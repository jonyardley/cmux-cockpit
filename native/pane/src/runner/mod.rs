//! The shell runner: reads every input, turns it into core events, and
//! runs the core. Inputs, each on its own thread except the files:
//!
//! - `cmux events`: replay, then live, reconnecting itself (stream.rs).
//! - `claude agents --json` every 2 seconds.
//! - `cmux --json workspace list`, then `cmux rpc workspace.group.list`
//!   (read only) for the list's window, on start, every 30 seconds, and
//!   when an event says either may have changed: any `workspace.` event
//!   but a selection, which takes in `workspace.reordered` (sent when a
//!   card is dragged between lanes) and `workspace.group.` names, and any
//!   `workspace_group.` one.
//! - config/state.json and config/projects.json, checked every 2 seconds.
//! - Each directory's PR, when the core asks (pr_ask.rs): `git` then `gh`
//!   on a thread per ask, the answer coming back as an input. The core
//!   decides when (cockpit_core::pr_poll), and only an answer that moves
//!   what a card shows asks for a new frame.
//!
//! The join (join.rs) turns the first four into one frame of the core's
//! data; a fresh frame goes in when any of them changed, and every 30
//! seconds anyway so the ages move on. The core's render request is the
//! cue to draw; its cmux calls and state writes go to one worker thread
//! (outbox.rs), which carries them out in order. Jon's actions reach the
//! core through `Feed::act`.

pub mod join;
pub mod outbox;
pub mod parse;
pub mod pr_ask;
pub mod stream;
pub mod text;
pub mod watch;

use std::io::Read;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cockpit_core::data::Workspace;
use cockpit_core::pr_poll::PrPolled;
use cockpit_core::{Cockpit, Effect, Event, Model};
use crux_core::App;
use serde_json::Value;

use join::{Change, Join, changes_workspaces};
use outbox::Outgoing;
use parse::{AgentView, Groups};
use stream::CmuxEvents;
use watch::{Watched, read_projects, read_state};

pub const AGENTS_EVERY: Duration = Duration::from_secs(2);
pub const WORKSPACES_EVERY: Duration = Duration::from_secs(30);
pub const FILES_EVERY: Duration = Duration::from_secs(2);
/// A fresh frame at least this often, so ages move on with nothing new.
pub const CLOCK_EVERY: Duration = Duration::from_secs(30);
/// The longest a poll's command may run before it is killed.
pub const COMMAND_LIMIT: Duration = Duration::from_secs(10);
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
    Groups(Groups),
    /// From the caller's own thread (a key press, say): call `on_frame`
    /// now, with or without a new frame.
    Poke,
    /// A line for the log, from the outbox worker.
    Log(String),
    /// From the outbox worker: a cmux call about this workspace failed.
    CmuxFailed(String),
    /// A directory's PR, as the core asked for it.
    PrPolled(Box<PrPolled>),
}

/// What `on_frame` is called with besides the feed.
#[derive(Debug, Clone, Copy, Default)]
pub struct Call<'a> {
    /// A new frame went into the core.
    pub fresh: bool,
    /// The latest live status change since the last frame.
    pub latency: Option<&'a Latency>,
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
pub struct Feed {
    app: Cockpit,
    pub model: Model,
    pub join: Join,
    /// The outbox worker, while `run` drives the feed.
    worker: Option<Sender<Outgoing>>,
    /// Requests made with no worker to take them (a feed driven by hand,
    /// as the tests do), oldest first.
    pub unsent: Vec<Outgoing>,
    /// Where the core's PR asks go, while `run` drives the feed.
    asker: Option<Sender<String>>,
    /// PR asks made with no asker to take them, oldest first.
    pub unasked: Vec<String>,
}

impl Feed {
    /// Sends the core an event and hands its requests on. True when the
    /// core asked for a render.
    fn send(&mut self, event: Event) -> bool {
        let mut cmd = self.app.update(event, &mut self.model);
        let mut render = false;
        for effect in cmd.effects() {
            let out = match effect {
                // The caller draws after every batch anyway.
                Effect::Render(_) => {
                    render = true;
                    continue;
                }
                Effect::PrPoll(r) => {
                    self.ask(r.operation.directory);
                    continue;
                }
                Effect::Cmux(r) => Outgoing::Cmux(r.operation),
                Effect::Persist(r) => Outgoing::Persist(r.operation),
            };
            // A worker gone (only once the run ends) keeps what it missed.
            match &self.worker {
                Some(w) => {
                    if let Err(mpsc::SendError(out)) = w.send(out) {
                        self.unsent.push(out);
                    }
                }
                None => self.unsent.push(out),
            }
        }
        render
    }

