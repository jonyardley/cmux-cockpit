//! The shell runner: reads every input, turns it into core events, and
//! runs the core. Any front end drives it the same way, the terminal
//! pane today and the Swift panel next, so the two cannot disagree about
//! the shell rules. Nothing here knows about a terminal:
//!
//! - Start: `run` with an `Options` (the config folder, where to replay
//!   from, an optional wake, the home folder) and the ends of `channel()`.
//! - Each new frame: `run` calls `on_frame` with the `Feed`, whose
//!   `model` is the core's model with the frame in it.
//! - Send an action: `Feed::act` inside `on_frame`, so the next frame or
//!   key is read against the core's new view.
//! - Stop: `on_frame` returns `ControlFlow::Break`. Another thread wakes
//!   the loop to ask it with `Input::Poke` on the kept sender.
//!
//! Inputs, each on its own thread except the files:
//!
//! - `cmux events`: replay, then live, reconnecting itself (stream.rs).
//! - `claude agents --json` every 2 seconds, once per Claude config dir
//!   (parse::other_config_dirs), read at once and merged into one Agent
//!   View, each dir keeping its last good view (parse::AgentViews).
//! - `cmux --json workspace list`, then `cmux rpc workspace.group.list`
//!   (read only) for the list's window, on start, every 30 seconds, and
//!   when an event says either may have changed: any `workspace.` event
//!   but a selection, which takes in `workspace.reordered` (sent when a
//!   card is dragged between lanes) and `workspace.group.` names, and any
//!   `workspace_group.` one.
//! - config/state.json, config/projects.json and config/lanes.json,
//!   checked every 2 seconds.
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
//!
//! Headless, the `cockpit-publish` binary (src/bin) drives the runner for
//! the Swift sidebar with no core of its own (`run_without_core`): it
//! joins the core's inputs (`Inputs`) and writes them to a shared folder
//! as data.json after each change, so the core in the sidebar is fed what
//! a core here would be, and signals it (publish.rs, signal.rs). It
//! carries out the effects that core sends back as files in outbox/
//! (effect.rs, `Feed::carry`), and keeps their answers for inbox/
//! (inbox.rs).

pub mod effect;
pub mod inbox;
pub mod join;
pub mod outbox;
pub mod parse;
pub mod pr_ask;
pub mod publish;
pub mod signal;
pub mod stream;
pub mod text;
pub mod watch;

use std::collections::BTreeMap;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cockpit_core::data::{Data, Workspace};
use cockpit_core::home::expand_home;
use cockpit_core::lanes::LaneConfig;
use cockpit_core::persist::{SavedProject, SavedState};
use cockpit_core::pr_poll::PrPolled;
use cockpit_core::project_table::merge_projects;
use cockpit_core::projects::Project;
use cockpit_core::{Cockpit, Effect, Event, Model, PrAsk};
use crux_core::App;
use serde::Serialize;
use serde_json::Value;

use effect::EffectFile;
use inbox::Answer;
use join::{Change, Join, changes_workspaces};
use outbox::Outgoing;
use parse::{AgentView, Groups};
use stream::CmuxEvents;
use watch::{Watched, read_lanes, read_projects, read_state};

pub const AGENTS_EVERY: Duration = Duration::from_secs(2);
pub const WORKSPACES_EVERY: Duration = Duration::from_secs(30);
pub const FILES_EVERY: Duration = Duration::from_secs(2);
/// A fresh frame at least this often, so ages move on with nothing new.
pub const CLOCK_EVERY: Duration = Duration::from_secs(30);
/// The longest a poll's command may run before it is killed.
pub const COMMAND_LIMIT: Duration = Duration::from_secs(10);
/// The soonest the runner wakes for a PR ask falling due.
pub const PR_DUE_MIN: Duration = Duration::from_secs(1);
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
    /// The workspace list, and when it was asked for, in epoch seconds.
    Workspaces(Vec<Workspace>, f64),
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

