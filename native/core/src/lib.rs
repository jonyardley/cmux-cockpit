//! The cockpit's shared core: the sidebar logic ported from TypeScript, and
//! the Crux app the shells drive (app.rs). So far the cockpit's lanes and
//! placement (model.rs), what an agent's status means (status.rs), the
//! Needs you strip (strip.rs), All's rows (lane_entries.rs) and Next
//! (next.rs), drops and the pane's card moves (placement.rs), with the
//! shared helpers they need. Session holds the state
//! between frames; each call takes the frame's cmux data.

pub mod activity;
pub mod anchors;
pub mod app;
pub mod data;
pub mod hooks;
pub mod js;
pub mod lane_entries;
pub mod lanes;
pub mod lenient;
pub mod model;
pub mod moves;
pub mod needs;
pub mod next;
pub mod persist;
pub mod placement;
pub mod projects;
pub mod prs;
pub mod quiet;
pub mod saved;
pub mod session;
pub mod shells;
pub mod state;
pub mod status;
pub mod strip;
pub mod subagents;
pub mod text;
pub mod theme;
pub mod time;
pub mod ui;
pub mod words;

pub use app::{CmuxCall, Cockpit, Effect, Event, Model, StateSet, ViewModel};
