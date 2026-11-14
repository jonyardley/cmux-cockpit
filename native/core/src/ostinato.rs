//! Ostinato runs on their workspace's card (issue #390). The Ostinato
//! kit (jonyardley/ostinato) writes a run record for each project, one
//! JSON line per event of an unattended run; the runner watches the
//! records folder and hands the core each record's text, with which
//! folders are main checkouts of which GitHub repo (`Event::Ostinato`).
//! The core reads each record once, when its text changes (line.rs), and
//! works out where its latest run stands at the frame's clock (run.rs).
//!
//! A record's card is the workspace open on its project's main checkout
//! (remote.rs): the record's `owner/repo`, from its latest `run_started`
//! or else its file name, matched to the folder's GitHub `origin`.
//!
//! The runner hands on only what a card reads of each record (bound.rs).
//! The card's words and tokens come from card.rs, and a parked attempt
//! waits on Jon in Needs you (wait.rs).

pub mod bound;
pub mod card;
pub mod line;
pub mod remote;
pub mod run;
pub mod wait;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::data::{Data, Workspace};
use crate::home::trim_slash;
use crate::session::Session;
use crate::time::now_epoch;

pub use line::{Broken, RecordError, RecordText};
pub use run::RunState;

use line::{Event, Heard, Line, read};
use run::{Share, run_state, shares};

/// What the runner hands the core: every record in the folder, and the
/// folders open in cmux that are main checkouts of a GitHub repo.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OstinatoFeed {
    /// Each record's text by its file's project, `owner/repo` in lower
    /// case (`owner__repo.jsonl`).
    #[serde(default)]
    pub records: BTreeMap<String, RecordText>,
    /// Each main checkout's folder to its GitHub `owner/repo`, in lower
    /// case.
    #[serde(default)]
    pub checkouts: BTreeMap<String, String>,
}

/// One record as read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Record {
    /// The text it was read from, so an unchanged one is not read again.
    text: RecordText,
    lines: Vec<Line>,
    /// Unknown events' times and runs: skipped, but their run was heard.
    heard: Vec<Heard>,
    error: Option<RecordError>,
    shares: Vec<Share>,
    /// The project it is about, lower case: the latest `run_started`'s,
    /// else the file's.
    project: String,
}

impl Record {
    /// Reads a record whose file names `file_project`.
    pub fn read(file_project: &str, text: RecordText) -> Record {
        let read = read(&text);
        let started = read.lines.iter().rev().find_map(|l| match &l.event {
            Event::RunStarted { project, .. } => Some(project.as_str()),
            _ => None,
        });
        let project = started.unwrap_or(file_project).to_ascii_lowercase();
        Record {
            shares: shares(&read.lines),
            lines: read.lines,
            heard: read.heard,
            error: read.error,
            project,
            text,
        }
    }

    /// Where it stands at epoch `now`.
    pub fn state(&self, now: f64) -> RecordState {
        RecordState {
            run: run_state(&self.lines, &self.heard, &self.shares, now),
            error: self.error.clone(),
        }
    }
}

/// What a card reads of a record: where its latest run stands, from the
/// lines read, and the line that stopped the read, if one did.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordState {
    /// None when no line was read.
    pub run: Option<RunState>,
    pub error: Option<RecordError>,
}

/// The records and checkouts the core last heard of.
#[derive(Debug, Clone, Default)]
pub struct Ostinato {
    /// By file project, as the feed keys them.
    records: BTreeMap<String, Record>,
    checkouts: BTreeMap<String, String>,
}

impl Ostinato {
    /// Takes a new feed, reading only the records whose text changed.
    pub fn take(&mut self, feed: OstinatoFeed) {
        let mut old = std::mem::take(&mut self.records);
        for (key, text) in feed.records {
            let record = match old.remove(&key) {
                Some(r) if r.text == text => r,
                _ => Record::read(&key, text),
            };
            self.records.insert(key, record);
        }
        self.checkouts = feed
            .checkouts
            .into_iter()
            .map(|(dir, repo)| (trim_slash(&dir).to_string(), repo))
            .collect();
    }

    /// The record whose card `directory`, a workspace's folder, holds.
    /// When two records are about its repo (one file left from before a
    /// rename, say), the one with the newest line.
    pub fn record_for(&self, directory: &str) -> Option<&Record> {
        let repo = self.checkouts.get(trim_slash(directory))?;
        let newest = |r: &Record| r.lines.last().map_or(f64::MIN, |l| l.at);
        self.records
            .values()
            .filter(|r| r.project.eq_ignore_ascii_case(repo))
            .max_by(|a, b| newest(a).total_cmp(&newest(b)))
    }
}

