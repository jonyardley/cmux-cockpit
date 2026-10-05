//! What `git` and `gh` say about a directory's PR, read as
//! scripts/pr-poll.ts reads it: the same command, the same fields, the
//! same pick of PR and checks, and the same reading of a failure. The
//! shell runs the commands and hands their raw results here, so every
//! rule is tested without a process.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde_json::{Map, Value};

use super::{GhFailure, PollAnswer};
use crate::data::PrStatus;
use crate::persist::{SavedCheck, SavedPr};

/// The fields the PR pick reads (PR_FIELDS in scripts/pr-poll.ts).
pub const PR_FIELDS: &str = "number,state,url,headRefName,updatedAt,isCrossRepository,isDraft,mergeStateStatus,statusCheckRollup,title,additions,deletions";

/// Checks kept per PR (MAX_CHECKS in scripts/state-config.ts).
pub const MAX_CHECKS: usize = 20;

/// The longest title kept, in UTF-16 units (MAX_LABEL).
const MAX_LABEL: usize = 120;

/// The longest check name kept, in UTF-16 units.
const MAX_CHECK_NAME: usize = 64;

/// The arguments for `git`, run in the directory, that print its branch.
pub fn git_args(directory: &str) -> Vec<String> {
    ["-C", directory, "branch", "--show-current"]
        .map(str::to_string)
        .to_vec()
}

/// The arguments for `gh`, run in the directory, that list the branch's PRs.
pub fn gh_args(branch: &str) -> Vec<String> {
    let args = [
        "pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", PR_FIELDS,
    ];
    args.map(str::to_string).to_vec()
}

/// One finished command, or one that never started (`missing`) or was
/// killed (no status).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ran {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub missing: bool,
}

/// What `git branch --show-current` says (branchFromGit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Branch {
    On(String),
    /// A detached HEAD, or not a repo.
    None,
    /// git failed or was killed, so nothing can be said.
    Unknown,
}

/// Reads git's answer: a branch, none, or unknown.
pub fn branch_from_git(r: &Ran) -> Branch {
    match r.status {
        None => Branch::Unknown,
        Some(0) => match r.stdout.trim() {
            "" => Branch::None,
            b => Branch::On(b.to_string()),
        },
        Some(_) if r.stderr.contains("not a git repository") => Branch::None,
        Some(_) => Branch::Unknown,
    }
}

/// What one gh call says about reaching GitHub (ghOutcome): answered, or
/// why not. A failure about the directory's repo rather than gh is Repo.
pub fn gh_outcome(r: &Ran) -> Result<(), GhFailure> {
    if r.missing {
        return Err(GhFailure::Missing);
    }
    if r.status == Some(0) {
        return Ok(());
    }
    let said = r.stderr.to_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| said.contains(w));
    if any(&["auth login", "not logged in"]) {
        return Err(GhFailure::SignedOut);
    }
    let repo = [
        "not a git repository",
        "no git remotes",
        "none of the git remotes",
        "set-default",
        "http 404",
    ];
    if any(&repo) {
        return Err(GhFailure::Repo);
    }
    Err(GhFailure::Unavailable)
}

/// The whole answer for one directory, from git's run and, once the
/// branch is known, gh's.
pub fn answer(git: &Ran, gh: impl FnOnce(&str) -> Ran) -> PollAnswer {
    let branch = match branch_from_git(git) {
        Branch::On(b) => b,
        Branch::None => return PollAnswer::NoBranch,
        Branch::Unknown => return PollAnswer::GitFailed,
    };
    let ran = gh(&branch);
    if let Err(why) = gh_outcome(&ran) {
        return PollAnswer::Failed { branch, why };
    }
    match pick_pr(&ran.stdout, &branch) {
        Some(pr) => PollAnswer::Answered { branch, pr },
        None => PollAnswer::Failed {
            branch,
            why: GhFailure::Unreadable,
        },
    }
}

/// A C0 or C1 control character, or DEL: what the cleaners turn to a space.
fn is_control(c: char) -> bool {
    let code = u32::from(c);
    code < 32 || code == 127 || (0x80..=0x9f).contains(&code)
}

/// JavaScript's `\s`, which takes in the byte order mark Rust does not.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// The first whole code points of `s` that fit in `max` UTF-16 units (cutTo).
fn cut_to(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for c in s.chars() {
        len += c.len_utf16();
        if len > max {
            break;
        }
        out.push(c);
    }
    out
}

