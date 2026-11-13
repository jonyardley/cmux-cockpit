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
//!
//! Each session also keeps the tab (cmux surface) it runs in: the status
//! write's `--panel=` (this wins), or the hook's `surface_id`. cmux's tree
//! gives each tab's title, so a workspace with several agents can name
//! the one waiting.
//!
//! A session that stops without handing back (issue #376) is marked on
//! its agent (cockpit_core::stopped): a turn cmux reports ended on an
//! error, by tab, until the next prompt there; a process that left Agent
//! View mid-turn, kept as a card instead of hidden, only for a pid seen
//! alive since the runner started, so a replay never raises old ghosts;
//! and a working session silent past `SILENT_SECS`.
//!
//! Claude Code also reports its own state per tab, as cmux's
//! `program_status.changed` (issue #326). The join keeps the latest per
//! surface and cockpit_core::program decides, for each session, whether
//! its tab's report or its hooks say what the card shows.

use std::collections::HashMap;

use cockpit_core::data::{Agent, AgentStatus, Data, Workspace};
use cockpit_core::hooks::{Hooked, moves_activity, status_from_hook};
use cockpit_core::program::{Record, Report, resolve, status_of_records};
use cockpit_core::stopped::{Stop, StopCause, gone_mid_turn, silent_since};
use serde_json::Value;

