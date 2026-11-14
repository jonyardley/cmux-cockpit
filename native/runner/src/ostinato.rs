//! Watches the Ostinato records folder (issue #390) on a thread of its
//! own, and finds which open workspace folders are main checkouts of
//! which GitHub repo, then hands the core both (`Input::Ostinato`)
//! whenever either changed.
//!
//! - The folder is `$OSTINATO_HOME` when set and not empty, else
//!   `~/.local/state/ostinato/records/`. Only its `*.jsonl` files are
//!   records; `owner__repo.jsonl` is the project `owner/repo`.
//! - It is polled every `FILES_EVERY`, as watch.rs polls the config
//!   files: each file's size and modified time, and a file is read only
//!   when they moved. A missing folder is no records, and no error.
//! - Only while there is a record, each open folder is looked up once
//!   while it stays open (cached, and forgotten when its workspace
//!   closes, so reopening it looks again): the nearest `.git` at or above it, a directory for a main
//!   checkout, whose `config` names its `origin`
//!   (cockpit_core::ostinato::remote). No git process runs, since git
//!   run in a folder obeys that repo's own config, which can run
//!   anything (`core.fsmonitor`, a pager). A `.git` file is a linked
//!   worktree, which matches nothing.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};

use cockpit_core::ostinato::remote::checkout_repo;
use cockpit_core::ostinato::{OstinatoFeed, RecordText};

use crate::watch::{Stamp, stamp};
use crate::{FILES_EVERY, Input};

/// Names the records folder.
pub const HOME_ENV: &str = "OSTINATO_HOME";

/// The records folder: `env`, the value of `$OSTINATO_HOME`, when set
/// and not empty, else under `home`. None with neither.
pub fn records_dir(env: Option<OsString>, home: Option<&Path>) -> Option<PathBuf> {
    match env {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => home.map(|h| h.join(".local/state/ostinato/records")),
    }
}

/// The project a record's file is named for, `owner__repo.jsonl` as
/// `owner/repo` in lower case; None for a file that is no record.
pub fn record_project(name: &str) -> Option<String> {
    if name.starts_with('.') {
        return None;
    }
    let stem = name.strip_suffix(".jsonl")?;
    let project = match stem.split_once("__") {
        Some((owner, repo)) => format!("{owner}/{repo}"),
        // Not the kit's name: its run_started may still say its project.
        None => stem.to_string(),
    };
    Some(project.to_ascii_lowercase())
}

/// The record files in `dir`, with their projects.
fn list(dir: &Path) -> Vec<(PathBuf, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let project = record_project(e.file_name().to_str()?)?;
            Some((e.path(), project))
        })
        .collect()
}

/// One record file as last read.
#[derive(Debug)]
struct Kept {
    stamp: Stamp,
    project: String,
    text: RecordText,
}

/// The record files, each read again only when it changed.
#[derive(Debug, Default)]
pub struct Records {
    dir: Option<PathBuf>,
    files: BTreeMap<PathBuf, Kept>,
}

impl Records {
    pub fn new(dir: Option<PathBuf>) -> Records {
        Records {
            dir,
            files: BTreeMap::new(),
        }
    }

    /// Reads each record file that changed, appeared or went since the
    /// last check; true when any did. One that will not read is tried
    /// again on the next check.
    pub fn check(&mut self) -> bool {
        let found = self.dir.as_deref().map(list).unwrap_or_default();
        let before = self.files.len();
        self.files.retain(|p, _| found.iter().any(|(f, _)| f == p));
        let mut changed = self.files.len() != before;
        for (path, project) in found {
            let now = stamp(&path);
            if self.files.get(&path).is_some_and(|k| k.stamp == now) {
                continue;
            }
            if let Ok(bytes) = fs::read(&path) {
                let text = RecordText::from_bytes(&bytes);
                let kept = Kept {
                    stamp: now,
                    project,
                    text,
                };
                self.files.insert(path, kept);
                changed = true;
            }
        }
        changed
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// Each record's text by its project.
    pub fn texts(&self) -> BTreeMap<String, RecordText> {
        self.files
            .values()
            .map(|k| (k.project.clone(), k.text.clone()))
            .collect()
    }
}

/// Each folder looked up: the repo it is the main checkout of, or None.
#[derive(Debug, Default)]
pub struct Checkouts {
    known: HashMap<String, Option<String>>,
}

impl Checkouts {
    /// Looks up each folder in `open` not looked up yet, with `look`, and
    /// forgets those no longer open, so a folder cloned into or given its
    /// origin after it was looked up is looked up again once reopened.
    pub fn learn(&mut self, open: &[String], look: impl Fn(&str) -> Option<String>) {
        self.known.retain(|dir, _| open.contains(dir));
        for dir in open {
            if !self.known.contains_key(dir) {
                self.known.insert(dir.clone(), look(dir));
            }
        }
    }

