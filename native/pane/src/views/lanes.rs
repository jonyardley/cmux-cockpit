//! The lanes: each header with its fold mark, marker, name, anchor, count
//! pill, folded dot and merge line, then its cards (dot, title, status with
//! its age, chips, where you left off, detail), a card waiting on Jon
//! marked by a bar down its lead in the waiting ink. An empty lane is its
//! header alone, faint, with no fold mark. While a card is dragged, the lane it
//! would drop into says so on its header, and the card it would land above
//! carries the drop's mark.

use std::ops::Range;

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::parts::{Edge, pill, spans_width, spread};
use crate::model::{
    Card, Chip, ChipKind, DROP_AT_END, DROP_HERE, FOLDED_MARK, LANE_MARK, Lane, OPEN_MARK, Row,
};
use crate::placing::{Place, Spot};
use crate::text::{ELLIPSIS, fit, fit_ranked, width, wrap};
use crate::theme;
use cockpit_core::panel::LaneKey;
use cockpit_core::panel::PillColors;
use cockpit_core::panel::Token;

/// Before a card's title: indent, the dot and a space.
pub(super) const CARD_LEAD: usize = 4;
/// Down a waiting card's lead, in its edge ink: the terminal's take on
/// the sidebar's leading edge.
const WAITING_BAR: &str = "▎";
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
        for c in lane.rows.iter().map(Row::card) {
            let id = c.ws_id.as_str();
            let landing = target.is_some_and(|p| p.before.as_deref() == Some(id));
            let start = out.lines.len();
            let on = cursor == Some(id);
            out.lines.extend(card(c, inner, on, landing));
            if on {
                out.focus = Some(start..out.lines.len());
            }
            let spot = Spot::Card {
                id: id.to_string(),
                lane: lane.key,
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

/// A card's chips as the pane lays them out: a diff size joins the PR
/// before it, a space apart, so the PR and its size fit or go together.
/// A diff after anything else stays a chip of its own, so a change in the
/// core's order shows rather than folding it into a branch.
fn glued(chips: &[Chip]) -> Vec<Chip> {
    let mut out: Vec<Chip> = Vec::new();
    for c in chips {
        match out.last_mut() {
            Some(prev) if c.kind == ChipKind::Diff && prev.kind == ChipKind::Pr => {
                prev.pieces.extend(c.pieces.iter().cloned())
            }
            _ => out.push(c.clone()),
        }
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
    let right = title_right(c, inner.saturating_sub(CARD_LEAD + MIN_TITLE + 1));
    let right_width = spans_width(&right);
    let gap = usize::from(right_width > 0);
    let title_room = inner.saturating_sub(CARD_LEAD + right_width + gap);
    let left = vec![
        lead(c, "  "),
        Span::styled(c.icon.glyph, theme::icon(c.icon.ink)),
        Span::raw(" "),
        Span::styled(fit(&c.title, title_room), theme::title()),
    ];
    let mut out = vec![spread(left, right, inner, first)];
    let room = inner.saturating_sub(CARD_LEAD);
    let indent = || lead(c, &" ".repeat(CARD_LEAD));
    let chips_at = |chips: &[Chip]| {
        let mut spans = vec![indent()];
        spans.extend(chips_line(chips, room));
        spread(spans, Vec::new(), inner, edge)
    };
    // Park and Close end the chips line while every chip fits whole, else
    // take a line of their own, so a button `x` acts on is never cut.
    let chips = glued(&c.chips);
    let together: Vec<Chip> = chips.iter().chain(&c.merged).cloned().collect();
    if chips_width(&together) <= room {
        if !together.is_empty() {
            out.push(chips_at(&together));
        }
    } else {
        if !chips.is_empty() {
            out.push(chips_at(&chips));
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
        let spans = vec![indent(), Span::styled(line, theme::ink(c.detail_ink))];
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

/// The right of a card's title row in at most `room` cells: its status,
/// then its age while the status carries none (a waiting card's reason),
/// in the waiting ink while it waits, as the sidebar's title row has it.
/// The age is short and kept whole; the status gives way first.
fn title_right(c: &Card, room: usize) -> Vec<Span<'static>> {
    let age = if c.status_has_age { "" } else { c.age.as_str() };
    let age = fit(age, room);
    let age_room = if age.is_empty() { 0 } else { width(&age) + 1 };
    let status = fit(&c.status, room.saturating_sub(age_room));
    let mut out = Vec::new();
    if !status.is_empty() {
        out.push(Span::styled(status, theme::ink(c.status_ink)));
    }
    if !age.is_empty() {
        if !out.is_empty() {
            out.push(Span::raw(" "));
        }
        let ink = c.waiting.map_or(Token::MetaText, |w| w.ink);
        out.push(Span::styled(age, theme::ink(ink)));
    }
    out
}

/// The blank start of a card's line, `blank` wide; on a waiting card its
/// first cell is the waiting bar in the card's edge ink.
fn lead(c: &Card, blank: &str) -> Span<'static> {
    match c.waiting {
        Some(w) => Span::styled(
            format!("{WAITING_BAR}{}", blank.get(1..).unwrap_or_default()),
            theme::ink(w.edge),
        ),
        None => Span::raw(blank.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Density, Piece, Row, fixtures};

    #[test]
    fn joins_a_diff_size_to_the_pr_before_it() {
        let chip = |kind, text: &str| Chip {
            kind,
            pieces: vec![Piece {
                text: text.into(),
                ink: Token::Secondary,
            }],
            gives_way: false,
            url: None,
            is_action: false,
        };
        let chips = [
            chip(ChipKind::Pr, "#3"),
            chip(ChipKind::Diff, "+1"),
            chip(ChipKind::Branch, "feat"),
        ];
        let got = glued(&chips);
        let words: Vec<Vec<&str>> = got
            .iter()
            .map(|c| c.pieces.iter().map(|p| p.text.as_str()).collect())
            .collect();
        assert_eq!(words, [vec!["#3", "+1"], vec!["feat"]]);
        assert_eq!(got[0].kind, ChipKind::Pr, "the PR keeps its kind");
        let alone = glued(&[chip(ChipKind::Diff, "+1")]);
        assert_eq!(alone.len(), 1, "a diff with nothing before it stays");
        let after_branch = glued(&[chip(ChipKind::Branch, "feat"), chip(ChipKind::Diff, "+1")]);
        assert_eq!(after_branch.len(), 2, "a diff joins only a PR");
    }

    #[test]
    fn a_waiting_card_carries_its_edge_down_its_lead() {
        let Row::Card(mut c) = fixtures::card("asks", 0, true);
        c.detail = "Allow git push?".into();
        let lines = card(&c, 30, false, false);
        assert_eq!(lines.len(), 2, "the title line and the detail");
        for line in &lines {
            let lead = &line.spans[1];
            assert!(lead.content.starts_with(WAITING_BAR));
            assert_eq!(lead.style.fg, theme::ink(Token::Clay).fg);
        }
        c.waiting = None;
        let lines = card(&c, 30, false, false);
        assert_eq!(lines[0].spans[1].content, "  ", "no bar once answered");
    }

    #[test]
    fn draws_the_age_after_a_waiting_cards_reason_in_its_ink() {
        let Row::Card(mut c) = fixtures::card("asks", 0, true);
        c.status = "Your turn: Which green?".into();
        c.status_ink = Token::ClayText;
        c.age = "5m".into();
        let right = title_right(&c, 30);
        let words: Vec<&str> = right.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(words, ["Your turn: Which green?", " ", "5m"]);
        assert_eq!(right[2].style.fg, theme::ink(Token::ClayText).fg);
        let narrow = title_right(&c, 8);
        assert_eq!(
            narrow.last().map(|s| s.content.as_ref()),
            Some("5m"),
            "the age stays whole"
        );
        c.waiting = None;
        let right = title_right(&c, 30);
        assert_eq!(
            right[2].style.fg,
            theme::ink(Token::MetaText).fg,
            "meta ink once answered"
        );
        c.status_has_age = true;
        assert_eq!(title_right(&c, 30).len(), 1, "no second time");
    }

    #[test]
    fn draws_a_waiting_rows_reason_in_the_waiting_ink() {
        let Row::Card(mut c) = fixtures::card("row", 0, true);
        c.density = Density::Row;
        c.detail = "Asking: allow git push?".into();
        c.detail_ink = Token::AmberText;
        let lines = card(&c, 40, false, false);
        assert_eq!(lines.len(), 2, "the title line and the reason");
        let reason = &lines[1].spans[2];
        assert_eq!(reason.content, "Asking: allow git push?");
        assert_eq!(reason.style.fg, theme::ink(Token::AmberText).fg);
    }

    #[test]
    fn a_dimmed_card_keeps_its_drop_mark_at_full_strength() {
        let Row::Card(mut c) = fixtures::card("merged", 0, false);
        c.dimmed = true;
        let lines = card(&c, 30, false, true);
        let dim = |s: Style| s.add_modifier.contains(Modifier::DIM);
        assert!(!dim(lines[0].style), "the line itself is not dimmed");
        assert!(!dim(lines[0].spans[0].style), "the drop mark is not dimmed");
        assert!(dim(lines[0].spans[1].style), "the card's words are");
    }
}