    fn ask(&mut self, directory: String) {
        match &self.asker {
            Some(a) => {
                if let Err(mpsc::SendError(d)) = a.send(directory) {
                    self.unasked.push(d);
                }
            }
            None => self.unasked.push(directory),
        }
    }

    /// Tells the core the shell can run `git` and `gh`, so it starts
    /// asking for each directory's PR.
    pub fn poll_prs(&mut self) {
        self.send(Event::PrPollOn);
    }

    /// One of Jon's actions (`Event::MoveCard`, `SwitchTo`, `Dismiss` or
    /// `FlipView`): the core takes it at once and the cmux calls and state
    /// writes it asks for go to the outbox worker. The caller draws after.
    /// Any other event is ignored: the feed's inputs bring those.
    pub fn act(&mut self, event: Event) {
        if matches!(
            event,
            Event::MoveCard { .. }
                | Event::SwitchTo { .. }
                | Event::Dismiss { .. }
                | Event::FlipView
        ) {
            self.send(event);
        }
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
            Input::Groups(groups) => (self.join.groups(groups), false, None),
            Input::CmuxFailed(id) => {
                self.send(Event::CmuxFailed { id });
                (true, false, None)
            }
            // Only an answer that moves what a card shows is news.
            Input::PrPolled(polled) => (self.send(Event::PrPolled(polled)), false, None),
            // `run` logs these itself before they reach the feed.
            Input::Poke | Input::Log(_) => (false, false, None),
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

/// Runs a command and returns its output when it succeeded within
/// `limit`; one that hangs is killed, so a stuck cmux cannot stop a poll
/// for good. The output is read on its own thread, so a large one never
/// fills the pipe.
fn output_within(program: &str, args: &[&str], limit: Duration) -> Option<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let read = stdout.read_to_end(&mut buf).map(|_| buf);
        let _ = done_tx.send(read);
    });
    let read = done_rx.recv_timeout(limit);
    if read.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    let out = read.ok()?.ok()?;
    status.success().then_some(out)
}

fn output(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    output_within(program, args, COMMAND_LIMIT)
}

/// Runs an outbox request's command; true when it succeeded in time.
fn run_ok(program: &str, args: &[String]) -> bool {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    output(program, &args).is_some()
}

fn poll_agents(tx: &Sender<Input>, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        let view = output("claude", &["agents", "--json"]).and_then(|o| parse::agents(&o));
        if let Some(view) = view
            && tx.send(Input::Agents(view)).is_err()
        {
            return;
        }
        thread::sleep(AGENTS_EVERY);
    }
}

/// The workspace list and the window it answers for.
type List = (Vec<Workspace>, Option<String>);

fn read_list() -> Option<List> {
    let out = output("cmux", &["--json", "workspace", "list"])?;
    Some((parse::workspaces(&out)?, parse::window_ref(&out)))
}

/// The groups of `window`, the workspace list's own, so the two never
/// answer for different windows; cmux's default window when unknown.
fn read_groups(window: Option<&str>) -> Option<Groups> {
    let params = window.map(|w| serde_json::json!({ "window_id": w }).to_string());
    let mut args = vec!["rpc", "workspace.group.list"];
    args.extend(params.as_deref());
    output("cmux", &args).and_then(|o| parse::groups(&o, window))
}

