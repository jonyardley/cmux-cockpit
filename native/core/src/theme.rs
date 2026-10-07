//! The colour tokens the logic chooses between, named after the keys of
//! src/cockpit/theme.ts and src/shared/palette.ts. The core says which
//! token; the hex values stay with whoever draws.

use serde::{Deserialize, Serialize};

/// A colour token.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, facet::Facet,
)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
#[facet(rename_all = "camelCase")]
pub enum Token {
    /// No colour: "clear".
    #[default]
    Clear,
    Blue,
    Clay,
    Green,
    Amber,
    BlueHalo,
    ClayHalo,
    AmberHalo,
    BlueText,
    ClayText,
    GreenText,
    AmberText,
    MetaText,
    Faint,
    /// A lane header's words.
    Heading,
    /// palette.ts's greenDeep: pr-colors.ts's READY_INK, a PR GitHub would merge.
    GreenDeep,
    /// The first ink: a title's words, and a merged card's Close.
    Text,
    /// The second ink: the quiet chip's words.
    Secondary,
    /// A failing or conflicting PR in words.
    RedText,
    /// The quiet chip's face and edge: the branch, the ports, a PR's pill.
    ChipFace,
    ChipEdge,
    /// A PR state's own chip: a faint face of its health's hue and an edge.
    RedChipFace,
    RedChipEdge,
    BlueChipFace,
    BlueChipEdge,
    GreenChipFace,
    GreenChipEdge,
    CountBg,
    BlueCount,
    ClayCount,
    AmberCount,
    AmberRowEdge,
    NeedsRowEdge,
    Select,
    CardEdge,
    LaneMain,
    LaneReview,
    LaneBackground,
    LaneParked,
    LaneUnsorted,
}

/// A project's own colour, "#D97757" as the table writes it; None for
/// anything but six hex digits after a "#".
pub fn parse_hex(s: &str) -> Option<u32> {
    let digits = s.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_projects_colour_and_refuses_anything_else() {
        assert_eq!(parse_hex("#D97757"), Some(0xD97757));
        assert_eq!(parse_hex("#d97757"), Some(0xD97757));
        assert_eq!(parse_hex("D97757"), None);
        assert_eq!(parse_hex("#D9775"), None);
        assert_eq!(parse_hex("#D9775G"), None);
        assert_eq!(parse_hex("#+97757"), None);
    }
}
