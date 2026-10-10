//! Each golden cockpit scene drawn on ratatui's TestBackend at 40 and 80
//! columns: the text matches the committed snapshot, no word is cut, and
//! the pane draws again only when its model, a key or the size changes.
//!
//! Re-record the snapshots after a meant change with
//! `UPDATE_SNAPSHOTS=1 cargo test -p cockpit_pane`, then read the diff.

#![cfg(test)]

mod support;

use std::collections::HashSet;
use std::path::PathBuf;

use cockpit_core::EditEvent;
use cockpit_core::MenuEvent;
use cockpit_core::panel::LaneKey;
use cockpit_core::panel::Token;
use cockpit_core::panel::{MenuAction, MenuTarget};
use cockpit_pane::model::{PaneView, ProjectTarget, words};
use cockpit_pane::{Action, Outcome, Pane, PaneModel, theme};
use crux_core::App;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::{Buffer, Cell};
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::style::{Color, Modifier};

use support::golden::{SCENES, scene_model};

const WIDTHS: [u16; 2] = [40, 80];
/// Tall enough for every scene's lanes, so the snapshot holds them all.
const HEIGHT: u16 = 64;

/// Glyphs the pane draws that are not words.
const MARKS: &str = "▌▎▔▸▾■●○◌─│┌┐└┘";
/// Narrow splits the snapshots do not cover, checked for cut words only.
const NARROW: [u16; 3] = [16, 24, 32];

fn pane_for(scene: &str) -> Pane {
    let mut core = scene_model(scene).unwrap();
    Pane::new(PaneModel::from_core(&mut core))
}

fn terminal(width: u16) -> Terminal<TestBackend> {
    Terminal::new(TestBackend::new(width, HEIGHT)).unwrap()
}

/// The buffer as text, each row's trailing spaces and the blank rows at
/// the bottom left off.
fn text_of(buffer: &Buffer) -> String {
    let w = usize::from(buffer.area.width);
    let mut rows: Vec<String> = buffer
        .content
        .chunks(w)
        .map(|row| {
            let line: String = row.iter().map(|c| c.symbol()).collect();
            line.trim_end().to_string()
        })
        .collect();
    while rows.last().is_some_and(String::is_empty) {
        rows.pop();
    }
    rows.join("\n") + "\n"
}

fn check_snapshot(name: &str, got: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots")
        .join(format!("{name}.txt"));
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{name}: no snapshot; run with UPDATE_SNAPSHOTS=1"));
    assert_eq!(got, want, "{name}: the pane drew something else");
}

fn draw(pane: &mut Pane, terminal: &mut Terminal<TestBackend>) -> String {
    pane.draw(terminal).unwrap();
    text_of(terminal.backend().buffer())
}

#[test]
fn draws_each_scene_as_its_snapshot_at_40_and_80_columns() {
    for scene in SCENES {
        for width in WIDTHS {
            let mut pane = pane_for(scene);
            let mut term = terminal(width);
            let got = draw(&mut pane, &mut term);
            check_snapshot(&format!("{scene}-{width}"), &got);
        }
    }
}

/// Every whitespace-separated run on screen is a whole word of the model's
/// text, or one followed by the ellipsis a fitted line ends on, or marks.
fn cut_words(model: &PaneModel, screen: &str) -> Vec<String> {
    let words: HashSet<String> = words(model)
        .iter()
        .flat_map(|t| t.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .collect();
    let mut cut = Vec::new();
    for token in screen.split_whitespace() {
        if token.chars().all(|c| MARKS.contains(c)) || token == "…" {
            continue;
        }
        let bare = token.trim_start_matches(|c| MARKS.contains(c));
        let stem = bare.strip_suffix('…').unwrap_or(bare);
        if !words.contains(bare) && !words.contains(stem) {
            cut.push(token.to_string());
        }
    }
    cut
}

#[test]
fn never_cuts_a_word_mid_line_in_any_scene_at_any_width() {
    for scene in SCENES {
        for width in WIDTHS.into_iter().chain(NARROW) {
            let mut pane = pane_for(scene);
            let mut term = terminal(width);
            let screen = draw(&mut pane, &mut term);
            let cut = cut_words(pane.model(), &screen);
            assert!(
                cut.is_empty(),
                "{scene} at {width}: cut words {cut:?}\n{screen}"
            );
        }
    }
}

#[test]
fn the_cut_word_check_catches_half_a_word() {
    let pane = pane_for("lanes");
    let words = words(pane.model());
    let longest = words
        .iter()
        .flat_map(|t| t.split_whitespace())
        .max_by_key(|w| w.chars().count())
        .unwrap();
    let half: String = longest.chars().take(longest.chars().count() / 2).collect();
    assert!(!cut_words(pane.model(), &format!("{half}…")).is_empty());
    assert!(!cut_words(pane.model(), &half).is_empty());
}

#[test]
fn draws_only_when_the_model_changes_or_the_terminal_resizes() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(80);
    assert!(pane.draw(&mut term).unwrap(), "the first draw");
    assert!(!pane.draw(&mut term).unwrap(), "nothing changed");

    let same = pane.model().clone();
    assert!(!pane.set_view_model(same), "the same model");
    assert!(!pane.draw(&mut term).unwrap());

    let mut core = scene_model("review-verdicts").unwrap();
    assert!(pane.set_view_model(PaneModel::from_core(&mut core)));
    assert!(pane.draw(&mut term).unwrap(), "a new model");
    assert!(!pane.draw(&mut term).unwrap());
}

#[test]
fn redraws_cleanly_at_the_new_width_after_a_resize() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(80);
    pane.draw(&mut term).unwrap();

    term.backend_mut().resize(40, HEIGHT);
    assert_eq!(
        pane.handle_event(&Event::Resize(40, HEIGHT)),
        Outcome::Redraw
    );
    assert!(pane.draw(&mut term).unwrap(), "the resize draws");
    let narrow = text_of(term.backend().buffer());

    let mut fresh = pane_for("lanes");
    let mut fresh_term = terminal(40);
    assert_eq!(
        narrow,
        draw(&mut fresh, &mut fresh_term),
        "nothing left from 80 columns"
    );

    // A resize the runner did not pass on still draws: the size differs.
    term.backend_mut().resize(80, HEIGHT);
    assert!(pane.draw(&mut term).unwrap());
    assert!(!pane.draw(&mut term).unwrap());
}

fn press(pane: &mut Pane, code: KeyCode) -> Outcome {
    pane.handle_key(KeyEvent::from(code))
}

#[test]
fn moves_a_cursor_between_cards_and_shows_it() {
    let mut pane = pane_for("lanes");
    let cards: Vec<String> = pane
        .model()
        .card_ids()
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert!(cards.len() > 1);
    assert_eq!(pane.cursor(), None);

    assert_eq!(press(&mut pane, KeyCode::Down), Outcome::Redraw);
    assert_eq!(pane.cursor(), Some(cards[0].as_str()));
    assert_eq!(press(&mut pane, KeyCode::Down), Outcome::Redraw);
    assert_eq!(pane.cursor(), Some(cards[1].as_str()));
    assert_eq!(press(&mut pane, KeyCode::Up), Outcome::Redraw);
    assert_eq!(
        press(&mut pane, KeyCode::Up),
        Outcome::Nothing,
        "held at the top"
    );

    let mut term = terminal(40);
    let screen = draw(&mut pane, &mut term);
    check_snapshot("lanes-40-cursor", &screen);
}

