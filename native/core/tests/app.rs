//! The Crux app, driven as a shell would: each cockpit scene's input goes
//! in as events (the project table, the saved state, then cmux's data), and
//! the view model that comes back matches the scene's golden JSON
//! (test/golden/README.md) for the All view: the mode, Needs you, Next,
//! All's rows and every lane header.

#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::data::Data;
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use cockpit_core::{Cockpit, Effect, Event, Model};
use crux_core::App;
use serde_json::{Value, json};

fn golden(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../test/golden/{name}"));
    let text = std::fs::read_to_string(&path).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// Sends one event and checks the app asks for a render.
fn send(app: &Cockpit, model: &mut Model, event: Event) {
    let mut cmd = app.update(event, model);
    let effects: Vec<Effect> = cmd.effects().collect();
    assert!(matches!(effects.as_slice(), [Effect::Render(_)]));
}

/// The TypeScript model with R4.5's one deliberate difference taken out
/// (issue #281): the JS cockpit, being retired, still lifts waiting cards
/// into a strip and leaves a placeholder; the core keeps each card in its
/// place. So each placeholder reads as its card in the same spot, and
/// Needs you keeps only its list and clock. A short copy of the helper in
/// golden.rs, which also maps the Projects entries.
fn without_the_strip(mut want: Value) -> Value {
    if let Some(entries) = want["laneEntries"].as_array_mut() {
        for e in entries.iter_mut().filter(|e| e["kind"] == "ghost") {
            e["kind"] = json!("ws");
            e["id"] = json!(format!("w:{}", e["wsId"].as_str().unwrap_or_default()));
        }
    }
    if let Some(needs) = want["needs"].as_object_mut() {
        needs.retain(|k, _| ["list", "waitText", "late"].contains(&k.as_str()));
    }
    want
}

fn check(scene: &str) {
    let input = golden(&format!("{scene}.input.json"));
    let want = without_the_strip(golden(&format!("{scene}.json")));

    let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
    let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
    let data: Data = serde_json::from_value(input["data"].clone()).unwrap();

    let app = Cockpit;
    let mut model = Model::default();
    send(&app, &mut model, Event::Projects(projects));
    send(&app, &mut model, Event::State(Box::new(saved)));
    send(&app, &mut model, Event::Data(data));
    let got = serde_json::to_value(app.view(&model)).unwrap();

    for field in ["mode", "needs", "next", "laneEntries", "laneHeaders"] {
        assert_eq!(got[field], want[field], "{scene}: {field}");
    }
}

#[test]
fn lanes_scene_gives_the_golden_view_model() {
    check("lanes");
}

#[test]
fn needs_and_next_scene_gives_the_golden_view_model() {
    check("needs-and-next");
}

#[test]
fn projects_scene_gives_the_golden_view_model() {
    check("projects");
}

#[test]
fn review_verdicts_scene_gives_the_golden_view_model() {
    check("review-verdicts");
}
