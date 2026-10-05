//! The pane's own PR poll (#212): the core decides when each directory's
//! PR is asked for, the shell runs `git` and `gh` for it as
//! scripts/pr-poll.ts does (gh.rs reads what they say), and the answer
//! comes back as an event.
//!
//! The rules, by directory, since every workspace in one directory is on
//! one branch and so shares one call, as the TypeScript asks each
//! directory and branch once:
//!
//! - Asked at most once every FLOOR_SECS, and never while an ask is out.
//! - Again after FLOOR_SECS when its workspaces stirred (an agent's
//!   status moved, its branch changed, it was selected) or its PR's
//!   checks are running; else after IDLE_SECS.
//! - A failed ask backs off, doubling from FLOOR_SECS to BACKOFF_CAP_SECS.
//!   A failure about the repo itself (no GitHub remote) waits the cap.
//! - At most MAX_IN_FLIGHT asks out at once.
//!
//! The answers are held here, not written to config/state.json, and made
//! over the state file's `prs` map on every read (overlay), so a new
//! state file never hides a fresher answer. A result redraws only when
//! what a card shows of the PR changed (Shown, the lesson from #198).

mod gh;

use std::collections::BTreeMap;

pub use gh::{
    Branch, MAX_CHECKS, PR_FIELDS, Ran, answer, branch_from_git, checks_from, clean_title, gh_args,
    gh_outcome, git_args, pick_pr,
};

use crate::data::{Data, PrStatus, PullRequest, Workspace};
use crate::js::non_empty;
use crate::persist::SavedPr;
use crate::prs::{PrHealth, health_of};

/// The shortest wait between two asks for one directory.
pub const FLOOR_SECS: f64 = 30.0;
/// The wait while nothing in the directory stirs and no check is running.
pub const IDLE_SECS: f64 = 300.0;
/// The longest a failing directory waits.
pub const BACKOFF_CAP_SECS: f64 = 600.0;
/// An ask with no answer this long is taken as lost, and may go again.
pub const ANSWER_SECS: f64 = 60.0;
/// The most asks out at once.
pub const MAX_IN_FLIGHT: usize = 2;

/// Why gh gave no PR list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhFailure {
    /// The directory's repo is the trouble (not a repo, no GitHub remote).
    Repo,
    /// No gh binary.
    Missing,
    SignedOut,
    /// A timeout, the network, GitHub itself.
    Unavailable,
    /// gh answered with something that is not a PR list.
    Unreadable,
}

impl GhFailure {
    /// The failure as a log word. Never anything gh printed.
    pub fn as_str(self) -> &'static str {
        match self {
            GhFailure::Repo => "repo",
            GhFailure::Missing => "missing",
            GhFailure::SignedOut => "signed-out",
            GhFailure::Unavailable => "unavailable",
            GhFailure::Unreadable => "unreadable",
        }
    }
}

/// What the shell found for one directory.
#[derive(Debug, Clone, PartialEq)]
pub enum PollAnswer {
    /// On no branch (a detached HEAD, or not a repo): it has no PR.
    NoBranch,
    /// git could not say, so what was known stays.
    GitFailed,
    /// gh answered: the branch's PR, or none.
    Answered { branch: String, pr: Option<SavedPr> },
    /// gh did not answer, so what was known stays.
    Failed { branch: String, why: GhFailure },
}

impl PollAnswer {
    /// The answer as a log line's words: no title, branch or gh output.
    pub fn log_word(&self) -> &'static str {
        match self {
            PollAnswer::NoBranch => "no branch",
            PollAnswer::GitFailed => "git failed",
            PollAnswer::Answered { pr: Some(_), .. } => "found",
            PollAnswer::Answered { pr: None, .. } => "none",
            PollAnswer::Failed { why, .. } => why.as_str(),
        }
    }
}

/// One answer, for the event that brings it back.
#[derive(Debug, Clone, PartialEq)]
pub struct PrPolled {
    pub directory: String,
    pub answer: PollAnswer,
    /// When the shell had the answer, in epoch seconds.
    pub epoch: f64,
}

