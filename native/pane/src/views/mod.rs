//! View builders only: each takes the pane's model and lays it out. Every
//! word and colour comes from the model and the theme; a decision a view
//! would need goes in the model (model.rs, cursor.rs, text.rs) with a test.

mod editor;
mod keys;
mod lanes;
mod menu;
mod needs;
mod parts;
mod projects;
mod top;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::text::Line;
use ratatui::widgets::{Block, Paragraph};

use crate::cursor::{Scroll, scroll_for};
use crate::editor::Field;
use crate::model::{KEYS, KEYS_TITLE, PICK_TITLE, PaneModel, PaneView, pick_rows};
use crate::placing::{Place, Spot};
use crate::theme;
use cockpit_core::panel::MenuView;

/// The fixed lines above the body: the view switch and Next.
const TOP_LINES: u16 = 2;

/// What one draw shows: the model, the card under the cursor and whether
/// it is the last, the line scroll with no card to move to, whether the
/// keys or the lane picker are up, which view, and a drag's drop target.
#[derive(Debug, Clone, Copy)]
pub struct Shown<'a> {
    pub model: &'a PaneModel,
    pub cursor: Option<&'a str>,
    pub last: bool,
    pub manual: usize,
    pub keys: bool,
    pub picking: bool,
    pub view: PaneView,
    pub drop: Option<&'a Place>,
    /// The editor's focused field, while one is open in Projects.
    pub field: Field,
    /// The open menu, the index of its lit item, and the item its list
    /// started at last draw.
    pub menu: Option<(&'a MenuView, usize, usize)>,
}

/// Where a draw put the body: its first row on screen, how far it
/// scrolled, and what each of its lines is, for the mouse.
#[derive(Debug, Clone, Default)]
pub struct Drawn {
    pub top: u16,
    pub scroll: usize,
    /// The furthest the body can scroll.
    pub most: usize,
    pub spots: Vec<Spot>,
    /// The item the open menu's list started at.
    pub menu_top: usize,
}

/// Draws the whole pane into the frame.
pub fn draw(frame: &mut Frame<'_>, shown: Shown<'_>) -> Drawn {
    let area = frame.area();
    frame.render_widget(Block::new().style(theme::base()), area);
    let inner = parts::inner(area.width);
    let [top_area, body_area] =
        Layout::vertical([Constraint::Length(TOP_LINES), Constraint::Fill(1)]).areas(area);

    let top = vec![
        top::switch(inner, shown.view),
        top::next(&shown.model.next, inner),
    ];
    frame.render_widget(Paragraph::new(top), top_area);

    let mut drawn = match shown.view {
        PaneView::All => {
            let height = usize::from(body_area.height);
            let (body, spots, scroll) = all(shown, inner, height);
            let most = body.len().saturating_sub(height);
            let offset = u16::try_from(scroll).unwrap_or(u16::MAX);
            frame.render_widget(Paragraph::new(body).scroll((offset, 0)), body_area);
            Drawn {
                top: body_area.y,
                scroll,
                most,
                spots,
                menu_top: 0,
            }
        }
        PaneView::Projects => {
            // The cursor moves between its rows, with the keys or the
            // wheel, and the view keeps it in sight: an editor's focus
            // runs to its foot line, and the last row scrolls to the end.
            // No line is a spot.
            let mut body: Vec<Line<'static>> = Vec::new();
            if let Some(needs) = needs::line(&shown.model.needs, inner) {
                body.push(Line::default());
                body.push(needs);
            }
            let lead = body.len();
            let laid = projects::lines(&shown.model.projects, inner, shown.cursor, shown.field);
            body.extend(laid.lines);
            let height = usize::from(body_area.height);
            let most = body.len().saturating_sub(height);
            let scroll = scroll_for(&Scroll {
                focus: laid.focus.map(|r| r.start + lead..r.end + lead),
                last: shown.last,
                manual: shown.manual,
                total: body.len(),
                height,
            });
            let offset = u16::try_from(scroll).unwrap_or(u16::MAX);
            frame.render_widget(Paragraph::new(body).scroll((offset, 0)), body_area);
            Drawn {
                top: body_area.y,
                scroll,
                most,
                spots: Vec::new(),
                menu_top: 0,
            }
        }
    };

    if shown.keys {
        keys::draw(frame, area, KEYS_TITLE, &KEYS);
    } else if let Some((view, at, top)) = shown.menu {
        drawn.menu_top = menu::draw(frame, area, view, at, top);
    } else if shown.picking && shown.view == PaneView::All {
        let rows = pick_rows();
        let rows: Vec<(&str, &str)> = rows.iter().map(|(k, w)| (k.as_str(), *w)).collect();
        keys::draw(frame, area, PICK_TITLE, &rows);
    }
    drawn
}

/// The All view's body: the Needs you line then the lanes, what each line
/// is, and how far it scrolls to keep the cursor's card in sight.
fn all(shown: Shown<'_>, inner: usize, height: usize) -> (Vec<Line<'static>>, Vec<Spot>, usize) {
    let mut body: Vec<Line<'static>> = Vec::new();
    let mut spots: Vec<Spot> = Vec::new();
    if let Some(needs) = needs::line(&shown.model.needs, inner) {
        body.extend([Line::default(), needs]);
        spots.extend([Spot::Blank, Spot::Blank]);
    }
    let lead = body.len();
    let lanes = lanes::lines(&shown.model.lanes, inner, shown.cursor, shown.drop);
    let focus = lanes.focus.map(|r| r.start + lead..r.end + lead);
    body.extend(lanes.lines);
    spots.extend(lanes.spots);
    let scroll = scroll_for(&Scroll {
        focus,
        last: shown.last,
        manual: shown.manual,
        total: body.len(),
        height,
    });
    (body, spots, scroll)
}
