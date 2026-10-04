//! The colour tokens the logic chooses between, named after the keys of
//! src/cockpit/theme.ts and src/shared/palette.ts. The core says which
//! token; the hex values stay with whoever draws.

/// A colour token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Token {
    /// No colour: "clear".
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
