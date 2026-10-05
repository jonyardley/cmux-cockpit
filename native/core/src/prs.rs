//! A workspace's pull requests and their health (src/shared/prs.ts and
//! src/shared/pr-health.ts): cmux's own when it sends any, else the one
//! the poller saved in config/state.json, and the summary a chip shows.
//! The agents sidebar's slice (Jon's own PRs, which chat opened a PR, a
//! PR's title) waits for that sidebar's port.

use std::borrow::Cow;

use crate::data::{PrStatus, PullRequest, Workspace};
use crate::js::{non_empty, num_text, truthy};
use crate::persist::{SavedCheck, SavedPr, SavedState};

/// What a PR's chip says about it: its worst state, or quiet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
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

impl PrStatus {
    /// The status as cmux writes it; None for a word the core does not
    /// know, which the TypeScript would echo as it came.
    pub fn word(self) -> Option<&'static str> {
        match self {
            PrStatus::Open => Some("open"),
            PrStatus::Merged => Some("merged"),
            PrStatus::Closed => Some("closed"),
            PrStatus::Unknown => None,
        }
    }
}

/// A merged PR: the card dims and offers Park and Close.
pub fn is_merged_pr(pr: Option<&PullRequest>) -> bool {
    pr.is_some_and(|p| truthy(p.number).is_some() && p.status == Some(PrStatus::Merged))
}

/// Everything a view shows of a PR.
#[derive(Debug, Clone, PartialEq)]
pub struct PrSummary {
    pub number: f64,
    pub status: Option<PrStatus>,
    pub url: Option<String>,
    pub health: PrHealth,
    /// The number alone, "#12".
    pub tag: String,
    /// The full words: "#35 · 1 failing", "#9 · draft · running", "#11 · merged".
    pub text: String,
    /// The words without the number: "1 failing", "draft · running", a
    /// quiet open PR's "open".
    pub state: String,
    /// Its diff size, "+120 −8"; "" when it has none.
    pub diff: String,
}

/// The chip's words after the number: a draft keeps its marker whatever
/// its health, and a PR that is not open says its status.
fn words_of(pr: &PullRequest, health: PrHealth, failing: usize) -> Vec<String> {
    if pr.status != Some(PrStatus::Open) {
        return pr
            .status
            .and_then(PrStatus::word)
            .map(str::to_string)
            .into_iter()
            .collect();
    }
    let mut words = Vec::new();
    if pr.draft == Some(true) {
        words.push("draft".to_string());
    }
    match health {
        PrHealth::Failing => words.push(format!("{failing} failing")),
        PrHealth::Quiet => {}
        h => words.push(h.as_str().to_string()),
    }
    words
}

/// A count in at most four characters, never rounded up: 950, 1.2k, 12k, 3.4M.
fn lines(n: f64) -> String {
    if n < 1000.0 {
        return num_text(n);
    }
    let (scaled, unit) = if n < 1e6 {
        (n / 1e3, "k")
    } else {
        (n / 1e6, "M")
    };
    if scaled >= 1000.0 {
        return "999M".to_string();
    }
    let shown = if scaled < 10.0 {
        (scaled * 10.0).floor() / 10.0
    } else {
        scaled.floor()
    };
    format!("{}{unit}", num_text(shown))
}

/// An open PR's diff size as "+120 −8" (a true minus sign). "" for a PR
/// that is not open, since the size is a cue for review; "" unless both
/// counts are known, so a missing one never shows as 0; and "" for an
/// empty diff.
pub fn diff_text(pr: &PullRequest) -> String {
    let (Some(add), Some(del)) = (pr.additions, pr.deletions) else {
        return String::new();
    };
    if pr.status != Some(PrStatus::Open) || (add == 0.0 && del == 0.0) {
        return String::new();
    }
    format!("+{} \u{2212}{}", lines(add), lines(del))
}

