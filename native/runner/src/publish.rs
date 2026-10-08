//! cockpit-publish's half of the bridge to the Swift sidebar, which is
//! sandboxed and so cannot run the runner itself. The helper app starts
//! cockpit-publish; it runs the runner headless and talks to the sidebar
//! through the App Group folder the two share (`default_root`):
//!
//! - Out: data.json, what the core is fed (crate::Inputs), written whole
//!   and atomically (a temp file renamed over it) when any input was fed
//!   again, as `{"seq": 9, "written_at_ms": 1791229864123, "home":
//!   "/Users/jon", "lanes": [...], "lanes_seq": 1, "projects": [...],
//!   "projects_seq": 1, "state": {...}, "state_seq": 2, "data": {...},
//!   "data_seq": 40}`. `seq` counts this process's writes from 1, and
//!   `written_at_ms` is the wall clock at the write. The sidebar's core,
//!   fed `lanes`, `projects`, `state`, then `data`,
//!   with `home` set on its model first, builds the panel itself; a later
//!   file is read by sending only the inputs whose `_seq` moved, and an
//!   input still null is skipped. Then it posts the bare signal
//!   (signal.rs). Nothing is written until the runner is ready (`ready`),
//!   so a restart never blanks the sidebar.
//! - Once a minute, when anything was written, a log line gives the
//!   file's writes per minute and size (`Tally`).
//! - In: each file in outbox/ is one effect (effect.rs) from the
//!   sidebar's core. The writer writes it under a name that starts with
//!   "." or does not end in ".json", then renames it to `<name>.json`.
//!   Files are taken in byte order of their names, so a name must sort in
//!   the order sent: a fixed width, zero padded `<13 digit epoch ms>-<6
//!   digit counter>.json` (`1791229864123-000042.json`), never a bare
//!   counter, where "10" sorts before "9". Each one is claimed by an
//!   atomic rename, so it is carried out at most once even with two
//!   publishers running, then deleted. Any file older than `STALE` (a
//!   minute) is deleted and logged instead, so an old move or message is
//!   never replayed. One that will not parse is deleted and logged, never
//!   retried.
//! - Back: each answer to an effect (a cmux call that failed, a PR) goes
//!   into inbox/ as a file (inbox.rs), then the signal is posted. Answers
//!   older than `STALE` are deleted.

use std::collections::HashSet;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::effect::EffectFile;
use crate::inbox::{self, INBOX_DIR, Inbox};
use crate::{Feed, Inputs};

/// The App Group the helper app and the sidebar share.
pub const GROUP_ID: &str = "9S5FG4LQAF.dev.jonyardley.cockpit";
/// Overrides the shared folder (tests, or a run by hand).
pub const ROOT_ENV: &str = "COCKPIT_GROUP_DIR";
pub const DATA_FILE: &str = "data.json";
pub const OUTBOX_DIR: &str = "outbox";
/// Before an outbox file's name once claimed, then its claimer's pid.
const TAKEN: &str = ".taken-";
/// How often the write tally is logged.
pub const TALLY_EVERY: Duration = Duration::from_secs(60);
/// How long an outbox file or an answer stays good. Past this a move, a
/// message or a link is history: the sidebar's optimistic draw lapsed long
/// ago, so carrying it out would surprise, and it is dropped instead.
pub const STALE: Duration = Duration::from_secs(60);
/// The longest the publisher waits for the runner to be ready before it
/// writes whatever it has, as `cockpit-pane --once` does.
pub const READY_LIMIT: Duration = Duration::from_secs(10);

/// The shared folder under `home`.
pub fn default_root(home: &Path) -> PathBuf {
    home.join("Library/Group Containers").join(GROUP_ID)
}

/// What data.json holds: the core's inputs, beside the same envelope and
/// the home folder the core's model was given.
#[derive(Debug, Serialize)]
pub struct PublishedData<'a> {
    pub seq: u64,
    pub written_at_ms: u64,
    pub home: Option<&'a str>,
    #[serde(flatten)]
    pub inputs: &'a Inputs,
}

/// One file's writes since the tally last logged.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Writes {
    count: u32,
    /// The size of the latest write.
    last_bytes: usize,
}

impl Writes {
    fn add(&mut self, bytes: usize) {
        self.count += 1;
        self.last_bytes = bytes;
    }

    fn describe(&self, name: &str, minutes: f64) -> String {
        // A count and a byte size are far below f64's exact range.
        let rate = f64::from(self.count) / minutes;
        let kb = self.last_bytes as f64 / 1024.0;
        format!("{name} {rate:.1} writes/min, {kb:.1} KB")
    }
}

/// How often and how large data.json was written, for the log: one
/// line per `TALLY_EVERY`, none when nothing was written.
#[derive(Debug)]
pub struct Tally {
    since: Instant,
    data: Writes,
}

impl Tally {
    pub fn new(now: Instant) -> Tally {
        Tally {
            since: now,
            data: Writes::default(),
        }
    }

    /// The line to log once `TALLY_EVERY` has passed, then starts again.
    pub fn report(&mut self, now: Instant) -> Option<String> {
        let elapsed = now.saturating_duration_since(self.since);
        if elapsed < TALLY_EVERY {
            return None;
        }
        let minutes = elapsed.as_secs_f64() / 60.0;
        let line = (self.data.count > 0)
            .then(|| format!("written: {}", self.data.describe(DATA_FILE, minutes)));
        *self = Tally::new(now);
        line
    }
}

