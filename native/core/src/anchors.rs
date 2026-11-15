//! Lane placeholders (src/shared/anchors.ts): the empty workspace cmux makes
//! to hold each lane's group. The cockpit draws one as its lane's header,
//! never as a card. The renderer's data has no flag for it (issue #7), so a
//! generated anchor is the one titled exactly after its group.
//!
//! Which groups are lanes is the lane table's to say (lanes.rs, from
//! config/lanes.json), so the anchors follow a renamed or added lane:
//! `Session::lane_anchor_ids` asks this of each configured lane's group.

use crate::data::{Workspace, WorkspaceGroup};

/// A name or title as the matches compare it.
fn norm(s: Option<&str>) -> String {
    s.unwrap_or_default().trim().to_lowercase()
}

/// Whether `w`, the anchor of group `g`, is the placeholder cmux generated.
/// A workspace not in the data yet counts, so it never flashes up as a card.
pub fn is_generated_anchor(g: &WorkspaceGroup, w: Option<&Workspace>) -> bool {
    let Some(w) = w else { return true };
    // With no name there is nothing to match: a nameless group's untitled
    // anchor is a real card.
    let name = norm(g.name.as_deref());
    !name.is_empty() && norm(w.title.as_deref()) == name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_title_to_the_group_name() {
        let g = WorkspaceGroup {
            id: "g".into(),
            name: Some("Parked".into()),
            ..WorkspaceGroup::default()
        };
        let titled = |t: &str| Workspace {
            id: "w".into(),
            title: Some(t.into()),
            ..Workspace::default()
        };
        assert!(is_generated_anchor(&g, None));
        assert!(is_generated_anchor(&g, Some(&titled(" parked "))));
        assert!(!is_generated_anchor(&g, Some(&titled("Spike"))));
        let nameless = WorkspaceGroup {
            name: None,
            ..g.clone()
        };
        assert!(!is_generated_anchor(&nameless, Some(&titled(""))));
    }

    #[test]
    fn follows_the_configured_lane_names() {
        use crate::data::Data;
        use crate::lanes::LaneConfig;
        use crate::session::Session;

        let group = |id: &str, name: &str| WorkspaceGroup {
            id: id.into(),
            name: Some(name.into()),
            anchor_id: Some(format!("{id}-anchor")),
            ..WorkspaceGroup::default()
        };
        let anchor = |id: &str, title: &str| Workspace {
            id: format!("{id}-anchor"),
            title: Some(title.into()),
            ..Workspace::default()
        };
        let data = Data {
            epoch: Some(1000.0),
            groups: Some(vec![group("d", "Doing"), group("p", "Parked")]),
            workspaces: Some(vec![anchor("d", "Doing"), anchor("p", "Parked")]),
            ..Data::default()
        };
        let mut s = Session::default();
        let built_in: Vec<String> = s.lane_anchor_ids(&data).into_iter().collect();
        assert_eq!(built_in, ["p-anchor"], "today's four: Parked's alone");
        let doing = LaneConfig {
            name: "Doing".into(),
            ..LaneConfig::default()
        };
        s.set_lanes(&[doing]);
        let configured: Vec<String> = s.lane_anchor_ids(&data).into_iter().collect();
        assert_eq!(
            configured,
            ["d-anchor"],
            "Doing's, and Parked's is a card now it is no lane"
        );
    }
}