/// What the core was last fed from the shell's own inputs: the lane
/// table, the project table (each "~" root expanded), the state file and
/// cmux's frame. Written out as data.json, so a core elsewhere fed these
/// in this order (lanes, projects, state, data), with the home folder set
/// on its model first, builds the same panel. Each is None until first fed (a file that would
/// not read, say), and is written as null then: a reader skips it.
///
/// Each input carries a count of the times it was fed, so a reader of a
/// later data.json sends its core only those that moved: the project
/// table and the state reset parts of the session, so a core sent them
/// again on every frame would lose its local edits and folds.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Inputs {
    pub lanes: Option<Vec<LaneConfig>>,
    pub lanes_seq: u64,
    pub projects: Option<Vec<Project>>,
    pub projects_seq: u64,
    pub state: Option<SavedState>,
    pub state_seq: u64,
    pub data: Option<Data>,
    pub data_seq: u64,
}

impl Inputs {
    /// Keeps a copy of the event, when it is one of these inputs.
    fn note(&mut self, event: &Event) {
        match event {
            Event::Lanes(l) => {
                self.lanes = Some(l.clone());
                self.lanes_seq += 1;
            }
            Event::Projects(p) => {
                self.projects = Some(p.clone());
                self.projects_seq += 1;
            }
            Event::State(s) => {
                self.state = Some(SavedState::clone(s));
                self.state_seq += 1;
            }
            Event::Data(d) => {
                self.data = Some(d.clone());
                self.data_seq += 1;
            }
            _ => {}
        }
    }

    /// Moves whenever any input was fed, so an unchanged set is not
    /// written again.
    pub fn generation(&self) -> u64 {
        self.lanes_seq + self.projects_seq + self.state_seq + self.data_seq
    }
}

/// The core and the join that feeds it. Without the core
/// (`Feed::without_core`) it only joins: the inputs are kept, the model
/// stays empty and actions go nowhere, while the effects a core elsewhere
/// sends (`Feed::carry`) are carried out and their answers kept in
/// `answers`.
#[derive(Debug, Default)]
pub struct Feed {
    app: Cockpit,
    pub model: Model,
    pub join: Join,
    /// What the core was last fed, for data.json.
    pub inputs: Inputs,
    /// Set when there is no core to feed (`run_without_core`).
    no_core: bool,
    /// The outbox worker, while `run` drives the feed.
    worker: Option<Sender<Outgoing>>,
    /// Requests made with no worker to take them (a feed driven by hand,
    /// as the tests do), oldest first.
    pub unsent: Vec<Outgoing>,
    /// Where the core's PR asks go, while `run` drives the feed.
    asker: Option<Sender<PrAsk>>,
    /// PR asks made with no asker to take them, oldest first.
    pub unasked: Vec<PrAsk>,
    /// Without a core: the answers to the effects carried out, oldest
    /// first, for the publisher to write to inbox/ and take.
    pub answers: Vec<Answer>,
}