impl Ostinato {
    /// The repo the folder `directory` is the main checkout of (or a
    /// folder inside it), lower case; None for any other folder.
    fn repo_of(&self, directory: &str) -> Option<&str> {
        self.checkouts
            .get(trim_slash(directory))
            .map(String::as_str)
    }
}

impl Session {
    /// Where the Ostinato run on `w`'s card stands at the frame's clock;
    /// None when no record is about the repo it is the main checkout of.
    /// One card shows a record: the first in tab order of the workspaces
    /// in that checkout, so two open there never both draw the run or
    /// both wait on Jon for one park.
    pub fn ostinato_run(&self, data: &Data, w: &Workspace) -> Option<RecordState> {
        let directory = w.directory.as_deref()?;
        let repo = self.ostinato.repo_of(directory)?;
        let first = data.workspace_list().iter().find(|other| {
            other
                .directory
                .as_deref()
                .and_then(|d| self.ostinato.repo_of(d))
                .is_some_and(|r| r.eq_ignore_ascii_case(repo))
        })?;
        if first.id != w.id {
            return None;
        }
        let record = self.ostinato.record_for(directory)?;
        Some(record.state(now_epoch(data)))
    }
}

#[cfg(test)]
mod tests {
    use super::line::Outcome;
    use super::run::{Attempt, AttemptEnd, Caps, Cost, DraftMade, Park, Phase, Stage, StageMark};
    use super::*;
    use crate::time::iso_epoch;

    const ONE_ISSUE: &str = include_str!("../../../test/golden/ostinato/one-issue.jsonl");
    const PARKED: &str = include_str!("../../../test/golden/ostinato/parked-then-picked.jsonl");
    const TEAM: &str = include_str!("../../../test/golden/ostinato/standing-team.jsonl");
    const TORN: &str = include_str!("../../../test/golden/ostinato/torn-last-line.jsonl");

    fn at(s: &str) -> f64 {
        iso_epoch(s).unwrap()
    }

    fn record(text: &str) -> Record {
        Record::read("example/x", RecordText::from_bytes(text.as_bytes()))
    }