/// Whether the inputs are worth writing: replay has caught up and every
/// poll has answered, or it has been `READY_LIMIT` since the start.
pub fn ready(feed: &Feed, started: Instant) -> bool {
    (feed.join.health.caught_up() && feed.join.loaded()) || started.elapsed() >= READY_LIMIT
}

/// Writes `bytes` to `dir/name` through a temp file in the same folder,
/// so a reader sees the old file or the new one, never half of either.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    // Named by `tmp_prefix`, so a crash's is swept.
    let tmp = dir.join(format!("{}{}.tmp", tmp_prefix(name), std::process::id()));
    let written = fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, dir.join(name)));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// Before the pid in `name`'s temp file, as `write_atomic` names it.
fn tmp_prefix(name: &str) -> String {
    format!(".{name}.")
}

fn epoch_ms() -> u64 {
    ms_of(SystemTime::now())
}

fn ms_of(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The epoch ms an outbox or inbox name starts with: its 13 digits before
/// the "-". None for any other name.
pub fn name_ms(name: &str) -> Option<u64> {
    let (ms, _) = name.split_once('-')?;
    if ms.len() != 13 || !ms.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    ms.parse().ok()
}

pub fn stale_ms() -> u64 {
    u64::try_from(STALE.as_millis()).unwrap_or(u64::MAX)
}

/// Whether an outbox file was written more than `STALE` before `now_ms`:
/// by its name's time, or for another name its modified time. One whose
/// age cannot be read counts as fresh.
fn is_stale(path: &Path, now_ms: u64) -> bool {
    let name = path.file_name().and_then(|n| n.to_str());
    let written = name.and_then(name_ms).or_else(|| {
        let modified = fs::metadata(path).and_then(|m| m.modified()).ok()?;
        Some(ms_of(modified))
    });
    written.is_some_and(|w| now_ms.saturating_sub(w) > stale_ms())
}

/// The outbox files waiting, oldest name first: files ending ".json"
/// whose names do not start with "." (one still being written, or a
/// claim).
pub fn waiting(outbox: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(outbox) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.ends_with(".json") && !n.starts_with('.'))
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// Takes one outbox file: renames it to a claim only this process holds,
/// reads it and deletes it. None when another publisher took it first.
pub fn claim(path: &Path) -> Result<Option<String>, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let claimed = path.with_file_name(format!("{TAKEN}{}-{name}", std::process::id()));
    match fs::rename(path, &claimed) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{name}: {e}")),
    }
    let text = fs::read_to_string(&claimed).map_err(|e| format!("{name}: {e}"));
    let removed = fs::remove_file(&claimed).map_err(|e| format!("{name}: {e}"));
    let text = text?;
    removed?;
    Ok(Some(text))
}

