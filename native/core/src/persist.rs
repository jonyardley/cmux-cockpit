//! The saved half of the local state loop (src/shared/persist.ts and the
//! contract in scripts/state-config.ts): config/state.json as it stands,
//! read unchanged, and the one-entry writes the sidebar sends back.
//!
//! The build cleans the file before baking it in, so most entries arrive
//! valid. A malformed entry in a map, or a field of the wrong type, is
//! still dropped on its own rather than failing the whole file, as the
//! TypeScript reader drops it (lenient.rs).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::data::PrStatus;
use crate::js::{encode_uri_component, utf16_len};
use crate::pr_colors::PrTone;
use crate::prs::PrHealth;
use crate::saved::Stamped;
use crate::text::js_space;

/// The cockpit's view: "all" (lanes) or "projects".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    #[default]
    All,
    Projects,
}

impl ViewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewMode::All => "all",
            ViewMode::Projects => "projects",
        }
    }
}

/// The cockpit's own view state, so a rebuild's reload keeps it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct UiState {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub mode: Option<ViewMode>,
    /// "lane:<key>", "project:<key>" or "quiet" to 1 folded, 0 unfolded.
    #[serde(deserialize_with = "crate::lenient::map")]
    pub collapsed: BTreeMap<String, f64>,
    /// The All view's project filter: a project's key, or "other" for the
    /// cards with no project (filter.rs); none while every card shows.
    #[serde(
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub filter: Option<String>,
}

/// A project made or edited in the sidebar.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ProjectSpec {
    pub name: String,
    pub color: String,
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// A saved project: a spec, or a projects.json project removed in the sidebar.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SavedProject {
    Spec(ProjectSpec),
    Removed { removed: bool },
}

/// A check run's queue time as gh's answer is read when GitHub gives
/// none: queued for a runner, time unknown. The poll replaces it with when
/// it first saw the run waiting (pr_poll.rs `stamp_queued`) before it
/// keeps the answer, so it is never saved.
pub const UNTIMED: f64 = 0.0;

/// One CI check as the poller saves it: its name, its state ("pass",
/// "fail" or "pending"), and, so the core can time a check that hangs
/// (prs.rs `stuck`), when it was queued and when it started, in
/// epoch seconds. A state file from before the times were kept reads
/// with none.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct SavedCheck {
    pub name: String,
    pub state: String,
    /// When a check still waiting for a runner was queued: GitHub's own
    /// time when it gives one, else when the poll first saw it waiting
    /// (pr_poll.rs). None once it has started, and for a run held at a
    /// gate (an approval, a concurrency group), which never reads stuck.
    /// `UNTIMED` only between gh's answer and the poll's stamp.
    #[serde(
        default,
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub queued: Option<f64>,
    /// When a running or finished check started (gh's `startedAt`).
    #[serde(
        default,
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub started: Option<f64>,
}

/// A pull request as the poller saves it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedPr {
    pub number: f64,
    pub url: String,
    /// Read as cmux's own PR status is, an unknown word as Unknown.
    pub status: PrStatus,
    pub branch: String,
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub mergeable: Option<bool>,
    #[serde(default)]
    pub conflicts: Option<bool>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub additions: Option<f64>,
    #[serde(default)]
    pub deletions: Option<f64>,
    #[serde(default)]
    pub checks: Option<Vec<SavedCheck>>,
    /// While GitHub would merge it (prs.rs `health_of` reads Ready), when
    /// the poll first saw it so, in epoch seconds (pr_poll.rs
    /// `stamp_ready`): carried from answer to answer and, through the
    /// state file, across a restart, so the core can tell a change left
    /// merge-ready four hours (issue #380). Kept while only GitHub's merge
    /// verdict is unsure; None once the PR itself changes, so a later
    /// return to ready starts a fresh time.
    #[serde(
        default,
        rename = "readySince",
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub ready_since: Option<f64>,
    /// The chip's health and the words' tone as the poll last worked them
    /// out (pr_poll.rs `stamp_look`), so the agents panel reads the core's
    /// answer rather than its own copy of the rule (#426). Never stuck,
    /// which needs the clock. An unknown word reads as none.
    #[serde(
        default,
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub health: Option<PrHealth>,
    #[serde(
        default,
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub tone: Option<PrTone>,
}

/// A subagent run as the hook saves it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSubagent {
    pub id: String,
    pub session: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    pub label: String,
    pub started_epoch: f64,
    #[serde(default)]
    pub ended_epoch: Option<f64>,
}

/// What kind of background work a task is (state-config.ts's TASK_TYPES):
/// Claude Code's own labels for a `background_tasks` entry, `session` for
/// a `claude --bg` session, and `other` for any word Claude Code adds
/// later, so a new kind is kept rather than dropping its entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum TaskType {
    #[serde(rename = "shell")]
    Shell,
    #[serde(rename = "subagent")]
    Subagent,
    #[serde(rename = "monitor")]
    Monitor,
    #[serde(rename = "workflow")]
    Workflow,
    #[serde(rename = "teammate")]
    Teammate,
    #[serde(rename = "cloud session")]
    CloudSession,
    #[serde(rename = "MCP task")]
    McpTask,
    #[serde(rename = "session")]
    Session,
    #[serde(rename = "other", other)]
    Other,
}

/// One piece of background work a chat has running, as
/// scripts/hooks/report-background.ts saves it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTask {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: TaskType,
    pub status: String,
    pub description: String,
    /// The chat session whose Stop or SubagentStop last listed it.
    pub session: String,
    /// The Claude process that listed it (CLAUDE_PID), which a /clear
    /// keeps; absent when the hook was given none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub started_epoch: f64,
    /// When a snapshot last listed it; the hook's prune and the core's age
    /// limit (`crate::running`) count from here.
    pub seen_epoch: f64,
}

/// Background tasks kept per workspace, the last listed kept (MAX_TASKS).
pub const MAX_TASKS: usize = 20;
/// The longest status word kept (MAX_STATUS).
pub const MAX_STATUS: usize = 32;
/// The longest description kept (MAX_LABEL).
pub(crate) const MAX_LABEL: usize = 120;

impl SavedTask {
    /// Every field within the bounds state-config.ts's savedTask holds it to.
    fn fits(&self) -> bool {
        let epoch = |e: f64| e.is_finite() && e >= 0.0;
        is_id(&self.id)
            && is_id(&self.session)
            && is_text(&self.status, MAX_STATUS)
            && is_text(&self.description, MAX_LABEL)
            && self.pid != Some(0)
            && epoch(self.started_epoch)
            && epoch(self.seen_epoch)
    }
}

/// The `background` map as validateState reads it: a task that does not
/// fit is dropped on its own, the last MAX_TASKS kept, and a workspace
/// left with none dropped.
fn tasks_map<'de, D>(d: D) -> Result<BTreeMap<String, Vec<SavedTask>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let lists: BTreeMap<String, Value> = crate::lenient::map(d)?;
    Ok(lists
        .into_iter()
        .filter(|(ws, _)| is_id(ws))
        .filter_map(|(ws, list)| {
            let Value::Array(items) = list else {
                return None;
            };
            let tasks: Vec<SavedTask> = items
                .into_iter()
                .filter_map(|v| serde_json::from_value::<SavedTask>(v).ok())
                .filter(SavedTask::fits)
                .collect();
            let skip = tasks.len().saturating_sub(MAX_TASKS);
            let kept: Vec<SavedTask> = tasks.into_iter().skip(skip).collect();
            (!kept.is_empty()).then_some((ws, kept))
        })
        .collect())
}

