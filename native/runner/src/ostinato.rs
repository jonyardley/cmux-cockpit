//! Watches the Ostinato records folder (issue #390) on a thread of its
//! own, and finds which open workspace folders are in checkouts of
//! which GitHub repo, then hands the core both (`Input::Ostinato`)
//! whenever either changed.
//!
//! - The folder is `$OSTINATO_HOME` when set and not empty, else
//!   `~/.local/state/ostinato/records/`. Only its `*.jsonl` files are
//!   records; `owner__repo.jsonl` is the project `owner/repo`.
//! - It is polled every `FILES_EVERY`, as watch.rs polls the config
//!   files: each file's size and modified time, and a file is read only
//!   when they moved. A missing folder is no records, and no error.
//! - Only what a card reads of a record is handed on, cut at the wall
//!   clock of the read (cockpit_core::ostinato::bound): its latest run
//!   and the day's spend, not the whole file, which only grows.
//! - Only while there is a record, each open folder is looked up: once
//!   found in a checkout it stays cached until its workspace closes, and
//!   one found in none is looked up again on each check. The nearest
//!   `.git` at or above it, a directory for a main checkout, whose
//!   `config` names its `origin` (cockpit_core::ostinato::remote). No
//!   git process runs, since git run in a folder obeys that repo's own
//!   config, which can run anything (`core.fsmonitor`, a pager). A
//!   `.git` file is a linked worktree, which takes its main checkout's
//!   repo, so a workspace whose terminal moves between the two keeps the
//!   card; the feed marks it a worktree, so the core prefers a workspace
//!   on the main checkout itself to carry the run. Each file read on the
//!   way is a regular file under a size cap.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};

use cockpit_core::ostinato::bound::bound;
use cockpit_core::ostinato::remote::checkout_repo;
use cockpit_core::ostinato::{OstinatoFeed, RecordText};

use crate::watch::{Stamp, stamp};
use crate::{FILES_EVERY, Input, now_epoch};

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
        // Through a link too, as `stamp` and `fs::read` follow one.
        .filter(|e| fs::metadata(e.path()).is_ok_and(|m| m.is_file()))
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
        self.check_at(now_epoch())
    }

    /// `check`, cutting each record read to what its card reads at epoch
    /// `clock` and after.
    fn check_at(&mut self, clock: f64) -> bool {
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
                let text = bound(&RecordText::from_bytes(&bytes), clock);
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

/// What a folder was found to be in: its GitHub repo, and whether it
/// is in a linked worktree of it rather than the main checkout itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    pub repo: String,
    pub worktree: bool,
}

/// Each folder looked up: the repo it is in the main checkout or a
/// linked worktree of, or None.
#[derive(Debug, Default)]
pub struct Checkouts {
    known: HashMap<String, Option<Checkout>>,
}

impl Checkouts {
    /// Looks up each folder in `open` with `look`, unless it was found
    /// in a checkout already, and forgets those no longer open. A folder
    /// found in none is looked up again on each check, so one cloned
    /// into or given its origin after it opened is found then; one found
    /// stays cached until it closes, so reopening it looks again.
    pub fn learn(&mut self, open: &[String], look: impl Fn(&str) -> Option<Checkout>) {
        self.known.retain(|dir, _| open.contains(dir));
        for dir in open {
            if !matches!(self.known.get(dir), Some(Some(_))) {
                self.known.insert(dir.clone(), look(dir));
            }
        }
    }

    /// The folders in `open` in a main checkout or one of its linked
    /// worktrees, to their repos.
    pub fn map(&self, open: &[String]) -> BTreeMap<String, String> {
        self.found(open)
            .map(|(dir, c)| (dir.clone(), c.repo.clone()))
            .collect()
    }

    /// The folders in `open` that are in a linked worktree.
    pub fn worktrees(&self, open: &[String]) -> BTreeSet<String> {
        self.found(open)
            .filter(|(_, c)| c.worktree)
            .map(|(dir, _)| dir.clone())
            .collect()
    }

    fn found<'a>(&'a self, open: &'a [String]) -> impl Iterator<Item = (&'a String, &'a Checkout)> {
        open.iter()
            .filter_map(|dir| Some((dir, self.known.get(dir)?.as_ref()?)))
    }
}

/// The most of a worktree pointer file (`.git` file, `commondir`,
/// `gitdir`) the chain reads: a pointer is one line, so anything bigger
/// is no pointer of ours.
const POINTER_CAP: u64 = 64 * 1024;

