//! Draws a golden cockpit scene in the terminal, as the pane will draw live
//! data once the runner (#206) feeds it: up and down move the cursor, `?`
//! shows the keys, `q` quits, and resizing the window redraws.
//!
//!     cargo run -p cockpit_pane --example scene -- [scene]
//!
//! The scene is one of lanes (the default), needs-and-next, projects or
//! review-verdicts. `--html <columns>` prints the scene as a coloured HTML
//! page instead, for a picture without a terminal.

#[path = "../tests/support/golden.rs"]
mod golden;

use std::error::Error;
use std::fmt::Write as _;

use cockpit_pane::{Outcome, Pane, PaneModel, theme};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event;
use ratatui::style::{Color, Modifier};
use ratatui::{DefaultTerminal, Terminal};

use golden::{SCENES, scene_model};

/// The picture's height in rows.
const HTML_ROWS: u16 = 48;

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut scene = "lanes".to_string();
    let mut html: Option<u16> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--html" {
            let cols = rest.next().ok_or("--html needs a width in columns")?;
            html = Some(cols.parse()?);
        } else {
            scene.clone_from(arg);
        }
    }
    if !SCENES.contains(&scene.as_str()) {
        return Err(format!("no scene called {scene}; try one of {}", SCENES.join(", ")).into());
    }
    let mut core = scene_model(&scene)?;
    let mut pane = Pane::new(PaneModel::from_core(&mut core));
    if let Some(cols) = html {
        print!("{}", picture(&mut pane, cols)?);
        return Ok(());
    }
    let mut terminal = ratatui::try_init()?;
    let result = run(&mut terminal, &mut pane);
    ratatui::restore();
    result
}

/// Draws whenever the pane asks, and hands it every terminal event.
fn run(terminal: &mut DefaultTerminal, pane: &mut Pane) -> Result<(), Box<dyn Error>> {
    loop {
        pane.draw(terminal)?;
        if pane.handle_event(&event::read()?) == Outcome::Quit {
            return Ok(());
        }
    }
}

/// The scene drawn at `cols` columns as an HTML page, cell by cell.
fn picture(pane: &mut Pane, cols: u16) -> Result<String, Box<dyn Error>> {
    let mut terminal = Terminal::new(TestBackend::new(cols, HTML_ROWS))?;
    pane.draw(&mut terminal)?;
    Ok(html_of(terminal.backend().buffer()))
}

fn css(c: Color, fallback: u32) -> String {
    match c {
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        _ => format!("#{fallback:06x}"),
    }
}

fn html_of(buffer: &Buffer) -> String {
    let mut out = String::from(
        "<!doctype html><meta charset=utf-8><body style=\"margin:0\"><pre style=\"margin:0;\
         font:15px/1.25 Menlo,monospace\">",
    );
    let width = usize::from(buffer.area.width);
    for row in buffer.content.chunks(width) {
        for cell in row {
            let fg = css(cell.fg, theme::TEXT);
            let bg = css(cell.bg, theme::GROUND);
            let weight = if cell.modifier.contains(Modifier::BOLD) {
                "bold"
            } else {
                "normal"
            };
            let symbol = match cell.symbol() {
                "<" => "&lt;",
                ">" => "&gt;",
                "&" => "&amp;",
                s => s,
            };
            // Writing to a String cannot fail.
            let _ = write!(
                out,
                "<span style=\"color:{fg};background:{bg};font-weight:{weight}\">{symbol}</span>"
            );
        }
        out.push('\n');
    }
    out.push_str("</pre>");
    out
}