/// How many of one kind of background work a chat runs, in a saved verdict.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedCount {
    #[serde(rename = "type")]
    pub kind: TaskType,
    pub n: usize,
}

/// The core's background verdict for a workspace's card (#360), saved so
/// the agents panel, which reads only the file, says what the card says:
/// the chat it is about (the card's agent), when its earliest running
/// work started, and how many of each kind run, in the card's order. The
/// panel applies the card's rule on top: Running while that agent is idle.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedRunning {
    pub agent: String,
    pub since: f64,
    pub counts: Vec<SavedCount>,
}

/// The most kinds a saved verdict counts: one per task type (MAX_COUNTS).
pub const MAX_COUNTS: usize = 9;

impl SavedRunning {
    /// Every field within the bounds state-config.ts's savedRunning holds
    /// it to: an id, an epoch, and one to MAX_COUNTS counts of 1 to
    /// MAX_TASKS each. The core sends only a verdict that fits, so the
    /// script never refuses one and leaves it to be sent again.
    pub(crate) fn fits(&self) -> bool {
        is_id(&self.agent)
            && self.since.is_finite()
            && self.since >= 0.0
            && (1..=MAX_COUNTS).contains(&self.counts.len())
            && self.counts.iter().all(|c| (1..=MAX_TASKS).contains(&c.n))
    }
}

/// The `running` map as validateState reads it: an entry that does not
/// fit is dropped on its own.
fn running_map<'de, D>(d: D) -> Result<BTreeMap<String, SavedRunning>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, Value> = crate::lenient::map(d)?;
    Ok(entries
        .into_iter()
        .filter(|(ws, _)| is_id(ws))
        .filter_map(|(ws, v)| {
            let r = serde_json::from_value::<SavedRunning>(v).ok()?;
            r.fits().then_some((ws, r))
        })
        .collect())
}

/// The core's quiet verdict for a workspace's card (#425), saved so the
/// agents panel, which cannot see the session ids before a `/clear`,
/// reads quiet from the core's rule (quiet.rs) rather than its own: the
/// card's agent and when it last showed activity. The panel drops it
/// once that agent is not working or shows activity since.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedQuiet {
    pub agent: String,
    pub since: f64,
}

impl SavedQuiet {
    /// An id and an epoch, as state-config.ts's savedQuiet holds it. The
    /// core sends only a verdict that fits, so the script never refuses
    /// one and leaves it to be sent again.
    pub(crate) fn fits(&self) -> bool {
        is_id(&self.agent) && self.since.is_finite() && self.since >= 0.0
    }
}

/// The `quiet` map as validateState reads it: an entry that does not fit
/// is dropped on its own.
fn quiet_map<'de, D>(d: D) -> Result<BTreeMap<String, SavedQuiet>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, Value> = crate::lenient::map(d)?;
    Ok(entries
        .into_iter()
        .filter(|(ws, _)| is_id(ws))
        .filter_map(|(ws, v)| {
            let q = serde_json::from_value::<SavedQuiet>(v).ok()?;
            q.fits().then_some((ws, q))
        })
        .collect())
}

/// An agent's status as the core shows it, saved for the agents panel
/// (#429): cmux's own words, a status the core does not know left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedStatus {
    NeedsInput,
    Working,
    Idle,
    Ended,
}

/// Why a shown agent waits on Jon: its turn ended on a move asking
/// something of him, it asks (a saved ask), its session stopped, it
/// carries its workspace's CI wait, or its Ostinato parks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitWhy {
    Turn,
    Ask,
    Stop,
    Ci,
    Park,
}

/// One agent a workspace shows, as the core shows it (#429), so the
/// agents panel reads each agent's status, and why it waits on Jon, from
/// the core's rules rather than copies of its own.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedAgent {
    /// The agent's id, or `stand-in` for a CI or park stand-in.
    pub id: String,
    pub status: SavedStatus,
    /// When the status began, in epoch seconds; 0 when cmux sent none.
    pub since: f64,
    /// Only with needs_input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<WaitWhy>,
    /// The ask's words, only with `why` ask, which may have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The agent as the core's frame had it before any wait was laid on,
    /// so the panel holds the entry only while cmux still shows that
    /// spell. None for a stand-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<Seen>,
}

/// An agent's own status and its start, as the core's frame had it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Seen {
    pub status: SavedStatus,
    /// Epoch seconds; 0 when the frame had none.
    pub since: f64,
}

/// The most agents saved for one workspace.
pub const MAX_AGENTS: usize = 20;

impl SavedAgent {
    /// Every field within the bounds state-config.ts's savedAgent holds it
    /// to: an id, an epoch, a why with needs_input and only there, and a
    /// reason of plain text only with an ask, which may have none (a
    /// permission prompt saves no ask), and a seen start that is an epoch.
    pub(crate) fn fits(&self) -> bool {
        let waits = self.status == SavedStatus::NeedsInput;
        let ask = self.why == Some(WaitWhy::Ask);
        let epoch = |t: f64| t.is_finite() && t >= 0.0;
        is_id(&self.id)
            && epoch(self.since)
            && self.seen.is_none_or(|s| epoch(s.since))
            && self.why.is_none_or(|_| waits)
            && self
                .reason
                .as_ref()
                .is_none_or(|r| ask && is_text(r, MAX_LABEL))
    }
}

/// Whether `agents` fits as one workspace's list: one to MAX_AGENTS
/// agents, each of which fits.
fn agents_fit(agents: &[SavedAgent]) -> bool {
    (1..=MAX_AGENTS).contains(&agents.len()) && agents.iter().all(SavedAgent::fits)
}

/// The `agents` map as validateState reads it: a workspace's list with
/// any agent that does not fit is dropped whole, as for `waits`.
fn agents_map<'de, D>(d: D) -> Result<BTreeMap<String, Vec<SavedAgent>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, Value> = crate::lenient::map(d)?;
    Ok(entries
        .into_iter()
        .filter(|(ws, _)| is_id(ws))
        .filter_map(|(ws, v)| {
            let a = serde_json::from_value::<Vec<SavedAgent>>(v).ok()?;
            agents_fit(&a).then_some((ws, a))
        })
        .collect())
}

/// What kind of wait on Jon the core saved for a workspace (#388): a
/// stopped session (stopped.rs), CI stuck or red with nobody on it, a
/// change left merge-ready four hours (ci_wait.rs), or parked Ostinato
/// attempts (ostinato/wait.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitKind {
    Stopped,
    CiStuck,
    CiFailing,
    MergeReady,
    Park,
}

/// One wait the Cockpit shows on a workspace's card, saved so the agents
/// panel, which reads only the file, counts and names the same waits
/// (#388). Nothing in it moves with the clock: the panel works out each
/// age from `since`, so a saved wait is written once, not every minute.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedWait {
    pub kind: WaitKind,
    /// When it began to wait on Jon, in epoch seconds.
    pub since: f64,
    /// The start a dismissal of it is saved at, in `dismissed`.
    pub key: f64,
    /// The stopped session's id, which its dismissal is saved under; only
    /// a stop carries one (CI's is `ci`, a park's `ostinato`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// A few words of what waits: a stop's cause ("error", "gone",
    /// "silent"), the PR's title or "#12", the park's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Stuck CI only: the stuck check's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    /// Stuck CI only: when the stuck check was queued, or started when it
    /// runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<f64>,
}

