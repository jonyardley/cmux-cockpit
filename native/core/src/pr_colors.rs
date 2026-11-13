//! The PR chip's palette (src/shared/pr-colors.ts), as tokens: a PR's
//! state words take its tone (pr_tone): a health with a hue wins (red
//! failing or in conflict, blue running, ready's merge green), and a quiet
//! PR reads by its state as GitHub colours it: grey draft and closed,
//! green open, purple merged. Open's green is a status colour on the
//! words, cooler than the merge green, so ready to merge keeps a green of
//! its own. A state chip on its own takes a faint face and edge of its
//! tone's hue. Also status.ts's prTextColor, the one reading of it a
//! card's PR words make. The shells ink words only, so the chip faces
//! (pr_chip_colors) and the stale reading (shown_tone) wait for a shell
//! that draws faces, and for the agents sidebar's port.

use serde::Serialize;

use crate::data::{PrStatus, Workspace};
use crate::persist::SavedState;
use crate::prs::{PrHealth, PrSummary, pr_of};
use crate::theme::Token;

/// A chip's face, words and edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChipColors {
    pub bg: Token,
    pub fg: Token,
    pub edge: Token,
}

/// What colours a PR's words: its health when that has a hue, else its
/// state. `Draft` is an open draft; `Quiet` is grey with nothing to say,
/// a PR with no status the core knows or a stale ready (shown_tone).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrTone {
    Failing,
    Conflicts,
    Running,
    Ready,
    Draft,
    Open,
    Merged,
    Closed,
    Quiet,
}

/// The quiet chip: the branch, the ports, and a PR's number.
pub const NEUTRAL_CHIP: ChipColors = ChipColors {
    bg: Token::ChipFace,
    fg: Token::Secondary,
    edge: Token::ChipEdge,
};

/// Ready to merge in words: the ink a ready to merge card's status says it
/// in, so ready to merge reads in one green everywhere; an open PR's green
/// is another, cooler one (`OpenText`).
pub const READY_INK: Token = Token::MergeText;

/// A PR's tone: a health with a hue wins (a failing draft is red); a quiet
/// PR reads by its state, a merged or closed one by its status whatever
/// its draft flag, and one with no status the core knows stays grey
/// rather than claim open.
pub fn pr_tone(status: Option<PrStatus>, draft: bool, health: PrHealth) -> PrTone {
    match health {
        PrHealth::Failing => PrTone::Failing,
        PrHealth::Conflicts => PrTone::Conflicts,
        // Still running, too long: the waiting card says so (ci_wait.rs).
        PrHealth::Running | PrHealth::Stuck => PrTone::Running,
        PrHealth::Ready => PrTone::Ready,
        PrHealth::Quiet => match status {
            Some(PrStatus::Merged) => PrTone::Merged,
            Some(PrStatus::Closed) => PrTone::Closed,
            Some(PrStatus::Open) if draft => PrTone::Draft,
            Some(PrStatus::Open) => PrTone::Open,
            Some(PrStatus::Unknown) | None => PrTone::Quiet,
        },
    }
}

/// A PR's state as words: its tone's colour.
pub fn pr_ink(tone: PrTone) -> Token {
    match tone {
        PrTone::Failing | PrTone::Conflicts => Token::RedText,
        PrTone::Running => Token::BlueText,
        PrTone::Ready => READY_INK,
        PrTone::Open => Token::OpenText,
        PrTone::Merged => Token::MergedText,
        PrTone::Draft | PrTone::Closed | PrTone::Quiet => Token::MetaText,
    }
}

/// The tone a PR's words show while its data may be stale and the chip
/// is dimmed: ready drops to grey, so a stale verdict (still saying
/// "ready") does not shout, nor borrow open's green; the rest keep their
/// hue, dimmed.
pub fn shown_tone(tone: PrTone, dim: bool) -> PrTone {
    if dim && tone == PrTone::Ready {
        PrTone::Quiet
    } else {
        tone
    }
}

/// A PR state chip's colours: its ink on a faint face of its tone's hue,
/// or the quiet chip's.
pub fn pr_chip_colors(tone: PrTone) -> ChipColors {
    let (bg, edge) = match tone {
        PrTone::Failing | PrTone::Conflicts => (Token::RedChipFace, Token::RedChipEdge),
        PrTone::Running => (Token::BlueChipFace, Token::BlueChipEdge),
        PrTone::Ready => (Token::GreenChipFace, Token::GreenChipEdge),
        PrTone::Open => (Token::OpenChipFace, Token::OpenChipEdge),
        PrTone::Merged => (Token::MergedChipFace, Token::MergedChipEdge),
        PrTone::Draft | PrTone::Closed | PrTone::Quiet => (NEUTRAL_CHIP.bg, NEUTRAL_CHIP.edge),
    };
    ChipColors {
        bg,
        fg: pr_ink(tone),
        edge,
    }
}

/// Whether the workspace's PR is a draft, read off the PR itself (prs.rs
/// pr_of), since the summary keeps only the words.
pub fn draft_of(saved: &SavedState, w: Option<&Workspace>) -> bool {
    pr_of(saved, w).is_some_and(|p| p.draft == Some(true))
}

