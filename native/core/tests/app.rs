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
use serde_json::Value;

mod common;
use common::without_the_strip;

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
