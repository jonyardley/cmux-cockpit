//! What cmux hands the sidebar each frame, mirroring src/renderer.d.ts.
//! There is no published schema (issue #7), so every field is optional and
//! a missing one reads as its default. Each field is read on its own
//! (lenient.rs): a value of the wrong type reads as missing rather than
//! failing the frame, as the TypeScript would only misread that field. A
//! null in the agents or children list is kept as a hole, since the
//! TypeScript skips each one where it reads the list.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// An agent's status as cmux sends it. A status this port does not know
/// keeps cmux's own word, ranked below every known one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentStatus {
    NeedsInput,
    Working,
    Idle,
    Ended,
    Other(String),
}

impl AgentStatus {
    /// The status as cmux names it.
    pub fn as_str(&self) -> &str {
        match self {
            AgentStatus::NeedsInput => "needs_input",
            AgentStatus::Working => "working",
            AgentStatus::Idle => "idle",
            AgentStatus::Ended => "ended",
            AgentStatus::Other(s) => s,
        }
    }
}

/// Written as cmux's own word, so it reads back as it was sent.
impl Serialize for AgentStatus {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AgentStatus {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.as_str() {
            "needs_input" => AgentStatus::NeedsInput,
            "working" => AgentStatus::Working,
            "idle" => AgentStatus::Idle,
            "ended" => AgentStatus::Ended,
            _ => AgentStatus::Other(s),
        })
    }
}

/// A pull request's state as cmux sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrStatus {
    Open,
    Merged,
    Closed,
    #[serde(other)]
    Unknown,
}

/// A subagent run nested under an agent session.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubagentRun {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub id: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub label: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub running: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub started_epoch: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub ended_epoch: Option<f64>,
}

/// One agent session in a workspace.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Agent {
    /// For Claude Code, the session id.
    #[serde(deserialize_with = "crate::lenient::field")]
    pub id: String,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub status: Option<AgentStatus>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub name: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub title: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub surface_id: Option<String>,
    /// The title of the tab (cmux surface) it runs in, as the runner reads
    /// it from cmux's tree; not cmux's own `title`, which names the agent.
    #[serde(deserialize_with = "crate::lenient::field")]
    pub tab_title: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub transcript_path: Option<String>,
    /// Epoch seconds the current status began.
    #[serde(deserialize_with = "crate::lenient::field")]
    pub since_epoch: Option<f64>,
    /// Epoch seconds of the agent's latest activity.
    #[serde(deserialize_with = "crate::lenient::field")]
    pub last_activity_at: Option<f64>,
    /// Subagent runs under this session, oldest first.
    #[serde(deserialize_with = "crate::lenient::slots")]
    pub children: Option<Vec<Option<SubagentRun>>>,
    /// The session ids the same Claude process ran under before this one,
    /// newest first, from the runner's memory of Agent View: `/clear`
    /// starts a new session in the same process, and work saved under the
    /// old id is still this chat's (`crate::owner`). cmux never sends it.
    #[serde(
        deserialize_with = "crate::lenient::list",
        skip_serializing_if = "Option::is_none"
    )]
    pub earlier_sessions: Option<Vec<String>>,
    /// Why and since when the session stopped without handing back, from
    /// the runner's join (stopped.rs). cmux never sends it.
    #[serde(
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub stopped: Option<crate::stopped::Stop>,
    /// What is wrong with its workspace's PR's CI, while that waits on
    /// Jon with nobody on it (ci_wait.rs): set by the core on the agent as
    /// the sidebars show it, never by cmux or the runner.
    #[serde(
        deserialize_with = "crate::lenient::field",
        skip_serializing_if = "Option::is_none"
    )]
    pub ci: Option<crate::ci_wait::CiTrouble>,
}

impl Agent {
    /// The subagent runs cmux sent, skipping holes.
    pub fn child_runs(&self) -> impl Iterator<Item = &SubagentRun> {
        self.children.iter().flatten().flatten()
    }
}

/// A pull request as cmux (or the saved state) describes it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct PullRequest {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub url: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub number: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub status: Option<PrStatus>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub draft: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub mergeable: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub conflicts: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub title: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub additions: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub deletions: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub label: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub branch: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub stale: Option<bool>,
}

