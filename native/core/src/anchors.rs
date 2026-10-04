//! Lane placeholders (src/shared/anchors.ts): the empty workspace cmux makes
//! to hold each lane's group. The cockpit draws one as its lane's header,
//! never as a card. The renderer's data has no flag for it (issue #7), so a
//! generated anchor is the one titled exactly after its group.

use crate::data::{Workspace, WorkspaceGroup};

/// The lane groups' names, as lanes.rs names them.
pub const LANE_GROUP_NAMES: [&str; 4] = ["Main activity", "For review", "Background", "Parked"];

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
}
