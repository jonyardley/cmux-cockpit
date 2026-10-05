//! Whether a card's chips row has anything to show, the chips a card
//! draws, and how they fit (src/cockpit/chips.ts). The fit is the
//! sidebar's estimate of its own point widths from character counts, as
//! its renderer cannot measure; a shell that measures can ignore it.

use crate::card_chips::Chip;
use crate::data::{Data, Workspace};
use crate::js::utf16_len;
use crate::session::Session;

/// Characters' worth of chips a project card fits on one line at the
/// width Jon keeps the sidebar.
pub const PROJECT_LINE_CHARS: usize = 36;
/// The full card's line, narrower by its glyph. It errs towards
/// splitting: a line too many costs height, a line too few cuts the branch.
pub const FULL_LINE_CHARS: usize = 32;
// A chip's frame and the gap after it, in characters.
const FRAME_CHARS: usize = 3;
// The glyph before a PR or branch chip's words, with its gap.
const GLYPH_CHARS: usize = 2;
// The branch chip's uncommitted-changes dot, with its gap.
const DIRTY_CHARS: usize = 2;
// "To review →" as it draws, frame included.
const REVIEW_CHARS: usize = 14;
// A merged card's "Park" and "Close", frames included.
const PARK_CHARS: usize = 7;
const CLOSE_CHARS: usize = 8;

/// The words after a gap, or nothing when there are none.
fn spaced(s: &str) -> usize {
    if s.is_empty() { 0 } else { utf16_len(s) + 1 }
}

fn chip_chars(c: &Chip) -> usize {
    match c {
        Chip::Pr {
            tag, state, diff, ..
        } => utf16_len(tag) + spaced(state) + FRAME_CHARS + GLYPH_CHARS + spaced(diff),
        Chip::Branch { text, dirty } => {
            let dot = if *dirty { DIRTY_CHARS } else { 0 };
            utf16_len(text) + FRAME_CHARS + GLYPH_CHARS + dot
        }
        // The size and port chips carry no glyph.
        Chip::Size { text, .. } | Chip::Port { text, .. } => utf16_len(text) + FRAME_CHARS,
    }
}

/// On the second line of a split: the branch and the ports.
fn second_line(c: &Chip) -> bool {
    matches!(c, Chip::Branch { .. } | Chip::Port { .. })
}

impl Session {
    /// True when the chips row shows a chip from `chips` (a chips_for
    /// list), the To review action or a merged card's Park or Close.
    pub fn shows_chips_row(&mut self, data: &Data, chips: &[Chip], w: Option<&Workspace>) -> bool {
        !chips.is_empty() || self.can_file_for_review(data, w) || self.offers_merged_chip(data, w)
    }

    /// The chips a card draws: chips_for, less a merged card's branch
    /// while Park or Close takes its room. A branch with uncommitted
    /// changes stays, since its dot is the card's only sign of work left.
    pub fn card_chips(
        &mut self,
        data: &Data,
        w: Option<&Workspace>,
        with_branch: bool,
    ) -> Vec<Chip> {
        let mut chips = self.chips_for(w, with_branch);
        if self.offers_merged_chip(data, w) {
            chips.retain(|c| !matches!(c, Chip::Branch { dirty: false, .. }));
        }
        chips
    }

    /// shows_chips_row for a card that has no chip list to hand.
    pub fn has_chips_row(&mut self, data: &Data, w: Option<&Workspace>, with_branch: bool) -> bool {
        let chips = self.card_chips(data, w, with_branch);
        self.shows_chips_row(data, &chips, w)
    }

    /// The action buttons that share the chips line, in characters.
    fn action_chars(&mut self, data: &Data, w: Option<&Workspace>) -> usize {
        let review = if self.can_file_for_review(data, w) {
            REVIEW_CHARS
        } else {
            0
        };
        let park = if self.offers_park(data, w) {
            PARK_CHARS
        } else {
            0
        };
        let close = if self.offers_close(data, w) {
            CLOSE_CHARS
        } else {
            0
        };
        review + park + close
    }

    /// Whether a card's chips fit on one line `line_chars` wide.
    pub fn chips_fit_one_line(
        &mut self,
        data: &Data,
        chips: &[Chip],
        w: Option<&Workspace>,
        line_chars: usize,
    ) -> bool {
        let used = self.action_chars(data, w) + chips.iter().map(chip_chars).sum::<usize>();
        used <= line_chars
    }

    /// Whether a card's chips split over two lines: the PR (and size) on
    /// the first; the branch, port, To review and a merged card's Park and
    /// Close on the second. Only when both lines have something and they
    /// do not fit on one.
    pub fn chips_split(
        &mut self,
        data: &Data,
        chips: &[Chip],
        w: Option<&Workspace>,
        line_chars: usize,
    ) -> bool {
        let first = chips
            .iter()
            .any(|c| matches!(c, Chip::Pr { .. } | Chip::Size { .. }));
        let second = chips.iter().any(second_line)
            || self.can_file_for_review(data, w)
            || self.offers_merged_chip(data, w);
        first && second && !self.chips_fit_one_line(data, chips, w, line_chars)
    }

    /// Whether a split's second line fits. When it does not, Park and
    /// Close take a line of their own under it.
    pub fn second_line_fits(
        &mut self,
        data: &Data,
        chips: &[Chip],
        w: Option<&Workspace>,
        line_chars: usize,
    ) -> bool {
        let second: usize = chips
            .iter()
            .filter(|c| second_line(c))
            .map(chip_chars)
            .sum();
        self.action_chars(data, w) + second <= line_chars
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::moves::MoveSize;
    use crate::prs::PrHealth;

    #[test]
    fn counts_each_chip_as_the_typescript_does() {
        let pr = Chip::Pr {
            tag: "#148".into(),
            state: "draft".into(),
            health: PrHealth::Quiet,
            diff: "+342 \u{2212}17".into(),
            url: None,
        };
        // "#148" 4, " draft" 6, frame 3, glyph 2, " +342 −17" 9.
        assert_eq!(chip_chars(&pr), 24);
        let bare = Chip::Pr {
            tag: "#7".into(),
            state: String::new(),
            health: PrHealth::Quiet,
            diff: String::new(),
            url: None,
        };
        assert_eq!(chip_chars(&bare), 7);
        let br = Chip::Branch {
            text: "feat".into(),
            dirty: true,
        };
        assert_eq!(chip_chars(&br), 11);
        let size = Chip::Size {
            text: "Quick".into(),
            size: MoveSize::Quick,
        };
        assert_eq!(chip_chars(&size), 8);
        let port = Chip::Port {
            text: ":5173 \u{2197}".into(),
            url: String::new(),
        };
        assert_eq!(chip_chars(&port), 10);
        assert!(second_line(&br) && second_line(&port));
        assert!(!second_line(&pr) && !second_line(&size));
    }
}
