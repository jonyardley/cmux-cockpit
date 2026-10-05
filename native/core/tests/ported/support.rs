//! Fixture builders for the ported TypeScript cases, after
//! test/support/fixtures.ts: only the fields a test cares about.

use std::path::PathBuf;

use cockpit_core::data::{
    Agent, AgentStatus, Data, PrStatus, Progress, PullRequest, SubagentRun, Workspace,
    WorkspaceGroup,
};
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use cockpit_core::session::{Outbound, Param, Session};

pub use AgentStatus::{Ended, Idle, NeedsInput, Working};

/// Hands out agent ids "a1", "a2", ... as the TypeScript fixture does.
#[derive(Default)]
pub struct Fx {
    next: u32,
}

impl Fx {
    pub fn agent(&mut self, status: AgentStatus) -> Agent {
        self.next += 1;
        Agent {
            id: format!("a{}", self.next),
            status: Some(status),
            ..Agent::default()
        }
    }
}

/// An agent with no status, as cmux may send one.
pub fn bare_agent(id: &str) -> Agent {
    Agent {
        id: id.to_string(),
        ..Agent::default()
    }
}

/// Builder steps for an agent.
pub trait AgentExt {
    fn id(self, id: &str) -> Self;
    fn since(self, at: f64) -> Self;
    fn activity(self, at: f64) -> Self;
    fn kind(self, kind: &str) -> Self;
    fn children(self, runs: Vec<Option<SubagentRun>>) -> Self;
}

impl AgentExt for Agent {
    fn id(mut self, id: &str) -> Self {
        self.id = id.to_string();
        self
    }
    fn since(mut self, at: f64) -> Self {
        self.since_epoch = Some(at);
        self
    }
    fn activity(mut self, at: f64) -> Self {
        self.last_activity_at = Some(at);
        self
    }
    fn kind(mut self, kind: &str) -> Self {
        self.kind = Some(kind.to_string());
        self
    }
    fn children(mut self, runs: Vec<Option<SubagentRun>>) -> Self {
        self.children = Some(runs);
        self
    }
}

/// A subagent run cmux sends.
pub fn run(id: &str, running: Option<bool>, ended: Option<f64>) -> Option<SubagentRun> {
    Some(SubagentRun {
        id: Some(id.to_string()),
        running,
        ended_epoch: ended,
        ..SubagentRun::default()
    })
}

/// A workspace titled after its id.
pub fn ws(id: &str) -> Workspace {
    Workspace {
        id: id.to_string(),
        title: Some(id.to_string()),
        ..Workspace::default()
    }
}

/// Builder steps for a workspace.
pub trait WsExt {
    fn title(self, t: &str) -> Self;
    fn group(self, g: &str) -> Self;
    fn agents(self, agents: Vec<Agent>) -> Self;
    fn directory(self, d: &str) -> Self;
    fn latest_at(self, at: f64) -> Self;
    fn unread(self, n: f64) -> Self;
    fn selected(self) -> Self;
    fn description(self, d: &str) -> Self;
    fn message(self, m: &str) -> Self;
    fn prompt(self, p: &str) -> Self;
    fn progress(self, p: Option<Progress>) -> Self;
    fn branch(self, b: &str) -> Self;
    fn dirty(self) -> Self;
    fn pr(self, pr: PullRequest) -> Self;
    fn ports(self, ports: &[f64]) -> Self;
    fn pinned(self) -> Self;
}

impl WsExt for Workspace {
    fn title(mut self, t: &str) -> Self {
        self.title = Some(t.to_string());
        self
    }
    fn group(mut self, g: &str) -> Self {
        self.group = Some(g.to_string());
        self
    }
    fn agents(mut self, agents: Vec<Agent>) -> Self {
        self.agents = Some(agents.into_iter().map(Some).collect());
        self
    }
    fn directory(mut self, d: &str) -> Self {
        self.directory = Some(d.to_string());
        self
    }
    fn latest_at(mut self, at: f64) -> Self {
        self.latest_at = Some(at);
        self
    }
    fn unread(mut self, n: f64) -> Self {
        self.unread = Some(n);
        self
    }
    fn selected(mut self) -> Self {
        self.selected = Some(true);
        self
    }
    fn description(mut self, d: &str) -> Self {
        self.description = Some(d.to_string());
        self
    }
    fn message(mut self, m: &str) -> Self {
        self.latest_message = Some(m.to_string());
        self
    }
    fn prompt(mut self, p: &str) -> Self {
        self.latest_prompt = Some(p.to_string());
        self
    }
    fn progress(mut self, p: Option<Progress>) -> Self {
        self.progress = p;
        self
    }
    fn branch(mut self, b: &str) -> Self {
        self.branch = Some(b.to_string());
        self
    }
    fn dirty(mut self) -> Self {
        self.dirty = Some(true);
        self
    }
    fn pr(mut self, pr: PullRequest) -> Self {
        self.pr = Some(pr);
        self
    }
    fn ports(mut self, ports: &[f64]) -> Self {
        self.ports = Some(ports.to_vec());
        self
    }
    fn pinned(mut self) -> Self {
        self.pinned = Some(true);
        self
    }
}

