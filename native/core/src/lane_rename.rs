//! A lane renamed in config/lanes.json takes its cmux group with it (issue
//! #294, src/cockpit/lane-rename.ts), so its cards stay in the lane rather
//! than falling to Unsorted.
//!
//! Each lane id's last name is kept in the state file (`laneNames`); a
//! lane with none saved is taken to have its built-in name. When lanes.json
//! gives a different name, the group still under the old name is renamed,
//! once, and the new name is saved only when cmux shows a group under it,
//! so a rename cmux dropped is asked again on the next start. A group
//! already under the new name is the lane's now: the old one is left
//! alone. A lane whose new name is another renamed lane's old name waits
//! for that lane's group to move first, so a chain of renames follows
//! through; a swap waits for ever and renames neither. A lane seen for the
//! first time is saved once a group under its name exists. The TypeScript
//! sidebar does the same.
//!
//! The group's generated anchor is renamed too, and the name is saved only
//! once the anchor shows the new title: an anchor is known by its title
//! matching the group's name (anchors.rs), so one left under the old title
//! would show as a card.

use std::collections::HashSet;

use serde_json::Value;

use crate::data::{Data, WorkspaceGroup};
use crate::lanes::built_in_name;
use crate::session::{Param, Session};

/// A lane whose name differs from the one last saved for it.
struct Change {
    id: String,
    from: Option<String>,
    to: String,
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

impl Session {
    /// Follows each lane renamed since its name was last saved, and saves
    /// the name of a lane seen for the first time. Idempotent: run from the
    /// read every frame starts with, it asks each rename once and writes
    /// only when a name changed. Waits for cmux's groups, a state file and
    /// a lanes.json that lists lanes.
    pub(crate) fn rename_lane_groups(&mut self, data: &Data) {
        let Some(groups) = data.groups.as_deref() else {
            return;
        };
        if !self.lanes_read || !self.state_read {
            return;
        }
        let changes: Vec<Change> = self
            .lanes
            .groups()
            .iter()
            .map(|lane| {
                let id = lane.key.as_str();
                let from = (self.saved.lane_names.get(id).map(String::as_str))
                    .or_else(|| built_in_name(id))
                    .map(str::to_string);
                Change {
                    id: id.to_string(),
                    from,
                    to: lane.name.clone(),
                }
            })
            .filter(|c| c.from.as_deref() != Some(c.to.as_str()))
            .collect();
        let named = |n: &str| groups.iter().find(|g| g.name.as_deref() == Some(n));
        // Old names still on a group, which no other lane may take yet.
        let leaving: HashSet<&str> = changes
            .iter()
            .filter_map(|c| c.from.as_deref())
            .filter(|f| named(f).is_some())
            .collect();
        for c in changes.iter().filter(|c| !leaving.contains(c.to.as_str())) {
            if let Some(g) = named(&c.to) {
                self.settle(data, c, g);
            } else if let Some(old) = c.from.as_deref().and_then(named) {
                self.ask(
                    format!("group:{}", c.id),
                    &c.to,
                    "workspace.group.rename",
                    vec![("group_id", old.id.clone()), ("name", c.to.clone())],
                );
            }
        }
    }

    /// The lane's group is under its new name: saves it once the anchor,
    /// if it has one, is under the new title too.
    fn settle(&mut self, data: &Data, c: &Change, g: &WorkspaceGroup) {
        if let (Some(from), Some(anchor_id)) = (c.from.as_deref(), g.anchor_id.as_deref()) {
            let Some(anchor) = data.ws_by_id(anchor_id) else {
                return; // not sent yet
            };
            if norm(anchor.title.as_deref().unwrap_or_default()) == norm(from) {
                self.ask(
                    format!("anchor:{anchor_id}"),
                    &c.to,
                    "workspace.rename",
                    vec![("workspace_id", anchor.id.clone()), ("title", c.to.clone())],
                );
                return;
            }
        }
        let key = format!("laneNames.{}", c.id);
        let value = Value::from(c.to.clone());
        self.saved.set_entry(&key, Some(&value));
        self.persist_set(key, Some(value));
    }