/// A progress bar.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Progress {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub value: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub label: Option<String>,
}

/// One cmux workspace.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub id: String,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub title: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub directory: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub selected: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub pinned: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub unread: Option<f64>,
    /// The workspace group's id, when it is in one.
    #[serde(deserialize_with = "crate::lenient::field")]
    pub group: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub branch: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub dirty: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub latest_message: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub latest_prompt: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub description: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub latest_at: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::slots")]
    pub agents: Option<Vec<Option<Agent>>>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub pr: Option<PullRequest>,
    #[serde(deserialize_with = "crate::lenient::list")]
    pub prs: Option<Vec<PullRequest>>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub progress: Option<Progress>,
    #[serde(deserialize_with = "crate::lenient::list")]
    pub ports: Option<Vec<f64>>,
}

impl Workspace {
    /// Whether cmux has the workspace pinned.
    pub fn is_pinned(&self) -> bool {
        self.pinned == Some(true)
    }

    /// The agents cmux sent, skipping holes.
    pub fn agent_list(&self) -> impl Iterator<Item = &Agent> + Clone {
        self.agents.iter().flatten().flatten()
    }

    /// How many entries the agents list has, holes included, as
    /// `(w.agents ?? []).length` counts them.
    pub fn agent_slots(&self) -> usize {
        self.agents.as_ref().map_or(0, Vec::len)
    }

    /// The group id, when set and not empty: `!w.group` reads "" as none.
    pub fn group_id(&self) -> Option<&str> {
        self.group.as_deref().filter(|g| !g.is_empty())
    }
}

/// A cmux workspace group.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceGroup {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub id: String,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub name: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub anchor_id: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub collapsed: Option<bool>,
}

/// A `claude --bg` session's state as Agent View reports it. A state this
/// port does not know keeps Claude Code's own word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundState {
    Working,
    Blocked,
    Done,
    Failed,
    Stopped,
    Other(String),
}

impl BackgroundState {
    /// The state as Claude Code names it.
    pub fn as_str(&self) -> &str {
        match self {
            BackgroundState::Working => "working",
            BackgroundState::Blocked => "blocked",
            BackgroundState::Done => "done",
            BackgroundState::Failed => "failed",
            BackgroundState::Stopped => "stopped",
            BackgroundState::Other(s) => s,
        }
    }

    /// Whether the session still runs. Working and blocked (waiting on
    /// a permission or a question) run; done, failed and stopped have
    /// settled. These five are every word Claude Code 2.1.322 writes in
    /// `state`; "idle" is never one of them, it is the separate process
    /// `status` a live session also carries, and a session that finished
    /// its turn reads `done` while its process waits. A word this port
    /// does not know, from a later Claude Code, counts as running: the
    /// card must never say Idle while work runs, and Agent View drops a
    /// session with no live process unless it is working or blocked.
    pub fn runs(&self) -> bool {
        !matches!(
            self,
            BackgroundState::Done | BackgroundState::Failed | BackgroundState::Stopped
        )
    }
}

/// Written as Claude Code's own word, so it reads back as it was sent.
impl Serialize for BackgroundState {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for BackgroundState {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.as_str() {
            "working" => BackgroundState::Working,
            "blocked" => BackgroundState::Blocked,
            "done" => BackgroundState::Done,
            "failed" => BackgroundState::Failed,
            "stopped" => BackgroundState::Stopped,
            _ => BackgroundState::Other(s),
        })
    }
}

/// One `claude --bg` session from `claude agents --json`. It runs
/// detached, in no tab, and names no parent, so it belongs to no
/// workspace or agent here; the hooks save the short id `claude --bg`
/// prints to tie it to a chat.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundSession {
    /// The short id `claude --bg` prints (8 hex characters).
    #[serde(deserialize_with = "crate::lenient::field")]
    pub id: String,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub state: Option<BackgroundState>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub cwd: Option<String>,
    /// Epoch seconds the session started.
    #[serde(deserialize_with = "crate::lenient::field")]
    pub started_epoch: Option<f64>,
}

impl BackgroundSession {
    /// Whether `id` names this session, by its short id or its session id.
    fn is(&self, id: &str) -> bool {
        !id.is_empty() && (self.id == id || self.session_id.as_deref() == Some(id))
    }

