//! Stuck or red CI with nobody on it (issue #377). A PR whose checks
//! failed, or hang in the queue or run too long (prs.rs `stuck`), waits
//! on Jon once no session in its workspace is on it: none working, none
//! waiting on him for a reason of its own, none running background work
//! its chat started. Then it joins Needs you in Your turn's clay, as a
//! stopped session does: the card's agent reads as needs input from when
//! the wait began, carrying `Agent::ci` so the status and words say why.
//! A workspace with no session left gets a stand-in agent for the wait.
//!
//! The rule is read once a frame, at the frame's clock (`Session::tend_ci`),
//! since a check goes stuck with time and no event says so; every other
//! rule reads the agent as `Session::effective_agent` gives it, so Needs
//! you, the waiting count, lane order, the late chip and the look agree.
//!
//! One dismissal covers the workspace's CI, under `CI_KEY`, keyed on the
//! checks' own times (`CiWait::key`): it holds while a session works on it
//! and after, and lapses only when the PR's checks change (a rerun, a new
//! push, going green).
//!
//! A change left merge-ready four hours waits on its PR the same way
//! (issue #380, merge_wait.rs): `CiTrouble::MergeReady`, keyed on when it
//! first read merge-ready. It never coincides with stuck or red CI, since
//! a merge-ready PR has every check passed, so the one wait, dismissal
//! and stand-in serve both.

use serde::{Deserialize, Serialize};

use crate::activity::most_active;
use crate::data::{Agent, AgentStatus, Data, PrStatus, Workspace};
use crate::js::{num_text, truthy};
use crate::merge_wait::merge_wait;
use crate::persist::{SavedCheck, SavedState};
use crate::prs::{checks_of, pr_of, ready_since_of, stuck};
use crate::session::Session;
use crate::text::clean_title;
use crate::time::now_epoch;

/// The dismissal key a workspace's CI wait is saved under, beside its
/// agents' ids, a merge wait's too (the two never coincide). No session
/// id takes this shape.
pub const CI_KEY: &str = "ci";

/// What is wrong with a PR's CI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiTrouble {
    /// A check waiting for a runner, or running, too long.
    Stuck,
    /// A check failed.
    Failing,
    /// Every check passed and GitHub would merge it, and it has read so
    /// four hours or more with nobody merging it (issue #380,
    /// merge_wait.rs).
    MergeReady,
}

/// A workspace's PR whose CI is in trouble, as the last frame read it.
#[derive(Debug, Clone, PartialEq)]
pub struct CiWait {
    pub trouble: CiTrouble,
    /// The checks' own time the trouble is keyed on: the stuck check's
    /// queue or start time, else the latest start of a failing check (0
    /// with none known), else when a merge-ready PR first read so. It
    /// moves only when the PR does, so a dismissal keyed on it holds until
    /// the PR's state changes.
    pub key: f64,
    /// When it began to wait on Jon: the later of when the trouble began
    /// and when the workspace's last session stopped working; for a
    /// merge-ready PR, the four-hour mark alone, an instant that never
    /// moves while it waits (issue #380).
    pub since: f64,
    /// The PR as the words name it: its title, else its number, "#12".
    pub pr: String,
    /// No session in the workspace is on it, so it waits on Jon. False
    /// while one is: the trouble is still read, so a dismissal holds.
    pub waits: bool,
}

/// The trouble with `checks` at epoch `now`, its key, and when it began:
/// failing first, then stuck. None when neither.
fn trouble_of(checks: &[SavedCheck], now: f64) -> Option<(CiTrouble, f64, f64)> {
    let failing: Vec<&SavedCheck> = checks.iter().filter(|c| c.state == "fail").collect();
    if !failing.is_empty() {
        let key = failing.iter().filter_map(|c| c.started).fold(0.0, f64::max);
        return Some((CiTrouble::Failing, key, key));
    }
    let s = stuck(checks, now)?;
    Some((CiTrouble::Stuck, s.since, s.went_stuck()))
}

