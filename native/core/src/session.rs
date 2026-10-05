//! Everything the core holds between frames: what the build baked in (the
//! project table, the saved state), the optimistic local state the
//! TypeScript keeps in module-level maps, and the requests it has made of
//! cmux and the state handler since they were last taken.
//!
//! The TypeScript reads some of these maps during render and tidies them as
//! it goes (an override the data has caught up with is dropped), so the
//! reads here take `&mut self` where theirs do. The data itself is passed
//! in on each call, never held.

use std::collections::{BTreeMap, HashMap};

use indexmap::IndexMap;
use serde_json::Value;

use crate::lanes::{LANES, LaneKey};
use crate::persist::{SavedState, ViewMode, persist_url};
use crate::projects::{Project, is_project_key};
use crate::state::DragState;
use crate::status::Status;
use crate::text::PromptMemory;

/// A value in a cmux request's parameters.
#[derive(Debug, Clone, PartialEq)]
pub enum Param {
    Str(String),
    Num(f64),
    Bool(bool),
}

/// Something the core asks of the world outside it.
#[derive(Debug, Clone, PartialEq)]
pub enum Outbound {
    /// A cmux socket command, as `cmux(method, params)`, params in the
    /// order the TypeScript writes them.
    Cmux {
        method: String,
        params: Vec<(String, Param)>,
    },
    /// One entry set (or, with no value, deleted) in config/state.json, as `persistSet`.
    Persist { key: String, value: Option<Value> },
}

impl Outbound {
    /// A persist request as the URL the handler reads; None for a cmux one.
    pub fn persist_url(&self, token: &str) -> Option<String> {
        match self {
            Outbound::Persist { key, value } => Some(persist_url(key, value.as_ref(), token)),
            Outbound::Cmux { .. } => None,
        }
    }
}

/// A lane move cmux has not reflected yet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LaneMove {
    pub lane: LaneKey,
    pub at: f64,
    /// The lane's group is being made, so the move waits for it.
    pub awaiting: bool,
    /// For a move made in the pane: the lane cmux had the card in when it
    /// was moved. Such a move has no timer; it holds until cmux's data no
    /// longer shows the card there (so it agrees, or cmux put it somewhere
    /// else itself). A wait on a lane's group still lapses after
    /// CREATE_SECS. None for the sidebar's own moves, which lapse after
    /// OVERRIDE_SECS as the TypeScript's do.
    pub held_from: Option<LaneKey>,
}

/// A reorder cmux has not reflected yet: every workspace id in the order
/// wanted, and when it was asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct OrderMove {
    pub ids: Vec<String>,
    pub at: f64,
    /// For a move made in the pane: cmux's tab order when it was moved. It
    /// holds until cmux's order of those workspaces is no longer that one,
    /// with no timer, as `LaneMove::held_from` does.
    pub held_base: Option<Vec<String>>,
}

/// The workspace Next last opened: its id, its place in the queue then,
/// and the one that followed it.
#[derive(Debug, Clone, PartialEq)]
pub struct LastJump {
    pub id: String,
    pub index: usize,
    pub after_id: Option<String>,
}

/// The core's state between frames.
#[derive(Debug, Clone, Default)]
pub struct Session {
    /// The project table the build bakes in (`__PROJECTS__`).
    pub projects: Vec<Project>,
    /// config/state.json as the build read it (`__STATE__`).
    pub saved: SavedState,
    pub(crate) outbox: Vec<Outbound>,

    // shared/needs.ts: wsId to agent id to the start of a dismissed spell.
    pub(crate) dismissed: IndexMap<String, IndexMap<String, f64>>,
    // shared/text.ts: the last prompt Jon typed in each workspace.
    pub(crate) prompts: PromptMemory,
    // cockpit/by-project.ts: wsId to the project key chosen by Move to project.
    pub(crate) project_override: IndexMap<String, String>,

    // cockpit/state.ts: the view, the local folds and the selection.
    pub(crate) mode: ViewMode,
    pub(crate) unsorted_collapsed: bool,
    pub(crate) quiet_collapsed: bool,
    pub(crate) collapsed_projects: Vec<String>,
    pub(crate) select_override: Option<(String, f64)>,
    pub(crate) drag: Option<DragState>,