/// Runs of `\s` as one space, as `replaceAll(/\s+/g, " ")`.
fn one_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A PR title as a label (cleanTitle): control characters become spaces,
/// runs of space one space, cut to MAX_LABEL in whole code points, then
/// trimmed. Empty when nothing readable is left.
pub fn clean_title(title: &str) -> String {
    let spaced: String = title
        .chars()
        .map(|c| if is_control(c) { ' ' } else { c })
        .collect();
    cut_to(&one_space(&spaced), MAX_LABEL)
        .trim_matches(is_js_space)
        .to_string()
}

fn text<'v>(o: &'v Map<String, Value>, key: &str) -> Option<&'v str> {
    o.get(key).and_then(Value::as_str)
}

/// A finished check run's conclusion that lets a required check through.
const PASSING: [&str; 3] = ["SUCCESS", "NEUTRAL", "SKIPPED"];

/// A CheckRun or a StatusContext in three states (checkState).
fn check_state(c: &Map<String, Value>) -> &'static str {
    if text(c, "__typename") == Some("StatusContext") {
        return match text(c, "state") {
            Some("SUCCESS") => "pass",
            Some("PENDING" | "EXPECTED") => "pending",
            _ => "fail",
        };
    }
    if text(c, "status") != Some("COMPLETED") {
        return "pending";
    }
    match text(c, "conclusion") {
        Some(c) if PASSING.contains(&c) => "pass",
        _ => "fail",
    }
}

struct Rolled {
    id: String,
    started_at: String,
    check: SavedCheck,
}

fn rolled(c: &Value) -> Option<Rolled> {
    let c = c.as_object()?;
    let name = match c.get("name") {
        Some(Value::String(n)) => n.as_str(),
        _ => text(c, "context")?,
    };
    if name.trim().is_empty() {
        return None;
    }
    let workflow = text(c, "workflowName").unwrap_or("");
    let shown = cut_to(name.trim(), MAX_CHECK_NAME).trim().to_string();
    Some(Rolled {
        id: format!("{workflow}\n{name}"),
        started_at: text(c, "startedAt").unwrap_or("").to_string(),
        check: SavedCheck {
            name: shown,
            state: check_state(c).to_string(),
        },
    })
}

/// A queued run has no start yet, and is its check's newest, so it sorts last.
fn start_key(at: &str) -> &str {
    if at.is_empty() || at.starts_with("0001-") {
        "\u{ffff}"
    } else {
        at
    }
}

fn state_rank(state: &str) -> u8 {
    match state {
        "fail" => 0,
        "pending" => 1,
        _ => 2,
    }
}