/// A PR as a view shows it, with the checks saved for it; None without a number.
pub fn summary_of(pr: &PullRequest, checks: &[SavedCheck]) -> Option<PrSummary> {
    let number = truthy(pr.number)?;
    let failing = checks.iter().filter(|c| c.state == "fail").count();
    let health = health_of(pr, checks);
    let words = words_of(pr, health, failing);
    let tag = format!("#{}", num_text(number));
    let text = std::iter::once(tag.clone())
        .chain(words.iter().cloned())
        .collect::<Vec<_>>()
        .join(" · ");
    let joined = words.join(" · ");
    let state = if joined.is_empty() {
        pr.status
            .and_then(PrStatus::word)
            .unwrap_or_default()
            .to_string()
    } else {
        joined
    };
    Some(PrSummary {
        number,
        status: pr.status,
        url: pr.url.clone(),
        health,
        tag,
        text,
        state,
        diff: diff_text(pr),
    })
}

/// The workspace's first PR as a view shows it; None without a numbered PR.
pub fn pr_summary(saved: &SavedState, w: Option<&Workspace>) -> Option<PrSummary> {
    let w = w?;
    let pr = pr_of(saved, Some(w))?;
    summary_of(&pr, checks_of(saved, w))
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

    #[test]
    fn counts_lines_in_four_characters_never_rounding_up() {
        assert_eq!(lines(950.0), "950");
        assert_eq!(lines(1000.0), "1k");
        assert_eq!(lines(1290.0), "1.2k");
        assert_eq!(lines(12_999.0), "12k");
        assert_eq!(lines(3_450_000.0), "3.4M");
        assert_eq!(lines(2e9), "999M");
    }

    #[test]
    fn sizes_only_an_open_diff_with_both_counts() {
        let open = PullRequest {
            number: Some(1.0),
            status: Some(PrStatus::Open),
            additions: Some(120.0),
            deletions: Some(8.0),
            ..PullRequest::default()
        };
        assert_eq!(diff_text(&open), "+120 \u{2212}8");
        let merged = PullRequest {
            status: Some(PrStatus::Merged),
            ..open.clone()
        };
        assert_eq!(diff_text(&merged), "");
        let half = PullRequest {
            deletions: None,
            ..open.clone()
        };
        assert_eq!(diff_text(&half), "");
        let empty = PullRequest {
            additions: Some(0.0),
            deletions: Some(0.0),
            ..open
        };
        assert_eq!(diff_text(&empty), "");
    }

    #[test]
    fn words_a_pr_by_its_status_and_health() {
        let pr = |status: PrStatus, draft: bool| PullRequest {
            number: Some(9.0),
            status: Some(status),
            draft: Some(draft),
            ..PullRequest::default()
        };
        let pending = [SavedCheck {
            name: "b".into(),
            state: "pending".into(),
        }];
        let s = summary_of(&pr(PrStatus::Open, true), &pending).unwrap();
        assert_eq!(
            (s.text.as_str(), s.state.as_str()),
            ("#9 · draft · running", "draft · running")
        );
        let s = summary_of(&pr(PrStatus::Open, false), &[]).unwrap();
        assert_eq!((s.text.as_str(), s.state.as_str()), ("#9", "open"));
        let s = summary_of(&pr(PrStatus::Merged, false), &[]).unwrap();
        assert_eq!(
            (s.text.as_str(), s.state.as_str()),
            ("#9 · merged", "merged")
        );
        let s = summary_of(&pr(PrStatus::Unknown, false), &[]).unwrap();
        assert_eq!((s.text.as_str(), s.state.as_str()), ("#9", ""));
        assert!(summary_of(&PullRequest::default(), &[]).is_none());
        assert!(is_merged_pr(Some(&pr(PrStatus::Merged, false))));
        assert!(!is_merged_pr(Some(&pr(PrStatus::Open, false))));
        assert!(!is_merged_pr(None));
    }
}
