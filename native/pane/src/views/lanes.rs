//! The lanes: each header with its fold mark, marker, name, anchor, count
//! pill, folded dot and merge line, then its cards (dot, title, status with
//! its age, chips, where you left off, detail) and the
//! placeholders of cards waiting in Needs you. An empty lane is its header
//! alone, faint, with no fold mark. While a card is dragged, the lane it
//! would drop into says so on its header, and the card it would land above
//! carries the drop's mark.

use std::ops::Range;

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::parts::{Edge, pill, spans_width, spread};
use crate::model::{
    Card, Chip, DROP_AT_END, DROP_HERE, FOLDED_MARK, GHOST, GHOST_GAP, LANE_MARK, Lane, OPEN_MARK,
    Row,
};
use crate::placing::{Place, Spot};
use crate::text::{ELLIPSIS, fit, fit_ranked, width, wrap};
use crate::theme;
use cockpit_core::panel::LaneKey;
use cockpit_core::panel::PillColors;
use cockpit_core::panel::Token;

/// Before a card's title: indent, the dot and a space.
pub(super) const CARD_LEAD: usize = 4;
/// Between two chips on a card's chips line.
const CHIP_GAP: &str = "  ";
/// A title keeps at least this many cells before the status takes the rest.
const MIN_TITLE: usize = 10;
/// An empty lane's count: faint on the quiet face.
const EMPTY_PILL: PillColors = PillColors {
    bg: Token::CountBg,
    fg: Token::Faint,
};

/// The lanes laid out: their lines, what each line is for the mouse, and
/// which lines the card under the cursor takes.
#[derive(Default)]
pub struct Laid {
    pub lines: Vec<Line<'static>>,
    pub spots: Vec<Spot>,
    pub focus: Option<Range<usize>>,
}

/// Lays out the lanes, with the cursor's card and a drag's drop target.
pub fn lines(lanes: &[Lane], inner: usize, cursor: Option<&str>, drop: Option<&Place>) -> Laid {
    let mut out = Laid::default();
    let mut above: Option<LaneKey> = None;
    for lane in lanes {
        out.lines.push(Line::default());
        out.spots.push(above.map_or(Spot::Blank, Spot::End));
        let target = drop.filter(|p| p.lane == lane.key);
        out.lines.push(header(lane, inner, target));
        out.spots.push(Spot::Header(lane.key));
        for row in &lane.rows {
            let id = row.ws_id();
            let landing = target.is_some_and(|p| p.before.as_deref() == Some(id));
            let start = out.lines.len();
            let spot = match row {
                Row::Card(c) => {
                    let on = cursor == Some(c.ws_id.as_str());
                    out.lines.extend(card(c, inner, on, landing));
                    if on {
                        out.focus = Some(start..out.lines.len());
                    }
                    Spot::Card {
                        id: id.to_string(),
                        lane: lane.key,
                    }
                }
                Row::Ghost { title, text, .. } => {
                    out.lines.push(ghost(title, text, inner, landing));
                    Spot::Ghost {
                        id: id.to_string(),
                        lane: lane.key,
                    }
                }
            };
            out.spots.resize(out.lines.len(), spot);
        }
        above = Some(lane.key);
    }
    out
}

/// A lane's header; with `target`, the drop it would take on the right in
/// place of the merge line.
fn header(lane: &Lane, inner: usize, target: Option<&Place>) -> Line<'static> {
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
    let (right_words, right_ink) = match target {
        Some(p) if p.before.is_none() => (DROP_AT_END, theme::strong(Token::Select)),
        Some(_) => (DROP_HERE, theme::strong(Token::Select)),
        None => (lane.merge_ready.as_str(), theme::ink(Token::GreenDeep)),
    };
    let merge = fit(right_words, inner.saturating_sub(fixed + keep + 1));
    let gap = usize::from(!merge.is_empty());
    let name_room = inner.saturating_sub(fixed + width(&merge) + gap);
    let mut left = lead;
    left.push(Span::styled(fit(&lane.name, name_room), name_ink));
    left.extend(tail);
    let right = if merge.is_empty() {
        Vec::new()
    } else {
        vec![Span::styled(merge, right_ink)]
    };
    spread(left, right, inner, Edge::Plain)
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

