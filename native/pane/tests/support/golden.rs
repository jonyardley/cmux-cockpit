//! Loads a cockpit scene from test/golden/ and feeds it through the core as
//! a shell would: the project table, the saved state, then cmux's data.
//! Shared by the tests and examples/scene.rs, so it returns errors rather
//! than unwrapping.

use std::error::Error;
use std::path::PathBuf;

use cockpit_core::{Cockpit, Data, Event, Model, Project, SavedState};
use crux_core::App;
use serde_json::Value;

/// The scenes with golden files, in the README's order.
pub const SCENES: [&str; 4] = ["lanes", "needs-and-next", "projects", "review-verdicts"];

/// The core's model after a scene's input went in as events.
pub fn scene_model(scene: &str) -> Result<Model, Box<dyn Error>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../test/golden/{scene}.input.json"));
    let input: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let projects: Vec<Project> = serde_json::from_value(input["projects"].clone())?;
    let saved: SavedState = serde_json::from_value(input["state"].clone())?;
    let data: Data = serde_json::from_value(input["data"].clone())?;

    let app = Cockpit;
    let mut model = Model::default();
    for event in [
        Event::Projects(projects),
        Event::State(Box::new(saved)),
        Event::Data(data),
    ] {
        // The only effect is a render, which a test or demo draws itself.
        let _render = app.update(event, &mut model);
    }
    Ok(model)
}
