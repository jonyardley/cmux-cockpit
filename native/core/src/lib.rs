//! The cockpit's shared core. Empty for now: R1.1 sets up the workspace and
//! the gates, and later issues port the sidebar logic in here.

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