/// cmux's own PR: its number and status, the rest unset.
pub fn pr(number: f64, status: Option<PrStatus>) -> PullRequest {
    PullRequest {
        number: Some(number),
        status,
        ..PullRequest::default()
    }
}

/// A workspace group.
pub fn group(id: &str, name: &str) -> WorkspaceGroup {
    WorkspaceGroup {
        id: id.to_string(),
        name: Some(name.to_string()),
        ..WorkspaceGroup::default()
    }
}

/// Builder steps for a group.
pub trait GroupExt {
    fn anchor(self, id: &str) -> Self;
    fn collapsed(self, v: bool) -> Self;
}

impl GroupExt for WorkspaceGroup {
    fn anchor(mut self, id: &str) -> Self {
        self.anchor_id = Some(id.to_string());
        self
    }
    fn collapsed(mut self, v: bool) -> Self {
        self.collapsed = Some(v);
        self
    }
}

/// A frame at `epoch`.
pub fn frame(epoch: f64, groups: Vec<WorkspaceGroup>, workspaces: Vec<Workspace>) -> Data {
    Data {
        epoch: Some(epoch),
        groups: Some(groups),
        selected_id: None,
        workspaces: Some(workspaces),
    }
}

/// The workspace with this id, to change between reads.
pub fn ws_mut<'d>(data: &'d mut Data, id: &str) -> &'d mut Workspace {
    let list = data.workspaces.get_or_insert_with(Vec::new);
    let at = list.iter().position(|w| w.id == id).unwrap();
    &mut list[at]
}

/// The workspace with this id.
pub fn by_id<'d>(data: &'d Data, id: &str) -> &'d Workspace {
    data.ws_by_id(id).unwrap()
}

/// config/projects.example.json, the table the TypeScript tests run on.
pub fn example_projects() -> Vec<Project> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../config/projects.example.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A session on the example table, seeded from a saved state's JSON.
pub fn session(state: &str) -> Session {
    Session::new(example_projects(), SavedState::from_json(state).unwrap())
}

/// A session on the example table with nothing saved.
pub fn fresh() -> Session {
    session("{}")
}

fn param_text(p: &Param) -> String {
    match p {
        Param::Str(s) => s.clone(),
        Param::Num(n) => cockpit_core::js::num_text(*n),
        Param::Bool(b) => b.to_string(),
    }
}

/// The cmux requests made, as (method, [(param, value)]), values as text.
pub fn calls(s: &Session) -> Vec<(String, Vec<(String, String)>)> {
    s.outbox()
        .iter()
        .filter_map(|o| match o {
            Outbound::Cmux { method, params } => Some((
                method.clone(),
                params
                    .iter()
                    .map(|(k, v)| (k.clone(), param_text(v)))
                    .collect(),
            )),
            Outbound::Persist { .. } => None,
        })
        .collect()
}

/// A cmux request as `calls` lists it, from string pairs.
pub fn call(method: &str, params: &[(&str, &str)]) -> (String, Vec<(String, String)>) {
    (
        method.to_string(),
        params
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

/// The cmux methods called, in order.
pub fn methods(s: &Session) -> Vec<String> {
    calls(s).into_iter().map(|(m, _)| m).collect()
}

/// The state writes made, as the URLs the handler reads, with no token.
pub fn opened(s: &Session) -> Vec<String> {
    s.outbox()
        .iter()
        .filter_map(|o| o.persist_url(""))
        .collect()
}

/// The state writes made, as (key, value), the value parsed back.
pub fn sent(s: &Session) -> Vec<(String, Option<serde_json::Value>)> {
    s.outbox()
        .iter()
        .filter_map(|o| match o {
            Outbound::Persist { key, value } => Some((key.clone(), value.clone())),
            Outbound::Cmux { .. } => None,
        })
        .collect()
}
