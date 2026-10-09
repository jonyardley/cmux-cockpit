//! Lanes are cmux workspace groups matched by name, in display order
//! (src/cockpit/lanes.ts). Unsorted is not a group: it holds every
//! workspace outside the others, and is always last.
//!
//! The table comes from config/lanes.json, an array of `LaneConfig`; with
//! no file, or an empty array, it is today's four lanes. A field a lane
//! leaves out takes the value the built-in lane with the same id has, so a
//! file that lists "Parked" by name alone, with id "parked", still draws
//! it faint and folded.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::theme::Token;

/// A lane's id: a configured lane's `id`, or its name when it has none.
/// Saved folds are keyed by it (`lane:<id>`).
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, facet::Facet,
)]
#[serde(transparent)]
#[facet(transparent)]
pub struct LaneKey(String);

const UNSORTED_ID: &str = "unsorted";

impl LaneKey {
    pub fn new(id: impl Into<String>) -> LaneKey {
        LaneKey(id.into())
    }

    /// Unsorted's key, which no configured lane may take.
    pub fn unsorted() -> LaneKey {
        LaneKey::new(UNSORTED_ID)
    }

    pub fn is_unsorted(&self) -> bool {
        self.0 == UNSORTED_ID
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for LaneKey {
    fn from(id: &str) -> LaneKey {
        LaneKey::new(id)
    }
}

/// How big a lane's cards draw. The panel carries it on each card, so it
/// serialises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, facet::Facet)]
#[repr(u8)]
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

    fn parse(s: &str) -> Option<Density> {
        [Density::Full, Density::Compact, Density::Row]
            .into_iter()
            .find(|d| d.as_str() == s)
    }
}

/// One lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    pub key: LaneKey,
    /// The cmux group name it matches.
    pub name: String,
    /// One of the lane tokens, which the theme maps light and dark.
    pub color: Token,
    pub density: Density,
    pub starts_collapsed: bool,
    /// Its heading and merge-ready hint draw faint.
    pub faint: bool,
    /// Its cards say where you left off ("You: <last prompt>").
    pub left_off: bool,
}

/// One lane as config/lanes.json writes it. Only `name` is needed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaneConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    /// One of the lane colour tokens: laneMain, laneReview,
    /// laneBackground, laneParked, laneUnsorted, laneViolet, laneTeal,
    /// laneRose. A hex is refused, so every lane reads in
    /// both themes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// full, compact or row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_off: Option<bool>,
}

/// The colours a lane may take: the lane tokens, as JSON names them.
const LANE_COLORS: [Token; 8] = [
    Token::LaneMain,
    Token::LaneReview,
    Token::LaneBackground,
    Token::LaneParked,
    Token::LaneUnsorted,
    Token::LaneViolet,
    Token::LaneTeal,
    Token::LaneRose,
];

/// What an unknown colour's error suggests. A hex is refused, so every
/// lane reads in both themes; the same words as lane-config.ts.
const LANE_COLOR_HINT: &str = "use a lane token (laneMain, laneReview, laneBackground, laneParked, laneUnsorted, laneViolet, laneTeal or laneRose); a hex is not taken";

fn parse_color(s: &str) -> Option<Token> {
    let token: Token = serde_json::from_value(serde_json::Value::from(s)).ok()?;
    LANE_COLORS.contains(&token).then_some(token)
}

fn unsorted() -> Lane {
    Lane {
        key: LaneKey::unsorted(),
        name: "Unsorted".to_string(),
        color: Token::LaneUnsorted,
        density: Density::Row,
        starts_collapsed: false,
        faint: false,
        left_off: false,
    }
}

/// A built-in lane's flags: whether it starts folded, draws faint and
/// says where you left off.
#[derive(Clone, Copy)]
struct Flags {
    folded: bool,
    faint: bool,
    left_off: bool,
}

/// A built-in lane. Parked alone starts folded, and it alone draws faint.
fn built_in_lane(id: &str, name: &str, color: Token, density: Density, flags: Flags) -> Lane {
    Lane {
        key: LaneKey::new(id),
        name: name.to_string(),
        color,
        density,
        starts_collapsed: flags.folded,
        faint: flags.faint,
        left_off: flags.left_off,
    }
}

