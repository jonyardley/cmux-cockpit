//! The golden scenes the pane's tests and examples/scene.rs draw, loaded
//! through the core as a shell would feed them (cockpit_core::fixture).

pub use cockpit_core::fixture::scene_model;

/// The scenes with golden files, in the README's order.
pub const SCENES: [&str; 4] = ["lanes", "needs-and-next", "projects", "review-verdicts"];