/// The CI trouble of the workspace's first PR at epoch `now`: an open
/// numbered PR with the poller's checks, stuck or red, else left
/// merge-ready four hours (merge_wait.rs). None for any other.
fn ci_of(saved: &SavedState, w: &Workspace, now: f64) -> Option<(CiTrouble, f64, f64, String)> {
    let pr = pr_of(saved, Some(w))?;
    let number = truthy(pr.number)?;
    if pr.status != Some(PrStatus::Open) {
        return None;
    }
    let checks = checks_of(saved, w);
    let (trouble, key, began) = trouble_of(checks, now).or_else(|| {
        merge_wait(&pr, checks, ready_since_of(saved, w), now)
            .map(|(key, began)| (CiTrouble::MergeReady, key, began))
    })?;
    let title = clean_title(pr.title.as_deref());
    let name = if title.is_empty() {
        format!("#{}", num_text(number))
    } else {
        title
    };
    Some((trouble, key, began, name))
}

/// Whether `a`, as the sidebars show it, is on its workspace's work:
/// working, waiting on Jon for a reason of its own, or idle while its
/// chat runs background work.
fn is_on_it(saved: &SavedState, data: &Data, w: &Workspace, a: &Agent) -> bool {
    match a.status {
        Some(AgentStatus::Working | AgentStatus::NeedsInput) => true,
        Some(AgentStatus::Idle) => {
            crate::running::running_work(saved, data, Some(w), Some(a)).is_some()
        }
        _ => false,
    }
}

fn finished(a: &Agent) -> bool {
    matches!(a.status, Some(AgentStatus::Idle | AgentStatus::Ended))
}

/// The id of the agent among `own` (a workspace's agents as shown before
/// CI) that carries its CI wait: the one the card speaks through
/// (`most_active`), when it has finished. One only, so an ended session
/// beside an idle one stays ended and counts as no live tab.
pub(crate) fn ci_carrier(own: &[Agent]) -> Option<&str> {
    most_active(own)
        .filter(|a| finished(a))
        .map(|a| a.id.as_str())
}

impl Session {
    /// Reads each workspace's CI trouble at the frame's clock, and whether
    /// anyone is on it, for the frame's rules to read
    /// (`effective_agent`). An asleep workspace has nobody on it by
    /// design, so its CI never waits.
    pub(crate) fn tend_ci(&mut self, data: &Data) {
        // Cleared first, so the agents read below are their own.
        self.ci.clear();
        let now = now_epoch(data);
        let mut found = std::collections::HashMap::new();
        for w in data.workspace_list() {
            let Some((trouble, key, began, pr)) = ci_of(&self.saved, w, now) else {
                continue;
            };
            let agents = self.shown_agents(w);
            let on_it = agents.iter().any(|a| is_on_it(&self.saved, data, w, a));
            let asleep = self.sleep_kind(&w.id).is_some();
            let stopped_working = agents
                .iter()
                .filter_map(|a| truthy(a.since_epoch))
                .fold(0.0, f64::max);
            // A merge wait is dated from its four-hour mark alone, so the
            // instant a notification keys on never moves (#379).
            let since = match trouble {
                CiTrouble::MergeReady => began,
                CiTrouble::Stuck | CiTrouble::Failing => began.max(stopped_working),
            };
            found.insert(
                w.id.clone(),
                CiWait {
                    trouble,
                    key,
                    since,
                    pr,
                    waits: !on_it && !asleep,
                },
            );
        }
        self.ci = found;
        self.ci_read = true;
    }

    /// Whether a CI dismissal saved at `key` still holds for `w`: its
    /// trouble is read with that key, or nothing says it changed. It lapses
    /// only on what a read shows: trouble with another key, a PR no longer
    /// open, or checks that give no trouble. A frame where the PR cannot be
    /// read (before the first read, or cmux reporting the workspace before
    /// its branch settles) or carries no checks keeps it, and so does one
    /// where a merge wait's ready time still holds while GitHub's verdict
    /// is unsure (pr_poll.rs `stamp_ready`).
    pub(crate) fn ci_dismissal_holds(&self, w: &Workspace, key: f64) -> bool {
        if !self.ci_read {
            return true;
        }
        if let Some(ci) = self.ci.get(&w.id) {
            return ci.key == key;
        }
        self.ci_unsure(w, key)
    }

