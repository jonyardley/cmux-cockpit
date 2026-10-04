//! Lanes are cmux workspace groups matched by name, in display order
//! (src/cockpit/lanes.ts). Unsorted is not a group: it holds every
//! workspace outside the others.

use crate::theme::Token;

/// A lane's key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LaneKey {
    Main,
    Review,
    Bg,
    Parked,
    Unsorted,
}

impl LaneKey {
    pub fn as_str(self) -> &'static str {
        match self {
            LaneKey::Main => "main",
            LaneKey::Review => "review",
            LaneKey::Bg => "bg",
            LaneKey::Parked => "parked",
            LaneKey::Unsorted => "unsorted",
        }
    }
}

/// How big a lane's cards draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Density {
    Full,
    Compact,
    Row,
}

impl Density {
    pub fn as_str(self) -> &'static str {
        match self {
            Density::Full => "full",
            Density::Compact => "compact",
            Density::Row => "row",
        }
    }
}

/// One lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lane {
    pub key: LaneKey,
    /// The cmux group name it matches.
    pub name: &'static str,
    pub color: Token,
    pub density: Density,
    pub starts_collapsed: bool,
}

const UNSORTED: Lane = Lane {
    key: LaneKey::Unsorted,
    name: "Unsorted",
    color: Token::LaneUnsorted,
    density: Density::Row,
    starts_collapsed: false,
};

/// Every lane, in display order, Unsorted last.
pub const LANES: [Lane; 5] = [
    Lane {
        key: LaneKey::Main,
        name: "Main activity",
        color: Token::LaneMain,
        density: Density::Full,
        starts_collapsed: false,
    },
    Lane {
        key: LaneKey::Review,
        name: "For review",
        color: Token::LaneReview,
        density: Density::Compact,
        starts_collapsed: false,
    },
    Lane {
        key: LaneKey::Bg,
        name: "Background",
        color: Token::LaneBackground,
        density: Density::Compact,
        starts_collapsed: false,
    },
    Lane {
        key: LaneKey::Parked,
        name: "Parked",
        color: Token::LaneParked,
        density: Density::Row,
        starts_collapsed: true,
    },
    UNSORTED,
];

/// A drop above every row lands here.
pub const FIRST_LANE: LaneKey = LaneKey::Main;

/// The lane with this key.
pub fn lane_by_key(k: LaneKey) -> Lane {
    LANES.into_iter().find(|l| l.key == k).unwrap_or(UNSORTED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchors::LANE_GROUP_NAMES;

    #[test]
    fn names_the_same_groups_as_the_anchors() {
        let names: Vec<&str> = LANES[..4].iter().map(|l| l.name).collect();
        assert_eq!(names, LANE_GROUP_NAMES);
    }
}
