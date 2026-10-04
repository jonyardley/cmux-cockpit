//! R1.0 status spike. Follows `cmux events` (replay, then live) and polls
//! `claude agents --json`, joins the two on the Claude process id, and prints
//! one line per workspace: title, status, needs you or not.
//!
//! Throwaway: it exists to prove the join in the R1 plan's section 2 holds.
//! Run `cargo run --release` for the live table, `-- --once` to replay,
//! print once and exit (the restart check).

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AGENTS_EVERY: Duration = Duration::from_secs(2);
const WORKSPACES_EVERY: Duration = Duration::from_secs(30);
/// Quiet time after the last change before the table reprints.
const SETTLE: Duration = Duration::from_millis(300);
/// Wait before reconnecting after `cmux events` exits.
const RETRY: Duration = Duration::from_secs(1);
/// In --once mode, the longest replay may take before the table prints anyway.
const ONCE_LIMIT: Duration = Duration::from_secs(10);

enum Msg {
    Event(Value),
    /// The stream's ack: replay is done once events reach this sequence.
    Replaying(u64),
    StreamDown(String),
    Agents(AgentView),
    Workspaces(Vec<(String, String)>),
}

#[derive(Default, PartialEq)]
struct AgentView {
    /// pid -> busy, for interactive sessions
    busy: HashMap<u32, bool>,
    /// Background sessions carry no pid, so they only count.
    background: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Status {
    Ended,
    /// A status write tied the pid to a workspace, but no hook has come yet.
    Unknown,
    Idle,
    Working,
    NeedsInput,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Ended => "ended",
            Status::Unknown => "no hooks yet",
            Status::Idle => "idle",
            Status::Working => "working",
            Status::NeedsInput => "needs input",
        }
    }
}

/// What a Claude hook does to the agent's status, following cmux 0.64.25 as
/// docs/state-loop.md ("What cmux does") and scripts/hooks/report-notification.ts
/// describe it: Stop sets idle, every Notification (the idle_prompt nudge
/// about 60s after a Stop included) and every PermissionRequest set needs
/// input, and so does PreToolUse for the two tools that ask under
/// bypassPermissions. None leaves the status as it was (a subagent finishing
/// does not end the parent's turn).
fn status_from_hook(name: &str, tool: Option<&str>) -> Option<Status> {
    match (name, tool) {
        ("PreToolUse", Some("AskUserQuestion" | "ExitPlanMode")) => Some(Status::NeedsInput),
        ("Notification" | "PermissionRequest", _) => Some(Status::NeedsInput),
        ("UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact", _) => {
            Some(Status::Working)
        }
        ("SessionStart" | "Stop", _) => Some(Status::Idle),
        ("SessionEnd", _) => Some(Status::Ended),
        _ => None,
    }
}

struct Session {
    status: Status,
    seq: u64,
    /// The workspace_id on this session's latest hook.
    hook_ws: String,
}

/// One live Claude session, placed in a workspace.
struct Placed<'a> {
    pid: u32,
    ws: &'a str,
    status: Status,
    seq: u64,
    joined: String,
}

#[derive(Default)]
struct State {
    last_seq: u64,
    replay_to: Option<u64>,
    stream_down: Option<String>,
    /// Workspace list order, as cmux gives it.
    titles: Vec<(String, String)>,
    /// pid -> workspace, from the --pid and --tab on a status write
    tab_of: HashMap<u32, String>,
    /// pid -> status from its latest hook
    sessions: HashMap<u32, Session>,
    agents: Option<AgentView>,
}

