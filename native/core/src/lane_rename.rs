//! A lane renamed in config/lanes.json takes its cmux group with it (issue
//! #294, src/cockpit/lane-rename.ts), so its cards stay in the lane rather
//! than falling to Unsorted.
//!
//! Each lane id's last name is kept in the state file (`laneNames`). When
//! the name lanes.json gives differs, the group still under the old name
//! is renamed, but only while no group has the new name: a group already
//! called that is the lane's now, and the old one is left alone. Either
//! way the new name is saved; with neither group there, nothing is, so the
//! rename waits for a group to follow. A lane with no saved name is taken
//! to have its built-in name; one with neither is left alone, and the
//! build saves its name, so drawing never writes anything unless a lane
//! was renamed. The TypeScript sidebar does the same; whichever runs
//! second finds the new name taken and only saves.
//!
//! The group's generated anchor is renamed with it: an anchor is known by
//! its title matching the group's name (anchors.rs), so one left under the
//! old title would show as a card.

use serde_json::Value;

use crate::anchors::is_generated_anchor;
use crate::data::{Data, WorkspaceGroup};
use crate::lanes::built_in_name;
use crate::session::{Param, Session};

impl Session {
    /// Renames the group of each lane whose name changed since it was last
    /// saved, then saves the name. Idempotent: run from the read every
    /// frame starts with, it acts once per lane per name, and only for a
    /// lane renamed. Waits for a shell's lane table and cmux's groups.
    pub(crate) fn rename_lane_groups(&mut self, data: &Data) {
        let Some(groups) = data.groups.as_deref() else {
            return;
        };
        if !self.lanes_read {
            return;
        }
        let renamed: Vec<(String, String, String)> = self
            .lanes
            .groups()
            .iter()
            .filter_map(|lane| {
                let id = lane.key.as_str();
                let last = self
                    .saved
                    .lane_names
                    .get(id)
                    .cloned()
                    .or_else(|| built_in_name(id))?;
                (last != lane.name).then(|| (id.to_string(), last, lane.name.clone()))
            })
            .collect();
        for (id, from, to) in renamed {
            if !self.rename_group(data, groups, &from, &to) {
                continue;
            }
            let key = format!("laneNames.{id}");
            let value = Value::from(to);
            self.saved.set_entry(&key, Some(&value));
            self.persist_set(key, Some(value));
        }
    }

    /// Whether the lane's group now goes by `to`: renamed here, or already
    /// called that. False with neither name in the list.
    fn rename_group(
        &mut self,
        data: &Data,
        groups: &[WorkspaceGroup],
        from: &str,
        to: &str,
    ) -> bool {
        if groups.iter().any(|g| g.name.as_deref() == Some(to)) {
            return true;
        }
        let Some(old) = groups.iter().find(|g| g.name.as_deref() == Some(from)) else {
            return false;
        };
        self.cmux(
            "workspace.group.rename",
            vec![
                ("group_id", Param::Str(old.id.clone())),
                ("name", Param::Str(to.to_string())),
            ],
        );
        let anchor = old.anchor_id.as_deref().and_then(|id| data.ws_by_id(id));
        if let Some(a) = anchor.filter(|a| is_generated_anchor(old, Some(a))) {
            self.cmux(
                "workspace.rename",
                vec![
                    ("workspace_id", Param::Str(a.id.clone())),
                    ("title", Param::Str(to.to_string())),
                ],
            );
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::lanes::LaneConfig;
    use crate::persist::SavedState;
    use crate::session::Outbound;

    fn lanes(config: Value) -> Vec<LaneConfig> {
        serde_json::from_value(config).unwrap()
    }

    fn data(groups: Value) -> Data {
        serde_json::from_value(json!({
            "epoch": 10,
            "groups": groups,
            "workspaces": [
                {"id": "anchor-main", "title": "Main activity", "group": "g-main"},
                {"id": "anchor-review", "title": "For review", "group": "g-review"},
            ],
        }))
        .unwrap()
    }

    // main renamed from its built-in name, review unchanged, a saved lane
    // renamed onto a group that already exists, Background renamed with no
    // group under either name, and a new lane the build never recorded.
    fn session() -> Session {
        let mut saved = SavedState::default();
        saved.lane_names.insert("ideas".into(), "Ideas".into());
        let mut s = Session::new(Vec::new(), saved);
        s.set_lanes(&lanes(json!([
            {"id": "main", "name": "Doing"},
            {"id": "review", "name": "For review"},
            {"id": "ideas", "name": "Thoughts"},
            {"id": "bg", "name": "Later"},
            {"name": "Shelf"},
        ])));
        s
    }

    fn groups() -> Value {
        json!([
            {"id": "g-main", "name": "Main activity", "anchorId": "anchor-main"},
            {"id": "g-review", "name": "For review", "anchorId": "anchor-review"},
            {"id": "g-ideas", "name": "Ideas"},
            {"id": "g-thoughts", "name": "Thoughts"},
            {"id": "g-shelf", "name": "Shelf"},
        ])
    }

    fn calls(s: &Session) -> Vec<String> {
        s.outbox()
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

    #[test]
    fn renames_a_renamed_lanes_group_and_anchor_and_saves_each_changed_name() {
        let mut s = session();
        s.rename_lane_groups(&data(groups()));
        assert_eq!(
            calls(&s),
            [
                "workspace.group.rename group_id=g-main name=Doing",
                "workspace.rename workspace_id=anchor-main title=Doing",
                r#"persist laneNames.main Some(String("Doing"))"#,
                r#"persist laneNames.ideas Some(String("Thoughts"))"#,
            ]
        );
    }

    #[test]
    fn does_nothing_on_later_frames_though_cmux_still_shows_the_old_name() {
        let mut s = session();
        s.rename_lane_groups(&data(groups()));
        let before = s.outbox().len();
        s.rename_lane_groups(&data(groups()));
        assert_eq!(s.outbox().len(), before);
    }

    #[test]
    fn saves_a_waiting_lanes_name_once_its_group_turns_up_under_it() {
        let mut s = session();
        s.rename_lane_groups(&data(groups()));
        let before = s.outbox().len();
        let mut later = groups();
        if let Value::Array(list) = &mut later {
            list.push(json!({"id": "g-later", "name": "Later"}));
        }
        s.rename_lane_groups(&data(later));
        assert_eq!(
            calls(&s)[before..],
            [r#"persist laneNames.bg Some(String("Later"))"#]
        );
    }

    #[test]
    fn waits_for_cmuxs_groups_and_a_shells_lane_table() {
        let mut s = session();
        let no_groups: Data = serde_json::from_value(json!({"epoch": 10})).unwrap();
        s.rename_lane_groups(&no_groups);
        s.rename_lane_groups(&data(json!([])));
        assert!(s.outbox().is_empty());

        // Today's four by default, with main saved as renamed: no lane
        // table yet, so the group is not renamed back.
        let mut saved = SavedState::default();
        saved.lane_names.insert("main".into(), "Doing".into());
        let mut fresh = Session::new(Vec::new(), saved);
        fresh.rename_lane_groups(&data(json!([{"id": "g-main", "name": "Doing"}])));
        assert!(fresh.outbox().is_empty());
    }

    #[test]
    fn a_new_state_file_without_the_write_yet_still_holds_it() {
        let mut s = session();
        s.rename_lane_groups(&data(groups()));
        s.reseed(SavedState::default());
        assert_eq!(
            s.saved.lane_names.get("main").map(String::as_str),
            Some("Doing")
        );
    }
}
