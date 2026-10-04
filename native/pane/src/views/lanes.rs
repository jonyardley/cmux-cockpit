//! The lanes: each header with its fold mark, marker, name, anchor, count
//! pill, folded dot and merge line, then its cards (dot, title, status with
//! its age, where you left off, detail) and the
//! placeholders of cards waiting in Needs you. An empty lane is its header
//! alone, faint, with no fold mark.

use std::ops::Range;

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::parts::{pill, spans_width, spread};
use crate::model::{Card, FOLDED_MARK, GHOST, GHOST_GAP, LANE_MARK, Lane, OPEN_MARK, Row};
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
    let chevron = if lane.empty {
        " "
    } else if lane.collapsed {
        FOLDED_MARK
    } else {
        OPEN_MARK
    };
    let name_ink = if lane.faint {
        theme::strong(Token::Faint)
    } else {
        theme::plain(theme::SECONDARY).add_modifier(Modifier::BOLD)
    };
    let lead = vec![
        Span::styled(chevron, theme::ink(Token::Faint)),
        Span::raw(" "),
        Span::styled(LANE_MARK, theme::ink(lane.marker)),
        Span::raw(" "),
    ];
    let tail = header_tail(lane);
    let fixed = spans_width(&lead) + spans_width(&tail);
    let keep = width(&lane.name).min(MIN_TITLE);
    let merge = fit(&lane.merge_ready, inner.saturating_sub(fixed + keep + 1));
    let gap = usize::from(!merge.is_empty());
    let name_room = inner.saturating_sub(fixed + width(&merge) + gap);
    let mut left = lead;
    left.push(Span::styled(fit(&lane.name, name_room), name_ink));
    left.extend(tail);
    let right = if merge.is_empty() {
        Vec::new()
    } else {
        vec![Span::styled(merge, theme::ink(Token::GreenDeep))]
    };
    spread(left, right, inner, false)
}

/// After a lane's name: its anchor's dot and unread badge, the count, and
/// while folded the dot of its most urgent session.
fn header_tail(lane: &Lane) -> Vec<Span<'static>> {
    let tint = if lane.empty { EMPTY_PILL } else { lane.pill };
    let mut tail = Vec::new();
    if let Some(a) = &lane.anchor {
        tail.push(Span::raw(" "));
        tail.push(Span::styled(a.icon.glyph, theme::icon(a.icon.ink)));
        if !a.unread.is_empty() {
            tail.push(Span::raw(" "));
            tail.push(Span::styled(format!(" {} ", a.unread), theme::badge()));
        }
    }
    tail.push(Span::raw(" "));
    tail.push(pill(lane.count, tint));
    if let Some(dot) = &lane.dot {
        tail.push(Span::raw(" "));
        tail.push(Span::styled(dot.glyph, theme::icon(dot.ink)));
    }
    tail
}

fn card(c: &Card, inner: usize, on: bool) -> Vec<Line<'static>> {
    let status = fit(&c.status, inner.saturating_sub(CARD_LEAD + MIN_TITLE + 1));
    let gap = usize::from(!status.is_empty());
    let title_room = inner.saturating_sub(CARD_LEAD + width(&status) + gap);
    let left = vec![
        Span::raw("  "),
        Span::styled(c.icon.glyph, theme::icon(c.icon.ink)),
        Span::raw(" "),
        Span::styled(fit(&c.title, title_room), theme::title()),
    ];
    let right = vec![Span::styled(status, theme::ink(c.status_ink))];
    let mut out = vec![spread(left, right, inner, on)];
    let room = inner.saturating_sub(CARD_LEAD);
    let indent = || Span::raw(" ".repeat(CARD_LEAD));
    if !c.left_off.is_empty() {
        let spans = vec![
            indent(),
            Span::styled(fit(&c.left_off, room), theme::plain(theme::TERTIARY)),
        ];
        out.push(spread(spans, Vec::new(), inner, on));
    }
    for line in wrap(&c.detail, room, c.detail_lines) {
        let spans = vec![indent(), Span::styled(line, theme::plain(theme::SECONDARY))];
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
