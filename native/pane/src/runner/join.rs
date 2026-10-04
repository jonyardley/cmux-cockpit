//! The join from the R1.0 spike, without its printing: cmux events, Agent
//! View and the workspace list in, one frame of the core's data out.
//!
//! A Claude process id ties a session to a workspace two ways: `--pid=`
//! and `--tab=` on a `sidebar.metadata.updated` status write (this wins),
//! or `_ppid` and `workspace_id` on an `agent.hook.*` event. The status
//! comes from the session's last hook (cockpit_core::hooks). A session is
//! dropped once it ends or Agent View stops listing its pid.

use std::collections::HashMap;

use cockpit_core::data::{Agent, Data, Workspace};
use cockpit_core::hooks::{Hooked, status_from_hook, status_without_hooks};
use serde_json::Value;

use super::parse::{AgentView, iso_epoch};

/// How the event stream stands, for the pane to show beside the view.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Health {
    /// Why the stream is down, while it is.
    pub down: Option<String>,
    /// The last sequence read.
    pub last_seq: u64,
    /// The sequence the stream's ack said replay runs to.
    pub replay_to: Option<u64>,
}

impl Health {
    /// Replay has reached the sequence the ack named.
    pub fn caught_up(&self) -> bool {
        self.replay_to.is_some_and(|to| self.last_seq >= to)
    }
}

/// What a status change looked like, for the latency log.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub seq: u64,
    pub hook: String,
    /// When cmux says the event happened, in epoch seconds.
    pub at: Option<f64>,
}

/// Everything the runner has learnt from its inputs.
#[derive(Debug, Default)]
pub struct Join {
    pub health: Health,
    workspaces: Option<Vec<Workspace>>,
    selected: Option<String>,
    /// pid to workspace, from a status write.
    tab_of: HashMap<u32, String>,
    /// pid to its latest status-setting hook.
    sessions: HashMap<u32, Hooked>,
    agents: Option<AgentView>,
}

/// A workspace event that can change the list: anything but a prompt.
pub fn changes_workspaces(e: &Value) -> bool {
    e["name"]
        .as_str()
        .is_some_and(|n| n.starts_with("workspace.") && n != "workspace.prompt.submitted")
}

impl Join {
    /// Both polls have answered at least once.
    pub fn loaded(&self) -> bool {
        self.agents.is_some() && self.workspaces.is_some()
    }

    /// The stream's ack: replay runs to `latest_seq`. A connection that
    /// asked from 0 is a fresh start, so what was joined before goes.
    pub fn ack(&mut self, ack: &Value) {
        if ack["resume"]["requested_after_seq"] == 0 {
            self.tab_of.clear();
            self.sessions.clear();
        }
        self.health.replay_to = ack["resume"]["latest_seq"].as_u64();
        self.health.down = None;
    }

    pub fn stream_down(&mut self, why: String) {
        self.health.down = Some(why);
    }

    /// Takes a new Agent View; false when it matches the last one.
    pub fn agents(&mut self, view: AgentView) -> bool {
        if self.agents.as_ref() == Some(&view) {
            return false;
        }
        self.agents = Some(view);
        true
    }

    /// Takes a new workspace list; false when it matches the last one.
    pub fn workspaces(&mut self, list: Vec<Workspace>) -> bool {
        if self.workspaces.as_ref() == Some(&list) {
            return false;
        }
        self.selected = list
            .iter()
            .find(|w| w.selected == Some(true))
            .map(|w| w.id.clone());
        self.workspaces = Some(list);
        true
    }

    /// Applies one event frame. Returns the status change it made, if any,
    /// and whether anything in the frame changed at all.
    pub fn event(&mut self, e: &Value) -> (bool, Option<Change>) {
        if e.get("resume").is_some() {
            self.ack(e);
            return (true, None);
        }
        if e["type"] != "event" {
            return (false, None);
        }
        let seq = e["seq"].as_u64().unwrap_or_default();
        self.health.last_seq = seq;
        let name = e["name"].as_str().unwrap_or_default();
        let p = &e["payload"];
        if name == "sidebar.metadata.updated" {
            return (
                self.status_write(p["args"].as_str().unwrap_or_default()),
                None,
            );
        }
        if name == "workspace.selected" {
            return (self.select(p), None);
        }
        let Some(hook) = name.strip_prefix("agent.hook.") else {
            return (false, None);
        };
        let at = e["occurred_at"].as_str().and_then(iso_epoch);
        if !self.hook(hook, p, seq, at.unwrap_or_default()) {
            return (false, None);
        }
        let change = Change {
            seq,
            hook: hook.to_string(),
            at,
        };
        (true, Some(change))
    }