/// The pid in a leftover's name: the digits after `prefix`.
fn pid_in(name: &str, prefix: &str) -> Option<u32> {
    let rest = name.strip_prefix(prefix)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Whether a process with this pid is running, asked of `kill -0` (std
/// has no signal call). Only asked on start, of a leftover file.
fn alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Deletes the files in `dir` whose names start with `prefix` and a pid
/// no longer running: a claim or a temp file a crash left. A live
/// publisher's own are left alone, so two can run at once.
fn sweep(dir: &Path, prefix: &str, alive: &dyn Fn(u32) -> bool) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if pid_in(&name, prefix).is_some_and(|pid| !alive(pid)) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Writes the core's inputs out and takes its effects in, in one shared
/// folder.
pub struct Publisher {
    root: PathBuf,
    /// Outbox files that could not be claimed, each logged once rather
    /// than on every wake.
    stuck: HashSet<PathBuf>,
    /// Where effects' answers go.
    inbox: Inbox,
    /// Whether the last inbox write failed, so a failure is logged once.
    inbox_failing: bool,
    /// The inputs' generation last written to data.json, so unchanged
    /// ones are not written again.
    last_inputs: Option<u64>,
    data_seq: u64,
    tally: Tally,
    /// Posts the "changed" signal; true when it went.
    signal: Box<dyn FnMut() -> bool>,
}

impl Publisher {
    /// A publisher writing into `root`, which it makes with its outbox
    /// when missing. Claims and temp files a crashed publisher left are
    /// cleared: at most once means never applying its claims.
    pub fn new(root: PathBuf, signal: Box<dyn FnMut() -> bool>) -> io::Result<Publisher> {
        Publisher::new_with(root, signal, &alive)
    }

    fn new_with(
        root: PathBuf,
        signal: Box<dyn FnMut() -> bool>,
        alive: &dyn Fn(u32) -> bool,
    ) -> io::Result<Publisher> {
        let outbox = root.join(OUTBOX_DIR);
        fs::create_dir_all(&outbox)?;
        sweep(&outbox, TAKEN, alive);
        let answers = root.join(INBOX_DIR);
        fs::create_dir_all(&answers)?;
        sweep(&answers, inbox::TMP, alive);
        sweep(&root, &tmp_prefix(DATA_FILE), alive);
        let inbox = Inbox::new(answers);
        inbox.prune(epoch_ms().saturating_sub(stale_ms()));
        Ok(Publisher {
            root,
            stuck: HashSet::new(),
            inbox,
            inbox_failing: false,
            last_inputs: None,
            data_seq: 0,
            tally: Tally::new(Instant::now()),
            signal,
        })
    }

    pub fn outbox(&self) -> PathBuf {
        self.root.join(OUTBOX_DIR)
    }

    pub fn inbox(&self) -> PathBuf {
        self.inbox.dir().to_path_buf()
    }

    /// Takes every outbox file, oldest first, and carries out its effect
    /// (`Feed::carry`). One older than `STALE` is dropped instead, so an
    /// old move or message is never replayed. Returns how many were
    /// carried out.
    pub fn take_effects(&mut self, feed: &mut Feed, log: &mut dyn FnMut(String)) -> usize {
        let now = epoch_ms();
        let mut carried = 0;
        let listed = waiting(&self.outbox());
        let present: HashSet<&PathBuf> = listed.iter().collect();
        self.stuck.retain(|p| present.contains(p));
        for path in &listed {
            if is_stale(path, now) {
                self.drop_stale(path, log);
                continue;
            }
            let Some(text) = self.claim_once(path, log) else {
                continue;
            };
            match EffectFile::parse(&text) {
                Ok(effect) => {
                    log(format!("outbox: {}", effect.name()));
                    feed.carry(effect);
                    carried += 1;
                }
                Err(e) => log(format!("outbox: dropped {}: {e}", path.display())),
            }
        }
        carried
    }

    /// Claims one outbox file and gives its text: None when another
    /// publisher took it, or it could not be claimed (logged once).
    fn claim_once(&mut self, path: &Path, log: &mut dyn FnMut(String)) -> Option<String> {
        match claim(path) {
            Ok(text) => text,
            Err(e) => {
                if self.stuck.insert(path.to_path_buf()) {
                    log(format!("outbox: {e}"));
                }
                None
            }
        }
    }

    /// Claims a stale outbox file and deletes it unread but for its name.
    fn drop_stale(&mut self, path: &Path, log: &mut dyn FnMut(String)) {
        if let Some(text) = self.claim_once(path, log) {
            let name = EffectFile::parse(&text).map_or("unreadable", |f| f.name());
            log(format!("outbox: {name} dropped, stale"));
        }
    }

    /// Writes each answer waiting in the feed to inbox/, oldest first,
    /// then deletes any there older than `STALE`. One that will not write
    /// stays, with those after it, for the next turn, and the failure is
    /// logged once. True when any was written.
    fn write_answers(&mut self, feed: &mut Feed, log: &mut dyn FnMut(String)) -> bool {
        let mut written = 0;
        for answer in &feed.answers {
            match self.inbox.write(answer, epoch_ms()) {
                Ok(_) => {
                    log(format!("inbox: {}", answer.name()));
                    written += 1;
                    self.inbox_failing = false;
                }
                Err(e) => {
                    if !self.inbox_failing {
                        log(format!("inbox: {} not written: {e}", answer.name()));
                    }
                    self.inbox_failing = true;
                    break;
                }
            }
        }
        feed.answers.drain(..written);
        if written > 0 {
            // Answers no sidebar took in time are history.
            self.inbox.prune(epoch_ms().saturating_sub(stale_ms()));
        }
        written > 0
    }

    /// Writes the core's inputs to data.json, when any was fed since they
    /// were last written. True when it wrote.
    fn write_data(&mut self, feed: &Feed, log: &mut dyn FnMut(String)) -> bool {
        let inputs = &feed.inputs;
        if self.last_inputs == Some(inputs.generation()) {
            return false;
        }
        let out = PublishedData {
            seq: self.data_seq + 1,
            written_at_ms: epoch_ms(),
            home: feed.model.session.home.as_deref(),
            inputs,
        };
        let Some(bytes) = self.write(DATA_FILE, &out, log) else {
            return false;
        };
        self.data_seq += 1;
        self.last_inputs = Some(inputs.generation());
        self.tally.data.add(bytes);
        true
    }

    /// Writes `value` to `name` atomically; its size, or None, logged,
    /// when it failed, so the caller tries again next time.
    fn write(
        &self,
        name: &str,
        value: &impl Serialize,
        log: &mut dyn FnMut(String),
    ) -> Option<usize> {
        let written = serde_json::to_vec(value)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                write_atomic(&self.root, name, &bytes)
                    .map(|()| bytes.len())
                    .map_err(|e| e.to_string())
            });
        written
            .map_err(|e| log(format!("{name} not written: {e}")))
            .ok()
    }

    /// Posts the "changed" signal.
    fn post(&mut self, log: &mut dyn FnMut(String)) {
        // Off macOS there is no centre to post to, so no news in that.
        if !(self.signal)() && cfg!(target_os = "macos") {
            log("changed signal not posted".to_string());
        }
    }

    /// One turn of the runner: the outbox's effects are carried out,
    /// effects' answers go to inbox/, then the inputs go out when a frame
    /// came or data.json has not been written yet (or its first write
    /// failed). The signal follows the inputs and the answers. The tally
    /// is logged when it is due.
    pub fn step(&mut self, feed: &mut Feed, fresh: bool, log: &mut dyn FnMut(String)) {
        self.take_effects(feed, log);
        let mut changed = self.write_answers(feed, log);
        if fresh || self.last_inputs.is_none() {
            changed |= self.write_data(feed, log);
        }
        if changed {
            self.post(log);
        }
        if let Some(line) = self.tally.report(Instant::now()) {
            log(line);
        }
    }
}

