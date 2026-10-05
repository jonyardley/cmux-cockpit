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
