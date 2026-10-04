//! A workspace's pull requests and their health (src/shared/prs.ts and
//! src/shared/pr-health.ts): cmux's own when it sends any, else the one
//! the poller saved in config/state.json. Only the slice a lane header's
//! merge line needs is here; the chips' words, summaries and colours come
//! with the chips port.

use std::borrow::Cow;

use crate::data::{PrStatus, PullRequest, Workspace};
use crate::js::{non_empty, truthy};
use crate::persist::{SavedCheck, SavedPr, SavedState};

/// What a PR's chip says about it: its worst state, or quiet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrHealth {
    Failing,
    Conflicts,
    Running,
    Ready,
    Quiet,
}

impl PrHealth {
    /// The health as the TypeScript names it.
    pub fn as_str(self) -> &'static str {
        match self {
            PrHealth::Failing => "failing",
            PrHealth::Conflicts => "conflicts",
            PrHealth::Running => "running",
            PrHealth::Ready => "ready",
            PrHealth::Quiet => "quiet",
        }
    }
}

/// The saved PR as cmux's own shape, so both read one way.
fn as_pull_request(saved: &SavedPr) -> PullRequest {
    PullRequest {
        url: Some(saved.url.clone()),
        number: Some(saved.number),
        status: Some(saved.status),
        draft: saved.draft,
        mergeable: saved.mergeable,
        conflicts: saved.conflicts,
        title: saved.title.clone(),
        additions: saved.additions,
        deletions: saved.deletions,
        branch: Some(saved.branch.clone()),
        ..PullRequest::default()
    }
}

/// The saved PR, while the workspace's branch is not yet known or still
/// matches the branch it was found for.
fn saved_for<'s>(saved: &'s SavedState, w: &Workspace) -> Option<&'s SavedPr> {
    let pr = saved.prs.get(&w.id)?;
    match non_empty(w.branch.as_deref()) {
        Some(branch) if branch != pr.branch => None,
        _ => Some(pr),
    }
}

/// The app's list, else its single PR, else the saved one.
pub fn prs_of(saved: &SavedState, w: &Workspace) -> Vec<PullRequest> {
    if let Some(list) = w.prs.as_ref().filter(|l| !l.is_empty()) {
        return list.clone();
    }
    if let Some(pr) = &w.pr {
        return vec![pr.clone()];
    }
    saved_for(saved, w)
        .map(as_pull_request)
        .into_iter()
        .collect()
}

/// The workspace's first PR, if any: borrowed when it is cmux's own, so
/// a read every frame clones no list.
pub fn pr_of<'a>(saved: &SavedState, w: Option<&'a Workspace>) -> Option<Cow<'a, PullRequest>> {
    let w = w?;
    if let Some(first) = w.prs.as_ref().and_then(|l| l.first()) {
        return Some(Cow::Borrowed(first));
    }
    if let Some(pr) = &w.pr {
        return Some(Cow::Borrowed(pr));
    }
    saved_for(saved, w).map(|p| Cow::Owned(as_pull_request(p)))
}

/// Whether the workspace's PRs are the poller's saved copy rather than cmux's own.
pub fn from_poller(w: &Workspace) -> bool {
    !(w.prs.as_ref().is_some_and(|l| !l.is_empty()) || w.pr.is_some())
}

/// The CI checks of the saved PR. Only the poller saves checks, so while
/// cmux sends a PR of its own there are none.
pub fn checks_of<'s>(saved: &'s SavedState, w: &Workspace) -> &'s [SavedCheck] {
    if !from_poller(w) {
        return &[];
    }
    saved_for(saved, w)
        .and_then(|pr| pr.checks.as_deref())
        .unwrap_or(&[])
}

/// Only an open PR has a health, its worst state: failing checks, then
/// merge conflicts, then checks running. Ready needs GitHub's own verdict
/// (mergeable) on a PR out of draft whose saved checks all passed; with
/// no saved checks it stays quiet rather than claim a ready it cannot see.
pub fn health_of(pr: &PullRequest, checks: &[SavedCheck]) -> PrHealth {
    if pr.status != Some(PrStatus::Open) {
        return PrHealth::Quiet;
    }
    if checks.iter().any(|c| c.state == "fail") {
        return PrHealth::Failing;
    }
    if pr.conflicts == Some(true) {
        return PrHealth::Conflicts;
    }
    if checks.iter().any(|c| c.state == "pending") {
        return PrHealth::Running;
    }
    if !checks.is_empty() && pr.draft != Some(true) && pr.mergeable == Some(true) {
        PrHealth::Ready
    } else {
        PrHealth::Quiet
    }
}

/// The health of the workspace's first numbered PR; quiet with none.
pub fn pr_health(saved: &SavedState, w: Option<&Workspace>) -> PrHealth {
    let Some(w) = w else {
        return PrHealth::Quiet;
    };
    match pr_of(saved, Some(w)) {
        Some(pr) if truthy(pr.number).is_some() => health_of(&pr, checks_of(saved, w)),
        _ => PrHealth::Quiet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(json: &str) -> SavedState {
        SavedState::from_json(json).unwrap()
    }

    const READY: &str = r#"{"prs": {"w": {"number": 1, "url": "u", "status": "open", "branch": "feat", "mergeable": true, "checks": [{"name": "build", "state": "pass"}]}}}"#;

    #[test]
    fn reads_the_saved_pr_while_the_branch_is_unknown_or_the_same() {
        let s = saved(READY);
        let w = Workspace {
            id: "w".into(),
            ..Workspace::default()
        };
        assert_eq!(pr_health(&s, Some(&w)), PrHealth::Ready);
        let same = Workspace {
            branch: Some("feat".into()),
            ..w.clone()
        };
        assert_eq!(pr_health(&s, Some(&same)), PrHealth::Ready);
        let moved = Workspace {
            branch: Some("other".into()),
            ..w
        };
        assert_eq!(pr_health(&s, Some(&moved)), PrHealth::Quiet);
    }

    #[test]
    fn prefers_cmuxs_own_pr_which_has_no_checks_so_stays_quiet() {
        let s = saved(READY);
        let w = Workspace {
            id: "w".into(),
            pr: Some(PullRequest {
                number: Some(7.0),
                status: Some(PrStatus::Open),
                mergeable: Some(true),
                ..PullRequest::default()
            }),
            ..Workspace::default()
        };
        assert_eq!(pr_of(&s, Some(&w)).and_then(|p| p.number), Some(7.0));
        assert_eq!(pr_health(&s, Some(&w)), PrHealth::Quiet);
    }

    #[test]
    fn ranks_failing_then_conflicts_then_running() {
        let check = |state: &str| SavedCheck {
            name: "build".into(),
            state: state.into(),
        };
        let open = PullRequest {
            number: Some(1.0),
            status: Some(PrStatus::Open),
            conflicts: Some(true),
            mergeable: Some(true),
            ..PullRequest::default()
        };
        assert_eq!(
            health_of(&open, &[check("pending"), check("fail")]),
            PrHealth::Failing
        );
        assert_eq!(health_of(&open, &[check("pending")]), PrHealth::Conflicts);
        let clean = PullRequest {
            conflicts: None,
            ..open
        };
        assert_eq!(health_of(&clean, &[check("pending")]), PrHealth::Running);
        assert_eq!(health_of(&clean, &[]), PrHealth::Quiet);
        assert_eq!(PrHealth::Ready.as_str(), "ready");
    }
}
