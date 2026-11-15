//! A change left merge-ready with nobody merging it (issue #380). Ready to
//! merge draws green on the card but never counted in Needs you, so a
//! change GitHub would merge could sit for days. Once it has read
//! merge-ready four hours (`MERGE_WAIT_SECS`), it joins Needs you as a
//! wait on its PR, the way stuck or red CI does (ci_wait.rs, which reads
//! it as `CiTrouble::MergeReady` and carries it to the card's agent).
//!
//! The clock runs from when the poll first saw the PR merge-ready
//! (persist.rs `SavedPr::ready_since`, stamped by pr_poll.rs
//! `stamp_ready`), so a restart keeps it. An answer that shows the PR
//! itself change clears it: merged or closed, red, running, in conflict,
//! back in draft, or its checks run again. GitHub's verdict alone going
//! unsure (UNKNOWN while it recomputes after main moves, or BLOCKED or
//! BEHIND) keeps it, though the PR does not read Ready while it lasts, so
//! neither the green status nor the wait shows until the verdict comes
//! back. The wait is dated from the four-hour mark, so the waiting clock
//! and the late chip count from when it began to wait, and that instant
//! holds from frame to frame.

use crate::data::PullRequest;
use crate::persist::SavedCheck;
use crate::prs::{PrHealth, health_of};

/// How long a change reads merge-ready before it waits on Jon. To tune.
pub const MERGE_WAIT_SECS: f64 = 4.0 * 60.0 * 60.0;

/// A saved ready time that counts: any after the zero time. The one rule
/// both the poll's stamp and the wait read it by.
pub(crate) fn ready_time(ready_since: Option<f64>) -> Option<f64> {
    ready_since.filter(|t| *t > 0.0)
}

/// The merge-ready wait of `pr`, with its saved `checks` and the time it
/// first read merge-ready (`ready_since`), at epoch `now`: that time, which
/// a dismissal is keyed on, and when it began to wait on Jon, four hours
/// on. None while it is not merge-ready, carries no time, or has read so
/// under four hours.
pub(crate) fn merge_wait(
    pr: &PullRequest,
    checks: &[SavedCheck],
    ready_since: Option<f64>,
    now: f64,
) -> Option<(f64, f64)> {
    if health_of(pr, checks) != PrHealth::Ready {
        return None;
    }
    let start = ready_time(ready_since)?;
    let due = start + MERGE_WAIT_SECS;
    (now >= due).then_some((start, due))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::PrStatus;

    fn ready_pr() -> PullRequest {
        PullRequest {
            number: Some(12.0),
            status: Some(PrStatus::Open),
            mergeable: Some(true),
            ..PullRequest::default()
        }
    }

    fn passed() -> Vec<SavedCheck> {
        vec![SavedCheck {
            name: "build".into(),
            state: "pass".into(),
            ..SavedCheck::default()
        }]
    }

    #[test]
    fn waits_from_the_four_hour_mark_and_not_a_second_before() {
        let start = 10_000.0;
        let due = start + MERGE_WAIT_SECS;
        let at = |now| merge_wait(&ready_pr(), &passed(), Some(start), now);
        assert_eq!(at(due - 1.0), None, "under four hours stays out");
        assert_eq!(at(due), Some((start, due)));
        assert_eq!(
            at(due + 9000.0),
            Some((start, due)),
            "dated from the mark, not the clock"
        );
    }

    #[test]
    fn needs_a_ready_pr_and_a_time() {
        let late = 1e9;
        assert_eq!(merge_wait(&ready_pr(), &passed(), None, late), None);
        assert_eq!(merge_wait(&ready_pr(), &passed(), Some(0.0), late), None);
        let merged = PullRequest {
            status: Some(PrStatus::Merged),
            ..ready_pr()
        };
        assert_eq!(merge_wait(&merged, &passed(), Some(1.0), late), None);
        let red = vec![SavedCheck {
            state: "fail".into(),
            ..passed()[0].clone()
        }];
        assert_eq!(merge_wait(&ready_pr(), &red, Some(1.0), late), None);
        let blocked = PullRequest {
            mergeable: None,
            ..ready_pr()
        };
        assert_eq!(merge_wait(&blocked, &passed(), Some(1.0), late), None);
    }
}
