//! R1.0 status spike. Follows `cmux events` (replay, then live) and polls
//! `claude agents --json`, joins the two on the Claude process id, and prints
//! one line per workspace: title, status, needs you or not.
//!
//! Throwaway: it exists to prove the join in the R1 plan's section 2 holds.
//! Run `cargo run --release` for the live table, `-- --once` to replay,
//! print once and exit (the restart check).

use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

const AGENTS_EVERY: Duration = Duration::from_secs(2);
const WORKSPACES_EVERY: Duration = Duration::from_secs(30);
/// Quiet time after the last change before the table reprints.
const SETTLE: Duration = Duration::from_millis(300);
/// In --once mode, how long replay gets before the table prints.
const ONCE_AFTER: Duration = Duration::from_secs(3);

enum Msg {
    Event(Value),
    Agents(Vec<Agent>),
    Workspaces(Vec<(String, String)>),
}

struct Agent {
    pid: u32,
    busy: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Status {
    Ended,
    Idle,
    Working,
    NeedsInput,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Ended => "ended",
            Status::Idle => "idle",
            Status::Working => "working",
            Status::NeedsInput => "needs input",
        }
    }
}

/// What a Claude hook says about the session that sent it. None leaves the
/// status as it was (a subagent finishing does not end the parent's turn).
fn status_from_hook(name: &str) -> Option<Status> {
    match name {
        "SessionStart" | "Stop" => Some(Status::Idle),
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact" => Some(Status::Working),
        "Notification" => Some(Status::NeedsInput),
        "SessionEnd" => Some(Status::Ended),
        _ => None,
    }
}

/// How a pid was tied to a workspace: the --pid on a status write, or the
/// _ppid on a hook event.
#[derive(Clone, Copy)]
enum Join {
    StatusWrite,
    Hook,
}

struct Session {
    status: Status,
    seq: u64,
}

#[derive(Default)]
struct State {
    boot: String,
    last_seq: u64,
    titles: BTreeMap<String, String>,
    /// pid -> (workspace id, how we know)
    pid_ws: HashMap<u32, (String, Join)>,
    /// (workspace id, pid) -> hook-derived status
    sessions: BTreeMap<(String, u32), Session>,
    /// pid -> busy, from Agent View
    agents: HashMap<u32, bool>,
    background: usize,
}

