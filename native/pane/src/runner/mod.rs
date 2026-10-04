//! The shell runner: reads every input, turns it into core events, and
//! runs the core. Inputs, each on its own thread except the files:
//!
//! - `cmux events`: replay, then live, reconnecting itself (stream.rs).
//! - `claude agents --json` every 2 seconds.
//! - `cmux --json workspace list` on start, every 30 seconds, and when a
//!   workspace event says the list may have changed.
//! - config/state.json and config/projects.json, checked every 2 seconds.
//!
//! The join (join.rs) turns the first three into one frame of the core's
//! data; a fresh frame goes in when any of them changed, and every 30
//! seconds anyway so the ages move on. The core asks for no effects that
//! write in R1.2; its render request is the cue to draw.

pub mod join;
pub mod parse;
pub mod stream;
pub mod text;
pub mod watch;

use std::ops::ControlFlow;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cockpit_core::data::Workspace;
use cockpit_core::{Cockpit, Event, Model};
use crux_core::App;
use serde_json::Value;

use join::{Change, Join, changes_workspaces};
use parse::AgentView;
use stream::CmuxEvents;
use watch::{Watched, read_projects, read_state};

pub const AGENTS_EVERY: Duration = Duration::from_secs(2);
pub const WORKSPACES_EVERY: Duration = Duration::from_secs(30);
pub const FILES_EVERY: Duration = Duration::from_secs(2);
/// A fresh frame at least this often, so ages move on with nothing new.
pub const CLOCK_EVERY: Duration = Duration::from_secs(30);
/// While a replay streams in, a frame waits for this much quiet, so a
/// burst builds one frame rather than one per batch.
pub const REPLAY_SETTLE: Duration = Duration::from_millis(300);

/// What the input threads hand the runner.
#[derive(Debug)]
pub enum Input {
    /// One frame from `cmux events`, and when it was read.
    Event(Box<Value>, Instant),
    StreamDown(String),
    Agents(AgentView),
    Workspaces(Vec<Workspace>),
}

/// A status change the latest frame carries, for the latency log.
#[derive(Debug, Clone, PartialEq)]
pub struct Latency {
    pub change: Change,
    /// When the runner read the event.
    pub read_at: Instant,
}

/// The core and the join that feeds it.
#[derive(Debug, Default)]
pub struct Pane {
    app: Cockpit,
    pub model: Model,
    pub join: Join,
}

impl Pane {
    fn send(&mut self, event: Event) {
        let mut cmd = self.app.update(event, &mut self.model);
        // R1.2's only effect is a render request; the caller draws after
        // every batch anyway.
        for _ in cmd.effects() {}
    }

    /// Takes one input. Returns whether the join changed, whether the
    /// workspace list should be read again, and any status change.
    pub fn input(&mut self, input: Input) -> (bool, bool, Option<Latency>) {
        match input {
            Input::Event(e, read_at) => {
                let nudge = changes_workspaces(&e);
                let was_caught_up = self.join.health.caught_up();
                let (changed, change) = self.join.event(&e);
                // Catching up is news too: --once waits for it.
                let changed = changed || was_caught_up != self.join.health.caught_up();
                let latency = change.map(|change| Latency { change, read_at });
                (changed, nudge, latency)
            }
            Input::StreamDown(why) => {
                self.join.stream_down(why);
                (true, false, None)
            }
            Input::Agents(view) => (self.join.agents(view), false, None),
            Input::Workspaces(list) => (self.join.workspaces(list), false, None),
        }
    }

    /// Sends the core a fresh frame at epoch `now`.
    pub fn frame(&mut self, now: f64) {
        let data = self.join.frame(now);
        self.send(Event::Data(data));
    }

    pub fn state(&mut self, saved: cockpit_core::persist::SavedState) {
        self.send(Event::State(Box::new(saved)));
    }

    pub fn projects(&mut self, projects: Vec<cockpit_core::projects::Project>) {
        self.send(Event::Projects(projects));
    }
}

