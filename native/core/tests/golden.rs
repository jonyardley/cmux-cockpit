//! The lanes, placement and Needs you strip match the TypeScript model's
//! golden JSON (test/golden/README.md) for every cockpit scene. Only the
//! fields model.rs, status.rs and strip.rs answer are compared: the view
//! mode, every workspace's placement, whether each lane is folded, and the
//! strip's list, rows, placeholders, "+N more" and clock. A lane header's
//! cards and merge line, the lane and project entries and Next belong to
//! the modules later lanes port.

#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::data::Data;
use cockpit_core::lanes::LANES;
use cockpit_core::model::{actual_lane_of, card_density};
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use cockpit_core::session::Session;
use serde_json::{Map, Value, json};

fn golden(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../test/golden/{name}"));
    let text = std::fs::read_to_string(&path).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// What the port computes for the scene, in the golden file's shape.
fn computed(input: &Value) -> Value {
    let data: Data = serde_json::from_value(input["data"].clone()).unwrap();
    let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
    let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
    let mut s = Session::new(projects, saved);

    let cards: Vec<String> = s
        .card_workspaces(&data)
        .iter()
        .map(|w| w.id.clone())
        .collect();
    let mut placement = Map::new();
    for w in s.all_workspaces(&data) {
        let place = json!({
            "actualLane": actual_lane_of(&data, Some(w)).as_str(),
            "card": cards.contains(&w.id),
            "density": card_density(&data, Some(w)).as_str(),
            "lane": s.lane_of(&data, w).as_str(),
            "project": s.project_key(w),
            "status": s.status_of(Some(w)).as_str(),
        });
        placement.insert(w.id.clone(), place);
    }
    let mut collapsed = Map::new();
    for lane in &LANES {
        collapsed.insert(
            lane.key.as_str().to_string(),
            Value::from(s.is_collapsed(&data, lane)),
        );
    }
    let ids = |list: Vec<&cockpit_core::data::Workspace>| -> Vec<String> {
        list.into_iter().map(|w| w.id.clone()).collect()
    };
    let needs = json!({
        "inStrip": s.in_strip(&data).into_iter().collect::<Vec<_>>(),
        "late": s.needs_wait_late(&data),
        "list": ids(s.needs_list(&data)),
        "more": s.needs_more(&data),
        "shown": ids(s.needs_shown(&data)),
        "waitText": s.needs_wait_text(&data),
    });
    json!({
        "mode": s.mode().as_str(),
        "needs": needs,
        "placement": placement,
        "collapsed": collapsed,
    })
}

fn check(scene: &str) {
    let input = golden(&format!("{scene}.input.json"));
    let want = golden(&format!("{scene}.json"));
    let got = computed(&input);

    assert_eq!(got["mode"], want["mode"], "{scene}: mode");
    assert_eq!(got["placement"], want["placement"], "{scene}: placement");
    assert_eq!(got["needs"], want["needs"], "{scene}: needs");
    let headers = want["laneHeaders"].as_object().unwrap();
    assert_eq!(headers.len(), LANES.len(), "{scene}: one header per lane");
    for (lane, header) in headers {
        assert_eq!(
            got["collapsed"][lane], header["collapsed"],
            "{scene}: laneHeaders.{lane}.collapsed"
        );
    }
}

#[test]
fn lanes_scene_matches_the_golden_lanes_placement_and_needs() {
    check("lanes");
}

#[test]
fn needs_and_next_scene_matches_the_golden_lanes_placement_and_needs() {
    check("needs-and-next");
}

#[test]
fn projects_scene_matches_the_golden_lanes_placement_and_needs() {
    check("projects");
}

#[test]
fn review_verdicts_scene_matches_the_golden_lanes_placement_and_needs() {
    check("review-verdicts");
}
