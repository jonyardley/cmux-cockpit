//! The Projects view: each busy project's header (fold mark, its mark in
//! the project's colour, name, count pill, folded dot, and "+" when it has
//! a folder), its cards with their chips and the placeholders of cards
//! waiting in Needs you; then "+ New project", and the Quiet header over
//! a row for each project with no sessions.

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use super::lanes::{CARD_LEAD, card, ghost};
use super::parts::{Edge, pill, spans_width, spread};
use crate::model::{
    FOLDED_MARK, LANE_MARK, NEW_PROJECT_LABEL, OPEN_MARK, PLUS_MARK, ProjectHead, ProjectRow,
    QUIET_LABEL,
};
use crate::text::fit;
use crate::theme;
use cockpit_core::theme::Token;
use cockpit_core::ui::QUIET_PILL;

/// Lays out the Projects view's rows.
pub fn lines(rows: &[ProjectRow], inner: usize) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    for row in rows {
        match row {
            ProjectRow::Header(h) => {
                out.push(Line::default());
                out.push(header(h, inner));
            }
            ProjectRow::Card(c) => out.extend(card(c, inner, false, false)),
            ProjectRow::Ghost { title, text, .. } => out.push(ghost(title, text, inner, false)),
            ProjectRow::NewProject => {
                out.push(Line::default());
                let words = fit(NEW_PROJECT_LABEL, inner.saturating_sub(2));
                let spans = vec![
                    Span::raw("  "),
                    Span::styled(words, theme::ink(Token::Faint)),
                ];
                out.push(spread(spans, Vec::new(), inner, Edge::Plain));
            }
            ProjectRow::QuietHeader { count, collapsed } => {
                out.push(Line::default());
                out.push(quiet_header(*count, *collapsed, inner));
            }
            ProjectRow::Quiet {
                name,
                color,
                can_open,
            } => out.push(quiet_row(name, *color, *can_open, inner)),
        }
    }
    out
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

fn header(h: &ProjectHead, inner: usize) -> Line<'static> {
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
    spread(left, right, inner, Edge::Plain)
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
fn quiet_row(name: &str, color: Option<u32>, can_open: bool, inner: usize) -> Line<'static> {
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
    spread(left, right, inner, Edge::Plain)
}