/// A PR's words in a card's line: its tone's ink, `draft` from draft_of.
pub fn pr_text_color(pr: &PrSummary, draft: bool) -> Token {
    pr_ink(pr_tone(pr.status, draft, pr.health))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TONES: [PrTone; 9] = [
        PrTone::Failing,
        PrTone::Conflicts,
        PrTone::Running,
        PrTone::Ready,
        PrTone::Draft,
        PrTone::Open,
        PrTone::Merged,
        PrTone::Closed,
        PrTone::Quiet,
    ];

    #[test]
    fn lets_a_health_with_a_hue_win_draft_or_not() {
        let open = Some(PrStatus::Open);
        assert_eq!(pr_tone(open, true, PrHealth::Failing), PrTone::Failing);
        assert_eq!(pr_tone(open, true, PrHealth::Conflicts), PrTone::Conflicts);
        assert_eq!(pr_tone(open, true, PrHealth::Running), PrTone::Running);
        assert_eq!(
            pr_tone(open, false, PrHealth::Stuck),
            PrTone::Running,
            "blue words, a clay card"
        );
        assert_eq!(pr_tone(open, false, PrHealth::Ready), PrTone::Ready);
    }

    #[test]
    fn reads_a_quiet_pr_by_its_state() {
        let quiet = PrHealth::Quiet;
        assert_eq!(pr_tone(Some(PrStatus::Open), true, quiet), PrTone::Draft);
        assert_eq!(pr_tone(Some(PrStatus::Open), false, quiet), PrTone::Open);
        assert_eq!(pr_tone(Some(PrStatus::Merged), true, quiet), PrTone::Merged);
        assert_eq!(pr_tone(Some(PrStatus::Closed), true, quiet), PrTone::Closed);
        assert_eq!(pr_tone(None, false, quiet), PrTone::Quiet);
        assert_eq!(pr_tone(None, true, quiet), PrTone::Quiet);
        assert_eq!(
            pr_tone(Some(PrStatus::Unknown), false, quiet),
            PrTone::Quiet
        );
    }

    #[test]
    fn greys_a_stale_ready_so_its_ready_never_borrows_opens_green() {
        let ready = pr_tone(Some(PrStatus::Open), false, PrHealth::Ready);
        assert_eq!(shown_tone(ready, true), PrTone::Quiet);
        assert_eq!(shown_tone(ready, false), PrTone::Ready);
        for t in TONES.into_iter().filter(|t| *t != PrTone::Ready) {
            assert_eq!(shown_tone(t, true), t, "{t:?}");
        }
    }

    #[test]
    fn inks_each_tone() {
        assert_eq!(pr_ink(PrTone::Failing), Token::RedText);
        assert_eq!(pr_ink(PrTone::Conflicts), Token::RedText);
        assert_eq!(pr_ink(PrTone::Running), Token::BlueText);
        assert_eq!(pr_ink(PrTone::Ready), READY_INK);
        assert_eq!(pr_ink(PrTone::Draft), Token::MetaText);
        assert_eq!(pr_ink(PrTone::Closed), Token::MetaText);
        assert_eq!(pr_ink(PrTone::Quiet), Token::MetaText);
        assert_eq!(pr_ink(PrTone::Open), Token::OpenText);
        assert_eq!(pr_ink(PrTone::Merged), Token::MergedText);
    }

    #[test]
    fn says_ready_in_its_own_green_only() {
        for t in TONES.into_iter().filter(|t| *t != PrTone::Ready) {
            assert_ne!(pr_ink(t), READY_INK, "{t:?}");
        }
    }

    #[test]
    fn faces_a_state_chip_in_its_hue_and_a_grey_one_as_the_quiet_chip() {
        let ready = pr_chip_colors(PrTone::Ready);
        assert_eq!(
            (ready.bg, ready.fg, ready.edge),
            (Token::GreenChipFace, READY_INK, Token::GreenChipEdge)
        );
        assert_eq!(pr_chip_colors(PrTone::Running).bg, Token::BlueChipFace);
        assert_eq!(pr_chip_colors(PrTone::Conflicts).edge, Token::RedChipEdge);
        let open = pr_chip_colors(PrTone::Open);
        assert_eq!(
            (open.bg, open.fg, open.edge),
            (Token::OpenChipFace, Token::OpenText, Token::OpenChipEdge)
        );
        let merged = pr_chip_colors(PrTone::Merged);
        assert_eq!(
            (merged.bg, merged.fg, merged.edge),
            (
                Token::MergedChipFace,
                Token::MergedText,
                Token::MergedChipEdge
            )
        );
        for t in [PrTone::Draft, PrTone::Closed, PrTone::Quiet] {
            let c = pr_chip_colors(t);
            assert_eq!((c.bg, c.edge), (NEUTRAL_CHIP.bg, NEUTRAL_CHIP.edge));
            assert_eq!(c.fg, Token::MetaText);
        }
    }

    #[test]
    fn says_ready_in_the_merge_green_a_ready_to_merge_card_says_it_in() {
        use crate::status::StatusKind;
        assert_eq!(READY_INK, StatusKind::MergeReady.style().text);
        assert_ne!(READY_INK, Token::GreenDeep);
    }
}