/// The most waits saved for one workspace.
pub const MAX_WAITS: usize = 20;
/// The longest check name kept (state-config.ts's isName, MAX_NAME).
pub const MAX_CHECK_NAME: usize = 64;
/// The longest wait detail kept (MAX_LABEL).
pub const MAX_WAIT_DETAIL: usize = MAX_LABEL;

impl SavedWait {
    /// Every field within the bounds state-config.ts's savedWait holds it
    /// to: two epochs, an agent on a stop and only there, a detail of
    /// plain text, and a check and its time on stuck CI and only there.
    /// The core sends only a wait that fits, so the script never refuses
    /// one and leaves it to be sent again.
    pub(crate) fn fits(&self) -> bool {
        let epoch = |e: f64| e.is_finite() && e >= 0.0;
        let stuck = self.kind == WaitKind::CiStuck;
        let agent = match (&self.agent, self.kind) {
            (Some(a), WaitKind::Stopped) => is_id(a),
            (None, WaitKind::Stopped) => false,
            (a, _) => a.is_none(),
        };
        epoch(self.since)
            && epoch(self.key)
            && agent
            && self
                .detail
                .as_deref()
                .is_none_or(|d| is_text(d, MAX_WAIT_DETAIL))
            && self
                .check
                .as_deref()
                .is_none_or(|c| stuck && is_text(c, MAX_CHECK_NAME))
            && self.queued.is_none_or(|q| stuck && epoch(q))
    }
}

/// Whether `waits` fits as one workspace's list: one to MAX_WAITS waits,
/// each of which fits.
pub(crate) fn waits_fit(waits: &[SavedWait]) -> bool {
    (1..=MAX_WAITS).contains(&waits.len()) && waits.iter().all(SavedWait::fits)
}

/// The `waits` map as validateState reads it: a workspace's list with
/// any wait that does not fit is dropped whole, so the panel never counts
/// part of what the Cockpit showed.
fn waits_map<'de, D>(d: D) -> Result<BTreeMap<String, Vec<SavedWait>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, Value> = crate::lenient::map(d)?;
    Ok(entries
        .into_iter()
        .filter(|(ws, _)| is_id(ws))
        .filter_map(|(ws, v)| {
            let w = serde_json::from_value::<Vec<SavedWait>>(v).ok()?;
            waits_fit(&w).then_some((ws, w))
        })
        .collect())
}

/// One stage of a saved Ostinato cycle, or its park (ostinato/cycle.rs
/// `Milestone`): its name, when, how long since the one before, and the
/// sessions behind it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedStage {
    pub name: String,
    pub at: f64,
    pub secs: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<String>,
}

/// One Ostinato cycle on a workspace's card, one attempt at one item,
/// saved for the agents panel's Details tab (#399, cycles_save.rs).
/// Nothing in it moves with the clock: times are epochs and `secs` the
/// time between two lines, so a cycle is written when it changes, not
/// every minute.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedCycle {
    /// The item, as `repo#12`.
    pub item: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    /// How it ended, as the record's word; absent while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// Why it parked, as the record's code, and the question for Jon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// The draft pull request it opened, as `repo#12`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<String>,
    /// What it cost in dollars, from its end line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// When it was picked; absent for an earlier run's cycle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<SavedStage>,
}

/// The most cycles saved for one workspace, the newest kept.
pub const MAX_CYCLES: usize = 10;
/// The most stages saved for one cycle, the last kept.
pub const MAX_STAGES: usize = 20;
/// The most sessions saved for one cycle or stage.
pub const MAX_CYCLE_SESSIONS: usize = 8;
/// The longest text a cycle keeps (MAX_LABEL).
pub const MAX_CYCLE_TEXT: usize = MAX_LABEL;
/// The longest item link kept; a longer one is dropped, never cut.
pub const MAX_URL: usize = 512;

/// Whether `sessions` fits a cycle or stage: up to MAX_CYCLE_SESSIONS ids.
fn sessions_fit(sessions: &[String]) -> bool {
    sessions.len() <= MAX_CYCLE_SESSIONS && sessions.iter().all(|s| is_id(s))
}

impl SavedStage {
    fn fits(&self) -> bool {
        is_text(&self.name, MAX_CYCLE_TEXT)
            && is_epoch(self.at)
            && is_epoch(self.secs)
            && sessions_fit(&self.sessions)
    }
}

impl SavedCycle {
    /// Every field within the bounds state-config.ts's savedCycle holds
    /// it to. The core sends only a cycle that fits, so the script never
    /// refuses one and leaves it to be sent again.
    pub(crate) fn fits(&self) -> bool {
        let text = |t: &Option<String>| t.as_deref().is_none_or(|t| is_text(t, MAX_CYCLE_TEXT));
        is_text(&self.item, MAX_CYCLE_TEXT)
            && self.url.as_deref().is_none_or(|u| is_text(u, MAX_URL))
            && self.attempt.is_none_or(|n| n >= 1)
            && text(&self.outcome)
            && text(&self.reason)
            && text(&self.question)
            && text(&self.pr)
            && sessions_fit(&self.sessions)
            && self.cost.is_none_or(is_epoch)
            && self.started.is_none_or(is_epoch)
            && self.ended.is_none_or(is_epoch)
            && self.stages.len() <= MAX_STAGES
            && self.stages.iter().all(SavedStage::fits)
    }
}

/// A number that is finite and not below zero: an epoch, a length, dollars.
pub(crate) fn is_epoch(e: f64) -> bool {
    e.is_finite() && e >= 0.0
}

/// Whether `cycles` fits as one workspace's list: one to MAX_CYCLES
/// cycles, each of which fits.
pub(crate) fn cycles_fit(cycles: &[SavedCycle]) -> bool {
    (1..=MAX_CYCLES).contains(&cycles.len()) && cycles.iter().all(SavedCycle::fits)
}

/// The `cycles` map as validateState reads it: a workspace's list with
/// any cycle that does not fit is dropped whole, as the waits are.
fn cycles_map<'de, D>(d: D) -> Result<BTreeMap<String, Vec<SavedCycle>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, Value> = crate::lenient::map(d)?;
    Ok(entries
        .into_iter()
        .filter(|(ws, _)| is_id(ws))
        .filter_map(|(ws, v)| {
            let c = serde_json::from_value::<Vec<SavedCycle>>(v).ok()?;
            cycles_fit(&c).then_some((ws, c))
        })
        .collect())
}

/// The `notified` map, each entry kept only while it fits (`SavedNote::fits`).
fn notes_map<'de, D>(d: D) -> Result<BTreeMap<String, SavedNote>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries: BTreeMap<String, SavedNote> = crate::lenient::map(d)?;
    Ok(entries
        .into_iter()
        .filter(|(ws, n)| is_id(ws) && n.fits())
        .collect())
}

/// Why an agent stopped to ask, as the notification hook saves it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedAsk {
    pub reason: String,
    pub epoch: f64,
    #[serde(default)]
    pub session: Option<String>,
}

impl Stamped for SavedAsk {
    fn epoch(&self) -> f64 {
        self.epoch
    }
    fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }
}

