//! The Crux app the shells drive: it takes cmux's data, the saved state and
//! the project table as events, and hands back the All view's model: Next,
//! Needs you and the lanes. No effects beyond asking for a render yet; the
//! session's requests to cmux and the state handler wait in its outbox.

use std::collections::BTreeMap;

use crux_core::{
    App, Command,
    macros::effect,
    render::{RenderOperation, render},
};
use serde::Serialize;

use crate::data::{Data, Workspace};
use crate::lane_entries::LaneEntry;
use crate::lanes::{LANES, LaneKey};
use crate::persist::SavedState;
use crate::projects::Project;
use crate::session::Session;

/// What the shell can tell the core.
#[derive(Debug)]
pub enum Event {
    /// A new frame of cmux data.
    Data(Data),
    /// A new config/state.json. The session is seeded from it afresh, as
    /// a reload seeds the sidebar, so local overrides start over.
    State(Box<SavedState>),
    /// A new project table, seeded the same way.
    Projects(Vec<Project>),
    /// Asks the shell to draw the current view again.
    Refresh,
}

/// Everything the core knows: the session, the latest frame, and the view
/// built from them. The view is built in `update`, since reading the
/// session tidies it and `view` only borrows the model.
#[derive(Debug, Default)]
pub struct Model {
    pub session: Session,
    pub data: Option<Data>,
    pub view: ViewModel,
}

/// The Needs you strip as the shell draws it, workspaces by id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsView {
    pub list: Vec<String>,
    pub shown: Vec<String>,
    pub in_strip: Vec<String>,
    pub more: usize,
    pub wait_text: String,
    pub late: bool,
}

/// Where the next press of Next goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepView {
    pub target: String,
    pub position: usize,
    pub total: usize,
}

/// The Next button: its queue and where the next press goes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct NextView {
    pub queue: Vec<String>,
    pub step: Option<StepView>,
}

/// A lane header: folded or not, the cards it counts, its merge line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneHeaderView {
    pub collapsed: bool,
    pub workspaces: Vec<String>,
    pub merge_ready: String,
}

/// What the shell draws: the All view.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewModel {
    pub mode: String,
    pub needs: NeedsView,
    pub next: NextView,
    pub lane_entries: Vec<LaneEntry>,
    pub lane_headers: BTreeMap<LaneKey, LaneHeaderView>,
}

/// What the core can ask the shell to do.
#[effect]
pub enum Effect {
    Render(RenderOperation),
}

/// The cockpit app.
#[derive(Debug, Default)]
pub struct Cockpit;

fn ids(list: &[&Workspace]) -> Vec<String> {
    list.iter().map(|w| w.id.clone()).collect()
}

/// The All view for a frame.
pub fn build_view(s: &mut Session, data: &Data) -> ViewModel {
    let strip = s.needs(data);
    let needs = NeedsView {
        list: ids(&strip.list),
        shown: ids(&strip.shown),
        in_strip: strip.in_strip.iter().cloned().collect(),
        more: strip.more,
        wait_text: strip.wait_text,
        late: strip.late,
    };
    let queue = ids(&s.next_queue(data));
    let step = s.next_step(data).map(|st| StepView {
        target: st.target.id.clone(),
        position: st.position,
        total: st.total,
    });
    let lane_entries = s.lane_entries(data);
    let mut lane_headers = BTreeMap::new();
    for lane in &LANES {
        let header = LaneHeaderView {
            collapsed: s.is_collapsed(data, lane),
            workspaces: ids(&s.lane_workspaces(data, lane.key)),
            merge_ready: s.merge_ready_text(data, lane.key),
        };
        lane_headers.insert(lane.key, header);
    }
    ViewModel {
        mode: s.mode().as_str().to_string(),
        needs,
        next: NextView { queue, step },
        lane_entries,
        lane_headers,
    }
}

impl Model {
    fn rebuild(&mut self) {
        self.view = match &self.data {
            Some(data) => build_view(&mut self.session, data),
            None => ViewModel {
                mode: self.session.mode().as_str().to_string(),
                ..ViewModel::default()
            },
        };
    }
}

impl App for Cockpit {
    type Event = Event;
    type Model = Model;
    type ViewModel = ViewModel;
    type Effect = Effect;

    fn update(&self, event: Event, model: &mut Model) -> Command<Effect, Event> {
        match event {
            Event::Data(data) => model.data = Some(data),
            Event::State(saved) => {
                let projects = std::mem::take(&mut model.session.projects);
                model.session = Session::new(projects, *saved);
            }
            Event::Projects(projects) => {
                let saved = std::mem::take(&mut model.session.saved);
                model.session = Session::new(projects, saved);
            }
            Event::Refresh => {}
        }
        model.rebuild();
        render()
    }

    fn view(&self, model: &Model) -> ViewModel {
        model.view.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::ViewMode;

    #[test]
    fn refresh_asks_the_shell_to_render() {
        let app = Cockpit;
        let mut model = Model::default();
        let mut cmd = app.update(Event::Refresh, &mut model);

        let effects: Vec<Effect> = cmd.effects().collect();
        assert!(matches!(effects.as_slice(), [Effect::Render(_)]));
        assert_eq!(app.view(&model).mode, ViewMode::All.as_str());
    }

    #[test]
    fn keeps_the_saved_state_when_the_project_table_changes() {
        let app = Cockpit;
        let mut model = Model::default();
        let saved = SavedState::from_json(r#"{"ui": {"mode": "projects"}}"#).unwrap();
        let _ = app.update(Event::State(Box::new(saved)), &mut model);
        let _ = app.update(Event::Projects(Vec::new()), &mut model);
        assert_eq!(app.view(&model).mode, "projects");
    }
}