use super::parse::{AgentView, Groups, SessionHistory, iso_epoch};

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
    /// When `selected` was last set, in epoch seconds: a selection
    /// event's `occurred_at`, or when the list that set it was asked for.
    /// Word from before then gives way (issue #301).
    selected_at: Option<f64>,
    /// pid to workspace, from a status write.
    tab_of: HashMap<u32, String>,
    /// pid to the tab (cmux surface) it runs in, and whether a status
    /// write's `--panel=` said so (this wins) rather than a hook's
    /// `surface_id`.
    surface_of: HashMap<u32, (String, bool)>,
    /// Surface id to its tab title, from cmux's tree.
    titles: HashMap<String, String>,
    /// pid to its latest status-setting hook.
    sessions: HashMap<u32, Hooked>,
    /// Surface id to Claude's own latest report there, while it has one.
    /// Forgotten with the tab's session: when it ends, when Agent View
    /// forgets its pid, or when a new session's hook claims the tab.
    program: HashMap<String, Report>,
    agents: Option<AgentView>,
    /// Each pid's session ids over time, so work started before a
    /// `/clear` stays its chat's. Kept across a new cmux boot, since the
    /// Claude processes outlive it; forgotten with the pid.
    history: SessionHistory,
    /// pid to how many Agent Views running have left it out.
    absent: HashMap<u32, u8>,
    /// Surface id to when cmux said a turn there ended on an error: the
    /// first of a run of retries, until a prompt or a new session there.
    errors: HashMap<String, f64>,
    /// pid to Agent View's last word on it, busy and its session id. A
    /// pid here has been seen alive since the runner started.
    seen: HashMap<u32, (bool, Option<String>)>,
    /// pid to a session whose process went mid-turn: its workspace and
    /// its agent as the card keeps showing it, stopped.
    gone: HashMap<u32, (String, Agent)>,
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
            // A new cmux boot: its events and lists start the selection afresh.
            self.selected_at = None;
            self.tab_of.clear();
            self.surface_of.clear();
            self.sessions.clear();
            self.program.clear();
            self.absent.clear();
            self.errors.clear();
            self.seen.clear();
            self.gone.clear();
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
        self.history.record(&view);
        // A pid back in Agent View is a live process again, not the one that went.
        let gone_before = self.gone.len();
        self.gone.retain(|pid, _| !view.busy.contains_key(pid));
        let mut changed = self.forget_absent(&view) || self.gone.len() != gone_before;
        for (pid, busy) in &view.busy {
            let session = view.session.get(pid);
            let same = self
                .seen
                .get(pid)
                .is_some_and(|(b, s)| b == busy && s.as_ref() == session);
            if !same {
                self.seen.insert(*pid, (*busy, session.cloned()));
            }
        }
        if self.agents.as_ref() != Some(&view) {
            self.agents = Some(view);
            changed = true;
        }
        changed
    }

    /// Takes a workspace list, asked for at `asked` (epoch seconds);
    /// false when neither it nor the selection changed. Its selection
    /// wins unless a selection event happened after it was asked for:
    /// cmux answered from before that event, and the outline would jump
    /// back to a workspace no longer on screen (issue #301). A list the
    /// same as the last one still gives its selection, since the last one
    /// may have been held back.
    pub fn workspaces(&mut self, list: Vec<Workspace>, asked: f64) -> bool {
        let mut changed = false;
        if self.selected_at.is_none_or(|at| at < asked) {
            let selected = list
                .iter()
                .find(|w| w.selected == Some(true))
                .map(|w| w.id.clone());
            changed = selected != self.selected;
            self.selected = selected;
            self.selected_at = Some(asked);
        }
        if self.workspaces.as_ref() != Some(&list) {
            self.workspaces = Some(list);
            changed = true;
        }
        changed
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
    /// so forgetting one changes no frame, unless it went mid-turn: it is
    /// kept as a stopped card, and that is news (true).
    fn forget_absent(&mut self, view: &AgentView) -> bool {
        let mut kept = false;
        let mut pids: Vec<u32> = self
            .tab_of
            .keys()
            .chain(self.sessions.keys())
            .chain(self.surface_of.keys())
            .copied()
            .chain(self.history.pids())
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
                if let Some(gone) = self.gone_record(pid) {
                    self.gone.insert(pid, gone);
                    kept = true;
                }
                self.seen.remove(&pid);
                self.absent.remove(&pid);
                self.tab_of.remove(&pid);
                if let Some((surface, _)) = self.surface_of.remove(&pid) {
                    self.forget_report_unless_held(&surface);
                }
                self.sessions.remove(&pid);
                self.history.forget(pid);
            }
        }
        kept
    }

    /// The stopped card a pid leaves when its process went mid-turn
    /// (`gone_mid_turn`, with Agent View's last word on it), placed where
    /// it ran; None when it ended cleanly, was idle, or was never seen
    /// alive since the runner started (a replayed session long gone), or
    /// when a new session already runs in its tab.
    fn gone_record(&self, pid: u32) -> Option<(String, Agent)> {
        let (busy, session) = self.seen.get(&pid)?;
        let h = self.sessions.get(&pid)?;
        let surface = self.surface_of.get(&pid).map(|(s, _)| s.clone());
        let taken = surface.as_ref().is_some_and(|s| {
            self.surface_of
                .iter()
                .any(|(p, (other, _))| *p != pid && other == s)
        });
        if taken {
            return None;
        }
        let program = surface.as_ref().and_then(|s| self.program.get(s));
        if !gone_mid_turn(h, program, Some(*busy)) {
            return None;
        }
        let ws = self.placed(pid)?.to_string();
        let id = session.clone().unwrap_or_else(|| format!("pid:{pid}"));
        let earlier = Some(self.history.earlier(pid, &id)).filter(|ids| !ids.is_empty());
        let agent = Agent {
            id,
            kind: Some("claude".to_string()),
            surface_id: surface,
            earlier_sessions: earlier,
            status: Some(AgentStatus::Idle),
            since_epoch: Some(h.last_hook).filter(|t| *t > 0.0),
            last_activity_at: Some(h.last_activity).filter(|t| *t > 0.0),
            stopped: Some(Stop {
                cause: StopCause::Gone,
                since: h.last_hook,
            }),
            ..Agent::default()
        };
        Some((ws, agent))
    }

    /// cmux's word that a turn ended on an error (StopFailure, which its
    /// own hooks catch): an `agent.notification.decision` of kind
    /// `agent.error.reported`, reason `accepted`, from Claude, naming the
    /// tab but no workspace or pid. A retry before any prompt keeps the
    /// first time. Kept, and news for a frame, only in a tab some session
    /// runs in: a session's SessionStart always comes before its error.
    fn error_reported(&mut self, e: &Value, seq: u64) -> (bool, Option<Change>) {
        let p = &e["payload"];
        if p["kind"] != "agent.error.reported"
            || p["reason"] != "accepted"
            || p["agent"] != "claude"
        {
            return (false, None);
        }
        let at = e["occurred_at"].as_str().and_then(iso_epoch);
        let (Some(surface), Some(at)) = (e["surface_id"].as_str(), at) else {
            return (false, None);
        };
        if self.errors.contains_key(surface) || !self.held(surface) {
            return (false, None);
        }
        self.errors.insert(surface.to_string(), at);
        let change = Change {
            seq,
            hook: "agent.error.reported".to_string(),
            at: Some(at),
        };
        (true, Some(change))
    }

    /// A new session (`pid`'s SessionStart) in the tab `surface`: a
    /// stopped card another process left there gives way to it. Any other
    /// hook claims nothing, so a second process that shares the tab (a
    /// `claude -p` a hook runs, say) never clears a stop. The error
    /// clears in `hook` on the same SessionStart. Whether a card went.
    fn claim_tab(&mut self, pid: u32, surface: &str) -> bool {
        let before = self.gone.len();
        self.gone
            .retain(|p, (_, a)| *p == pid || a.surface_id.as_deref() != Some(surface));
        self.gone.len() != before
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
        if name == "program_status.changed" {
            return self.program_status(e, seq);
        }
        if name == "agent.notification.decision" {
            return self.error_reported(e, seq);
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
        // One from before the selection was last set (a replayed event
        // landing after the list) gives way. One with no time cmux gave
        // counts as new and keeps the stamp it found.
        if let Some(at) = at {
            if self.selected_at.is_some_and(|last| at < last) {
                return false;
            }
            self.selected_at = Some(at);
        }
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
        let surface_moved = flag("--panel=").is_some_and(|s| self.set_surface(pid, s, true));
        let old = self.tab_of.insert(pid, tab.to_string());
        old.as_deref() != Some(tab) || surface_moved
    }

    /// Records the tab `pid` runs in; whether it changed. A hook's word
    /// (`written` false) never replaces a status write's.
    fn set_surface(&mut self, pid: u32, surface: &str, written: bool) -> bool {
        let old = self.surface_of.get(&pid);
        if !written && old.is_some_and(|(_, w)| *w) {
            return false;
        }
        let moved = old.is_none_or(|(s, _)| s != surface);
        self.surface_of.insert(pid, (surface.to_string(), written));
        moved
    }

    /// Takes cmux's tab titles, surface id to title; whether the title of
    /// a tab some session runs in changed. Every other tab's title is kept
    /// too, for a session placed in it before the next read, but a change
    /// there is no news for a frame.
    pub fn titles(&mut self, titles: HashMap<String, String>) -> bool {
        let changed = self
            .surface_of
            .values()
            .any(|(s, _)| self.titles.get(s) != titles.get(s));
        self.titles = titles;
        changed
    }

    /// Forgets a tab's report and any error there once no session is
    /// placed in it.
    fn forget_report_unless_held(&mut self, surface: &str) {
        if !self.held(surface) {
            self.program.remove(surface);
            self.errors.remove(surface);
        }
    }

    /// Forgets the report in a tab that a new session's hook claims from
    /// another, when the report is older than the hook: it was the last
    /// session's word (one killed with no done, say), not this one's.
    fn forget_report_on_claim(&mut self, pid: u32, surface: &str, at: Option<f64>) {
        let other = self
            .surface_of
            .iter()
            .any(|(p, (s, _))| *p != pid && s == surface);
        let older = self
            .program
            .get(surface)
            .is_some_and(|r| at.is_some_and(|t| r.since < t));
        if other && older {
            self.program.remove(surface);
        }
    }

    /// Whether some session is placed in the tab.
    fn held(&self, surface: &str) -> bool {
        self.surface_of.values().any(|(s, _)| s == surface)
    }

    /// Takes a tab's program status: the records cmux lists after the
    /// change, which every event carries. A `dismissed` (Jon looked at the
    /// tab) lists none but changes nothing Claude said, so the last report
    /// stands until Claude sends another. A tab whose records say nothing
    /// is forgotten, and its sessions fall back to their hooks. A report
    /// with no readable time is left out, since its order is unknown. Only
    /// a change of status in a tab some session runs in is news for a
    /// frame: a repeat, or a tab with no session, redraws nothing.
    fn program_status(&mut self, e: &Value, seq: u64) -> (bool, Option<Change>) {
        let p = &e["payload"];
        let Some(surface) = e["surface_id"].as_str() else {
            return (false, None);
        };
        if p["event"] == "dismissed" {
            return (false, None);
        }
        let records: Vec<Record<'_>> = p["records"]
            .as_array()
            .map(|list| list.iter().filter_map(record_of).collect())
            .unwrap_or_default();
        let held = self.held(surface);
        let Some(status) = status_of_records(&records) else {
            let forgot = self.program.remove(surface).is_some();
            return (forgot && held, None);
        };
        let Some(at) = e["occurred_at"].as_str().and_then(iso_epoch) else {
            return (false, None);
        };
        let prev = self.program.get(surface);
        let moved = prev.is_none_or(|s| s.status != status);
        let next = Report::after(prev, status, at);
        self.program.insert(surface.to_string(), next);
        let moved = moved && held;
        let change = moved.then(|| Change {
            seq,
            hook: format!("program_status.{}", p["event"].as_str().unwrap_or_default()),
            at: Some(at),
        });
        (moved, change)
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
        let released = self.gone.remove(&pid).is_some()
            | (hook == "SessionStart"
                && p["surface_id"]
                    .as_str()
                    .is_some_and(|s| self.claim_tab(pid, s)));
        let surface_moved = p["surface_id"].as_str().is_some_and(|s| {
            self.forget_report_on_claim(pid, s, at);
            self.set_surface(pid, s, false)
        }) || released;
        // A new prompt, or a new session, ends a stop on an error there.
        if matches!(hook, "UserPromptSubmit" | "SessionStart")
            && let Some((surface, _)) = self.surface_of.get(&pid)
        {
            self.errors.remove(surface);
        }
        let Some(status) = status_from_hook(hook, p["tool_name"].as_str()) else {
            return (surface_moved, false);
        };
        if status == AgentStatus::Ended
            && let Some((surface, _)) = self.surface_of.get(&pid)
        {
            self.program.remove(surface);
        }
        let prev = self.sessions.get(&pid);
        let moved = prev.is_none_or(|s| s.status != status || s.workspace != ws);
        let at = at.or(prev.map(|s| s.last_activity)).unwrap_or_default();
        let next = Hooked::after(prev, status, at, moves_activity(hook), ws);
        let changed = prev != Some(&next) || surface_moved;
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
        let session = view.and_then(|a| a.session.get(&pid).cloned());
        let earlier = session
            .as_deref()
            .map(|id| self.history.earlier(pid, id))
            .filter(|ids| !ids.is_empty());
        let id = session.unwrap_or_else(|| format!("pid:{pid}"));
        let surface = self.surface_of.get(&pid).map(|(s, _)| s.clone());
        let tab_title = surface.as_ref().and_then(|s| self.titles.get(s)).cloned();
        let mut a = Agent {
            id,
            kind: Some("claude".to_string()),
            surface_id: surface,
            tab_title,
            earlier_sessions: earlier,
            ..Agent::default()
        };
        let program = a.surface_id.as_ref().and_then(|s| self.program.get(s));
        let r = resolve(self.sessions.get(&pid), program, busy, now)?;
        let error = a.surface_id.as_ref().and_then(|s| self.errors.get(s));
        a.stopped = match error {
            Some(at) => Some(Stop {
                cause: StopCause::Error,
                since: *at,
            }),
            None => silent_since(&r.status, r.last_activity, now).map(|since| Stop {
                cause: StopCause::Silent,
                since,
            }),
        };
        a.status = Some(r.status);
        a.since_epoch = Some(r.since).filter(|t| *t > 0.0);
        a.last_activity_at = Some(r.last_activity).filter(|t| *t > 0.0);
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
                .is_some_and(|s| s.status == AgentStatus::Ended);
            if ended || !self.alive(pid) {
                continue;
            }
            let (Some(ws), Some(agent)) = (self.placed(pid), self.agent(pid, now)) else {
                continue;
            };
            out.entry(ws).or_default().push(agent);
        }
        let mut gone: Vec<(&u32, &(String, Agent))> = self.gone.iter().collect();
        gone.sort_unstable_by_key(|(pid, _)| **pid);
        for (_, (ws, agent)) in gone {
            let mut agent = agent.clone();
            agent.tab_title = agent
                .surface_id
                .as_ref()
                .and_then(|s| self.titles.get(s))
                .cloned();
            out.entry(ws.as_str()).or_default().push(agent);
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
            background_sessions: self
                .agents
                .as_ref()
                .filter(|v| !v.background.is_empty())
                .map(|v| v.background.clone()),
        }
    }
}