/// What a chat last asked of Jon, as the Stop hook saves it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct SavedMove {
    /// The line after "Your move:".
    pub text: String,
    /// Epoch seconds the hook saw the turn end.
    pub epoch: f64,
    #[serde(default)]
    pub session: Option<String>,
    /// How many numbered decisions the reply laid out.
    #[serde(default)]
    pub decisions: Option<f64>,
    /// The reply's recommended answers ("1b 2a").
    #[serde(default)]
    pub leans: Option<String>,
    /// Set when the line was "Nothing for you:": the turn waits on the agent.
    #[serde(default)]
    pub idle: Option<bool>,
    /// Set when the reply had neither label: `text` is its last line, shown in grey.
    #[serde(default)]
    pub unlabelled: Option<bool>,
    /// Set beside `unlabelled` when the reply asked nothing at all: it
    /// waits on Jon only once the chat's helpers stop (needs.rs).
    #[serde(default, rename = "noAsk")]
    pub no_ask: Option<bool>,
    /// A small model's reading of the whole reply, written after the move
    /// (scripts/hooks/move-verdict.ts): "waits" overrides the wording
    /// flags, "quiet" holds the turn like `no_ask` (moves.rs).
    #[serde(default)]
    pub verdict: Option<MoveVerdict>,
}

/// What the model said of a reply: it waits on Jon, or it does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveVerdict {
    Waits,
    Quiet,
}

impl MoveVerdict {
    fn of(s: &str) -> Option<Self> {
        match s {
            "waits" => Some(Self::Waits),
            "quiet" => Some(Self::Quiet),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Waits => "waits",
            Self::Quiet => "quiet",
        }
    }
}

impl Stamped for SavedMove {
    fn epoch(&self) -> f64 {
        self.epoch
    }
    fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }
}

/// The agent tabs (cmux surface ids) the cockpit put to sleep in one
/// workspace when its card was parked, and when, in epoch seconds (#328).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct SavedAsleep {
    pub surfaces: Vec<String>,
    pub since: f64,
}

/// The desktop notification the cockpit posted for one workspace's wait
/// (notify.rs, #379): when the wait began, which keys it, the CI wait's
/// own key for a CI wait (ci_wait.rs `CiWait::key`), and the id cmux gave
/// it, kept until it is dismissed. Kept with no id after, marked `down`,
/// so the same wait never notifies twice. A record with no id that is not
/// down is a post on its way, or one that failed.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SavedNote {
    pub since: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ci: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// When it was taken down, in epoch seconds: its wait cleared, or its
    /// card left the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub down: Option<f64>,
}

impl SavedNote {
    /// Whether the state handler keeps it (savedNote in
    /// scripts/state-config.ts): a start after the zero time, a CI key
    /// that is a time, an id in cmux's UUID shape, and a take down after
    /// the zero time.
    pub fn fits(&self) -> bool {
        self.since.is_finite()
            && self.since > 0.0
            && self.ci.is_none_or(|k| k.is_finite() && k >= 0.0)
            && self.id.as_deref().is_none_or(is_uuid)
            && self.down.is_none_or(|t| t.is_finite() && t > 0.0)
    }
}

/// Whether `v` is a UUID as cmux writes one, "74D64488-9CB8-4B8D-900F-1908FF44B8BB",
/// in either case: the only shape a notification id may take before it
/// reaches a command line.
pub fn is_uuid(v: &str) -> bool {
    v.len() == 36
        && v.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// How the PR poller's last runs went.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedPoll {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub ok_epoch: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub error: Option<String>,
}

/// config/state.json. The maps only the agents sidebar reads stay as plain
/// JSON until that sidebar is ported.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedState {
    /// wsId to agent id to the start of the dismissed needs_input spell.
    #[serde(deserialize_with = "crate::lenient::map")]
    pub dismissed: BTreeMap<String, BTreeMap<String, f64>>,
    /// wsId to the project key chosen by "Move to project".
    #[serde(deserialize_with = "crate::lenient::map")]
    pub project_override: BTreeMap<String, String>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub projects: BTreeMap<String, SavedProject>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub prs: BTreeMap<String, SavedPr>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub own_prs: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub subagents: BTreeMap<String, Vec<SavedSubagent>>,
    /// wsId to the background work its chats have running, from the Stop
    /// hooks' task lists (crate::background). Left out while empty.
    #[serde(
        deserialize_with = "tasks_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub background: BTreeMap<String, Vec<SavedTask>>,
    /// wsId to the core's background verdict for its card (#360), which
    /// the core writes through the runner (running_save.rs) and the agents
    /// panel reads. Left out while empty.
    #[serde(
        deserialize_with = "running_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub running: BTreeMap<String, SavedRunning>,
    /// wsId to the core's quiet verdict for its card (#425), which the
    /// core writes through the runner (quiet_save.rs) and the agents panel
    /// reads. Left out while empty.
    #[serde(
        deserialize_with = "quiet_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub quiet: BTreeMap<String, SavedQuiet>,
    /// wsId to the agents its workspace shows, as the core shows them
    /// (#429), which the core writes through the runner (agents_save.rs).
    /// Left out while empty.
    #[serde(
        deserialize_with = "agents_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub agents: BTreeMap<String, Vec<SavedAgent>>,
    /// wsId to the waits on Jon its card shows (#388), which the core
    /// writes through the runner (waits_save.rs) and the agents panel
    /// reads. Left out while empty.
    #[serde(
        deserialize_with = "waits_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub waits: BTreeMap<String, Vec<SavedWait>>,
    /// wsId to the Ostinato cycles its card carries (#399), newest last,
    /// which the core writes through the runner (cycles_save.rs) and the
    /// agents panel's Details tab reads. Left out while empty.
    #[serde(
        deserialize_with = "cycles_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub cycles: BTreeMap<String, Vec<SavedCycle>>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub names: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub published: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub pr_origins: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub asking: BTreeMap<String, SavedAsk>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub moves: BTreeMap<String, SavedMove>,
    /// Lane id to the name the cockpit last saw it under in lanes.json, so
    /// a rename there renames the lane's group (lane_rename.rs).
    #[serde(deserialize_with = "crate::lenient::map")]
    pub lane_names: BTreeMap<String, String>,
    /// wsId to the agents the cockpit put to sleep there (sleep.rs), so a
    /// card still reads Asleep after a reload. Left out while empty.
    #[serde(
        deserialize_with = "crate::lenient::map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub asleep: BTreeMap<String, SavedAsleep>,
    /// wsId to the desktop notification posted for its wait (notify.rs),
    /// so a restart neither posts it again nor loses the id that dismisses
    /// it. Left out while empty.
    #[serde(
        deserialize_with = "notes_map",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub notified: BTreeMap<String, SavedNote>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub ui: UiState,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub poll: Option<SavedPoll>,
}

impl SavedState {
    /// The state from config/state.json's text.
    pub fn from_json(text: &str) -> Result<SavedState, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// Makes one of the cockpit's own writes here, as the handler's
    /// applySet makes it in the file: `dismissed.<ws>`, `projectOverride.<ws>`,
    /// `projects.<key>`, `laneNames.<id>`, `asleep.<ws>`, `notified.<ws>`, `ui.mode`, `ui.collapsed` or `ui.filter`, set, or deleted with
    /// no value. False
    /// for any other key or a value of the wrong shape, leaving the state
    /// as it was.
    pub fn set_entry(&mut self, key: &str, value: Option<&Value>) -> bool {
        fn parse<T: serde::de::DeserializeOwned>(v: Option<&Value>) -> Result<Option<T>, ()> {
            v.map(|v| serde_json::from_value(v.clone()).map_err(|_| ()))
                .transpose()
        }
        let Some((map, id)) = key.split_once('.') else {
            return false;
        };
        fn put<T>(entries: &mut BTreeMap<String, T>, id: &str, v: Option<T>) {
            match v {
                Some(v) => entries.insert(id.to_string(), v),
                None => entries.remove(id),
            };
        }
        match (map, id) {
            ("dismissed", _) => parse(value)
                .map(|v| put(&mut self.dismissed, id, v))
                .is_ok(),
            ("projectOverride", _) => parse(value)
                .map(|v| put(&mut self.project_override, id, v))
                .is_ok(),
            ("projects", _) => parse(value).map(|v| put(&mut self.projects, id, v)).is_ok(),
            ("laneNames", _) => parse(value)
                .map(|v| put(&mut self.lane_names, id, v))
                .is_ok(),
            ("asleep", _) => parse(value).map(|v| put(&mut self.asleep, id, v)).is_ok(),
            ("notified", _) => parse(value).map(|v| put(&mut self.notified, id, v)).is_ok(),
            ("ui", "mode") => parse(value).map(|v| self.ui.mode = v).is_ok(),
            ("ui", "filter") => parse(value).map(|v| self.ui.filter = v).is_ok(),
            ("ui", "collapsed") => parse(value)
                .map(|v| self.ui.collapsed = v.unwrap_or_default())
                .is_ok(),
            _ => false,
        }
    }