/// Today's four lanes, which a missing or empty lanes.json gives.
fn built_in() -> Vec<Lane> {
    use Density::{Compact, Full, Row};
    let plain = Flags {
        folded: false,
        faint: false,
        left_off: false,
    };
    let left_off = Flags {
        left_off: true,
        ..plain
    };
    let shelved = Flags {
        folded: true,
        faint: true,
        left_off: true,
    };
    vec![
        built_in_lane("main", "Main activity", Token::LaneMain, Full, plain),
        built_in_lane("review", "For review", Token::LaneReview, Compact, plain),
        built_in_lane("bg", "Background", Token::LaneBackground, Compact, left_off),
        built_in_lane("parked", "Parked", Token::LaneParked, Row, shelved),
    ]
}

/// The id a configured lane takes: its own, else its name.
fn config_id(c: &LaneConfig) -> &str {
    c.id.as_deref().unwrap_or(&c.name).trim()
}

/// A lane read from config, its gaps filled from `base`, else compact,
/// unfolded and plain in laneUnsorted's colour.
fn configured(c: &LaneConfig, base: Option<&Lane>) -> Result<Lane, String> {
    let name = c.name.trim();
    if name.is_empty() {
        return Err("a lane has no name".to_string());
    }
    let id = config_id(c);
    if id.is_empty() {
        return Err(format!("lane \"{name}\" has an empty id"));
    }
    let color = match c.color.as_deref() {
        Some(s) => parse_color(s)
            .ok_or_else(|| format!("lane \"{name}\": unknown colour {s:?}; {LANE_COLOR_HINT}"))?,
        None => base.map_or(Token::LaneUnsorted, |b| b.color),
    };
    let density = match c.density.as_deref() {
        Some(s) => {
            Density::parse(s).ok_or_else(|| format!("lane \"{name}\": unknown density {s:?}"))?
        }
        None => base.map_or(Density::Compact, |b| b.density),
    };
    let or_base = |v: Option<bool>, pick: fn(&Lane) -> bool| v.or(base.map(pick)).unwrap_or(false);
    Ok(Lane {
        key: LaneKey::new(id),
        name: name.to_string(),
        color,
        density,
        starts_collapsed: or_base(c.folded, |b| b.starts_collapsed),
        faint: or_base(c.faint, |b| b.faint),
        left_off: or_base(c.left_off, |b| b.left_off),
    })
}

/// Every lane in display order, then Unsorted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lanes {
    groups: Vec<Lane>,
    unsorted: Lane,
}

impl Default for Lanes {
    fn default() -> Lanes {
        Lanes {
            groups: built_in(),
            unsorted: unsorted(),
        }
    }
}

impl Lanes {
    /// The table config/lanes.json describes; none or an empty list is
    /// today's four. A lane without a name, an unknown colour or density,
    /// an id or group name used twice, or an id or name "unsorted" in any
    /// case fails it whole. A field it does not know fails it on reading.
    pub fn from_config(config: &[LaneConfig]) -> Result<Lanes, String> {
        let defaults = built_in();
        let mut groups = Vec::with_capacity(config.len());
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        for c in config {
            let base = defaults.iter().find(|l| l.key.as_str() == config_id(c));
            let lane = configured(c, base)?;
            let taken = |s: &str| s.to_lowercase() == UNSORTED_ID;
            if taken(lane.key.as_str()) || taken(&lane.name) {
                return Err(format!(
                    "lane \"{}\": \"{UNSORTED_ID}\" is Unsorted's, as an id or a name",
                    lane.name
                ));
            }
            if !ids.insert(lane.key.clone()) {
                return Err(format!("two lanes have the id \"{}\"", lane.key.as_str()));
            }
            if !names.insert(lane.name.to_lowercase()) {
                return Err(format!("two lanes are named \"{}\"", lane.name));
            }
            groups.push(lane);
        }
        if groups.is_empty() {
            return Ok(Lanes::default());
        }
        Ok(Lanes {
            groups,
            unsorted: unsorted(),
        })
    }

    /// Every lane, Unsorted last.
    pub fn iter(&self) -> impl Iterator<Item = &Lane> {
        self.groups.iter().chain(std::iter::once(&self.unsorted))
    }

    /// The lanes that are cmux groups: all but Unsorted.
    pub fn groups(&self) -> &[Lane] {
        &self.groups
    }

    /// The lane with this key, Unsorted included; None for a key the table
    /// does not hold, which an action then ignores.
    pub fn find(&self, k: &LaneKey) -> Option<&Lane> {
        self.iter().find(|l| &l.key == k)
    }