    // cockpit/strip.ts: a card dismissed from Needs you, held at the top of
    // its lane until its status moves on from the one it was dismissed in.
    pub(crate) dismissed_hold: HashMap<String, Status>,

    // cockpit/lane-entries.ts: the rank each card last had while not
    // selected, so an opened card keeps its place until Jon moves on.
    pub(crate) held_rank: HashMap<String, u8>,

    // cockpit/next.ts: the last workspace Next opened, and what followed it.
    pub(crate) last_jump: Option<LastJump>,

    // cockpit/model.ts: optimistic lane moves, order and folds.
    pub(crate) lane_override: IndexMap<String, LaneMove>,
    pub(crate) order_override: Option<OrderMove>,
    pub(crate) collapse_override: IndexMap<String, bool>,
    pub(crate) touched_lanes: Vec<LaneKey>,
}

impl Session {
    /// A session seeded from what the build bakes in, as each module seeds
    /// itself from `__STATE__` at load.
    pub fn new(projects: Vec<Project>, saved: SavedState) -> Session {
        let dismissed = saved
            .dismissed
            .iter()
            .map(|(ws, starts)| {
                let starts = starts.iter().map(|(a, s)| (a.clone(), *s)).collect();
                (ws.clone(), starts)
            })
            .collect();
        let project_override = saved
            .project_override
            .iter()
            .filter(|(_, key)| is_project_key(&projects, key))
            .map(|(ws, key)| (ws.clone(), key.clone()))
            .collect();
        let folds: &BTreeMap<String, f64> = &saved.ui.collapsed;
        let folded = |k: &str| folds.get(k) == Some(&1.0);
        let collapsed_projects = folds
            .iter()
            .filter(|(_, flag)| **flag == 1.0)
            .filter_map(|(k, _)| k.strip_prefix(PROJECT_FOLD).map(str::to_string))
            .collect();
        let touched_lanes = LANES
            .iter()
            .filter(|l| folds.contains_key(&format!("lane:{}", l.key.as_str())))
            .map(|l| l.key)
            .collect();
        Session {
            mode: saved.ui.mode.unwrap_or_default(),
            unsorted_collapsed: folded("lane:unsorted"),
            quiet_collapsed: folded("quiet"),
            collapsed_projects,
            touched_lanes,
            dismissed,
            project_override,
            projects,
            saved,
            ..Session::default()
        }
    }

    /// Takes over the optimistic placement and selection of an earlier
    /// session, so a card moved or tapped a moment ago stays put when a new
    /// state file reseeds the session: lane, order and selection all live
    /// in cmux's data, not in the file.
    pub fn keep_overrides_of(&mut self, earlier: &mut Session) {
        self.lane_override = std::mem::take(&mut earlier.lane_override);
        self.order_override = earlier.order_override.take();
        self.select_override = earlier.select_override.take();
    }

    /// Every request made since the last call, oldest first.
    pub fn take_outbox(&mut self) -> Vec<Outbound> {
        std::mem::take(&mut self.outbox)
    }

    /// Puts requests taken earlier back at the front of the outbox, oldest first.
    pub fn requeue(&mut self, mut earlier: Vec<Outbound>) {
        earlier.append(&mut self.outbox);
        self.outbox = earlier;
    }

    /// Swaps in a new project table, keeping everything else. A Move to
    /// project override naming a key the table no longer has is dropped,
    /// as the seed drops it.
    pub fn set_projects(&mut self, projects: Vec<Project>) {
        self.project_override
            .retain(|_, key| is_project_key(&projects, key));
        self.projects = projects;
    }

    /// The requests made so far, without taking them.
    pub fn outbox(&self) -> &[Outbound] {
        &self.outbox
    }

    pub(crate) fn cmux(&mut self, method: &str, params: Vec<(&str, Param)>) {
        self.outbox.push(Outbound::Cmux {
            method: method.to_string(),
            params: params
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        });
    }

    pub(crate) fn persist_set(&mut self, key: String, value: Option<Value>) {
        self.outbox.push(Outbound::Persist { key, value });
    }
}

/// The prefix of a project's fold key.
pub(crate) const PROJECT_FOLD: &str = "project:";
