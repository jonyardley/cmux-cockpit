//! A golden scene's input through the bridge as the Swift sidebar sends it
//! (mac/Sidebar/Live/InProcessCore.swift): the panel comes back, and a
//! fold click redraws it. Its own process, so its own core.

#![cfg(test)]

use cockpit_ffi::{update, view};
use serde_json::{Value, json};

fn send(event: Value) {
    update(event.to_string().as_bytes()).unwrap();
}

fn lane(key: &str) -> Value {
    let v: Value = serde_json::from_slice(&view().unwrap()).unwrap();
    let lanes = v["panel"]["lanes"].as_array().cloned().unwrap();
    lanes.into_iter().find(|l| l["key"] == key).unwrap()
}

#[test]
fn a_golden_scene_draws_and_folds_from_the_core_in_process() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/golden/lanes.input.json"
    );
    let input: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    send(json!("PanelOn"));
    send(json!({ "Projects": input["projects"] }));
    send(json!({ "State": input["state"] }));
    send(json!({ "Data": input["data"] }));
    assert_eq!(lane("main")["collapsed"], false);
    assert!(lane("main")["count"].as_u64().is_some_and(|n| n > 0));

    let now = input["data"]["epoch"].as_f64().unwrap() + 1.0;
    send(json!({ "At": { "now": now, "event": { "ToggleLane": { "lane": "main" } } } }));
    assert_eq!(lane("main")["collapsed"], true);
}
