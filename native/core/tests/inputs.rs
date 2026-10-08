//! The core's inputs written out as JSON read back as they were, so a
//! core fed from the helper's data.json gets what the helper's own core
//! got: cmux's data, the saved state and the project table, for every
//! golden scene and for a saved state with every entry filled.

// Not redundant: clippy lets a test unwrap only inside cfg(test).
#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::data::Data;
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn input(scene: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../test/golden/{scene}.input.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// Reads `raw`, writes it out, reads that back, and checks the two reads match.
fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(raw: &Value) -> T {
    let first: T = serde_json::from_value(raw.clone()).unwrap();
    let written = serde_json::to_value(&first).unwrap();
    let again: T = serde_json::from_value(written).unwrap();
    assert_eq!(again, first);
    first
}

#[test]
fn every_scenes_inputs_read_back_the_same() {
    for scene in ["lanes", "needs-and-next", "projects", "review-verdicts"] {
        let input = input(scene);
        let data: Data = round_trip(&input["data"]);
        assert!(!data.workspace_list().is_empty(), "{scene}");
        round_trip::<SavedState>(&input["state"]);
        let projects: Vec<Project> = round_trip(&input["projects"]);
        assert!(!projects.is_empty(), "{scene}");
    }
}

#[test]
fn a_state_with_every_entry_reads_back_the_same() {
    let raw = json!({
        "dismissed": {"w": {"a": 10}},
        "projectOverride": {"w": "cmux"},
        "projects": {
            "made": {"name": "Made", "color": "#D97757", "icon": "folder.fill", "root": "/r"},
            "gone": {"removed": true}
        },
        "prs": {"/r": {"number": 4, "url": "u", "status": "open", "branch": "b",
                       "draft": false, "checks": [{"name": "ci", "state": "pass"}]}},
        "ownPrs": {"x": {"any": 1}},
        "subagents": {"w": [{"id": "s", "session": "a", "type": "task", "label": "L",
                             "startedEpoch": 5, "endedEpoch": 6}]},
        "shells": {"w": [{"id": "sh", "session": "a", "startedEpoch": 5}]},
        "names": {"a": "Name"},
        "published": {"a": 1},
        "prOrigins": {"a": "o"},
        "asking": {"w": {"reason": "perm", "epoch": 9, "session": "a"}},
        "moves": {"w": {"text": "Do it", "epoch": 9, "decisions": 2, "leans": "1b 2a",
                        "idle": false}},
        "ui": {"mode": "projects", "collapsed": {"quiet": 1}},
        "poll": {"okEpoch": 3, "error": "gh down"}
    });
    let state: SavedState = round_trip(&raw);
    assert_eq!(state.projects.len(), 2);
    assert_eq!(state.subagents["w"][0].kind.as_deref(), Some("task"));
    let written = serde_json::to_value(&state).unwrap();
    assert_eq!(written["ui"]["mode"], "projects");
    assert_eq!(written["prs"]["/r"]["status"], "open");
    // Every entry was read, none dropped as not fitting, so the check above covers it.
    for (key, value) in raw.as_object().unwrap() {
        assert_eq!(
            written[key].as_object().map(|o| o.len()),
            value.as_object().map(|o| o.len()),
            "{key}"
        );
    }
}
