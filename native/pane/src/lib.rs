//! The cockpit in a terminal: a ratatui pane that draws the core's All
//! view (Next, Needs you and the lanes, each card with its chips) and its
//! Projects view (Needs you and the cards grouped by project, where up,
//! down and the wheel scroll and the card keys rest for now), lets up and
//! down walk the cards,
//! and turns keys and drags into actions on them: place a card in a lane,
//! switch to it, dismiss it from Needs you, flip the view. It writes
//! nothing itself; the runner hands each action to the core.
//!
//! A runner owns the terminal and the core. Each frame it builds a
//! `PaneModel` from the core and hands it to `Pane::set_view_model`, passes
//! each terminal event to `Pane::handle_event`, and calls `Pane::draw`,
//! which only draws when something changed: a new model, a key or a drag
//! that changed what shows, or a new terminal size.

pub mod cursor;
pub mod editor;
pub mod menu;
pub mod model;
pub mod placing;
pub mod runner;
pub mod text;
pub mod theme;
mod views;

use cockpit_core::Event as CoreEvent;
use cockpit_core::edit::EditEvent;
use cockpit_core::lanes::LaneKey;
use cockpit_core::menu::{MenuEvent, MenuTarget};
use ratatui::Terminal;
use ratatui::backend::Backend;
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Size;

use crate::cursor::Cursor;
use crate::editor::{EditKey, Field};
use crate::menu::MenuKey;
pub use crate::model::PaneModel;
use crate::model::{PaneView, ProjectTarget, lane_for_digit};
use crate::placing::{Place, Spot, drop_on, reorder, spot_at, to_lane};

/// Something the pane asks the core to do. Plain data: the runner turns
/// each into its core event (`From<Action> for cockpit_core::Event`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Place card `id` in `lane`, above card `before`, or at the lane's
    /// end when None.
    MoveCard {
        id: String,
        lane: LaneKey,
        before: Option<String>,
    },
    /// Switch cmux to workspace `id`.
    SwitchTo { id: String },
    /// Dismiss `id` from Needs you.
    Dismiss { id: String },
    /// Flip between the All and Projects views.
    FlipView,
    /// Something done in the project editor.
    Edit(EditEvent),
    /// A project's "+": a new session in its folder.
    OpenProject { key: String },
    /// A card's "To review →".
    FileForReview { id: String },
    /// Something done with the card menu or a project's menu.
    Menu(MenuEvent),
}

impl From<Action> for CoreEvent {
    fn from(action: Action) -> CoreEvent {
        match action {
            Action::MoveCard { id, lane, before } => CoreEvent::MoveCard { id, lane, before },
            Action::SwitchTo { id } => CoreEvent::SwitchTo { id },
            Action::Dismiss { id } => CoreEvent::Dismiss { id },
            Action::FlipView => CoreEvent::FlipView,
            Action::Edit(e) => CoreEvent::Edit(e),
            Action::OpenProject { key } => CoreEvent::OpenProject { key },
            Action::FileForReview { id } => CoreEvent::FileForReview { id },
            Action::Menu(e) => CoreEvent::Menu(e),
        }
    }
}

/// What an event asks of the runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing changed.
    Nothing,
    /// Something on screen changed; `draw` will draw it.
    Redraw,
    /// Hand this action to the core. `draw` draws whatever it changed on
    /// screen meanwhile.
    Act(Action),
    /// Leave the pane.
    Quit,
}

/// A card being dragged: which, and where it would land if let go now.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Drag {
    id: String,
    over: Option<Place>,
}