    fn ask(&mut self, key: String, name: &str, method: &str, params: Vec<(&str, String)>) {
        if self.renames_asked.get(&key).map(String::as_str) == Some(name) {
            return;
        }
        self.renames_asked.insert(key, name.to_string());
        let params = params
            .into_iter()
            .map(|(k, v)| (k, Param::Str(v)))
            .collect();
        self.cmux(method, params);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::lanes::LaneConfig;
    use crate::persist::SavedState;
    use crate::session::Outbound;

    fn session(config: Value, saved: Value) -> Session {
        let mut s = Session::default();
        let lanes: Vec<LaneConfig> = serde_json::from_value(config).unwrap();
        s.set_lanes(&lanes);
        s.reseed(serde_json::from_value(saved).unwrap());
        s
    }

    // main renamed from its built-in name, review unchanged, a saved lane
    // renamed onto a group that already exists, Background renamed with no
    // group under either name, and a new lane seen for the first time.
    fn renamed() -> Session {
        session(
            json!([
                {"id": "main", "name": "Doing"},
                {"id": "review", "name": "For review"},
                {"id": "ideas", "name": "Thoughts"},
                {"id": "bg", "name": "Later"},
                {"name": "Shelf"},
            ]),
            json!({"laneNames": {"ideas": "Ideas"}}),
        )
    }

    fn data(groups: Value, workspaces: Value) -> Data {
        serde_json::from_value(json!({"epoch": 10, "groups": groups, "workspaces": workspaces}))
            .unwrap()
    }

    fn first_groups() -> Value {
        json!([
            {"id": "g-main", "name": "Main activity", "anchorId": "anchor-main"},
            {"id": "g-review", "name": "For review"},
            {"id": "g-ideas", "name": "Ideas"},
            {"id": "g-thoughts", "name": "Thoughts"},
            {"id": "g-shelf", "name": "Shelf"},
        ])
    }

    fn anchor(title: &str) -> Value {
        json!([{"id": "anchor-main", "title": title, "group": "g-main"}])
    }

    /// The outbox since `from`, in words.
    fn sent(s: &Session, from: usize) -> Vec<String> {
        s.outbox()[from..]
            .iter()
            .map(|o| match o {
                Outbound::Cmux { method, params } => {
                    let p: Vec<String> = params
                        .iter()
                        .map(|(k, v)| match v {
                            Param::Str(v) => format!("{k}={v}"),
                            other => format!("{k}={other:?}"),
                        })
                        .collect();
                    format!("{method} {}", p.join(" "))
                }
                Outbound::Persist { key, value } => format!("persist {key} {value:?}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn twice(s: &mut Session, d: &Data) {
        s.rename_lane_groups(d);
        s.rename_lane_groups(d);
    }

    #[test]
    fn asks_once_to_rename_a_renamed_lanes_group_and_saves_a_name_already_on_a_group() {
        let mut s = renamed();
        twice(&mut s, &data(first_groups(), anchor("Main activity")));
        assert_eq!(
            sent(&s, 0),
            [
                "workspace.group.rename group_id=g-main name=Doing",
                r#"persist laneNames.ideas Some(String("Thoughts"))"#,
                r#"persist laneNames.Shelf Some(String("Shelf"))"#,
            ]
        );
    }

    #[test]
    fn then_retitles_the_anchor_and_saves_the_name_once_both_show_it() {
        let mut s = renamed();
        twice(&mut s, &data(first_groups(), anchor("Main activity")));
        let groups = json!([{"id": "g-main", "name": "Doing", "anchorId": "anchor-main"}]);
        let at = s.outbox().len();
        twice(&mut s, &data(groups.clone(), anchor("Main activity")));
        assert_eq!(
            sent(&s, at),
            ["workspace.rename workspace_id=anchor-main title=Doing"]
        );
        let at = s.outbox().len();
        twice(&mut s, &data(groups, anchor("Doing")));
        assert_eq!(
            sent(&s, at),
            [r#"persist laneNames.main Some(String("Doing"))"#]
        );
    }

    #[test]
    fn saves_a_waiting_lanes_name_once_its_group_turns_up_under_it() {
        let mut s = renamed();
        twice(&mut s, &data(first_groups(), anchor("Main activity")));
        let at = s.outbox().len();
        let groups = json!([{"id": "g-later", "name": "Later"}]);
        twice(&mut s, &data(groups, json!([])));
        assert_eq!(
            sent(&s, at),
            [r#"persist laneNames.bg Some(String("Later"))"#]
        );
    }

    #[test]
    fn renames_a_chain_in_order_and_never_a_swapped_pair() {
        let mut s = session(
            json!([
                {"id": "main", "name": "For review"},
                {"id": "review", "name": "To check"},
                {"id": "bg", "name": "Parked"},
                {"id": "parked", "name": "Background"},
            ]),
            json!({}),
        );
        let groups = |review: &str| {
            json!([
                {"id": "g-main", "name": "Main activity"},
                {"id": "g-review", "name": review},
                {"id": "g-bg", "name": "Background"},
                {"id": "g-parked", "name": "Parked"},
            ])
        };
        s.rename_lane_groups(&data(groups("For review"), json!([])));
        assert_eq!(
            sent(&s, 0),
            ["workspace.group.rename group_id=g-review name=To check"]
        );
        let at = s.outbox().len();
        s.rename_lane_groups(&data(groups("To check"), json!([])));
        assert_eq!(
            sent(&s, at),
            [
                "workspace.group.rename group_id=g-main name=For review",
                r#"persist laneNames.review Some(String("To check"))"#,
            ]
        );
    }

    #[test]
    fn waits_for_cmuxs_groups_a_state_file_and_a_lanes_json_that_lists_lanes() {
        let config = json!([{"id": "main", "name": "Doing"}]);
        let groups = json!([{"id": "g-main", "name": "Main activity"}]);
        let mut s = session(config.clone(), json!({}));
        let no_groups: Data = serde_json::from_value(json!({"epoch": 10})).unwrap();
        s.rename_lane_groups(&no_groups);
        s.rename_lane_groups(&data(json!([]), json!([])));
        assert!(s.outbox().is_empty());

        // No state file read yet.
        let mut unread = Session::default();
        let lanes: Vec<LaneConfig> = serde_json::from_value(config).unwrap();
        unread.set_lanes(&lanes);
        unread.rename_lane_groups(&data(groups.clone(), json!([])));
        assert!(unread.outbox().is_empty());

        // main saved as renamed, then lanes.json empty or gone: today's
        // four are not Jon's choice, so the group is not renamed back.
        let mut emptied = session(json!([]), json!({"laneNames": {"main": "Doing"}}));
        emptied.rename_lane_groups(&data(json!([{"id": "g-main", "name": "Doing"}]), json!([])));
        assert!(emptied.outbox().is_empty());
    }

    #[test]
    fn a_new_state_file_without_the_write_yet_still_holds_it() {
        let mut s = renamed();
        twice(&mut s, &data(first_groups(), anchor("Main activity")));
        s.reseed(SavedState::default());
        assert_eq!(
            s.saved.lane_names.get("ideas").map(String::as_str),
            Some("Thoughts")
        );
    }
}