    fn select(&mut self, p: &Value) -> bool {
        let Some(id) = p["workspace_id"].as_str() else {
            return false;
        };
        if p["selected"] == false || self.selected.as_deref() == Some(id) {
            return false;
        }
        self.selected = Some(id.to_string());
        true
    }

    fn status_write(&mut self, args: &str) -> bool {
        let flag = |key: &str| args.split_whitespace().find_map(|t| t.strip_prefix(key));
        let (Some(tab), Some(pid)) = (flag("--tab="), flag("--pid=").and_then(|s| s.parse().ok()))
        else {
            return false;
        };
        let old = self.tab_of.insert(pid, tab.to_string());
        old.as_deref() != Some(tab)
    }

    /// True when the hook changed the session's status.
    fn hook(&mut self, hook: &str, p: &Value, seq: u64, at: f64) -> bool {
        let Some(ws) = p["workspace_id"].as_str() else {
            return false;
        };
        let Some(pid) = pid_of(&p["_ppid"]) else {
            return false;
        };
        let Some(status) = status_from_hook(hook, p["tool_name"].as_str()) else {
            return false;
        };
        let prev = self.sessions.get(&pid);
        let changed = prev.is_none_or(|s| s.status != status || s.workspace != ws);
        let next = Hooked::after(prev, status, at, seq, ws);
        self.sessions.insert(pid, next);
        changed
    }

    /// A session is gone once Agent View stops listing its pid.
    fn alive(&self, pid: u32) -> bool {
        self.agents
            .as_ref()
            .is_none_or(|a| a.busy.contains_key(&pid))
    }

    /// The workspace a pid sits in: its status write's tab, else its hook's.
    fn placed(&self, pid: u32) -> Option<&str> {
        self.tab_of
            .get(&pid)
            .map(String::as_str)
            .or_else(|| self.sessions.get(&pid).map(|s| s.workspace.as_str()))
    }

    fn agent(&self, pid: u32) -> Option<Agent> {
        let view = self.agents.as_ref();
        let id = view
            .and_then(|a| a.session.get(&pid).cloned())
            .unwrap_or_else(|| format!("pid:{pid}"));
        let mut a = Agent {
            id,
            kind: Some("claude".to_string()),
            ..Agent::default()
        };
        match self.sessions.get(&pid) {
            Some(s) => {
                a.status = Some(s.status.clone());
                a.since_epoch = Some(s.since).filter(|t| *t > 0.0);
                a.last_activity_at = Some(s.last_activity).filter(|t| *t > 0.0);
            }
            None => {
                let busy = view.and_then(|v| v.busy.get(&pid).copied());
                a.status = Some(status_without_hooks(busy)?);
            }
        }
        Some(a)
    }

    /// Every live session, grouped by workspace, oldest pid first so the
    /// order holds still between frames.
    fn agents_by_workspace(&self) -> HashMap<&str, Vec<Agent>> {
        let mut pids: Vec<u32> = self
            .sessions
            .keys()
            .chain(self.tab_of.keys())
            .copied()
            .collect();
        pids.sort_unstable();
        pids.dedup();
        let mut out: HashMap<&str, Vec<Agent>> = HashMap::new();
        for pid in pids {
            let ended = self
                .sessions
                .get(&pid)
                .is_some_and(|s| s.status == cockpit_core::data::AgentStatus::Ended);
            if ended || !self.alive(pid) {
                continue;
            }
            let (Some(ws), Some(agent)) = (self.placed(pid), self.agent(pid)) else {
                continue;
            };
            out.entry(ws).or_default().push(agent);
        }
        out
    }

    /// One frame of the core's data at epoch `now`. A session placed in a
    /// workspace the list does not have is left out.
    pub fn frame(&self, now: f64) -> Data {
        let mut by_ws = self.agents_by_workspace();
        let workspaces = self.workspaces.as_ref().map(|list| {
            list.iter()
                .map(|w| {
                    let mut w = w.clone();
                    w.selected = Some(self.selected.as_deref() == Some(w.id.as_str()));
                    let agents = by_ws.remove(w.id.as_str()).unwrap_or_default();
                    w.agents = Some(agents.into_iter().map(Some).collect());
                    w
                })
                .collect()
        });
        Data {
            epoch: Some(now),
            groups: None,
            selected_id: self.selected.clone(),
            workspaces,
        }
    }
}

