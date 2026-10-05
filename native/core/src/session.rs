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
use crate::persist::{ProjectSpec, SavedState, ViewMode, persist_url};
use crate::pr_poll::PrPoll;
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
    /// For a move made in the pane: the lanes cmux may still show the card
    /// in while the move is on its way (where it was, and any lane an
    /// earlier move still in flight sent it to). Such a move has no timer;
    /// it holds until cmux's data shows it in its lane, or somewhere none
    /// of these (cmux's own answer), or a request for it failed. A wait on
    /// a lane's group still lapses after CREATE_SECS. None for the
    /// sidebar's own moves, which lapse after OVERRIDE_SECS as the
    /// TypeScript's do.
    pub held_from: Option<LaneSet>,
}

/// A set of lanes, small enough to copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LaneSet(u8);

impl LaneSet {
    fn bit(k: LaneKey) -> u8 {
        LANES.iter().position(|l| l.key == k).map_or(0, |i| 1 << i)
    }

    /// The set holding only `k`.
    pub fn of(k: LaneKey) -> LaneSet {
        LaneSet(Self::bit(k))
    }

    /// This set with `k` added.
    pub fn with(self, k: LaneKey) -> LaneSet {
        LaneSet(self.0 | Self::bit(k))
    }

    pub fn contains(self, k: LaneKey) -> bool {
        self.0 & Self::bit(k) != 0
    }
}

/// A reorder cmux has not reflected yet: every workspace id in the order
/// wanted, and when it was asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct OrderMove {
    pub ids: Vec<String>,
    pub at: f64,
    /// For a move made in the pane: the tab orders cmux may still show
    /// while the move is on its way (cmux's when it was made, and each
    /// order an earlier move still in flight asked for). It holds, with no
    /// timer, until cmux shows the order wanted, or one none of these, or
    /// a request for it failed. Empty for the sidebar's own reorders,
    /// which lapse after OVERRIDE_SECS.
    pub held_bases: Vec<Vec<String>>,
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
    /// State writes sent but not yet seen in a state file, oldest first,
    /// one per key: a new file has them made over it until it shows them.
    pub(crate) pending: Vec<(String, Option<Value>)>,

    // shared/needs.ts: wsId to agent id to the start of a dismissed spell.
    pub(crate) dismissed: IndexMap<String, IndexMap<String, f64>>,
    // shared/text.ts: the last prompt Jon typed in each workspace.
    pub(crate) prompts: PromptMemory,
    // cockpit/by-project.ts: wsId to the project key chosen by Move to project.
    pub(crate) project_override: IndexMap<String, String>,
    // cockpit/by-project.ts: the last spec sent for each project made or
    // edited here, None once removed, until a rebuild carries it.
    pub(crate) sent_specs: IndexMap<String, Option<ProjectSpec>>,
    // cockpit/state.ts: the project whose editor is open, or NEW_PROJECT.
    pub(crate) editing_project: Option<String>,
    /// The home folder (`__HOME__`), so a "~" root expands and the home
    /// folder itself is never offered as a project. None until the shell
    /// sets it.
    pub home: Option<String>,

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

    /// The pane's own PR poll and the answers it holds, made over
    /// `saved.prs` on every read; a new state file never resets it.
    pub pr_poll: PrPoll,
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

    /// Seeds again from a new state file, as a reload seeds the sidebar,
    /// but only what the file holds: the view, folds, dismissals and
    /// project choices. Everything held only in memory (optimistic moves,
    /// folds and selection, holds, ranks, Next's place, requests not yet
    /// taken) stays. A write sent but not in the file yet is made over it,
    /// so the pane's own writes never undo each other on the way, and an
    /// undated dismissal, which is never saved, stays for the session.
    pub fn reseed(&mut self, mut saved: SavedState) {
        self.pending
            .retain(|(key, value)| !saved.shows_entry(key, value.as_ref()));
        for (key, value) in &self.pending {
            saved.set_entry(key, value.as_ref());
        }
        let mut fresh = Session::new(std::mem::take(&mut self.projects), saved);
        for (ws, starts) in &self.dismissed {
            for (agent, start) in starts.iter().filter(|(_, s)| **s <= 0.0) {
                fresh
                    .dismissed
                    .entry(ws.clone())
                    .or_default()
                    .entry(agent.clone())
                    .or_insert(*start);
            }
        }
        self.projects = fresh.projects;
        self.saved = fresh.saved;
        self.dismissed = fresh.dismissed;
        self.project_override = fresh.project_override;
        self.mode = fresh.mode;
        self.unsorted_collapsed = fresh.unsorted_collapsed;
        self.quiet_collapsed = fresh.quiet_collapsed;
        self.collapsed_projects = fresh.collapsed_projects;
        self.touched_lanes = fresh.touched_lanes;
    }

    /// A request for this workspace failed in cmux: lets go of the pane's
    /// hold on it, so the card shows where cmux has it.
    pub fn request_failed(&mut self, ws_id: &str) {
        let held = |o: &LaneMove| o.held_from.is_some();
        if self.lane_override.get(ws_id).is_some_and(held) {
            self.lane_override.shift_remove(ws_id);
        }
        if self
            .order_override
            .as_ref()
            .is_some_and(|o| !o.held_bases.is_empty())
        {
            self.order_override = None;
        }
    }

    /// Every request made since the last call, oldest first.
    pub fn take_outbox(&mut self) -> Vec<Outbound> {
        std::mem::take(&mut self.outbox)
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
        self.pending.retain(|(k, _)| *k != key);
        self.pending.push((key.clone(), value.clone()));
        self.outbox.push(Outbound::Persist { key, value });
    }
}

/// The prefix of a project's fold key.
pub(crate) const PROJECT_FOLD: &str = "project:";
