//! The two fixed lines at the top: the view switch with the keys hint,
//! then Next with where it goes and "1 of N"; and the line the Projects
//! view shows until it is drawn.

use ratatui::text::{Line, Span};

use super::parts::{Edge, spans_width, spread};
use crate::model::{
    ALL_LABEL, KEYS_HINT, NEXT_LABEL, NEXT_NOTHING, NextLine, PROJECTS_LABEL, PROJECTS_SOON,
    PaneView,
};
use crate::text::{fit, width, wrap};
use crate::theme;
use cockpit_core::theme::Token;
use ratatui::style::{Modifier, Style};

/// The view switch: the view on screen lit, the other faint, and the hint.
pub fn switch(inner: usize, view: PaneView) -> Line<'static> {
    let lit = Style::new()
        .fg(theme::rgb(theme::GROUND))
        .bg(theme::colour(Token::Select))
        .add_modifier(Modifier::BOLD);
    let (first, second) = match view {
        PaneView::All => (ALL_LABEL, PROJECTS_LABEL),
        PaneView::Projects => (PROJECTS_LABEL, ALL_LABEL),
    };
    let first = Span::styled(format!(" {first} "), lit);
    let second_room = inner.saturating_sub(width(&first.content) + 1);
    let second = Span::styled(fit(second, second_room), theme::ink(Token::Faint));
    // The views keep their order: All, then Projects.
    let left = match view {
        PaneView::All => vec![first, Span::raw(" "), second],
        PaneView::Projects => vec![second, Span::raw(" "), first],
    };
    let room = inner.saturating_sub(spans_width(&left) + 1);
    let right = vec![Span::styled(fit(KEYS_HINT, room), theme::ink(Token::Faint))];
    spread(left, right, inner, Edge::Plain)
}

/// The Projects view's body until it is drawn: a few faint lines.
pub fn projects_soon(inner: usize) -> Vec<Line<'static>> {
    wrap(PROJECTS_SOON, inner, 3)
        .into_iter()
        .map(|l| {
            let words = Span::styled(l, theme::ink(Token::Faint));
            spread(vec![words], Vec::new(), inner, Edge::Plain)
        })
        .collect()
}

/// Next: its label, the workspace it goes to, and its place in the queue.
pub fn next(line: &NextLine, inner: usize) -> Line<'static> {
    let label = Span::styled(NEXT_LABEL, theme::strong(Token::Heading));
    let room = inner.saturating_sub(width(NEXT_LABEL) + 2);
    match line {
        NextLine::Step { title, place } => {
            let place = fit(place, room);
            let title_room = room.saturating_sub(width(&place) + 1);
            let left = vec![
                label,
                Span::raw("  "),
                Span::styled(fit(title, title_room), theme::title()),
            ];
            let right = vec![Span::styled(place, theme::ink(Token::MetaText))];
            spread(left, right, inner, Edge::Plain)
        }
        NextLine::Nothing => {
            let left = vec![
                label,
                Span::raw("  "),
                Span::styled(fit(NEXT_NOTHING, room), theme::ink(Token::Faint)),
            ];
            spread(left, Vec::new(), inner, Edge::Plain)
        }
    }
}