    /// Whether the state already holds this write.
    pub fn shows_entry(&self, key: &str, value: Option<&Value>) -> bool {
        let mut after = self.clone();
        after.set_entry(key, value) && after == *self
    }
}

/// The URL that asks the (separately installed) handler to set or delete
/// one entry. `key` is `<map>.<id>`; a None value asks for a delete. The
/// install's token goes last, when there is one.
pub fn persist_url(key: &str, value: Option<&Value>, token: &str) -> String {
    let mut url = format!("cmux-cockpit://set?key={}", encode_uri_component(key));
    if let Some(v) = value {
        url.push_str("&value=");
        url.push_str(&encode_uri_component(&v.to_string()));
    }
    if !token.is_empty() {
        url.push_str("&token=");
        url.push_str(&encode_uri_component(token));
    }
    url
}

// A move rides to the cockpit in its workspace's description: the line,
// then the rest of the move as one bracketed JSON tail.
static MOVE_TAIL: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?s)^(.*) ⟦move (\{.*\})⟧$").ok());
// The status line's context rides after the move as a second tail
// (state-config.ts CONTEXT_TAIL); it is stripped before the move is read.
static CONTEXT_TAIL: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?s)^(.*?) ?⟦ctx \{[^⟦⟧]*\}⟧$").ok());
static LEANS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[1-9][a-z](?: [1-9][a-z])*$").ok());

/// The longest "Your move" line kept.
pub const MAX_MOVE: usize = 200;
/// The most decisions one reply is counted as laying out.
pub const MAX_DECISIONS: f64 = 9.0;

/// Plain, single-line text with no leading, trailing or control characters, up to `max` long.
/// Spaces are those JS trim() takes off (js_space), byte order marks
/// too, as state-config.ts's isText holds them, so a text this passes the
/// script never refuses.
pub(crate) fn is_text(v: &str, max: usize) -> bool {
    let len = utf16_len(v);
    v.trim_matches(js_space) == v
        && len > 0
        && len <= max
        && v.chars().all(|c| c >= ' ' && c != '\u{7f}')
}

pub(crate) fn is_id(v: &str) -> bool {
    let len = utf16_len(v);
    len > 0 && len <= 128 && !["__proto__", "constructor", "prototype"].contains(&v)
}

fn epoch_of(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|e| e.is_finite() && *e >= 0.0)
}

/// A move from its fields, or None when any is bad (state-config.ts's savedMove).
fn saved_move(fields: &Map<String, Value>, text: &str) -> Option<SavedMove> {
    if !is_text(text, MAX_MOVE) {
        return None;
    }
    let epoch = epoch_of(fields.get("epoch"))?;
    let session = match fields.get("session") {
        None => None,
        Some(Value::String(s)) if is_id(s) => Some(s.clone()),
        Some(_) => return None,
    };
    let decisions = match fields.get("decisions") {
        None => None,
        Some(v) => Some(
            v.as_f64()
                .filter(|d| d.fract() == 0.0 && (1.0..=MAX_DECISIONS).contains(d))?,
        ),
    };
    let leans = match fields.get("leans") {
        None => None,
        Some(Value::String(s))
            if utf16_len(s) <= 40 && LEANS.as_ref().is_some_and(|re| re.is_match(s)) =>
        {
            Some(s.clone())
        }
        Some(_) => return None,
    };
    let idle = flag(fields.get("idle"))?;
    let unlabelled = flag(fields.get("unlabelled"))?;
    let no_ask = flag(fields.get("noAsk"))?;
    let verdict = match fields.get("verdict") {
        None => None,
        Some(Value::String(s)) => Some(MoveVerdict::of(s)?),
        Some(_) => return None,
    };
    Some(SavedMove {
        text: text.to_string(),
        epoch,
        session,
        decisions,
        leans,
        idle,
        unlabelled,
        no_ask,
        verdict,
    })
}

/// A move's marker field: absent, or true; None for anything else, which
/// makes the whole move bad.
fn flag(v: Option<&Value>) -> Option<Option<bool>> {
    match v {
        None => Some(None),
        Some(Value::Bool(true)) => Some(Some(true)),
        Some(_) => None,
    }
}

/// A description without the context tail the status line adds, when it has one.
pub fn without_context(d: &str) -> &str {
    CONTEXT_TAIL
        .as_ref()
        .and_then(|re| re.captures(d))
        .and_then(|c| c.get(1))
        .map_or(d, |m| m.as_str())
}

/// The move a workspace description carries, or None when it carries none or a bad one.
pub fn move_of_description(d: Option<&str>) -> Option<SavedMove> {
    let caps = MOVE_TAIL.as_ref()?.captures(without_context(d?))?;
    let text = caps.get(1)?.as_str();
    let rest: Value = serde_json::from_str(caps.get(2)?.as_str()).ok()?;
    saved_move(rest.as_object()?, text)
}

/// True when a description is a move's, so it is never shown as Jon's own words.
pub fn is_move_description(d: Option<&str>) -> bool {
    match (d, MOVE_TAIL.as_ref()) {
        (Some(d), Some(re)) => re.is_match(without_context(d)),
        _ => false,
    }
}