/// What a card shows of a saved PR: the one list of fields whose change
/// redraws. It is the cockpit's cut in scripts/bundle.ts (cockpitPr):
/// the number, link, status, branch and title; while open, the draft
/// marker, the diff size and the chip's health; and the failing count
/// only when the health is failing, since the chip counts those. A check
/// renamed, one passing beside one still running, or a merge verdict
/// moving while the chip says running is not here, so it never redraws.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub number: f64,
    pub url: String,
    pub status: PrStatus,
    pub branch: String,
    pub title: Option<String>,
    pub draft: Option<bool>,
    pub additions: Option<f64>,
    pub deletions: Option<f64>,
    pub health: PrHealth,
    pub failing: usize,
}

/// What a card shows of `pr`.
pub fn shown(pr: &SavedPr) -> Shown {
    let open = pr.status == PrStatus::Open;
    let as_pr = PullRequest {
        number: Some(pr.number),
        status: Some(pr.status),
        draft: pr.draft,
        mergeable: pr.mergeable,
        conflicts: pr.conflicts,
        ..PullRequest::default()
    };
    let checks = pr.checks.as_deref().unwrap_or(&[]);
    let health = health_of(&as_pr, checks);
    let failing = match health {
        PrHealth::Failing => checks.iter().filter(|c| c.state == "fail").count(),
        _ => 0,
    };
    Shown {
        number: pr.number,
        url: pr.url.clone(),
        status: pr.status,
        branch: pr.branch.clone(),
        title: pr.title.clone(),
        draft: pr.draft.filter(|_| open),
        additions: pr.additions.filter(|_| open),
        deletions: pr.deletions.filter(|_| open),
        health,
        failing,
    }
}

/// What the cards in `directory` show of their saved PRs, in tab order.
pub fn shown_in(
    prs: &BTreeMap<String, SavedPr>,
    data: &Data,
    directory: &str,
) -> Vec<Option<Shown>> {
    data.workspace_list()
        .iter()
        .filter(|w| dir_of(w) == Some(directory))
        .map(|w| prs.get(&w.id).map(shown))
        .collect()
}

fn dir_of(w: &Workspace) -> Option<&str> {
    non_empty(w.directory.as_deref())
}

/// One directory's poll.
#[derive(Debug, Clone, Default)]
struct Target {
    /// When it was last asked for.
    asked: Option<f64>,
    /// An ask is out.
    waiting: bool,
    /// Failed asks in a row.
    failures: u32,
    /// The wait after the last answer while nothing stirs.
    rest: f64,
    /// Its workspaces as last seen, to tell when they stir.
    stir: String,
    stirred: bool,
    /// The last answer that said something: the PR, or none. None until one does.
    known: Option<Option<SavedPr>>,
}

impl Target {
    fn in_flight(&self, now: f64) -> bool {
        self.waiting && self.asked.is_some_and(|at| now < at + ANSWER_SECS)
    }

    /// When it may be asked for next.
    fn due_at(&self) -> f64 {
        let Some(at) = self.asked else {
            return f64::NEG_INFINITY;
        };
        if self.waiting {
            return at + ANSWER_SECS;
        }
        if self.stirred && self.failures == 0 {
            return at + FLOOR_SECS;
        }
        at + self.rest.max(FLOOR_SECS)
    }

    /// Its PR's checks are running, so the chip will move soon.
    fn lively(&self) -> bool {
        matches!(&self.known, Some(Some(pr)) if shown(pr).health == PrHealth::Running)
    }

    fn record(&mut self, answer: PollAnswer) {
        self.waiting = false;
        match answer {
            PollAnswer::NoBranch => self.settle(Some(None)),
            PollAnswer::Answered { pr, .. } => self.settle(Some(pr)),
            PollAnswer::Failed {
                why: GhFailure::Repo,
                ..
            } => {
                self.failures = 0;
                self.rest = BACKOFF_CAP_SECS;
            }
            PollAnswer::Failed { .. } | PollAnswer::GitFailed => {
                self.failures = self.failures.saturating_add(1);
                self.rest = backoff(self.failures);
            }
        }
    }

    fn settle(&mut self, known: Option<Option<SavedPr>>) {
        self.known = known;
        self.failures = 0;
        self.rest = if self.lively() { FLOOR_SECS } else { IDLE_SECS };
    }
}

/// The wait after `failures` failed asks in a row: FLOOR_SECS doubled
/// each time, up to BACKOFF_CAP_SECS.
pub fn backoff(failures: u32) -> f64 {
    let doubled = FLOOR_SECS * 2f64.powi(i32::try_from(failures).unwrap_or(i32::MAX));
    doubled.min(BACKOFF_CAP_SECS)
}