/// The most of a repo's config the chain reads: a long-lived repo's
/// config can grow well past a pointer's size, so it gets more room.
const CONFIG_CAP: u64 = 1024 * 1024;

/// The text of a worktree pointer file at `path` when it is a regular
/// file, not a link, of at most `POINTER_CAP` bytes; None otherwise.
fn read_pointer(path: &Path) -> Option<String> {
    read_capped(path, &fs::symlink_metadata(path).ok()?, POINTER_CAP)
}

/// The text of the config at `path` when it is, or links to, a regular
/// file of at most `CONFIG_CAP` bytes; None otherwise. Links are
/// followed, since dotfile managers link a repo's config.
fn read_config(path: &Path) -> Option<String> {
    read_capped(path, &fs::metadata(path).ok()?, CONFIG_CAP)
}

/// The text of `path`, whose metadata is `meta`, when that is a regular
/// file of at most `cap` bytes; None otherwise, so a FIFO cannot block
/// the watch thread and a huge file cannot bloat it. The read is
/// bounded too, in case the file grows after `meta` was taken.
fn read_capped(path: &Path, meta: &fs::Metadata, cap: u64) -> Option<String> {
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(cap + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= cap).then_some(text)
}

/// The config file of the repo `dir` is in, and whether `dir` is in a
/// linked worktree: the nearest `.git` at or above it, its `config` when
/// that is a directory (a main checkout), or its main checkout's
/// (`worktree_config`) when it is a file. None when there is none, or
/// the file is no linked worktree's (a submodule's).
fn main_config(dir: &Path) -> Option<(PathBuf, bool)> {
    for folder in dir.ancestors() {
        let git = folder.join(".git");
        match fs::metadata(&git) {
            Ok(m) if m.is_dir() => return Some((git.join("config"), false)),
            Ok(_) => return worktree_config(&git).map(|c| (c, true)),
            Err(_) => {}
        }
    }
    None
}

/// The main checkout's config file for the linked worktree whose `.git`
/// file is `git`. That file names the worktree's own git folder
/// (`gitdir: <path>`, relative to the worktree or absolute), which must
/// be `<common>/worktrees/<name>`, must name this `.git` file back in its
/// own `gitdir` file (so a copied worktree matches nothing), and whose
/// `commondir` must name `<common>`, the main checkout's `.git`. A
/// submodule's git folder has no `commondir`, so it matches nothing.
fn worktree_config(git: &Path) -> Option<PathBuf> {
    let folder = git.parent()?;
    let text = read_pointer(git)?;
    let named = folder.join(text.lines().next()?.strip_prefix("gitdir:")?.trim());
    let own = fs::canonicalize(named).ok()?;
    let back = read_pointer(&own.join("gitdir"))?;
    let back = fs::canonicalize(own.join(back.lines().next()?.trim())).ok()?;
    if back != fs::canonicalize(git).ok()? {
        return None;
    }
    let common = read_pointer(&own.join("commondir"))?;
    let common = fs::canonicalize(own.join(common.trim())).ok()?;
    let parent = own.parent()?;
    if parent.file_name()? != "worktrees" || parent.parent()? != common {
        return None;
    }
    Some(common.join("config"))
}

