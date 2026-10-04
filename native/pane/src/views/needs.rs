//! The Needs you strip: its heading with the count and the oldest wait,
//! a row per listed session with why it waits, and "+N more". Nothing at
//! all while nobody waits.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::parts::{pill, spans_width, spread};
use crate::model::{NEEDS_LABEL, Needs};
use crate::text::{fit, width};
use crate::theme;
use cockpit_core::theme::Token;
use cockpit_core::ui::PillColors;

/// Before a row's title: indent, then the dot and a space.
const ROW_LEAD: usize = 4;

/// The strip's lines, on its own face.
pub fn lines(needs: &Needs, inner: usize) -> Vec<Line<'static>> {
    if needs.count == 0 {
        return Vec::new();
    }
    let mut out = vec![heading(needs, inner)];
    for row in &needs.rows {
        let left = vec![
            Span::raw("  "),
            Span::styled(row.icon.glyph, theme::icon(row.icon.ink)),
            Span::raw(" "),
            Span::styled(
                fit(&row.title, inner.saturating_sub(ROW_LEAD)),
                theme::title(),
            ),
        ];
        out.push(spread(left, Vec::new(), inner, false));
        let why = vec![
            Span::raw(" ".repeat(ROW_LEAD)),
            Span::styled(
                fit(&row.line, inner.saturating_sub(ROW_LEAD)),
                theme::ink(row.ink),
            ),
        ];
        out.push(spread(why, Vec::new(), inner, false));
    }
    if !needs.more.is_empty() {
        let more = vec![
            Span::raw("  "),
            Span::styled(
                fit(&needs.more, inner.saturating_sub(2)),
                theme::ink(Token::MetaText),
            ),
        ];
        out.push(spread(more, Vec::new(), inner, false));
    }
    let face = Style::new().bg(theme::rgb(theme::NEEDS_BG));
    out.into_iter().map(|l| l.patch_style(face)).collect()
}

fn heading(needs: &Needs, inner: usize) -> Line<'static> {
    let tint = PillColors {
        bg: Token::ClayCount,
        fg: Token::ClayText,
    };
    let count = pill(needs.count, tint);
    let label_room = inner.saturating_sub(width(&count.content) + 1);
    let left = vec![
        Span::styled(fit(NEEDS_LABEL, label_room), theme::strong(Token::ClayText)),
        Span::raw(" "),
        count,
    ];
    let room = inner.saturating_sub(spans_width(&left) + 1);
    let wait = fit(&needs.wait, room);
    let ink = if needs.late {
        theme::strong(Token::ClayText)
    } else {
        theme::ink(Token::MetaText)
    };
    let right = if width(&wait) == 0 {
        Vec::new()
    } else {
        vec![Span::styled(wait, ink)]
    };
    spread(left, right, inner, false)
}
