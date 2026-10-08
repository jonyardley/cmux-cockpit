//! How a card's chips fit its line (src/cockpit/chips.ts). The fit is the
//! sidebar's estimate of its own point widths from character counts, as
//! its renderer cannot measure; a shell that measures can ignore it.

use crate::card_chips::Chip;
use crate::js::utf16_len;

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

/// Whether a card's chips fit on one line `line_chars` wide.
pub fn chips_fit_one_line(chips: &[Chip], line_chars: usize) -> bool {
    chips.iter().map(chip_chars).sum::<usize>() <= line_chars
}

/// Whether a card's chips split over two lines: the PR (and size) on the
/// first; the branch and port on the second. Only when both lines have
/// something and they do not fit on one.
pub fn chips_split(chips: &[Chip], line_chars: usize) -> bool {
    let first = chips
        .iter()
        .any(|c| matches!(c, Chip::Pr { .. } | Chip::Size { .. }));
    let second = chips.iter().any(second_line);
    first && second && !chips_fit_one_line(chips, line_chars)
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