impl State {
    /// Applies a message; false when it changed nothing worth reprinting.
    fn apply(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Event(e) => self.event(&e),
            Msg::Replaying(to) => {
                self.replay_to = Some(to);
                self.stream_down = None;
            }
            Msg::StreamDown(why) => self.stream_down = Some(why),
            Msg::Agents(view) => {
                if self.agents.as_ref() == Some(&view) {
                    return false;
                }
                self.agents = Some(view);
            }
            Msg::Workspaces(list) => self.titles = list,
        }
        true
    }

    fn event(&mut self, e: &Value) {
        if e.get("resume").is_some() {
            // A fresh connection after a cmux restart starts from nothing.
            if e["resume"]["requested_after_seq"] == 0 {
                self.tab_of.clear();
                self.sessions.clear();
            }
            return;
        }
        if e["type"] != "event" {
            return;
        }
        let seq = e["seq"].as_u64().unwrap_or_default();
        self.last_seq = seq;
        let name = e["name"].as_str().unwrap_or_default();
        let p = &e["payload"];
        if name == "sidebar.metadata.updated" {
            self.status_write(p["args"].as_str().unwrap_or_default());
        } else if let Some(hook) = name.strip_prefix("agent.hook.") {
            self.hook(hook, p, seq);
        }
    }

    fn status_write(&mut self, args: &str) {
        let flag = |key: &str| args.split_whitespace().find_map(|t| t.strip_prefix(key));
        if let (Some(tab), Some(pid)) =
            (flag("--tab="), flag("--pid=").and_then(|s| s.parse().ok()))
        {
            self.tab_of.insert(pid, tab.to_string());
        }
    }

    fn hook(&mut self, hook: &str, p: &Value, seq: u64) {
        let (Some(ws), Some(pid)) = (p["workspace_id"].as_str(), p["_ppid"].as_u64()) else {
            return;
        };
        let Ok(pid) = u32::try_from(pid) else { return };
        let Some(status) = status_from_hook(hook, p["tool_name"].as_str()) else {
            return;
        };
        let hook_ws = ws.to_string();
        self.sessions.insert(
            pid,
            Session {
                status,
                seq,
                hook_ws,
            },
        );
    }

    /// A session is gone once it ended, or once Agent View stops listing its pid.
    fn alive(&self, pid: u32) -> bool {
        self.agents
            .as_ref()
            .is_none_or(|a| a.busy.contains_key(&pid))
    }

    /// Every live session with its workspace. A status write's --tab is the
    /// stronger join; when the hook's workspace disagrees, the row says so.
    fn placed(&self) -> Vec<Placed<'_>> {
        let mut out = Vec::new();
        for (&pid, s) in &self.sessions {
            if s.status == Status::Ended || !self.alive(pid) {
                continue;
            }
            let (ws, joined) = match self.tab_of.get(&pid) {
                Some(tab) if *tab == s.hook_ws => (tab.as_str(), "--pid".to_string()),
                Some(tab) => (tab.as_str(), format!("CONFLICT hook {}", short(&s.hook_ws))),
                None => (s.hook_ws.as_str(), "hook _ppid".to_string()),
            };
            out.push(Placed {
                pid,
                ws,
                status: s.status,
                seq: s.seq,
                joined,
            });
        }
        for (&pid, tab) in &self.tab_of {
            if !self.sessions.contains_key(&pid) && self.alive(pid) {
                let joined = "--pid".to_string();
                out.push(Placed {
                    pid,
                    ws: tab,
                    status: Status::Unknown,
                    seq: 0,
                    joined,
                });
            }
        }
        out
    }

    fn header(&self) -> String {
        format!("\n── {} UTC · seq {} ──\n", clock(), self.last_seq)
    }

    /// Everything below the header; a change here is what reprints the table.
    fn rows(&self) -> String {
        let placed = self.placed();
        let mut out = match &self.stream_down {
            Some(why) => format!("EVENT STREAM DOWN, statuses may be stale: {why}\n"),
            None => String::new(),
        };
        out.push_str(&format!(
            "{:<32} {:<12} {:<10} {:<9} {:<22} {}\n",
            "WORKSPACE", "HOOK STATUS", "AGENT VIEW", "NEEDS YOU", "JOINED BY", "SEQ"
        ));
        for (id, title) in &self.titles {
            out.push_str(&self.line(title, placed.iter().filter(|p| p.ws == id)));
        }
        // Sessions placed in a workspace the list does not have.
        let mut orphans: Vec<&Placed> = placed
            .iter()
            .filter(|p| !self.titles.iter().any(|(id, _)| id == p.ws))
            .collect();
        orphans.sort_by_key(|p| p.ws);
        for p in orphans {
            out.push_str(&self.line(&format!("? workspace {}", short(p.ws)), std::iter::once(p)));
        }
        out.push_str(&self.agent_footer(&placed));
        out
    }

    /// The workspace's most urgent live session decides its line.
    fn line<'a>(&self, title: &str, sessions: impl Iterator<Item = &'a Placed<'a>>) -> String {
        let Some(p) = sessions.max_by_key(|p| (p.status, p.seq)) else {
            return format!("{:<32} -\n", clip(title));
        };
        let view = match self.agents.as_ref().and_then(|a| a.busy.get(&p.pid)) {
            Some(true) => "busy",
            Some(false) => "idle",
            None => "not listed",
        };
        let needs = if p.status == Status::NeedsInput {
            "YES"
        } else {
            "-"
        };
        format!(
            "{:<32} {:<12} {:<10} {:<9} {:<22} {} (pid {})\n",
            clip(title),
            p.status.label(),
            view,
            needs,
            p.joined,
            p.seq,
            p.pid
        )
    }

    fn agent_footer(&self, placed: &[Placed]) -> String {
        let Some(view) = &self.agents else {
            return "Agent View: not read yet\n".to_string();
        };
        let mut out = format!(
            "Agent View: {} interactive, {} background (no pid, not joined)\n",
            view.busy.len(),
            view.background
        );
        let mut unjoined: Vec<u32> = view
            .busy
            .keys()
            .filter(|pid| !placed.iter().any(|p| p.pid == **pid))
            .copied()
            .collect();
        unjoined.sort_unstable();
        for pid in unjoined {
            out.push_str(&format!(
                "  unjoined: Agent View pid {pid} has no workspace\n"
            ));
        }
        out
    }

    fn replayed(&self) -> bool {
        self.replay_to.is_some_and(|to| self.last_seq >= to)
    }
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn clip(s: &str) -> String {
    if s.chars().count() <= 31 {
        return s.to_string();
    }
    let mut t: String = s.chars().take(30).collect();
    t.push('…');
    t
}