/// The GitHub repo `dir` is in the main checkout or a linked worktree
/// of, read from the main checkout's `.git/config` with no git process;
/// None for none.
pub fn checkout_of(dir: &str) -> Option<Checkout> {
    let (config, worktree) = main_config(Path::new(dir))?;
    let repo = checkout_repo(&read_config(&config)?)?;
    Some(Checkout { repo, worktree })
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
    pub fn check(&mut self, look: impl Fn(&str) -> Option<Checkout>) -> Option<OstinatoFeed> {
        let moved = self.records.check();
        let (checkouts, worktrees) = if self.records.is_empty() {
            (BTreeMap::new(), BTreeSet::new())
        } else {
            self.checkouts.learn(&self.open, look);
            (
                self.checkouts.map(&self.open),
                self.checkouts.worktrees(&self.open),
            )
        };
        if !moved && checkouts == self.sent.checkouts && worktrees == self.sent.worktrees {
            return None;
        }
        let feed = OstinatoFeed {
            records: self.records.texts(),
            checkouts,
            worktrees,
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
            (d == "/dev/app-one").then(|| found("example/app-one", false))
        };
        let mut w = Watch::new(Some(dir.clone()));
        w.open = vec!["/dev/app-one".into(), "/dev/feat".into()];
        assert_eq!(w.check(ask), None, "no records: nothing, no lookups");
        assert_eq!(asked.get(), 0);

        // A line the reader skips but reads past, so a second one is sent.
        let line =
            "{\"v\":1,\"at\":\"2026-11-13T14:00:00Z\",\"run\":\"r\",\"event\":\"board_synced\"}\n";
        fs::write(dir.join("example__app-one.jsonl"), line).unwrap();
        fs::write(dir.join("notes.txt"), "not a record").unwrap();
        fs::create_dir_all(dir.join("folder.jsonl")).unwrap();
        let feed = w.check(ask).unwrap();
        assert_eq!(feed.records.len(), 1);
        assert_eq!(feed.records["example/app-one"].text, line);
        assert_eq!(
            feed.checkouts,
            BTreeMap::from([("/dev/app-one".into(), "example/app-one".into())])
        );
        assert!(feed.worktrees.is_empty());
        assert_eq!(asked.get(), 2);

        assert_eq!(w.check(ask), None, "nothing moved");
        assert_eq!(asked.get(), 3, "the found folder is not asked again");

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

    fn found(repo: &str, worktree: bool) -> Checkout {
        Checkout {
            repo: repo.into(),
            worktree,
        }
    }

    #[test]
    fn a_found_folder_is_looked_up_once_and_one_not_found_again() {
        let mut c = Checkouts::default();
        let open = vec!["/dev/a".to_string()];
        c.learn(&open, |_| Some(found("example/a", false)));
        assert_eq!(c.map(&open)["/dev/a"], "example/a");
        c.learn(&open, |_| None);
        assert_eq!(c.map(&open)["/dev/a"], "example/a", "cached");
        // Not found while open, then given its `.git`: found on the next
        // check, with no need to close it.
        let mut c = Checkouts::default();
        c.learn(&open, |_| None);
        assert!(c.map(&open).is_empty());
        c.learn(&open, |_| Some(found("example/a", true)));
        assert_eq!(c.map(&open)["/dev/a"], "example/a", "looked up again");
        assert_eq!(c.worktrees(&open), BTreeSet::from(["/dev/a".to_string()]));
        // Closed, then reopened: looked up again.
        c.learn(&[], |_| None);
        c.learn(&open, |_| Some(found("example/b", false)));
        assert_eq!(c.map(&open)["/dev/a"], "example/b", "forgotten on close");
        assert!(c.worktrees(&open).is_empty());
    }

    #[test]
    fn a_linked_record_is_read_through_its_link() {
        let dir = temp("linked-record");
        let real = temp("linked-record-source").join("kept.jsonl");
        fs::write(&real, "{\"v\":1}\n").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("example__app-one.jsonl")).unwrap();
        let mut records = Records::new(Some(dir));
        assert!(records.check());
        assert!(records.texts().contains_key("example/app-one"));
    }

    #[test]
    fn a_long_record_is_handed_on_cut_to_its_latest_run() {
        let dir = temp("bounded");
        let run = |day: u32| {
            format!(
                "{{\"v\":1,\"at\":\"2026-11-{day:02}T08:00:00Z\",\"run\":\"r-{day}\",\"event\":\"run_started\",\"project\":\"example/app-one\"}}\n"
            )
        };
        let whole: String = (1..=9).map(run).collect();
        fs::write(dir.join("example__app-one.jsonl"), &whole).unwrap();
        let mut records = Records::new(Some(dir));
        let now = cockpit_core::time::iso_epoch("2026-11-09T09:00:00Z").unwrap();
        assert!(records.check_at(now));
        let sent = &records.texts()["example/app-one"];
        assert_eq!(sent.text, run(9));
        assert_eq!(sent.numbers, [9], "the line keeps its number in the file");
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

    fn path(p: &Path) -> String {
        p.to_str().unwrap().to_string()
    }

    /// The repo `dir` is in a checkout of, and whether in a worktree.
    fn look(dir: &Path) -> Option<(String, bool)> {
        checkout_of(&path(dir)).map(|c| (c.repo, c.worktree))
    }

    fn repo(name: &str) -> Option<(String, bool)> {
        Some((name.to_string(), false))
    }

    fn in_worktree(name: &str) -> Option<(String, bool)> {
        Some((name.to_string(), true))
    }

    /// A linked worktree at `at` of the main checkout `main`, laid out
    /// by hand as git lays it out: `at/.git` names `main/.git/worktrees/
    /// <name>`, whose `commondir` names the main `.git` and whose
    /// `gitdir` names `at/.git` back.
    fn worktree(main: &Path, name: &str, at: &Path) -> PathBuf {
        let own = main.join(".git/worktrees").join(name);
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("commondir"), "../..\n").unwrap();
        fs::write(own.join("gitdir"), format!("{}\n", path(&at.join(".git")))).unwrap();
        fs::create_dir_all(at).unwrap();
        fs::write(at.join(".git"), format!("gitdir: {}\n", path(&own))).unwrap();
        own
    }

    #[test]
    fn a_checkout_or_its_worktree_names_its_origin() {
        let root = temp("checkouts");
        for (name, url) in [
            ("ssh", "git@github.com:Example/App-One.git"),
            ("https", "https://github.com/example/app-one"),
            ("dotgit", "https://github.com/example/APP-ONE.git"),
        ] {
            let dir = checkout(&root, name, &origin(url));
            assert_eq!(look(&dir), repo("example/app-one"), "{url}");
        }
        let main = checkout(&root, "main", &origin("git@github.com:example/app-one.git"));
        let sub = main.join("src/deep");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(look(&sub), repo("example/app-one"), "inside the checkout");

        let linked = root.join("main-worktrees/linked");
        worktree(&main, "linked", &linked);
        fs::create_dir_all(linked.join("src")).unwrap();
        assert_eq!(look(&linked), in_worktree("example/app-one"));
        assert_eq!(
            look(&linked.join("src")),
            in_worktree("example/app-one"),
            "a folder inside a linked worktree"
        );
        // A relative `gitdir`, inside the main checkout's folder, and an
        // absolute `commondir`.
        let nested = main.join("worktrees/feat");
        let feat = worktree(&main, "feat", &nested);
        fs::write(feat.join("commondir"), path(&main.join(".git"))).unwrap();
        fs::write(nested.join(".git"), "gitdir: ../../.git/worktrees/feat\n").unwrap();
        assert_eq!(look(&nested), in_worktree("example/app-one"));

        // A submodule's git folder has no `commondir`; a gone one, nothing.
        let module = main.join(".git/modules/lib");
        fs::create_dir_all(&module).unwrap();
        fs::write(
            module.join("config"),
            origin("https://github.com/example/lib"),
        )
        .unwrap();
        let sub_dir = main.join("lib");
        fs::create_dir_all(&sub_dir).unwrap();
        fs::write(sub_dir.join(".git"), "gitdir: ../.git/modules/lib\n").unwrap();
        assert_eq!(look(&sub_dir), None, "a submodule");
        let gone = root.join("gone");
        fs::create_dir_all(&gone).unwrap();
        fs::write(gone.join(".git"), "gitdir: /nowhere/.git/worktrees/gone\n").unwrap();
        assert_eq!(look(&gone), None, "a removed worktree");

        let bare = checkout(&root, "no-origin", "[core]\n\tbare = false\n");
        assert_eq!(look(&bare), None, "no origin");
        let other = checkout(
            &root,
            "gitlab",
            &origin("https://gitlab.com/example/app-one"),
        );
        assert_eq!(look(&other), None, "not GitHub");
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(look(&plain), None);
    }

    #[test]
    fn a_copied_worktree_whose_git_folder_names_another_matches_nothing() {
        let root = temp("copied");
        let main = checkout(&root, "main", &origin("git@github.com:example/app-one.git"));
        let real = root.join("real");
        worktree(&main, "real", &real);
        assert_eq!(look(&real), in_worktree("example/app-one"));
        // A copy of the worktree folder, `.git` file and all: its git
        // folder's `gitdir` still names the original.
        let copy = root.join("copy");
        fs::create_dir_all(&copy).unwrap();
        fs::copy(real.join(".git"), copy.join(".git")).unwrap();
        assert_eq!(look(&copy), None, "a stale copy");
        // A git folder whose `gitdir` file is missing matches nothing.
        let own = main.join(".git/worktrees/real");
        fs::remove_file(own.join("gitdir")).unwrap();
        assert_eq!(look(&real), None, "no back pointer");
    }

    #[test]
    fn a_git_file_pointing_outside_a_worktrees_folder_matches_nothing() {
        let root = temp("outside");
        let main = checkout(&root, "main", &origin("git@github.com:example/app-one.git"));
        // A git folder elsewhere on disk, with a `commondir` naming the
        // main `.git` and a `gitdir` naming this `.git` back: not under
        // `<common>/worktrees/`, so not a worktree of it.
        let stray = root.join("stray/own");
        fs::create_dir_all(&stray).unwrap();
        fs::write(stray.join("commondir"), path(&main.join(".git"))).unwrap();
        let at = root.join("at");
        fs::create_dir_all(&at).unwrap();
        fs::write(stray.join("gitdir"), path(&at.join(".git"))).unwrap();
        fs::write(at.join(".git"), format!("gitdir: {}\n", path(&stray))).unwrap();
        assert_eq!(look(&at), None, "not under worktrees");
        // Under some `worktrees` folder, but not the common one's.
        let other = root.join("other/.git/worktrees/own");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("commondir"), path(&main.join(".git"))).unwrap();
        fs::write(other.join("gitdir"), path(&at.join(".git"))).unwrap();
        fs::write(at.join(".git"), format!("gitdir: {}\n", path(&other))).unwrap();
        assert_eq!(look(&at), None, "another folder's worktrees");
    }

    #[test]
    fn a_git_file_that_is_too_big_or_no_regular_file_is_not_read() {
        let root = temp("bounded-git");
        let main = checkout(&root, "main", &origin("git@github.com:example/app-one.git"));
        let linked = root.join("linked");
        let own = worktree(&main, "linked", &linked);
        assert_eq!(look(&linked), in_worktree("example/app-one"));

        // A config just over the pointer cap still matches; one over the
        // config cap does not.
        let config = |extra: u64| {
            format!(
                "{}#{}\n",
                origin("git@github.com:example/app-one.git"),
                "x".repeat(extra as usize)
            )
        };
        fs::write(main.join(".git/config"), config(POINTER_CAP)).unwrap();
        assert_eq!(look(&main), repo("example/app-one"), "a config over 64 KiB");
        assert_eq!(look(&linked), in_worktree("example/app-one"));
        fs::write(main.join(".git/config"), config(CONFIG_CAP)).unwrap();
        assert_eq!(look(&main), None, "a main checkout's config");
        assert_eq!(look(&linked), None, "through a worktree");
        fs::write(main.join(".git/config"), config(1000)).unwrap();
        assert_eq!(look(&main), repo("example/app-one"));

        // A `.git` file over the pointer cap.
        let pointer = fs::read_to_string(linked.join(".git")).unwrap();
        let padded = format!("{pointer}{}\n", "x".repeat(POINTER_CAP as usize));
        fs::write(linked.join(".git"), padded).unwrap();
        assert_eq!(look(&linked), None, "a big `.git` file");
        fs::write(linked.join(".git"), pointer).unwrap();
        assert_eq!(look(&linked), in_worktree("example/app-one"));

        // A FIFO where `commondir` should be: refused, never opened, so
        // the check does not block.
        fs::remove_file(own.join("commondir")).unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(own.join("commondir"))
            .status()
            .unwrap();
        assert!(made.success());
        assert_eq!(look(&linked), None, "a FIFO");
        // A folder where the config should be.
        fs::remove_file(main.join(".git/config")).unwrap();
        fs::create_dir_all(main.join(".git/config")).unwrap();
        assert_eq!(look(&main), None, "a folder");
        // A link where the `.git` file should be.
        let link = root.join("link");
        fs::create_dir_all(&link).unwrap();
        std::os::unix::fs::symlink(linked.join(".git"), link.join(".git")).unwrap();
        assert_eq!(look(&link), None, "a linked `.git` file");
    }

    #[test]
    fn a_linked_config_is_read_through_its_link_and_a_fifo_config_is_not() {
        let root = temp("linked-config");
        let main = checkout(&root, "main", "");
        let linked = root.join("linked");
        worktree(&main, "linked", &linked);
        // A dotfile manager's link where the config should be.
        let real = root.join("dotfiles/config");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, origin("git@github.com:example/app-one.git")).unwrap();
        fs::remove_file(main.join(".git/config")).unwrap();
        std::os::unix::fs::symlink(&real, main.join(".git/config")).unwrap();
        assert_eq!(look(&main), repo("example/app-one"), "a linked config");
        assert_eq!(look(&linked), in_worktree("example/app-one"));

        // A FIFO where the config should be: refused, never opened.
        fs::remove_file(main.join(".git/config")).unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(main.join(".git/config"))
            .status()
            .unwrap();
        assert!(made.success());
        assert_eq!(look(&main), None, "a FIFO config");
        assert_eq!(look(&linked), None, "a FIFO config through a worktree");
    }
}