    /// Whether it still runs; a session with no state reads as running,
    /// as an unknown one does (`BackgroundState::runs`).
    pub fn runs(&self) -> bool {
        self.state.as_ref().is_none_or(BackgroundState::runs)
    }
}

/// One frame of cmux data: what `data.*()` returns in the renderer.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Data {
    /// The app clock in epoch seconds (`data.clock().epoch`).
    #[serde(deserialize_with = "crate::lenient::field")]
    pub epoch: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::list")]
    pub groups: Option<Vec<WorkspaceGroup>>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub selected_id: Option<String>,
    #[serde(deserialize_with = "crate::lenient::list")]
    pub workspaces: Option<Vec<Workspace>>,
    /// Every `claude --bg` session Agent View lists, from the runner; cmux
    /// never sends it. Left out when there are none.
    #[serde(
        deserialize_with = "crate::lenient::list",
        skip_serializing_if = "Option::is_none"
    )]
    pub background_sessions: Option<Vec<BackgroundSession>>,
}

impl Data {
    /// Every group, none when cmux sent no list.
    pub fn group_list(&self) -> &[WorkspaceGroup] {
        self.groups.as_deref().unwrap_or_default()
    }

    /// Every workspace, in tab order; none when cmux sent no list.
    pub fn workspace_list(&self) -> &[Workspace] {
        self.workspaces.as_deref().unwrap_or_default()
    }

    /// The workspace with this id.
    pub fn ws_by_id(&self, id: &str) -> Option<&Workspace> {
        self.workspace_list().iter().find(|w| w.id == id)
    }

    /// Every `claude --bg` session Agent View lists; none when the runner
    /// sent no list.
    pub fn background_list(&self) -> &[BackgroundSession] {
        self.background_sessions.as_deref().unwrap_or_default()
    }