impl Feed {
    /// Sends the core an event and hands its requests on. True when the
    /// core asked for a render.
    fn send(&mut self, event: Event) -> bool {
        self.inputs.note(&event);
        if self.no_core {
            return false;
        }
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
                    self.ask(r.operation);
                    continue;
                }
                Effect::Cmux(r) => Outgoing::Cmux(r.operation),
                Effect::Persist(r) => Outgoing::Persist(r.operation),
                Effect::OpenUrl(r) => Outgoing::OpenUrl(r.operation),
                Effect::AgentMessage(r) => Outgoing::AgentMessage(r.operation),
            };
            self.hand(out);
        }
        render
    }

    /// Hands a request to the outbox worker. A worker gone (only once the
    /// run ends) keeps what it missed.
    fn hand(&mut self, out: Outgoing) {
        match &self.worker {
            Some(w) => {
                if let Err(mpsc::SendError(out)) = w.send(out) {
                    self.unsent.push(out);
                }
            }
            None => self.unsent.push(out),
        }
    }

    /// Carries out an effect a core elsewhere asked for (an effect file):
    /// a PR ask goes to the asker, the rest to the outbox worker, as the
    /// feed's own core's would.
    pub fn carry(&mut self, effect: EffectFile) {
        match effect {
            EffectFile::PrPoll(ask) => self.ask(ask),
            EffectFile::Cmux(call) => self.hand(Outgoing::Cmux(call)),
            EffectFile::Persist(set) => self.hand(Outgoing::Persist(set)),
            EffectFile::OpenUrl(url) => self.hand(Outgoing::OpenUrl(url)),
            EffectFile::AgentMessage(m) => self.hand(Outgoing::AgentMessage(m)),
        }
    }

    fn ask(&mut self, ask: PrAsk) {
        match &self.asker {
            Some(a) => {
                if let Err(mpsc::SendError(d)) = a.send(ask) {
                    self.unasked.push(d);
                }
            }
            None => self.unasked.push(ask),
        }
    }

    /// Tells the core the shell can run `git` and `gh`, so it starts
    /// asking for each directory's PR.
    pub fn poll_prs(&mut self) {
        self.send(Event::PrPollOn);
    }

    /// One of Jon's actions (`Event::is_action`): the core takes it at
    /// once and the cmux calls, state writes and links it asks for go to
    /// the outbox worker. The caller draws after. The feed's own inputs
    /// are ignored: the inputs bring those, and one sent from here would
    /// be a frame or a state file no input saw.
    pub fn act(&mut self, event: Event) {
        if event.is_action() {
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
            Input::Workspaces(list, asked) => (self.join.workspaces(list, asked), false, None),
            Input::Groups(groups) => (self.join.groups(groups), false, None),
            // Without a core an answer is kept for inbox/, for the core
            // that asked; the caller's next turn writes it, so it is not
            // news for a frame.
            Input::CmuxFailed(id) if self.no_core => {
                self.answers.push(Answer::CmuxFailed { id });
                (false, false, None)
            }
            Input::PrPolled(polled) if self.no_core => {
                self.answers.push(Answer::PrPolled(polled));
                (false, false, None)
            }
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

    /// The lane table, as config/lanes.json lists it.
    pub fn lanes(&mut self, lanes: Vec<LaneConfig>) {
        self.send(Event::Lanes(lanes));
    }

    pub fn state(&mut self, saved: cockpit_core::persist::SavedState) {
        self.send(Event::State(Box::new(saved)));
    }

    /// The project table, each "~" root expanded against home as the
    /// sidebars' build does (scripts/build.ts), so "+" opens a real folder.
    pub fn projects(&mut self, projects: Vec<cockpit_core::projects::Project>) {
        let home = self.model.session.home.clone();
        let projects = projects
            .into_iter()
            .map(|mut p| {
                p.root = p
                    .root
                    .map(|r| expand_home(&r, home.as_deref()).unwrap_or(r));
                p
            })
            .collect();
        self.send(Event::Projects(projects));
    }

    /// A feed that knows where home is from the start, before any input,
    /// so every frame and every project table is read against it. With
    /// None the core never offers to make a folder a project, since that
    /// could be home itself, and "~" roots stay as written.
    pub fn with_home(home: Option<String>) -> Self {
        let mut feed = Self::default();
        feed.model.session.home = home;
        feed
    }

    /// A feed with no core: it joins the inputs and keeps them for
    /// data.json, and takes no action.
    pub fn without_core(home: Option<String>) -> Self {
        let mut feed = Self::with_home(home);
        feed.no_core = true;
        feed
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
    /// The home folder, as the sidebars' build bakes it in (`__HOME__`),
    /// so a "~" root expands and a folder can be offered as a project.
    pub home: Option<String>,
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

/// Runs a command, with `env` set, and returns its output when it
/// succeeded within `limit`; one that hangs is killed, so a stuck cmux
/// cannot stop a poll for good (pr_ask::ran_within, which the PR poll
/// shares).
fn output_within(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    limit: Duration,
) -> Option<Vec<u8>> {
    let args: Vec<String> = args.iter().map(|a| (*a).to_string()).collect();
    let ran = pr_ask::ran_within(program, &args, None, env, limit);
    (ran.status == Some(0)).then(|| ran.stdout.into_bytes())
}

fn output(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    output_within(program, args, &[], COMMAND_LIMIT)
}

/// Runs an outbox request's command; true when it succeeded in time.
fn run_ok(program: &str, args: &[String]) -> bool {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    output(program, &args).is_some()
}

/// Agent View in the runner's own config dir (keyed None) and in each
/// other one (parse::other_config_dirs), read at once so a slow dir does
/// not hold the others up. A session Jon started with another
/// CLAUDE_CONFIG_DIR is listed only by a read made with it.
fn read_agents() -> Vec<(Option<PathBuf>, Option<AgentView>)> {
    let read = |dir: Option<&Path>| {
        let dir = dir.map(Path::to_string_lossy);
        let env: Vec<(&str, &str)> = dir
            .as_deref()
            .map(|d| ("CLAUDE_CONFIG_DIR", d))
            .into_iter()
            .collect();
        output_within("claude", &["agents", "--json"], &env, COMMAND_LIMIT)
            .and_then(|out| parse::agents(&out))
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let inherited = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    let others = home.map_or_else(Vec::new, |home| {
        let names = std::fs::read_dir(&home)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok());
        parse::other_config_dirs(
            &home,
            names,
            |d| d.join("sessions").is_dir(),
            inherited.as_deref(),
            |d| std::fs::canonicalize(d).unwrap_or_else(|_| d.to_path_buf()),
        )
    });
    let dirs: Vec<Option<PathBuf>> = std::iter::once(None)
        .chain(others.into_iter().map(Some))
        .collect();
    thread::scope(|s| {
        let reads: Vec<_> = dirs
            .iter()
            .map(|dir| s.spawn(|| read(dir.as_deref())))
            .collect();
        dirs.iter()
            .cloned()
            .zip(reads)
            .map(|(dir, r)| (dir, r.join().ok().flatten()))
            .collect()
    })
}

fn poll_agents(tx: &Sender<Input>, stop: &AtomicBool) {
    let mut views = parse::AgentViews::default();
    while !stop.load(Ordering::SeqCst) {
        if let Some(view) = views.update(read_agents())
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
        let asked = now_epoch();
        if let Some((list, win)) = read_list() {
            window = win.or(window);
            if tx.send(Input::Workspaces(list, asked)).is_err() {
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

/// The watched files: the state and project files, with the last good
/// read of each, which the project table is built from, and the lane file.
struct Files {
    state: Watched,
    projects: Watched,
    lanes: Watched,
    file_table: Vec<Project>,
    saved_projects: BTreeMap<String, SavedProject>,
    /// The table last sent, so a state write that leaves it as it was
    /// does not drop the projects sent from here.
    table: Option<Vec<Project>>,
}

impl Files {
    fn new(config: &Path) -> Self {
        Files {
            state: Watched::new(config.join("state.json")),
            projects: Watched::new(config.join("projects.json")),
            lanes: Watched::new(config.join("lanes.json")),
            file_table: Vec::new(),
            saved_projects: BTreeMap::new(),
            table: None,
        }
    }

    /// Sends the core whichever file changed, the project table first so a
    /// new state's overrides are checked against it. The table is
    /// projects.json with state.json's saved projects laid over it, as the
    /// sidebars' build makes it, so a project saved here shows here. A file
    /// that will not read (half written, say) is logged and the core keeps
    /// the last good one until the file changes again.
    fn check(&mut self, feed: &mut Feed, log: &mut dyn FnMut(String)) -> bool {
        let mut changed = false;
        // First, so the first frame already has its lanes. One that will
        // not read, or that the core could not draw, keeps the last good one.
        if self.lanes.changed() {
            match read_lanes(&self.lanes.path) {
                Ok(lanes) => {
                    feed.lanes(lanes);
                    changed = true;
                }
                Err(e) => log(e),
            }
        }
        if self.projects.changed() {
            match read_projects(&self.projects.path) {
                Ok(projects) => self.file_table = projects,
                Err(e) => log(e),
            }
        }
        let mut saved = None;
        if self.state.changed() {
            match read_state(&self.state.path) {
                Ok(state) => {
                    self.saved_projects = state.projects.clone();
                    saved = Some(state);
                }
                Err(e) => log(e),
            }
        }
        let table = merge_projects(&self.file_table, &self.saved_projects);
        if self.table.as_ref() != Some(&table) {
            self.table = Some(table.clone());
            feed.projects(table);
            changed = true;
        }
        if let Some(state) = saved {
            feed.state(state);
            changed = true;
        }
        changed
    }
}

/// When the core's next PR ask falls due, at least a second from now so
/// a due ask the core has no room for yet never spins the loop.
fn pr_due_at(feed: &Feed) -> Option<Instant> {
    let now = now_epoch();
    let due = feed.model.session.pr_poll.next_due(now)?;
    let wait = (due - now).max(PR_DUE_MIN.as_secs_f64());
    Some(Instant::now() + Duration::from_secs_f64(wait.min(CLOCK_EVERY.as_secs_f64())))
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
    channel: (Sender<Input>, Receiver<Input>),
    on_frame: impl FnMut(&mut Feed, Call<'_>) -> ControlFlow<()>,
    log: impl FnMut(String),
) {
    run_with(
        opts,
        Feed::with_home(opts.home.clone()),
        channel,
        on_frame,
        log,
    );
}

/// Runs as `run` does with no core: the inputs are joined and handed to
/// `on_frame` in `Feed::inputs`, and the model stays empty. The outbox
/// worker and the PR asker still run, for the effects the sidebar's core
/// sends (`Feed::carry`); their answers wait in `Feed::answers`.
pub fn run_without_core(
    opts: &Options,
    channel: (Sender<Input>, Receiver<Input>),
    on_frame: impl FnMut(&mut Feed, Call<'_>) -> ControlFlow<()>,
    log: impl FnMut(String),
) {
    run_with(
        opts,
        Feed::without_core(opts.home.clone()),
        channel,
        on_frame,
        log,
    );
}

fn run_with(
    opts: &Options,
    mut feed: Feed,
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

    let mut files = Files::new(&opts.config);
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
        // A PR ask falling due brings a frame then, not at the next clock tick.
        let pr_due = pr_due_at(&feed);
        let due = wake_due.map_or(files_due.min(clock_due), |w| {
            w.min(files_due).min(clock_due)
        });
        let due = pr_due.map_or(due, |p| p.min(due));
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
        pending |= now >= clock_due || pr_due.is_some_and(|p| now >= p);
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
        feed.input(Input::Workspaces(vec![ws("A"), ws("B")], 0.0));
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
        let out = output_within("sleep", &["5"], &[], Duration::from_millis(100));
        assert_eq!(out, None);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            output_within("echo", &["hi"], &[], Duration::from_secs(5)),
            Some(b"hi\n".to_vec())
        );
        assert_eq!(
            output_within("false", &[], &[], Duration::from_secs(5)),
            None
        );
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
                LaneEntry::Ws { ws_id, lane, .. } => cards.push((lane.clone(), ws_id.clone())),
                LaneEntry::Header {
                    lane, anchor_id, ..
                } => headers.push((lane.clone(), anchor_id.clone())),
                LaneEntry::Zone { .. } => {}
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
        feed.input(Input::Workspaces(
            vec![
                titled("M", "real card anchoring Main"),
                titled("C", "a card"),
                titled("P", "Background"),
                titled("Q", "background card"),
                titled("U", "loose"),
            ],
            0.0,
        ));
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
                card(LaneKey::from("main"), "M"),
                card(LaneKey::from("main"), "C"),
                card(LaneKey::from("bg"), "Q"),
                card(LaneKey::unsorted(), "U"),
            ],
            "a generated anchor (P) is no card; a real one (M) is"
        );
        // A generated anchor names its header only while it has an agent
        // or unread messages; either way it is never a card.
        assert_eq!(
            headers,
            vec![
                (LaneKey::from("main"), None),
                (LaneKey::from("bg"), None),
                (LaneKey::unsorted(), None)
            ]
        );
    }

    /// A feed with Q loose and Background's group made, framed once.
    fn moving_feed() -> Feed {
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        feed.input(Input::Workspaces(
            vec![titled("P", "Background"), titled("Q", "q")],
            0.0,
        ));
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
            lane: LaneKey::from("bg"),
            before: None,
        }
    }

    fn methods(out: &[Outgoing]) -> Vec<String> {
        out.iter()
            .map(|o| match o {
                Outgoing::Cmux(c) => c.method.clone(),
                Outgoing::Persist(p) => format!("set {}", p.key),
                Outgoing::OpenUrl(u) => format!("open {}", u.url),
                Outgoing::AgentMessage(m) => format!("message {}", m.workspace),
            })
            .collect()
    }

    #[test]
    fn an_action_lands_at_once_and_its_requests_go_to_the_worker_in_order() {
        let mut feed = moving_feed();
        let (tx, rx) = mpsc::channel();
        feed.worker = Some(tx);
        feed.act(move_q());
        assert_eq!(
            placed(&feed).0,
            vec![(LaneKey::from("bg"), "Q".to_string())]
        );
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
        assert_eq!(
            placed(&feed).0,
            vec![(LaneKey::from("bg"), "Q".to_string())]
        );
        assert_eq!(
            methods(&feed.unsent),
            ["workspace.reorder", "workspace.group.add"],
            "the move's own requests, once"
        );
    }

    #[test]
    fn the_feed_keeps_what_the_core_was_fed_for_data_json() {
        let feed = Feed::with_home(Some("/Users/jon".into()));
        assert_eq!(feed.inputs, Inputs::default());
        let mut feed = moving_feed();
        let data = feed.inputs.data.clone().unwrap();
        assert_eq!(feed.model.data.as_ref(), Some(&data));
        assert_eq!(data.workspace_list().len(), 2);
        assert_eq!(feed.inputs.state, Some(SavedState::default()));
        let fed = (feed.inputs.projects_seq, feed.inputs.state_seq);
        let generation = feed.inputs.generation();
        // An action is no input: what goes out stays what came in.
        feed.act(move_q());
        assert_eq!(feed.inputs.data, Some(data));
        assert_eq!(feed.inputs.generation(), generation);
        // A frame moves only the data's count, so a reader resends only that.
        feed.frame(1_791_127_200.0);
        assert_eq!((feed.inputs.projects_seq, feed.inputs.state_seq), fed);
        assert_eq!(feed.inputs.generation(), generation + 1);
    }

    #[test]
    fn without_a_core_the_feed_only_joins() {
        let mut feed = Feed::without_core(Some("/h".into()));
        feed.state(SavedState::default());
        feed.input(Input::Workspaces(vec![titled("Q", "q")], 0.0));
        feed.frame(1_791_127_100.0);
        feed.poll_prs();
        feed.act(move_q());
        let (changed, _, _) = feed.input(Input::CmuxFailed("Q".into()));
        assert!(!changed, "no core to snap a card back");
        let data = feed.inputs.data.as_ref().unwrap();
        assert_eq!(data.workspace_list()[0].id, "Q");
        assert_eq!(feed.inputs.state, Some(SavedState::default()));
        assert_eq!(feed.model.data, None, "the model stays empty");
        assert!(feed.unsent.is_empty() && feed.unasked.is_empty());
        assert_eq!(pr_due_at(&feed), None);
    }

    #[test]
    fn a_failed_cmux_call_lets_the_card_go_back_to_where_cmux_has_it() {
        let mut feed = moving_feed();
        feed.act(move_q());
        let (changed, _, _) = feed.input(Input::CmuxFailed("Q".into()));
        assert!(changed, "the view must draw again");
        feed.frame(1_791_127_101.0);
        assert_eq!(
            placed(&feed).0,
            vec![(LaneKey::unsorted(), "Q".to_string())]
        );
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

    /// #234's editor keys were dropped here before they reached the core.
    #[test]
    fn act_takes_the_editor_and_the_menus_too() {
        use cockpit_core::edit::EditEvent;
        use cockpit_core::menu::{MenuAction, MenuEvent};
        let mut feed = moving_feed();
        feed.act(Event::Edit(EditEvent::OpenNew));
        assert!(feed.model.session.editing_project().is_some());
        feed.act(Event::Edit(EditEvent::Close));
        feed.act(Event::Menu(MenuEvent::OpenCard { id: "Q".into() }));
        assert!(feed.model.session.menu_target().is_some());
        feed.act(Event::Menu(MenuEvent::Pick(MenuAction::MarkRead)));
        assert_eq!(methods(&feed.unsent), ["workspace.action"]);
        assert!(feed.model.session.menu_target().is_none());
    }

    #[test]
    fn the_core_asks_for_prs_and_only_a_chip_change_is_news() {
        use cockpit_core::pr_poll::{PollAnswer, PrPolled};
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        let mut q = titled("Q", "q");
        q.directory = Some("/repo".into());
        feed.input(Input::Workspaces(vec![q], 0.0));
        feed.input(Input::Groups(groups(&[])));
        feed.frame(1_791_127_100.0);
        assert!(feed.unasked.is_empty(), "off until the runner turns it on");
        feed.poll_prs();
        let asked: Vec<&str> = feed.unasked.iter().map(|a| a.directory.as_str()).collect();
        assert_eq!(asked, ["/repo"]);

        let polled = |checks: &str, epoch| {
            let pr = format!(
                r#"{{"number": 2, "url": "https://github.com/o/r/pull/2", "status": "open",
                    "branch": "feat", "checks": {checks}}}"#
            );
            Input::PrPolled(Box::new(PrPolled {
                directory: "/repo".into(),
                asked: 1_791_127_100.0,
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
    fn a_tilde_root_expands_against_home_as_the_build_does() {
        let table = || -> Vec<cockpit_core::projects::Project> {
            serde_json::from_value(json!([
                {"match": "/dev/app", "name": "App", "color": "#000", "icon": "star", "root": "~/dev/app"},
                {"match": "/opt/x", "name": "X", "color": "#000", "icon": "star", "root": "/opt/x"}
            ]))
            .unwrap()
        };
        let roots = |home: Option<&str>| -> Vec<Option<String>> {
            let mut feed = Feed::with_home(home.map(str::to_string));
            feed.projects(table());
            feed.model
                .session
                .projects
                .iter()
                .map(|p| p.root.clone())
                .collect()
        };
        assert_eq!(
            roots(Some("/Users/me/")),
            [
                Some("/Users/me/dev/app".to_string()),
                Some("/opt/x".to_string())
            ]
        );
        assert_eq!(
            roots(None),
            [Some("~/dev/app".to_string()), Some("/opt/x".to_string())],
            "with no home the root stays as written, as the build leaves it"
        );
    }

    #[test]
    fn a_project_saved_in_state_joins_the_table_and_leaves_it_on_removal() {
        let dir = std::env::temp_dir().join(format!("cockpit-pane-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let projects = dir.join("projects.json");
        let state = dir.join("state.json");
        std::fs::write(
            &projects,
            r##"[{"match": "/dev/app", "name": "App", "color": "#000000", "icon": "star"}]"##,
        )
        .unwrap();
        std::fs::write(
            &state,
            r##"{"projects": {"/tmp/quill/": {"name": "Quill", "color": "#6A9BCC", "icon": "folder.fill", "root": "/tmp/quill"}}}"##,
        )
        .unwrap();
        let mut files = Files::new(&dir);
        let mut feed = Feed::default();
        assert!(files.check(&mut feed, &mut |_| {}));
        let names = |feed: &Feed| -> Vec<String> {
            feed.model
                .session
                .projects
                .iter()
                .map(|p| p.name.clone())
                .collect()
        };
        assert_eq!(names(&feed), ["App", "Quill"]);

        // A state write that leaves the table as it was sends no new table.
        std::fs::write(
            &state,
            r##"{"ui": {"mode": "projects"}, "projects": {"/tmp/quill/": {"name": "Quill", "color": "#6A9BCC", "icon": "folder.fill", "root": "/tmp/quill"}}}"##,
        )
        .unwrap();
        let before = files.table.clone();
        files.check(&mut feed, &mut |_| {});
        assert_eq!(files.table, before);

        std::fs::write(&state, r#"{"projects": {"/dev/app": {"removed": true}}}"#).unwrap();
        files.check(&mut feed, &mut |_| {});
        assert!(names(&feed).is_empty());
    }

    #[test]
    fn sends_the_lane_file_and_keeps_the_last_good_one() {
        let dir = std::env::temp_dir().join(format!("cockpit-pane-lanes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lanes = dir.join("lanes.json");
        let _ = std::fs::remove_file(&lanes);
        let mut files = Files::new(&dir);
        let mut feed = Feed::default();
        let keys = |feed: &Feed| -> Vec<String> {
            feed.model
                .session
                .lanes
                .iter()
                .map(|l| l.key.as_str().to_string())
                .collect()
        };
        assert!(files.check(&mut feed, &mut |_| {}));
        assert_eq!(keys(&feed), ["main", "review", "bg", "parked", "unsorted"]);
        assert_eq!(
            feed.inputs.lanes,
            Some(Vec::new()),
            "no file: none, as data.json says"
        );

        std::fs::write(
            &lanes,
            r#"[{"name": "Doing"}, {"id": "later", "name": "Later"}]"#,
        )
        .unwrap();
        assert!(files.check(&mut feed, &mut |_| {}));
        assert_eq!(keys(&feed), ["Doing", "later", "unsorted"]);

        // A table the core cannot draw is logged, and the last one stays.
        std::fs::write(&lanes, r#"[{"name": "Doing"}, {"name": "doing"}]"#).unwrap();
        let mut logged = Vec::new();
        assert!(!files.check(&mut feed, &mut |line| logged.push(line)));
        assert_eq!(keys(&feed), ["Doing", "later", "unsorted"]);
        assert!(
            logged.iter().any(|l| l.contains("two lanes are named")),
            "{logged:?}"
        );

        std::fs::remove_file(&lanes).unwrap();
        assert!(files.check(&mut feed, &mut |_| {}));
        assert_eq!(keys(&feed), ["main", "review", "bg", "parked", "unsorted"]);
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
        feed.input(Input::Workspaces(
            vec![titled("P", "Background"), titled("Q", "q")],
            0.0,
        ));
        feed.input(Input::Groups(groups(&[group(
            "gb",
            "Background",
            "P",
            &["P"],
        )])));
        feed.frame(1_791_127_100.0);
        assert_eq!(
            placed(&feed).0,
            vec![(LaneKey::unsorted(), "Q".to_string())]
        );

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
        assert_eq!(
            placed(&feed).0,
            vec![(LaneKey::from("bg"), "Q".to_string())]
        );
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
        assert!(matches!(next(), Ok(Input::Workspaces(..))));
        assert!(matches!(next(), Ok(Input::Groups(g)) if g.list.is_empty()));

        let nudged = Instant::now();
        let _ = nudge_tx.send(());
        assert!(matches!(next(), Ok(Input::Workspaces(..))));
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
    fn the_layout_poll_stamps_a_list_with_when_it_was_asked_for() {
        let (tx, rx) = mpsc::channel();
        let (nudge_tx, nudge_rx) = mpsc::channel::<()>();
        drop(nudge_tx);
        let started = Arc::new(std::sync::Mutex::new(0.0));
        let at_read = Arc::clone(&started);
        // A slow read: the stamp is from before it began, not when it answered.
        let list = move || {
            if let Ok(mut t) = at_read.lock() {
                *t = now_epoch();
            }
            thread::sleep(Duration::from_millis(50));
            Some((vec![ws("A")], None))
        };
        poll_layout(&tx, &nudge_rx, Duration::from_secs(600), list, |_| None);
        let began = started.lock().map(|t| *t).unwrap_or_default();
        let asked = rx.try_iter().find_map(|i| match i {
            Input::Workspaces(_, asked) => Some(asked),
            _ => None,
        });
        assert!(
            asked.is_some_and(|a| a <= began && began - a < 0.05),
            "{asked:?} {began}"
        );
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
            matches!(sent.as_slice(), [Input::Workspaces(..)]),
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