    /// The lane with this key; Unsorted for a key no lane has. For drawing,
    /// where a card always needs a lane; an action uses `find`.
    pub fn get(&self, k: &LaneKey) -> &Lane {
        self.groups
            .iter()
            .find(|l| &l.key == k)
            .unwrap_or(&self.unsorted)
    }

    /// The first lane: a drop above every row lands here, and a new
    /// project opens here.
    pub fn first(&self) -> &LaneKey {
        self.groups.first().map_or(&self.unsorted.key, |l| &l.key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(lanes: &Lanes) -> Vec<&str> {
        lanes.iter().map(|l| l.key.as_str()).collect()
    }

    fn named(name: &str) -> LaneConfig {
        LaneConfig {
            name: name.to_string(),
            ..LaneConfig::default()
        }
    }

    #[test]
    fn serialises_each_key_as_its_id() {
        for lane in Lanes::default().iter() {
            let json = serde_json::to_value(&lane.key).unwrap();
            assert_eq!(json, lane.key.as_str());
        }
    }

    #[test]
    fn names_today_s_groups() {
        let lanes = Lanes::default();
        let names: Vec<&str> = lanes.groups().iter().map(|l| l.name.as_str()).collect();
        assert_eq!(
            names,
            ["Main activity", "For review", "Background", "Parked"]
        );
    }

    #[test]
    fn the_default_is_today_s_four_then_unsorted() {
        let lanes = Lanes::default();
        assert_eq!(keys(&lanes), ["main", "review", "bg", "parked", "unsorted"]);
        let flags: Vec<(bool, bool, bool)> = lanes
            .iter()
            .map(|l| (l.starts_collapsed, l.faint, l.left_off))
            .collect();
        assert_eq!(
            flags,
            [
                (false, false, false),
                (false, false, false),
                (false, false, true),
                (true, true, true),
                (false, false, false),
            ]
        );
        assert_eq!(lanes.first().as_str(), "main");
    }

    #[test]
    fn no_lanes_in_config_is_the_default() {
        assert_eq!(Lanes::from_config(&[]), Ok(Lanes::default()));
    }

    #[test]
    fn reads_a_custom_table_in_its_order() {
        let json = r#"[
            {"name": "Doing", "color": "laneReview", "density": "full"},
            {"id": "later", "name": "Some day", "density": "row", "folded": true,
             "faint": true, "leftOff": true}
        ]"#;
        let config: Vec<LaneConfig> = serde_json::from_str(json).unwrap();
        let lanes = Lanes::from_config(&config).unwrap();
        assert_eq!(keys(&lanes), ["Doing", "later", "unsorted"]);
        assert_eq!(lanes.first().as_str(), "Doing");
        let doing = lanes.get(&LaneKey::from("Doing"));
        assert_eq!(
            (doing.color, doing.density, doing.faint, doing.left_off),
            (Token::LaneReview, Density::Full, false, false)
        );
        let later = lanes.get(&LaneKey::from("later"));
        assert_eq!(later.name, "Some day");
        assert_eq!(
            later.color,
            Token::LaneUnsorted,
            "no colour: the neutral one"
        );
        assert!(later.starts_collapsed && later.faint && later.left_off);
    }

    #[test]
    fn takes_any_lane_token_and_refuses_a_hex() {
        let json = r#"[
            {"name": "Violet", "color": "laneViolet"},
            {"name": "Teal", "color": "laneTeal"},
            {"name": "Rose", "color": "laneRose"}
        ]"#;
        let config: Vec<LaneConfig> = serde_json::from_str(json).unwrap();
        let lanes = Lanes::from_config(&config).unwrap();
        let color = |k: &str| lanes.get(&LaneKey::from(k)).color;
        assert_eq!(color("Violet"), Token::LaneViolet);
        assert_eq!(color("Teal"), Token::LaneTeal);
        assert_eq!(color("Rose"), Token::LaneRose);
        for bad in ["#c63", "#CC6633", "#cc663380", "blue", "text", "violet"] {
            let config = [LaneConfig {
                color: Some(bad.into()),
                ..named("Doing")
            }];
            assert_eq!(
                Lanes::from_config(&config),
                Err(format!(
                    "lane \"Doing\": unknown colour {bad:?}; {LANE_COLOR_HINT}"
                )),
                "{bad}"
            );
        }
    }

