//! cockpit-publish's half of the bridge to the Swift sidebar, which is
//! sandboxed and so cannot run the runner itself. The helper app starts
//! cockpit-publish; it runs the runner headless and talks to the sidebar
//! through the App Group folder the two share (`default_root`):
//!
//! - Out: after each change it writes the core's panel model to
//!   panel.json, whole and atomically (a temp file renamed over it), as
//!   `{"seq": 4, "written_at_ms": 1791229864123, "panel": {...}}`. The
//!   panel is cockpit_core::Panel as native/fixtures/ hold it; `seq`
//!   counts this process's writes from 1, and `written_at_ms` is the wall
//!   clock at the write, so the sidebar can log how late it read it. Then
//!   it posts the bare signal (signal.rs). Nothing is written until the
//!   runner is ready (`ready`), so a restart never blanks the sidebar.
//! - Beside it, data.json: what the core was fed (crate::Inputs), as
//!   `{"seq": 9, "written_at_ms": ..., "home": "/Users/jon", "projects":
//!   [...], "state": {...}, "data": {...}}`, written the same way when it
//!   changed, with its own `seq`. A core fed `projects`, `state`, then
//!   `data`, with `home` set on its model first, builds the same panel.
//!   One signal covers both files. Without a core only data.json goes.
//! - Once a minute, when anything was written, a log line gives each
//!   file's writes per minute and size (`Tally`).
//! - In: each file in outbox/ is one action (action.rs). The writer
//!   writes it under a name that starts with "." or does not end in
//!   ".json", then renames it to `<name>.json`. Files are taken in byte
//!   order of their names, so a name must sort in the order sent: a
//!   fixed width, zero padded `<13 digit epoch ms>-<6 digit counter>.json`
//!   (`1791229864123-000042.json`), never a bare counter, where "10"
//!   sorts before "9". Each one is claimed by an
//!   atomic rename before it is read, so it is applied at most once even
//!   with two publishers running, then deleted. One that will not parse
//!   is deleted and logged, never retried.

use std::collections::HashSet;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cockpit_core::{Model, Panel};
use serde::Serialize;

use crate::action::Action;
use crate::{Feed, Inputs};

/// The App Group the helper app and the sidebar share.
pub const GROUP_ID: &str = "9S5FG4LQAF.dev.jonyardley.cockpit";
/// Overrides the shared folder (tests, or a run by hand).
pub const ROOT_ENV: &str = "COCKPIT_GROUP_DIR";
pub const PANEL_FILE: &str = "panel.json";
pub const DATA_FILE: &str = "data.json";
pub const OUTBOX_DIR: &str = "outbox";
/// Before an outbox file's name once claimed, then its claimer's pid.
const TAKEN: &str = ".taken-";
/// Before panel.json's temp file's pid.
const PANEL_TMP: &str = ".panel.json.";
/// Before data.json's temp file's pid.
const DATA_TMP: &str = ".data.json.";
/// How often the write tally is logged.
pub const TALLY_EVERY: Duration = Duration::from_secs(60);
/// The longest the publisher waits for the runner to be ready before it
/// writes whatever it has, as `cockpit-pane --once` does.
pub const READY_LIMIT: Duration = Duration::from_secs(10);

/// The shared folder under `home`.
pub fn default_root(home: &Path) -> PathBuf {
    home.join("Library/Group Containers").join(GROUP_ID)
}

/// What panel.json holds.
#[derive(Debug, Serialize)]
pub struct Published<'a> {
    pub seq: u64,
    pub written_at_ms: u64,
    pub panel: &'a Panel,
}

/// What data.json holds: the core's inputs, beside the same envelope.
#[derive(Debug, Serialize)]
pub struct PublishedData<'a> {
    pub seq: u64,
    pub written_at_ms: u64,
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

/// How often and how large panel.json and data.json were written, for
/// the log: one line per `TALLY_EVERY`, none when nothing was written.
#[derive(Debug)]
pub struct Tally {
    since: Instant,
    panel: Writes,
    data: Writes,
}

