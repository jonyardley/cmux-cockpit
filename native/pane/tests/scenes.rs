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

use cockpit_core::theme::Token;
use cockpit_pane::{Outcome, Pane, PaneModel, theme};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::Color;

use support::golden::{SCENES, scene_model};

const WIDTHS: [u16; 2] = [40, 80];
/// Tall enough for every scene's lanes, so the snapshot holds them all.
const HEIGHT: u16 = 64;

/// Glyphs the pane draws that are not words.
const MARKS: &str = "▌▸▾■●○◌─│┌┐└┘";
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
    let words: HashSet<String> = model
        .words()
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
    let words = pane.model().words();
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
        lane.rows
            .retain(|r| matches!(r, cockpit_pane::model::Row::Ghost { .. }));
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
    let w = usize::from(buffer.area.width);
    for (y, row) in buffer.content.chunks(w).enumerate() {
        let line: String = row.iter().map(|c| c.symbol()).collect();
        if let Some(byte) = line.find(needle) {
            let x = line[..byte].chars().count();
            let cell = &row[x];
            assert!(y < usize::from(buffer.area.height));
            return (cell.fg, cell.bg);
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
    let (fg, bg) = cell_colours(buffer, "Needs you");
    assert_eq!(fg, theme::colour(Token::ClayText));
    assert_eq!(bg, theme::rgb(theme::NEEDS_BG));
    let (fg, _) = cell_colours(buffer, "Next");
    assert_eq!(fg, theme::colour(Token::Heading));
}