impl State {
    fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Event(e) => self.event(&e),
            Msg::Agents(list) => {
                self.agents = list.iter().map(|a| (a.pid, a.busy)).collect();
            }
            Msg::Workspaces(list) => self.titles = list.into_iter().collect(),
        }
    }

    fn event(&mut self, e: &Value) {
        if e["type"] != "event" {
            return;
        }
        let boot = e["boot_id"].as_str().unwrap_or_default();
        if boot != self.boot {
            // cmux restarted: sequence numbers and sessions start over.
            self.boot = boot.to_string();
            self.pid_ws.clear();
            self.sessions.clear();
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
            self.pid_ws
                .insert(pid, (tab.to_string(), Join::StatusWrite));
        }
    }

    fn hook(&mut self, hook: &str, p: &Value, seq: u64) {
        let (Some(ws), Some(pid)) = (p["workspace_id"].as_str(), p["_ppid"].as_u64()) else {
            return;
        };
        let Ok(pid) = u32::try_from(pid) else { return };
        // A status write's --pid is the stronger join; keep it if we have one.
        self.pid_ws
            .entry(pid)
            .or_insert_with(|| (ws.to_string(), Join::Hook));
        if let Some(status) = status_from_hook(hook) {
            self.sessions
                .insert((ws.to_string(), pid), Session { status, seq });
        }
    }

    fn render(&self) -> String {
        let mut out = format!(
            "\n── {} · seq {} · {} agents in Agent View ({} background, no pid) ──\n",
            clock(),
            self.last_seq,
            self.agents.len() + self.background,
            self.background
        );
        out.push_str(&format!(
            "{:<32} {:<12} {:<10} {:<9} {:<12} {}\n",
            "WORKSPACE", "HOOK STATUS", "AGENT VIEW", "NEEDS YOU", "JOINED BY", "SEQ"
        ));
        for (id, title) in &self.titles {
            out.push_str(&self.line(id, title));
        }
        for pid in self.unjoined() {
            out.push_str(&format!(
                "  unjoined: Agent View pid {pid} has no workspace\n"
            ));
        }
        out
    }

    /// The workspace's most urgent live session decides its line.
    fn line(&self, id: &str, title: &str) -> String {
        let best = self
            .sessions
            .range((id.to_string(), 0)..=(id.to_string(), u32::MAX))
            .filter(|(_, s)| s.status != Status::Ended)
            .max_by_key(|(_, s)| (s.status, s.seq));
        let Some(((_, pid), s)) = best else {
            return format!("{:<32} {:<12}\n", clip(title), "-");
        };
        let view = match self.agents.get(pid) {
            Some(true) => "busy",
            Some(false) => "idle",
            None => "not listed",
        };
        let joined = match self.pid_ws.get(pid) {
            Some((_, Join::StatusWrite)) => "--pid",
            Some((_, Join::Hook)) => "hook _ppid",
            None => "?",
        };
        let needs = if s.status == Status::NeedsInput {
            "YES"
        } else {
            "-"
        };
        format!(
            "{:<32} {:<12} {:<10} {:<9} {:<12} {} (pid {pid})\n",
            clip(title),
            s.status.label(),
            view,
            needs,
            joined,
            s.seq
        )
    }

    fn unjoined(&self) -> Vec<u32> {
        let mut v: Vec<u32> = self
            .agents
            .keys()
            .filter(|p| !self.pid_ws.contains_key(p))
            .copied()
            .collect();
        v.sort_unstable();
        v
    }
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
    Command::new("date")
        .arg("+%H:%M:%S")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn follow_events(after: u64, live: bool, tx: Sender<Msg>) {
    let mut cmd = Command::new("cmux");
    cmd.args([
        "events",
        "--no-heartbeat",
        "--no-ack",
        "--after",
        &after.to_string(),
    ]);
    if live {
        cmd.arg("--reconnect");
    }
    let mut child = match cmd.stdout(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return eprintln!("cmux events failed to start: {e}"),
    };
    let Some(stdout) = child.stdout.take() else {
        return;
    };
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if tx.send(Msg::Event(v)).is_err() {
            break;
        }
    }
    let _ = child.kill();
}

fn read_agents() -> Option<(Vec<Agent>, usize)> {
    let out = Command::new("claude")
        .args(["agents", "--json"])
        .output()
        .ok()?;
    let list: Vec<Value> = serde_json::from_slice(&out.stdout).ok()?;
    let mut agents = Vec::new();
    let mut background = 0;
    for a in &list {
        match a["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) {
            Some(pid) => agents.push(Agent {
                pid,
                busy: a["status"] == "busy",
            }),
            None => background += 1,
        }
    }
    Some((agents, background))
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

/// Polls Agent View; the background count rides along as its own message.
fn poll_agents(tx: Sender<Msg>, bg: Sender<usize>) {
    loop {
        if let Some((agents, background)) = read_agents()
            && (tx.send(Msg::Agents(agents)).is_err() || bg.send(background).is_err())
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
    let (bg_tx, bg_rx) = mpsc::channel();
    let (nudge_tx, nudge_rx) = mpsc::channel();
    let started = Instant::now();
    {
        let tx = tx.clone();
        thread::spawn(move || follow_events(after, !once, tx));
    }
    {
        let tx = tx.clone();
        thread::spawn(move || poll_agents(tx, bg_tx));
    }
    thread::spawn(move || poll_workspaces(tx, nudge_rx));

    let mut state = State::default();
    // The table reprints only after SETTLE of quiet, so a replayed burst
    // prints once, and only when what it shows has changed.
    let mut dirty = false;
    let mut shown = String::new();
    loop {
        let quiet = match rx.recv_timeout(SETTLE) {
            Ok(msg) => {
                if workspace_changed(&msg) {
                    let _ = nudge_tx.send(());
                }
                state.apply(msg);
                dirty = true;
                false
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        while let Ok(n) = bg_rx.try_recv() {
            state.background = n;
        }
        if once {
            if started.elapsed() >= ONCE_AFTER {
                print!("{}", state.render());
                return;
            }
            continue;
        }
        if dirty && quiet {
            dirty = false;
            let table = state.render();
            // The header carries the clock and seq; compare the rows only.
            let rows = table.split_once("──\n").map_or("", |(_, r)| r).to_string();
            if rows != shown {
                print!("{table}");
                shown = rows;
            }
        }
    }
}
