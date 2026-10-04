//! The cockpit's shared core: the sidebar logic ported from TypeScript, and
//! the Crux app the shells drive. So far the cockpit's lanes and placement
//! (model.rs) and what an agent's status means (status.rs), with the shared
//! helpers they need. Session holds the state between frames; each call
//! takes the frame's cmux data.

pub mod activity;
pub mod anchors;
pub mod data;
pub mod js;
pub mod lanes;
pub mod model;
pub mod moves;
pub mod needs;
pub mod persist;
pub mod projects;
pub mod quiet;
pub mod saved;
pub mod session;
pub mod shells;
pub mod state;
pub mod status;
pub mod subagents;
pub mod text;
pub mod theme;
pub mod time;
pub mod ui;
pub mod words;

use crux_core::{
    App, Command,
    macros::effect,
    render::{RenderOperation, render},
};

/// What the shell can tell the core.
#[derive(Debug)]
pub enum Event {
    /// Asks the shell to draw the current view again.
    Refresh,
}

/// Everything the core knows. Nothing yet.
#[derive(Debug, Default)]
pub struct Model;

/// What the shell draws. Nothing yet.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ViewModel;

/// What the core can ask the shell to do.
#[effect]
pub enum Effect {
    Render(RenderOperation),
}

/// The cockpit app.
#[derive(Debug, Default)]
pub struct Cockpit;

impl App for Cockpit {
    type Event = Event;
    type Model = Model;
    type ViewModel = ViewModel;
    type Effect = Effect;

    fn update(&self, event: Event, _model: &mut Model) -> Command<Effect, Event> {
        match event {
            Event::Refresh => render(),
        }
    }

    fn view(&self, _model: &Model) -> ViewModel {
        ViewModel
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_asks_the_shell_to_render() {
        let app = Cockpit;
        let mut model = Model;
        let mut cmd = app.update(Event::Refresh, &mut model);

        let effects: Vec<Effect> = cmd.effects().collect();
        assert!(matches!(effects.as_slice(), [Effect::Render(_)]));
        assert_eq!(app.view(&model), ViewModel);
    }
}