fn clock() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format!(
        "{:02}:{:02}:{:02}",
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60
    )
}

enum StreamEnd {
    /// The main loop has gone.
    Closed,
    /// cmux restarted since our last sequence: start again from 0.
    Restarted,
    Exited(String),
}

/// Follows `cmux events`, reconnecting itself rather than with --reconnect,
/// so a cmux restart (new boot, sequence numbers from 1 again) replays the
/// new run from the start instead of skipping up to our old sequence.
fn follow_events(mut after: u64, live: bool, tx: Sender<Msg>) {
    let mut boot: Option<String> = None;
    loop {
        match stream_once(&mut after, &mut boot, &tx) {
            StreamEnd::Closed => return,
            StreamEnd::Restarted => after = 0,
            StreamEnd::Exited(why) => {
                if tx.send(Msg::StreamDown(why)).is_err() || !live {
                    return;
                }
                thread::sleep(RETRY);
            }
        }
    }
}

fn stream_once(after: &mut u64, boot: &mut Option<String>, tx: &Sender<Msg>) -> StreamEnd {
    let spawned = Command::new("cmux")
        .args(["events", "--no-heartbeat", "--after", &after.to_string()])
        .stdout(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return StreamEnd::Exited(format!("cmux events did not start: {e}")),
    };
    let Some(stdout) = child.stdout.take() else {
        return StreamEnd::Exited("no stdout".to_string());
    };
    let end = read_stream(BufReader::new(stdout), after, boot, tx);
    let _ = child.kill();
    let status = child
        .wait()
        .map_or("unknown".to_string(), |s| s.to_string());
    end.unwrap_or(StreamEnd::Exited(format!("cmux events exited ({status})")))
}

/// Reads frames until the stream ends (None) or something ends it early.
fn read_stream(
    lines: impl BufRead,
    after: &mut u64,
    boot: &mut Option<String>,
    tx: &Sender<Msg>,
) -> Option<StreamEnd> {
    for line in lines.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("resume").is_some() {
            let this_boot = v["boot_id"].as_str().unwrap_or_default().to_string();
            if *after > 0 && boot.as_ref().is_some_and(|b| *b != this_boot) {
                return Some(StreamEnd::Restarted);
            }
            *boot = Some(this_boot);
            let to = v["resume"]["latest_seq"].as_u64().unwrap_or_default();
            if tx.send(Msg::Replaying(to)).is_err() {
                return Some(StreamEnd::Closed);
            }
        } else if let Some(seq) = v["seq"].as_u64() {
            *after = seq;
        }
        if tx.send(Msg::Event(v)).is_err() {
            return Some(StreamEnd::Closed);
        }
    }
    None
}

