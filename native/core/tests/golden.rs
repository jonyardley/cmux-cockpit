//! The core matches the TypeScript model's golden JSON
//! (test/golden/README.md) for every cockpit scene: the view mode, every
//! workspace's placement, and the All view as the app builds it (Needs
//! you, Next, All's rows, and each lane header's fold, cards and merge
//! line). The Projects rows and quiet projects belong to the by-project
//! port and are not compared.

#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::app::build_view;
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
    let view = serde_json::to_value(build_view(&mut s, &data)).unwrap();
    json!({
        "mode": s.mode().as_str(),
        "placement": placement,
        "view": view,
    })
}

fn check(scene: &str) {
    let input = golden(&format!("{scene}.input.json"));
    let want = golden(&format!("{scene}.json"));
    let got = computed(&input);

    assert_eq!(got["mode"], want["mode"], "{scene}: mode");
    assert_eq!(got["placement"], want["placement"], "{scene}: placement");
    let view = &got["view"];
    assert_eq!(view["mode"], want["mode"], "{scene}: the view's mode");
    for field in ["needs", "next", "laneEntries"] {
        assert_eq!(view[field], want[field], "{scene}: {field}");
    }
    let headers = want["laneHeaders"].as_object().unwrap();
    assert_eq!(headers.len(), LANES.len(), "{scene}: one header per lane");
    for (lane, header) in headers {
        for field in ["collapsed", "workspaces", "mergeReady"] {
            assert_eq!(
                view["laneHeaders"][lane][field], header[field],
                "{scene}: laneHeaders.{lane}.{field}"
            );
        }
    }
}

#[test]
fn lanes_scene_matches_the_golden_model() {
    check("lanes");
}

#[test]
fn needs_and_next_scene_matches_the_golden_model() {
    check("needs-and-next");
}

#[test]
fn projects_scene_matches_the_golden_model() {
    check("projects");
}

#[test]
fn review_verdicts_scene_matches_the_golden_model() {
    check("review-verdicts");
}