/// The pane: the model it draws, the card cursor, the keys overlay, the
/// lane picker and a drag under way. Which view shows comes with the
/// model, from the core.
#[derive(Debug, Clone, Default)]
pub struct Pane {
    model: PaneModel,
    cursor: Cursor,
    /// The line scroll Up and Down set when there is no card to move to.
    manual: usize,
    keys: bool,
    /// `m` was pressed on this card: the next key picks its lane.
    picking: Option<String>,
    drag: Option<Drag>,
    /// Where the last draw put the body, for the mouse.
    drawn: views::Drawn,
    /// Something changed since the last draw.
    dirty: bool,
    /// The size the last draw filled; None before the first.
    drawn_at: Option<Size>,
    /// The cursor among the Projects view's rows.
    rows: Cursor,
    /// The open editor's key and its focused field.
    editing: Option<String>,
    field: Field,
    /// What the open menu is on, and which of its items is lit.
    menu_on: Option<MenuTarget>,
    menu_at: usize,
}

impl Pane {
    /// A pane drawing `model`.
    pub fn new(model: PaneModel) -> Pane {
        Pane {
            model,
            dirty: true,
            ..Pane::default()
        }
    }

    /// The model it draws.
    pub fn model(&self) -> &PaneModel {
        &self.model
    }