#[test]
fn keeps_the_cursor_card_in_sight_in_a_short_pane() {
    let mut pane = pane_for("lanes");
    let last = pane.model().card_ids().len();
    for _ in 0..last {
        press(&mut pane, KeyCode::Down);
    }
    let mut term = Terminal::new(TestBackend::new(40, 12)).unwrap();
    let screen = draw(&mut pane, &mut term);
    assert!(
        screen.contains('▌'),
        "the cursor's card is on screen:\n{screen}"
    );
}

/// A short pane, with the cursor pressed down `presses` times.
fn short_screen(pane: &mut Pane, presses: usize) -> String {
    for _ in 0..presses {
        press(pane, KeyCode::Down);
    }
    let mut term = Terminal::new(TestBackend::new(40, 12)).unwrap();
    draw(pane, &mut term)
}

#[test]
fn shows_the_lanes_below_the_last_card_in_a_short_pane() {
    let mut pane = pane_for("review-verdicts");
    let cards = pane.model().card_ids().len();
    let screen = short_screen(&mut pane, cards);
    assert!(
        screen.contains("UNSORTED"),
        "the last lane is reachable:\n{screen}"
    );
}

#[test]
fn scrolls_a_line_at_a_time_when_there_are_no_cards() {
    let mut model = pane_for("lanes").model().clone();
    for lane in &mut model.lanes {
        lane.rows.clear();
    }
    let mut pane = Pane::new(model);
    assert!(pane.model().card_ids().is_empty());
    let top = short_screen(&mut pane, 0);
    assert!(!top.contains("UNSORTED"));
    let bottom = short_screen(&mut pane, 40);
    assert!(
        bottom.contains("UNSORTED"),
        "scrolled to the end:\n{bottom}"
    );
    assert_eq!(
        press(&mut pane, KeyCode::Up),
        Outcome::Redraw,
        "held at the end, so Up moves at once"
    );
}

#[test]
fn quits_on_q_alone_and_ignores_arrows_under_the_keys() {
    let mut pane = pane_for("lanes");
    let alt_q = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::ALT);
    assert_eq!(pane.handle_key(alt_q), Outcome::Nothing);
    let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    assert_eq!(pane.handle_key(ctrl_c), Outcome::Quit);

    press(&mut pane, KeyCode::Char('?'));
    assert_eq!(press(&mut pane, KeyCode::Down), Outcome::Nothing);
    assert_eq!(pane.cursor(), None, "the cursor stays put under the keys");
}

#[test]
fn shows_and_hides_the_keys_and_quits_on_q() {
    let mut pane = pane_for("needs-and-next");
    assert_eq!(press(&mut pane, KeyCode::Char('?')), Outcome::Redraw);
    assert!(pane.keys_shown());
    let mut term = terminal(80);
    check_snapshot("needs-and-next-80-keys", &draw(&mut pane, &mut term));

    assert_eq!(press(&mut pane, KeyCode::Esc), Outcome::Redraw);
    assert!(!pane.keys_shown());
    assert_eq!(press(&mut pane, KeyCode::Esc), Outcome::Nothing);
    assert_eq!(press(&mut pane, KeyCode::Char('x')), Outcome::Nothing);
    assert_eq!(press(&mut pane, KeyCode::Char('q')), Outcome::Quit);
}

fn cell_colours(buffer: &Buffer, needle: &str) -> (Color, Color) {
    let cell = cell_at(buffer, needle);
    (cell.fg, cell.bg)
}

/// The cell where `needle` first starts on screen.
fn cell_at<'b>(buffer: &'b Buffer, needle: &str) -> &'b Cell {
    let w = usize::from(buffer.area.width);
    for (y, row) in buffer.content.chunks(w).enumerate() {
        let line: String = row.iter().map(|c| c.symbol()).collect();
        if let Some(byte) = line.find(needle) {
            let x = line[..byte].chars().count();
            assert!(y < usize::from(buffer.area.height));
            return &row[x];
        }
    }
    panic!("{needle} is not on screen");
}

#[test]
fn paints_the_ground_and_takes_colours_from_the_theme() {
    let mut pane = pane_for("needs-and-next");
    let mut term = terminal(80);
    pane.draw(&mut term).unwrap();
    let buffer = term.backend().buffer();
    assert_eq!(buffer.content[0].bg, theme::rgb(theme::GROUND));
    let (fg, bg) = cell_colours(buffer, "5 need you");
    assert_eq!(fg, theme::colour(Token::ClayText));
    assert_eq!(bg, theme::rgb(theme::GROUND), "a line, no face");
    let (fg, _) = cell_colours(buffer, "▎");
    assert_eq!(fg, theme::colour(Token::Clay), "a waiting card's edge");
    let (fg, _) = cell_colours(buffer, "Next");
    assert_eq!(fg, theme::colour(Token::Heading));
}

/// Presses Down until the cursor is on the card titled `title`.
fn cursor_to(pane: &mut Pane, title: &str) -> String {
    let id = id_of(pane, title);
    for _ in 0..pane.model().card_ids().len() {
        if pane.cursor() == Some(id.as_str()) {
            return id;
        }
        press(pane, KeyCode::Down);
    }
    assert_eq!(pane.cursor(), Some(id.as_str()), "{title} is not a card");
    id
}

/// The workspace id of the card titled `title`.
fn id_of(pane: &Pane, title: &str) -> String {
    pane.model()
        .lanes
        .iter()
        .flat_map(|l| &l.rows)
        .map(cockpit_pane::model::Row::card)
        .find(|c| c.title == title)
        .map(|c| c.ws_id.clone())
        .unwrap_or_else(|| panic!("no card titled {title}"))
}

fn shift(pane: &mut Pane, code: KeyCode) -> Outcome {
    pane.handle_key(KeyEvent::new(code, KeyModifiers::SHIFT))
}

fn move_card(id: &str, lane: LaneKey, before: Option<&str>) -> Outcome {
    Outcome::Act(Action::MoveCard {
        id: id.to_string(),
        lane,
        before: before.map(str::to_string),
    })
}

