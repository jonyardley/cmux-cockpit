//! The two fixed lines at the top: the view switch with the keys hint,
//! then Next with where it goes and "1 of N".

use ratatui::text::{Line, Span};

use super::parts::{spans_width, spread};
use crate::model::{ALL_LABEL, KEYS_HINT, NEXT_LABEL, NEXT_NOTHING, NextLine, PROJECTS_LABEL};
use crate::text::{fit, width};
use crate::theme;
use cockpit_core::theme::Token;
use ratatui::style::{Modifier, Style};

/// The view switch: All lit, Projects faint until it is drawn, and the hint.
pub fn switch(inner: usize) -> Line<'static> {
    let lit = Style::new()
        .fg(theme::rgb(theme::GROUND))
        .bg(theme::colour(Token::Select))
        .add_modifier(Modifier::BOLD);
    let left = vec![
        Span::styled(format!(" {ALL_LABEL} "), lit),
        Span::raw(" "),
        Span::styled(PROJECTS_LABEL, theme::ink(Token::Faint)),
    ];
    let room = inner.saturating_sub(spans_width(&left) + 1);
    let right = vec![Span::styled(fit(KEYS_HINT, room), theme::ink(Token::Faint))];
    spread(left, right, inner, false)
}

/// Next: its label, the workspace it goes to, and its place in the queue.
pub fn next(line: Option<&NextLine>, inner: usize) -> Line<'static> {
    let label = Span::styled(NEXT_LABEL, theme::strong(Token::Heading));
    let room = inner.saturating_sub(width(NEXT_LABEL) + 2);
    match line {
        Some(NextLine::Step { title, place }) => {
            let place = fit(place, room);
            let title_room = room.saturating_sub(width(&place) + 1);
            let left = vec![
                label,
                Span::raw("  "),
                Span::styled(fit(title, title_room), theme::title()),
            ];
            let right = vec![Span::styled(place, theme::ink(Token::MetaText))];
            spread(left, right, inner, false)
        }
        Some(NextLine::Nothing) | None => {
            let left = vec![
                label,
                Span::raw("  "),
                Span::styled(fit(NEXT_NOTHING, room), theme::ink(Token::Faint)),
            ];
            spread(left, Vec::new(), inner, false)
        }
    }
}
