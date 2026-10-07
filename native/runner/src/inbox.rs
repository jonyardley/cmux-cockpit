//! The answers to a sidebar core's effects, back as files. The helper
//! carries out the effects the sidebar's core asks for (effect.rs); two
//! of them answer, and each answer goes into the shared folder's inbox/
//! as one file holding the core event it is, in the JSON the core's
//! bridge reads, so the sidebar hands it to its core as it is and deletes
//! it:
//!
//! ```json
//! {"CmuxFailed": {"id": "W1"}}
//! {"PrPolled": {"directory": "/dev/cockpit", "asked": 1791229864.5, "answer": "NoBranch", "epoch": 1791229866.0}}
//! ```
//!
//! A file is named as the outbox's are, `<13 digit epoch ms>-<6 digit
//! counter>.json`, so names sort in the order written; it is written under
//! a name starting with "." and then linked into place, which fails rather
//! than replace a file already there, so a second helper writing in the
//! same millisecond takes the next number instead. Nothing waits on an
//! answer: one the sidebar has not taken within `publish::STALE` is
//! deleted.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use cockpit_core::pr_poll::PrPolled;
use serde::Serialize;

use crate::publish::name_ms;

pub const INBOX_DIR: &str = "inbox";
/// Before an answer's temp file's name, then the writer's pid.
pub const TMP: &str = ".answer-";
/// The counter's width: it wraps at a million.
const COUNTER: u32 = 1_000_000;

/// An effect's answer, as the core event that carries it: the same names
/// and fields as `cockpit_core::Event`'s.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Answer {
    /// A cmux call about this workspace was refused or ran out of time,
    /// so the sidebar's core snaps the card back.
    CmuxFailed { id: String },
    /// A directory's PR, as the core asked for it.
    PrPolled(Box<PrPolled>),
}

impl Answer {
    /// Its name, for a log line: never a branch, title or URL.
    pub fn name(&self) -> &'static str {
        match self {
            Answer::CmuxFailed { .. } => "CmuxFailed",
            Answer::PrPolled(_) => "PrPolled",
        }
    }
}

/// Writes answers into one inbox/ folder, in order.
#[derive(Debug)]
pub struct Inbox {
    dir: PathBuf,
    /// The next counter to try.
    next: u32,
    /// The time of the last answer written, so a clock stepped back never
    /// sorts a later answer first.
    last_ms: u64,
}