    fn state(text: &str, now: &str) -> RunState {
        let r = record(text).state(at(now));
        assert_eq!(r.error, None);
        r.run.unwrap()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn mark(stage: Stage, when: &str) -> Option<StageMark> {
        Some(StageMark {
            stage,
            at: at(when),
        })
    }

    #[test]
    fn the_one_issue_record_ends_with_its_draft_and_cost() {
        let s = state(ONE_ISSUE, "2026-11-13T15:00:00Z");
        assert_eq!(s.run, "r-1422");
        assert_eq!(s.project.as_deref(), Some("example/app-one"));
        assert_eq!(
            s.caps,
            Caps {
                issues: Some(3.0),
                session_hours: Some(3.0),
                spend_24h_usd: Some(150.0),
            }
        );
        assert_eq!(s.picked, 1);
        assert_eq!(
            s.current,
            Some(Attempt {
                item: "app-one#2806".into(),
                url: Some("https://github.com/example/app-one/issues/2806".into()),
                attempt: 1,
                started: at("2026-11-13T14:22:47Z"),
                last_stage: mark(Stage::Draft, "2026-11-13T14:39:48Z"),
                steps: 5,
                ended: Some(AttemptEnd {
                    outcome: Outcome::Draft,
                    at: at("2026-11-13T14:40:05Z"),
                }),
            })
        );
        assert_eq!(
            s.phase,
            Phase::Ended {
                at: at("2026-11-13T14:40:06Z"),
                silent: false
            }
        );
        assert_eq!(s.length, Some(17.0 * 60.0 + 36.0));
        assert_eq!(
            s.drafts,
            [DraftMade {
                item: "app-one#2806".into(),
                pr: "app-one#2848".into()
            }]
        );
        assert!(s.parks.is_empty());
        assert!(close(s.cost.usd, 11.42) && !s.cost.unknown);
        assert!(close(s.spend_24h.usd, 11.42) && !s.spend_24h.unknown);
    }

    #[test]
    fn mid_run_the_one_issue_record_shows_its_stage_and_attempt_clock() {
        let cut: Vec<&str> = ONE_ISSUE.lines().take(5).collect();
        let s = state(&format!("{}\n", cut.join("\n")), "2026-11-13T14:40:00Z");
        assert_eq!(s.phase, Phase::Running);
        let current = s.current.unwrap();
        assert_eq!(current.ended, None);
        assert_eq!(current.started, at("2026-11-13T14:22:47Z"));
        assert_eq!(
            current.last_stage,
            mark(Stage::Reviewed, "2026-11-13T14:37:25Z")
        );
        assert_eq!((s.picked, s.caps.issues), (1, Some(3.0)));
        assert_eq!(s.length, None);
        assert_eq!(s.cost, Cost::default());
    }

    #[test]
    fn a_parked_item_picked_again_reads_from_the_latest_run() {
        let s = state(PARKED, "2026-11-11T10:00:00Z");
        assert_eq!(s.run, "r-1111");
        assert_eq!(s.picked, 2);
        let current = s.current.unwrap();
        assert_eq!(
            (current.item.as_str(), current.attempt),
            ("notes-app#42", 2)
        );
        assert_eq!(
            current.last_stage,
            mark(Stage::Draft, "2026-11-11T09:45:00Z")
        );
        let prs: Vec<&str> = s.drafts.iter().map(|d| d.pr.as_str()).collect();
        assert_eq!(prs, ["notes-app#51", "notes-app#50"]);
        assert!(s.parks.is_empty(), "the park was the run before");
        // No session_costs: each attempt's cost_usd.
        assert!(close(s.cost.usd, 9.8 + 4.05) && !s.cost.unknown);
        assert_eq!(s.length, Some(106.0 * 60.0));
        // The day to 10:00 holds the first run's second attempt, not its first.
        assert!(close(s.spend_24h.usd, 14.25 + 9.8 + 4.05));

        let first = state(
            &PARKED.lines().take(5).collect::<Vec<_>>().join("\n"),
            "2026-11-10T09:32:00Z",
        );
        assert_eq!(
            first.parks,
            [Park {
                item: "notes-app#41".into(),
                attempt: Some(1),
                reason: "permission_prompt".into(),
                question:
                    "May the session run the database migration script, or should it stop at the plan?"
                        .into(),
                at: at("2026-11-10T09:31:10Z"),
            }]
        );
        assert_eq!(first.phase, Phase::Running);
    }

    #[test]
    fn a_standing_team_counts_each_shared_session_once() {
        let r = record(TEAM);
        let each: Vec<f64> = r.shares.iter().map(|s| s.usd).collect();
        let want = [21.6, 9.9, 14.3, 8.45];
        assert_eq!(each.len(), want.len());
        assert!(each.iter().zip(want).all(|(a, b)| close(*a, b)), "{each:?}");

        let s = state(TEAM, "2026-11-11T19:00:00Z");
        assert!(close(s.cost.usd, 54.25), "not 60.1: {}", s.cost.usd);
        assert!(close(s.spend_24h.usd, 54.25));
        // A day that starts between the first two attempts: the second's
        // share, not its whole figure.
        let later = state(TEAM, "2026-11-12T10:47:00Z");
        assert!(close(later.spend_24h.usd, 32.65), "{}", later.spend_24h.usd);

        assert_eq!(s.caps, Caps::default(), "caps the card does not read");
        assert_eq!(s.picked, 3, "#102 twice counts once");
        let current = s.current.unwrap();
        assert_eq!(
            (current.item.as_str(), current.attempt),
            ("inbox-demo#102", 2)
        );
        let parked: Vec<(&str, &str)> = s
            .parks
            .iter()
            .map(|p| (p.item.as_str(), p.reason.as_str()))
            .collect();
        assert_eq!(parked, [("inbox-demo#102", "needs_decision")]);
        assert_eq!(s.drafts.len(), 3);
        assert_eq!(s.length, Some(9.0 * 3600.0));
    }

    #[test]
    fn overlapping_attempts_keep_their_own_stages() {
        let cut: Vec<&str> = TEAM.lines().take(9).collect();
        let s = state(&cut.join("\n"), "2026-11-11T10:06:00Z");
        let current = s.current.unwrap();
        assert_eq!(current.item, "inbox-demo#102", "the newest still running");
        assert_eq!(
            current.last_stage,
            mark(Stage::Built, "2026-11-11T09:52:00Z")
        );
        let team = state(TEAM, "2026-11-11T19:00:00Z");
        let first = team.current.unwrap();
        assert_eq!(first.last_stage, mark(Stage::Draft, "2026-11-11T14:20:00Z"));
        // A stage outside the strip is kept by its name.
        let criteria: Vec<&str> = TEAM.lines().take(4).collect();
        let s = state(&criteria.join("\n"), "2026-11-11T09:04:30Z");
        assert_eq!(
            s.current.unwrap().last_stage,
            mark(Stage::Other("criteria".into()), "2026-11-11T09:04:00Z")
        );
    }

    #[test]
    fn the_torn_record_skips_its_last_line_and_stops_running_after_the_cap() {
        let r = record(TORN);
        assert_eq!(r.error, None);
        assert_eq!(r.lines.len(), 3, "the torn fourth line is skipped");
        let s = state(TORN, "2026-11-12T10:30:00Z");
        assert_eq!(s.phase, Phase::Running);
        let current = s.current.unwrap();
        assert_eq!(current.item, "tools#7");
        assert_eq!(
            current.last_stage,
            mark(Stage::Brief, "2026-11-12T10:09:40Z")
        );
        // No session_hours cap: three hours from the last line read.
        let just = state(TORN, "2026-11-12T13:09:40Z");
        assert_eq!(just.phase, Phase::Running);
        let past = state(TORN, "2026-11-12T13:09:41Z");
        assert_eq!(
            past.phase,
            Phase::Ended {
                at: at("2026-11-12T10:09:40Z"),
                silent: true
            }
        );
        assert_eq!(past.length, Some(9.0 * 60.0 + 40.0));
    }

    #[test]
    fn a_run_with_no_end_stops_running_after_its_own_cap() {
        let started = TORN.replace(r#""caps":{"issues":1}"#, r#""caps":{"session_hours":1}"#);
        let s = state(&started, "2026-11-12T11:09:40Z");
        assert_eq!(s.phase, Phase::Running);
        let s = state(&started, "2026-11-12T11:09:41Z");
        assert!(matches!(s.phase, Phase::Ended { silent: true, .. }));
    }

    #[test]
    fn an_unknown_event_keeps_its_run_running() {
        // The team's first lines, then only events this reader skips.
        let mut lines: Vec<&str> = TEAM.lines().take(4).collect();
        let heard = r#"{"v":1,"at":"2026-11-11T12:00:00Z","run":"team-1111","event":"board_synced","tickets":2}"#;
        let other =
            r#"{"v":1,"at":"2026-11-11T14:00:00Z","run":"elsewhere","event":"board_synced"}"#;
        lines.extend([heard, other]);
        let text = lines.join("\n");
        assert_eq!(state(&text, "2026-11-11T14:59:59Z").phase, Phase::Running);
        assert_eq!(
            state(&text, "2026-11-11T15:00:01Z").phase,
            Phase::Ended {
                at: at("2026-11-11T12:00:00Z"),
                silent: true
            },
            "another run's line is not this run's"
        );
    }

    #[test]
    fn a_cap_of_zero_hours_is_no_cap() {
        let zero = TORN.replace(r#""caps":{"issues":1}"#, r#""caps":{"session_hours":0}"#);
        assert_eq!(state(&zero, "2026-11-12T13:09:40Z").phase, Phase::Running);
    }

    #[test]
    fn a_broken_line_is_named_and_what_came_before_is_kept() {
        let mut lines: Vec<&str> = ONE_ISSUE.lines().collect();
        lines.insert(
            4,
            r#"{"v":1,"at":"2026-11-13T14:30:00Z","run":"r-1422","event":"stage","item":"app-one#2806","attempt":1}"#,
        );
        let r = record(&lines.join("\n")).state(at("2026-11-13T14:31:00Z"));
        let error = r.error.unwrap();
        assert_eq!(error.line, 5);
        assert!(error.to_string().contains("stage"), "{error}");
        let s = r.run.unwrap();
        assert_eq!(s.phase, Phase::Running);
        assert_eq!(
            s.current.unwrap().last_stage,
            mark(Stage::Built, "2026-11-13T14:24:38Z")
        );

        let first = record("not json\n").state(0.0);
        assert_eq!(first.run, None);
        assert_eq!(first.error.map(|e| e.line), Some(1));
    }

    #[test]
    fn an_attempt_with_no_cost_marks_the_total_unknown() {
        let unpriced = ONE_ISSUE.replace(r#""cost_usd":11.42,"#, "");
        let s = state(&unpriced, "2026-11-13T15:00:00Z");
        assert!(s.cost.unknown && s.spend_24h.unknown);
        assert!(close(s.cost.usd, 11.42), "its sessions still count");
    }

    fn feed(checkout: &str) -> OstinatoFeed {
        OstinatoFeed {
            records: BTreeMap::from([
                (
                    "example/app-one".to_string(),
                    RecordText::from_bytes(ONE_ISSUE.as_bytes()),
                ),
                (
                    "example/tools".to_string(),
                    RecordText::from_bytes(TORN.as_bytes()),
                ),
            ]),
            checkouts: BTreeMap::from([(checkout.to_string(), "example/app-one".to_string())]),
        }
    }

    #[test]
    fn a_record_finds_the_card_on_its_main_checkout() {
        let mut o = Ostinato::default();
        o.take(feed("/dev/app-one/"));
        let r = o.record_for("/dev/app-one").unwrap();
        assert_eq!(r.project, "example/app-one");
        assert!(o.record_for("/dev/app-one/").is_some());
        assert!(o.record_for("/dev/tools").is_none(), "not a checkout");
        assert!(o.record_for("/dev/other").is_none());

        // Unchanged text is not read again; changed text is.
        let before = o.records["example/app-one"].clone();
        o.take(feed("/dev/app-one"));
        assert_eq!(o.records["example/app-one"], before);
        let mut next = feed("/dev/app-one");
        next.records.insert(
            "example/app-one".into(),
            RecordText::from_bytes(TORN.as_bytes()),
        );
        o.take(next);
        assert_eq!(o.records["example/app-one"].project, "example/tools");
        assert!(o.record_for("/dev/app-one").is_none(), "its project moved");
        o.take(OstinatoFeed::default());
        assert!(o.records.is_empty());
    }

    #[test]
    fn two_records_about_one_repo_give_the_newest() {
        let mut o = Ostinato::default();
        let mut f = feed("/dev/app-one");
        // An older file whose run_started also names the repo, sorting first.
        let old = ONE_ISSUE.replace("2026-11-13", "2026-10-13");
        f.records.insert(
            "aaa/old-name".into(),
            RecordText::from_bytes(old.as_bytes()),
        );
        o.take(f);
        let r = o.record_for("/dev/app-one").unwrap();
        assert_eq!(r.text.text, ONE_ISSUE);
    }

    #[test]
    fn the_file_name_gives_the_project_when_no_run_started_was_read() {
        let r = Record::read(
            "Example/App-One",
            RecordText::from_bytes(TORN.lines().nth(1).unwrap().as_bytes()),
        );
        assert_eq!(r.project, "example/app-one");
    }

    #[test]
    fn the_session_reads_the_run_at_the_frames_clock() {
        let mut s = Session::default();
        s.ostinato.take(feed("/dev/app-one"));
        let w = Workspace {
            id: "w".into(),
            directory: Some("/dev/app-one".into()),
            ..Workspace::default()
        };
        let data = |now: &str| Data {
            epoch: Some(at(now)),
            workspaces: Some(vec![w.clone()]),
            ..Data::default()
        };
        let run = s.ostinato_run(&data("2026-11-14T15:00:00Z"), &w);
        let run = run.unwrap().run.unwrap();
        assert_eq!(run.spend_24h, Cost::default(), "a day later");
        let run = s.ostinato_run(&data("2026-11-13T15:00:00Z"), &w);
        assert!(close(run.unwrap().run.unwrap().spend_24h.usd, 11.42));
        let elsewhere = Workspace {
            directory: Some("/dev/app-one-feat".into()),
            ..w.clone()
        };
        assert_eq!(
            s.ostinato_run(&data("2026-11-13T15:00:00Z"), &elsewhere),
            None
        );
    }

    #[test]
    fn two_workspaces_in_one_checkout_give_the_run_to_the_first_in_tab_order() {
        let mut s = Session::default();
        let mut f = feed("/dev/app-one");
        f.checkouts
            .insert("/dev/app-one/src".into(), "example/app-one".into());
        s.ostinato.take(f);
        let ws = |id: &str, dir: &str| Workspace {
            id: id.into(),
            directory: Some(dir.into()),
            ..Workspace::default()
        };
        let (a, b) = (ws("a", "/dev/app-one/src"), ws("b", "/dev/app-one"));
        let data = Data {
            epoch: Some(at("2026-11-13T15:00:00Z")),
            workspaces: Some(vec![a.clone(), b.clone()]),
            ..Data::default()
        };
        assert!(s.ostinato_run(&data, &a).is_some(), "first in tab order");
        assert_eq!(s.ostinato_run(&data, &b), None);
    }

    #[test]
    fn the_event_reaches_the_session_and_a_new_state_file_keeps_it() {
        use crate::app::{Cockpit, Event as Input, Model};
        use crux_core::App;
        let app = Cockpit;
        let mut m = Model::default();
        let _ = app.update(Input::Ostinato(Box::new(feed("/dev/app-one"))), &mut m);
        let _ = app.update(Input::State(Box::default()), &mut m);
        assert!(m.session.ostinato.record_for("/dev/app-one").is_some());
    }
}
