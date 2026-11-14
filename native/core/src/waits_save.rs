//! The Cockpit's waits on Jon, saved for the agents panel (#388), as its
//! background verdicts are since #360 (running_save.rs): the panel reads
//! only config/state.json, so the core writes each workspace's waits the
//! card shows into its `waits` map, and the panel counts and names them
//! from there rather than from rules of its own, so the two never
//! disagree.
//!
//! Only the waits the core alone decides are saved: a stopped session
//! (stopped.rs), CI stuck or red with nobody on it and a change left
//! merge-ready four hours (ci_wait.rs), and parked Ostinato attempts
//! (ostinato/wait.rs), each only while it shows: waiting on Jon, not
//! dismissed, the workspace awake. Asking, Your turn, the idle nudge and
//! quiet the panel reads for itself. Nothing saved moves with the clock
//! (no ages), so an unchanged wait is never written again; only a change
//! goes out, as for the running map (`Saves`).
//!
//! A frame that cannot yet tell keeps what the file holds rather than
//! deleting it: a CI wait whose PR this frame cannot read, as its
//! dismissal and notification are kept (notify.rs `note_holds`), and a
//! park before the first Ostinato feed, for at most `PARK_GRACE_SECS`
//! after the first frame, since no feed comes while there is no record.

use std::collections::BTreeMap;

use crate::ci_wait::CiTrouble;
use crate::data::{Data, Workspace};
use crate::persist::{MAX_WAIT_DETAIL, MAX_WAITS, SavedWait, WaitKind, is_id, is_text, waits_fit};
use crate::prs::saved_pr_of;
use crate::running_save::Saves;
use crate::session::Session;
use crate::stopped::StopCause;
use crate::text::clip;

/// How long after its first frame the core keeps a saved park while no
/// Ostinato feed has come, in seconds of the frame's clock: well past the
/// runner's first look at the records, never for good, since a runner
/// with no record sends no feed at all.
pub const PARK_GRACE_SECS: f64 = 60.0;

/// What the core sent for the `waits` map, and when its first frame came.
#[derive(Debug, Clone, Default)]
pub struct WaitSaves {
    pub saves: Saves<Vec<SavedWait>>,
    first: Option<f64>,
}

impl WaitSaves {
    /// A new state file: what was sent is forgotten (`Saves::file_read`).
    pub fn file_read(&mut self) {
        self.saves.file_read();
    }

    /// Whether a park the file holds still stands in for one not yet fed,
    /// at the frame's clock `epoch`.
    fn park_grace(&mut self, session: &Session, epoch: Option<f64>) -> bool {
        if session.ostinato.fed() {
            return false;
        }
        match (self.first, epoch) {
            (Some(first), Some(now)) => now - first < PARK_GRACE_SECS,
            (None, Some(now)) => {
                self.first = Some(now);
                true
            }
            (_, None) => true,
        }
    }

    /// The writes that bring the file's `waits` to the frame's: None
    /// before the state file is read or while the frame lists no
    /// workspaces, so neither ever deletes every saved wait.
    pub fn writes(
        &mut self,
        session: &Session,
        data: &Data,
    ) -> Option<BTreeMap<String, Option<Vec<SavedWait>>>> {
        let grace = self.park_grace(session, data.epoch);
        let now = waits(session, data, grace)?;
        Some(self.saves.writes(&session.saved.waits, &now, data.epoch))
    }
}

/// A stop's cause as one word.
fn cause_word(cause: StopCause) -> &'static str {
    match cause {
        StopCause::Error => "error",
        StopCause::Gone => "gone",
        StopCause::Silent => "silent",
    }
}

/// `text` cut to fit a wait's detail, or None when it cannot.
fn detail(text: &str) -> Option<String> {
    let cut = clip(text.trim(), MAX_WAIT_DETAIL);
    is_text(&cut, MAX_WAIT_DETAIL).then_some(cut)
}

fn ci_kind(trouble: CiTrouble) -> WaitKind {
    match trouble {
        CiTrouble::Stuck => WaitKind::CiStuck,
        CiTrouble::Failing => WaitKind::CiFailing,
        CiTrouble::MergeReady => WaitKind::MergeReady,
    }
}