#[test]
fn shift_up_and_down_reorder_the_card_among_its_lanes_cards_in_its_state() {
    let mut pane = pane_for("lanes");
    // Main sorts the pinned Untimed card first, then Tidy strip (finished)
    // above the working Snapshot tests, Long build and Selected card, then
    // the idle ones.
    let snapshot = cursor_to(&mut pane, "Snapshot tests");
    let selected = id_of(&pane, "Selected card");
    assert_eq!(
        shift(&mut pane, KeyCode::Up),
        Outcome::Nothing,
        "the finished card above sorts first"
    );
    assert_eq!(
        shift(&mut pane, KeyCode::Down),
        move_card(&snapshot, LaneKey::from("main"), Some(&selected)),
        "above the card two below"
    );
    assert_eq!(
        pane.cursor(),
        Some(snapshot.as_str()),
        "the cursor stays on it"
    );

    let long = cursor_to(&mut pane, "Long build");
    assert_eq!(
        shift(&mut pane, KeyCode::Up),
        move_card(&long, LaneKey::from("main"), Some(&snapshot)),
        "above the card above"
    );
    cursor_to(&mut pane, "Selected card");
    assert_eq!(
        shift(&mut pane, KeyCode::Down),
        Outcome::Nothing,
        "the idle card below sorts after"
    );
}

#[test]
fn shift_with_up_or_down_reorders_a_waiting_card_among_the_waiting() {
    let mut pane = pane_for("lanes");
    let chip = id_of(&pane, "Chip colours");
    let release = cursor_to(&mut pane, "Release notes");
    assert_eq!(
        shift(&mut pane, KeyCode::Up),
        move_card(&release, LaneKey::from("main"), Some(&chip)),
        "above the waiting card above"
    );
    assert_eq!(
        shift(&mut pane, KeyCode::Down),
        Outcome::Nothing,
        "the finished card below sorts after"
    );
}

#[test]
fn m_shows_the_lanes_and_a_digit_moves_the_card_to_that_lanes_end() {
    let mut pane = pane_for("lanes");
    assert_eq!(
        press(&mut pane, KeyCode::Char('m')),
        Outcome::Nothing,
        "no card"
    );
    let tidy = cursor_to(&mut pane, "Tidy strip");

    assert_eq!(press(&mut pane, KeyCode::Char('m')), Outcome::Redraw);
    assert!(pane.picking());
    let mut term = terminal(40);
    check_snapshot("lanes-40-pick", &draw(&mut pane, &mut term));
    assert_eq!(
        press(&mut pane, KeyCode::Char('4')),
        move_card(&tidy, LaneKey::from("parked"), None)
    );
    assert!(!pane.picking());

    press(&mut pane, KeyCode::Char('m'));
    assert_eq!(
        press(&mut pane, KeyCode::Char('1')),
        Outcome::Redraw,
        "its own lane"
    );
    press(&mut pane, KeyCode::Char('m'));
    assert_eq!(press(&mut pane, KeyCode::Esc), Outcome::Redraw);
    assert!(!pane.picking(), "Esc cancels");
    press(&mut pane, KeyCode::Char('m'));
    assert_eq!(
        press(&mut pane, KeyCode::Char('q')),
        Outcome::Redraw,
        "any other key cancels"
    );
    assert!(!pane.picking());
}

#[test]
fn m_moves_a_waiting_card_out_of_its_lane() {
    let mut pane = pane_for("lanes");
    let chip = cursor_to(&mut pane, "Chip colours");
    press(&mut pane, KeyCode::Char('m'));
    assert_eq!(
        press(&mut pane, KeyCode::Char('1')),
        Outcome::Redraw,
        "already in Main"
    );
    press(&mut pane, KeyCode::Char('m'));
    assert_eq!(
        press(&mut pane, KeyCode::Char('2')),
        move_card(&chip, LaneKey::from("review"), None)
    );
}

#[test]
fn enter_switches_to_the_card_under_the_cursor() {
    let mut pane = pane_for("lanes");
    assert_eq!(
        press(&mut pane, KeyCode::Enter),
        Outcome::Nothing,
        "no card"
    );
    let chip = cursor_to(&mut pane, "Chip colours");
    assert_eq!(
        press(&mut pane, KeyCode::Enter),
        Outcome::Act(Action::SwitchTo { id: chip }),
        "a Needs you row"
    );
    let tidy = cursor_to(&mut pane, "Tidy strip");
    assert_eq!(
        press(&mut pane, KeyCode::Enter),
        Outcome::Act(Action::SwitchTo { id: tidy })
    );
}

#[test]
fn d_dismisses_only_a_session_waiting_in_needs_you() {
    let mut pane = pane_for("needs-and-next");
    let oldest = cursor_to(&mut pane, "Oldest question");
    assert_eq!(
        press(&mut pane, KeyCode::Char('d')),
        Outcome::Act(Action::Dismiss { id: oldest })
    );
    let fifth = cursor_to(&mut pane, "Fifth, past the cap");
    assert_eq!(
        press(&mut pane, KeyCode::Char('d')),
        Outcome::Act(Action::Dismiss { id: fifth }),
        "a card past the strip's cap waits too"
    );
    cursor_to(&mut pane, "Busy");
    assert_eq!(press(&mut pane, KeyCode::Char('d')), Outcome::Nothing);
}

/// A pane wired to its core as the live runner wires it: each action goes
/// to the core at once, and the pane takes the core's new view before the
/// next event.
struct Live {
    core: cockpit_core::Model,
    pane: Pane,
}

impl Live {
    fn new(scene: &str) -> Live {
        let mut core = scene_model(scene).unwrap();
        let pane = Pane::new(PaneModel::from_core(&mut core));
        Live { core, pane }
    }

    fn handle(&mut self, event: &Event) -> Outcome {
        let out = self.pane.handle_event(event);
        if let Outcome::Act(action) = &out {
            let _ = cockpit_core::Cockpit.update(action.clone().into(), &mut self.core);
            self.pane
                .set_view_model(PaneModel::from_core(&mut self.core));
        }
        out
    }

    fn press(&mut self, code: KeyCode) -> Outcome {
        self.handle(&Event::Key(KeyEvent::from(code)))
    }

    fn shift(&mut self, code: KeyCode) -> Outcome {
        self.handle(&Event::Key(KeyEvent::new(code, KeyModifiers::SHIFT)))
    }

    /// Sends the core an event another shell sends (the sidebar's Next
    /// or a lane's fold), then takes its new view, as the runner would.
    fn core_event(&mut self, event: cockpit_core::Event) {
        let _ = cockpit_core::Cockpit.update(event, &mut self.core);
        self.pane
            .set_view_model(PaneModel::from_core(&mut self.core));
    }

    /// The ids of a lane's rows in the pane, top to bottom.
    fn lane(&self, key: LaneKey) -> Vec<String> {
        self.pane
            .model()
            .lane_rows(&key)
            .iter()
            .map(|r| r.ws_id().to_string())
            .collect()
    }
}

#[test]
fn tab_asks_the_core_to_flip_and_draws_the_view_the_core_sends() {
    let mut live = Live::new("lanes");
    cursor_to(&mut live.pane, "Tidy strip");
    assert_eq!(live.press(KeyCode::Tab), Outcome::Act(Action::FlipView));
    assert_eq!(live.pane.view(), PaneView::Projects, "from the core's mode");
    let mut term = terminal(40);
    check_snapshot("lanes-40-projects", &draw(&mut live.pane, &mut term));
    assert_eq!(
        live.press(KeyCode::Down),
        Outcome::Redraw,
        "the rows' cursor"
    );
    for code in [KeyCode::Char('d'), KeyCode::Char('m')] {
        assert_eq!(live.press(code), Outcome::Nothing, "{code:?} in Projects");
    }
    assert_eq!(live.shift(KeyCode::Up), Outcome::Nothing);
    assert_eq!(live.press(KeyCode::BackTab), Outcome::Act(Action::FlipView));
    assert_eq!(live.pane.view(), PaneView::All);
}