/// The process cockpit-publish stops with: the helper app, or whoever
/// started it by hand. Polled each wake, as std offers no wait on a
/// process that is not a child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parent(pub u32);

/// launchd's pid on macOS, init's on Linux: whoever takes an orphan when
/// no subreaper does.
const ORPHANAGE: u32 = 1;

impl Parent {
    /// The process to stop with: `named` (the helper app passes its own
    /// pid, which also catches it going before this process got going),
    /// else whoever started this one. An error when there is none to
    /// stop with: a process started from launchd's own hand, one whose
    /// starter went before it could look, or a named pid that is not its
    /// parent (a wrapper such as /usr/bin/env between them).
    pub fn of(named: Option<u32>) -> Result<Parent, String> {
        Parent::given(named, std::os::unix::process::parent_id())
    }

    fn given(named: Option<u32>, now: u32) -> Result<Parent, String> {
        if now == ORPHANAGE {
            return Err("its parent has already gone".to_string());
        }
        match named {
            Some(pid) if pid != now => Err(format!(
                "--parent {pid} is not its parent ({now}): start it directly"
            )),
            _ => Ok(Parent(now)),
        }
    }

    /// Gone when this process now has another parent: once it exits, the
    /// orphan is handed to launchd (or init, or a subreaper on Linux).
    pub fn gone(self) -> bool {
        self.gone_given(std::os::unix::process::parent_id())
    }

    fn gone_given(self, now: u32) -> bool {
        now != self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::data::Data;
    use cockpit_core::fixture::{FIXTURE_HOME, Scene, scene};
    use cockpit_core::panel::ProjectRow;
    use cockpit_core::persist::SavedState;
    use cockpit_core::projects::Project;
    use cockpit_core::{Cockpit, EditEvent, Event, MenuEvent, Model, Panel};
    use crux_core::App;
    use serde_json::Value;
    use std::cell::Cell;
    use std::rc::Rc;

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cockpit-publish-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn repo(path: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path)
    }

    fn json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    /// A feed given a golden scene's input as the shell gives it: the
    /// project table, the saved state, then cmux's data.
    fn fed(scene: &str) -> Feed {
        let input = json(&repo(&format!("test/golden/{scene}.input.json")));
        let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
        let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
        let data: Data = serde_json::from_value(input["data"].clone()).unwrap();
        let mut feed = Feed::default();
        feed.send(Event::Projects(projects));
        feed.send(Event::State(Box::new(saved)));
        feed.send(Event::Data(data));
        feed
    }

    /// A publisher in a fresh folder, and how many signals it posted.
    fn publisher(name: &str) -> (Publisher, PathBuf, Rc<Cell<usize>>) {
        let root = temp_root(name);
        let posted = Rc::new(Cell::new(0));
        let count = Rc::clone(&posted);
        let signal = Box::new(move || {
            count.set(count.get() + 1);
            true
        });
        (Publisher::new(root.clone(), signal).unwrap(), root, posted)
    }

    fn quiet() -> impl FnMut(String) {
        |_| {}
    }

    #[test]
    fn writes_data_json_alone_with_its_seq_and_time() {
        let (mut p, root, posted) = publisher("data-only");
        let mut feed = fed("lanes");
        let before = epoch_ms();
        p.step(&mut feed, true, &mut quiet());

        let got = json(&root.join(DATA_FILE));
        assert_eq!(got["seq"], 1);
        let at = got["written_at_ms"].as_u64().unwrap();
        assert!(at >= before && at <= epoch_ms() + 1);
        assert_eq!(posted.get(), 1, "one signal per write");
        let mut leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        leftovers.sort();
        assert_eq!(leftovers, ["data.json", "inbox", "outbox"]);
        fs::remove_dir_all(&root).unwrap();
    }

    /// A scene's feed as the runner builds it, home and all: the table
    /// through `Feed::projects`, so "~" roots expand against home.
    fn fed_at(scene_name: &str, home: Option<&str>) -> Feed {
        // Roots as typed: the feed expands them itself.
        let Scene {
            projects,
            saved,
            data,
        } = scene(scene_name, None).unwrap();
        let mut feed = Feed::with_home(home.map(str::to_string));
        feed.projects(projects);
        feed.state(saved);
        feed.send(Event::Data(data));
        feed
    }

    /// A fresh core fed from data.json alone: home on the model, then the
    /// project table, the state and cmux's data, as the file says.
    fn core_from(file: &Value) -> Model {
        let mut model = Model::default();
        model.session.home = serde_json::from_value(file["home"].clone()).unwrap();
        let read = |key: &str| (!file[key].is_null()).then(|| file[key].clone());
        let events = [
            read("lanes").map(|v| Event::Lanes(serde_json::from_value(v).unwrap())),
            read("projects").map(|v| Event::Projects(serde_json::from_value(v).unwrap())),
            read("state").map(|v| Event::State(Box::new(serde_json::from_value(v).unwrap()))),
            read("data").map(|v| Event::Data(serde_json::from_value(v).unwrap())),
        ];
        for event in events.into_iter().flatten() {
            let _effects = Cockpit.update(event, &mut model);
        }
        model
    }

