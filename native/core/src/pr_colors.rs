//! The PR chip's palette (src/shared/pr-colors.ts), as tokens: a PR's
//! state words take its health's ink (green ready, red failing or in
//! conflict, blue running, grey for the rest), and a state chip on its own
//! a faint face and edge of that hue. Also status.ts's prTextColor, the
//! one reading of it a card's PR words make.

use crate::prs::{PrHealth, PrSummary};
use crate::theme::Token;

/// A chip's face, words and edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChipColors {
    pub bg: Token,
    pub fg: Token,
    pub edge: Token,
}

/// The quiet chip: the branch, the ports, and a PR's number.
pub const NEUTRAL_CHIP: ChipColors = ChipColors {
    bg: Token::ChipFace,
    fg: Token::Secondary,
    edge: Token::ChipEdge,
};

/// Ready's green, as words on a card.
pub const READY_INK: Token = Token::GreenDeep;

/// A PR's state as words: its health's colour when it has one, else grey.
pub fn pr_ink(health: PrHealth) -> Token {
    match health {
        PrHealth::Failing | PrHealth::Conflicts => Token::RedText,
        PrHealth::Running => Token::BlueText,
        PrHealth::Ready => READY_INK,
        PrHealth::Quiet => Token::MetaText,
    }
}

/// The health a PR's words show while its data may be stale and the chip
/// is dimmed: ready drops to quiet, so a stale verdict does not shout.
pub fn shown_health(health: PrHealth, dim: bool) -> PrHealth {
    if dim && health == PrHealth::Ready {
        PrHealth::Quiet
    } else {
        health
    }
}

/// A PR state chip's colours: its ink on a faint face of its health's
/// hue, or the quiet chip's.
pub fn pr_chip_colors(health: PrHealth) -> ChipColors {
    let (bg, edge) = match health {
        PrHealth::Failing | PrHealth::Conflicts => (Token::RedChipFace, Token::RedChipEdge),
        PrHealth::Running => (Token::BlueChipFace, Token::BlueChipEdge),
        PrHealth::Ready => (Token::GreenChipFace, Token::GreenChipEdge),
        PrHealth::Quiet => (NEUTRAL_CHIP.bg, NEUTRAL_CHIP.edge),
    };
    ChipColors {
        bg,
        fg: pr_ink(health),
        edge,
    }
}

/// A PR's words in a card's line: `quiet` while the PR is quiet or
/// absent, else its health's ink.
pub fn pr_text_color(pr: Option<&PrSummary>, quiet: Token) -> Token {
    match pr {
        Some(p) if p.health != PrHealth::Quiet => pr_ink(p.health),
        _ => quiet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inks_each_health_and_greys_the_quiet_one() {
        assert_eq!(pr_ink(PrHealth::Failing), Token::RedText);
        assert_eq!(pr_ink(PrHealth::Conflicts), Token::RedText);
        assert_eq!(pr_ink(PrHealth::Running), Token::BlueText);
        assert_eq!(pr_ink(PrHealth::Ready), READY_INK);
        assert_eq!(pr_ink(PrHealth::Quiet), Token::MetaText);
    }

    #[test]
    fn faces_a_state_chip_in_its_hue_and_a_quiet_one_as_the_quiet_chip() {
        let ready = pr_chip_colors(PrHealth::Ready);
        assert_eq!(
            (ready.bg, ready.fg, ready.edge),
            (Token::GreenChipFace, READY_INK, Token::GreenChipEdge)
        );
        assert_eq!(pr_chip_colors(PrHealth::Running).bg, Token::BlueChipFace);
        assert_eq!(pr_chip_colors(PrHealth::Conflicts).edge, Token::RedChipEdge);
        let quiet = pr_chip_colors(PrHealth::Quiet);
        assert_eq!((quiet.bg, quiet.edge), (NEUTRAL_CHIP.bg, NEUTRAL_CHIP.edge));
        assert_eq!(quiet.fg, Token::MetaText);
    }

    #[test]
    fn greys_a_stale_ready_and_leaves_the_rest() {
        assert_eq!(shown_health(PrHealth::Ready, true), PrHealth::Quiet);
        assert_eq!(shown_health(PrHealth::Ready, false), PrHealth::Ready);
        assert_eq!(shown_health(PrHealth::Failing, true), PrHealth::Failing);
    }
}