/// A move as the workspace description the Stop hook sets.
pub fn move_description(m: &SavedMove) -> String {
    let mut rest = Map::new();
    rest.insert("epoch".into(), crate::js::json_num(m.epoch));
    if let Some(s) = &m.session {
        rest.insert("session".into(), Value::from(s.as_str()));
    }
    if let Some(d) = m.decisions {
        rest.insert("decisions".into(), crate::js::json_num(d));
    }
    if let Some(l) = &m.leans {
        rest.insert("leans".into(), Value::from(l.as_str()));
    }
    if let Some(i) = m.idle {
        rest.insert("idle".into(), Value::from(i));
    }
    if let Some(u) = m.unlabelled {
        rest.insert("unlabelled".into(), Value::from(u));
    }
    if let Some(n) = m.no_ask {
        rest.insert("noAsk".into(), Value::from(n));
    }
    if let Some(v) = m.verdict {
        rest.insert("verdict".into(), Value::from(v.as_str()));
    }
    format!("{} ⟦move {}⟧", m.text, Value::Object(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_notification_record_that_fits_and_drops_the_rest() {
        let id = "74D64488-9CB8-4B8D-900F-1908FF44B8BB";
        let saved = SavedState::from_json(&format!(
            r#"{{"notified": {{
                "W1": {{"since": 1000, "ci": 800, "id": "{id}"}},
                "W2": {{"since": 1000}},
                "W3": {{"since": 1000, "ci": 800, "down": 1100}},
                "early": {{"since": 1000, "down": 0}},
                "zero": {{"since": 0}},
                "odd": {{"since": 1000, "id": "--all-read"}},
                "bad": {{"since": "soon"}},
                "__proto__": {{"since": 1000}}
            }}}}"#
        ))
        .unwrap();
        let kept: Vec<&str> = saved.notified.keys().map(String::as_str).collect();
        assert_eq!(kept, ["W1", "W2", "W3"]);
        assert_eq!(saved.notified["W1"].id.as_deref(), Some(id));
        assert_eq!(saved.notified["W1"].down, None);
        assert_eq!(saved.notified["W3"].down, Some(1100.0));
        assert_eq!(saved.notified["W1"].ci, Some(800.0));
        // Written back as read, and left out while empty.
        let text = serde_json::to_string(&saved).unwrap();
        assert_eq!(SavedState::from_json(&text).unwrap(), saved);
        let empty = serde_json::to_value(SavedState::default()).unwrap();
        assert!(empty.get("notified").is_none());
        assert!(is_uuid(&id.to_lowercase()));
        assert!(!is_uuid("74D64488-9CB8-4B8D-900F-1908FF44B8B"));
        assert!(!is_uuid("74D64488x9CB8-4B8D-900F-1908FF44B8BB"));
        assert!(!is_uuid("G4D64488-9CB8-4B8D-900F-1908FF44B8BB"));
    }

    #[test]
    fn every_pattern_compiles() {
        assert!(MOVE_TAIL.is_some());
        assert!(CONTEXT_TAIL.is_some());
        assert!(LEANS.is_some());
    }

    #[test]
    fn reads_a_state_file_dropping_only_its_bad_entries() {
        let json = r##"{
            "dismissed": {"w1": {"a1": 500}, "bad": 3},
            "asking": {"ok": {"reason": "allow?", "epoch": 1}, "bad": {"epoch": 1}},
            "ui": {"mode": "projects", "collapsed": {"lane:unsorted": 1}},
            "projects": {"/a/b/": {"name": "B", "color": "#000000", "icon": "x"}, "/c/d": {"removed": true}},
            "someFutureMap": {}
        }"##;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.dismissed.len(), 1);
        assert_eq!(s.asking.len(), 1);
        assert_eq!(s.ui.mode, Some(ViewMode::Projects));
        assert_eq!(s.ui.collapsed.get("lane:unsorted"), Some(&1.0));
        assert!(matches!(
            s.projects.get("/c/d"),
            Some(SavedProject::Removed { .. })
        ));
    }

    #[test]
    fn drops_the_retired_shells_map_and_run_flag_whatever_their_shape() {
        // #361 retired the `shells` map and a subagent run's `background`
        // flag: an old file still reads, and neither is written back.
        let run =
            r#"{"id": "t", "session": "s", "label": "L", "startedEpoch": 5, "background": true}"#;
        for shells in [
            r#"{"w": [{"id": "b1", "session": "s", "startedEpoch": 5}]}"#,
            "3",
            "null",
            r#""x""#,
            "[1, 2]",
        ] {
            let json = format!(r#"{{"shells": {shells}, "subagents": {{"w": [{run}]}}}}"#);
            let s = SavedState::from_json(&json).unwrap();
            assert_eq!(s.subagents["w"].len(), 1, "{shells}");
            let out = serde_json::to_value(&s).unwrap();
            assert!(out.get("shells").is_none(), "{shells}");
            assert!(
                out["subagents"]["w"][0].get("background").is_none(),
                "{shells}"
            );
        }
    }

    #[test]
    fn reads_waits_as_validate_state_does() {
        // The same sample as test/waits-save.test.ts's validateState test.
        let long = "d".repeat(121);
        let json = r#"{"waits": {
            "w1": [
                {"kind": "stopped", "since": 100, "key": 100, "agent": "s1", "detail": "error", "extra": 1},
                {"kind": "ci_stuck", "since": 700, "key": 100, "detail": "Docs layout", "check": "build", "queued": 100},
                {"kind": "park", "since": 50, "key": 50}
            ],
            "nulls": [{"kind": "ci_failing", "since": 1, "key": 0, "agent": null, "detail": null, "check": null, "queued": null}],
            "unknown kind": [{"kind": "asking", "since": 1, "key": 1}],
            "detail not text": [{"kind": "park", "since": 1, "key": 1, "detail": 5}],
            "long detail": [{"kind": "park", "since": 1, "key": 1, "detail": "LONG"}],
            "padded detail": [{"kind": "park", "since": 1, "key": 1, "detail": " x"}],
            "check on red": [{"kind": "ci_failing", "since": 1, "key": 1, "check": "build"}],
            "queued on a park": [{"kind": "park", "since": 1, "key": 1, "queued": 1}],
            "stop with no agent": [{"kind": "stopped", "since": 1, "key": 1}],
            "agent on ci": [{"kind": "merge_ready", "since": 1, "key": 1, "agent": "s1"}],
            "one bad": [{"kind": "park", "since": 1, "key": 1}, {"kind": "park", "since": -1, "key": 1}],
            "no key": [{"kind": "park", "since": 1}],
            "empty": [],
            "junk": "x",
            "__proto__": [{"kind": "park", "since": 1, "key": 1}]
        }}"#
        .replace("LONG", &long);
        let s = SavedState::from_json(&json).unwrap();
        assert_eq!(s.waits.keys().collect::<Vec<_>>(), ["nulls", "w1"]);
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(
            out["waits"],
            serde_json::json!({
                "w1": [
                    {"kind": "stopped", "since": 100.0, "key": 100.0, "agent": "s1", "detail": "error"},
                    {"kind": "ci_stuck", "since": 700.0, "key": 100.0, "detail": "Docs layout",
                     "check": "build", "queued": 100.0},
                    {"kind": "park", "since": 50.0, "key": 50.0}
                ],
                "nulls": [{"kind": "ci_failing", "since": 1.0, "key": 0.0}]
            })
        );
        let many = format!(
            r#"{{"waits": {{"w": [{}]}}}}"#,
            vec![r#"{"kind": "park", "since": 1, "key": 1}"#; MAX_WAITS + 1].join(",")
        );
        assert!(SavedState::from_json(&many).unwrap().waits.is_empty());
        let empty = serde_json::to_value(SavedState::default()).unwrap();
        assert!(empty.get("waits").is_none(), "left out while empty");
    }

    #[test]
    fn reads_quiet_verdicts_as_validate_state_does() {
        // The same sample as test/quiet-save.test.ts's validateState test.
        let json = r#"{"quiet": {
            "w1": {"agent": "s1", "since": 100.5, "extra": 1},
            "bad since": {"agent": "s1", "since": -1},
            "no since": {"agent": "s1"},
            "no agent": {"agent": "", "since": 100},
            "junk": "x",
            "__proto__": {"agent": "s1", "since": 100}
        }}"#;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.quiet.keys().collect::<Vec<_>>(), ["w1"]);
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(
            out["quiet"]["w1"],
            serde_json::json!({"agent": "s1", "since": 100.5})
        );
        let empty = serde_json::to_value(SavedState::default()).unwrap();
        assert!(empty.get("quiet").is_none(), "left out while empty");
    }

    #[test]
    fn reads_shown_agents_as_validate_state_does() {
        // The same sample as test/agents-save.test.ts's validateState test.
        let json = r#"{"agents": {
            "w1": [{"id": "s1", "status": "needs_input", "since": 100.5, "why": "ask", "reason": "allow?", "extra": 1},
                   {"id": "s2", "status": "working", "since": 0}],
            "w2": [{"id": "stand-in", "status": "needs_input", "since": 5, "why": "ci"}],
            "why when idle": [{"id": "s1", "status": "idle", "since": 1, "why": "turn"}],
            "reason on a turn": [{"id": "s1", "status": "needs_input", "since": 1, "why": "turn", "reason": "x"}],
            "w3": [{"id": "s1", "status": "needs_input", "since": 1, "why": "ask",
                    "seen": {"status": "idle", "since": 0.5, "extra": 1}},
                   {"id": "s2", "status": "idle", "since": 1, "seen": null}],
            "seen unknown status": [{"id": "s1", "status": "idle", "since": 1, "seen": {"status": "busy", "since": 1}}],
            "seen no since": [{"id": "s1", "status": "idle", "since": 1, "seen": {"status": "idle"}}],
            "seen negative": [{"id": "s1", "status": "idle", "since": 1, "seen": {"status": "idle", "since": -1}}],
            "unknown status": [{"id": "s1", "status": "busy", "since": 1}],
            "unknown why": [{"id": "s1", "status": "needs_input", "since": 1, "why": "nap"}],
            "one bad": [{"id": "s1", "status": "idle", "since": 1}, {"id": "", "status": "idle", "since": 1}],
            "empty": [],
            "__proto__": [{"id": "s1", "status": "idle", "since": 1}]
        }}"#;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.agents.keys().collect::<Vec<_>>(), ["w1", "w2", "w3"]);
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(
            out["agents"],
            serde_json::json!({
                "w1": [{"id": "s1", "status": "needs_input", "since": 100.5, "why": "ask", "reason": "allow?"},
                       {"id": "s2", "status": "working", "since": 0.0}],
                "w2": [{"id": "stand-in", "status": "needs_input", "since": 5.0, "why": "ci"}],
                "w3": [{"id": "s1", "status": "needs_input", "since": 1.0, "why": "ask",
                        "seen": {"status": "idle", "since": 0.5}},
                       {"id": "s2", "status": "idle", "since": 1.0}]
            })
        );
        let many = format!(
            r#"{{"agents": {{"w": [{}]}}}}"#,
            vec![r#"{"id": "s", "status": "idle", "since": 1}"#; MAX_AGENTS + 1].join(",")
        );
        assert!(SavedState::from_json(&many).unwrap().agents.is_empty());
        let empty = serde_json::to_value(SavedState::default()).unwrap();
        assert!(empty.get("agents").is_none(), "left out while empty");
    }

    #[test]
    fn reads_running_verdicts_as_validate_state_does() {
        // The same sample as test/running-save.test.ts's validateState test.
        let json = r#"{"running": {
            "w1": {"agent": "s1", "since": 100, "counts": [{"type": "shell", "n": 2}, {"type": "a new kind", "n": 1}], "extra": 1},
            "no counts": {"agent": "s1", "since": 100, "counts": []},
            "zero": {"agent": "s1", "since": 100, "counts": [{"type": "shell", "n": 0}]},
            "too many": {"agent": "s1", "since": 100, "counts": [{"type": "shell", "n": 21}]},
            "half": {"agent": "s1", "since": 100, "counts": [{"type": "shell", "n": 1.5}]},
            "no type": {"agent": "s1", "since": 100, "counts": [{"type": 3, "n": 1}]},
            "bad since": {"agent": "s1", "since": -1, "counts": [{"type": "shell", "n": 1}]},
            "no agent": {"agent": "", "since": 100, "counts": [{"type": "shell", "n": 1}]},
            "junk": "x",
            "__proto__": {"agent": "s1", "since": 100, "counts": [{"type": "shell", "n": 1}]}
        }}"#;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.running.keys().collect::<Vec<_>>(), ["w1"]);
        let counts: Vec<(TaskType, usize)> = s.running["w1"]
            .counts
            .iter()
            .map(|c| (c.kind, c.n))
            .collect();
        assert_eq!(counts, [(TaskType::Shell, 2), (TaskType::Other, 1)]);
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(
            out["running"]["w1"],
            serde_json::json!({"agent": "s1", "since": 100.0,
                "counts": [{"type": "shell", "n": 2}, {"type": "other", "n": 1}]})
        );
        let empty = serde_json::to_value(SavedState::default()).unwrap();
        assert!(empty.get("running").is_none(), "left out while empty");
    }

    #[test]
    fn reads_background_tasks_as_validate_state_does() {
        // The same sample as test/report-background.test.ts's validateState test.
        let task = |id: &str, kind: &str| {
            serde_json::json!({"id": id, "type": kind, "status": "running", "description": id,
                "session": "s1", "startedEpoch": 10, "seenEpoch": 10})
        };
        let many: Vec<Value> = (0..MAX_TASKS + 3)
            .map(|i| task(&format!("b{i}"), "shell"))
            .collect();
        let mut no_epoch = task("no epoch", "shell");
        no_epoch["seenEpoch"] = Value::from(-1);
        let mut bad_status = task("bad status", "shell");
        bad_status["status"] = Value::from("");
        let mut bad_words = task("bad words", "shell");
        bad_words["description"] = Value::from(" padded ");
        let pid = |id: &str, pid: Value| {
            let mut t = task(id, "shell");
            t["pid"] = pid;
            t
        };
        let mut json = serde_json::json!({"background": {
            "w1": many,
            "w2": [task("kept", "a new kind"), task("cloud", "cloud session"), task("mcp", "MCP task"),
                   no_epoch, bad_status, bad_words, task("no type", "x"), "junk",
                   pid("pid", Value::from(4242)), pid("null pid", Value::Null), pid("zero pid", Value::from(0)),
                   pid("text pid", Value::from("42")), pid("minus pid", Value::from(-1)),
                   pid("big pid", Value::from(4_294_967_296_u64)), pid("half pid", Value::from(4.5))],
            "w3": [{"id": "x"}],
            "w4": "not a list",
            "__proto__": [task("p", "shell")]
        }});
        json["background"]["w2"][6]["type"] = Value::from(3);
        let s = SavedState::from_json(&json.to_string()).unwrap();
        let w1 = &s.background["w1"];
        assert_eq!(w1.len(), MAX_TASKS);
        assert_eq!(w1[0].id, "b3");
        let w2: Vec<(&str, TaskType)> = s.background["w2"]
            .iter()
            .map(|t| (t.id.as_str(), t.kind))
            .collect();
        assert_eq!(
            w2,
            [
                ("kept", TaskType::Other),
                ("cloud", TaskType::CloudSession),
                ("mcp", TaskType::McpTask),
                ("pid", TaskType::Shell),
                ("null pid", TaskType::Shell)
            ]
        );
        assert_eq!(s.background["w2"][3].pid, Some(4242));
        assert_eq!(s.background["w2"][4].pid, None);
        assert_eq!(s.background.keys().collect::<Vec<_>>(), ["w1", "w2"]);
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(out["background"]["w2"][0]["type"], "other");
        assert_eq!(out["background"]["w2"][1]["type"], "cloud session");
        assert_eq!(out["background"]["w2"][3]["pid"], 4242);
        assert!(out["background"]["w2"][4].get("pid").is_none());
        let empty = serde_json::to_value(SavedState::default()).unwrap();
        assert!(empty.get("background").is_none());
    }

    #[test]
    fn reads_and_writes_the_project_filter_beside_the_mode() {
        let s = SavedState::from_json(r#"{"ui": {"filter": "/dev/app", "mode": "all"}}"#).unwrap();
        assert_eq!(s.ui.filter.as_deref(), Some("/dev/app"));
        let bad = SavedState::from_json(r#"{"ui": {"filter": 3, "mode": "projects"}}"#).unwrap();
        assert_eq!(
            (bad.ui.filter, bad.ui.mode),
            (None, Some(ViewMode::Projects))
        );
        let mut s = SavedState::default();
        assert!(s.set_entry("ui.filter", Some(&Value::from("other"))));
        assert_eq!(s.ui.filter.as_deref(), Some("other"));
        assert!(s.shows_entry("ui.filter", Some(&Value::from("other"))));
        assert!(
            !s.set_entry("ui.filter", Some(&Value::from(3))),
            "a key is a string"
        );
        assert!(s.set_entry("ui.filter", None));
        assert_eq!(s.ui.filter, None);
        let written = serde_json::to_value(&s.ui).unwrap();
        assert!(written.get("filter").is_none(), "no filter writes no key");
    }

    #[test]
    fn keeps_the_rest_of_the_file_when_one_field_is_bad() {
        let json = r#"{"ui": {"mode": "lanes", "collapsed": {"quiet": 1}},
            "poll": {"okEpoch": "x"}, "ownPrs": null, "names": 3,
            "dismissed": {"w1": {"a1": 500}}}"#;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.ui.mode, None);
        assert_eq!(s.ui.collapsed.get("quiet"), Some(&1.0));
        assert_eq!(s.poll.and_then(|p| p.ok_epoch), None);
        assert!(s.own_prs.is_empty() && s.names.is_empty());
        assert_eq!(s.dismissed.len(), 1);
    }

    #[test]
    fn reads_a_file_from_when_merged_cards_had_keep() {
        let json = r#"{"mergeKept": {"w1": 5}, "projectOverride": {"w2": "alpha"}}"#;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(
            s.project_override.get("w2").map(String::as_str),
            Some("alpha")
        );
        let mut s = s;
        assert!(!s.set_entry("mergeKept.w1", Some(&Value::from(5))));
    }

    #[test]
    fn builds_the_persist_url() {
        let v = Value::from("/dev/app-two");
        assert_eq!(
            persist_url("projectOverride.a", Some(&v), ""),
            "cmux-cockpit://set?key=projectOverride.a&value=%22%2Fdev%2Fapp-two%22"
        );
        assert_eq!(
            persist_url("dismissed.w", None, "t k"),
            "cmux-cockpit://set?key=dismissed.w&token=t%20k"
        );
    }

    #[test]
    fn reads_a_move_past_the_context_tail() {
        let ctx = r#"⟦ctx {"epoch":5,"used":18,"hour":10}⟧"#;
        let d = format!(r#"go ⟦move {{"epoch":1}}⟧ {ctx}"#);
        assert!(is_move_description(Some(&d)));
        assert_eq!(
            move_of_description(Some(&d)).map(|m| m.text),
            Some("go".into())
        );
        assert_eq!(
            without_context(&format!("Ship checklist {ctx}")),
            "Ship checklist"
        );
        assert_eq!(without_context(ctx), "");
        assert!(!is_move_description(Some(ctx)));
        assert_eq!(without_context("plain words"), "plain words");
        let tricky = r#"check ⟦ctx {used} parsing ⟦move {"epoch":1}⟧"#;
        assert_eq!(without_context(tricky), tricky);
        assert!(is_move_description(Some(tricky)));
    }

    #[test]
    fn round_trips_a_move_through_a_description() {
        let m = SavedMove {
            text: "reply \"1a\".".into(),
            epoch: 1000.0,
            session: Some("s".into()),
            decisions: Some(1.0),
            ..SavedMove::default()
        };
        let d = move_description(&m);
        assert!(is_move_description(Some(&d)));
        assert_eq!(move_of_description(Some(&d)), Some(m));
        assert_eq!(move_of_description(Some("plain words")), None);
        assert!(!is_move_description(None));
    }

    #[test]
    fn writes_a_moves_fields_in_the_order_the_typescript_does() {
        let m = SavedMove {
            text: "go".into(),
            epoch: 1000.0,
            session: Some("s".into()),
            decisions: Some(1.0),
            ..SavedMove::default()
        };
        assert_eq!(
            move_description(&m),
            r#"go ⟦move {"epoch":1000,"session":"s","decisions":1}⟧"#
        );
    }

    #[test]
    fn round_trips_an_unlabelled_move() {
        let d = r##"Reply with the letter. ⟦move {"epoch":1,"unlabelled":true}⟧"##;
        let m = move_of_description(Some(d));
        assert_eq!(m.as_ref().and_then(|m| m.unlabelled), Some(true));
        assert_eq!(m.map(|m| move_description(&m)).as_deref(), Some(d));
    }

    #[test]
    fn round_trips_a_move_that_asks_nothing() {
        let d = r##"Still waiting on CI. ⟦move {"epoch":1,"unlabelled":true,"noAsk":true}⟧"##;
        let m = move_of_description(Some(d));
        assert_eq!(m.as_ref().and_then(|m| m.no_ask), Some(true));
        assert_eq!(m.map(|m| move_description(&m)).as_deref(), Some(d));
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"noAsk":false}⟧"##)),
            None
        );
        let saved = SavedState::from_json(
            r#"{"moves": {"w1": {"text": "go", "epoch": 1, "unlabelled": true, "noAsk": true}}}"#,
        );
        assert_eq!(
            saved
                .ok()
                .and_then(|s| s.moves.get("w1").and_then(|m| m.no_ask)),
            Some(true)
        );
    }

    #[test]
    fn round_trips_a_models_verdict() {
        for (word, verdict) in [("waits", MoveVerdict::Waits), ("quiet", MoveVerdict::Quiet)] {
            let d = format!(r#"go ⟦move {{"epoch":1,"unlabelled":true,"verdict":"{word}"}}⟧"#);
            let m = move_of_description(Some(&d));
            assert_eq!(m.as_ref().and_then(|m| m.verdict), Some(verdict));
            assert_eq!(m.map(|m| move_description(&m)), Some(d));
            let saved = SavedState::from_json(&format!(
                r#"{{"moves": {{"w1": {{"text": "go", "epoch": 1, "verdict": "{word}"}}}}}}"#
            ));
            assert_eq!(
                saved
                    .ok()
                    .and_then(|s| s.moves.get("w1").and_then(|m| m.verdict)),
                Some(verdict)
            );
        }
        for bad in [r#""maybe""#, "true", "1"] {
            let d = format!(r#"go ⟦move {{"epoch":1,"verdict":{bad}}}⟧"#);
            assert_eq!(move_of_description(Some(&d)), None, "{bad}");
        }
        let saved = SavedState::from_json(
            r#"{"moves": {"w1": {"text": "go", "epoch": 1, "verdict": "maybe"}}}"#,
        );
        assert!(saved.is_ok_and(|s| s.moves.is_empty()));
    }

    #[test]
    fn refuses_a_move_with_a_bad_field() {
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"idle":false}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"unlabelled":false}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"session":null}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"decisions":10}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##" go ⟦move {"epoch":1}⟧"##)),
            None
        );
        assert!(move_of_description(Some(r##"go ⟦move {"epoch":1,"leans":"1b 2a"}⟧"##)).is_some());
    }
}