    /// The folders in `open` that are main checkouts, to their repos.
    pub fn map(&self, open: &[String]) -> BTreeMap<String, String> {
        open.iter()
            .filter_map(|dir| Some((dir.clone(), self.known.get(dir)?.clone()?)))
            .collect()
    }
}

/// The config file of the main checkout `dir` is in: the nearest `.git`
/// at or above it, when that is a directory. None when it is a file (a
/// linked worktree, or a submodule) or there is none.
fn main_config(dir: &Path) -> Option<PathBuf> {
    for folder in dir.ancestors() {
        let git = folder.join(".git");
        match fs::metadata(&git) {
            Ok(m) if m.is_dir() => return Some(git.join("config")),
            Ok(_) => return None,
            Err(_) => {}
        }
    }
    None
}

/// The GitHub repo `dir` is in the main checkout of, read from its
/// `.git/config` with no git process; None for none.
pub fn checkout_of(dir: &str) -> Option<String> {
    let config = fs::read_to_string(main_config(Path::new(dir))?).ok()?;
    checkout_repo(&config)
}

/// The watch's state between checks.
#[derive(Debug, Default)]
pub struct Watch {
    pub records: Records,
    pub checkouts: Checkouts,
    /// The workspace folders open in cmux, as the runner last sent them.
    pub open: Vec<String>,
    /// The feed last handed on; nothing until there is something.
    sent: OstinatoFeed,
}

impl Watch {
    pub fn new(dir: Option<PathBuf>) -> Watch {
        Watch {
            records: Records::new(dir),
            ..Watch::default()
        }
    }