#[test]
fn makes_a_project_from_the_projects_view_with_the_keys() {
    let mut live = Live::new("projects");
    assert_eq!(
        live.press(KeyCode::Char('n')),
        Outcome::Act(Action::Edit(EditEvent::OpenNew))
    );
    assert!(live.pane.model().editor().is_some(), "the editor opens");
    for c in "/opt/quill".chars() {
        assert_ne!(live.press(KeyCode::Char(c)), Outcome::Quit, "q types");
    }
    let mut term = terminal(40);
    check_snapshot("projects-40-editor", &draw(&mut live.pane, &mut term));
    assert_eq!(
        live.press(KeyCode::Enter),
        Outcome::Act(Action::Edit(EditEvent::Save))
    );
    assert!(live.pane.model().editor().is_none(), "Done closes it");
    let made = live.core.session.spec_of("/opt/quill/").map(|p| p.name);
    assert_eq!(made.as_deref(), Some("Quill"), "sent, waiting on the build");
}

#[test]
fn esc_closes_the_editor_and_e_opens_it_on_the_project_under_the_cursor() {
    let mut live = Live::new("projects");
    assert_eq!(live.press(KeyCode::Down), Outcome::Redraw);
    let on = live
        .pane
        .model()
        .project_ids()
        .first()
        .map(|s| s.to_string());
    let target = on.and_then(|id| live.pane.model().project_target(&id));
    let Some(ProjectTarget::Project {
        key,
        can_open,
        quiet: false,
    }) = target
    else {
        panic!("the first row is a project's header: {target:?}");
    };
    let plus = live.press(KeyCode::Char('+'));
    if can_open {
        assert_eq!(plus, Outcome::Act(Action::OpenProject { key: key.clone() }));
    } else {
        assert_eq!(plus, Outcome::Nothing);
    }
    assert_eq!(
        live.press(KeyCode::Char('e')),
        Outcome::Act(Action::Edit(EditEvent::Open { key: key.clone() }))
    );
    let editor = live.pane.model().editor().map(|e| e.key.clone());
    assert_eq!(editor.as_deref(), Some(key.as_str()));
    assert_eq!(
        live.press(KeyCode::Esc),
        Outcome::Act(Action::Edit(EditEvent::Close))
    );
    assert!(live.pane.model().editor().is_none());
}

#[test]
fn r_p_x_and_k_do_nothing_now_the_cards_have_no_buttons() {
    let mut live = Live::new("lanes");
    for title in ["Tidy strip", "Card layout fit"] {
        cursor_to(&mut live.pane, title);
        for key in ['r', 'p', 'x', 'k'] {
            assert_eq!(
                live.press(KeyCode::Char(key)),
                Outcome::Nothing,
                "{key} on {title}"
            );
        }
    }
}

/// Presses Down until the open menu lights `label`.
fn light(live: &mut Live, label: &str) {
    for _ in 0..40 {
        if live.pane.menu_lit() == Some(label) {
            return;
        }
        live.press(KeyCode::Down);
    }
    assert_eq!(live.pane.menu_lit(), Some(label), "not in the menu");
}

#[test]
fn space_opens_a_cards_menu_which_takes_every_key_and_picks_with_enter() {
    let mut live = Live::new("lanes");
    let id = cursor_to(&mut live.pane, "Tidy strip");
    assert_eq!(
        live.press(KeyCode::Char(' ')),
        Outcome::Act(Action::Menu(MenuEvent::OpenCard { id: id.clone() }))
    );
    let target = live.pane.model().menu.as_ref().map(|m| m.target.clone());
    assert_eq!(target, Some(MenuTarget::Card { id: id.clone() }));
    assert!(
        live.pane
            .menu_lit()
            .is_some_and(|l| l.starts_with("New session")),
        "starts on its first item: {:?}",
        live.pane.menu_lit()
    );
    let mut term = terminal(40);
    check_snapshot("lanes-40-menu", &draw(&mut live.pane, &mut term));
    assert_eq!(
        live.press(KeyCode::Char('q')),
        Outcome::Nothing,
        "q does not quit"
    );
    assert_eq!(live.press(KeyCode::Up), Outcome::Nothing, "the top item");
    assert_eq!(live.press(KeyCode::Down), Outcome::Redraw);
    assert_eq!(
        live.pane.menu_lit(),
        Some("✓ Lane: Main activity"),
        "past the rule"
    );
    light(&mut live, "Mark read");
    assert_eq!(
        live.press(KeyCode::Enter),
        Outcome::Act(Action::Menu(MenuEvent::Pick(MenuAction::MarkRead)))
    );
    assert!(live.pane.model().menu.is_none(), "a pick closes it");
    assert_eq!(live.pane.cursor(), Some(id.as_str()), "the cursor stays");
}

#[test]
fn a_lane_picked_from_the_menu_moves_the_card_and_esc_closes_with_nothing_picked() {
    let mut live = Live::new("lanes");
    let id = cursor_to(&mut live.pane, "Tidy strip");
    live.press(KeyCode::Char(' '));
    assert_eq!(
        live.press(KeyCode::Esc),
        Outcome::Act(Action::Menu(MenuEvent::Close))
    );
    assert!(live.pane.model().menu.is_none());
    live.press(KeyCode::Char(' '));
    light(&mut live, "Lane: For review");
    live.press(KeyCode::Enter);
    assert!(
        live.lane(LaneKey::from("review")).contains(&id),
        "moved to For review"
    );
}

#[test]
fn the_mouse_rests_while_a_menu_is_open() {
    let mut live = Live::new("lanes");
    let mut term = terminal(40);
    draw(&mut live.pane, &mut term);
    let row = row_of(term.backend().buffer(), "Snapshot tests");
    cursor_to(&mut live.pane, "Tidy strip");
    live.press(KeyCode::Char(' '));
    let down = mouse(MouseEventKind::Down(MouseButton::Left), row);
    assert_eq!(live.handle(&down), Outcome::Nothing);
}

