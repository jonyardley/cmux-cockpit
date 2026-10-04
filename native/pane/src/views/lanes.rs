//! The lanes: each header with its fold mark, name, count pill and merge
//! line, then its cards (dot, title, status with its age, detail) and the
//! placeholders of cards waiting in Needs you. An empty lane is its header
//! alone, faint, with no fold mark.

use std::ops::Range;

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::parts::{pill, spans_width, spread};
use crate::model::{Card, FOLDED_MARK, GHOST, GHOST_GAP, Lane, OPEN_MARK, Row};
use crate::text::{fit, width, wrap};
use crate::theme;
use cockpit_core::theme::Token;
use cockpit_core::ui::PillColors;

/// Before a card's title: indent, the dot and a space.
const CARD_LEAD: usize = 4;
/// A title keeps at least this many cells before the status takes the rest.
const MIN_TITLE: usize = 10;
/// An empty lane's count: faint on the quiet face.
const EMPTY_PILL: PillColors = PillColors {
    bg: Token::CountBg,
    fg: Token::Faint,
};

/// The lanes' lines, and which of them the card under the cursor takes.
pub fn lines(
    lanes: &[Lane],
    inner: usize,
    cursor: Option<&str>,
) -> (Vec<Line<'static>>, Option<Range<usize>>) {
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut focus = None;
    for lane in lanes {
        out.push(Line::default());
        out.push(header(lane, inner));
        for row in &lane.rows {
            match row {
                Row::Card(c) => {
                    let on = cursor == Some(c.ws_id.as_str());
                    let start = out.len();
                    out.extend(card(c, inner, on));
                    if on {
                        focus = Some(start..out.len());
                    }
                }
                Row::Ghost { title, text, .. } => out.push(ghost(title, text, inner)),
            }
        }
    }
    (out, focus)
}

fn header(lane: &Lane, inner: usize) -> Line<'static> {
    let (mark, name_ink, tint) = if lane.empty {
        (" ", theme::ink(Token::Faint), EMPTY_PILL)
    } else if lane.collapsed {
        (FOLDED_MARK, theme::strong(Token::Heading), lane.pill)
    } else {
        (OPEN_MARK, theme::strong(Token::Heading), lane.pill)
    };
    let count = pill(lane.count, tint);
    let fixed = width(mark) + 1 + 1 + width(&count.content);
    let merge_room = inner.saturating_sub(fixed + MIN_TITLE + 1);
    let merge = fit(&lane.merge_ready, merge_room);
    let name_room = inner.saturating_sub(fixed + width(&merge) + 1);
    let left = vec![
        Span::styled(mark, theme::ink(lane.marker)),
        Span::raw(" "),
        Span::styled(fit(lane.name, name_room), name_ink),
        Span::raw(" "),
        count,
    ];
    let right = if merge.is_empty() {
        Vec::new()
    } else {
        vec![Span::styled(merge, theme::ink(Token::GreenDeep))]
    };
    spread(left, right, inner, false)
}

fn card(c: &Card, inner: usize, on: bool) -> Vec<Line<'static>> {
    let status = fit(&c.status, inner.saturating_sub(CARD_LEAD + MIN_TITLE + 1));
    let title_room = inner.saturating_sub(CARD_LEAD + width(&status) + 1);
    let left = vec![
        Span::raw("  "),
        Span::styled(c.icon.glyph, theme::ink(c.icon.ink)),
        Span::raw(" "),
        Span::styled(fit(&c.title, title_room), theme::title()),
    ];
    let right = vec![Span::styled(status, theme::ink(c.status_ink))];
    let mut out = vec![spread(left, right, inner, on)];
    let detail_room = inner.saturating_sub(CARD_LEAD);
    for line in wrap(&c.detail, detail_room, c.detail_lines) {
        let spans = vec![
            Span::raw(" ".repeat(CARD_LEAD)),
            Span::styled(line, theme::ink(Token::MetaText)),
        ];
        out.push(spread(spans, Vec::new(), inner, on));
    }
    if on {
        let face = Style::new().bg(theme::rgb(theme::CURSOR_BG));
        out = out.into_iter().map(|l| l.patch_style(face)).collect();
    }
    out
}

fn ghost(title: &str, text: &str, inner: usize) -> Line<'static> {
    let left = vec![
        Span::raw("  "),
        Span::styled(GHOST, theme::ink(Token::Faint)),
        Span::raw(" "),
    ];
    let room = inner.saturating_sub(spans_width(&left));
    let words = fit(&format!("{title} {GHOST_GAP} {text}"), room);
    let mut spans = left;
    spans.push(Span::styled(words, theme::ink(Token::Faint)));
    spread(spans, Vec::new(), inner, false)
}