impl Inbox {
    pub fn new(dir: PathBuf) -> Inbox {
        Inbox {
            dir,
            next: 1,
            last_ms: 0,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Writes one answer at wall-clock `ms`, or the last answer's time if
    /// that is later; the file's path. A folder gone since is made again.
    pub fn write(&mut self, answer: &Answer, ms: u64) -> io::Result<PathBuf> {
        let bytes = serde_json::to_vec(answer).map_err(io::Error::other)?;
        let ms = ms.max(self.last_ms);
        let tmp = self
            .dir
            .join(format!("{TMP}{}-{}.tmp", std::process::id(), self.next));
        let mut wrote = fs::write(&tmp, &bytes);
        if wrote
            .as_ref()
            .is_err_and(|e| e.kind() == ErrorKind::NotFound)
        {
            wrote = fs::create_dir_all(&self.dir).and_then(|()| fs::write(&tmp, &bytes));
        }
        let placed = wrote.and_then(|()| self.place(&tmp, ms));
        let _ = fs::remove_file(&tmp);
        if placed.is_ok() {
            self.last_ms = ms;
        }
        placed
    }

    /// Deletes the answers written before `before_ms`, by their names.
    pub fn prune(&self, before_ms: u64) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let written = name
                .to_str()
                .filter(|n| n.ends_with(".json"))
                .and_then(name_ms);
            if written.is_some_and(|ms| ms < before_ms) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Links the temp file in under the first free name from the counter.
    fn place(&mut self, tmp: &Path, ms: u64) -> io::Result<PathBuf> {
        loop {
            let path = self.dir.join(format!("{ms:013}-{:06}.json", self.next));
            self.next = self.next % (COUNTER - 1) + 1;
            match fs::hard_link(tmp, &path) {
                Ok(()) => return Ok(path),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::Event;
    use cockpit_core::persist::SavedPr;
    use cockpit_core::pr_poll::{GhFailure, PollAnswer};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cockpit-inbox-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn polled(answer: PollAnswer) -> Answer {
        Answer::PrPolled(Box::new(PrPolled {
            directory: "/dev/cockpit".into(),
            asked: 1_791_229_864.5,
            answer,
            epoch: 1_791_229_866.0,
        }))
    }

    fn event_of(path: &Path) -> Event {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn each_answer_is_written_as_the_core_event_it_carries() {
        let dir = temp_dir("events");
        let mut inbox = Inbox::new(dir.clone());
        let pr: SavedPr = serde_json::from_value(serde_json::json!({
            "number": 7, "url": "https://github.com/o/r/pull/7", "status": "open",
            "branch": "feat-7", "title": "Feature 7"
        }))
        .unwrap();
        let answers = [
            Answer::CmuxFailed { id: "W1".into() },
            polled(PollAnswer::NoBranch),
            polled(PollAnswer::GitFailed),
            polled(PollAnswer::Answered {
                branch: "feat-7".into(),
                pr: Some(pr),
            }),
            polled(PollAnswer::Answered {
                branch: "feat-8".into(),
                pr: None,
            }),
            polled(PollAnswer::Failed {
                branch: "feat-9".into(),
                why: GhFailure::SignedOut,
            }),
        ];
        for a in &answers {
            let path = inbox.write(a, 1_791_229_864_123).unwrap();
            let event = event_of(&path);
            match (a, event) {
                (Answer::CmuxFailed { id }, Event::CmuxFailed { id: got }) => assert_eq!(*id, got),
                (Answer::PrPolled(want), Event::PrPolled(got)) => assert_eq!(*want, got),
                (a, e) => panic!("{} came back as {e:?}", a.name()),
            }
        }
        assert_eq!(
            fs::read_to_string(dir.join("1791229864123-000001.json")).unwrap(),
            r#"{"CmuxFailed":{"id":"W1"}}"#
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_sort_in_the_order_written_and_never_replace_a_file() {
        let dir = temp_dir("names");
        let mut inbox = Inbox::new(dir.clone());
        let failed = Answer::CmuxFailed { id: "W1".into() };
        // Another helper's answer, in the same millisecond, holds 000002.
        fs::write(dir.join("0000000001000-000002.json"), "other").unwrap();
        let a = inbox.write(&failed, 1000).unwrap();
        let b = inbox.write(&failed, 1000).unwrap();
        let c = inbox.write(&failed, 999_999).unwrap();
        let name = |p: &PathBuf| p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(
            [name(&a), name(&b), name(&c)],
            [
                "0000000001000-000001.json",
                "0000000001000-000003.json",
                "0000000999999-000004.json"
            ]
        );
        assert_eq!(
            fs::read_to_string(dir.join("0000000001000-000002.json")).unwrap(),
            "other"
        );
        let mut all: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        all.sort();
        assert_eq!(all.len(), 4, "no temp file is left: {all:?}");
        // The counter wraps past six digits back to 1.
        inbox.next = COUNTER - 1;
        let d = inbox.write(&failed, 1_000_000).unwrap();
        let e = inbox.write(&failed, 1_000_000).unwrap();
        assert_eq!(
            [name(&d), name(&e)],
            ["0000001000000-999999.json", "0000001000000-000001.json"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_it_cannot_make_is_an_error_and_leaves_nothing() {
        let dir = temp_dir("blocked");
        fs::write(dir.join("file"), "").unwrap();
        let mut inbox = Inbox::new(dir.join("file").join("inbox"));
        let failed = Answer::CmuxFailed { id: "W1".into() };
        assert!(inbox.write(&failed, 1).is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "only the file");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_gone_since_is_made_again() {
        let dir = temp_dir("gone");
        let mut inbox = Inbox::new(dir.join("inbox"));
        let failed = Answer::CmuxFailed { id: "W1".into() };
        let path = inbox.write(&failed, 1000).unwrap();
        assert!(path.starts_with(dir.join("inbox")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_clock_stepped_back_still_sorts_later_answers_last() {
        let dir = temp_dir("clock");
        let mut inbox = Inbox::new(dir.clone());
        let failed = Answer::CmuxFailed { id: "W1".into() };
        let a = inbox.write(&failed, 5000).unwrap();
        let b = inbox.write(&failed, 3000).unwrap();
        assert!(a < b, "{a:?} then {b:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prune_deletes_only_answers_written_before_the_cut() {
        let dir = temp_dir("prune");
        let mut inbox = Inbox::new(dir.clone());
        let failed = Answer::CmuxFailed { id: "W1".into() };
        let old = inbox.write(&failed, 1000).unwrap();
        let new = inbox.write(&failed, 9000).unwrap();
        fs::write(dir.join("notes.json"), "").unwrap();
        fs::write(dir.join(".answer-1-1.tmp"), "").unwrap();
        inbox.prune(5000);
        assert!(!old.exists());
        assert!(new.exists());
        assert!(dir.join("notes.json").exists());
        assert!(
            dir.join(".answer-1-1.tmp").exists(),
            "the sweep's, not prune's"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