#[test]
fn a_menu_opened_mid_drag_drops_the_drag() {
    let mut live = Live::new("lanes");
    let mut term = terminal(40);
    draw(&mut live.pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let from = row_of(&buffer, "Snapshot tests");
    let onto = row_of(&buffer, "Ended agent");
    live.handle(&mouse(MouseEventKind::Down(MouseButton::Left), from));
    live.handle(&mouse(MouseEventKind::Drag(MouseButton::Left), onto));
    assert!(live.pane.drop_target().is_some());
    live.press(KeyCode::Char(' '));
    assert!(live.pane.model().menu.is_some());
    assert_eq!(live.pane.drop_target(), None, "the menu drops it");
    live.press(KeyCode::Esc);
    let up = mouse(MouseEventKind::Up(MouseButton::Left), onto);
    assert_eq!(live.handle(&up), Outcome::Nothing, "nothing to let go");
}

#[test]
fn space_on_a_project_header_opens_its_menu_and_edit_opens_the_editor() {
    let mut live = Live::new("projects");
    live.press(KeyCode::Down);
    let on = live
        .pane
        .model()
        .project_ids()
        .first()
        .map(|s| s.to_string());
    let target = on.and_then(|id| live.pane.model().project_target(&id));
    let Some(ProjectTarget::Project {
        key, quiet: false, ..
    }) = target
    else {
        panic!("the first row is a project's header: {target:?}");
    };
    assert_eq!(
        live.press(KeyCode::Char(' ')),
        Outcome::Act(Action::Menu(MenuEvent::OpenProject {
            key: key.clone(),
            quiet: false
        }))
    );
    let mut term = terminal(40);
    check_snapshot("projects-40-menu", &draw(&mut live.pane, &mut term));
    light(&mut live, "Edit project");
    live.press(KeyCode::Enter);
    assert!(live.pane.model().menu.is_none());
    let editor = live.pane.model().editor().map(|e| e.key.clone());
    assert_eq!(editor.as_deref(), Some(key.as_str()));
}

#[test]
fn space_on_a_card_in_projects_opens_the_card_menu() {
    let mut live = Live::new("projects");
    let rows = live.pane.model().project_ids().len();
    // Down the rows: Space on each opens its menu, a project's closed again,
    // until one is a card's.
    for _ in 0..rows {
        live.press(KeyCode::Down);
        live.press(KeyCode::Char(' '));
        match live.pane.model().menu.as_ref().map(|m| m.target.clone()) {
            Some(MenuTarget::Card { .. }) => return,
            Some(MenuTarget::Project { .. }) => {
                live.press(KeyCode::Esc);
            }
            None => {}
        }
    }
    panic!("no card in Projects opened the card menu");
}

#[test]
fn builds_the_projects_rows_from_the_core_only_while_projects_is_on() {
    use cockpit_pane::model::ProjectRow;
    let pane = pane_for("projects");
    let rows = &pane.model().projects;
    let heads: Vec<&str> = rows
        .iter()
        .filter_map(|r| match r {
            ProjectRow::Header(h) => Some(h.name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(heads, ["App One", "App Two", "Other"]);
    let quiet: Vec<&str> = rows
        .iter()
        .filter_map(|r| match r {
            ProjectRow::Quiet { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(quiet, ["App Three"]);
    assert!(rows.contains(&ProjectRow::NewProject));
    assert!(
        rows.iter().any(
            |r| matches!(r, ProjectRow::Card(c) if c.title == "One: docs" && c.waiting.is_some())
        ),
        "the waiting card stays in its project, marked waiting"
    );
    assert!(
        pane_for("lanes").model().projects.is_empty(),
        "All builds no Projects rows"
    );
}

#[test]
fn scrolls_the_projects_view_in_a_short_pane_with_the_keys_and_the_wheel() {
    let mut pane = pane_for("projects");
    let mut term = Terminal::new(TestBackend::new(40, 12)).unwrap();
    let top = draw(&mut pane, &mut term);
    assert!(!top.contains("App Three"), "below the fold:\n{top}");
    for _ in 0..40 {
        press(&mut pane, KeyCode::Down);
    }
    let bottom = draw(&mut pane, &mut term);
    assert!(
        bottom.contains("App Three"),
        "the last quiet row is reachable:\n{bottom}"
    );
    assert_eq!(
        press(&mut pane, KeyCode::Down),
        Outcome::Nothing,
        "at the end"
    );
    // A swipe up, which natural scrolling reports as the wheel turning down.
    for _ in 0..40 {
        pane.handle_event(&mouse(MouseEventKind::ScrollDown, 3));
    }
    let back = draw(&mut pane, &mut term);
    assert!(
        back.contains("1 needs you"),
        "the wheel goes back up:\n{back}"
    );
}

#[test]
fn the_wheel_moves_the_projects_cursor_with_the_finger() {
    let screen_after = |steps: &[Event]| {
        let mut pane = pane_for("projects");
        let mut term = terminal(40);
        for step in steps {
            pane.handle_event(step);
        }
        draw(&mut pane, &mut term)
    };
    let key = |code| Event::Key(KeyEvent::new(code, KeyModifiers::NONE));
    let down = key(KeyCode::Down);
    let start = [down.clone(), down.clone(), down.clone()];
    let with = |last: Event| {
        let mut steps = start.to_vec();
        steps.push(last);
        screen_after(&steps)
    };
    assert_ne!(
        with(key(KeyCode::Up)),
        with(down.clone()),
        "the cursor shows on screen"
    );
    assert_eq!(
        with(mouse(MouseEventKind::ScrollDown, 3)),
        with(key(KeyCode::Up)),
        "a swipe up moves the cursor up"
    );
    assert_eq!(
        with(mouse(MouseEventKind::ScrollUp, 3)),
        with(down.clone()),
        "a swipe down moves the cursor down"
    );
}

#[test]
fn the_wheel_leaves_the_projects_cursor_alone_while_the_editor_is_open() {
    let mut live = Live::new("projects");
    assert_eq!(live.press(KeyCode::Down), Outcome::Redraw);
    let open = live.press(KeyCode::Char('e'));
    let Outcome::Act(Action::Edit(EditEvent::Open { key })) = open else {
        panic!("e opens the editor on the first project: {open:?}");
    };
    for kind in [MouseEventKind::ScrollDown, MouseEventKind::ScrollUp] {
        for _ in 0..3 {
            assert_eq!(
                live.pane.handle_event(&mouse(kind, 3)),
                Outcome::Nothing,
                "the wheel does nothing under the editor"
            );
        }
    }
    assert_eq!(
        live.press(KeyCode::Esc),
        Outcome::Act(Action::Edit(EditEvent::Close))
    );
    assert_eq!(
        live.press(KeyCode::Char('e')),
        Outcome::Act(Action::Edit(EditEvent::Open { key })),
        "the cursor is still on the project it was on"
    );
}

#[test]
fn tab_alone_does_not_flip_the_pane_until_the_core_says_so() {
    let mut pane = pane_for("lanes");
    assert_eq!(
        press(&mut pane, KeyCode::Tab),
        Outcome::Act(Action::FlipView)
    );
    assert_eq!(pane.view(), PaneView::All, "no second copy of the view");
}

#[test]
fn two_quick_shift_downs_move_the_card_two_places_not_one() {
    let mut live = Live::new("lanes");
    let working = cursor_to(&mut live.pane, "Snapshot tests");
    let quiet = id_of(&live.pane, "Long build");
    let selected = id_of(&live.pane, "Selected card");
    let merged = id_of(&live.pane, "Card layout fit");
    let first = live.shift(KeyCode::Down);
    assert_eq!(
        first,
        move_card(&working, LaneKey::from("main"), Some(&selected))
    );
    let second = live.shift(KeyCode::Down);
    assert_eq!(
        second,
        move_card(&working, LaneKey::from("main"), Some(&merged)),
        "worked out from where the core holds it after the first"
    );
    let main = live.lane(LaneKey::from("main"));
    let at = |id: &str| main.iter().position(|r| r == id).unwrap();
    assert!(at(&quiet) < at(&selected) && at(&selected) < at(&working));
    assert_eq!(live.pane.cursor(), Some(working.as_str()));
}

#[test]
fn a_move_a_dismissal_and_a_drag_show_in_the_pane_from_the_core() {
    let mut live = Live::new("lanes");
    let tidy = cursor_to(&mut live.pane, "Tidy strip");
    live.press(KeyCode::Char('m'));
    live.press(KeyCode::Char('4'));
    let parked = &live.core.view.lane_headers[&LaneKey::from("parked")].workspaces;
    assert!(
        parked.contains(&tidy),
        "filed in Parked, which draws folded"
    );
    assert!(!live.lane(LaneKey::from("main")).contains(&tidy));

    let mut term = terminal(40);
    draw(&mut live.pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let snapshot = id_of(&live.pane, "Snapshot tests");
    let from = row_of(&buffer, "Snapshot tests");
    let onto = row_of(&buffer, "UNSORTED");
    live.handle(&mouse(MouseEventKind::Down(MouseButton::Left), from));
    live.handle(&mouse(MouseEventKind::Drag(MouseButton::Left), onto));
    live.handle(&mouse(MouseEventKind::Up(MouseButton::Left), onto));
    assert!(live.lane(LaneKey::unsorted()).contains(&snapshot));

    let mut live = Live::new("needs-and-next");
    let oldest = cursor_to(&mut live.pane, "Oldest question");
    let count = live.pane.model().needs.count;
    assert!(live.pane.model().is_waiting(&oldest));
    live.press(KeyCode::Char('d'));
    assert!(!live.pane.model().is_waiting(&oldest), "its edge drops");
    assert!(
        live.pane.model().is_lane_card(&oldest),
        "it stays in its lane"
    );
    assert_eq!(live.pane.model().needs.count, count - 1, "out of the count");
}

/// The pane has no key of its own for Next ('n' makes a project), so a
/// waiting card in a folded lane is no cursor stop; Next, from the
/// sidebar's pill or button, unfolds its lane, and the pane follows.
#[test]
fn next_unfolds_the_lane_hiding_a_waiting_card_and_the_cursor_reaches_it() {
    let mut live = Live::new("needs-and-next");
    let step = cockpit_core::Cockpit.view(&live.core).next.step;
    let id = step.map(|s| s.target).unwrap_or_default();
    let title = card_of(&live.pane, &id)
        .map(|c| c.title)
        .unwrap_or_default();
    let lane = live.pane.model().lane_of(&id).unwrap();
    assert!(
        live.pane.model().is_waiting(&id),
        "Next goes to a waiting card"
    );
    live.core_event(cockpit_core::Event::ToggleLane { lane: lane.clone() });
    assert!(!live.pane.model().is_lane_card(&id), "folded away");
    live.core_event(cockpit_core::Event::Next);
    assert!(live.pane.model().is_lane_card(&id), "its lane unfolds");
    assert_eq!(live.pane.model().lane_of(&id), Some(lane));
    assert!(card_of(&live.pane, &id).is_some_and(|c| c.selected && c.waiting.is_some()));
    assert_eq!(cursor_to(&mut live.pane, &title), id);
}

#[test]
fn the_card_keys_and_the_mouse_rest_under_the_keys_overlay() {
    let mut pane = pane_for("lanes");
    cursor_to(&mut pane, "Tidy strip");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    press(&mut pane, KeyCode::Char('?'));
    for code in [
        KeyCode::Tab,
        KeyCode::Enter,
        KeyCode::Char('d'),
        KeyCode::Char('m'),
        KeyCode::Char('1'),
    ] {
        assert_eq!(
            press(&mut pane, code),
            Outcome::Nothing,
            "{code:?} under the keys"
        );
    }
    assert_eq!(shift(&mut pane, KeyCode::Up), Outcome::Nothing);
    assert!(!pane.picking());
    let row = row_of(term.backend().buffer(), "Snapshot tests");
    assert_eq!(
        pane.handle_event(&mouse(MouseEventKind::Down(MouseButton::Left), row)),
        Outcome::Nothing
    );
    assert_eq!(pane.view(), PaneView::All);
}

fn mouse(kind: MouseEventKind, row: u16) -> Event {
    Event::Mouse(MouseEvent {
        kind,
        column: 10,
        row,
        modifiers: KeyModifiers::NONE,
    })
}

/// The screen row `needle` first shows on.
fn row_of(buffer: &Buffer, needle: &str) -> u16 {
    let w = usize::from(buffer.area.width);
    let y = buffer
        .content
        .chunks(w)
        .position(|row| {
            row.iter()
                .map(|c| c.symbol())
                .collect::<String>()
                .contains(needle)
        })
        .unwrap_or_else(|| panic!("{needle} is not on screen"));
    u16::try_from(y).unwrap()
}

#[test]
fn a_drag_shows_where_the_card_would_land_and_letting_go_places_it() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    let screen = draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let snapshot = id_of(&pane, "Snapshot tests");
    let ended = id_of(&pane, "Ended agent");

    let from = row_of(&buffer, "Snapshot tests");
    assert_eq!(
        pane.handle_event(&mouse(MouseEventKind::Down(MouseButton::Left), from)),
        Outcome::Redraw
    );
    assert_eq!(
        pane.cursor(),
        Some(snapshot.as_str()),
        "a press puts the cursor there"
    );

    let onto = row_of(&buffer, "Ended agent");
    let drag = MouseEventKind::Drag(MouseButton::Left);
    assert_eq!(pane.handle_event(&mouse(drag, onto)), Outcome::Redraw);
    assert_eq!(
        pane.handle_event(&mouse(drag, onto)),
        Outcome::Nothing,
        "same spot"
    );
    check_snapshot("lanes-40-drag", &draw(&mut pane, &mut term));

    assert_eq!(
        pane.handle_event(&mouse(MouseEventKind::Up(MouseButton::Left), onto)),
        move_card(&snapshot, LaneKey::from("review"), Some(&ended))
    );
    assert_eq!(pane.drop_target(), None);
    assert!(!screen.is_empty());
}

#[test]
fn a_drag_onto_a_header_or_past_the_end_lands_at_the_top_or_the_end() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let snapshot = id_of(&pane, "Snapshot tests");
    let loose = id_of(&pane, "Loose workspace");
    let from = row_of(&buffer, "Snapshot tests");
    let down = MouseEventKind::Down(MouseButton::Left);
    let up = MouseEventKind::Up(MouseButton::Left);

    pane.handle_event(&mouse(down, from));
    let header = row_of(&buffer, "UNSORTED");
    assert_eq!(
        pane.handle_event(&mouse(up, header)),
        move_card(&snapshot, LaneKey::unsorted(), Some(&loose))
    );

    pane.handle_event(&mouse(down, from));
    assert_eq!(
        pane.handle_event(&mouse(up, HEIGHT - 1)),
        move_card(&snapshot, LaneKey::unsorted(), None),
        "below every lane is the last lane's end; Loose workspace is pinned, so no peer"
    );
}

#[test]
fn a_click_or_a_drag_back_to_where_it_was_places_nothing() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let from = row_of(&buffer, "Snapshot tests");
    let down = MouseEventKind::Down(MouseButton::Left);
    let up = MouseEventKind::Up(MouseButton::Left);

    pane.handle_event(&mouse(down, from));
    assert_eq!(
        pane.handle_event(&mouse(up, from)),
        Outcome::Redraw,
        "a click"
    );

    pane.handle_event(&mouse(down, from));
    let needs = row_of(&buffer, "2 need you");
    assert_eq!(
        pane.handle_event(&mouse(up, needs)),
        Outcome::Redraw,
        "onto the Needs you line"
    );
}

#[test]
fn a_waiting_card_drags_like_any_other() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let chip = id_of(&pane, "Chip colours");
    assert!(pane.model().is_waiting(&chip));
    let down = MouseEventKind::Down(MouseButton::Left);
    let drag = MouseEventKind::Drag(MouseButton::Left);
    let up = MouseEventKind::Up(MouseButton::Left);
    let onto = row_of(&buffer, "UNSORTED");
    pane.handle_event(&mouse(down, row_of(&buffer, "Your turn: Which")));
    pane.handle_event(&mouse(drag, onto));
    assert_eq!(
        pane.handle_event(&mouse(up, onto)),
        move_card(
            &chip,
            LaneKey::unsorted(),
            Some(&id_of(&pane, "Loose workspace"))
        ),
        "at the top, under the header"
    );
}

#[test]
fn a_press_on_a_waiting_cards_reason_puts_the_cursor_there_and_the_wheel_moves_it_with_the_finger()
{
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let release = id_of(&pane, "Release notes");
    // Cut at 40 columns to leave room for its age.
    let row = row_of(&buffer, "Asking: allow git");
    let down = MouseEventKind::Down(MouseButton::Left);
    assert_eq!(pane.handle_event(&mouse(down, row)), Outcome::Redraw);
    assert_eq!(pane.cursor(), Some(release.as_str()));

    // A swipe up, which natural scrolling reports as the wheel turning down,
    // moves the cursor to the card above; a swipe down brings it back.
    assert_eq!(
        pane.handle_event(&mouse(MouseEventKind::ScrollDown, 0)),
        Outcome::Redraw
    );
    assert_eq!(pane.cursor(), Some(id_of(&pane, "Chip colours").as_str()));
    assert_eq!(
        pane.handle_event(&mouse(MouseEventKind::ScrollUp, 0)),
        Outcome::Redraw
    );
    assert_eq!(pane.cursor(), Some(release.as_str()));
}

#[test]
fn the_mouse_rests_while_the_lane_picker_is_up_or_in_projects() {
    let mut live = Live::new("lanes");
    let mut term = terminal(40);
    draw(&mut live.pane, &mut term);
    let row = row_of(term.backend().buffer(), "Snapshot tests");
    let down = mouse(MouseEventKind::Down(MouseButton::Left), row);
    cursor_to(&mut live.pane, "Tidy strip");
    live.press(KeyCode::Char('m'));
    assert_eq!(live.handle(&down), Outcome::Nothing, "picking");
    live.press(KeyCode::Esc);
    live.press(KeyCode::Tab);
    assert_eq!(live.handle(&down), Outcome::Nothing, "in Projects");
}

#[test]
fn down_past_the_last_waiting_card_scrolls_to_the_lanes_below() {
    let mut model = pane_for("lanes").model().clone();
    for lane in &mut model.lanes {
        lane.rows.retain(|r| r.card().waiting.is_some());
    }
    let mut pane = Pane::new(model);
    assert_eq!(pane.model().card_ids().len(), 2, "only the waiting cards");
    short_screen(&mut pane, 0);
    let bottom = short_screen(&mut pane, 40);
    assert!(
        bottom.contains("UNSORTED"),
        "scrolled to the end:\n{bottom}"
    );
    assert_eq!(press(&mut pane, KeyCode::Up), Outcome::Redraw);
}

#[test]
fn the_lane_picker_moves_the_card_m_was_pressed_on_or_nothing_once_it_goes() {
    let mut pane = pane_for("lanes");
    let tidy = cursor_to(&mut pane, "Tidy strip");
    press(&mut pane, KeyCode::Char('m'));
    let mut gone = pane.model().clone();
    for lane in &mut gone.lanes {
        lane.rows.retain(|r| r.ws_id() != tidy);
    }
    pane.set_view_model(gone);
    assert!(!pane.picking(), "its card went");
    assert_ne!(pane.cursor(), Some(tidy.as_str()));
    assert_eq!(press(&mut pane, KeyCode::Char('4')), Outcome::Nothing);
}

#[test]
fn the_keys_or_the_lane_picker_drop_a_drag_under_way() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let from = row_of(&buffer, "Snapshot tests");
    let onto = row_of(&buffer, "Ended agent");
    for key in ['?', 'm'] {
        pane.handle_event(&mouse(MouseEventKind::Down(MouseButton::Left), from));
        pane.handle_event(&mouse(MouseEventKind::Drag(MouseButton::Left), onto));
        assert!(pane.drop_target().is_some());
        press(&mut pane, KeyCode::Char(key));
        assert_eq!(pane.drop_target(), None, "{key} drops it");
        press(&mut pane, KeyCode::Esc);
        let up = mouse(MouseEventKind::Up(MouseButton::Left), onto);
        assert_eq!(
            pane.handle_event(&up),
            Outcome::Nothing,
            "nothing to let go"
        );
    }
}

/// The lanes scene's model with `f` applied to the card titled `title`.
fn with_card(pane: &Pane, title: &str, f: impl Fn(&mut cockpit_pane::model::Card)) -> PaneModel {
    let mut model = pane.model().clone();
    for row in model.lanes.iter_mut().flat_map(|l| &mut l.rows) {
        if let cockpit_pane::model::Row::Card(c) = row
            && c.title == title
        {
            f(c);
        }
    }
    model
}

#[test]
fn a_flip_from_outside_drops_the_lane_picker_and_a_drag() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    cursor_to(&mut pane, "Tidy strip");
    press(&mut pane, KeyCode::Char('m'));
    let mut projects = pane.model().clone();
    projects.view = PaneView::Projects;
    pane.set_view_model(projects.clone());
    assert!(!pane.picking(), "the picker closes");

    let mut back = projects;
    back.view = PaneView::All;
    pane.set_view_model(back.clone());
    let from = row_of(&buffer, "Snapshot tests");
    pane.handle_event(&mouse(MouseEventKind::Down(MouseButton::Left), from));
    let onto = row_of(&buffer, "Ended agent");
    pane.handle_event(&mouse(MouseEventKind::Drag(MouseButton::Left), onto));
    assert!(pane.drop_target().is_some());
    back.view = PaneView::Projects;
    pane.set_view_model(back);
    assert_eq!(pane.drop_target(), None, "the drag ends");
}

#[test]
fn a_drag_holds_when_its_card_starts_asking_and_ends_when_it_goes() {
    let mut pane = pane_for("lanes");
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    let snapshot = id_of(&pane, "Snapshot tests");
    let from = row_of(&buffer, "Snapshot tests");
    let onto = row_of(&buffer, "Ended agent");
    pane.handle_event(&mouse(MouseEventKind::Down(MouseButton::Left), from));
    pane.handle_event(&mouse(MouseEventKind::Drag(MouseButton::Left), onto));
    let mut asking = pane.model().clone();
    for row in asking.lanes.iter_mut().flat_map(|l| &mut l.rows) {
        if let cockpit_pane::model::Row::Card(c) = row
            && c.ws_id == snapshot
        {
            c.waiting = Some(cockpit_pane::model::Waiting {
                mark: Token::Amber,
                ink: Token::AmberText,
            });
        }
    }
    pane.set_view_model(asking.clone());
    assert!(
        pane.drop_target().is_some(),
        "it stays in its lane, so the drag holds (issue #281)"
    );
    let mut gone = asking;
    for lane in &mut gone.lanes {
        lane.rows.retain(|r| r.ws_id() != snapshot);
    }
    pane.set_view_model(gone);
    assert_eq!(pane.drop_target(), None);
    let up = mouse(MouseEventKind::Up(MouseButton::Left), onto);
    assert_eq!(pane.handle_event(&up), Outcome::Nothing, "nothing to place");
}

#[test]
fn a_card_that_anchors_another_group_is_not_moved() {
    let mut pane = pane_for("lanes");
    let model = with_card(&pane, "Snapshot tests", |c| c.movable = false);
    pane.set_view_model(model);
    let mut term = terminal(40);
    draw(&mut pane, &mut term);
    let buffer = term.backend().buffer().clone();
    cursor_to(&mut pane, "Snapshot tests");
    assert_eq!(press(&mut pane, KeyCode::Char('m')), Outcome::Nothing);
    assert_eq!(shift(&mut pane, KeyCode::Down), Outcome::Nothing);
    let from = row_of(&buffer, "Snapshot tests");
    let onto = row_of(&buffer, "Ended agent");
    pane.handle_event(&mouse(MouseEventKind::Down(MouseButton::Left), from));
    assert_eq!(
        pane.handle_event(&mouse(MouseEventKind::Drag(MouseButton::Left), onto)),
        Outcome::Nothing,
        "no drag starts"
    );
    assert_eq!(
        press(&mut pane, KeyCode::Enter),
        Outcome::Act(Action::SwitchTo {
            id: id_of(&pane, "Snapshot tests")
        }),
        "it can still be switched to"
    );
}

#[test]
fn a_short_pane_keeps_the_way_to_close_the_keys() {
    let mut pane = pane_for("lanes");
    let mut term = Terminal::new(TestBackend::new(40, 8)).unwrap();
    press(&mut pane, KeyCode::Char('?'));
    let screen = draw(&mut pane, &mut term);
    assert!(screen.contains("close this"), "{screen}");
}

#[test]
fn shows_the_quiet_heading_below_the_last_row_in_a_short_projects_pane() {
    let mut live = Live::new("projects");
    // Quiet folded, so "+ New project" is the last row and the heading
    // sits under it with nothing to move the cursor onto.
    let data = live.core.data.clone().unwrap_or_default();
    live.core.session.toggle_quiet(&data);
    live.pane
        .set_view_model(PaneModel::from_core(&mut live.core));
    let rows = live.pane.model().project_ids().len();
    for _ in 0..rows + 2 {
        live.press(KeyCode::Down);
    }
    let mut term = Terminal::new(TestBackend::new(40, 10)).unwrap();
    let screen = draw(&mut live.pane, &mut term);
    assert!(
        screen.contains("Quiet"),
        "the last row scrolls to the end:\n{screen}"
    );
}

#[test]
fn keeps_the_editors_foot_line_in_sight_on_its_last_field() {
    let mut live = Live::new("projects");
    live.press(KeyCode::Char('n'));
    for _ in 0..10 {
        live.press(KeyCode::Down);
    }
    let mut term = Terminal::new(TestBackend::new(40, 10)).unwrap();
    let screen = draw(&mut live.pane, &mut term);
    assert!(
        screen.contains("Type the project's folder."),
        "why Done would not save shows under the last field:\n{screen}"
    );
}

#[test]
fn types_a_space_in_the_middle_of_a_folder() {
    let mut live = Live::new("projects");
    live.press(KeyCode::Char('n'));
    for c in "/opt/my code".chars() {
        live.press(KeyCode::Char(c));
    }
    assert_eq!(
        live.core.session.draft_spec().root.as_deref(),
        Some("/opt/my code")
    );
}

/// The card `id` as the pane's lanes hold it.
fn card_of(pane: &Pane, id: &str) -> Option<cockpit_pane::model::Card> {
    pane.model()
        .lanes
        .iter()
        .flat_map(|l| &l.rows)
        .find_map(|r| match r {
            cockpit_pane::model::Row::Card(c) if c.ws_id == id => Some(c.as_ref().clone()),
            _ => None,
        })
}

/// The words of a card's chips, in order.
fn chip_words(pane: &Pane, id: &str) -> Vec<String> {
    card_of(pane, id)
        .map(|c| {
            c.chips
                .iter()
                .flat_map(|chip| chip.pieces.iter().map(|p| p.text.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the cell where `needle` starts is drawn dim.
fn is_dim(buffer: &Buffer, needle: &str) -> bool {
    cell_at(buffer, needle).modifier.contains(Modifier::DIM)
}

#[test]
fn a_merged_card_shows_its_branch_as_any_card_does_and_a_row_has_no_chips() {
    let pane = pane_for("lanes");
    let full = id_of(&pane, "Card layout fit");
    assert_eq!(
        chip_words(&pane, &full),
        ["#176", "merged", "card-layout-fit"]
    );
    let row = id_of(&pane, "Merged elsewhere");
    assert!(chip_words(&pane, &row).is_empty());
}

#[test]
fn a_merged_card_draws_dim_until_the_cursor_is_on_it() {
    let mut pane = pane_for("lanes");
    let id = id_of(&pane, "Card layout fit");
    assert!(card_of(&pane, &id).is_some_and(|c| c.dimmed));
    let mut term = terminal(80);
    pane.draw(&mut term).unwrap();
    assert!(is_dim(term.backend().buffer(), "Card layout fit"));
    assert!(is_dim(term.backend().buffer(), "card-layout-fit"));
    assert!(!is_dim(term.backend().buffer(), "Snapshot tests"));
    cursor_to(&mut pane, "Card layout fit");
    pane.draw(&mut term).unwrap();
    assert!(!is_dim(term.backend().buffer(), "Card layout fit"));
}
