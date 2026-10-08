//! A lane table that changes under the pane (config/lanes.json edited):
//! a key it no longer holds does nothing, a pending move to it lets go,
//! and a fold saved for it is kept. Not a TypeScript port: the sidebar's
//! lanes are fixed.

use cockpit_core::data::Data;
use cockpit_core::lanes::{LaneConfig, LaneKey};
use cockpit_core::persist::ViewMode;
use cockpit_core::session::Session;
use serde_json::Value;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

fn setup() -> (Session, Data) {
    let data = frame(
        NOW,
        vec![group("g-main", "Main activity").anchor("anchor-main")],
        vec![
            ws("anchor-main").title("Main activity").group("g-main"),
            ws("a").group("g-main"),
            ws("u"),
        ],
    );
    (fresh(), data)
}

fn lane(id: &str, name: &str) -> LaneConfig {
    LaneConfig {
        id: Some(id.into()),
        name: name.into(),
        ..LaneConfig::default()
    }
}

#[test]
fn a_key_the_table_does_not_hold_moves_folds_and_groups_nothing() {
    let (mut s, data) = setup();
    s.set_mode(ViewMode::All);
    s.take_outbox();
    let gone = LaneKey::from("gone");
    s.move_to_lane(&data, Some(by_id(&data, "a")), gone.clone());
    s.toggle_lane(&data, &gone);
    s.move_card(&data, "a", gone.clone(), None);
    assert!(s.outbox().is_empty(), "{:?}", s.outbox());
    assert_eq!(s.lane_of(&data, by_id(&data, "a")), LaneKey::from("main"));
    assert!(!s.is_collapsed(&data, &lane_by_key(LaneKey::unsorted())));

    // A new session asked into it opens ungrouped, as with no group yet.
    s.open_project_workspace(&data, "/dev/app-one", Some(gone));
    assert_eq!(
        calls(&s),
        [call(
            "workspace.create",
            &[("cwd", "~/dev/app-one"), ("focus", "true")]
        )]
    );
}

#[test]
fn unsorted_s_own_key_still_moves_and_folds() {
    let (mut s, data) = setup();
    s.move_to_lane(&data, Some(by_id(&data, "a")), LaneKey::unsorted());
    s.toggle_lane(&data, &LaneKey::unsorted());
    assert_eq!(
        calls(&s),
        [call("workspace.group.remove", &[("workspace_id", "a")])]
    );
    assert!(s.is_collapsed(&data, &lane_by_key(LaneKey::unsorted())));
}

#[test]
fn a_pending_move_to_a_lane_taken_out_of_the_table_lets_go() {
    let (mut s, data) = setup();
    s.set_lanes(&[lane("main", "Main activity"), lane("later", "Later")]);
    s.move_to_lane(&data, Some(by_id(&data, "u")), LaneKey::from("later"));
    assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::from("later"));
    s.set_lanes(&[lane("main", "Main activity")]);
    assert_eq!(s.lane_of(&data, by_id(&data, "u")), LaneKey::unsorted());
    let rows: Vec<String> = s
        .lane_entries(&data)
        .iter()
        .map(|e| e.id().to_string())
        .collect();
    assert!(rows.contains(&"w:u".to_string()), "{rows:?}");
}

#[test]
fn keeps_the_saved_fold_of_a_lane_the_table_no_longer_holds() {
    let mut s = session(r#"{"ui": {"collapsed": {"lane:later": 1, "lane:main": 0}}}"#);
    let (_, data) = setup();
    s.toggle_lane(&data, &LaneKey::unsorted());
    let (key, value) = sent(&s).last().cloned().unwrap();
    assert_eq!(key, "ui.collapsed");
    let folds = value.unwrap();
    assert_eq!(folds["lane:later"], Value::from(1));
    assert_eq!(folds["lane:main"], Value::from(0));
    assert_eq!(folds["lane:unsorted"], Value::from(1));
}