/// Reads the workspace list, then its window's groups, on start, every
/// `every`, and on each nudge. The list goes out as soon as it is read,
/// so a slow group read never holds it up; until the groups first answer
/// the join is not loaded. A read that fails keeps the last good one.
fn poll_layout(
    tx: &Sender<Input>,
    nudge: &Receiver<()>,
    every: Duration,
    read_list: impl Fn() -> Option<List>,
    read_groups: impl Fn(Option<&str>) -> Option<Groups>,
) {
    let mut window: Option<String> = None;
    loop {
        if let Some((list, win)) = read_list() {
            window = win.or(window);
            if tx.send(Input::Workspaces(list)).is_err() {
                return;
            }
        }
        if let Some(groups) = read_groups(window.as_deref())
            && tx.send(Input::Groups(groups)).is_err()
        {
            return;
        }
        if let Err(RecvTimeoutError::Disconnected) = nudge.recv_timeout(every) {
            return;
        }
        // A burst of workspace events reads the layout once.
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
    fn check(&mut self, feed: &mut Feed, log: &mut dyn FnMut(String)) -> bool {
        let mut changed = false;
        if self.projects.changed() {
            match read_projects(&self.projects.path) {
                Ok(projects) => {
                    feed.projects(projects);
                    changed = true;
                }
                Err(e) => log(e),
            }
        }
        if self.state.changed() {
            match read_state(&self.state.path) {
                Ok(saved) => {
                    feed.state(saved);
                    changed = true;
                }
                Err(e) => log(e),
            }
        }
        changed
    }
}

/// The runner's input channel. A caller keeps a clone of the sender to
/// send `Input::Poke`, and hands both ends to `run`.
pub fn channel() -> (Sender<Input>, Receiver<Input>) {
    mpsc::channel()
}

/// Runs until `on_frame` breaks, calling it after each new frame with
/// the latest status change since the last one, every `opts.wake`, and
/// on each `Input::Poke`. A replay builds its frame once it has caught up
/// or gone quiet. `log` takes lines for stderr.
pub fn run(
    opts: &Options,
    (tx, rx): (Sender<Input>, Receiver<Input>),
    mut on_frame: impl FnMut(&mut Feed, Call<'_>) -> ControlFlow<()>,
    mut log: impl FnMut(String),
) {
    let (nudge_tx, nudge_rx) = mpsc::channel();
    let events = CmuxEvents::default();
    {
        let tx = tx.clone();
        let mut source = events.clone();
        let after = opts.after;
        thread::spawn(move || stream::follow(&mut source, after, &tx));
    }
    let stop = Arc::new(AtomicBool::new(false));
    {
        let tx = tx.clone();
        let stop = Arc::clone(&stop);
        thread::spawn(move || poll_agents(&tx, &stop));
    }
    let mut feed = Feed::default();
    let worker = {
        let (out_tx, out_rx) = mpsc::channel();
        let config = opts.config.clone();
        let tx = tx.clone();
        feed.worker = Some(out_tx);
        thread::spawn(move || {
            let reports = outbox::Reports {
                log: |line| {
                    let _ = tx.send(Input::Log(line));
                },
                failed: |id| {
                    let _ = tx.send(Input::CmuxFailed(id));
                },
            };
            outbox::perform(&out_rx, &config, run_ok, &reports);
        })
    };
    {
        let (ask_tx, ask_rx) = mpsc::channel();
        let tx = tx.clone();
        feed.asker = Some(ask_tx);
        thread::spawn(move || pr_ask::serve(&ask_rx, &tx, pr_ask::ask));
    }
    thread::spawn(move || {
        poll_layout(&tx, &nudge_rx, WORKSPACES_EVERY, read_list, read_groups);
    });

    let mut files = Files {
        state: Watched::new(opts.config.join("state.json")),
        projects: Watched::new(opts.config.join("projects.json")),
    };
    files.check(&mut feed, &mut log);
    feed.poll_prs();
    let start = Instant::now();
    let mut files_due = start + FILES_EVERY;
    let mut clock_due = start + CLOCK_EVERY;
    let mut wake_due = opts.wake.map(|w| start + w);
    // The core has heard of a change it has no frame for yet.
    let mut pending = true;
    let mut latest: Option<Latency> = None;
    // Quiet is measured from the last input, not from any timeout, so a
    // check falling due mid-burst does not frame a half-read replay.
    let mut last_input = start;

    loop {
        let due = wake_due.map_or(files_due.min(clock_due), |w| {
            w.min(files_due).min(clock_due)
        });
        let mut wait = due.saturating_duration_since(Instant::now());
        if pending && feed.join.health.replaying() {
            let settled = (last_input + REPLAY_SETTLE).saturating_duration_since(Instant::now());
            wait = wait.min(settled);
        }
        let mut batch = Vec::new();
        match rx.recv_timeout(wait) {
            Ok(first) => batch.push(first),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        batch.extend(rx.try_iter());
        // A log line from the worker is not news, so it never holds off a
        // replay's quiet.
        if batch.iter().any(|i| !matches!(i, Input::Log(_))) {
            last_input = Instant::now();
        }

        let mut poked = false;
        for input in batch {
            if let Input::Log(line) = input {
                log(line);
                continue;
            }
            poked |= matches!(input, Input::Poke);
            // A replayed status change is history, not latency.
            let live = !feed.join.health.replaying();
            let (changed, nudge, latency) = feed.input(input);
            pending |= changed;
            if nudge {
                let _ = nudge_tx.send(());
            }
            if live {
                latest = latency.or(latest);
            }
        }
        let now = Instant::now();
        let quiet = now.duration_since(last_input) >= REPLAY_SETTLE;
        if now >= files_due {
            files_due = now + FILES_EVERY;
            pending |= files.check(&mut feed, &mut log);
        }
        pending |= now >= clock_due;
        let woke = wake_due.is_some_and(|w| now >= w);
        if woke {
            wake_due = opts.wake.map(|w| now + w);
        }
        let flow = if frame_now(pending, feed.join.health.replaying(), quiet) {
            pending = false;
            clock_due = now + CLOCK_EVERY;
            feed.frame(now_epoch());
            let latency = latest.take();
            let call = Call {
                fresh: true,
                latency: latency.as_ref(),
            };
            on_frame(&mut feed, call)
        } else if woke || poked {
            on_frame(&mut feed, Call::default())
        } else {
            ControlFlow::Continue(())
        };
        if flow.is_break() {
            break;
        }
    }
    stop.store(true, Ordering::SeqCst);
    events.shut_down();
    // Let the worker finish what was asked, so a quit straight after a move
    // never splits a reorder from the group join behind it. Each request is
    // bounded by COMMAND_LIMIT.
    feed.worker = None;
    feed.asker = None;
    let _ = worker.join();
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::data::WorkspaceGroup;
    use cockpit_core::lane_entries::LaneEntry;
    use cockpit_core::lanes::LaneKey;
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
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        feed.input(Input::Workspaces(vec![ws("A"), ws("B")]));
        feed.input(hook(1, "UserPromptSubmit", 7, "B"));
        feed.frame(1_791_127_100.0);
        assert!(feed.model.view.needs.list.is_empty());

        let (changed, nudge, latency) = feed.input(hook(2, "PermissionRequest", 7, "B"));
        assert!(changed && !nudge);
        let latency = latency.unwrap();
        assert_eq!(
            (latency.change.seq, latency.change.hook.as_str()),
            (2, "PermissionRequest")
        );
        feed.frame(1_791_127_100.0);
        assert_eq!(feed.model.view.needs.list, vec!["B".to_string()]);
    }

    #[test]
    fn a_dead_stream_shows_in_the_join_until_the_next_ack() {
        let mut feed = Feed::default();
        let (changed, _, _) = feed.input(Input::StreamDown("cmux events exited".into()));
        assert!(changed);
        assert_eq!(feed.join.health.down.as_deref(), Some("cmux events exited"));
        let ack = json!({"boot_id": "B", "resume": {"requested_after_seq": 4, "latest_seq": 9}});
        feed.input(Input::Event(Box::new(ack), Instant::now()));
        assert_eq!(feed.join.health.down, None);
    }

    #[test]
    fn a_replay_frames_once_caught_up_or_quiet() {
        assert!(!frame_now(false, false, true), "nothing new, no frame");
        assert!(frame_now(true, false, false), "live: at once");
        assert!(!frame_now(true, true, false), "mid-burst: wait");
        assert!(frame_now(true, true, true), "a quiet replay frames anyway");
    }

    #[test]
    fn a_poll_command_that_hangs_is_killed_at_its_limit() {
        let started = Instant::now();
        let out = output_within("sleep", &["5"], Duration::from_millis(100));
        assert_eq!(out, None);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            output_within("echo", &["hi"], Duration::from_secs(5)),
            Some(b"hi\n".to_vec())
        );
        assert_eq!(output_within("false", &[], Duration::from_secs(5)), None);
    }

    fn group(
        id: &str,
        name: &str,
        anchor: &str,
        members: &[&str],
    ) -> (WorkspaceGroup, Vec<String>) {
        let g = WorkspaceGroup {
            id: id.to_string(),
            name: Some(name.to_string()),
            anchor_id: Some(anchor.to_string()),
            collapsed: Some(false),
        };
        (g, members.iter().map(|m| m.to_string()).collect())
    }

    fn groups(list: &[(WorkspaceGroup, Vec<String>)]) -> Groups {
        let mut out = Groups::default();
        for (g, members) in list {
            for m in members {
                out.member_of.insert(m.clone(), g.id.clone());
            }
            out.list.push(g.clone());
        }
        out
    }

    /// Each card in the view model with its lane, and each lane header's
    /// anchor, in view order.
    type Placed = (Vec<(LaneKey, String)>, Vec<(LaneKey, Option<String>)>);

    fn placed(feed: &Feed) -> Placed {
        let (mut cards, mut headers): Placed = (Vec::new(), Vec::new());
        for e in &feed.model.view.lane_entries {
            match e {
                LaneEntry::Ws { ws_id, lane, .. } => cards.push((*lane, ws_id.clone())),
                LaneEntry::Header {
                    lane, anchor_id, ..
                } => headers.push((*lane, anchor_id.clone())),
                LaneEntry::Zone { .. } | LaneEntry::Ghost { .. } => {}
            }
        }
        (cards, headers)
    }

    fn titled(id: &str, title: &str) -> Workspace {
        Workspace {
            title: Some(title.to_string()),
            ..ws(id)
        }
    }

    // Background rather than Parked, which starts folded and so draws no
    // cards until it is opened.
    #[test]
    fn groups_put_cards_in_lanes_and_anchors_in_headers() {
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        feed.input(Input::Workspaces(vec![
            titled("M", "real card anchoring Main"),
            titled("C", "a card"),
            titled("P", "Background"),
            titled("Q", "background card"),
            titled("U", "loose"),
        ]));
        feed.input(Input::Groups(groups(&[
            group("gm", "Main activity", "M", &["M", "C"]),
            group("gb", "Background", "P", &["P", "Q"]),
        ])));
        feed.frame(1_791_127_100.0);
        let (cards, headers) = placed(&feed);
        let card = |l: LaneKey, id: &str| (l, id.to_string());
        assert_eq!(
            cards,
            vec![
                card(LaneKey::Main, "M"),
                card(LaneKey::Main, "C"),
                card(LaneKey::Bg, "Q"),
                card(LaneKey::Unsorted, "U"),
            ],
            "a generated anchor (P) is no card; a real one (M) is"
        );
        // A generated anchor names its header only while it has an agent
        // or unread messages; either way it is never a card.
        assert_eq!(
            headers,
            vec![
                (LaneKey::Main, None),
                (LaneKey::Bg, None),
                (LaneKey::Unsorted, None)
            ]
        );
    }

    /// A feed with Q loose and Background's group made, framed once.
    fn moving_feed() -> Feed {
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        feed.input(Input::Workspaces(vec![
            titled("P", "Background"),
            titled("Q", "q"),
        ]));
        feed.input(Input::Groups(groups(&[group(
            "gb",
            "Background",
            "P",
            &["P"],
        )])));
        feed.frame(1_791_127_100.0);
        feed
    }

    fn move_q() -> Event {
        Event::MoveCard {
            id: "Q".into(),
            lane: LaneKey::Bg,
            before: None,
        }
    }

    fn methods(out: &[Outgoing]) -> Vec<String> {
        out.iter()
            .map(|o| match o {
                Outgoing::Cmux(c) => c.method.clone(),
                Outgoing::Persist(p) => format!("set {}", p.key),
            })
            .collect()
    }

    #[test]
    fn an_action_lands_at_once_and_its_requests_go_to_the_worker_in_order() {
        let mut feed = moving_feed();
        let (tx, rx) = mpsc::channel();
        feed.worker = Some(tx);
        feed.act(move_q());
        assert_eq!(placed(&feed).0, vec![(LaneKey::Bg, "Q".to_string())]);
        feed.act(Event::FlipView);
        let sent: Vec<Outgoing> = rx.try_iter().collect();
        assert_eq!(
            methods(&sent),
            ["workspace.reorder", "workspace.group.add", "set ui.mode"]
        );
        assert!(feed.unsent.is_empty());
    }

    #[test]
    fn a_moved_card_holds_through_stale_layout_reads_and_a_new_state_file() {
        let mut feed = moving_feed();
        feed.act(move_q());
        // The 30 second poll answers before cmux has made the move.
        feed.input(Input::Groups(groups(&[group(
            "gb",
            "Background",
            "P",
            &["P"],
        )])));
        feed.state(cockpit_core::persist::SavedState::default());
        feed.frame(1_791_127_160.0);
        assert_eq!(placed(&feed).0, vec![(LaneKey::Bg, "Q".to_string())]);
        assert_eq!(
            methods(&feed.unsent),
            ["workspace.reorder", "workspace.group.add"],
            "the move's own requests, once"
        );
    }

    #[test]
    fn a_failed_cmux_call_lets_the_card_go_back_to_where_cmux_has_it() {
        let mut feed = moving_feed();
        feed.act(move_q());
        let (changed, _, _) = feed.input(Input::CmuxFailed("Q".into()));
        assert!(changed, "the view must draw again");
        feed.frame(1_791_127_101.0);
        assert_eq!(placed(&feed).0, vec![(LaneKey::Unsorted, "Q".to_string())]);
    }

    #[test]
    fn act_takes_only_jons_actions() {
        let mut feed = moving_feed();
        feed.act(Event::State(Box::default()));
        feed.act(Event::Refresh);
        assert!(feed.unsent.is_empty());
        feed.act(Event::SwitchTo { id: "Q".into() });
        assert_eq!(methods(&feed.unsent), ["workspace.select"]);
    }

    #[test]
    fn the_core_asks_for_prs_and_only_a_chip_change_is_news() {
        use cockpit_core::pr_poll::{PollAnswer, PrPolled};
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        let mut q = titled("Q", "q");
        q.directory = Some("/repo".into());
        feed.input(Input::Workspaces(vec![q]));
        feed.input(Input::Groups(groups(&[])));
        feed.frame(1_791_127_100.0);
        assert!(feed.unasked.is_empty(), "off until the runner turns it on");
        feed.poll_prs();
        assert_eq!(feed.unasked, ["/repo"]);

        let polled = |checks: &str, epoch| {
            let pr = format!(
                r#"{{"number": 2, "url": "https://github.com/o/r/pull/2", "status": "open",
                    "branch": "feat", "checks": {checks}}}"#
            );
            Input::PrPolled(Box::new(PrPolled {
                directory: "/repo".into(),
                answer: PollAnswer::Answered {
                    branch: "feat".into(),
                    pr: serde_json::from_str(&pr).ok(),
                },
                epoch,
            }))
        };
        let running = r#"[{"name": "a", "state": "pending"}]"#;
        let still = r#"[{"name": "b", "state": "pending"}, {"name": "c", "state": "pass"}]"#;
        assert!(
            feed.input(polled(running, 1_791_127_101.0)).0,
            "a PR appeared"
        );
        assert!(
            !feed.input(polled(still, 1_791_127_140.0)).0,
            "the chip still says running"
        );
    }

    #[test]
    fn a_request_the_gone_worker_missed_is_kept() {
        let mut feed = moving_feed();
        let (tx, rx) = mpsc::channel();
        drop(rx);
        feed.worker = Some(tx);
        feed.act(Event::FlipView);
        assert_eq!(methods(&feed.unsent), ["set ui.mode"]);
    }

    #[test]
    fn a_group_event_moves_the_card_in_the_view_model() {
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        feed.input(Input::Workspaces(vec![
            titled("P", "Background"),
            titled("Q", "q"),
        ]));
        feed.input(Input::Groups(groups(&[group(
            "gb",
            "Background",
            "P",
            &["P"],
        )])));
        feed.frame(1_791_127_100.0);
        assert_eq!(placed(&feed).0, vec![(LaneKey::Unsorted, "Q".to_string())]);

        // The event asks for the layout again; the poll's reply is the move.
        for name in ["workspace.reordered", "workspace.group.add"] {
            let e = json!({"type": "event", "seq": 1, "name": name, "payload": {}});
            let (_, nudge, _) = feed.input(Input::Event(Box::new(e), Instant::now()));
            assert!(nudge, "{name}");
        }
        let (changed, _, _) = feed.input(Input::Groups(groups(&[group(
            "gb",
            "Background",
            "P",
            &["P", "Q"],
        )])));
        assert!(changed);
        feed.frame(1_791_127_101.0);
        assert_eq!(placed(&feed).0, vec![(LaneKey::Bg, "Q".to_string())]);
    }

    #[test]
    fn the_layout_poll_reads_again_at_once_on_a_nudge() {
        let (tx, rx) = mpsc::channel();
        let (nudge_tx, nudge_rx) = mpsc::channel();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&reads);
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let windows = Arc::clone(&asked);
        let list = || Some((vec![ws("P")], Some("window:1".to_string())));
        let read_groups = move |window: Option<&str>| {
            if let Ok(mut w) = windows.lock() {
                w.push(window.map(str::to_string));
            }
            let n = counter.fetch_add(1, Ordering::SeqCst);
            Some(groups(&[group("g", "Parked", "P", &["P"])][..n.min(1)]))
        };
        // A long period, so only the nudge can explain a second read.
        let poll = thread::spawn(move || {
            poll_layout(&tx, &nudge_rx, Duration::from_secs(600), list, read_groups);
        });
        let next = || rx.recv_timeout(Duration::from_secs(1));
        assert!(matches!(next(), Ok(Input::Workspaces(_))));
        assert!(matches!(next(), Ok(Input::Groups(g)) if g.list.is_empty()));

        let nudged = Instant::now();
        let _ = nudge_tx.send(());
        assert!(matches!(next(), Ok(Input::Workspaces(_))));
        assert!(matches!(next(), Ok(Input::Groups(g)) if g.list.len() == 1));
        assert!(nudged.elapsed() < Duration::from_secs(1));
        assert_eq!(reads.load(Ordering::SeqCst), 2);

        drop(nudge_tx);
        assert!(poll.join().is_ok(), "a closed nudge ends the poll");
        let asked = asked.lock().map(|a| a.clone()).unwrap_or_default();
        let one = Some("window:1".to_string());
        assert_eq!(asked, vec![one.clone(), one], "the list's own window");
    }

    #[test]
    fn a_failed_group_read_keeps_the_last_good_one() {
        let (tx, rx) = mpsc::channel();
        let (nudge_tx, nudge_rx) = mpsc::channel::<()>();
        drop(nudge_tx);
        let list = || Some((vec![ws("A"), ws("B")], None));
        poll_layout(&tx, &nudge_rx, Duration::from_secs(600), list, |_| None);
        let sent: Vec<Input> = rx.try_iter().collect();
        assert!(
            matches!(sent.as_slice(), [Input::Workspaces(_)]),
            "{sent:?}"
        );

        // The join keeps the groups it had through a poll that sent none.
        let mut feed = Feed::default();
        feed.input(Input::Groups(groups(&[group(
            "g",
            "Background",
            "A",
            &["A", "B"],
        )])));
        for input in sent {
            feed.input(input);
        }
        let d = feed.join.frame(0.0);
        assert_eq!(d.group_list().len(), 1);
        assert_eq!(d.ws_by_id("B").and_then(|w| w.group.as_deref()), Some("g"));
        assert!(feed.join.missing().contains(&"Agent View"));
        assert!(!feed.join.missing().contains(&"group list"));
    }

    #[test]
    fn workspace_events_ask_for_the_list_again() {
        let mut feed = Feed::default();
        let e = json!({"type": "event", "seq": 1, "name": "workspace.reordered", "payload": {}});
        let (_, nudge, _) = feed.input(Input::Event(Box::new(e), Instant::now()));
        assert!(nudge);
    }
}