/// One record from a program status event's list.
fn record_of(r: &Value) -> Option<Record<'_>> {
    Some(Record {
        id: r["id"].as_str().unwrap_or_default(),
        state: r["state"].as_str()?,
    })
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
    use cockpit_core::data::BackgroundSession;
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
            started: HashMap::new(),
            background: Vec::new(),
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

    /// `hook` from the tab `surface`.
    fn hook_in(seq: u64, name: &str, pid: u32, ws: &str, surface: &str) -> Value {
        let mut e = hook(seq, name, pid, ws, None);
        e["payload"]["surface_id"] = json!(surface);
        e
    }

    /// Each agent's tab and its title, in frame order.
    fn tabs(d: &Data) -> Vec<(Option<String>, Option<String>)> {
        d.workspace_list()
            .iter()
            .flat_map(|w| w.agent_list())
            .map(|a| (a.surface_id.clone(), a.tab_title.clone()))
            .collect()
    }

    /// A `program_status.changed` from tab `surface` in workspace `ws` at
    /// epoch second `at`, listing `records` (id, state, kind) as cmux does
    /// after the change. The shape is copied from cmux 0.65's stream.
    fn program(
        seq: u64,
        event: &str,
        surface: &str,
        at: u32,
        records: &[(&str, &str, &str)],
    ) -> Value {
        let records: Vec<Value> = records
            .iter()
            .enumerate()
            .map(|(i, (id, state, kind))| {
                json!({"id": id, "kind": kind, "progress": null, "state": state, "updated_seq": i})
            })
            .collect();
        let record = if event == "report" {
            records.first().cloned()
        } else {
            None
        };
        json!({"type": "event", "seq": seq, "name": "program_status.changed",
               "category": "terminal", "source": "terminal.program_status",
               "occurred_at": format!("1970-01-01T00:{:02}:{:02}Z", at / 60, at % 60),
               "surface_id": surface, "workspace_id": "A",
               "payload": {"event": event, "id": null, "record": record,
                           "records": records, "records_total": records.len()}})
    }

    /// Workspace A's one agent's status at epoch `now`.
    fn status_at(j: &Join, now: f64) -> Option<AgentStatus> {
        j.frame(now)
            .workspace_list()
            .iter()
            .flat_map(|w| w.agent_list())
            .find_map(|a| a.status.clone())
    }

    /// A join with one live session, pid 7, placed by a Stop at 100s in tab S1.
    fn stopped_in_s1() -> Join {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        j.event(&hook_in(1, "Stop", 7, "A", "S1"));
        j
    }

    #[test]
    fn a_working_report_after_a_stop_keeps_the_card_working() {
        let mut j = stopped_in_s1();
        assert_eq!(status_at(&j, 101.0), Some(AgentStatus::Idle));
        let (changed, change) =
            j.event(&program(2, "report", "S1", 101, &[("", "working", "none")]));
        assert!(changed);
        assert_eq!(
            change.map(|c| c.hook),
            Some("program_status.report".to_string())
        );
        assert_eq!(status_at(&j, 102.0), Some(AgentStatus::Working));
    }

    #[test]
    fn a_blocked_permission_report_needs_jon_from_the_documented_mapping() {
        // No live blocked event has been seen yet (issue #326): this is the
        // mapping read from Claude Code 2.1.302, in the stream's shape.
        let mut j = stopped_in_s1();
        j.event(&program(2, "report", "S1", 101, &[("", "working", "none")]));
        j.event(&program(
            3,
            "report",
            "S1",
            102,
            &[("", "blocked", "permission")],
        ));
        assert_eq!(status_at(&j, 103.0), Some(AgentStatus::NeedsInput));
        let since = j.frame(103.0).workspace_list()[0]
            .agent_list()
            .find_map(|a| a.since_epoch);
        assert_eq!(since, Some(102.0));
    }

    #[test]
    fn a_blocked_helper_needs_jon_while_the_session_works() {
        let mut j = stopped_in_s1();
        j.event(&program(
            2,
            "report",
            "S1",
            101,
            &[("", "working", "none"), ("a1", "blocked", "question")],
        ));
        assert_eq!(status_at(&j, 102.0), Some(AgentStatus::NeedsInput));
    }

    #[test]
    fn dismissed_keeps_the_last_report_and_clearing_every_record_falls_back_to_the_hooks() {
        let mut j = stopped_in_s1();
        j.event(&program(2, "report", "S1", 101, &[("", "working", "none")]));
        assert_eq!(
            j.event(&program(3, "dismissed", "S1", 120, &[])),
            (false, None)
        );
        assert_eq!(status_at(&j, 121.0), Some(AgentStatus::Working));
        let (changed, change) = j.event(&program(4, "removed", "S1", 130, &[]));
        assert!(changed && change.is_none());
        assert_eq!(status_at(&j, 131.0), Some(AgentStatus::Idle), "the Stop's");
    }

    #[test]
    fn a_helpers_clear_leaves_the_sessions_own_record() {
        let mut j = stopped_in_s1();
        j.event(&program(
            2,
            "report",
            "S1",
            101,
            &[("", "done", "none"), ("a1", "working", "none")],
        ));
        let (changed, _) = j.event(&program(3, "clear", "S1", 102, &[("", "done", "none")]));
        assert!(!changed, "the same status: nothing to redraw");
        assert_eq!(status_at(&j, 103.0), Some(AgentStatus::Idle));
    }

    /// A hook from tab `surface` at epoch second `at`.
    fn hook_at(seq: u64, name: &str, pid: u32, surface: &str, at: u32) -> Value {
        let mut e = hook_in(seq, name, pid, "A", surface);
        e["occurred_at"] = json!(format!("1970-01-01T00:{:02}:{:02}Z", at / 60, at % 60));
        e
    }

    #[test]
    fn a_new_session_in_the_tab_does_not_inherit_the_last_ones_report() {
        // Claude killed mid-turn: it reported working and never done.
        let mut j = stopped_in_s1();
        j.event(&program(2, "report", "S1", 101, &[("", "working", "none")]));
        j.agents(view(&[(7, false, "s7"), (8, true, "s8")]));
        j.event(&hook_at(3, "SessionStart", 8, "S1", 300));
        assert!(!j.program.contains_key("S1"));
        let s8 = j.frame(301.0).workspace_list()[0]
            .agent_list()
            .find(|a| a.id == "s8")
            .and_then(|a| a.status.clone());
        assert_eq!(s8, Some(AgentStatus::Idle), "the new session's own hook");
    }

    #[test]
    fn a_report_after_the_new_sessions_hook_is_kept() {
        let mut j = stopped_in_s1();
        j.agents(view(&[(7, true, "s7"), (8, true, "s8")]));
        j.event(&program(2, "report", "S1", 300, &[("", "working", "none")]));
        j.event(&hook_at(3, "SessionStart", 8, "S1", 299));
        assert!(j.program.contains_key("S1"));
    }

    #[test]
    fn a_session_that_ends_or_is_forgotten_takes_its_tabs_report() {
        let mut j = stopped_in_s1();
        j.event(&program(2, "report", "S1", 101, &[("", "working", "none")]));
        j.event(&hook_at(3, "SessionEnd", 7, "S1", 102));
        assert!(j.program.is_empty(), "ended");
        j.event(&hook_at(4, "Stop", 7, "S1", 103));
        j.event(&program(5, "report", "S1", 104, &[("", "working", "none")]));
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        assert!(j.program.is_empty(), "forgotten with its pid");
    }

    #[test]
    fn another_tabs_report_and_one_with_no_time_change_nothing() {
        let mut j = stopped_in_s1();
        let (changed, change) =
            j.event(&program(2, "report", "S9", 101, &[("", "working", "none")]));
        assert!(!changed && change.is_none(), "S9 runs no session");
        assert_eq!(status_at(&j, 102.0), Some(AgentStatus::Idle));
        let mut untimed = program(3, "report", "S1", 101, &[("", "working", "none")]);
        untimed["occurred_at"] = Value::Null;
        assert_eq!(j.event(&untimed), (false, None));
        assert_eq!(status_at(&j, 102.0), Some(AgentStatus::Idle));
    }

    #[test]
    fn a_fresh_stream_forgets_the_reports() {
        let mut j = stopped_in_s1();
        j.event(&program(2, "report", "S1", 101, &[("", "working", "none")]));
        j.ack(&ack(0, 10));
        j.agents(view(&[(7, true, "s7")]));
        j.event(&hook_in(3, "Stop", 7, "A", "S1"));
        assert_eq!(status_at(&j, 102.0), Some(AgentStatus::Idle));
    }

    #[test]
    fn an_agent_carries_its_hooks_tab_and_that_tabs_title() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        assert!(j.event(&hook_in(1, "Stop", 7, "A", "S1")).0);
        assert_eq!(tabs(&j.frame(200.0)), vec![(Some("S1".into()), None)]);
        let titles = HashMap::from([("S1".to_string(), "Fix CI lint".to_string())]);
        assert!(j.titles(titles.clone()));
        assert!(!j.titles(titles));
        assert_eq!(
            tabs(&j.frame(200.0)),
            vec![(Some("S1".into()), Some("Fix CI lint".into()))]
        );
    }

    #[test]
    fn only_a_title_change_on_a_tab_a_session_runs_in_is_news() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        j.event(&hook_in(1, "Stop", 7, "A", "S1"));
        let read = |s1: &str, s9: &str| {
            HashMap::from([
                ("S1".to_string(), s1.to_string()),
                ("S9".to_string(), s9.to_string()),
            ])
        };
        assert!(j.titles(read("Fix CI lint", "zsh")));
        assert!(!j.titles(read("Fix CI lint", "vim")), "S9 runs no session");
        assert!(j.titles(read("Review #327", "vim")));
        // A session placed later in S9 finds the title already read.
        j.agents(view(&[(7, true, "s7"), (8, true, "s8")]));
        j.event(&hook_in(2, "Stop", 8, "A", "S9"));
        let mut t = tabs(&j.frame(200.0));
        t.sort();
        assert_eq!(
            t,
            vec![
                (Some("S1".into()), Some("Review #327".into())),
                (Some("S9".into()), Some("vim".into()))
            ]
        );
    }

    #[test]
    fn a_pid_with_only_a_tab_is_forgotten_too() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        j.event(&hook_in(1, "SubagentStart", 7, "A", "S1"));
        assert!(j.surface_of.contains_key(&7));
        assert!(!j.sessions.contains_key(&7) && !j.tab_of.contains_key(&7));
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        assert!(j.surface_of.is_empty(), "its tab is forgotten with it");
        assert!(j.absent.is_empty());
    }

    #[test]
    fn a_status_writes_panel_beats_the_hooks_tab() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        j.event(&hook_in(1, "Stop", 7, "A", "S1"));
        let write = json!({"type": "event", "seq": 2, "name": "sidebar.metadata.updated",
            "payload": {"args": "claude_code Running --tab=A --panel=S2 --pid=7"}});
        assert!(j.event(&write).0);
        // A later hook naming another tab does not move it back.
        assert!(!j.event(&hook_in(3, "Stop", 7, "A", "S1")).0);
        assert_eq!(tabs(&j.frame(200.0)), vec![(Some("S2".into()), None)]);
    }

    #[test]
    fn a_hook_with_no_status_still_places_its_tab() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        j.event(&hook_in(1, "Stop", 7, "A", "S1"));
        assert!(j.event(&hook_in(2, "SubagentStart", 7, "A", "S3")).0);
        assert_eq!(tabs(&j.frame(200.0)), vec![(Some("S3".into()), None)]);
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
    fn a_held_back_list_does_not_hide_the_next_one_like_it() {
        let mut j = Join::default();
        j.workspaces(vec![selected("A"), ws("B")], 0.0);
        j.event(&select_at("B", 20));
        j.workspaces(vec![selected("A"), ws("B")], 10.0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("B"));
        // Jon went back to A with no event: the next list, the same as
        // the held-back one, is the only word and must land.
        assert!(j.workspaces(vec![selected("A"), ws("B")], 30.0));
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("A"));
        assert!(!j.workspaces(vec![selected("A"), ws("B")], 40.0));
    }

    #[test]
    fn a_replayed_selection_landing_after_the_list_gives_way() {
        let mut j = Join::default();
        j.workspaces(vec![selected("A"), ws("B")], 50.0);
        assert!(!j.event(&select_at("B", 20)).0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("A"));
        // A newer one still moves it.
        assert!(j.event(&select_at("B", 55)).0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("B"));
    }

    #[test]
    fn a_new_cmux_boot_starts_the_selection_afresh() {
        let mut j = Join::default();
        j.event(&select_at("B", 50));
        j.event(&ack(0, 10));
        j.workspaces(vec![selected("A"), ws("B")], 30.0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("A"));
    }

    #[test]
    fn a_selection_with_no_time_moves_it_and_keeps_the_guard() {
        let mut j = Join::default();
        j.event(&select_at("B", 20));
        let untimed = json!({"type": "event", "seq": 2, "name": "workspace.selected",
                             "payload": {"workspace_id": "C", "selected": true}});
        assert!(j.event(&untimed).0);
        j.workspaces(vec![selected("A"), ws("B"), ws("C")], 10.0);
        assert_eq!(j.frame(0.0).selected_id.as_deref(), Some("C"));
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

    /// One process, `pid`, under `session`, started at `started`.
    fn started(pid: u32, session: &str, started: u64) -> AgentView {
        let mut v = view(&[(pid, false, session)]);
        v.started.insert(pid, started);
        v
    }

    /// Workspace A's agents, each with the sessions its process ran before.
    fn earlier(j: &Join) -> Vec<(String, Option<Vec<String>>)> {
        j.frame(0.0).workspace_list()[0]
            .agent_list()
            .map(|a| (a.id.clone(), a.earlier_sessions.clone()))
            .collect()
    }

    #[test]
    fn a_clear_hands_the_core_the_chats_earlier_session() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(started(7, "before", 100));
        j.event(&hook(1, "Stop", 7, "A", None));
        assert_eq!(earlier(&j), vec![("before".into(), None)]);
        j.agents(started(7, "after", 100));
        assert_eq!(
            earlier(&j),
            vec![("after".into(), Some(vec!["before".into()]))]
        );

        // data.json carries the frame to the sidebar's own core.
        let json = serde_json::to_value(j.frame(0.0)).unwrap();
        let back: Data = serde_json::from_value(json).unwrap();
        let ids: Vec<_> = back.workspace_list()[0]
            .agent_list()
            .map(|a| a.earlier_sessions.clone())
            .collect();
        assert_eq!(ids, vec![Some(vec!["before".to_string()])]);
    }

    /// An Agent View with one interactive process and these background
    /// sessions, each a short id and its state.
    fn with_bg(sessions: &[(&str, &str)]) -> AgentView {
        let mut v = view(&[(7, false, "chat")]);
        v.background = sessions
            .iter()
            .map(|(id, state)| BackgroundSession {
                id: (*id).to_string(),
                session_id: Some(format!("s-{id}")),
                state: serde_json::from_value(json!(state)).ok(),
                ..BackgroundSession::default()
            })
            .collect();
        v
    }

    #[test]
    fn background_sessions_reach_the_sidebars_core_with_their_state() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        assert!(j.agents(with_bg(&[])));
        let json = serde_json::to_value(j.frame(0.0)).unwrap();
        assert!(
            json.get("backgroundSessions").is_none(),
            "none, so left out"
        );

        assert!(j.agents(with_bg(&[("aaaa", "working"), ("bbbb", "done")])));
        assert!(!j.agents(with_bg(&[("aaaa", "working"), ("bbbb", "done")])));
        assert!(
            j.agents(with_bg(&[("aaaa", "stopped"), ("bbbb", "done")])),
            "a change of state alone is a new frame"
        );
        assert!(j.agents(with_bg(&[("aaaa", "working"), ("bbbb", "done")])));

        // data.json carries the frame to the sidebar's own core.
        let json = serde_json::to_value(j.frame(0.0)).unwrap();
        let back: Data = serde_json::from_value(json).unwrap();
        assert_eq!(back.background_list().len(), 2);
        assert!(back.background_runs("aaaa"));
        assert!(back.background_runs("s-aaaa"));
        assert!(!back.background_runs("bbbb"));
        assert_eq!(
            statuses(&back),
            statuses(&j.frame(0.0)),
            "the interactive agents are as before"
        );
    }

    #[test]
    fn a_reused_pid_inside_the_forget_window_carries_no_earlier_session() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(started(7, "theirs", 100));
        j.event(&hook(1, "Stop", 7, "A", None));
        j.agents(view(&[]));
        j.agents(started(7, "mine", 200));
        assert_eq!(earlier(&j), vec![("mine".into(), None)]);
    }

    #[test]
    fn the_history_outlives_a_new_cmux_boot_but_not_its_pid() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, false, "before")]));
        j.agents(view(&[(7, false, "after")]));
        j.event(&ack(0, 0));
        j.event(&hook(1, "Stop", 7, "A", None));
        assert_eq!(
            earlier(&j),
            vec![("after".into(), Some(vec!["before".into()]))],
            "Claude processes outlive a cmux boot"
        );
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        j.agents(view(&[(7, false, "fresh")]));
        j.event(&hook(2, "Stop", 7, "A", None));
        assert_eq!(earlier(&j), vec![("fresh".into(), None)]);
    }

    /// A fixture from the spike for #376 (native/fixtures/stopped/).
    fn fixture(name: &str) -> Value {
        let text = match name {
            "error" => include_str!("../../fixtures/stopped/error-reported-decision.json"),
            "stop" => include_str!("../../fixtures/stopped/ordinary-stop-hook.json"),
            "end" => include_str!("../../fixtures/stopped/session-end-hook.json"),
            _ => panic!("no fixture {name}"),
        };
        serde_json::from_str(text).unwrap()
    }

    /// The error fixture's tab, and when cmux reported it.
    const ERROR_TAB: &str = "E1248C60-050B-421C-9742-65C4A5C24868";
    const ERROR_AT: f64 = 1_794_565_070.863;

    /// `name` from pid 7 in workspace A, in the error fixture's tab, at
    /// epoch second `at`.
    fn tab_hook(seq: u64, name: &str, at: f64) -> Value {
        let mut e = hook_in(seq, name, 7, "A", ERROR_TAB);
        e["occurred_at"] = json!(iso(at));
        e
    }

    fn iso(at: f64) -> String {
        let ms = (at * 1000.0).round() as i64;
        chrono_free_iso(ms)
    }

    /// Epoch ms as cmux's ISO time, without a date crate: days from the
    /// civil calendar (Howard Hinnant's algorithm).
    fn chrono_free_iso(ms: i64) -> String {
        let secs = ms.div_euclid(1000);
        let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60,
            ms.rem_euclid(1000)
        )
    }

    /// Workspace A's one agent at epoch `now`, if any.
    fn agent_at(j: &Join, now: f64) -> Option<Agent> {
        j.frame(now)
            .workspace_list()
            .iter()
            .find(|w| w.id == "A")
            .and_then(|w| w.agent_list().next().cloned())
    }

    /// A join with pid 7 working in the error fixture's tab since `at`,
    /// Agent View listing it busy.
    fn working_from(at: f64) -> Join {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.agents(view(&[(7, true, "s7")]));
        j.event(&tab_hook(1, "UserPromptSubmit", at));
        j.event(&tab_hook(2, "PreToolUse", at + 1.0));
        j
    }

    #[test]
    fn the_time_helper_reads_back_as_cmux_writes_it() {
        assert_eq!(iso(ERROR_AT), "2026-11-13T10:17:50.863Z");
        assert_eq!(iso_epoch(&iso(ERROR_AT)), Some(ERROR_AT));
    }

    #[test]
    fn an_error_cmux_reports_stops_the_tabs_session_until_its_next_prompt() {
        let mut j = working_from(ERROR_AT - 60.0);
        let (changed, change) = j.event(&fixture("error"));
        assert!(changed, "a session runs in that tab");
        assert_eq!(
            change.map(|c| c.hook).as_deref(),
            Some("agent.error.reported")
        );
        let stop = agent_at(&j, ERROR_AT + 5.0).and_then(|a| a.stopped);
        assert_eq!(
            stop,
            Some(Stop {
                cause: StopCause::Error,
                since: ERROR_AT
            })
        );
        // A retry before any prompt keeps the first time, so a dismissal holds.
        let mut again = fixture("error");
        again["occurred_at"] = json!(iso(ERROR_AT + 30.0));
        assert_eq!(j.event(&again), (false, None));
        assert_eq!(
            agent_at(&j, ERROR_AT + 40.0)
                .and_then(|a| a.stopped)
                .map(|s| s.since),
            Some(ERROR_AT)
        );
        // The idle nudge clears nothing; the next prompt does.
        j.event(&tab_hook(3, "Notification", ERROR_AT + 60.0));
        assert!(
            agent_at(&j, ERROR_AT + 61.0)
                .and_then(|a| a.stopped)
                .is_some()
        );
        j.event(&tab_hook(4, "UserPromptSubmit", ERROR_AT + 120.0));
        assert_eq!(agent_at(&j, ERROR_AT + 121.0).and_then(|a| a.stopped), None);
    }

    #[test]
    fn an_error_that_was_not_accepted_or_in_no_sessions_tab_changes_nothing() {
        let mut j = working_from(ERROR_AT - 60.0);
        let mut stale = fixture("error");
        stale["payload"]["reason"] = json!("stale");
        assert_eq!(j.event(&stale), (false, None));
        let mut elsewhere = fixture("error");
        elsewhere["surface_id"] = json!("OTHER");
        assert_eq!(j.event(&elsewhere), (false, None));
        assert_eq!(agent_at(&j, ERROR_AT + 1.0).and_then(|a| a.stopped), None);
    }

    /// The stop on workspace A's session `id` at epoch `now`.
    fn stop_of(j: &Join, id: &str, now: f64) -> Option<Stop> {
        j.frame(now)
            .ws_by_id("A")
            .and_then(|w| w.agent_list().find(|a| a.id == id).cloned())
            .and_then(|a| a.stopped)
    }

    /// `name` from `pid` in the error fixture's tab at epoch second `at`.
    fn pid_hook(seq: u64, name: &str, pid: u32, at: f64) -> Value {
        let mut e = hook_in(seq, name, pid, "A", ERROR_TAB);
        e["occurred_at"] = json!(iso(at));
        e
    }

    #[test]
    fn another_agents_error_marks_nothing() {
        let mut j = working_from(ERROR_AT - 60.0);
        let mut codex = fixture("error");
        codex["payload"]["agent"] = json!("codex");
        assert_eq!(j.event(&codex), (false, None));
        assert_eq!(stop_of(&j, "s7", ERROR_AT + 1.0), None);
    }

    #[test]
    fn a_second_process_in_the_tab_clears_no_error_until_it_starts_a_session() {
        let mut j = working_from(ERROR_AT - 60.0);
        j.agents(view(&[(7, true, "s7"), (8, true, "s8")]));
        j.event(&pid_hook(3, "PreToolUse", 8, ERROR_AT - 30.0));
        j.event(&fixture("error"));
        // A tool call from the other process is no new prompt here.
        j.event(&pid_hook(4, "PreToolUse", 8, ERROR_AT + 10.0));
        j.event(&pid_hook(5, "PostToolUse", 8, ERROR_AT + 11.0));
        assert_eq!(
            stop_of(&j, "s7", ERROR_AT + 12.0).map(|s| s.cause),
            Some(StopCause::Error)
        );
        j.event(&pid_hook(6, "SessionStart", 8, ERROR_AT + 20.0));
        assert_eq!(stop_of(&j, "s7", ERROR_AT + 21.0), None);
    }

    #[test]
    fn a_gone_card_gives_way_to_a_new_session_not_to_any_hook() {
        let at = 1_794_567_000.0;
        let mut j = working_from(at);
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        j.agents(view(&[(8, true, "s8")]));
        j.event(&pid_hook(5, "PreToolUse", 8, at + 30.0));
        assert_eq!(
            stop_of(&j, "s7", at + 31.0).map(|s| s.cause),
            Some(StopCause::Gone)
        );
        j.event(&pid_hook(6, "SessionStart", 8, at + 40.0));
        assert_eq!(stop_of(&j, "s7", at + 41.0), None);
        assert!(
            j.frame(at + 41.0)
                .ws_by_id("A")
                .is_some_and(|w| w.agent_list().all(|a| a.id != "s7")),
            "the card went"
        );
    }

    #[test]
    fn an_error_goes_with_the_tabs_last_session_and_is_never_kept_for_an_empty_tab() {
        // The session that met the error is forgotten: a later process in
        // the tab, whose first hook here is not a SessionStart, is not stopped.
        // Agent View last saw it idle, so it leaves no Gone card to claim.
        let mut j = working_from(ERROR_AT - 60.0);
        j.event(&fixture("error"));
        j.agents(view(&[(7, false, "s7")]));
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        assert!(
            j.frame(ERROR_AT + 20.0)
                .ws_by_id("A")
                .is_some_and(|w| w.agent_list().count() == 0)
        );
        j.agents(view(&[(8, true, "s8")]));
        j.event(&pid_hook(5, "PreToolUse", 8, ERROR_AT + 30.0));
        assert_eq!(stop_of(&j, "s8", ERROR_AT + 31.0), None);
        // An error in a tab no session holds is not kept for a later one.
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        assert_eq!(j.event(&fixture("error")), (false, None));
        j.agents(view(&[(8, true, "s8")]));
        j.event(&pid_hook(1, "PreToolUse", 8, ERROR_AT + 30.0));
        assert_eq!(stop_of(&j, "s8", ERROR_AT + 31.0), None);
    }

    #[test]
    fn a_process_gone_mid_turn_keeps_its_card_stopped() {
        let at = 1_794_567_000.0;
        let mut j = working_from(at);
        for _ in 0..FORGET_AFTER - 1 {
            j.agents(view(&[]));
        }
        assert!(
            agent_at(&j, at + 10.0).is_none(),
            "hidden while it may come back"
        );
        assert!(j.agents(view(&[])), "kept as a stopped card: news");
        let a = agent_at(&j, at + 20.0).unwrap();
        assert_eq!(a.id, "s7", "its session id, so a dismissal holds");
        assert_eq!(a.surface_id.as_deref(), Some(ERROR_TAB));
        assert_eq!(
            a.stopped,
            Some(Stop {
                cause: StopCause::Gone,
                since: at + 1.0
            })
        );
        // A new session in the tab takes its place.
        let mut fresh = hook_in(9, "SessionStart", 8, "A", ERROR_TAB);
        fresh["occurred_at"] = json!(iso(at + 30.0));
        j.agents(view(&[(8, false, "s8")]));
        j.event(&fresh);
        let ids: Vec<String> = j.frame(at + 31.0).workspace_list()[0]
            .agent_list()
            .map(|a| a.id.clone())
            .collect();
        assert_eq!(ids, ["s8"]);
    }

    #[test]
    fn a_session_restarted_in_the_tab_before_the_kill_is_noticed_leaves_no_card() {
        let at = 1_794_567_000.0;
        let mut j = working_from(at);
        j.agents(view(&[]));
        let mut fresh = hook_in(9, "SessionStart", 8, "A", ERROR_TAB);
        fresh["occurred_at"] = json!(iso(at + 3.0));
        j.event(&fresh);
        for _ in 1..FORGET_AFTER {
            j.agents(view(&[(8, false, "s8")]));
        }
        let ids: Vec<String> = j.frame(at + 10.0).workspace_list()[0]
            .agent_list()
            .map(|a| a.id.clone())
            .collect();
        assert_eq!(ids, ["s8"]);
    }

    #[test]
    fn a_replayed_session_never_seen_alive_raises_no_ghost() {
        let mut j = Join::default();
        j.workspaces(vec![ws("A")], 0.0);
        j.event(&tab_hook(1, "UserPromptSubmit", 1000.0));
        for _ in 0..FORGET_AFTER {
            j.agents(view(&[]));
        }
        assert!(agent_at(&j, 1010.0).is_none());
    }

    #[test]
    fn a_clean_end_from_the_fixtures_stays_out() {
        let stop = fixture("stop");
        let pid = 4607;
        let ws_id = stop["workspace_id"].as_str().unwrap().to_string();
        let surface = stop["surface_id"].as_str().unwrap().to_string();
        // The SessionEnd fixture came from another session: put it in this one.
        let mut end = fixture("end");
        end["payload"]["_ppid"] = json!(pid);
        end["payload"]["workspace_id"] = json!(ws_id);
        end["payload"]["surface_id"] = json!(surface);
        for ends in [vec![stop.clone()], vec![stop.clone(), end]] {
            let mut j = Join::default();
            j.workspaces(vec![ws(&ws_id)], 0.0);
            j.agents(view(&[(pid, true, "s")]));
            let mut prompt = hook_in(1, "UserPromptSubmit", pid, &ws_id, &surface);
            prompt["occurred_at"] = json!("2026-11-13T08:30:00Z");
            j.event(&prompt);
            for e in &ends {
                j.event(e);
            }
            j.agents(view(&[(pid, false, "s")]));
            for _ in 0..FORGET_AFTER {
                j.agents(view(&[]));
            }
            let agents: Vec<Agent> = j
                .frame(1_794_560_000.0)
                .workspace_list()
                .iter()
                .flat_map(|w| w.agent_list().cloned())
                .collect();
            assert!(agents.is_empty(), "{} hooks", ends.len());
        }
    }

    #[test]
    fn a_working_session_silent_past_the_limit_is_stopped_from_its_last_hook() {
        use cockpit_core::stopped::SILENT_SECS;
        let at = 1_794_567_000.0;
        let j = working_from(at);
        let last = at + 1.0;
        assert_eq!(
            agent_at(&j, last + SILENT_SECS - 1.0).and_then(|a| a.stopped),
            None
        );
        assert_eq!(
            agent_at(&j, last + SILENT_SECS).and_then(|a| a.stopped),
            Some(Stop {
                cause: StopCause::Silent,
                since: last
            })
        );
    }
}
