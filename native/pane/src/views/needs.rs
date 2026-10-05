//! The Needs you strip: its heading with the count and the oldest wait,
//! a row per listed session with why it waits, and "+N more". Nothing at
//! all while nobody waits. The cursor walks the rows before the lanes.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::lanes::Laid;
use super::parts::{Edge, pill, spans_width, spread};
use crate::model::{NEEDS_LABEL, Needs};
use crate::placing::Spot;
use crate::text::{fit, width};
use crate::theme;
use cockpit_core::panel::PillColors;
use cockpit_core::panel::Token;

/// Before a row's title: indent, then the dot and a space.
const ROW_LEAD: usize = 4;

/// The strip's lines on its own face, what each is for the mouse, and
/// which the row under the cursor takes.
pub fn lines(needs: &Needs, inner: usize, cursor: Option<&str>) -> Laid {
    if needs.count == 0 {
        return Laid::default();
    }
    let mut out = vec![heading(needs, inner)];
    let mut spots = vec![Spot::Blank];
    let mut focus = None;
    for row in &needs.rows {
        let on = cursor == Some(row.ws_id.as_str());
        let edge = if on { Edge::Cursor } else { Edge::Plain };
        if on {
            focus = Some(out.len()..out.len() + 2);
        }
        let left = vec![
            Span::raw("  "),
            Span::styled(row.icon.glyph, theme::icon(row.icon.ink)),
            Span::raw(" "),
            Span::styled(
                fit(&row.title, inner.saturating_sub(ROW_LEAD)),
                theme::title(),
            ),
        ];
        out.push(spread(left, Vec::new(), inner, edge));
        let why = vec![
            Span::raw(" ".repeat(ROW_LEAD)),
            Span::styled(
                fit(&row.line, inner.saturating_sub(ROW_LEAD)),
                theme::ink(row.ink),
            ),
        ];
        out.push(spread(why, Vec::new(), inner, edge));
        spots.resize(out.len(), Spot::Needs(row.ws_id.clone()));
    }
    if !needs.more.is_empty() {
        let more = vec![
            Span::raw("  "),
            Span::styled(
                fit(&needs.more, inner.saturating_sub(2)),
                theme::ink(Token::MetaText),
            ),
        ];
        out.push(spread(more, Vec::new(), inner, Edge::Plain));
        spots.push(Spot::Blank);
    }
    let face = Style::new().bg(theme::rgb(theme::NEEDS_BG));
    Laid {
        lines: out.into_iter().map(|l| l.patch_style(face)).collect(),
        spots,
        focus,
    }
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
    spread(left, right, inner, Edge::Plain)
}
