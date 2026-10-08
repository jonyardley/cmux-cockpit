//! The golden scenes (test/golden/) as tests and demos load them: one copy
//! for core/tests/panel.rs, the pane's tests and scene example, and the
//! runner's publish tests. Test support in shape, kept in the library so
//! the other crates can reach it; no shell calls it. It reads files, so it
//! returns errors rather than unwrapping.

use std::error::Error;
use std::path::PathBuf;

use crux_core::App;
use serde_json::Value;

use crate::home::expand_home;
use crate::{Cockpit, Data, Event, Model, Project, SavedState};

/// The home folder every fixture loads with: not a card's own folder, so a
/// card outside it offers Make project, the one action chip.
pub const FIXTURE_HOME: &str = "/Users/jon";

/// A golden scene's input: the project table, the saved state and cmux's data.
pub struct Scene {
    pub projects: Vec<Project>,
    pub saved: SavedState,
    pub data: Data,
}

/// A golden scene's input, each "~" root expanded against `home` as the
/// runner expands them (Feed::projects); with None the roots stay as typed.
pub fn scene(name: &str, home: Option<&str>) -> Result<Scene, Box<dyn Error>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../test/golden/{name}.input.json"));
    let input: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let mut projects: Vec<Project> = serde_json::from_value(input["projects"].clone())?;
    for p in &mut projects {
        p.root = p.root.take().map(|r| expand_home(&r, home).unwrap_or(r));
    }
    Ok(Scene {
        projects,
        saved: serde_json::from_value(input["state"].clone())?,
        data: serde_json::from_value(input["data"].clone())?,
    })
}

/// The core's model after a scene went in as a shell feeds it, at
/// `FIXTURE_HOME`: the project table, the saved state, the home, then
/// cmux's data.
pub fn scene_model(name: &str) -> Result<Model, Box<dyn Error>> {
    let Scene {
        projects,
        saved,
        data,
    } = scene(name, Some(FIXTURE_HOME))?;
    let mut model = Model::default();
    for event in [
        Event::Projects(projects),
        Event::State(Box::new(saved)),
        Event::Home {
            home: Some(FIXTURE_HOME.to_string()),
        },
        Event::Data(data),
    ] {
        // The only effects are renders and writes, which a fixture draws or
        // ignores itself.
        let _effects = Cockpit.update(event, &mut model);
    }
    Ok(model)
}