fn read_agents() -> Option<AgentView> {
    let out = Command::new("claude")
        .args(["agents", "--json"])
        .output()
        .ok()?;
    let list: Vec<Value> = serde_json::from_slice(&out.stdout).ok()?;
    let mut view = AgentView::default();
    for a in &list {
        match a["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) {
            Some(pid) => {
                view.busy.insert(pid, a["status"] == "busy");
            }
            None => view.background += 1,
        }
    }
    Some(view)
}

fn read_workspaces() -> Option<Vec<(String, String)>> {
    let out = Command::new("cmux")
        .args(["--json", "workspace", "list"])
        .output()
        .ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let list = v["workspaces"].as_array()?;
    Some(
        list.iter()
            .filter_map(|w| {
                Some((
                    w["id"].as_str()?.to_string(),
                    w["title"].as_str()?.to_string(),
                ))
            })
            .collect(),
    )
}

fn poll_agents(tx: Sender<Msg>) {
    loop {
        if let Some(view) = read_agents()
            && tx.send(Msg::Agents(view)).is_err()
        {
            return;
        }
        thread::sleep(AGENTS_EVERY);
    }
}

/// Reads the workspace list on start, every 30 seconds, and whenever the
/// main loop sees a workspace come or go.
fn poll_workspaces(tx: Sender<Msg>, nudge: Receiver<()>) {
    loop {
        if let Some(list) = read_workspaces()
            && tx.send(Msg::Workspaces(list)).is_err()
        {
            return;
        }
        if let Err(RecvTimeoutError::Disconnected) = nudge.recv_timeout(WORKSPACES_EVERY) {
            return;
        }
    }
}

fn workspace_changed(msg: &Msg) -> bool {
    let Msg::Event(e) = msg else { return false };
    matches!(
        e["name"].as_str(),
        Some("workspace.created" | "workspace.closed" | "workspace.renamed")
    )
}

/// --once: print as soon as replay is done and both polls have answered.
fn once_ready(state: &State, started: Instant) -> Option<String> {
    let loaded = state.agents.is_some() && !state.titles.is_empty();
    if state.replayed() && loaded {
        return Some(format!(
            "replayed in {:.1}s",
            started.elapsed().as_secs_f32()
        ));
    }
    if started.elapsed() >= ONCE_LIMIT {
        return Some(format!(
            "NOT fully replayed after {}s",
            ONCE_LIMIT.as_secs()
        ));
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let once = args.iter().any(|a| a == "--once");
    let after = args
        .iter()
        .position(|a| a == "--after")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let (tx, rx) = mpsc::channel();
    let (nudge_tx, nudge_rx) = mpsc::channel();
    let started = Instant::now();
    {
        let tx = tx.clone();
        thread::spawn(move || follow_events(after, !once, tx));
    }
    {
        let tx = tx.clone();
        thread::spawn(move || poll_agents(tx));
    }
    thread::spawn(move || poll_workspaces(tx, nudge_rx));

    // The table reprints only after SETTLE of quiet, so a replayed burst
    // prints once, and only when its rows have changed.
    let mut state = State::default();
    let mut dirty = false;
    let mut shown = String::new();
    loop {
        let quiet = match rx.recv_timeout(SETTLE) {
            Ok(msg) => {
                if workspace_changed(&msg) {
                    let _ = nudge_tx.send(());
                }
                dirty |= state.apply(msg);
                false
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if once {
            if let Some(note) = once_ready(&state, started) {
                println!("{}{}{note}", state.header(), state.rows());
                return;
            }
            continue;
        }
        if dirty && quiet {
            dirty = false;
            let rows = state.rows();
            if rows != shown {
                print!("{}{rows}", state.header());
                shown = rows;
            }
        }
    }
}