    /// The action that opens a fixture over its scene's panel, if any.
    type Opens = fn(&Panel) -> Option<Event>;

    /// Each fixture: the scene it loads and the action that opens it.
    fn fixtures() -> Vec<(&'static str, &'static str, Opens)> {
        fn none(_: &Panel) -> Option<Event> {
            None
        }
        fn card_menu(p: &Panel) -> Option<Event> {
            let id = p.card_ids()[0].to_string();
            Some(Event::Menu(MenuEvent::OpenCard { id }))
        }
        fn editor(p: &Panel) -> Option<Event> {
            p.projects.iter().find_map(|r| match r {
                ProjectRow::Header(h) => Some(Event::Edit(EditEvent::Open { key: h.key.clone() })),
                _ => None,
            })
        }
        fn new_project(_: &Panel) -> Option<Event> {
            Some(Event::Edit(EditEvent::OpenNew))
        }
        vec![
            ("lanes", "lanes", none),
            ("needs-and-next", "needs-and-next", none),
            ("projects", "projects", none),
            ("review-verdicts", "review-verdicts", none),
            ("card-menu", "lanes", card_menu),
            ("editor", "projects", editor),
            ("new-project", "projects", new_project),
        ]
    }

    #[test]
    fn a_core_fed_from_data_json_alone_builds_the_runners_panel() {
        for home in [None, Some(FIXTURE_HOME)] {
            for (fixture, scene, open) in fixtures() {
                let name = format!("{fixture}-{}", home.is_some());
                let (mut p, root, posted) = publisher(&name);
                let mut feed = fed_at(scene, home);
                if let Some(event) = open(&Panel::from_core(&mut feed.model)) {
                    feed.act(event);
                }
                p.step(&mut feed, true, &mut quiet());
                assert_eq!(posted.get(), 1, "one signal for data.json");

                let runners = serde_json::to_value(Panel::from_core(&mut feed.model)).unwrap();
                let file = json(&root.join(DATA_FILE));
                assert_eq!(file["seq"], 1);
                let mut model = core_from(&file);
                // The same action, read off this core's own panel.
                if let Some(event) = open(&Panel::from_core(&mut model)) {
                    let _effects = Cockpit.update(event, &mut model);
                }
                let built = serde_json::to_value(Panel::from_core(&mut model)).unwrap();
                assert_eq!(built, runners, "{name}");
                // The fixtures load with this home (cockpit_core::fixture).
                if home == Some(FIXTURE_HOME) {
                    let want = json(&repo(&format!("native/fixtures/{fixture}.json")));
                    assert_eq!(built, want, "{name}");
                }
                fs::remove_dir_all(&root).unwrap();
            }
        }
    }