    /// The card under the cursor, by workspace id.
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.on()
    }

    /// Whether the keys overlay is up.
    pub fn keys_shown(&self) -> bool {
        self.keys
    }

    /// The open menu's lit item, in its words.
    pub fn menu_lit(&self) -> Option<&str> {
        let view = self.model.menu.as_ref()?;
        view.items.get(self.menu_at).map(|i| i.label())
    }

    /// Whether `m` is waiting for a lane.
    pub fn picking(&self) -> bool {
        self.picking.is_some()
    }

    /// Which view it draws.
    pub fn view(&self) -> PaneView {
        self.model.view
    }

    /// Where the card being dragged would land if let go now.
    pub fn drop_target(&self) -> Option<&Place> {
        self.drag.as_ref().and_then(|d| d.over.as_ref())
    }

    /// Takes a new frame's model. Only a model that differs from the one on
    /// screen asks for a draw; the cursor stays on its card if it is still
    /// there, and a drag whose card went is dropped. True when it changed.
    pub fn set_view_model(&mut self, model: PaneModel) -> bool {
        if model == self.model {
            return false;
        }
        if model.view != self.model.view {
            // A new view starts at its top.
            self.manual = 0;
        }
        self.model = model;
        let cards = self.model.card_ids();
        self.cursor.settle(&cards);
        self.rows.settle(&self.model.project_ids());
        // A newly opened editor starts on its first field.
        let editor = self.model.editor();
        let editing = editor.map(|e| e.key.clone());
        if editing != self.editing {
            self.field = editor
                .and_then(|e| e.fields().first().copied())
                .unwrap_or_default();
            self.editing = editing;
        }
        // A newly opened menu starts on its first item; one still open
        // keeps its lit item on an item as its words change.
        let menu = self.model.menu.as_ref();
        let menu_on = menu.map(|m| m.target.clone());
        if let Some(m) = menu {
            self.menu_at = if menu_on == self.menu_on {
                menu::settle(&m.items, self.menu_at)
            } else {
                menu::first(&m.items)
            };
        }
        self.menu_on = menu_on;
        // The card `m` was pressed on went, or the view left All (flipped
        // from the sidebar, say): nothing left to move.
        let all = self.model.view == PaneView::All;
        if self
            .picking
            .as_deref()
            .is_some_and(|id| !all || !cards.contains(&id))
        {
            self.picking = None;
        }
        if let Some(d) = &mut self.drag {
            // A card that went, or turned into a placeholder as its session
            // started asking, is no longer dragged (drop.ts).
            if !all || !self.model.is_lane_card(&d.id) {
                self.drag = None;
            } else if let Some(over) = &d.over {
                // The card it would land above may have gone.
                let gone = over
                    .before
                    .as_deref()
                    .is_some_and(|b| self.model.lane_of(b).is_none());
                if gone {
                    d.over = None;
                }
            }
        }
        self.dirty = true;
        true
    }

    /// Whether the next `draw` will draw: something changed, or the
    /// terminal is not the size last drawn.
    pub fn needs_draw(&self, size: Size) -> bool {
        self.dirty || self.drawn_at != Some(size)
    }

    /// Handles a terminal event: keys, the mouse, and a resize, which asks
    /// for a draw.
    pub fn handle_event(&mut self, event: &Event) -> Outcome {
        match event {
            Event::Key(key) => self.handle_key(*key),
            Event::Mouse(mouse) => self.handle_mouse(*mouse),
            // The next draw sees the new size and draws.
            Event::Resize(..) => Outcome::Redraw,
            _ => Outcome::Nothing,
        }
    }

    /// Handles a key. `q` or Ctrl-C quits, `?` shows or hides the keys and
    /// Esc hides them; while they are up nothing else answers. After `m`
    /// the next key picks a lane (Esc, or any other key, cancels). Tab
    /// flips the view. Up and down move the cursor (or scroll a line when
    /// there are none): in All over the cards, where with shift they
    /// reorder its card in its lane, and in Projects over its rows. Enter
    /// switches to the card, `d` dismisses it from Needs you, `r` files
    /// it for review and Space opens its menu. In Projects `+`, `e` and
    /// `n` open a session, edit a project and make one, and Space opens a
    /// card's or a project's menu. An open menu or editor takes every key.
    pub fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if key.kind == KeyEventKind::Release {
            return Outcome::Nothing;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Outcome::Quit;
        }
        let chord = key.modifiers.intersects(
            KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META,
        );
        if chord {
            return Outcome::Nothing;
        }
        if let Some(id) = self.picking.take() {
            self.dirty = true;
            return self.pick(id, key.code);
        }
        // An open menu takes every key: Up, Down, Enter and Esc.
        if !self.keys
            && let Some(view) = &self.model.menu
        {
            return match menu::key(view, self.menu_at, key.code) {
                MenuKey::Send(e) => {
                    self.dirty = true;
                    Outcome::Act(Action::Menu(e))
                }
                MenuKey::Move(at) => {
                    self.menu_at = at;
                    self.dirty = true;
                    Outcome::Redraw
                }
                MenuKey::Nothing => Outcome::Nothing,
            };
        }
        // An open editor takes every key, so a "q" or "?" in a name types.
        if !self.keys
            && self.model.view == PaneView::Projects
            && let Some(editor) = self.model.editor()
        {
            self.dirty = true;
            return match editor::key(editor, self.field, key.code) {
                EditKey::Send(e) => Outcome::Act(Action::Edit(e)),
                EditKey::Focus(f) => {
                    self.field = f;
                    Outcome::Redraw
                }
                EditKey::Nothing => Outcome::Nothing,
            };
        }
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let outcome = match key.code {
            KeyCode::Char('q') => return Outcome::Quit,
            KeyCode::Char('?') => {
                self.keys = !self.keys;
                // The mouse rests under the keys, so a drag would never
                // hear its button let go.
                self.drag = None;
                Outcome::Redraw
            }
            KeyCode::Esc if self.keys => {
                self.keys = false;
                Outcome::Redraw
            }
            _ if self.keys => Outcome::Nothing,
            KeyCode::Esc if self.drag.is_some() => {
                self.drag = None;
                Outcome::Redraw
            }
            KeyCode::Tab | KeyCode::BackTab => {
                // The core flips the view; the model it sends next draws it.
                self.drag = None;
                Outcome::Act(Action::FlipView)
            }
            // Shift's reorder is All's; Projects has no lanes to reorder in.
            _ if self.model.view == PaneView::Projects && shift => Outcome::Nothing,
            _ if self.model.view == PaneView::Projects => self.row_key(key.code),
            code => self.card_key(code, shift),
        };
        if outcome != Outcome::Nothing {
            self.dirty = true;
        }
        outcome
    }

    /// The keys that act on the cards, in All with nothing over them.
    fn card_key(&mut self, code: KeyCode, shift: bool) -> Outcome {
        let on = self.cursor.on().map(str::to_string);
        match code {
            KeyCode::Up | KeyCode::Down if shift => {
                let up = code == KeyCode::Up;
                let place = on.and_then(|id| {
                    let place = reorder(&self.model, &id, up)?;
                    Some((id, place))
                });
                place.map_or(Outcome::Nothing, |(id, p)| move_card(id, p))
            }
            KeyCode::Up => redraw_if(self.step(-1)),
            KeyCode::Down => redraw_if(self.step(1)),
            KeyCode::Enter => {
                on.map_or(Outcome::Nothing, |id| Outcome::Act(Action::SwitchTo { id }))
            }
            KeyCode::Char('r') => on.map_or(Outcome::Nothing, |id| {
                Outcome::Act(Action::FileForReview { id })
            }),
            KeyCode::Char('d') => match on {
                Some(id) if self.model.is_waiting(&id) => Outcome::Act(Action::Dismiss { id }),
                _ => Outcome::Nothing,
            },
            KeyCode::Char(' ') => on.map_or(Outcome::Nothing, |id| {
                Outcome::Act(Action::Menu(MenuEvent::OpenCard { id }))
            }),
            KeyCode::Char('m') if on.as_deref().is_some_and(|id| self.model.movable(id)) => {
                self.picking = on;
                self.drag = None;
                Outcome::Redraw
            }
            _ => Outcome::Nothing,
        }
    }

    /// A key in Projects with no editor open: the cursor moves between the
    /// rows; Enter switches to a card, opens a session in a project
    /// (as its "+") or opens "+ New project"'s editor.
    fn row_key(&mut self, code: KeyCode) -> Outcome {
        let target = self.rows.on().and_then(|id| self.model.project_target(id));
        match (code, target) {
            (KeyCode::Up, _) => redraw_if(self.row_step(-1)),
            (KeyCode::Down, _) => redraw_if(self.row_step(1)),
            (KeyCode::Char('n'), _) | (KeyCode::Enter, Some(ProjectTarget::New)) => {
                Outcome::Act(Action::Edit(EditEvent::OpenNew))
            }
            (KeyCode::Enter, Some(ProjectTarget::Card(id))) => {
                Outcome::Act(Action::SwitchTo { id })
            }
            (KeyCode::Char('r'), Some(ProjectTarget::Card(id))) => {
                Outcome::Act(Action::FileForReview { id })
            }
            (KeyCode::Char(' '), Some(ProjectTarget::Card(id))) => {
                Outcome::Act(Action::Menu(MenuEvent::OpenCard { id }))
            }
            (KeyCode::Char(' '), Some(ProjectTarget::Project { key, quiet, .. })) => {
                Outcome::Act(Action::Menu(MenuEvent::OpenProject { key, quiet }))
            }
            (
                KeyCode::Enter | KeyCode::Char('+'),
                Some(ProjectTarget::Project { key, can_open, .. }),
            ) => {
                if can_open {
                    Outcome::Act(Action::OpenProject { key })
                } else {
                    Outcome::Nothing
                }
            }
            (KeyCode::Char('e'), Some(ProjectTarget::Project { key, .. })) => {
                Outcome::Act(Action::Edit(EditEvent::Open { key }))
            }
            _ => Outcome::Nothing,
        }
    }

    /// Moves the Projects cursor, or scrolls a line with no rows to move to.
    fn row_step(&mut self, by: isize) -> bool {
        let ids = self.model.project_ids();
        if ids.is_empty() {
            return self.scroll(by);
        }
        self.rows.step(&ids, by)
    }

    /// The key after `m` on card `id`: a lane's digit places that card at
    /// the lane's end; anything else cancels.
    fn pick(&mut self, id: String, code: KeyCode) -> Outcome {
        let lane = match code {
            KeyCode::Char(c) => lane_for_digit(c),
            _ => None,
        };
        match lane.and_then(|lane| to_lane(&self.model, &id, lane)) {
            Some(place) => move_card(id, place),
            None => Outcome::Redraw,
        }
    }

    /// Handles the mouse in All, with nothing over the lanes: a press on a
    /// card puts the cursor there and picks it up, a drag shows where it
    /// would land, and letting go places it. The wheel moves the cursor.
    pub fn handle_mouse(&mut self, mouse: MouseEvent) -> Outcome {
        if self.keys || self.picking.is_some() || self.model.menu.is_some() {
            return Outcome::Nothing;
        }
        if self.model.view == PaneView::Projects {
            // The wheel scrolls the Projects view; nothing there is dragged.
            let moved = match mouse.kind {
                MouseEventKind::ScrollUp => self.row_step(-1),
                MouseEventKind::ScrollDown => self.row_step(1),
                _ => false,
            };
            if moved {
                self.dirty = true;
            }
            return redraw_if(moved);
        }
        // The cursor follows the finger: macOS natural scrolling reports a
        // swipe up as the wheel turning down, so down steps the cursor up.
        let outcome = match mouse.kind {
            MouseEventKind::ScrollDown => redraw_if(self.step(-1)),
            MouseEventKind::ScrollUp => redraw_if(self.step(1)),
            MouseEventKind::Down(MouseButton::Left) => self.press(mouse.row),
            MouseEventKind::Drag(MouseButton::Left) => self.drag_over(mouse.row),
            MouseEventKind::Up(MouseButton::Left) => self.let_go(mouse.row),
            _ => Outcome::Nothing,
        };
        if outcome != Outcome::Nothing {
            self.dirty = true;
        }
        outcome
    }

    /// What is under screen row `row`, as the last draw laid it out.
    fn spot(&self, row: u16) -> Spot {
        match row.checked_sub(self.drawn.top) {
            Some(y) => spot_at(&self.drawn.spots, usize::from(y) + self.drawn.scroll),
            None => Spot::Blank,
        }
    }

    fn press(&mut self, row: u16) -> Outcome {
        let (id, card) = match self.spot(row) {
            Spot::Card { id, .. } => (id, true),
            Spot::Needs(id) => (id, false),
            _ => return Outcome::Nothing,
        };
        let moved = self.cursor.jump(&self.model.card_ids(), &id);
        if moved {
            // As a step does: the line scroll past the last card starts over.
            self.manual = 0;
        }
        // A placeholder or a Needs you row is not dragged (drop.ts), nor a
        // card that anchors another group, which the core will not move.
        if card && self.model.movable(&id) {
            self.drag = Some(Drag { id, over: None });
        }
        redraw_if(moved)
    }

    fn drag_over(&mut self, row: u16) -> Outcome {
        let spot = self.spot(row);
        let Some(d) = &mut self.drag else {
            return Outcome::Nothing;
        };
        let over = drop_on(&self.model, &d.id, &spot);
        if over == d.over {
            return Outcome::Nothing;
        }
        d.over = over;
        Outcome::Redraw
    }

    fn let_go(&mut self, row: u16) -> Outcome {
        self.drag_over(row);
        let Some(d) = self.drag.take() else {
            return Outcome::Nothing;
        };
        match d.over {
            Some(place) => move_card(d.id, place),
            None => Outcome::Redraw,
        }
    }

    /// Scrolls a line, as far as the last draw's body goes; true when it moved.
    fn scroll(&mut self, by: isize) -> bool {
        let next = self.manual.saturating_add_signed(by).min(self.drawn.most);
        let moved = next != self.manual;
        self.manual = next;
        moved
    }

    /// Moves the cursor a card, or with no cards scrolls a line. Down on
    /// the last card scrolls a line too, so the lanes below it (empty ones,
    /// or only placeholders) come into sight.
    fn step(&mut self, by: isize) -> bool {
        let cards = self.model.card_ids();
        let last = !cards.is_empty() && self.cursor.on() == cards.last().copied();
        if !cards.is_empty() && !(last && by > 0) {
            self.manual = 0;
            return self.cursor.step(&cards, by);
        }
        self.scroll(by)
    }

    /// The last row the cursor can rest on: All's last card, or Projects'
    /// last row while no editor is open, so resting there scrolls to the
    /// end and the lines under it (a Quiet heading) come into view.
    fn last_row(&self, projects: bool) -> Option<&str> {
        if !projects {
            return self.model.card_ids().last().copied();
        }
        if self.model.editor().is_some() {
            return None;
        }
        self.model.project_ids().last().copied()
    }

    /// Draws when something changed or the terminal was resized; true when
    /// it drew.
    pub fn draw<B: Backend>(&mut self, terminal: &mut Terminal<B>) -> Result<bool, B::Error> {
        let size = terminal.size()?;
        if !self.needs_draw(size) {
            return Ok(false);
        }
        let cursor = self.cursor.on();
        let projects = self.model.view == PaneView::Projects;
        let cursor = if projects { self.rows.on() } else { cursor };
        let shown = views::Shown {
            model: &self.model,
            cursor,
            last: cursor.is_some() && cursor == self.last_row(projects),
            manual: self.manual,
            keys: self.keys,
            picking: self.picking.is_some(),
            view: self.model.view,
            drop: self.drag.as_ref().and_then(|d| d.over.as_ref()),
            field: self.field,
            menu: self.model.menu.as_ref().map(|m| (m, self.menu_at)),
        };
        let mut drawn = views::Drawn::default();
        terminal.draw(|frame| drawn = views::draw(frame, shown))?;
        if cursor.is_none() || shown.last || shown.view == PaneView::Projects {
            // Held at the end, so Up after too many Downs moves at once.
            self.manual = drawn.scroll;
        }
        self.drawn = drawn;
        self.dirty = false;
        self.drawn_at = Some(size);
        Ok(true)
    }
}

