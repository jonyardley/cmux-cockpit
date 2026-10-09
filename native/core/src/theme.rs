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
    /// The first ink: a title's words, which the shells draw with it.
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
    /// The four lane hues config/lanes.json may pick, chosen clear of the
    /// state hues (clay, amber, blue, the greens and red).
    LaneViolet,
    LaneTeal,
    LaneRose,
    LaneBrown,
    /// Ready to merge's dot (issue #299): palette.ts's vivid mergeGreen,
    /// never the finished olive.
    MergeGreen,
    /// Ready to merge's halo: its dot's green, faint.
    MergeHalo,
    /// Ready to merge in words, a step darker than its dot.
    MergeText,
}

/// A project's own colour, "#D97757" as the table writes it, as six hex
/// digits. A hand-typed "#RGB" reads as its six digits, and "#RRGGBBAA"
/// drops its alpha; None for anything else. The JS sidebar's badge ink
/// (src/shared/contrast.ts) is looser: it also takes four digits and a
/// colour with no "#", which this leaves grey.
pub fn parse_hex(s: &str) -> Option<u32> {
    let digits = s.strip_prefix('#')?;
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let full = match digits.len() {
        3 => digits.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 | 8 => digits.to_string(),
        _ => return None,
    };
    u32::from_str_radix(full.get(..6)?, 16).ok()
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
        assert_eq!(parse_hex("#D75"), Some(0xDD7755), "three digits, doubled");
        assert_eq!(parse_hex("#D9775780"), Some(0xD97757), "alpha dropped");
        assert_eq!(parse_hex("#D975"), None, "four digits");
    }

    #[test]
    fn refuses_every_other_shape() {
        for bad in [
            "",
            "#",
            "abc",
            "#ab",
            "#abcd",
            "#abcde",
            "#abcdefa",
            "#abcdefabc",
            "#ggg",
            "#+bc",
            "#ab c",
            "#aabbccgg",
        ] {
            assert_eq!(parse_hex(bad), None, "{bad:?}");
        }
    }
}
