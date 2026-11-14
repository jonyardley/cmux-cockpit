//! Watches the Ostinato records folder (issue #390) on a thread of its
//! own, and asks git which open workspace folders are main checkouts of
//! which GitHub repo, then hands the core both (`Input::Ostinato`)
//! whenever either changed.
//!
//! - The folder is `$OSTINATO_HOME` when set and not empty, else
//!   `~/.local/state/ostinato/records/`. Only its `*.jsonl` files are
//!   records; `owner__repo.jsonl` is the project `owner/repo`.
//! - It is polled every `FILES_EVERY`, as watch.rs polls the config
//!   files: each file's size and modified time, and a file is read only
//!   when they moved. A missing folder is no records, and no error.
//! - git runs only while there is a record, once per folder (cached),
//!   with `git rev-parse` and `git remote get-url origin` there
//!   (cockpit_core::ostinato::remote), with every `GIT_` variable the
//!   runner inherited cleared, so git finds the repo from the folder
//!   alone. A folder git could not answer for (past its time limit) is
//!   asked again on the next check.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};

use cockpit_core::ostinato::remote::{REMOTE_ARGS, REV_PARSE_ARGS, checkout_repo};
use cockpit_core::ostinato::{OstinatoFeed, RecordText};

use crate::watch::{Stamp, stamp};
use crate::{COMMAND_LIMIT, FILES_EVERY, Input, pr_ask};

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

/// What git said of each folder: the repo it is the main checkout of, or
/// None.
#[derive(Debug, Default)]
pub struct Checkouts {
    known: HashMap<String, Option<String>>,
}

impl Checkouts {
    /// Asks `ask` about each folder in `open` not answered yet. An answer
    /// of None (git could not tell) leaves it to be asked again.
    pub fn learn(&mut self, open: &[String], ask: impl Fn(&str) -> Option<Option<String>>) {
        for dir in open {
            if self.known.contains_key(dir) {
                continue;
            }
            if let Some(answer) = ask(dir) {
                self.known.insert(dir.clone(), answer);
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

/// Asks git in `dir` which repo it is the main checkout of: Some(None)
/// for none (no folder, not a checkout, a linked worktree, no GitHub
/// `origin`), None when git could not answer (missing, or killed past
/// `COMMAND_LIMIT`).
pub fn ask_git(dir: &str) -> Option<Option<String>> {
    if !Path::new(dir).is_dir() {
        return Some(None);
    }
    let git = pr_ask::tool("git", &["/opt/homebrew/bin/git", "/usr/bin/git"]);
    let run = |args: &[&str]| pr_ask::ran_command(git_in(&git, dir, args), COMMAND_LIMIT);
    let rev = run(&REV_PARSE_ARGS);
    match rev.status {
        None => return None,
        Some(0) => {}
        Some(_) => return Some(None),
    }
    let remote = run(&REMOTE_ARGS);
    let url = match remote.status {
        None => return None,
        Some(0) => Some(remote.stdout),
        // No origin.
        Some(_) => None,
    };
    Some(checkout_repo(&rev.stdout, url.as_deref()))
}

/// `git` with `args` in `dir`, clear of every `GIT_` variable the runner
/// inherited: one such as `GIT_DIR`, which a git hook sets, would point
/// it at another repo whatever the folder.
pub fn git_in(git: &str, dir: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(git);
    cmd.args(args).current_dir(dir);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(name);
        }
    }
    cmd
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
    /// git is asked only while there is a record.
    pub fn check(&mut self, ask: impl Fn(&str) -> Option<Option<String>>) -> Option<OstinatoFeed> {
        let moved = self.records.check();
        let checkouts = if self.records.is_empty() {
            BTreeMap::new()
        } else {
            self.checkouts.learn(&self.open, ask);
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
        if let Some(feed) = w.check(ask_git)
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
            Some((d == "/dev/app-one").then(|| "example/app-one".to_string()))
        };
        let mut w = Watch::new(Some(dir.clone()));
        w.open = vec!["/dev/app-one".into(), "/dev/feat".into()];
        assert_eq!(w.check(ask), None, "no records: nothing, no git");
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
    fn a_folder_git_could_not_answer_for_is_asked_again() {
        let mut c = Checkouts::default();
        let open = vec!["/dev/a".to_string()];
        c.learn(&open, |_| None);
        assert!(c.map(&open).is_empty());
        c.learn(&open, |_| Some(Some("example/a".into())));
        assert_eq!(c.map(&open)["/dev/a"], "example/a");
        c.learn(&open, |_| Some(None));
        assert_eq!(c.map(&open)["/dev/a"], "example/a", "cached");
    }

    #[test]
    fn a_missing_folder_is_no_records_and_no_error() {
        let mut w = Watch::new(Some(PathBuf::from("/nonexistent/ostinato/records")));
        assert_eq!(w.check(|_| Some(None)), None);
        let mut none = Watch::new(None);
        assert_eq!(none.check(|_| Some(None)), None);
    }

    /// git in a folder of the test's own, never the repo the tests run
    /// in: clear of the variables a git hook exports, and stopped from
    /// looking above the test's folder.
    fn git_ok(dir: &Path, root: &Path, args: &[&str]) -> bool {
        let mut cmd = git_in("git", dir.to_str().unwrap(), args);
        cmd.env("GIT_CEILING_DIRECTORIES", root);
        cmd.output().is_ok_and(|o| o.status.success())
    }

    fn git(dir: &Path, root: &Path, args: &[&str]) {
        assert!(git_ok(dir, root, args), "git {args:?}");
    }

    #[test]
    fn git_names_a_main_checkouts_repo_and_not_a_worktrees() {
        let root = temp("git");
        let main = root.join("main");
        fs::create_dir_all(&main).unwrap();
        // A tripwire: were git to see any repo from here, init would
        // change that one, so stop before it.
        assert!(
            !git_ok(&main, &root, &["rev-parse", "--git-dir"]),
            "the test folder is inside a repo"
        );
        git(&main, &root, &["init", "-q"]);
        let main_dir = main.to_str().unwrap();
        assert_eq!(ask_git(main_dir), Some(None), "no origin");
        git(
            &main,
            &root,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:Example/App-One.git",
            ],
        );
        assert_eq!(ask_git(main_dir), Some(Some("example/app-one".to_string())));
        git(
            &main,
            &root,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--no-verify",
                "--allow-empty",
                "-m",
                "first",
            ],
        );
        let linked = root.join("linked");
        git(
            &main,
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat",
                linked.to_str().unwrap(),
            ],
        );
        assert_eq!(ask_git(linked.to_str().unwrap()), Some(None), "a worktree");
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(ask_git(plain.to_str().unwrap()), Some(None));
        assert_eq!(ask_git(root.join("gone").to_str().unwrap()), Some(None));
    }
}