    /// Whether the `claude --bg` session named `id` (its short id or its
    /// session id) still runs. One gone from Agent View has settled, as
    /// has one done, failed or stopped.
    pub fn background_runs(&self, id: &str) -> bool {
        self.background_list().iter().any(|s| s.is(id) && s.runs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_frame_with_holes_nulls_and_unknown_values() {
        let json = r#"{"epoch": 10, "workspaces": [{"id": "w", "group": null,
            "agents": [null, {"id": "a", "status": "thinking", "children": [null]}]}]}"#;
        let data: Data = serde_json::from_str(json).unwrap();
        let w = &data.workspace_list()[0];
        assert_eq!(w.group_id(), None);
        assert_eq!(w.agent_slots(), 2);
        let a = w.agent_list().next().unwrap();
        assert_eq!(a.status, Some(AgentStatus::Other("thinking".into())));
        assert_eq!(a.child_runs().count(), 0);
        assert!(data.group_list().is_empty());
    }

    #[test]
    fn reads_a_value_of_the_wrong_type_as_missing_not_the_frame_as_bad() {
        let json = r#"{"epoch": 10, "groups": "nope", "workspaces": [7, {"id": "w",
            "unread": "3", "ports": [3000, null], "prs": [null, {"number": 4}],
            "agents": [{"id": null, "status": 5}]}]}"#;
        let data: Data = serde_json::from_str(json).unwrap();
        assert!(data.groups.is_none());
        let w = &data.workspace_list()[0];
        assert_eq!(w.id, "w");
        assert_eq!(w.unread, None);
        assert_eq!(w.ports, Some(vec![3000.0]));
        assert_eq!(w.prs.as_ref().map(Vec::len), Some(1));
        let a = w.agent_list().next().unwrap();
        assert_eq!((a.id.as_str(), &a.status), ("", &None));
    }

    #[test]
    fn a_frame_written_out_reads_back_the_same() {
        let json = r#"{"epoch": 10, "selectedId": "w", "groups": [{"id": "g", "anchorId": "w"}],
            "workspaces": [{"id": "w", "group": "g", "ports": [3000],
            "agents": [null, {"id": "a", "status": "thinking", "children": [null, {"id": "s"}]},
                       {"id": "b", "status": "needs_input"}],
            "pr": {"number": 4, "status": "draft_ish"}}]}"#;
        let data: Data = serde_json::from_str(json).unwrap();
        let written = serde_json::to_value(&data).unwrap();
        assert_eq!(written["workspaces"][0]["agents"][1]["status"], "thinking");
        assert_eq!(
            written["workspaces"][0]["agents"][2]["status"],
            "needs_input"
        );
        assert_eq!(
            written["workspaces"][0]["agents"][0],
            serde_json::Value::Null
        );
        let back: Data = serde_json::from_value(written).unwrap();
        assert_eq!(back, data);
        assert_eq!(back.workspace_list()[0].agent_slots(), 3);
    }

    fn bg(id: &str, session: &str, state: Option<BackgroundState>) -> BackgroundSession {
        BackgroundSession {
            id: id.to_string(),
            session_id: Some(session.to_string()),
            state,
            ..BackgroundSession::default()
        }
    }

    fn with_bg(sessions: Vec<BackgroundSession>) -> Data {
        Data {
            background_sessions: Some(sessions),
            ..Data::default()
        }
    }

    #[test]
    fn working_and_blocked_background_sessions_run_and_the_rest_have_settled() {
        use BackgroundState::*;
        let cases = [
            (Working, true),
            (Blocked, true),
            (Done, false),
            (Failed, false),
            (Stopped, false),
        ];
        for (state, runs) in cases {
            let data = with_bg(vec![bg("5e5e5e5e", "sess", Some(state.clone()))]);
            assert_eq!(
                data.background_runs("5e5e5e5e"),
                runs,
                "{state:?} by short id"
            );
            assert_eq!(
                data.background_runs("sess"),
                runs,
                "{state:?} by session id"
            );
        }
    }

    #[test]
    fn an_unknown_or_missing_background_state_counts_as_running() {
        // A word a later Claude Code adds keeps counting rather than let
        // the card say Idle while work may run; leaving Agent View still
        // settles it.
        let data = with_bg(vec![
            bg("aaaa", "s-a", Some(BackgroundState::Other("parked".into()))),
            bg("bbbb", "s-b", None),
        ]);
        assert!(data.background_runs("aaaa"));
        assert!(data.background_runs("s-b"));
    }

    #[test]
    fn a_background_session_gone_from_agent_view_has_settled() {
        let data = with_bg(vec![bg("aaaa", "s-a", Some(BackgroundState::Working))]);
        assert!(!data.background_runs("bbbb"));
        assert!(!data.background_runs("aaa"), "no match on part of an id");
        assert!(!data.background_runs(""));
        assert!(!Data::default().background_runs("aaaa"), "no list at all");
        let nameless = with_bg(vec![BackgroundSession {
            state: Some(BackgroundState::Working),
            ..BackgroundSession::default()
        }]);
        assert!(!nameless.background_runs(""));
    }

    #[test]
    fn background_sessions_read_back_the_same_and_are_left_out_when_none() {
        let mut first = bg("aaaa", "s-a", Some(BackgroundState::Other("queued".into())));
        first.cwd = Some("/w".into());
        first.started_epoch = Some(1_794_459_510.38);
        let data = with_bg(vec![first, bg("bbbb", "s-b", Some(BackgroundState::Done))]);
        let written = serde_json::to_value(&data).unwrap();
        assert_eq!(written["backgroundSessions"][0]["sessionId"], "s-a");
        assert_eq!(written["backgroundSessions"][0]["state"], "queued");
        assert_eq!(
            written["backgroundSessions"][1]["startedEpoch"],
            serde_json::Value::Null
        );
        let back: Data = serde_json::from_value(written).unwrap();
        assert_eq!(back, data);

        let none = serde_json::to_value(Data::default()).unwrap();
        assert!(none.get("backgroundSessions").is_none());
    }

    #[test]
    fn a_background_entry_that_does_not_fit_is_dropped_not_the_frame() {
        let json = r#"{"backgroundSessions": [7, {"id": "aaaa", "state": 3},
            {"id": "bbbb", "state": "working", "startedEpoch": "soon"}]}"#;
        let data: Data = serde_json::from_str(json).unwrap();
        let list = data.background_list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].state, None);
        assert_eq!(list[1].started_epoch, None);
        assert!(data.background_runs("bbbb"));
    }
}