/// Where the runner reads from.
#[derive(Debug, Clone)]
pub struct Options {
    /// The folder holding state.json and projects.json.
    pub config: PathBuf,
    /// Replay `cmux events` after this sequence.
    pub after: u64,
    /// Also call `on_frame` at least this often with no new frame, for a
    /// caller with a deadline of its own.
    pub wake: Option<Duration>,
}

/// Whether a frame goes in now: something changed, and no replay is
/// mid-burst (it has caught up, or gone quiet).
pub fn frame_now(pending: bool, replaying: bool, quiet: bool) -> bool {
    pending && (!replaying || quiet)
}

/// Wall-clock epoch seconds.
pub fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

/// Runs a command and returns its output when it succeeded.
fn output(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

fn poll_agents(tx: &Sender<Input>) {
    loop {
        let view = output("claude", &["agents", "--json"]).and_then(|o| parse::agents(&o));
        if let Some(view) = view
            && tx.send(Input::Agents(view)).is_err()
        {
            return;
        }
        thread::sleep(AGENTS_EVERY);
    }
}

fn poll_workspaces(tx: &Sender<Input>, nudge: &Receiver<()>) {
    loop {
        let list =
            output("cmux", &["--json", "workspace", "list"]).and_then(|o| parse::workspaces(&o));
        if let Some(list) = list
            && tx.send(Input::Workspaces(list)).is_err()
        {
            return;
        }
        if let Err(RecvTimeoutError::Disconnected) = nudge.recv_timeout(WORKSPACES_EVERY) {
            return;
        }
        // A burst of workspace events reads the list once.
        while nudge.try_recv().is_ok() {}
    }
}

/// The two watched files.
struct Files {
    state: Watched,
    projects: Watched,
}

impl Files {
    /// Sends the core whichever file changed, projects first so a new
    /// state's overrides are checked against the new table. A file that
    /// will not read (half written, say) is logged and the core keeps the
    /// last good one until the file changes again.
    fn check(&mut self, pane: &mut Pane, log: &mut dyn FnMut(String)) -> bool {
        let mut changed = false;
        if self.projects.changed() {
            match read_projects(&self.projects.path) {
                Ok(projects) => {
                    pane.projects(projects);
                    changed = true;
                }
                Err(e) => log(e),
            }
        }
        if self.state.changed() {
            match read_state(&self.state.path) {
                Ok(saved) => {
                    pane.state(saved);
                    changed = true;
                }
                Err(e) => log(e),
            }
        }
        changed
    }
}

/// Runs until `on_frame` breaks, calling it after each new frame with
/// the latest status change since the last one, and every `opts.wake`
/// with none. A replay builds its frame once it has caught up or gone
/// quiet. `log` takes lines for stderr.
pub fn run(
    opts: &Options,
    mut on_frame: impl FnMut(&Pane, Option<&Latency>) -> ControlFlow<()>,
    mut log: impl FnMut(String),
) {
    let (tx, rx) = mpsc::channel();
    let (nudge_tx, nudge_rx) = mpsc::channel();
    let events = CmuxEvents::default();
    {
        let tx = tx.clone();
        let mut source = events.clone();
        let after = opts.after;
        thread::spawn(move || stream::follow(&mut source, after, &tx));
    }
    {
        let tx = tx.clone();
        thread::spawn(move || poll_agents(&tx));
    }
    thread::spawn(move || poll_workspaces(&tx, &nudge_rx));

    let mut pane = Pane::default();
    let mut files = Files {
        state: Watched::new(opts.config.join("state.json")),
        projects: Watched::new(opts.config.join("projects.json")),
    };
    files.check(&mut pane, &mut log);
    let start = Instant::now();
    let mut files_due = start + FILES_EVERY;
    let mut clock_due = start + CLOCK_EVERY;
    let mut wake_due = opts.wake.map(|w| start + w);
    // The core has heard of a change it has no frame for yet.
    let mut pending = true;
    let mut latest: Option<Latency> = None;

    loop {
        let due = wake_due.map_or(files_due.min(clock_due), |w| {
            w.min(files_due).min(clock_due)
        });
        let mut wait = due.saturating_duration_since(Instant::now());
        if pending && pane.join.health.replaying() {
            wait = wait.min(REPLAY_SETTLE);
        }
        let mut batch = Vec::new();
        let quiet = match rx.recv_timeout(wait) {
            Ok(first) => {
                batch.push(first);
                false
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        batch.extend(rx.try_iter());

        for input in batch {
            let (changed, nudge, latency) = pane.input(input);
            pending |= changed;
            if nudge {
                let _ = nudge_tx.send(());
            }
            latest = latency.or(latest);
        }
        let now = Instant::now();
        if now >= files_due {
            files_due = now + FILES_EVERY;
            pending |= files.check(&mut pane, &mut log);
        }
        pending |= now >= clock_due;
        let woke = wake_due.is_some_and(|w| now >= w);
        if woke {
            wake_due = opts.wake.map(|w| now + w);
        }
        let flow = if frame_now(pending, pane.join.health.replaying(), quiet) {
            pending = false;
            clock_due = now + CLOCK_EVERY;
            pane.frame(now_epoch());
            on_frame(&pane, latest.take().as_ref())
        } else if woke {
            on_frame(&pane, None)
        } else {
            ControlFlow::Continue(())
        };
        if flow.is_break() {
            break;
        }
    }
    events.shut_down();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ws(id: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            title: Some(id.to_string()),
            ..Workspace::default()
        }
    }

    fn hook(seq: u64, name: &str, pid: u32, ws: &str) -> Input {
        let e = json!({"type": "event", "seq": seq, "name": format!("agent.hook.{name}"),
                       "occurred_at": "2026-10-04T15:17:37.889Z",
                       "payload": {"_ppid": pid, "workspace_id": ws}});
        Input::Event(Box::new(e), Instant::now())
    }

    #[test]
    fn a_status_change_reaches_the_view_model() {
        let mut pane = Pane::default();
        pane.state(cockpit_core::persist::SavedState::default());
        pane.input(Input::Workspaces(vec![ws("A"), ws("B")]));
        pane.input(hook(1, "UserPromptSubmit", 7, "B"));
        pane.frame(1_791_127_100.0);
        assert!(pane.model.view.needs.list.is_empty());

        let (changed, nudge, latency) = pane.input(hook(2, "PermissionRequest", 7, "B"));
        assert!(changed && !nudge);
        let latency = latency.unwrap();
        assert_eq!(
            (latency.change.seq, latency.change.hook.as_str()),
            (2, "PermissionRequest")
        );
        pane.frame(1_791_127_100.0);
        assert_eq!(pane.model.view.needs.list, vec!["B".to_string()]);
    }

    #[test]
    fn a_dead_stream_shows_in_the_join_until_the_next_ack() {
        let mut pane = Pane::default();
        let (changed, _, _) = pane.input(Input::StreamDown("cmux events exited".into()));
        assert!(changed);
        assert_eq!(pane.join.health.down.as_deref(), Some("cmux events exited"));
        let ack = json!({"boot_id": "B", "resume": {"requested_after_seq": 4, "latest_seq": 9}});
        pane.input(Input::Event(Box::new(ack), Instant::now()));
        assert_eq!(pane.join.health.down, None);
    }

    #[test]
    fn a_replay_frames_once_caught_up_or_quiet() {
        assert!(!frame_now(false, false, true), "nothing new, no frame");
        assert!(frame_now(true, false, false), "live: at once");
        assert!(!frame_now(true, true, false), "mid-burst: wait");
        assert!(frame_now(true, true, true), "a quiet replay frames anyway");
    }

    #[test]
    fn workspace_events_ask_for_the_list_again() {
        let mut pane = Pane::default();
        let e = json!({"type": "event", "seq": 1, "name": "workspace.reordered", "payload": {}});
        let (_, nudge, _) = pane.input(Input::Event(Box::new(e), Instant::now()));
        assert!(nudge);
    }
}
