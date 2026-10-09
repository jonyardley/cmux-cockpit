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

/// The lanes scene with a lane table of three of its groups, renamed in
/// place by id and reordered: the panel draws those lanes in that order,
/// Background's workspaces fall to Unsorted, and the card menu offers the
/// table's lanes.
#[test]
fn a_configured_lane_table_draws_its_lanes_in_its_order() {
    use cockpit_core::lanes::LaneConfig;
    use cockpit_core::menu::MenuEvent;
    use cockpit_core::panel::Panel;

    let input = golden("lanes.input.json");
    let lanes: Vec<LaneConfig> = serde_json::from_str(
        r#"[{"id": "parked", "name": "Parked"},
            {"name": "For review", "density": "full", "color": "laneMain"},
            {"id": "main", "name": "Main activity", "faint": true}]"#,
    )
    .unwrap();
    let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
    let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
    let data: Data = serde_json::from_value(input["data"].clone()).unwrap();
    let app = Cockpit;
    let mut model = Model::default();
    send(&app, &mut model, Event::Lanes(lanes));
    send(&app, &mut model, Event::Projects(projects));
    send(&app, &mut model, Event::State(Box::new(saved)));
    // For review has no id, so it is a lane new to the state file: its
    // name is saved once, as its group already goes by it (lane_rename.rs).
    // The built-in ids keep their built-in names, so nothing else is.
    let mut cmd = app.update(Event::Data(data), &mut model);
    let saves: Vec<(String, Option<Value>)> = cmd
        .effects()
        .filter_map(|e| match e {
            Effect::Persist(r) => Some((r.operation.key.clone(), r.operation.value.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        saves,
        [(
            "laneNames.For review".to_string(),
            Some(Value::from("For review"))
        )]
    );

    let panel = Panel::from_core(&mut model);
    let heads: Vec<(&str, &str, bool)> = panel
        .lanes
        .iter()
        .map(|l| (l.key.as_str(), l.name.as_str(), l.faint))
        .collect();
    assert_eq!(
        heads,
        [
            ("parked", "PARKED", true),
            ("For review", "FOR REVIEW", false),
            ("main", "MAIN ACTIVITY", true),
            ("unsorted", "UNSORTED", false),
        ]
    );
    let in_background: Vec<&str> = input["data"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|w| w["group"] == "g-bg")
        .filter_map(|w| w["id"].as_str())
        .collect();
    assert!(!in_background.is_empty());
    for id in in_background {
        let lane = panel.lane_of(id);
        assert_eq!(lane.as_ref().map(|k| k.as_str()), Some("unsorted"), "{id}");
    }

    // Parked starts folded, so the first card drawn is in For review.
    let id = panel.card_ids()[0].to_string();
    send(&app, &mut model, Event::Menu(MenuEvent::OpenCard { id }));
    let menu = Panel::from_core(&mut model).menu.unwrap();
    let lanes: Vec<&str> = menu
        .items
        .iter()
        .map(|i| i.label())
        .filter(|l| l.contains("Lane: "))
        .collect();
    assert_eq!(
        lanes,
        [
            "Lane: Parked",
            "✓ Lane: For review",
            "Lane: Main activity",
            "Lane: Unsorted"
        ]
    );
}