impl Tally {
    pub fn new(now: Instant) -> Tally {
        Tally {
            since: now,
            panel: Writes::default(),
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
        let line = (self.panel.count > 0 || self.data.count > 0).then(|| {
            format!(
                "written: {}; {}",
                self.panel.describe(PANEL_FILE, minutes),
                self.data.describe(DATA_FILE, minutes)
            )
        });
        *self = Tally::new(now);
        line
    }
}

/// Whether the panel is worth writing: replay has caught up and every
/// poll has answered, or it has been `READY_LIMIT` since the start.
pub fn ready(feed: &Feed, started: Instant) -> bool {
    (feed.join.health.caught_up() && feed.join.loaded()) || started.elapsed() >= READY_LIMIT
}

/// Writes `bytes` to `dir/name` through a temp file in the same folder,
/// so a reader sees the old file or the new one, never half of either.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    // `PANEL_TMP` is this name for panel.json, so a crash's is swept.
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let written = fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, dir.join(name)));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
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

/// Writes the panel model out and takes actions in, in one shared folder.
pub struct Publisher {
    root: PathBuf,
    /// Outbox files that could not be claimed, each logged once rather
    /// than on every wake.
    stuck: HashSet<PathBuf>,
    /// The panel last written, so an unchanged one is not written again.
    last: Option<Panel>,
    seq: u64,
    /// The inputs last written to data.json, likewise.
    last_inputs: Option<Inputs>,
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
        sweep(&root, PANEL_TMP, alive);
        sweep(&root, DATA_TMP, alive);
        Ok(Publisher {
            root,
            stuck: HashSet::new(),
            last: None,
            seq: 0,
            last_inputs: None,
            data_seq: 0,
            tally: Tally::new(Instant::now()),
            signal,
        })
    }

    pub fn outbox(&self) -> PathBuf {
        self.root.join(OUTBOX_DIR)
    }

    /// Hands the core every action waiting in the outbox, oldest first.
    /// Returns how many went in.
    pub fn take_actions(&mut self, feed: &mut Feed, log: &mut dyn FnMut(String)) -> usize {
        let mut applied = 0;
        for path in waiting(&self.outbox()) {
            let text = match claim(&path) {
                Ok(Some(text)) => text,
                Ok(None) => continue,
                Err(e) => {
                    if self.stuck.insert(path.clone()) {
                        log(format!("outbox: {e}"));
                    }
                    continue;
                }
            };
            match Action::parse(&text) {
                // The effects the sidebar's core will send here are not
                // read yet (issue #269); an action has no core to go to.
                Ok(action) if !feed.has_core() => {
                    log(format!("outbox: {} dropped, no core", action.name()));
                }
                Ok(action) => {
                    log(format!("outbox: {}", action.name()));
                    feed.act(action.into());
                    applied += 1;
                }
                Err(e) => log(format!("outbox: dropped {}: {e}", path.display())),
            }
        }
        applied
    }

    /// Writes the core's panel to panel.json and posts the signal, when it
    /// differs from the one last written. True when it wrote.
    pub fn publish(&mut self, model: &mut Model, log: &mut dyn FnMut(String)) -> bool {
        let wrote = self.write_panel(model, log);
        if wrote {
            self.post(log);
        }
        wrote
    }

    /// Writes the panel to panel.json, when it differs from the one last
    /// written. True when it wrote.
    fn write_panel(&mut self, model: &mut Model, log: &mut dyn FnMut(String)) -> bool {
        let panel = Panel::from_core(model);
        if self.last.as_ref() == Some(&panel) {
            return false;
        }
        let out = Published {
            seq: self.seq + 1,
            written_at_ms: epoch_ms(),
            panel: &panel,
        };
        let Some(bytes) = self.write(PANEL_FILE, &out, log) else {
            return false;
        };
        self.seq += 1;
        self.last = Some(panel);
        self.tally.panel.add(bytes);
        true
    }

    /// Writes the core's inputs to data.json, when they differ from those
    /// last written. True when it wrote.
    fn write_data(&mut self, inputs: &Inputs, log: &mut dyn FnMut(String)) -> bool {
        if self.last_inputs.as_ref() == Some(inputs) {
            return false;
        }
        let out = PublishedData {
            seq: self.data_seq + 1,
            written_at_ms: epoch_ms(),
            inputs,
        };
        let Some(bytes) = self.write(DATA_FILE, &out, log) else {
            return false;
        };
        self.data_seq += 1;
        self.last_inputs = Some(inputs.clone());
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

    /// One turn of the runner: the outbox's actions go in, then the panel
    /// and the inputs go out when a frame came, an action went in, or a
    /// file has not been written yet (or its last write failed), with one
    /// signal for both. Without a core only the inputs go out. The tally
    /// is logged when it is due.
    pub fn step(&mut self, feed: &mut Feed, fresh: bool, log: &mut dyn FnMut(String)) {
        let applied = self.take_actions(feed, log);
        let core = feed.has_core();
        let unwritten = (core && self.last.is_none()) || self.last_inputs.is_none();
        if fresh || applied > 0 || unwritten {
            let panel = core && self.write_panel(&mut feed.model, log);
            let data = self.write_data(&feed.inputs, log);
            if panel || data {
                self.post(log);
            }
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
    use cockpit_core::lanes::LaneKey;
    use cockpit_core::panel::ProjectRow;
    use cockpit_core::persist::SavedState;
    use cockpit_core::projects::Project;
    use cockpit_core::{Cockpit, EditEvent, Event, MenuEvent};
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
    fn writes_each_scenes_panel_as_its_fixture() {
        for scene in ["lanes", "needs-and-next", "projects", "review-verdicts"] {
            let (mut p, root, posted) = publisher(scene);
            let mut feed = fed(scene);
            let before = epoch_ms();
            p.step(&mut feed, true, &mut quiet());

            let got = json(&root.join(PANEL_FILE));
            let want = json(&repo(&format!("native/fixtures/{scene}.json")));
            assert_eq!(got["panel"], want, "{scene}");
            assert_eq!(got["seq"], 1);
            let at = got["written_at_ms"].as_u64().unwrap();
            assert!(at >= before && at <= epoch_ms() + 1);
            assert_eq!(posted.get(), 1, "one signal per write");
            let leftovers: Vec<_> = fs::read_dir(&root)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            assert_eq!(
                leftovers.len(),
                3,
                "only panel.json, data.json and outbox/: {leftovers:?}"
            );
            fs::remove_dir_all(&root).unwrap();
        }
    }

    /// A scene's feed as the runner builds it, home and all: the table
    /// through `Feed::projects`, so "~" roots expand against home.
    fn fed_at(scene: &str, home: Option<&str>) -> Feed {
        let input = json(&repo(&format!("test/golden/{scene}.input.json")));
        let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
        let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
        let data: Data = serde_json::from_value(input["data"].clone()).unwrap();
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
        let projects: Vec<Project> = serde_json::from_value(file["projects"].clone()).unwrap();
        let saved: SavedState = serde_json::from_value(file["state"].clone()).unwrap();
        let data: Data = serde_json::from_value(file["data"].clone()).unwrap();
        for event in [
            Event::Projects(projects),
            Event::State(Box::new(saved)),
            Event::Data(data),
        ] {
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
    fn a_core_fed_from_data_json_alone_builds_the_helpers_panel() {
        for home in [None, Some("/Users/jon")] {
            for (fixture, scene, open) in fixtures() {
                let name = format!("{fixture}-{}", home.is_some());
                let (mut p, root, posted) = publisher(&name);
                let mut feed = fed_at(scene, home);
                if let Some(event) = open(&Panel::from_core(&mut feed.model)) {
                    feed.act(event);
                }
                p.step(&mut feed, true, &mut quiet());
                assert_eq!(posted.get(), 1, "one signal for both files");

                let helpers = json(&root.join(PANEL_FILE))["panel"].clone();
                let file = json(&root.join(DATA_FILE));
                assert_eq!(file["seq"], 1);
                let mut model = core_from(&file);
                // The same action, read off this core's own panel.
                if let Some(event) = open(&Panel::from_core(&mut model)) {
                    let _effects = Cockpit.update(event, &mut model);
                }
                let built = serde_json::to_value(Panel::from_core(&mut model)).unwrap();
                assert_eq!(built, helpers, "{name}");
                if home.is_none() {
                    let want = json(&repo(&format!("native/fixtures/{fixture}.json")));
                    assert_eq!(built, want, "{name}");
                }
                fs::remove_dir_all(&root).unwrap();
            }
        }
    }

    #[test]
    fn data_json_carries_the_expanded_table_and_is_written_only_when_it_changed() {
        let (mut p, root, posted) = publisher("data-changed");
        let mut feed = fed_at("lanes", Some("/Users/jon"));
        p.step(&mut feed, true, &mut quiet());
        let file = json(&root.join(DATA_FILE));
        assert_eq!(file["home"], "/Users/jon");
        let roots: Vec<&Value> = file["projects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| &p["root"])
            .collect();
        assert!(
            roots.contains(&&Value::from("/Users/jon/dev/app-one")),
            "{roots:?}"
        );

        // An action moves the panel, not the inputs.
        feed.act(Event::FlipView);
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(PANEL_FILE))["seq"], 2);
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 1);
        // A new frame moves the inputs, not the panel.
        let mut data = feed.inputs.data.clone().unwrap();
        data.epoch = data.epoch.map(|e| e + 1.0);
        feed.send(Event::Data(data));
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(DATA_FILE))["seq"], 2);
        assert_eq!(posted.get(), 3);
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(posted.get(), 3, "nothing new, no signal");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn without_a_core_only_data_json_goes_and_actions_are_dropped() {
        let (mut p, root, posted) = publisher("no-core");
        let mut feed = Feed::without_core(Some("/h".into()));
        feed.state(SavedState::default());
        feed.frame(1_791_127_100.0);
        fs::write(p.outbox().join("1.json"), r#""FlipView""#).unwrap();
        let mut lines = Vec::new();
        p.step(&mut feed, false, &mut |l| lines.push(l));
        assert_eq!(lines, vec!["outbox: FlipView dropped, no core".to_string()]);
        assert!(waiting(&p.outbox()).is_empty());
        assert!(!root.join(PANEL_FILE).exists());
        let file = json(&root.join(DATA_FILE));
        assert_eq!(
            (file["seq"].clone(), file["home"].clone()),
            (1.into(), "/h".into())
        );
        assert_eq!(file["data"]["epoch"], 1_791_127_100.0);
        assert_eq!(posted.get(), 1);
        // Written, so a wake with nothing new writes nothing.
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(posted.get(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_tally_logs_each_files_rate_and_size_once_a_minute() {
        let start = Instant::now();
        let mut t = Tally::new(start);
        t.panel.add(10 * 1024);
        t.panel.add(10 * 1024 + 512);
        for _ in 0..30 {
            t.data.add(32 * 1024);
        }
        assert_eq!(t.report(start + Duration::from_secs(59)), None, "not due");
        assert_eq!(
            t.report(start + TALLY_EVERY).as_deref(),
            Some("written: panel.json 2.0 writes/min, 10.5 KB; data.json 30.0 writes/min, 32.0 KB")
        );
        // It starts again, and a quiet minute logs nothing.
        assert_eq!(t.report(start + TALLY_EVERY * 2), None);
        t.data.add(2048);
        assert_eq!(
            t.report(start + TALLY_EVERY * 4).as_deref(),
            Some("written: panel.json 0.0 writes/min, 0.0 KB; data.json 0.5 writes/min, 2.0 KB")
        );
    }

    #[test]
    fn writes_and_signals_only_when_the_panel_changed() {
        let (mut p, root, posted) = publisher("unchanged");
        let mut feed = fed("lanes");
        assert!(p.publish(&mut feed.model, &mut quiet()));
        assert!(!p.publish(&mut feed.model, &mut quiet()));
        assert_eq!(posted.get(), 1);
        // The same panel again: only data.json, its first write, is news.
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(json(&root.join(PANEL_FILE))["seq"], 1);
        assert_eq!(posted.get(), 2);
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(posted.get(), 2);
        feed.act(Event::FlipView);
        assert!(p.publish(&mut feed.model, &mut quiet()));
        assert_eq!(posted.get(), 3);
        assert_eq!(json(&root.join(PANEL_FILE))["seq"], 2);
        fs::remove_dir_all(&root).unwrap();
    }

    /// The first card in Main the core will move, and Review's cards.
    fn main_card_and_review(panel: &Value) -> (String, Vec<String>) {
        let lanes = panel["lanes"].as_array().unwrap();
        let cards = |key: &str| -> Vec<Value> {
            lanes.iter().find(|l| l["key"] == key).unwrap()["rows"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["Card"].is_object())
                .map(|r| r["Card"].clone())
                .collect()
        };
        let main = cards("main");
        let movable = main.iter().find(|c| c["movable"] == true).unwrap();
        let review = cards("review");
        let ids = review
            .iter()
            .map(|c| c["ws_id"].as_str().unwrap().to_string());
        (
            movable["ws_id"].as_str().unwrap().to_string(),
            ids.collect(),
        )
    }

    #[test]
    fn an_action_file_moves_a_card_once_and_goes() {
        let (mut p, root, _) = publisher("move");
        let mut feed = fed("lanes");
        p.step(&mut feed, true, &mut quiet());
        let (id, review) = main_card_and_review(&json(&root.join(PANEL_FILE))["panel"]);
        assert!(!review.contains(&id));

        let file = p.outbox().join("1791229864123-1.json");
        let text = format!(r#"{{"MoveCard": {{"id": "{id}", "lane": "review", "before": null}}}}"#);
        fs::write(&file, text).unwrap();
        let mut lines = Vec::new();
        p.step(&mut feed, false, &mut |l| lines.push(l));

        assert!(!file.exists(), "the action file is deleted");
        assert_eq!(
            fs::read_dir(p.outbox()).unwrap().count(),
            0,
            "no claim is left"
        );
        assert_eq!(lines, vec!["outbox: MoveCard".to_string()]);
        let got = json(&root.join(PANEL_FILE));
        assert_eq!(got["seq"], 2);
        let (_, review) = main_card_and_review(&got["panel"]);
        assert!(review.contains(&id), "{id} moved into review");
        let lane = Panel::from_core(&mut feed.model).lane_of(&id);
        assert_eq!(lane, Some(LaneKey::Review));
        let sent = feed.unsent.len();
        assert!(sent > 0, "the move asked cmux to follow");

        // Nothing left to take: a second turn applies nothing more.
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(feed.unsent.len(), sent);
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
        fs::write(outbox.join("e.json"), r#""FlipView""#).unwrap();
        fs::create_dir(outbox.join("f.json")).unwrap();
        assert_eq!(
            waiting(&outbox),
            vec![outbox.join("b.json"), outbox.join("e.json")]
        );
        let mut feed = fed("lanes");
        let mut lines = Vec::new();
        assert_eq!(p.take_actions(&mut feed, &mut |l| lines.push(l)), 1);
        assert!(lines[0].starts_with("outbox: dropped"), "{lines:?}");
        assert_eq!(lines[1], "outbox: FlipView");
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
        fs::write(root.join(".panel.json.7.tmp"), "{").unwrap();
        fs::write(root.join(".panel.json.8.tmp"), "{").unwrap();
        // 7 crashed; 8 is another publisher, mid-claim and mid-write.
        let p = Publisher::new_with(root.clone(), Box::new(|| true), &|pid| pid == 8).unwrap();
        assert!(
            !p.outbox().join(".taken-7-a.json").exists(),
            "never applied"
        );
        assert!(!root.join(".panel.json.7.tmp").exists());
        assert!(p.outbox().join(".taken-8-b.json").exists());
        assert!(root.join(".panel.json.8.tmp").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_pid_is_read_from_a_leftovers_name_and_asked_after() {
        assert_eq!(pid_in(".taken-123-a.json", TAKEN), Some(123));
        assert_eq!(pid_in(".panel.json.45.tmp", PANEL_TMP), Some(45));
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
        let mut feed = fed("lanes");
        let outbox = p.outbox();
        fs::write(outbox.join("1.json"), r#""FlipView""#).unwrap();
        // A folder it cannot rename in: every claim fails the same way.
        fs::set_permissions(&outbox, fs::Permissions::from_mode(0o555)).unwrap();
        let mut lines = Vec::new();
        for _ in 0..3 {
            assert_eq!(p.take_actions(&mut feed, &mut |l| lines.push(l)), 0);
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
        fs::create_dir(root.join(PANEL_FILE)).unwrap();
        let mut lines = Vec::new();
        assert!(!p.publish(&mut feed.model, &mut |l| lines.push(l)));
        assert!(lines[0].starts_with("panel.json not written"), "{lines:?}");
        assert_eq!(posted.get(), 0, "no signal without a file");
        let tmps = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(tmps, 0, "the temp file is cleared");

        fs::remove_dir(root.join(PANEL_FILE)).unwrap();
        p.step(&mut feed, false, &mut quiet());
        assert_eq!(json(&root.join(PANEL_FILE))["seq"], 1);
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
