//! The Projects view: each busy project's header (fold mark, its mark in
//! the project's colour, name, count pill, folded dot, and "+" when it has
//! a folder), its cards with their chips and the placeholders of cards
//! waiting in Needs you; then "+ New project", and the Quiet header over
//! a row for each project with no sessions. The open editor sits under
//! its project's row (editor.rs). The cursor's row has the bar and face a
//! card under the cursor has.

use std::ops::Range;

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::editor;
use super::lanes::{CARD_LEAD, card, ghost};
use super::parts::{Edge, pill, spans_width, spread};
use crate::editor::Field;
use crate::model::{
    FOLDED_MARK, LANE_MARK, NEW_PROJECT_LABEL, NEW_ROW, OPEN_MARK, PLUS_MARK, ProjectHead,
    ProjectRow, QUIET_LABEL,
};
use crate::text::fit;
use crate::theme;
use cockpit_core::theme::Token;
use cockpit_core::ui::QUIET_PILL;

/// The Projects view laid out: its lines, and the lines to keep in sight
/// (the cursor's row, or the editor's focused field).
#[derive(Default)]
pub struct Laid {
    pub lines: Vec<Line<'static>>,
    pub focus: Option<Range<usize>>,
}

/// The cursor's face over a row's lines.
fn lit(lines: Vec<Line<'static>>, on: bool) -> Vec<Line<'static>> {
    if !on {
        return lines;
    }
    let face = Style::new().bg(theme::rgb(theme::CURSOR_BG));
    lines.into_iter().map(|l| l.patch_style(face)).collect()
}

fn edge(on: bool) -> Edge {
    if on { Edge::Cursor } else { Edge::Plain }
}

/// Lays out the Projects view's rows, with the cursor's row and, while
/// the editor is open, its focused field.
pub fn lines(rows: &[ProjectRow], inner: usize, cursor: Option<&str>, field: Field) -> Laid {
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut focus = None;
    for row in rows {
        let on = |id: &str| cursor == Some(id);
        let (lines, at): (Vec<Line<'static>>, Option<Range<usize>>) = match row {
            ProjectRow::Header(h) => {
                out.push(Line::default());
                let on = on(&h.id);
                (
                    lit(vec![header(h, inner, edge(on))], on),
                    on.then_some(0..1),
                )
            }
            ProjectRow::Card(c) => {
                let on = on(&c.ws_id);
                let lines = card(c, inner, on, false);
                let n = lines.len();
                (lines, on.then_some(0..n))
            }
            ProjectRow::Ghost { title, text, .. } => (vec![ghost(title, text, inner, false)], None),
            ProjectRow::NewProject => {
                out.push(Line::default());
                let on = on(NEW_ROW);
                let words = fit(NEW_PROJECT_LABEL, inner.saturating_sub(2));
                let spans = vec![
                    Span::raw("  "),
                    Span::styled(words, theme::ink(Token::Faint)),
                ];
                let line = spread(spans, Vec::new(), inner, edge(on));
                (lit(vec![line], on), on.then_some(0..1))
            }
            ProjectRow::Editor(e) => {
                let laid = editor::lines(e, inner, field);
                (laid.lines, laid.focus)
            }
            ProjectRow::QuietHeader { count, collapsed } => {
                out.push(Line::default());
                (vec![quiet_header(*count, *collapsed, inner)], None)
            }
            ProjectRow::Quiet {
                id,
                name,
                color,
                can_open,
                ..
            } => {
                let on = on(id);
                let line = quiet_row(name, *color, *can_open, inner, edge(on));
                (lit(vec![line], on), on.then_some(0..1))
            }
        };
        let lead = out.len();
        // The editor's field wins over the row the cursor rests on.
        if let Some(r) = at
            && (focus.is_none() || matches!(row, ProjectRow::Editor(_)))
        {
            focus = Some(r.start + lead..r.end + lead);
        }
        out.extend(lines);
    }
    Laid { lines: out, focus }
}

/// A project's mark in its own colour, or the grey of a dot with none.
fn mark(color: Option<u32>) -> Span<'static> {
    let style = match color {
        Some(hex) => theme::plain(hex),
        None => theme::plain(theme::GREY),
    };
    Span::styled(LANE_MARK, style)
}

/// "+" at the right, faint, when the project has a folder to open.
fn plus(can_open: bool) -> Vec<Span<'static>> {
    if can_open {
        vec![Span::styled(PLUS_MARK, theme::ink(Token::Faint))]
    } else {
        Vec::new()
    }
}

fn header(h: &ProjectHead, inner: usize, edge: Edge) -> Line<'static> {
    let chevron = if h.collapsed { FOLDED_MARK } else { OPEN_MARK };
    let lead = vec![
        Span::styled(chevron, theme::ink(Token::Faint)),
        Span::raw(" "),
        mark(h.color),
        Span::raw(" "),
    ];
    let mut tail = vec![Span::raw(" "), pill(h.count, h.pill)];
    if let Some(dot) = &h.dot {
        tail.push(Span::raw(" "));
        tail.push(Span::styled(dot.glyph, theme::icon(dot.ink)));
    }
    let right = plus(h.can_open);
    let fixed = spans_width(&lead) + spans_width(&tail) + spans_width(&right) + 1;
    let name = fit(&h.name, inner.saturating_sub(fixed));
    let mut left = lead;
    left.push(Span::styled(
        name,
        theme::plain(theme::SECONDARY).add_modifier(Modifier::BOLD),
    ));
    left.extend(tail);
    spread(left, right, inner, edge)
}

fn quiet_header(count: usize, collapsed: bool, inner: usize) -> Line<'static> {
    let chevron = if collapsed { FOLDED_MARK } else { OPEN_MARK };
    let lead = vec![
        Span::styled(chevron, theme::ink(Token::Faint)),
        Span::raw(" "),
    ];
    let tail = vec![Span::raw(" "), pill(count, QUIET_PILL)];
    let room = inner.saturating_sub(spans_width(&lead) + spans_width(&tail));
    let mut left = lead;
    left.push(Span::styled(
        fit(QUIET_LABEL, room),
        theme::strong(Token::Faint),
    ));
    left.extend(tail);
    spread(left, Vec::new(), inner, Edge::Plain)
}

/// A project with no sessions: its mark and name, dimmed with no folder
/// to open, and "+" with one.
fn quiet_row(
    name: &str,
    color: Option<u32>,
    can_open: bool,
    inner: usize,
    edge: Edge,
) -> Line<'static> {
    let lead = vec![
        Span::raw(" ".repeat(CARD_LEAD - 2)),
        mark(color),
        Span::raw(" "),
    ];
    let right = plus(can_open);
    let room = inner.saturating_sub(spans_width(&lead) + spans_width(&right) + 1);
    let ink = if can_open {
        theme::plain(theme::SECONDARY)
    } else {
        theme::ink(Token::Faint)
    };
    let mut left = lead;
    left.push(Span::styled(fit(name, room), ink));
    spread(left, right, inner, edge)
}