/// Redraw when something moved, else nothing.
fn redraw_if(changed: bool) -> Outcome {
    if changed {
        Outcome::Redraw
    } else {
        Outcome::Nothing
    }
}

fn move_card(id: String, place: Place) -> Outcome {
    Outcome::Act(Action::MoveCard {
        id,
        lane: place.lane,
        before: place.before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The core's Event has no PartialEq, so each is matched field by field.
    #[test]
    fn turns_each_action_into_its_core_event() {
        let moved = CoreEvent::from(Action::MoveCard {
            id: "a".into(),
            lane: LaneKey::Review,
            before: Some("b".into()),
        });
        assert!(
            matches!(&moved, CoreEvent::MoveCard { id, lane: LaneKey::Review, before: Some(b) }
                if id == "a" && b == "b"),
            "{moved:?}"
        );
        let to_end = CoreEvent::from(Action::MoveCard {
            id: "a".into(),
            lane: LaneKey::Parked,
            before: None,
        });
        assert!(
            matches!(&to_end, CoreEvent::MoveCard { id, lane: LaneKey::Parked, before: None }
                if id == "a"),
            "{to_end:?}"
        );
        let switch = CoreEvent::from(Action::SwitchTo { id: "s".into() });
        assert!(
            matches!(&switch, CoreEvent::SwitchTo { id } if id == "s"),
            "{switch:?}"
        );
        let dismiss = CoreEvent::from(Action::Dismiss { id: "d".into() });
        assert!(
            matches!(&dismiss, CoreEvent::Dismiss { id } if id == "d"),
            "{dismiss:?}"
        );
        let flip = CoreEvent::from(Action::FlipView);
        assert!(matches!(flip, CoreEvent::FlipView), "{flip:?}");
    }
}
