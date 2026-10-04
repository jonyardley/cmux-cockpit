//! What cmux hands the sidebar each frame, mirroring src/renderer.d.ts.
//! There is no published schema (issue #7), so every field is optional and
//! a missing one reads as its default. A null in a list (an agent, a
//! subagent run) is kept as None, since the TypeScript skips each one where
//! it reads the list.

use serde::Deserialize;

/// An agent's status as cmux sends it. A status this port does not know
/// reads as `Unknown`, ranked below every known one, rather than failing
/// the whole frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    NeedsInput,
    Working,
    Idle,
    Ended,
    #[serde(other)]
    Unknown,
}

/// A pull request's state as cmux sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrStatus {
    Open,
    Merged,
    Closed,
    #[serde(other)]
    Unknown,
}

/// A subagent run nested under an agent session.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubagentRun {
    pub id: Option<String>,
    pub label: Option<String>,
    pub running: Option<bool>,
    pub started_epoch: Option<f64>,
    pub ended_epoch: Option<f64>,
}

/// One agent session in a workspace.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Agent {
    /// For Claude Code, the session id.
    pub id: String,
    pub status: Option<AgentStatus>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub surface_id: Option<String>,
    pub transcript_path: Option<String>,
    /// Epoch seconds the current status began.
    pub since_epoch: Option<f64>,
    /// Epoch seconds of the agent's latest activity.
    pub last_activity_at: Option<f64>,
    /// Subagent runs under this session, oldest first.
    pub children: Option<Vec<Option<SubagentRun>>>,
}

impl Agent {
    /// The subagent runs cmux sent, skipping holes.
    pub fn child_runs(&self) -> impl Iterator<Item = &SubagentRun> {
        self.children.iter().flatten().flatten()
    }
}

/// A pull request as cmux (or the saved state) describes it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct PullRequest {
    pub url: Option<String>,
    pub number: Option<f64>,
    pub status: Option<PrStatus>,
    pub draft: Option<bool>,
    pub mergeable: Option<bool>,
    pub conflicts: Option<bool>,
    pub title: Option<String>,
    pub additions: Option<f64>,
    pub deletions: Option<f64>,
    pub label: Option<String>,
    pub branch: Option<String>,
    pub stale: Option<bool>,
}

/// A progress bar.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Progress {
    pub value: Option<f64>,
    pub label: Option<String>,
}

/// One cmux workspace.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub title: Option<String>,
    pub directory: Option<String>,
    pub selected: Option<bool>,
    pub pinned: Option<bool>,
    pub unread: Option<f64>,
    /// The workspace group's id, when it is in one.
    pub group: Option<String>,
    pub branch: Option<String>,
    pub dirty: Option<bool>,
    pub latest_message: Option<String>,
    pub latest_prompt: Option<String>,
    pub description: Option<String>,
    pub latest_at: Option<f64>,
    pub agents: Option<Vec<Option<Agent>>>,
    pub pr: Option<PullRequest>,
    pub prs: Option<Vec<PullRequest>>,
    pub progress: Option<Progress>,
    pub ports: Option<Vec<f64>>,
}

impl Workspace {
    /// The agents cmux sent, skipping holes.
    pub fn agent_list(&self) -> impl Iterator<Item = &Agent> {
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
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: Option<String>,
    pub anchor_id: Option<String>,
    pub collapsed: Option<bool>,
}

/// One frame of cmux data: what `data.*()` returns in the renderer.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Data {
    /// The app clock in epoch seconds (`data.clock().epoch`).
    pub epoch: Option<f64>,
    pub groups: Option<Vec<WorkspaceGroup>>,
    pub selected_id: Option<String>,
    pub workspaces: Option<Vec<Workspace>>,
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
        assert_eq!(a.status, Some(AgentStatus::Unknown));
        assert_eq!(a.child_runs().count(), 0);
        assert!(data.group_list().is_empty());
    }
}
