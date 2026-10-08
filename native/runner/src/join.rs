//! The join from the R1.0 spike, without its printing: cmux events, Agent
//! View, the workspace list and the workspace groups in, one frame of the
//! core's data out. The groups give each workspace its `group`, as the
//! sidebar's data has it, so cards land in their lanes.
//!
//! A Claude process id ties a session to a workspace two ways: `--pid=`
//! and `--tab=` on a `sidebar.metadata.updated` status write (this wins),
//! or `_ppid` and `workspace_id` on an `agent.hook.*` event. The status
//! comes from the session's last hook (cockpit_core::hooks). A session is
//! hidden once it ends or Agent View stops listing its pid, and forgotten
//! once Agent View has left it out `FORGET_AFTER` times running, so a
//! reused pid starts clean.

use std::collections::HashMap;

use cockpit_core::data::{Agent, Data, Workspace};
use cockpit_core::hooks::{Hooked, moves_activity, status_from_hook, status_without_hooks};
use serde_json::Value;

use super::parse::{AgentView, Groups, iso_epoch};

/// How many Agent Views running may leave a pid out before the join
/// forgets it. More than one, so a new session's first hook is not lost
/// to an Agent View read a moment before it listed the pid.
pub const FORGET_AFTER: u8 = 3;

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

    /// Connected and still replaying what cmux kept.
    pub fn replaying(&self) -> bool {
        self.down.is_none() && self.replay_to.is_some() && !self.caught_up()
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
    groups: Option<Groups>,
    selected: Option<String>,
    /// When the selection event that set `selected` happened, in epoch
    /// seconds: a list asked for before then answers from before it.
    selected_at: Option<f64>,
    /// pid to workspace, from a status write.
    tab_of: HashMap<u32, String>,
    /// pid to its latest status-setting hook.
    sessions: HashMap<u32, Hooked>,
    agents: Option<AgentView>,
    /// pid to how many Agent Views running have left it out.
    absent: HashMap<u32, u8>,
}

/// A workspace event that can change the list: anything but a
/// selection, which the join applies itself. A prompt counts, since the
/// list carries the latest prompt and its time.
pub fn changes_workspaces(e: &Value) -> bool {
    e["name"].as_str().is_some_and(|n| {
        (n.starts_with("workspace.") && n != "workspace.selected")
            || n.starts_with("workspace_group.")
    })
}

impl Join {
    /// Every poll has answered at least once: Agent View, the workspace
    /// list and the groups, so no frame that counts puts every card in
    /// Unsorted.
    pub fn loaded(&self) -> bool {
        self.missing().is_empty()
    }