/// What a workspace shows that, when it moves, is a reason to ask again:
/// as the TypeScript poll runs on a turn ending or a workspace selected.
fn stir_of(data: &Data, w: &Workspace) -> String {
    let selected = data.selected_id.as_deref() == Some(w.id.as_str()) || w.selected == Some(true);
    let statuses: Vec<String> = w.agent_list().map(|a| format!("{:?}", a.status)).collect();
    format!(
        "{}\u{1}{}\u{1}{selected}\u{1}{}",
        w.id,
        w.branch.as_deref().unwrap_or(""),
        statuses.join(",")
    )
}

/// The poll's state across frames. Off until the shell says it can run
/// gh, so a shell that cannot (or a test) is never asked.
#[derive(Debug, Clone, Default)]
pub struct PrPoll {
    on: bool,
    targets: BTreeMap<String, Target>,
}

impl PrPoll {
    /// The shell can run gh: from now on, ask.
    pub fn turn_on(&mut self) {
        self.on = true;
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    /// Notes what each directory's workspaces show now, dropping the
    /// directories no workspace is in any more.
    fn observe(&mut self, data: &Data) {
        let mut seen: BTreeMap<&str, String> = BTreeMap::new();
        for w in data.workspace_list() {
            if let Some(dir) = dir_of(w) {
                seen.entry(dir).or_default().push_str(&stir_of(data, w));
            }
        }
        self.targets
            .retain(|dir, _| seen.contains_key(dir.as_str()));
        for (dir, stir) in seen {
            let t = self.targets.entry(dir.to_string()).or_default();
            if t.stir != stir {
                t.stirred = t.asked.is_some();
                t.stir = stir;
            }
        }
    }

    /// The directories to ask for now, oldest asked first, marked as asked.
    pub fn due(&mut self, data: &Data, now: f64) -> Vec<String> {
        if !self.on {
            return Vec::new();
        }
        self.observe(data);
        let out = self.targets.values().filter(|t| t.in_flight(now)).count();
        let room = MAX_IN_FLIGHT.saturating_sub(out);
        let mut ready: Vec<(&String, f64)> = self
            .targets
            .iter()
            .filter(|(_, t)| !t.in_flight(now) && t.due_at() <= now)
            .map(|(d, t)| (d, t.asked.unwrap_or(f64::NEG_INFINITY)))
            .collect();
        ready.sort_by(|a, b| a.1.total_cmp(&b.1));
        let picked: Vec<String> = ready
            .into_iter()
            .take(room)
            .map(|(d, _)| d.clone())
            .collect();
        for dir in &picked {
            if let Some(t) = self.targets.get_mut(dir) {
                t.asked = Some(now);
                t.waiting = true;
                t.stirred = false;
            }
        }
        picked
    }

    /// Takes an answer. One for a directory no workspace is in any more is dropped.
    pub fn record(&mut self, polled: PrPolled) {
        if let Some(t) = self.targets.get_mut(&polled.directory) {
            t.record(polled.answer);
        }
    }

    /// Makes the answers over the saved `prs` map, for each workspace in
    /// an answered directory: its PR, or none.
    pub fn overlay(&self, prs: &mut BTreeMap<String, SavedPr>, data: &Data) {
        for w in data.workspace_list() {
            let known = dir_of(w).and_then(|d| self.targets.get(d)?.known.as_ref());
            match known {
                Some(Some(pr)) => {
                    prs.insert(w.id.clone(), pr.clone());
                }
                Some(None) => {
                    prs.remove(&w.id);
                }
                None => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{Agent, AgentStatus};
    use crate::persist::SavedCheck;

    fn ws(id: &str, dir: &str) -> Workspace {
        Workspace {
            id: id.into(),
            directory: Some(dir.into()),
            ..Workspace::default()
        }
    }

    fn data(list: Vec<Workspace>) -> Data {
        Data {
            workspaces: Some(list),
            ..Data::default()
        }
    }

    fn pr(checks: &[&str]) -> SavedPr {
        SavedPr {
            number: 7.0,
            url: "https://github.com/o/r/pull/7".into(),
            status: PrStatus::Open,
            branch: "feat".into(),
            draft: None,
            mergeable: Some(true),
            conflicts: None,
            title: Some("Poll".into()),
            additions: Some(3.0),
            deletions: Some(1.0),
            checks: Some(
                checks
                    .iter()
                    .enumerate()
                    .map(|(i, s)| SavedCheck {
                        name: format!("c{i}"),
                        state: (*s).into(),
                    })
                    .collect(),
            ),
        }
    }

    fn answered(dir: &str, pr: Option<SavedPr>, epoch: f64) -> PrPolled {
        PrPolled {
            directory: dir.into(),
            answer: PollAnswer::Answered {
                branch: "feat".into(),
                pr,
            },
            epoch,
        }
    }

    fn failed(dir: &str, why: GhFailure, epoch: f64) -> PrPolled {
        PrPolled {
            directory: dir.into(),
            answer: PollAnswer::Failed {
                branch: "feat".into(),
                why,
            },
            epoch,
        }
    }

    fn on() -> PrPoll {
        let mut p = PrPoll::default();
        p.turn_on();
        p
    }

    #[test]
    fn asks_nothing_until_the_shell_turns_it_on() {
        let d = data(vec![ws("a", "/a")]);
        let mut p = PrPoll::default();
        assert!(p.due(&d, 0.0).is_empty());
        p.turn_on();
        assert_eq!(p.due(&d, 0.0), ["/a"]);
    }

    #[test]
    fn asks_once_per_directory_however_many_workspaces_share_it() {
        let d = data(vec![
            ws("a", "/a"),
            ws("b", "/a"),
            ws("c", ""),
            Workspace::default(),
        ]);
        let mut p = on();
        assert_eq!(p.due(&d, 0.0), ["/a"]);
        assert!(p.due(&d, 1.0).is_empty(), "never while an ask is out");
    }

    #[test]
    fn never_asks_one_directory_more_often_than_the_floor() {
        let d = data(vec![ws("a", "/a")]);
        let mut p = on();
        assert_eq!(p.due(&d, 0.0), ["/a"]);
        p.record(answered("/a", Some(pr(&["pending"])), 1.0));
        // Checks running and the workspace stirring: still the floor.
        let mut busy = ws("a", "/a");
        busy.branch = Some("feat".into());
        let stirred = data(vec![busy]);
        assert!(p.due(&stirred, 29.9).is_empty());
        assert_eq!(p.due(&stirred, 30.0), ["/a"]);
    }

    #[test]
    fn a_quiet_directory_waits_the_idle_time_and_a_stir_brings_it_forward() {
        let d = data(vec![ws("a", "/a")]);
        let mut p = on();
        assert_eq!(p.due(&d, 0.0), ["/a"]);
        p.record(answered("/a", Some(pr(&["pass"])), 1.0));
        assert!(
            p.due(&d, 299.0).is_empty(),
            "nothing moved and nothing runs"
        );
        assert_eq!(p.due(&d, 300.0), ["/a"]);
        p.record(answered("/a", None, 301.0));

        let mut turned = ws("a", "/a");
        turned.agents = Some(vec![Some(Agent {
            status: Some(AgentStatus::Other("idle".into())),
            ..Agent::default()
        })]);
        let stirred = data(vec![turned]);
        assert!(p.due(&stirred, 329.0).is_empty());
        assert_eq!(p.due(&stirred, 330.0), ["/a"], "a turn ended");
    }

    #[test]
    fn running_checks_are_followed_at_the_floor() {
        let d = data(vec![ws("a", "/a")]);
        let mut p = on();
        let _ = p.due(&d, 0.0);
        p.record(answered("/a", Some(pr(&["pass", "pending"])), 1.0));
        assert_eq!(p.due(&d, 30.0), ["/a"]);
    }

    #[test]
    fn failures_back_off_to_the_cap_and_an_answer_resets_it() {
        assert_eq!(
            [1, 2, 3, 4, 5, 40].map(backoff),
            [60.0, 120.0, 240.0, 480.0, 600.0, 600.0]
        );
        let d = data(vec![ws("a", "/a")]);
        let mut p = on();
        let mut now = 0.0;
        let mut gaps = Vec::new();
        for _ in 0..3 {
            assert_eq!(p.due(&d, now), ["/a"]);
            p.record(failed("/a", GhFailure::Unavailable, now));
            let next = (0..2000)
                .map(|s| now + f64::from(s))
                .find(|t| !p.clone().due(&d, *t).is_empty())
                .unwrap();
            gaps.push(next - now);
            now = next;
        }
        assert_eq!(gaps, [60.0, 120.0, 240.0]);
        let _ = p.due(&d, now);
        p.record(answered("/a", Some(pr(&["pending"])), now));
        assert!(p.clone().due(&d, now + 29.0).is_empty());
        assert_eq!(p.due(&d, now + 30.0), ["/a"], "back to the floor");
    }

    #[test]
    fn a_repo_with_no_github_remote_waits_the_cap() {
        let d = data(vec![ws("a", "/a")]);
        let mut p = on();
        let _ = p.due(&d, 0.0);
        p.record(failed("/a", GhFailure::Repo, 0.0));
        assert!(p.due(&d, 599.0).is_empty());
        assert_eq!(p.due(&d, 600.0), ["/a"]);
    }

    #[test]
    fn a_lost_ask_goes_again_after_its_time_and_at_most_two_are_out() {
        let d = data(vec![ws("a", "/a"), ws("b", "/b"), ws("c", "/c")]);
        let mut p = on();
        assert_eq!(p.due(&d, 0.0), ["/a", "/b"]);
        assert!(p.due(&d, 10.0).is_empty());
        p.record(answered("/a", None, 11.0));
        assert_eq!(p.due(&d, 11.0), ["/c"], "the one never asked goes first");
        assert_eq!(p.due(&d, 60.0), ["/b"], "its answer never came");
    }

    #[test]
    fn overlays_answers_and_keeps_them_through_a_failure() {
        let d = data(vec![ws("a", "/a"), ws("b", "/a"), ws("c", "/c")]);
        let mut p = on();
        let _ = p.due(&d, 0.0);
        p.record(answered("/a", Some(pr(&[])), 1.0));
        let mut prs = BTreeMap::new();
        prs.insert("c".to_string(), pr(&["fail"]));
        p.overlay(&mut prs, &d);
        assert_eq!(
            prs.keys().collect::<Vec<_>>(),
            ["a", "b", "c"],
            "c is not answered yet"
        );

        let _ = p.due(&d, 400.0);
        p.record(failed("/a", GhFailure::SignedOut, 400.0));
        let mut again = BTreeMap::new();
        p.overlay(&mut again, &d);
        assert_eq!(again.len(), 2, "a failure keeps what was known");

        let _ = p.due(&d, 2000.0);
        p.record(PrPolled {
            directory: "/a".into(),
            answer: PollAnswer::NoBranch,
            epoch: 2000.0,
        });
        p.overlay(&mut prs, &d);
        assert_eq!(prs.keys().collect::<Vec<_>>(), ["c"]);
    }

    #[test]
    fn only_what_the_card_shows_counts_as_a_change() {
        let running = pr(&["pending", "pass"]);
        let mut moved = pr(&["pass", "pending", "pending"]);
        if let Some(c) = moved.checks.as_mut().and_then(|c| c.first_mut()) {
            c.name = "renamed".into();
        }
        moved.mergeable = None;
        assert_eq!(shown(&running), shown(&moved), "still running");

        assert_ne!(shown(&running), shown(&pr(&["fail", "pending"])));
        assert_ne!(
            shown(&pr(&["fail"])),
            shown(&pr(&["fail", "fail"])),
            "the chip counts"
        );
        assert_ne!(shown(&pr(&["pass"])), shown(&running), "running to ready");
        let mut retitled = running.clone();
        retitled.title = Some("New".into());
        assert_ne!(shown(&running), shown(&retitled));

        let merged = |additions| SavedPr {
            status: PrStatus::Merged,
            additions,
            ..pr(&["fail"])
        };
        assert_eq!(
            shown(&merged(Some(1.0))),
            shown(&merged(Some(9.0))),
            "no diff once merged"
        );
    }

    #[test]
    fn log_words_carry_nothing_gh_printed() {
        assert_eq!(
            failed("/a", GhFailure::SignedOut, 0.0).answer.log_word(),
            "signed-out"
        );
        assert_eq!(answered("/a", None, 0.0).answer.log_word(), "none");
    }
}
