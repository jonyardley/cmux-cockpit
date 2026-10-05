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
//! - In: each file in outbox/ is one action (action.rs). The writer
//!   writes it under a name that starts with "." or does not end in
//!   ".json", then renames it to `<name>.json`; names sort in the order
//!   sent (`<epoch ms>-<counter>.json`, say). Each one is claimed by an
//!   atomic rename before it is read, so it is applied at most once even
//!   with two publishers running, then deleted. One that will not parse
//!   is deleted and logged, never retried.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cockpit_core::{Model, Panel};
use serde::Serialize;

use crate::Feed;
use crate::action::Action;

/// The App Group the helper app and the sidebar share.
pub const GROUP_ID: &str = "9S5FG4LQAF.dev.jonyardley.cockpit";
/// Overrides the shared folder (tests, or a run by hand).
pub const ROOT_ENV: &str = "COCKPIT_GROUP_DIR";
pub const PANEL_FILE: &str = "panel.json";
pub const OUTBOX_DIR: &str = "outbox";
/// Before an outbox file's name once claimed.
const TAKEN: &str = ".taken-";
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

/// Whether the panel is worth writing: replay has caught up and every
/// poll has answered, or it has been `READY_LIMIT` since the start.
pub fn ready(feed: &Feed, started: Instant) -> bool {
    (feed.join.health.caught_up() && feed.join.loaded()) || started.elapsed() >= READY_LIMIT
}

/// Writes `bytes` to `dir/name` through a temp file in the same folder,
/// so a reader sees the old file or the new one, never half of either.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
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

/// Writes the panel model out and takes actions in, in one shared folder.
pub struct Publisher {
    root: PathBuf,
    /// The panel last written, so an unchanged one is not written again.
    last: Option<Panel>,
    seq: u64,
    /// Posts the "changed" signal; true when it went.
    signal: Box<dyn FnMut() -> bool>,
}

impl Publisher {
    /// A publisher writing into `root`, which it makes with its outbox
    /// when missing. Claims a crash left behind are cleared: at most once
    /// means never applying them.
    pub fn new(root: PathBuf, signal: Box<dyn FnMut() -> bool>) -> io::Result<Publisher> {
        let outbox = root.join(OUTBOX_DIR);
        fs::create_dir_all(&outbox)?;
        for entry in fs::read_dir(&outbox)?.flatten() {
            if entry.file_name().to_string_lossy().starts_with(TAKEN) {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(Publisher {
            root,
            last: None,
            seq: 0,
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
                    log(format!("outbox: {e}"));
                    continue;
                }
            };
            match Action::parse(&text) {
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
        let panel = Panel::from_core(model);
        if self.last.as_ref() == Some(&panel) {
            return false;
        }
        let out = Published {
            seq: self.seq + 1,
            written_at_ms: epoch_ms(),
            panel: &panel,
        };
        let written = serde_json::to_vec(&out)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                write_atomic(&self.root, PANEL_FILE, &bytes).map_err(|e| e.to_string())
            });
        if let Err(e) = written {
            // Kept unwritten, so the next call tries again.
            log(format!("{PANEL_FILE} not written: {e}"));
            return false;
        }
        self.seq += 1;
        self.last = Some(panel);
        if !(self.signal)() {
            log("changed signal not posted".to_string());
        }
        true
    }

    /// One turn of the runner: the outbox's actions go in, then the panel
    /// goes out when a frame came, an action went in, or nothing has been
    /// written yet (or the last write failed).
    pub fn step(&mut self, feed: &mut Feed, fresh: bool, log: &mut dyn FnMut(String)) {
        let applied = self.take_actions(feed, log);
        if fresh || applied > 0 || self.last.is_none() {
            self.publish(&mut feed.model, log);
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
    /// else whoever started this one. None when that is already gone: a
    /// process started from launchd's own hand has nothing to stop with,
    /// and one whose starter has gone was orphaned before it could look.
    pub fn of(named: Option<u32>) -> Option<Parent> {
        Parent::given(named, std::os::unix::process::parent_id())
    }

    fn given(named: Option<u32>, now: u32) -> Option<Parent> {
        let parent = Parent(named.unwrap_or(now));
        (parent.0 != ORPHANAGE && !parent.gone_given(now)).then_some(parent)
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
    use cockpit_core::Event;
    use cockpit_core::data::Data;
    use cockpit_core::lanes::LaneKey;
    use cockpit_core::persist::SavedState;
    use cockpit_core::projects::Project;
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
                2,
                "only panel.json and outbox/: {leftovers:?}"
            );
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn writes_and_signals_only_when_the_panel_changed() {
        let (mut p, root, posted) = publisher("unchanged");
        let mut feed = fed("lanes");
        assert!(p.publish(&mut feed.model, &mut quiet()));
        assert!(!p.publish(&mut feed.model, &mut quiet()));
        p.step(&mut feed, true, &mut quiet());
        assert_eq!(posted.get(), 1);
        feed.act(Event::FlipView);
        assert!(p.publish(&mut feed.model, &mut quiet()));
        assert_eq!(posted.get(), 2);
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
    fn a_claim_left_by_a_crash_is_cleared_not_applied() {
        let root = temp_root("crash");
        let outbox = root.join(OUTBOX_DIR);
        fs::create_dir_all(&outbox).unwrap();
        fs::write(outbox.join(".taken-1-a.json"), r#""FlipView""#).unwrap();
        let p = Publisher::new(root.clone(), Box::new(|| true)).unwrap();
        assert_eq!(fs::read_dir(p.outbox()).unwrap().count(), 0);
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
        assert!(Parent::of(None).is_some_and(|p| !p.gone()));
    }

    #[test]
    fn starts_only_with_a_parent_to_stop_with() {
        assert_eq!(Parent::given(None, 4242), Some(Parent(4242)));
        assert_eq!(Parent::given(Some(4242), 4242), Some(Parent(4242)));
        assert_eq!(Parent::given(None, 1), None, "orphaned before it looked");
        assert_eq!(Parent::given(Some(4242), 1), None, "the named one went");
        assert_eq!(Parent::given(Some(4242), 99), None, "not its parent");
        assert_eq!(Parent::given(Some(1), 1), None, "launchd is never one");
    }

    #[test]
    fn the_shared_folder_is_the_app_groups() {
        assert_eq!(
            default_root(Path::new("/Users/jon")),
            PathBuf::from("/Users/jon/Library/Group Containers/9S5FG4LQAF.dev.jonyardley.cockpit")
        );
    }
}