    /// The polls that have not answered yet, by name.
    pub fn missing(&self) -> Vec<&'static str> {
        let answered = [
            ("Agent View", self.agents.is_some()),
            ("workspace list", self.workspaces.is_some()),
            ("group list", self.groups.is_some()),
        ];
        answered
            .into_iter()
            .filter_map(|(name, done)| (!done).then_some(name))
            .collect()
    }

    /// The stream's ack: replay runs to `latest_seq`. A connection that
    /// asked from 0 is a fresh start, so what was joined before goes.
    pub fn ack(&mut self, ack: &Value) {
        let after = ack["resume"]["requested_after_seq"]
            .as_u64()
            .unwrap_or_default();
        if after == 0 {
            self.tab_of.clear();
            self.sessions.clear();
            self.absent.clear();
            self.health.last_seq = 0;
        } else {
            // Nothing before `after` will come, so a start with --after
            // is caught up once it reaches the ack's latest.
            self.health.last_seq = self.health.last_seq.max(after);
        }
        self.health.replay_to = ack["resume"]["latest_seq"].as_u64();
        self.health.down = None;
    }

    pub fn stream_down(&mut self, why: String) {
        self.health.down = Some(why);
    }

    /// Takes a new Agent View; false when it matches the last one.
    pub fn agents(&mut self, view: AgentView) -> bool {
        self.forget_absent(&view);
        if self.agents.as_ref() == Some(&view) {
            return false;
        }
        self.agents = Some(view);
        true
    }

    /// Takes a new workspace list, asked for at `asked` (epoch seconds);
    /// false when it matches the last one. Its selection wins unless a
    /// selection event happened after it was asked for: cmux answered
    /// from before that event, and the outline would jump back to a
    /// workspace no longer on screen (issue #301). A replayed event
    /// happened before the list was asked for, so the list wins over it.
    pub fn workspaces(&mut self, list: Vec<Workspace>, asked: f64) -> bool {
        if self.workspaces.as_ref() == Some(&list) {
            return false;
        }
        if self.selected_at.is_none_or(|at| at < asked) {
            self.selected = list
                .iter()
                .find(|w| w.selected == Some(true))
                .map(|w| w.id.clone());
        }
        self.workspaces = Some(list);
        true
    }

    /// Takes a fresh group list; false when nothing changed.
    pub fn groups(&mut self, groups: Groups) -> bool {
        if self.groups.as_ref() == Some(&groups) {
            return false;
        }
        self.groups = Some(groups);
        true
    }

    /// Counts the pids this Agent View leaves out, and forgets those it
    /// has left out `FORGET_AFTER` times running. They are hidden already,
    /// so forgetting them changes no frame.
    fn forget_absent(&mut self, view: &AgentView) {
        let mut pids: Vec<u32> = self
            .tab_of
            .keys()
            .chain(self.sessions.keys())
            .copied()
            .collect();
        pids.sort_unstable();
        pids.dedup();
        for pid in pids {
            if view.busy.contains_key(&pid) {
                self.absent.remove(&pid);
                continue;
            }
            let n = self.absent.entry(pid).or_default();
            *n = n.saturating_add(1);
            if *n >= FORGET_AFTER {
                self.absent.remove(&pid);
                self.tab_of.remove(&pid);
                self.sessions.remove(&pid);
            }
        }
    }

    /// Applies one event frame. Returns whether anything in the frame
    /// changed, and the status change it made, if any.
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
            let at = e["occurred_at"].as_str().and_then(iso_epoch);
            return (self.select(p, at), None);
        }
        let Some(hook) = name.strip_prefix("agent.hook.") else {
            return (false, None);
        };
        let at = e["occurred_at"].as_str().and_then(iso_epoch);
        let (changed, status_changed) = self.hook(hook, p, at);
        let change = status_changed.then(|| Change {
            seq,
            hook: hook.to_string(),
            at,
        });
        (changed, change)
    }

    fn select(&mut self, p: &Value, at: Option<f64>) -> bool {
        let Some(id) = p["workspace_id"].as_str() else {
            return false;
        };
        if p["selected"] == false {
            return false;
        }
        self.selected_at = at;
        if self.selected.as_deref() == Some(id) {
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

    /// Whether the hook changed the session at all (a repeated status
    /// still moves its last activity, which picks the workspace's most
    /// active agent), and whether it changed its status or workspace.
    /// A hook with no readable time keeps the session's last activity
    /// rather than wiping it.
    fn hook(&mut self, hook: &str, p: &Value, at: Option<f64>) -> (bool, bool) {
        let Some(ws) = p["workspace_id"].as_str() else {
            return (false, false);
        };
        let Some(pid) = pid_of(&p["_ppid"]) else {
            return (false, false);
        };
        let Some(status) = status_from_hook(hook, p["tool_name"].as_str()) else {
            return (false, false);
        };
        let prev = self.sessions.get(&pid);
        let moved = prev.is_none_or(|s| s.status != status || s.workspace != ws);
        let at = at.or(prev.map(|s| s.last_activity)).unwrap_or_default();
        let next = Hooked::after(prev, status, at, moves_activity(hook), ws);
        let changed = prev != Some(&next);
        self.sessions.insert(pid, next);
        (changed, moved)
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

    fn agent(&self, pid: u32, now: f64) -> Option<Agent> {
        let view = self.agents.as_ref();
        let busy = view.and_then(|v| v.busy.get(&pid).copied());
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
                let (status, since) = s.with_agent_view(busy, now);
                a.status = Some(status);
                a.since_epoch = Some(since).filter(|t| *t > 0.0);
                a.last_activity_at = Some(s.last_activity).filter(|t| *t > 0.0);
            }
            None => {
                a.status = Some(status_without_hooks(busy)?);
            }
        }
        Some(a)
    }

    /// Every live session, grouped by workspace, oldest pid first so the
    /// order holds still between frames.
    fn agents_by_workspace(&self, now: f64) -> HashMap<&str, Vec<Agent>> {
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
            let (Some(ws), Some(agent)) = (self.placed(pid), self.agent(pid, now)) else {
                continue;
            };
            out.entry(ws).or_default().push(agent);
        }
        out
    }

    /// One frame of the core's data at epoch `now`. A session placed in a
    /// workspace the list does not have is left out.
    pub fn frame(&self, now: f64) -> Data {
        let mut by_ws = self.agents_by_workspace(now);
        let workspaces = self.workspaces.as_ref().map(|list| {
            list.iter()
                .map(|w| {
                    let mut w = w.clone();
                    w.group = self
                        .groups
                        .as_ref()
                        .and_then(|g| g.member_of.get(&w.id).cloned());
                    w.selected = Some(self.selected.as_deref() == Some(w.id.as_str()));
                    let agents = by_ws.remove(w.id.as_str()).unwrap_or_default();
                    w.agents = Some(agents.into_iter().map(Some).collect());
                    w
                })
                .collect()
        });
        Data {
            epoch: Some(now),
            groups: self.groups.as_ref().map(|g| g.list.clone()),
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
        j.workspaces(vec![ws("A"), ws("B")], 0.0);
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
        j.workspaces(vec![ws("A"), ws("B")], 0.0);
        j.event(&hook(1, "UserPromptSubmit", 7, "A", None));
        j.event(&status_write(2, 7, "B"));
        let d = j.frame(0.0);
        assert_eq!(d.ws_by_id("A").unwrap().agent_list().count(), 0);
        assert_eq!(d.ws_by_id("B").unwrap().agent_list().count(), 1);
    }

    #[test]
    fn a_hook_that_repeats_the_status_is_not_a_status_change() {
        let mut j = Join::default();
        assert!(
            j.event(&hook(1, "PreToolUse", 7, "A", Some("Bash")))
                .1
                .is_some()
        );
        assert_eq!(
            j.event(&hook(2, "PostToolUse", 7, "A", Some("Bash"))),
            (false, None),
            "same status at the same time changes nothing"
        );
        let later = json!({"type": "event", "seq": 2, "name": "agent.hook.PostToolUse",
                           "occurred_at": "1970-01-01T00:02:00Z",
                           "payload": {"_ppid": 7, "workspace_id": "A"}});
        assert_eq!(
            j.event(&later),
            (true, None),
            "a later hook moves the last activity, but is no status change"
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
        j.workspaces(vec![ws("A")], 0.0);
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
        j.workspaces(vec![ws("A")], 0.0);
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
    fn a_session_in_another_config_dir_shows_once_its_agent_view_is_read() {
        // workspace:14 on 2026-10-05: pid 59557 ran with
        // CLAUDE_CONFIG_DIR=~/.claude-personal, so the default Agent View
        // never listed it and its card read No agent in the pane.
        use crate::parse;
        let mut j = Join::default();
        j.workspaces(vec![ws("A"), ws("B")], 0.0);
        j.event(&status_write(1, 59557, "B"));
        j.event(&hook(2, "PreToolUse", 59557, "B", Some("Bash")));
        let default_dir =
            || parse::agents(br#"[{"pid": 9533, "sessionId": "s9533", "status": "busy"}]"#);
        let personal_dir =
            || parse::agents(br#"[{"pid": 59557, "sessionId": "s59557", "status": "busy"}]"#);
        j.agents(parse::merged(default_dir()));
        assert_eq!(
            statuses(&j.frame(200.0))[1].1,
            vec![],
            "one dir's view hides it"
        );
        j.agents(parse::merged(
            default_dir().into_iter().chain(personal_dir()),
        ));
        assert_eq!(
            statuses(&j.frame(200.0))[1].1,
            vec![("s59557".into(), Some(AgentStatus::Working))]
        );
    }

    #[test]
    fn a_fresh_replay_from_zero_forgets_what_was_joined() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
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
    fn a_replay_from_zero_after_a_restart_is_not_caught_up_at_the_old_sequence() {
        let mut j = Join::default();
        j.event(&ack(0, 500));
        j.event(&hook(500, "Stop", 7, "A", None));
        assert!(j.health.caught_up());
        j.event(&ack(0, 40));
        assert_eq!(j.health.last_seq, 0);
        assert!(j.health.replaying());
    }

    #[test]
    fn a_pid_agent_view_keeps_leaving_out_is_forgotten_so_a_reused_pid_starts_clean() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A"), ws("B")], 0.0);
        j.agents(view(&[(4242, false, "old")]));
        j.event(&status_write(1, 4242, "A"));
        j.event(&hook(2, "PermissionRequest", 4242, "A", None));
        for _ in 0..FORGET_AFTER - 1 {
            j.agents(view(&[]));
        }
        j.agents(view(&[(4242, false, "old")]));
        assert_eq!(
            statuses(&j.frame(0.0))[0].1,
            vec![("old".into(), Some(AgentStatus::NeedsInput))],
            "a pid back before the limit keeps what it had"
        );
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        j.agents(view(&[(4242, false, "new")]));
        j.event(&status_write(3, 4242, "B"));
        let d = statuses(&j.frame(0.0));
        assert_eq!(d[0].1, vec![], "nothing left in A");
        assert_eq!(d[1].1, vec![("new".into(), Some(AgentStatus::Idle))]);
    }

    #[test]
    fn caught_up_once_events_reach_the_acks_sequence() {
        let mut j = Join::default();
        assert!(!j.health.caught_up());
        j.event(&ack(0, 2));
        j.event(&hook(1, "Stop", 7, "A", None));
        assert!(!j.health.caught_up());
        assert!(j.health.replaying());
        j.event(&hook(2, "Stop", 7, "A", None));
        assert!(j.health.caught_up());
        assert!(!j.health.replaying());
    }

    #[test]
    fn selection_follows_the_list_then_the_event() {
        let mut j = Join::default();
        let mut a = ws("A");
        a.selected = Some(true);
        j.workspaces(vec![a, ws("B")], 0.0);
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

    fn selected(id: &str) -> Workspace {
        Workspace {
            selected: Some(true),
            ..ws(id)
        }
    }

    /// A selection of `id` that cmux says happened at second `at` of 1970.
    fn select_at(id: &str, at: u8) -> Value {
        json!({"type": "event", "seq": 1, "name": "workspace.selected",
               "occurred_at": format!("1970-01-01T00:00:{at:02}Z"),
               "payload": {"workspace_id": id, "selected": true}})
    }

    #[test]
    fn a_list_asked_for_before_a_selection_keeps_that_selection() {
        let mut j = Join::default();
        j.workspaces(vec![selected("A"), ws("B")], 0.0);
        // Jon opens B at 20 s while a list asked for at 10 s is under
        // way; it answers after the event, from before it, with an
        // unrelated change.
        j.event(&select_at("B", 20));
        let mut stale_a = selected("A");
        stale_a.unread = Some(1.0);
        assert!(j.workspaces(vec![stale_a, ws("B")], 10.0));
        let d = j.frame(0.0);
        assert_eq!(
            d.selected_id.as_deref(),
            Some("B"),
            "the outline stays on B"
        );
        assert_eq!(d.ws_by_id("A").and_then(|w| w.selected), Some(false));

        // A list asked for after the event is cmux's word again.
        j.workspaces(vec![ws("A"), ws("B"), selected("C")], 30.0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("C"));
    }

    #[test]
    fn reselecting_the_same_workspace_still_guards_against_an_older_list() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A"), selected("B")], 0.0);
        j.event(&select_at("B", 20));
        assert!(j.workspaces(vec![selected("A"), ws("B")], 10.0));
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("B"));
    }

    #[test]
    fn a_replayed_selection_gives_way_to_the_list() {
        let mut j = Join::default();
        // On start cmux replays an old selection of B; the list, asked
        // for since, has A on screen.
        j.event(&select_at("B", 20));
        j.workspaces(vec![selected("A"), ws("B")], 60.0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("A"));
    }

    #[test]
    fn unchanged_polls_are_not_changes() {
        let mut j = Join::default();
        assert!(!j.loaded());
        assert!(j.agents(view(&[(1, true, "s")])));
        assert!(!j.agents(view(&[(1, true, "s")])));
        assert!(j.workspaces(vec![ws("A")], 0.0));
        assert!(!j.workspaces(vec![ws("A")], 0.0));
        assert!(!j.loaded(), "no groups yet");
        assert_eq!(j.missing(), vec!["group list"]);
        assert!(j.groups(Groups::default()));
        assert!(!j.groups(Groups::default()));
        assert!(j.loaded());
    }

    #[test]
    fn groups_give_each_member_its_group() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A"), ws("B"), ws("C")], 0.0);
        let d = j.frame(0.0);
        assert_eq!(d.groups, None, "no group list read yet");
        assert_eq!(d.ws_by_id("A").unwrap().group, None);

        let g = cockpit_core::data::WorkspaceGroup {
            id: "g".into(),
            name: Some("Parked".into()),
            anchor_id: Some("A".into()),
            collapsed: Some(false),
        };
        let member_of = [("A", "g"), ("B", "g")]
            .map(|(w, g)| (w.to_string(), g.to_string()))
            .into();
        assert!(j.groups(Groups {
            list: vec![g.clone()],
            member_of,
        }));
        let d = j.frame(0.0);
        assert_eq!(d.groups, Some(vec![g]));
        let group_of = |id: &str| d.ws_by_id(id).unwrap().group.clone();
        assert_eq!(group_of("A").as_deref(), Some("g"));
        assert_eq!(group_of("B").as_deref(), Some("g"));
        assert_eq!(group_of("C"), None);
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
    fn workspace_events_other_than_selections_change_the_list() {
        assert!(changes_workspaces(&json!({"name": "workspace.reordered"})));
        assert!(changes_workspaces(&json!({"name": "workspace.action"})));
        assert!(!changes_workspaces(&json!({"name": "workspace.selected"})));
        assert!(changes_workspaces(
            &json!({"name": "workspace.prompt.submitted"})
        ));
        assert!(!changes_workspaces(&json!({"name": "agent.hook.Stop"})));
        // cmux refers to groups as `workspace_group:N`, so a group event
        // may be named either way.
        assert!(changes_workspaces(&json!({"name": "workspace.group.add"})));
        assert!(changes_workspaces(
            &json!({"name": "workspace_group.collapsed"})
        ));
    }

    #[test]
    fn a_session_in_a_workspace_the_list_lacks_is_left_out() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.event(&hook(1, "Stop", 7, "GONE", None));
        let d = j.frame(0.0);
        assert_eq!(d.workspace_list().len(), 1);
        assert_eq!(d.ws_by_id("A").unwrap().agent_list().count(), 0);
    }

    #[test]
    fn a_start_with_after_is_caught_up_when_nothing_is_left_to_replay() {
        let mut j = Join::default();
        j.event(&ack(500, 500));
        assert!(j.health.caught_up());
        assert!(!j.health.replaying());
    }

    #[test]
    fn a_hook_without_a_time_keeps_the_last_activity() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.event(&hook(1, "PreToolUse", 7, "A", Some("Bash")));
        let untimed = json!({"type": "event", "seq": 2, "name": "agent.hook.Stop",
                             "payload": {"_ppid": 7, "workspace_id": "A"}});
        j.event(&untimed);
        let d = j.frame(0.0);
        let a = d.ws_by_id("A").unwrap().agent_list().next().unwrap();
        assert_eq!(a.status, Some(AgentStatus::Idle));
        assert_eq!(
            (a.since_epoch, a.last_activity_at),
            (Some(100.0), Some(100.0))
        );
    }

    #[test]
    fn agent_view_idle_retires_a_working_status_its_hooks_left_behind() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, false, "s7")]));
        j.event(&hook(1, "PreToolUse", 7, "A", Some("Bash")));
        assert_eq!(
            statuses(&j.frame(102.0))[0].1[0].1,
            Some(AgentStatus::Working)
        );
        assert_eq!(statuses(&j.frame(200.0))[0].1[0].1, Some(AgentStatus::Idle));
    }
}