fn is_ci(kind: WaitKind) -> bool {
    matches!(
        kind,
        WaitKind::CiStuck | WaitKind::CiFailing | WaitKind::MergeReady
    )
}

/// The file's waits for `w` of the kinds `keep` picks.
fn held(session: &Session, w: &Workspace, keep: fn(WaitKind) -> bool) -> Vec<SavedWait> {
    session
        .saved
        .waits
        .get(&w.id)
        .into_iter()
        .flatten()
        .filter(|v| keep(v.kind))
        .cloned()
        .collect()
}

/// Each stopped session the card shows: one with a status, its stop not
/// dismissed, its workspace awake (`Session::stop_of`).
fn stops(session: &Session, w: &Workspace) -> Vec<SavedWait> {
    w.agent_list()
        .filter(|a| a.status.is_some() && is_id(&a.id))
        .filter_map(|a| {
            let stop = session.stop_of(a, Some(w))?;
            (!session.dismissed_key(&w.id, &a.id, stop.since)).then(|| SavedWait {
                kind: WaitKind::Stopped,
                since: stop.since,
                key: stop.since,
                agent: Some(a.id.clone()),
                detail: Some(cause_word(stop.cause).to_string()),
                check: None,
                queued: None,
            })
        })
        .collect()
}

/// The card's CI wait as it shows (`Session::ci_shown`). With none read
/// for `w` this frame, the file's is kept while its PR, still the card's,
/// cannot be read and nothing else took it off the card.
fn ci(session: &Session, data: &Data, w: &Workspace) -> Vec<SavedWait> {
    if let Some(ci) = session.ci_shown(Some(w)) {
        let stuck = ci.trouble == CiTrouble::Stuck;
        return vec![SavedWait {
            kind: ci_kind(ci.trouble),
            since: ci.since,
            key: ci.key,
            agent: None,
            detail: detail(&ci.pr),
            check: ci.check.clone().filter(|_| stuck),
            queued: stuck.then_some(ci.key),
        }];
    }
    if session.ci.contains_key(&w.id) || saved_pr_of(&session.saved, w).is_none() {
        return Vec::new();
    }
    held(session, w, is_ci)
        .into_iter()
        .filter(|v| session.ci_unsure(w, v.key) && session.ci_would_wait(data, w, v.key))
        .collect()
}

/// The card's park as it shows (`Session::park_shown`), or the file's
/// while `grace` holds.
fn park(session: &Session, w: &Workspace, grace: bool) -> Vec<SavedWait> {
    if let Some(p) = session.park_shown(Some(w)) {
        return vec![SavedWait {
            kind: WaitKind::Park,
            since: p.key,
            key: p.key,
            agent: None,
            detail: detail(&session.park_detail(Some(w), MAX_WAIT_DETAIL)),
            check: None,
            queued: None,
        }];
    }
    if grace && session.sleep_kind(&w.id).is_none() {
        return held(session, w, |k| k == WaitKind::Park);
    }
    Vec::new()
}