/// A card's chips on one line, each whole: the chips that fit, a long
/// branch giving way first, then an ellipsis when some were left off, so
/// a chip is never cut.
fn chips_line(chips: &[Chip], room: usize) -> Vec<Span<'static>> {
    let widths: Vec<usize> = chips.iter().map(chip_width).collect();
    let ways: Vec<bool> = chips.iter().map(|c| c.gives_way).collect();
    let (shown, cut) = fit_ranked(&widths, &ways, width(CHIP_GAP), room);
    let mut out: Vec<Span<'static>> = Vec::new();
    let kept = chips
        .iter()
        .zip(&shown)
        .filter(|(_, s)| **s)
        .map(|(c, _)| c);
    for (i, chip) in kept.enumerate() {
        if i > 0 {
            out.push(Span::raw(CHIP_GAP));
        }
        for (j, p) in chip.pieces.iter().enumerate() {
            if j > 0 {
                out.push(Span::raw(" "));
            }
            out.push(Span::styled(p.text.clone(), theme::ink(p.ink)));
        }
    }
    if cut && width(ELLIPSIS) <= room {
        if shown.contains(&true) {
            out.push(Span::raw(CHIP_GAP));
        }
        out.push(Span::styled(ELLIPSIS, theme::ink(Token::Faint)));
    }
    out
}

/// The cells a run of chips takes on one line, each whole.
fn chips_width(chips: &[Chip]) -> usize {
    let gaps = chips.len().saturating_sub(1) * width(CHIP_GAP);
    chips.iter().map(chip_width).sum::<usize>() + gaps
}

/// The cells a chip takes: its pieces, a space apart.
fn chip_width(c: &Chip) -> usize {
    c.pieces.iter().map(|p| width(&p.text)).sum::<usize>() + c.pieces.len().saturating_sub(1)
}

/// A card's lines; `on` under the cursor, `landing` when a drag would land
/// above it.
pub(super) fn card(c: &Card, inner: usize, on: bool, landing: bool) -> Vec<Line<'static>> {
    let edge = if on { Edge::Cursor } else { Edge::Plain };
    let first = if landing { Edge::Drop } else { edge };
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
    let mut out = vec![spread(left, right, inner, first)];
    let room = inner.saturating_sub(CARD_LEAD);
    let indent = || Span::raw(" ".repeat(CARD_LEAD));
    let chips_at = |chips: &[Chip]| {
        let mut spans = vec![indent()];
        spans.extend(chips_line(chips, room));
        spread(spans, Vec::new(), inner, edge)
    };
    // Park and Close end the chips line while every chip fits whole, else
    // take a line of their own, so a button `x` acts on is never cut.
    let together: Vec<Chip> = c.chips.iter().chain(&c.merged).cloned().collect();
    if chips_width(&together) <= room {
        if !together.is_empty() {
            out.push(chips_at(&together));
        }
    } else {
        if !c.chips.is_empty() {
            out.push(chips_at(&c.chips));
        }
        if !c.merged.is_empty() {
            out.push(chips_at(&c.merged));
        }
    }
    if !c.left_off.is_empty() {
        let spans = vec![
            indent(),
            Span::styled(fit(&c.left_off, room), theme::plain(theme::TERTIARY)),
        ];
        out.push(spread(spans, Vec::new(), inner, edge));
    }
    for line in wrap(&c.detail, room, c.detail_lines) {
        let spans = vec![indent(), Span::styled(line, theme::plain(theme::SECONDARY))];
        out.push(spread(spans, Vec::new(), inner, edge));
    }
    if on {
        let face = Style::new().bg(theme::rgb(theme::CURSOR_BG));
        out = out.into_iter().map(|l| l.patch_style(face)).collect();
    } else if c.dimmed {
        // The sidebar's lit card shows at full strength; here the cursor
        // lights it. The margin keeps its strength, so a drop mark there
        // reads as it does above any other card.
        let faint = Style::new().add_modifier(Modifier::DIM);
        for line in &mut out {
            for span in line.spans.iter_mut().skip(1) {
                span.style = span.style.patch(faint);
            }
        }
    }
    out
}

pub(super) fn ghost(title: &str, text: &str, inner: usize, landing: bool) -> Line<'static> {
    let left = vec![
        Span::raw("  "),
        Span::styled(GHOST, theme::ink(Token::Faint)),
        Span::raw(" "),
    ];
    let room = inner.saturating_sub(spans_width(&left));
    let words = fit(&format!("{title} {GHOST_GAP} {text}"), room);
    let mut spans = left;
    spans.push(Span::styled(words, theme::ink(Token::Faint)));
    let edge = if landing { Edge::Drop } else { Edge::Plain };
    spread(spans, Vec::new(), inner, edge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Row, fixtures};

    #[test]
    fn a_dimmed_card_keeps_its_drop_mark_at_full_strength() {
        let Row::Card(mut c) = fixtures::card("merged", 0, false) else {
            panic!("the fixture is a card")
        };
        c.dimmed = true;
        let lines = card(&c, 30, false, true);
        let dim = |s: Style| s.add_modifier.contains(Modifier::DIM);
        assert!(!dim(lines[0].style), "the line itself is not dimmed");
        assert!(!dim(lines[0].spans[0].style), "the drop mark is not dimmed");
        assert!(dim(lines[0].spans[1].style), "the card's words are");
    }
}