    /// Whether a CI wait keyed `key` in `w` may still be on, though this
    /// frame read no trouble there: the PR cannot be read or carries no
    /// checks, or its ready time holds while GitHub's verdict is unsure.
    /// False once the PR is merged or closed, or its checks give no trouble.
    pub(crate) fn ci_unsure(&self, w: &Workspace, key: f64) -> bool {
        match pr_of(&self.saved, Some(w)).and_then(|pr| pr.status) {
            Some(PrStatus::Merged | PrStatus::Closed) => false,
            Some(PrStatus::Open) => {
                checks_of(&self.saved, w).is_empty() || ready_since_of(&self.saved, w) == Some(key)
            }
            Some(PrStatus::Unknown) | None => true,
        }
    }

    /// The workspace's CI wait as the sidebars show it: waiting on Jon and
    /// not dismissed.
    pub fn ci_shown(&self, w: Option<&Workspace>) -> Option<&CiWait> {
        let w = w?;
        self.ci
            .get(&w.id)
            .filter(|ci| ci.waits && !self.dismissed_key(&w.id, CI_KEY, ci.key))
    }

    /// The workspace's CI wait that counts for dismissing and restoring:
    /// waiting on Jon, dismissed or not.
    pub(crate) fn ci_waiting(&self, w: &Workspace) -> Option<&CiWait> {
        self.ci.get(&w.id).filter(|ci| ci.waits)
    }

    /// Whether the agent with id `id` carries `w`'s CI wait: the wait
    /// shows and it is the one the card speaks through (`ci_carrier`).
    pub(crate) fn carries_ci(&self, w: &Workspace, id: &str) -> bool {
        self.ci_shown(Some(w)).is_some() && ci_carrier(&self.shown_agents(w)) == Some(id)
    }

    /// `own`, an agent as the sidebars show it before CI, carrying the
    /// workspace's CI wait when it has finished (idle or ended) and the
    /// wait shows. Only its carrier is given it (`ci_carrier`).
    pub(crate) fn with_ci(&self, own: Agent, w: Option<&Workspace>) -> Agent {
        match self.ci_shown(w) {
            Some(ci) if finished(&own) => Agent {
                status: Some(AgentStatus::NeedsInput),
                since_epoch: Some(ci.since),
                ci: Some(ci.trouble),
                ..own
            },
            _ => own,
        }
    }

    /// The stand-in agent a workspace with no session left shows its CI
    /// wait by, or None when no wait shows.
    pub(crate) fn ci_stand_in(&self, w: Option<&Workspace>) -> Option<Agent> {
        let ci = self.ci_shown(w)?;
        Some(Agent {
            id: CI_KEY.to_string(),
            status: Some(AgentStatus::NeedsInput),
            since_epoch: Some(ci.since),
            last_activity_at: Some(ci.since),
            ci: Some(ci.trouble),
            ..Agent::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(state: &str, queued: Option<f64>, started: Option<f64>) -> SavedCheck {
        SavedCheck {
            name: "build".into(),
            state: state.into(),
            queued,
            started,
        }
    }

    #[test]
    fn failing_outranks_stuck_and_keys_on_the_latest_failed_start() {
        let checks = [
            check("pending", Some(100.0), None),
            check("fail", None, Some(300.0)),
            check("fail", None, Some(200.0)),
        ];
        assert_eq!(
            trouble_of(&checks, 10_000.0),
            Some((CiTrouble::Failing, 300.0, 300.0))
        );
        let stuck = [check("pending", Some(100.0), None)];
        assert_eq!(
            trouble_of(&stuck, 700.0),
            Some((CiTrouble::Stuck, 100.0, 700.0)),
            "began when it went stuck"
        );
        let running = [check("pending", Some(50.0), Some(100.0))];
        assert_eq!(
            trouble_of(&running, 2800.0),
            Some((CiTrouble::Stuck, 100.0, 2800.0))
        );
        assert_eq!(trouble_of(&[check("pass", None, Some(1.0))], 1e10), None);
        assert_eq!(
            trouble_of(&[check("fail", None, None)], 1.0),
            Some((CiTrouble::Failing, 0.0, 0.0)),
            "old saved data still fails"
        );
    }
}