/// Each workspace's waits in `data` that its card shows, in a fixed order
/// (stops by agent, then CI, then the park), for every workspace with
/// any. None before the state file is read or when the frame lists no
/// workspaces, so neither deletes every saved wait. Only waits the state
/// file's contract keeps (`SavedWait::fits`) are given, so the script
/// never refuses one that would then go out again.
pub fn waits(
    session: &Session,
    data: &Data,
    grace: bool,
) -> Option<BTreeMap<String, Vec<SavedWait>>> {
    if !session.state_read {
        return None;
    }
    let list = data.workspaces.as_deref().filter(|l| !l.is_empty())?;
    let mut out = BTreeMap::new();
    for w in list.iter().filter(|w| is_id(&w.id)) {
        let mut found = stops(session, w);
        found.sort_by(|a, b| a.agent.cmp(&b.agent));
        found.extend(ci(session, data, w));
        found.extend(park(session, w, grace));
        let mut kept: Vec<SavedWait> = found.into_iter().filter(SavedWait::fits).collect();
        kept.truncate(MAX_WAITS);
        if waits_fit(&kept) {
            out.insert(w.id.clone(), kept);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use crate::app::{Cockpit, Effect, Event, Model};
    use crate::data::Data;
    use crate::persist::SavedState;
    use crux_core::App;

    /// A core that has read the state file `state`, the panel on when
    /// `sidebar`.
    fn core(state: &str, sidebar: bool) -> Model {
        let mut m = Model::default();
        if sidebar {
            let _ = Cockpit.update(Event::PanelOn, &mut m);
        }
        let _ = Cockpit.update(Event::State(Box::new(read(state))), &mut m);
        m
    }

    fn read(state: &str) -> SavedState {
        SavedState::from_json(state).unwrap()
    }

    /// The waits `event` saves, as JSON: one object per save.
    fn saved(m: &mut Model, event: Event) -> Vec<serde_json::Value> {
        let mut cmd = Cockpit.update(event, m);
        cmd.effects()
            .filter_map(|e| match e {
                Effect::SaveWaits(r) => serde_json::to_value(r.operation.waits).ok(),
                _ => None,
            })
            .collect()
    }

    /// A frame at epoch `now` with workspace W, its one agent `agent`.
    fn frame(now: f64, agent: serde_json::Value) -> Event {
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": now,
            "workspaces": [
                {"id": "W", "title": "fix login", "branch": "feat", "agents": [agent]},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap();
        Event::Data(data)
    }

    /// W's agent `c`, stopped on an error at `since`.
    fn stopped(since: f64) -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "working",
            "sinceEpoch": 900, "lastActivityAt": 900,
            "stopped": {"cause": "error", "since": since}})
    }

    fn idle() -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "idle",
            "sinceEpoch": 900, "lastActivityAt": 900})
    }

    fn working(now: f64) -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "working",
            "sinceEpoch": now, "lastActivityAt": now})
    }

    const STOP: &str =
        r#"{"kind": "stopped", "since": 1000.0, "key": 1000.0, "agent": "c", "detail": "error"}"#;

    /// The state file with W's PR #12 "Docs layout" carrying `checks`,
    /// and `extra` beside it.
    fn with_pr(checks: &str, extra: &str) -> String {
        format!(
            r#"{{"prs": {{"W": {{"number": 12, "url": "https://github.com/o/r/pull/12",
                "status": "open", "branch": "feat", "title": "Docs layout",
                "checks": {checks}}}}}{extra}}}"#
        )
    }

    const QUEUED: &str = r#"[{"name": "build", "state": "pending", "queued": 1000}]"#;

    #[test]
    fn the_sidebars_core_saves_a_stop_once_until_the_file_shows_it() {
        let mut m = core("{}", true);
        let want: serde_json::Value =
            serde_json::from_str(&format!(r#"{{"W": [{STOP}]}}"#)).unwrap();
        assert_eq!(saved(&mut m, frame(1060.0, stopped(1000.0))), [want]);
        assert!(
            saved(&mut m, frame(1100.0, stopped(1000.0))).is_empty(),
            "sent already"
        );
        assert_eq!(
            saved(&mut m, frame(1120.0, stopped(1000.0))).len(),
            1,
            "a minute on, the file still lacks it: the save failed"
        );
        // The file shows it: nothing, however late. Back at work: a delete.
        let shown = format!(r#"{{"waits": {{"W": [{STOP}]}}}}"#);
        assert!(saved(&mut m, Event::State(Box::new(read(&shown)))).is_empty());
        assert!(saved(&mut m, frame(5000.0, stopped(1000.0))).is_empty());
        assert_eq!(
            saved(&mut m, frame(5100.0, working(5100.0))),
            [serde_json::json!({"W": null})]
        );
    }

    #[test]
    fn the_panes_core_never_saves() {
        let mut m = core("{}", false);
        assert!(saved(&mut m, frame(1060.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn a_dismissed_or_asleep_stop_is_not_saved() {
        let mut m = core(r#"{"dismissed": {"W": {"c": 1000}}}"#, true);
        assert!(saved(&mut m, frame(1060.0, stopped(1000.0))).is_empty());
        let asleep = r#"{"asleep": {"W": {"surfaces": ["s1"], "since": 990}}}"#;
        let mut m = core(asleep, true);
        assert!(saved(&mut m, frame(1060.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn stuck_ci_saves_its_check_and_never_moves_with_the_clock() {
        let mut m = core(&with_pr(QUEUED, ""), true);
        let at = 1000.0 + 40.0 * 60.0;
        let wait = serde_json::json!({"kind": "ci_stuck", "since": 1600.0, "key": 1000.0,
            "detail": "Docs layout", "check": "build", "queued": 1000.0});
        assert_eq!(
            saved(&mut m, frame(at, idle())),
            [serde_json::json!({ "W": [wait.clone()] })]
        );
        let shown = with_pr(QUEUED, &format!(r#", "waits": {{"W": [{wait}]}}"#));
        assert!(saved(&mut m, Event::State(Box::new(read(&shown)))).is_empty());
        for later in [at + 600.0, at + 1200.0, at + 7200.0] {
            assert!(saved(&mut m, frame(later, idle())).is_empty(), "{later}");
        }
    }

    #[test]
    fn red_ci_and_a_change_left_ready_save_their_kinds() {
        let failed = r#"[{"name": "build", "state": "fail", "started": 800}]"#;
        let mut red = core(&with_pr(failed, ""), true);
        assert_eq!(
            saved(&mut red, frame(1020.0, idle())),
            [
                serde_json::json!({"W": [{"kind": "ci_failing", "since": 900.0,
                "key": 800.0, "detail": "Docs layout"}]})
            ]
        );
        let passed = r#"[{"name": "build", "state": "pass", "started": 800}], "mergeable": true, "readySince": 1000"#;
        let mut ready = core(&with_pr(passed, ""), true);
        let due = 1000.0 + crate::merge_wait::MERGE_WAIT_SECS;
        assert_eq!(
            saved(&mut ready, frame(due + 60.0, idle())),
            [
                serde_json::json!({"W": [{"kind": "merge_ready", "since": due,
                "key": 1000.0, "detail": "Docs layout"}]})
            ]
        );
    }

    #[test]
    fn a_ci_wait_whose_pr_cannot_be_read_is_kept_until_it_ends() {
        let wait = r#"{"kind": "ci_failing", "since": 900, "key": 800, "detail": "Docs layout"}"#;
        let failed = r#"[{"name": "build", "state": "fail", "started": 800}]"#;
        let unknown = with_pr(failed, &format!(r#", "waits": {{"W": [{wait}]}}"#))
            .replace(r#""status": "open""#, r#""status": "unknown""#);
        let mut m = core(&unknown, true);
        assert!(saved(&mut m, frame(1050.0, idle())).is_empty(), "kept");
        let merged = unknown.replace(r#""status": "unknown""#, r#""status": "merged""#);
        assert_eq!(
            saved(&mut m, Event::State(Box::new(read(&merged)))),
            [serde_json::json!({"W": null})]
        );
    }

    #[test]
    fn a_park_is_kept_for_a_minute_before_the_first_feed() {
        let park = r#"{"waits": {"W": [{"kind": "park", "since": 500, "key": 500,
            "detail": "Ostinato parked notes-app#41"}]}}"#;
        let mut m = core(park, true);
        assert!(saved(&mut m, frame(1000.0, idle())).is_empty());
        assert!(saved(&mut m, frame(1059.0, idle())).is_empty());
        assert_eq!(
            saved(&mut m, frame(1060.0, idle())),
            [serde_json::json!({"W": null})],
            "no feed came"
        );
    }

    #[test]
    fn says_nothing_before_the_file_is_read_or_with_no_workspaces() {
        let mut m = Model::default();
        let _ = Cockpit.update(Event::PanelOn, &mut m);
        assert!(saved(&mut m, frame(1060.0, stopped(1000.0))).is_empty());
        let held = format!(r#"{{"waits": {{"W": [{STOP}]}}}}"#);
        let mut m = core(&held, true);
        let empty: Data =
            serde_json::from_value(serde_json::json!({"epoch": 1000, "workspaces": []})).unwrap();
        assert!(saved(&mut m, Event::Data(empty)).is_empty());
        assert!(saved(&mut m, Event::Data(Data::default())).is_empty());
    }
}
