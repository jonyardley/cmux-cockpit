//! The panel model for each scene, as JSON in native/fixtures/: the four
//! golden scenes as they load, then a card's menu open over lanes, and
//! the project editor open on a project and on a new one over projects.
//! A shell that draws the panel (the Swift one, across the bridge) can
//! test against these without the core.
//!
//! The test fails when a fixture is stale. Re-record them after a meant
//! change with `UPDATE_SNAPSHOTS=1 cargo test -p cockpit_core --test panel`,
//! then `npx biome format --write native/fixtures` from the repo root (the
//! check formats JSON as Biome does), and read the diff.

#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::data::Data;
use cockpit_core::panel::ProjectRow;
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use cockpit_core::{Cockpit, EditEvent, Event, MenuEvent, Model, Panel};
use crux_core::App;
use serde_json::Value;

/// The core's model after a golden scene's input went in as events, as
/// a shell feeds it: the project table, the saved state, then cmux's data.
fn loaded(scene: &str) -> Model {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../test/golden/{scene}.input.json"));
    let input: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
    let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
    let data: Data = serde_json::from_value(input["data"].clone()).unwrap();
    let mut model = Model::default();
    for event in [
        Event::Projects(projects),
        Event::State(Box::new(saved)),
        Event::Data(data),
    ] {
        send(&mut model, event);
    }
    model
}

fn send(model: &mut Model, event: Event) {
    // The only effects are renders and writes, which no fixture needs.
    let _effects = Cockpit.update(event, model);
}

/// The first project's key in the Projects rows.
fn first_project(panel: &Panel) -> String {
    panel
        .projects
        .iter()
        .find_map(|r| match r {
            ProjectRow::Header(h) => Some(h.key.clone()),
            _ => None,
        })
        .unwrap()
}

/// Each fixture's name and the panel it holds.
fn scenes() -> Vec<(&'static str, Panel)> {
    let mut out = Vec::new();
    for scene in ["lanes", "needs-and-next", "projects", "review-verdicts"] {
        let mut model = loaded(scene);
        out.push((scene, Panel::from_core(&mut model)));
    }

    let mut model = loaded("lanes");
    let id = Panel::from_core(&mut model).card_ids()[0].to_string();
    send(&mut model, Event::Menu(MenuEvent::OpenCard { id }));
    out.push(("card-menu", Panel::from_core(&mut model)));

    let mut model = loaded("projects");
    let key = first_project(&Panel::from_core(&mut model));
    send(&mut model, Event::Edit(EditEvent::Open { key }));
    out.push(("editor", Panel::from_core(&mut model)));

    let mut model = loaded("projects");
    send(&mut model, Event::Edit(EditEvent::OpenNew));
    out.push(("new-project", Panel::from_core(&mut model)));
    out
}

#[test]
fn each_scenes_panel_matches_its_fixture() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    let update = std::env::var_os("UPDATE_SNAPSHOTS").is_some();
    let mut stale = Vec::new();
    for (name, panel) in scenes() {
        let got = serde_json::to_string_pretty(&panel).unwrap() + "\n";
        let path = dir.join(format!("{name}.json"));
        if update {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, &got).unwrap();
            continue;
        }
        // By value, not text: Biome formats the files after they are written.
        let want: Option<Value> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
        if want != Some(serde_json::to_value(&panel).unwrap()) {
            stale.push(name);
        }
    }
    assert!(
        stale.is_empty(),
        "stale panel fixtures {stale:?}: re-record as this file's head says"
    );
}

#[test]
fn every_fixture_has_a_scene() {
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        return; // Re-recording: the folder may not be written yet.
    }
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    let names: Vec<String> = scenes().iter().map(|(n, _)| format!("{n}.json")).collect();
    assert_eq!(names.len(), 7);
    for entry in std::fs::read_dir(&dir).unwrap() {
        let file = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(names.contains(&file), "{file} has no scene behind it");
    }
}

#[test]
fn opens_the_menu_and_the_editors_the_fixtures_name() {
    let s = scenes();
    let panel = |n: &str| &s.iter().find(|(name, _)| *name == n).unwrap().1;
    assert!(panel("lanes").menu.is_none());
    assert!(panel("card-menu").menu.is_some());
    let editor = panel("editor").editor().unwrap();
    assert!(!editor.is_new);
    assert!(panel("new-project").editor().unwrap().is_new);
}