/// Names in an order close to `localeCompare`: case folded first, then
/// as written, so the order never depends on the input's.
fn by_name(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// The checks from gh's statusCheckRollup (checksFrom): the latest started
/// run of each workflow and name, failing first, then running, then
/// passed, by name within each, at most MAX_CHECKS.
pub fn checks_from(rollup: Option<&Value>) -> Vec<SavedCheck> {
    let Some(list) = rollup.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut latest: Vec<Rolled> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for c in list.iter().filter_map(rolled) {
        match at.get(&c.id) {
            Some(&i) => {
                if let Some(seen) = latest.get_mut(i)
                    && start_key(&c.started_at) >= start_key(&seen.started_at)
                {
                    *seen = c;
                }
            }
            None => {
                at.insert(c.id.clone(), latest.len());
                latest.push(c);
            }
        }
    }
    let mut checks: Vec<SavedCheck> = latest.into_iter().map(|r| r.check).collect();
    checks.sort_by(|a, b| {
        state_rank(&a.state)
            .cmp(&state_rank(&b.state))
            .then_with(|| by_name(&a.name, &b.name))
    });
    checks.truncate(MAX_CHECKS);
    checks
}

/// A line count as the poller keeps one: a whole number, not negative.
fn line_count(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    const SAFE: f64 = 9_007_199_254_740_991.0;
    (n.fract() == 0.0 && (0.0..=SAFE).contains(&n)).then_some(n)
}

/// A PR from gh's list, before it is cut down to a SavedPr.
struct Listed {
    pr: SavedPr,
    updated_at: String,
    fork: bool,
}

fn listed(p: &Value) -> Option<Listed> {
    let p = p.as_object()?;
    let status = match text(p, "state")? {
        "OPEN" => PrStatus::Open,
        "MERGED" => PrStatus::Merged,
        "CLOSED" => PrStatus::Closed,
        _ => return None,
    };
    let number = p.get("number")?.as_f64()?;
    let url = text(p, "url")?.to_string();
    let branch = text(p, "headRefName").filter(|b| !b.is_empty())?;
    let title = clean_title(text(p, "title").unwrap_or(""));
    let checks = checks_from(p.get("statusCheckRollup"));
    let merge = text(p, "mergeStateStatus");
    let pr = SavedPr {
        number,
        url,
        status,
        branch: branch.to_string(),
        draft: (p.get("isDraft") == Some(&Value::Bool(true))).then_some(true),
        mergeable: (merge == Some("CLEAN")).then_some(true),
        conflicts: (merge == Some("DIRTY")).then_some(true),
        title: (!title.is_empty()).then_some(title),
        additions: line_count(p.get("additions")),
        deletions: line_count(p.get("deletions")),
        checks: (!checks.is_empty()).then_some(checks),
    };
    Some(Listed {
        pr,
        updated_at: text(p, "updatedAt").unwrap_or("").to_string(),
        fork: p.get("isCrossRepository") == Some(&Value::Bool(true)),
    })
}

/// The branch's PR from `gh pr list --json PR_FIELDS` (pickPr): an open one
/// first, else the most recently updated, never a fork's. `Some(None)` when
/// there is none; None when the output cannot be read.
pub fn pick_pr(text: &str, branch: &str) -> Option<Option<SavedPr>> {
    let v: Value = serde_json::from_str(text).ok()?;
    let mut prs: Vec<Listed> = v
        .as_array()?
        .iter()
        .filter_map(listed)
        .filter(|l| l.pr.branch == branch && !l.fork)
        .collect();
    prs.sort_by(|a, b| {
        let open = |l: &Listed| l.pr.status == PrStatus::Open;
        open(b)
            .cmp(&open(a))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    Some(prs.into_iter().next().map(|l| l.pr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::utf16_len;

    fn ran(status: Option<i32>, stdout: &str, stderr: &str) -> Ran {
        Ran {
            status,
            stdout: stdout.into(),
            stderr: stderr.into(),
            missing: false,
        }
    }

    #[test]
    fn reads_gits_branch_none_or_unknown() {
        assert_eq!(
            branch_from_git(&ran(Some(0), "feat\n", "")),
            Branch::On("feat".into())
        );
        assert_eq!(branch_from_git(&ran(Some(0), "\n", "")), Branch::None);
        let not_repo = ran(Some(128), "", "fatal: not a git repository");
        assert_eq!(branch_from_git(&not_repo), Branch::None);
        assert_eq!(branch_from_git(&ran(Some(1), "", "boom")), Branch::Unknown);
        assert_eq!(branch_from_git(&ran(None, "", "")), Branch::Unknown);
    }

    #[test]
    fn reads_why_gh_failed_as_the_ts_poll_does() {
        assert_eq!(gh_outcome(&ran(Some(0), "[]", "")), Ok(()));
        let missing = Ran {
            missing: true,
            ..Ran::default()
        };
        assert_eq!(gh_outcome(&missing), Err(GhFailure::Missing));
        let signed_out = ran(Some(4), "", "To get started, run: gh auth login");
        assert_eq!(gh_outcome(&signed_out), Err(GhFailure::SignedOut));
        let no_remote = ran(Some(1), "", "no git remotes found");
        assert_eq!(gh_outcome(&no_remote), Err(GhFailure::Repo));
        let gone = ran(Some(1), "", "HTTP 404: Not Found");
        assert_eq!(gh_outcome(&gone), Err(GhFailure::Repo));
        assert_eq!(
            gh_outcome(&ran(None, "", "")),
            Err(GhFailure::Unavailable),
            "a timeout"
        );
    }

    #[test]
    fn the_command_is_the_ts_polls() {
        assert_eq!(
            gh_args("feat").join(" "),
            format!("pr list --head feat --state all --limit 5 --json {PR_FIELDS}")
        );
        assert_eq!(git_args("/d").join(" "), "-C /d branch --show-current");
    }

    const LIST: &str = r#"[
        {"number": 3, "state": "CLOSED", "url": "u3", "headRefName": "feat", "updatedAt": "2026-10-05T09:00:00Z"},
        {"number": 4, "state": "OPEN", "url": "u4", "headRefName": "feat", "isCrossRepository": true},
        {"number": 5, "state": "OPEN", "url": "u5", "headRefName": "feat", "updatedAt": "2026-10-01T00:00:00Z",
         "isDraft": true, "mergeStateStatus": "DIRTY", "title": "Poll\u0007 the   PRs ",
         "additions": 12, "deletions": 1.5,
         "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "build", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-10-01T00:00:00Z"},
            {"__typename": "CheckRun", "name": "build", "workflowName": "CI", "status": "IN_PROGRESS", "startedAt": "2026-10-01T00:05:00Z"},
            {"__typename": "CheckRun", "name": "Lint", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"__typename": "StatusContext", "context": "deploy", "state": "ERROR"},
            {"__typename": "CheckRun", "name": "  ", "status": "COMPLETED"}
         ]},
        {"number": 6, "state": "OPEN", "url": "u6", "headRefName": "other"}
    ]"#;

    #[test]
    fn picks_the_open_pr_on_the_branch_never_a_forks() {
        let pr = pick_pr(LIST, "feat").flatten().unwrap();
        assert_eq!(pr.number, 5.0);
        assert_eq!(pr.draft, Some(true));
        assert_eq!(pr.conflicts, Some(true));
        assert_eq!(pr.mergeable, None);
        assert_eq!(pr.title.as_deref(), Some("Poll the PRs"));
        assert_eq!(pr.additions, Some(12.0));
        assert_eq!(pr.deletions, None, "not a whole number");
        let checks: Vec<(&str, &str)> = pr
            .checks
            .iter()
            .flatten()
            .map(|c| (c.name.as_str(), c.state.as_str()))
            .collect();
        assert_eq!(
            checks,
            [("deploy", "fail"), ("build", "pending"), ("Lint", "pass")],
            "the latest run of build wins, failing first"
        );
    }

    #[test]
    fn with_no_open_pr_the_latest_updated_wins_and_none_is_none() {
        let closed = r#"[
            {"number": 1, "state": "MERGED", "url": "a", "headRefName": "b", "updatedAt": "2026-01-01"},
            {"number": 2, "state": "CLOSED", "url": "c", "headRefName": "b", "updatedAt": "2026-02-01"}
        ]"#;
        assert_eq!(pick_pr(closed, "b").flatten().map(|p| p.number), Some(2.0));
        assert_eq!(pick_pr("[]", "b"), Some(None));
        assert_eq!(pick_pr("{}", "b"), None, "not a list");
        assert_eq!(pick_pr("nope", "b"), None);
    }

    #[test]
    fn a_title_is_cut_in_whole_code_points() {
        let long = "😀".repeat(70);
        let cut = clean_title(&long);
        assert_eq!(utf16_len(&cut), 120);
        assert_eq!(clean_title("\u{85}\u{feff} "), "");
    }

    #[test]
    fn the_answer_follows_git_then_gh() {
        let on = ran(Some(0), "feat\n", "");
        let asked = answer(&on, |b| {
            ran(
                Some(0),
                &format!(r#"[{{"number": 9, "state": "OPEN", "url": "u", "headRefName": "{b}"}}]"#),
                "",
            )
        });
        assert!(matches!(asked, PollAnswer::Answered { pr: Some(ref p), .. } if p.number == 9.0));
        let failed = answer(&on, |_| ran(Some(1), "", "network down"));
        assert_eq!(
            failed,
            PollAnswer::Failed {
                branch: "feat".into(),
                why: GhFailure::Unavailable
            }
        );
        let unreadable = answer(&on, |_| ran(Some(0), "<html>", ""));
        assert!(matches!(
            unreadable,
            PollAnswer::Failed {
                why: GhFailure::Unreadable,
                ..
            }
        ));
        let never = |_: &str| -> Ran { unreachable!("gh is not asked without a branch") };
        assert_eq!(answer(&ran(Some(0), "", ""), never), PollAnswer::NoBranch);
        assert_eq!(answer(&ran(None, "", ""), never), PollAnswer::GitFailed);
    }
}
