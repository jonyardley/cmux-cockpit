//! The status decisions both sidebars share from src/shared/ui.ts: which
//! statuses get the halo, and how urgent a count pill's sessions are.

use crate::theme::Token;

/// The two statuses that get the halo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HaloStatus {
    Working,
    NeedsInput,
}

/// Which status, if any, gets the halo: working and needs only.
pub fn halo_status(status: Option<&str>) -> Option<HaloStatus> {
    match status {
        Some("working") => Some(HaloStatus::Working),
        Some("needs_input") => Some(HaloStatus::NeedsInput),
        _ => None,
    }
}

/// How urgent the sessions behind a count pill are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Needs,
    Asking,
    Working,
    Quiet,
}

/// The ranking, most urgent first.
pub const URGENCY_RANK: [Urgency; 4] = [
    Urgency::Needs,
    Urgency::Asking,
    Urgency::Working,
    Urgency::Quiet,
];

/// A count pill's colours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PillColors {
    pub bg: Token,
    pub fg: Token,
}

/// The count pill with nothing urgent behind it: grey.
pub const QUIET_PILL: PillColors = PillColors {
    bg: Token::CountBg,
    fg: Token::MetaText,
};

/// The one count tint rule both sides share: clay needs you, amber asking,
/// blue working; quiet leaves the pill grey.
pub fn count_tint(u: Urgency) -> PillColors {
    match u {
        Urgency::Needs => PillColors {
            bg: Token::ClayCount,
            fg: Token::ClayText,
        },
        Urgency::Asking => PillColors {
            bg: Token::AmberCount,
            fg: Token::AmberText,
        },
        Urgency::Working => PillColors {
            bg: Token::BlueCount,
            fg: Token::BlueText,
        },
        Urgency::Quiet => QUIET_PILL,
    }
}