    /// One check: the feed to hand on, when it moved since the last.
    /// Folders are looked up only while there is a record.
    pub fn check(&mut self, look: impl Fn(&str) -> Option<String>) -> Option<OstinatoFeed> {
        let moved = self.records.check();
        let checkouts = if self.records.is_empty() {
            BTreeMap::new()
        } else {
            self.checkouts.learn(&self.open, look);
            self.checkouts.map(&self.open)
        };
        if !moved && checkouts == self.sent.checkouts {
            return None;
        }
        let feed = OstinatoFeed {
            records: self.records.texts(),
            checkouts,
        };
        if feed == self.sent {
            return None;
        }
        self.sent = feed.clone();
        Some(feed)
    }
}

/// The watch's thread: a check every `FILES_EVERY`, and at once when the
/// open folders change (sent on `open`). Ends when either channel closes.
pub fn watch(tx: &Sender<Input>, open: &Receiver<Vec<String>>, dir: Option<PathBuf>) {
    let mut w = Watch::new(dir);
    loop {
        if let Some(feed) = w.check(checkout_of)
            && tx.send(Input::Ostinato(Box::new(feed))).is_err()
        {
            return;
        }
        match open.recv_timeout(FILES_EVERY) {
            Ok(dirs) => w.open = dirs,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        // A burst of changes checks once, against the latest.
        while let Ok(dirs) = open.try_recv() {
            w.open = dirs;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("cockpit-ostinato-{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_folder_is_ostinato_home_when_set_else_under_home() {
        let home = Path::new("/Users/me");
        assert_eq!(
            records_dir(Some("/tmp/rec".into()), Some(home)),
            Some(PathBuf::from("/tmp/rec"))
        );
        let default = Some(PathBuf::from("/Users/me/.local/state/ostinato/records"));
        assert_eq!(records_dir(Some(OsString::new()), Some(home)), default);
        assert_eq!(records_dir(None, Some(home)), default);
        assert_eq!(records_dir(None, None), None);
    }

    #[test]
    fn a_record_file_names_its_project() {
        assert_eq!(
            record_project("Example__App-One.jsonl").as_deref(),
            Some("example/app-one")
        );
        assert_eq!(record_project("a__b__c.jsonl").as_deref(), Some("a/b__c"));
        assert_eq!(record_project("loose.jsonl").as_deref(), Some("loose"));
        assert_eq!(record_project("a__b.json"), None);
        assert_eq!(record_project(".a__b.jsonl"), None);
    }

    #[test]
    fn hands_on_records_and_checkouts_only_when_they_move() {
        let dir = temp("watch");
        let asked = Cell::new(0);
        let ask = |d: &str| {
            asked.set(asked.get() + 1);
            (d == "/dev/app-one").then(|| "example/app-one".to_string())
        };
        let mut w = Watch::new(Some(dir.clone()));
        w.open = vec!["/dev/app-one".into(), "/dev/feat".into()];
        assert_eq!(w.check(ask), None, "no records: nothing, no lookups");
        assert_eq!(asked.get(), 0);

        let line = "{\"v\":1}\n";
        fs::write(dir.join("example__app-one.jsonl"), line).unwrap();
        fs::write(dir.join("notes.txt"), "not a record").unwrap();
        let feed = w.check(ask).unwrap();
        assert_eq!(feed.records.len(), 1);
        assert_eq!(feed.records["example/app-one"].text, line);
        assert_eq!(
            feed.checkouts,
            BTreeMap::from([("/dev/app-one".into(), "example/app-one".into())])
        );
        assert_eq!(asked.get(), 2);

        assert_eq!(w.check(ask), None, "nothing moved");
        assert_eq!(asked.get(), 2, "each folder asked once");

        fs::write(dir.join("example__app-one.jsonl"), format!("{line}{line}")).unwrap();
        let feed = w.check(ask).unwrap();
        assert_eq!(
            feed.records["example/app-one"].text,
            format!("{line}{line}")
        );

        w.open = vec!["/dev/feat".into()];
        let feed = w.check(ask).unwrap();
        assert!(feed.checkouts.is_empty(), "its workspace closed");

        fs::remove_file(dir.join("example__app-one.jsonl")).unwrap();
        let feed = w.check(ask).unwrap();
        assert_eq!(feed, OstinatoFeed::default());
    }

    #[test]
    fn each_folder_is_looked_up_once() {
        let mut c = Checkouts::default();
        let open = vec!["/dev/a".to_string()];
        c.learn(&open, |_| Some("example/a".into()));
        assert_eq!(c.map(&open)["/dev/a"], "example/a");
        c.learn(&open, |_| None);
        assert_eq!(c.map(&open)["/dev/a"], "example/a", "cached");
        // Closed, then reopened once it has its origin: looked up again.
        let mut c = Checkouts::default();
        c.learn(&open, |_| None);
        c.learn(&[], |_| None);
        c.learn(&open, |_| Some("example/a".into()));
        assert_eq!(c.map(&open)["/dev/a"], "example/a", "forgotten on close");
    }

    #[test]
    fn a_missing_folder_is_no_records_and_no_error() {
        let mut w = Watch::new(Some(PathBuf::from("/nonexistent/ostinato/records")));
        assert_eq!(w.check(|_| None), None);
        let mut none = Watch::new(None);
        assert_eq!(none.check(|_| None), None);
    }

    /// A checkout made by hand, with no git process: `.git` and its config.
    fn checkout(root: &Path, name: &str, config: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/config"), config).unwrap();
        dir
    }

    fn origin(url: &str) -> String {
        format!("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = {url}\n")
    }

    #[test]
    fn a_main_checkout_names_its_origin_and_a_worktree_nothing() {
        let root = temp("checkouts");
        let path = |p: &Path| p.to_str().unwrap().to_string();
        for (name, url) in [
            ("ssh", "git@github.com:Example/App-One.git"),
            ("https", "https://github.com/example/app-one"),
            ("dotgit", "https://github.com/example/APP-ONE.git"),
        ] {
            let dir = checkout(&root, name, &origin(url));
            assert_eq!(
                checkout_of(&path(&dir)).as_deref(),
                Some("example/app-one"),
                "{url}"
            );
        }
        let main = checkout(&root, "main", &origin("git@github.com:example/app-one.git"));
        let sub = main.join("src/deep");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            checkout_of(&path(&sub)).as_deref(),
            Some("example/app-one"),
            "a folder inside the checkout"
        );

        let linked = root.join("linked");
        fs::create_dir_all(&linked).unwrap();
        fs::write(
            linked.join(".git"),
            "gitdir: /dev/app-one/.git/worktrees/linked\n",
        )
        .unwrap();
        assert_eq!(checkout_of(&path(&linked)), None, "a linked worktree");
        // A worktree inside the main checkout's folder is still a worktree.
        let nested = main.join("worktrees/feat");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join(".git"), "gitdir: ../../.git/worktrees/feat\n").unwrap();
        assert_eq!(checkout_of(&path(&nested)), None);

        let bare = checkout(&root, "no-origin", "[core]\n\tbare = false\n");
        assert_eq!(checkout_of(&path(&bare)), None, "no origin");
        let other = checkout(
            &root,
            "gitlab",
            &origin("https://gitlab.com/example/app-one"),
        );
        assert_eq!(checkout_of(&path(&other)), None, "not GitHub");
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(checkout_of(&path(&plain)), None);
        assert_eq!(checkout_of(&path(&root.join("gone"))), None);
    }
}