/// `_ppid` arrives as a number, or as a string from some hook writers.
fn pid_of(v: &Value) -> Option<u32> {
    let n = match v {
        Value::Number(n) => n.as_u64()?,
        Value::String(s) => s.parse().ok()?,
        _ => return None,
    };
    u32::try_from(n).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::data::AgentStatus;
    use serde_json::json;

    fn ack(after: u64, latest: u64) -> Value {
        json!({"boot_id": "B", "type": "ack",
               "resume": {"requested_after_seq": after, "latest_seq": latest}})
    }

    fn hook(seq: u64, name: &str, pid: u32, ws: &str, tool: Option<&str>) -> Value {
        json!({"type": "event", "seq": seq, "name": format!("agent.hook.{name}"),
               "occurred_at": "1970-01-01T00:01:40Z",
               "payload": {"_ppid": pid, "workspace_id": ws, "tool_name": tool}})
    }

    fn status_write(seq: u64, pid: u32, tab: &str) -> Value {
        json!({"type": "event", "seq": seq, "name": "sidebar.metadata.updated",
               "payload": {"args": format!("claude_code Running --icon=bolt.fill --tab={tab} --pid={pid}")}})
    }

    fn ws(id: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            title: Some(format!("title {id}")),
            ..Workspace::default()
        }
    }

    fn view(pids: &[(u32, bool, &str)]) -> AgentView {
        AgentView {
            busy: pids.iter().map(|(p, b, _)| (*p, *b)).collect(),
            session: pids
                .iter()
                .map(|(p, _, s)| (*p, (*s).to_string()))
                .collect(),
            background: 0,
        }
    }

    /// Each workspace with its agents' ids and statuses.
    type Statuses = Vec<(String, Vec<(String, Option<AgentStatus>)>)>;

    fn statuses(d: &Data) -> Statuses {
        d.workspace_list()
            .iter()
            .map(|w| {
                let agents = w
                    .agent_list()
                    .map(|a| (a.id.clone(), a.status.clone()))
                    .collect();
                (w.id.clone(), agents)
            })
            .collect()
    }

    #[test]
    fn a_hook_places_a_session_and_sets_its_status() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A"), ws("B")]);
        j.agents(view(&[(7, true, "s7")]));
        let (changed, change) = j.event(&hook(5, "PermissionRequest", 7, "B", Some("Bash")));
        assert!(changed);
        let change = change.unwrap();
        assert_eq!(
            (change.seq, change.hook.as_str(), change.at),
            (5, "PermissionRequest", Some(100.0))
        );
        let d = j.frame(200.0);
        assert_eq!(d.epoch, Some(200.0));
        assert_eq!(
            statuses(&d),
            vec![
                ("A".into(), vec![]),
                (
                    "B".into(),
                    vec![("s7".into(), Some(AgentStatus::NeedsInput))]
                )
            ]
        );
        let a = d.ws_by_id("B").unwrap().agent_list().next().unwrap();
        assert_eq!(
            (a.since_epoch, a.last_activity_at),
            (Some(100.0), Some(100.0))
        );
    }

    #[test]
    fn a_status_write_beats_the_hooks_workspace() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A"), ws("B")]);
        j.event(&hook(1, "UserPromptSubmit", 7, "A", None));
        j.event(&status_write(2, 7, "B"));
        let d = j.frame(0.0);
        assert_eq!(d.ws_by_id("A").unwrap().agent_list().count(), 0);
        assert_eq!(d.ws_by_id("B").unwrap().agent_list().count(), 1);
    }

    #[test]
    fn a_hook_that_repeats_the_status_is_not_a_change() {
        let mut j = Join::default();
        assert!(
            j.event(&hook(1, "PreToolUse", 7, "A", Some("Bash")))
                .1
                .is_some()
        );
        assert_eq!(
            j.event(&hook(2, "PostToolUse", 7, "A", Some("Bash"))),
            (false, None)
        );
        assert!(j.event(&hook(3, "Stop", 7, "A", None)).1.is_some());
        assert_eq!(
            j.event(&hook(4, "SubagentStop", 7, "A", None)),
            (false, None)
        );
        assert_eq!(j.health.last_seq, 4);
    }

    #[test]
    fn a_session_with_a_status_write_but_no_hook_takes_agent_view_word() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")]);
        j.event(&status_write(1, 9, "A"));
        assert_eq!(
            statuses(&j.frame(0.0))[0].1,
            vec![],
            "no Agent View yet, no status"
        );
        j.agents(view(&[(9, true, "s9")]));
        assert_eq!(
            statuses(&j.frame(0.0))[0].1,
            vec![("s9".into(), Some(AgentStatus::Working))]
        );
    }

    #[test]
    fn ended_sessions_and_pids_gone_from_agent_view_are_dropped() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")]);
        j.event(&hook(1, "Stop", 7, "A", None));
        j.event(&hook(2, "Stop", 8, "A", None));
        assert_eq!(j.frame(0.0).ws_by_id("A").unwrap().agent_list().count(), 2);
        j.event(&hook(3, "SessionEnd", 7, "A", None));
        let d = j.frame(0.0);
        let ids: Vec<&str> = d
            .ws_by_id("A")
            .unwrap()
            .agent_list()
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["pid:8"],
            "before Agent View the pid stands in for the id"
        );
        j.agents(view(&[]));
        assert_eq!(j.frame(0.0).ws_by_id("A").unwrap().agent_list().count(), 0);
    }

    #[test]
    fn a_fresh_replay_from_zero_forgets_what_was_joined() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")]);
        j.event(&ack(0, 10));
        j.event(&hook(3, "Stop", 7, "A", None));
        j.stream_down("cmux events exited".into());
        assert!(j.health.down.is_some());
        j.event(&ack(3, 10));
        assert_eq!(j.health.down, None, "reconnecting clears the down line");
        assert_eq!(j.frame(0.0).ws_by_id("A").unwrap().agent_list().count(), 1);
        j.event(&ack(0, 2));
        assert_eq!(j.frame(0.0).ws_by_id("A").unwrap().agent_list().count(), 0);
    }

    #[test]
    fn caught_up_once_events_reach_the_acks_sequence() {
        let mut j = Join::default();
        assert!(!j.health.caught_up());
        j.event(&ack(0, 2));
        j.event(&hook(1, "Stop", 7, "A", None));
        assert!(!j.health.caught_up());
        j.event(&hook(2, "Stop", 7, "A", None));
        assert!(j.health.caught_up());
    }

    #[test]
    fn selection_follows_the_list_then_the_event() {
        let mut j = Join::default();
        let mut a = ws("A");
        a.selected = Some(true);
        j.workspaces(vec![a, ws("B")]);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("A"));
        let sel = json!({"type": "event", "seq": 1, "name": "workspace.selected",
                         "payload": {"workspace_id": "B", "selected": true}});
        assert!(j.event(&sel).0);
        let d = j.frame(0.0);
        assert_eq!(d.selected_id.as_deref(), Some("B"));
        assert_eq!(d.ws_by_id("B").unwrap().selected, Some(true));
        assert_eq!(d.ws_by_id("A").unwrap().selected, Some(false));
        assert!(!j.event(&sel).0, "selecting it again changes nothing");
    }

    #[test]
    fn unchanged_polls_are_not_changes() {
        let mut j = Join::default();
        assert!(!j.loaded());
        assert!(j.agents(view(&[(1, true, "s")])));
        assert!(!j.agents(view(&[(1, true, "s")])));
        assert!(j.workspaces(vec![ws("A")]));
        assert!(!j.workspaces(vec![ws("A")]));
        assert!(j.loaded());
    }

    #[test]
    fn reads_a_pid_as_a_number_or_a_string() {
        assert_eq!(pid_of(&json!(9533)), Some(9533));
        assert_eq!(pid_of(&json!("9533")), Some(9533));
        assert_eq!(pid_of(&json!("x")), None);
        assert_eq!(pid_of(&json!(null)), None);
        assert_eq!(pid_of(&json!(u64::MAX)), None);
    }

    #[test]
    fn workspace_events_other_than_prompts_change_the_list() {
        assert!(changes_workspaces(&json!({"name": "workspace.reordered"})));
        assert!(changes_workspaces(&json!({"name": "workspace.action"})));
        assert!(!changes_workspaces(
            &json!({"name": "workspace.prompt.submitted"})
        ));
        assert!(!changes_workspaces(&json!({"name": "agent.hook.Stop"})));
    }

    #[test]
    fn a_session_in_a_workspace_the_list_lacks_is_left_out() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")]);
        j.event(&hook(1, "Stop", 7, "GONE", None));
        let d = j.frame(0.0);
        assert_eq!(d.workspace_list().len(), 1);
        assert_eq!(d.ws_by_id("A").unwrap().agent_list().count(), 0);
    }
}
