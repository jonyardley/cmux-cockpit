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
    /// Ready to merge's dot (issue #299): palette.ts's vivid mergeGreen,
    /// never the finished olive.
    MergeGreen,
    /// Ready to merge's halo: its dot's green, faint.
    MergeHalo,
    /// Ready to merge in words, a step darker than its dot.
    MergeText,
}

/// A colour of its own, as hex: six digits of red, green and blue, and an
/// alpha (0xFF for opaque).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, facet::Facet)]
pub struct Rgba {
    pub rgb: u32,
    pub alpha: u8,
}

impl Rgba {
    /// "#RRGGBB", or "#RRGGBBAA" when it is not opaque, in capitals.
    pub fn to_hex(self) -> String {
        if self.alpha == 0xFF {
            format!("#{:06X}", self.rgb)
        } else {
            format!("#{:06X}{:02X}", self.rgb, self.alpha)
        }
    }
}

/// A colour as a hand-written config spells it: "#RGB", "#RRGGBB" or
/// "#RRGGBBAA", in either case. None for anything else.
pub fn parse_colour(s: &str) -> Option<Rgba> {
    let digits = s.strip_prefix('#')?;
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let full = match digits.len() {
        3 => digits.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 | 8 => digits.to_string(),
        _ => return None,
    };
    let rgb = u32::from_str_radix(full.get(..6)?, 16).ok()?;
    let alpha = match full.get(6..) {
        Some(a) if !a.is_empty() => u8::from_str_radix(a, 16).ok()?,
        _ => 0xFF,
    };
    Some(Rgba { rgb, alpha })
}

/// A project's own colour, "#D97757" as the table writes it, as six hex
/// digits; None for anything `parse_colour` refuses. A hand-typed "#RGB"
/// reads as its six digits, and "#RRGGBBAA" drops its alpha. The JS
/// sidebar's badge ink (src/shared/contrast.ts) is looser: it also takes
/// four digits and a colour with no "#", which this leaves grey.
pub fn parse_hex(s: &str) -> Option<u32> {
    parse_colour(s).map(|c| c.rgb)
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
    fn reads_a_colour_with_its_alpha() {
        let c = |rgb, alpha| Some(Rgba { rgb, alpha });
        assert_eq!(parse_colour("#abc"), c(0xAABBCC, 0xFF));
        assert_eq!(parse_colour("#AABBCC"), c(0xAABBCC, 0xFF));
        assert_eq!(parse_colour("#aabbcc80"), c(0xAABBCC, 0x80));
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
        ] {
            assert_eq!(parse_colour(bad), None, "{bad:?}");
        }
        assert_eq!(
            parse_colour("#abc").map(Rgba::to_hex).as_deref(),
            Some("#AABBCC")
        );
        assert_eq!(
            parse_colour("#aabbcc80").map(Rgba::to_hex).as_deref(),
            Some("#AABBCC80")
        );
    }
}