    #[test]
    fn reads_the_committed_sample() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../config/lanes.example.json"
        );
        let json = std::fs::read_to_string(path).unwrap();
        let config: Vec<LaneConfig> = serde_json::from_str(&json).unwrap();
        let lanes = Lanes::from_config(&config).unwrap();
        let names: Vec<&str> = lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(
            names,
            ["Doing", "Waiting on others", "Ideas", "Parked", "Unsorted"]
        );
        let ideas = lanes.get(&LaneKey::from("Ideas"));
        assert_eq!(ideas.color, Token::LaneRose);
    }

    #[test]
    fn a_built_in_id_fills_what_the_lane_leaves_out() {
        let parked = LaneConfig {
            id: Some("parked".into()),
            ..named("Shelf")
        };
        let lanes = Lanes::from_config(&[named("Background"), parked]).unwrap();
        // "Background" has no id, so it is not "bg" and takes nothing.
        let bg = lanes.get(&LaneKey::from("Background"));
        assert!(!bg.left_off);
        let shelf = lanes.get(&LaneKey::from("parked"));
        assert_eq!(shelf.name, "Shelf");
        assert_eq!(
            (shelf.color, shelf.density),
            (Token::LaneParked, Density::Row)
        );
        assert!(shelf.starts_collapsed && shelf.faint && shelf.left_off);
        let unfaint = LaneConfig {
            id: Some("parked".into()),
            faint: Some(false),
            ..named("Parked")
        };
        let lanes = Lanes::from_config(&[unfaint]).unwrap();
        assert!(!lanes.get(&LaneKey::from("parked")).faint, "said, so kept");
    }

    #[test]
    fn finds_only_a_key_the_table_holds() {
        let lanes = Lanes::default();
        assert_eq!(
            lanes
                .find(&LaneKey::from("parked"))
                .map(|l| l.name.as_str()),
            Some("Parked")
        );
        assert!(lanes.find(&LaneKey::unsorted()).is_some(), "Unsorted's own");
        assert!(lanes.find(&LaneKey::from("gone")).is_none());
    }

    #[test]
    fn refuses_a_field_it_does_not_know() {
        let read = |json: &str| serde_json::from_str::<Vec<LaneConfig>>(json);
        assert!(read(r#"[{"name": "Doing", "colour": "laneMain"}]"#).is_err());
        assert!(read(r#"[{"name": "Doing", "left_off": true}]"#).is_err());
        assert!(read(r#"[{"name": "Doing", "leftOff": true}]"#).is_ok());
    }

    #[test]
    fn an_unknown_key_reads_as_unsorted() {
        let lanes = Lanes::default();
        assert!(lanes.get(&LaneKey::from("gone")).key.is_unsorted());
        assert_eq!(
            lanes.iter().nth(4).map(|l| l.key.as_str()),
            Some("unsorted")
        );
        assert!(lanes.iter().nth(5).is_none());
    }

    #[test]
    fn refuses_a_table_it_cannot_draw() {
        let with = |f: fn(&mut LaneConfig)| {
            let mut c = named("Doing");
            f(&mut c);
            Lanes::from_config(&[c])
        };
        assert!(with(|c| c.name = "  ".into()).is_err(), "no name");
        assert!(with(|c| c.id = Some(String::new())).is_err(), "empty id");
        assert!(
            with(|c| c.color = Some("red".into())).is_err(),
            "not a lane colour"
        );
        assert!(
            with(|c| c.color = Some("heading".into())).is_err(),
            "a token, not a lane's"
        );
        assert!(
            with(|c| c.density = Some("huge".into())).is_err(),
            "no such density"
        );
        assert!(
            with(|c| c.id = Some("unsorted".into())).is_err(),
            "Unsorted's id"
        );
        assert!(
            with(|c| c.id = Some("Unsorted".into())).is_err(),
            "Unsorted's id, any case"
        );
        assert!(
            with(|c| c.name = "Unsorted".into()).is_err(),
            "Unsorted's name"
        );
        assert!(
            with(|c| c.name = "UNSORTED".into()).is_err(),
            "Unsorted's name, any case"
        );
        let twice = |a: LaneConfig, b: LaneConfig| Lanes::from_config(&[a, b]).is_err();
        assert!(twice(named("A"), named("A")), "the same id");
        let other_id = LaneConfig {
            id: Some("b".into()),
            ..named("a")
        };
        assert!(twice(named("A"), other_id), "the same group, any case");
    }
}