    #[test]
    fn data_json_carries_the_lane_table_to_the_sidebars_core() {
        let (mut p, root, _) = publisher("data-lanes");
        let mut feed = fed_at("lanes", Some(FIXTURE_HOME));
        let lanes = r#"[{"id": "bg", "name": "Background"}, {"name": "Main activity"}]"#;
        feed.lanes(serde_json::from_str(lanes).unwrap());
        p.step(&mut feed, true, &mut quiet());

        let file = json(&root.join(DATA_FILE));
        assert_eq!(file["lanes"], serde_json::from_str::<Value>(lanes).unwrap());
        assert_eq!(file["lanes_seq"], 1);
        let mut model = core_from(&file);
        let built = Panel::from_core(&mut model);
        let names: Vec<&str> = built.lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["BACKGROUND", "MAIN ACTIVITY", "UNSORTED"]);
        let runners = serde_json::to_value(Panel::from_core(&mut feed.model)).unwrap();
        assert_eq!(serde_json::to_value(built).unwrap(), runners);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn data_json_carries_the_expanded_table_and_is_written_only_when_it_changed() {
        let (mut p, root, posted) = publisher("data-changed");
        let mut feed = fed_at("lanes", Some(FIXTURE_HOME));
        p.step(&mut feed, true, &mut quiet());
        let file = json(&root.join(DATA_FILE));
        assert_eq!(file["home"], FIXTURE_HOME);
        let roots: Vec<&Value> = file["projects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| &p["root"])
            .collect();
        assert!(
            roots.contains(&&Value::from(format!("{FIXTURE_HOME}/dev/app-one"))),
            "{roots:?}"
        );

        // An action moves the panel, not the inputs: nothing goes.
        feed.act(Event::FlipView);
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 1);
        assert_eq!(posted.get(), 1);
        // A new frame moves the inputs: data.json goes with only the
        // data's count moved, and the signal follows it.
        let mut data = feed.inputs.data.clone().unwrap();
        data.epoch = data.epoch.map(|e| e + 1.0);
        feed.send(Event::Data(data));
        p.step(&mut feed, true, &mut quiet());
        let file = json(&root.join(DATA_FILE));
        assert_eq!(file["seq"], 2);
        assert_eq!(
            (&file["projects_seq"], &file["state_seq"], &file["data_seq"]),
            (&1.into(), &1.into(), &2.into())
        );
        assert_eq!(posted.get(), 2, "the signal follows data.json");
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 2, "nothing new");
        assert_eq!(posted.get(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn data_json_goes_alone_and_an_action_file_is_dropped() {
        let (mut p, root, posted) = publisher("no-core");
        let mut feed = Feed::without_core(Some("/h".into()));
        feed.state(SavedState::default());
        feed.frame(1_791_127_100.0);
        let action = p.outbox().join("1.json");
        fs::write(&action, r#""FlipView""#).unwrap();
        let mut lines = Vec::new();
        p.step(&mut feed, false, &mut |l| lines.push(l));
        p.step(&mut feed, false, &mut |l| lines.push(l));
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with("outbox: dropped"), "{lines:?}");
        assert!(waiting(&p.outbox()).is_empty(), "not an effect, so gone");
        let file = json(&root.join(DATA_FILE));
        assert_eq!(
            (file["seq"].clone(), file["home"].clone()),
            (1.into(), "/h".into())
        );
        assert_eq!(file["data"]["epoch"], 1_791_127_100.0);
        // No table was read, so a reader has none to send.
        assert_eq!(
            (&file["projects"], &file["projects_seq"]),
            (&Value::Null, &0.into())
        );
        assert_eq!(posted.get(), 1);
        // Written, so a wake with nothing new writes nothing.
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(posted.get(), 1);
        // The signal follows data.json.
        feed.frame(1_791_127_130.0);
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 2);
        assert_eq!(posted.get(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_name_gives_its_time_only_in_the_outbox_format() {
        assert_eq!(
            name_ms("1791229864123-000042.json"),
            Some(1_791_229_864_123)
        );
        assert_eq!(name_ms("1791229864123-1.json"), Some(1_791_229_864_123));
        for other in [
            "1.json",
            "179122986412-000042.json",
            "17912298641a3-1.json",
            "x",
        ] {
            assert_eq!(name_ms(other), None, "{other}");
        }
    }

    #[test]
    fn a_stale_outbox_file_is_dropped_never_replayed() {
        let old = format!("{:013}-000001.json", epoch_ms() - stale_ms() - 1000);
        for (text, want) in [
            (SELECT_W1, "outbox: Cmux dropped, stale"),
            (r#""FlipView""#, "outbox: unreadable dropped, stale"),
        ] {
            let (mut p, root, _) = publisher("stale");
            let mut feed = Feed::without_core(None);
            fs::write(p.outbox().join(&old), text).unwrap();
            let unsent = feed.unsent.len();
            let mut lines = Vec::new();
            assert_eq!(p.take_effects(&mut feed, &mut |l| lines.push(l)), 0);
            assert_eq!(lines, [want]);
            assert_eq!(fs::read_dir(p.outbox()).unwrap().count(), 0, "gone");
            assert_eq!(feed.unsent.len(), unsent, "nothing carried out");
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn a_file_named_otherwise_is_aged_by_when_it_was_written() {
        let (mut p, root, _) = publisher("mtime");
        let mut feed = Feed::without_core(None);
        let path = p.outbox().join("1.json");
        fs::write(&path, SELECT_W1).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - STALE - Duration::from_secs(1))
            .unwrap();
        let mut lines = Vec::new();
        assert_eq!(p.take_effects(&mut feed, &mut |l| lines.push(l)), 0);
        assert_eq!(lines, ["outbox: Cmux dropped, stale"]);
        fs::remove_dir_all(&root).unwrap();
    }

    /// The cmux call an effect file asks for, about workspace W1.
    const SELECT_W1: &str =
        r#"{"Cmux": {"method": "workspace.select", "params": {"workspace_id": "W1"}}}"#;

    #[test]
    fn a_refused_cmux_call_lands_in_the_inbox_as_failed() {
        let (mut p, root, posted) = publisher("refused");
        let mut feed = Feed::without_core(None);
        feed.frame(1_791_127_100.0);
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(posted.get(), 1, "data.json");

        let name = format!("{:013}-000001.json", epoch_ms());
        fs::write(p.outbox().join(name), SELECT_W1).unwrap();
        let mut lines = Vec::new();
        p.step(&mut feed, false, &mut |l| lines.push(l));
        assert_eq!(lines, vec!["outbox: Cmux".to_string()]);
        assert!(waiting(&p.outbox()).is_empty(), "claimed and gone");
        assert_eq!(fs::read_dir(p.outbox()).unwrap().count(), 0);

        // The worker runs it, and cmux refuses.
        let (tx, rx) = std::sync::mpsc::channel();
        for out in feed.unsent.drain(..) {
            tx.send(out).unwrap();
        }
        drop(tx);
        let failed = std::cell::RefCell::new(Vec::new());
        let reports = crate::outbox::Reports {
            log: |_| {},
            failed: |id| failed.borrow_mut().push(id),
        };
        crate::outbox::perform(&rx, &root, |_, _| false, &reports);
        for id in failed.into_inner() {
            let (changed, _, _) = feed.input(crate::Input::CmuxFailed(id));
            assert!(!changed, "not news for a frame");
        }

        let mut lines = Vec::new();
        p.step(&mut feed, false, &mut |l| lines.push(l));
        assert_eq!(lines, vec!["inbox: CmuxFailed".to_string()]);
        assert!(feed.answers.is_empty(), "taken");
        assert_eq!(posted.get(), 2, "the answer is signalled");
        let names: Vec<PathBuf> = fs::read_dir(p.inbox())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        let event: Event = serde_json::from_str(&fs::read_to_string(&names[0]).unwrap()).unwrap();
        assert!(
            matches!(&event, Event::CmuxFailed { id } if id == "W1"),
            "{event:?}"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_pr_ask_goes_to_the_asker_and_its_answer_to_the_inbox() {
        use cockpit_core::pr_poll::{PollAnswer, PrPolled};
        let (mut p, root, _) = publisher("pr-ask");
        let mut feed = Feed::without_core(None);
        let ask = r#"{"PrPoll": {"directory": "/dev/cockpit", "asked": 1791229864.5}}"#;
        fs::write(p.outbox().join("1.json"), ask).unwrap();
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(feed.unasked.len(), 1);
        assert_eq!(feed.unasked[0].directory, "/dev/cockpit");

        let polled = PrPolled {
            directory: "/dev/cockpit".into(),
            asked: 1_791_229_864.5,
            answer: PollAnswer::NoBranch,
            epoch: 1_791_229_866.0,
        };
        feed.input(crate::Input::PrPolled(Box::new(polled.clone())));
        p.step(&mut feed, false, &mut quiet());
        let file = fs::read_dir(p.inbox()).unwrap().flatten().next().unwrap();
        let event: Event = serde_json::from_str(&fs::read_to_string(file.path()).unwrap()).unwrap();
        assert!(matches!(event, Event::PrPolled(got) if *got == polled));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_answer_that_will_not_write_waits_and_is_logged_once() {
        let (mut p, root, posted) = publisher("inbox-fail");
        let mut feed = Feed::without_core(None);
        feed.frame(1_791_127_100.0);
        p.step(&mut feed, true, &mut quiet());
        // A file where inbox/ should be: it cannot be made again.
        fs::remove_dir_all(p.inbox()).unwrap();
        fs::write(p.inbox(), "").unwrap();
        feed.input(crate::Input::CmuxFailed("W1".into()));
        feed.input(crate::Input::CmuxFailed("W2".into()));
        let mut lines = Vec::new();
        p.step(&mut feed, false, &mut |l| lines.push(l));
        p.step(&mut feed, false, &mut |l| lines.push(l));
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].starts_with("inbox: CmuxFailed not written"),
            "{lines:?}"
        );
        assert_eq!(feed.answers.len(), 2);
        assert_eq!(posted.get(), 1);

        fs::remove_file(p.inbox()).unwrap();
        fs::create_dir(p.inbox()).unwrap();
        p.step(&mut feed, false, &mut quiet());
        assert!(feed.answers.is_empty());
        assert_eq!(fs::read_dir(p.inbox()).unwrap().count(), 2);
        assert_eq!(posted.get(), 2, "one signal for both");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_tally_logs_each_files_rate_and_size_once_a_minute() {
        let start = Instant::now();
        let mut t = Tally::new(start);
        for _ in 0..30 {
            t.data.add(32 * 1024);
        }
        assert_eq!(t.report(start + Duration::from_secs(59)), None, "not due");
        assert_eq!(
            t.report(start + TALLY_EVERY).as_deref(),
            Some("written: data.json 30.0 writes/min, 32.0 KB")
        );
        // It starts again, and a quiet minute logs nothing.
        assert_eq!(t.report(start + TALLY_EVERY * 2), None);
        t.data.add(2048);
        assert_eq!(
            t.report(start + TALLY_EVERY * 4).as_deref(),
            Some("written: data.json 0.5 writes/min, 2.0 KB")
        );
    }

    #[test]
    fn writes_and_signals_only_when_the_inputs_changed() {
        let (mut p, root, posted) = publisher("unchanged");
        let mut feed = fed("lanes");
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(posted.get(), 1);
        // The same inputs again: nothing written, no signal.
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 1);
        assert_eq!(posted.get(), 1);
        let mut data = feed.inputs.data.clone().unwrap();
        data.epoch = data.epoch.map(|e| e + 1.0);
        feed.send(Event::Data(data));
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(
            posted.get(),
            1,
            "no frame and no action file: not looked at"
        );
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(posted.get(), 2);
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_claimed_file_is_taken_once_and_a_bad_one_dropped() {
        let (mut p, root, _) = publisher("claim");
        let outbox = p.outbox();
        let file = outbox.join("a.json");
        fs::write(&file, r#""FlipView""#).unwrap();
        assert_eq!(claim(&file), Ok(Some(r#""FlipView""#.to_string())));
        assert_eq!(claim(&file), Ok(None), "a second claim finds nothing");

        // Half written, a hidden temp, and not JSON by name: only the
        // finished .json files are taken, in name order.
        fs::write(outbox.join("b.json"), r#"{"MoveCard": "#).unwrap();
        fs::write(outbox.join(".c.json"), r#""FlipView""#).unwrap();
        fs::write(outbox.join("d.tmp"), r#""FlipView""#).unwrap();
        fs::write(outbox.join("e.json"), SELECT_W1).unwrap();
        fs::create_dir(outbox.join("f.json")).unwrap();
        assert_eq!(
            waiting(&outbox),
            vec![outbox.join("b.json"), outbox.join("e.json")]
        );
        let mut feed = Feed::without_core(None);
        let mut lines = Vec::new();
        assert_eq!(p.take_effects(&mut feed, &mut |l| lines.push(l)), 1);
        assert!(lines[0].starts_with("outbox: dropped"), "{lines:?}");
        assert_eq!(lines[1], "outbox: Cmux");
        assert!(waiting(&outbox).is_empty());
        assert!(outbox.join(".c.json").exists() && outbox.join("d.tmp").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn what_a_crash_left_is_cleared_and_a_live_publishers_kept() {
        let root = temp_root("crash");
        let outbox = root.join(OUTBOX_DIR);
        fs::create_dir_all(&outbox).unwrap();
        fs::write(outbox.join(".taken-7-a.json"), r#""FlipView""#).unwrap();
        fs::write(outbox.join(".taken-8-b.json"), r#""FlipView""#).unwrap();
        fs::write(root.join(".data.json.7.tmp"), "{").unwrap();
        fs::write(root.join(".data.json.8.tmp"), "{").unwrap();
        fs::create_dir_all(root.join(INBOX_DIR)).unwrap();
        fs::write(root.join(INBOX_DIR).join(".answer-7-1.tmp"), "{").unwrap();
        fs::write(root.join(INBOX_DIR).join(".answer-8-1.tmp"), "{").unwrap();
        // 7 crashed; 8 is another publisher, mid-claim and mid-write.
        let p = Publisher::new_with(root.clone(), Box::new(|| true), &|pid| pid == 8).unwrap();
        assert!(
            !p.outbox().join(".taken-7-a.json").exists(),
            "never applied"
        );
        assert!(!root.join(".data.json.7.tmp").exists());
        assert!(!root.join(INBOX_DIR).join(".answer-7-1.tmp").exists());
        assert!(root.join(INBOX_DIR).join(".answer-8-1.tmp").exists());
        assert!(p.outbox().join(".taken-8-b.json").exists());
        assert!(root.join(".data.json.8.tmp").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_pid_is_read_from_a_leftovers_name_and_asked_after() {
        assert_eq!(pid_in(".taken-123-a.json", TAKEN), Some(123));
        assert_eq!(
            pid_in(".data.json.45.tmp", &tmp_prefix(DATA_FILE)),
            Some(45)
        );
        assert_eq!(pid_in(".taken-x.json", TAKEN), None);
        assert_eq!(pid_in("a.json", TAKEN), None);
        assert!(alive(std::process::id()));
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        assert!(!alive(dead));
    }

    #[test]
    fn a_file_that_cannot_be_claimed_is_logged_once() {
        use std::os::unix::fs::PermissionsExt;
        let (mut p, root, _) = publisher("stuck");
        let mut feed = Feed::without_core(None);
        let outbox = p.outbox();
        fs::write(outbox.join("1.json"), r#""FlipView""#).unwrap();
        // A folder it cannot rename in: every claim fails the same way.
        fs::set_permissions(&outbox, fs::Permissions::from_mode(0o555)).unwrap();
        let mut lines = Vec::new();
        for _ in 0..3 {
            assert_eq!(p.take_effects(&mut feed, &mut |l| lines.push(l)), 0);
        }
        fs::set_permissions(&outbox, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with("outbox: 1.json"), "{lines:?}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_write_is_logged_and_tried_again() {
        let (mut p, root, posted) = publisher("fail");
        let mut feed = fed("lanes");
        // A folder where the file should be: the rename cannot replace it.
        fs::create_dir(root.join(DATA_FILE)).unwrap();
        let mut lines = Vec::new();
        p.step(&mut feed, true, &mut |l| lines.push(l));
        assert!(lines[0].starts_with("data.json not written"), "{lines:?}");
        assert_eq!(posted.get(), 0, "no signal without a file");
        let tmps = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(tmps, 0, "the temp file is cleared");

        fs::remove_dir(root.join(DATA_FILE)).unwrap();
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 1);
        assert_eq!(posted.get(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn writes_nothing_until_ready_unless_it_waited_too_long() {
        let feed = Feed::default();
        assert!(!ready(&feed, Instant::now()));
        let long_ago = Instant::now().checked_sub(READY_LIMIT).unwrap();
        assert!(ready(&feed, long_ago));
    }

    #[test]
    fn the_parent_is_gone_once_the_process_has_another() {
        let p = Parent(4242);
        assert!(!p.gone_given(4242));
        assert!(p.gone_given(1));
        assert!(Parent::of(None).is_ok_and(|p| !p.gone()));
    }

    #[test]
    fn starts_only_with_a_parent_to_stop_with() {
        assert_eq!(Parent::given(None, 4242), Ok(Parent(4242)));
        assert_eq!(Parent::given(Some(4242), 4242), Ok(Parent(4242)));
        let gone = Err("its parent has already gone".to_string());
        assert_eq!(Parent::given(None, 1), gone, "orphaned before it looked");
        assert_eq!(Parent::given(Some(4242), 1), gone, "the named one went");
        assert_eq!(Parent::given(Some(1), 1), gone, "launchd is never one");
        let wrapped = Parent::given(Some(4242), 99);
        assert!(wrapped.is_err_and(|e| e.contains("not its parent")));
    }

    #[test]
    fn the_shared_folder_is_the_app_groups() {
        assert_eq!(
            default_root(Path::new("/Users/jon")),
            PathBuf::from("/Users/jon/Library/Group Containers/9S5FG4LQAF.dev.jonyardley.cockpit")
        );
    }
}
