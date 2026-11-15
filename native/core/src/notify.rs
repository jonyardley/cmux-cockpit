//! A desktop notification for each new wait no session announces (issue
//! #379). Claude Code already posts a cmux notification when a session
//! asks or its turn ends, so Asking and Your turn never post here. The
//! waits it has no session to announce do: a stopped session
//! (stopped.rs), CI stuck or red with nobody on it, and a change left
//! merge-ready four hours (ci_wait.rs).
//!
//! The core decides and the runner sends, as with every cmux call. Each
//! frame, the core that draws the sidebar (`Event::PanelOn`, so the
//! pane's never doubles a banner) reads each card as Needs you shows it:
//! a card whose agent waits on Jon and carries a stop or its workspace's
//! CI has a wait that notifies, keyed on the card and the instant the wait
//! began (`since`). A key with no notification yet asks the runner to post
//! one (`Effect::Notify`, `cmux notify --workspace <id> --title <title>
//! --body <body> --json`), which answers with the id cmux gave it
//! (`Event::Notified`). When the wait clears (answered, merged, dismissed
//! from Needs you, asleep, or the card gone), the core asks the runner to
//! dismiss it by that id (`Effect::DismissNotification`, `cmux
//! dismiss-notification --id <id>`), so cmux's dock badge drops with it.
//!
//! Each card's record lives in the state file's `notified` map
//! (persist.rs `SavedNote`), written as the post goes out and again with
//! the id, so a restart neither posts it again nor loses the id. The id is
//! forgotten as the dismiss goes out, whatever cmux answers: a
//! notification Jon already cleared answers not_found, and nothing tries
//! again. The record stays after that, marked down, so a wait that comes
//! back (Restore needs you, say) never posts twice; a new wait on the same
//! card has a new start and posts again. A CI wait is keyed on its checks'
//! own time too (`same_wait`): a rerun that fails again posts anew, and a
//! start that moves only because a session beside it ended does not,
//! whether the post is up, on its way or failed.
//!
//! A card missing from the list may be in another window, so it is taken
//! down but its record kept a week. Nothing is decided on a frame that
//! lists no workspaces, nor before the state file is read. A CI wait
//! whose PR, still on the card's branch, cannot be read this frame
//! (`Session::ci_unsure`) keeps its notification, as it keeps its
//! dismissal, since nothing says it ended, unless something else took it
//! off the card: a session at it, sleep, or a dismissal.

use crux_core::capability::Operation;
use serde::{Deserialize, Serialize};

use crate::data::{AgentStatus, Data, Workspace};
use crate::js::truthy;
use crate::persist::{SavedNote, is_uuid};
use crate::prs::saved_pr_of;
use crate::session::{Outbound, Session};
use crate::text::clean_title;

/// A card's title when it has none worth showing.
pub const NO_TITLE: &str = "A session";

/// How long a record outlives its card leaving the list, from when it was
/// taken down: a week. A card that comes back sooner with the same wait
/// never posts it again.
pub const FORGET_GONE_SECS: f64 = 7.0 * 24.0 * 60.0 * 60.0;

/// One desktop notification for the runner to post, as `cmux notify
/// --workspace <workspace> --title <title> --body <body> --json`. The
/// answer carries `workspace` and `since` back (`Notified`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyPost {
    pub workspace: String,
    /// When the wait began, in epoch seconds: the key it posts under.
    pub since: f64,
    pub title: String,
    pub body: String,
}

impl Operation for NotifyPost {
    type Output = ();
}

/// A notification for the runner to dismiss, as `cmux dismiss-notification
/// --id <id>`. Nothing answers: the core forgot the id as it asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyDismiss {
    pub id: String,
}

impl Operation for NotifyDismiss {
    type Output = ();
}

/// The runner's answer to a post: the id cmux gave the notification, or
/// None when it was not posted (cmux refused, or never answered).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notified {
    pub workspace: String,
    pub since: f64,
    #[serde(default)]
    pub id: Option<String>,
}

/// A card's wait that notifies, as this frame reads it.
#[derive(Debug, Clone, PartialEq)]
struct Wait {
    since: f64,
    /// The CI wait's own key, for a CI wait.
    ci: Option<f64>,
    title: String,
    body: String,
}

/// Whether `note` was posted for `wait`. A stop is its start. A CI wait
/// is its checks' key too, so a rerun that fails again is a new wait; and
/// until it is taken down (up, on its way, or failed), the key alone,
/// since a stuck or red wait's start moves with its sessions' (ci_wait.rs
/// `CiWait::since`): an idle session ending, or another finishing beside
/// it, moves it without a new wait. Once taken down (a session took it
/// up), a new start is a new wait; the take down records the start it
/// had then (`take_down`).
fn same_wait(note: &SavedNote, wait: &Wait) -> bool {
    match (note.ci, wait.ci) {
        (None, None) => note.since == wait.since,
        (Some(was), Some(now)) => was == now && (note.since == wait.since || note.down.is_none()),
        (Some(_), None) | (None, Some(_)) => false,
    }
}

/// A workspace's title in plain words, else its agent tab's, else
/// `NO_TITLE`.
fn card_title(w: &Workspace, tab: Option<&str>) -> String {
    let own = |t: Option<&str>| {
        clean_title(t)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    [own(w.title.as_deref()), own(tab)]
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or_else(|| NO_TITLE.to_string())
}

impl Session {
    /// The card's wait that notifies, if it shows one in Needs you: its
    /// agent, as the sidebars show it, waits on Jon and stopped or carries
    /// the workspace's CI. Asking and Your turn carry neither. The title is
    /// the change (a CI wait's PR) or the session (the card's title), the
    /// body the Needs you line: "CI stuck 40m: rerun?", "Stopped on an
    /// error: Please run /login".
    fn notifying_wait(&mut self, data: &Data, w: &Workspace) -> Option<Wait> {
        let a = self.agent_of(Some(w))?;
        if a.status != Some(AgentStatus::NeedsInput) {
            return None;
        }
        let since = truthy(a.since_epoch)?;
        let card = card_title(w, a.tab_title.as_deref());
        if self.stop_of(&a, Some(w)).is_some() {
            let detail = self.needs_detail(Some(w));
            let body = self.wait_line(data, Some(w), &detail)?;
            return Some(Wait {
                since,
                ci: None,
                title: card,
                body,
            });
        }
        a.ci?;
        let ci = self.ci_shown(Some(w))?;
        let (key, pr) = (ci.key, ci.pr.clone());
        let body = self.wait_line(data, Some(w), "")?;
        Some(Wait {
            since,
            ci: Some(key),
            title: if pr.is_empty() { card } else { pr },
            body,
        })
    }

    /// Whether a notification recorded as `note` stays up in `w`, whose
    /// card shows no wait that notifies: a CI wait before the PR poll's
    /// first read, or one whose saved PR, still the card's own
    /// (`saved_pr_of`), this frame could not read (`ci_unsure`) when
    /// nothing else took the wait off the card (a session at it, sleep,
    /// or a dismissal: `ci_would_wait`).
    fn note_holds(&self, data: &Data, w: &Workspace, note: &SavedNote) -> bool {
        let Some(key) = note.ci else { return false };
        !self.ci_read
            || (!self.ci.contains_key(&w.id)
                && saved_pr_of(&self.saved, w).is_some()
                && self.ci_unsure(w, key)
                && self.ci_would_wait(data, w, key))
    }

    /// Takes a card's notification down at epoch `now`: dismissed by its
    /// id when it has one, and its record kept, marked down, so the same
    /// wait never posts again. A CI record takes the start its wait reads
    /// now, so the wait restored after a session beside it moved that
    /// start is still the same wait.
    fn take_down(&mut self, ws: &str, note: SavedNote, now: Option<f64>) {
        if let Some(id) = note.id.clone() {
            self.dismiss_note(id);
        }
        let since = self
            .ci
            .get(ws)
            .filter(|ci| note.ci == Some(ci.key))
            .map_or(note.since, |ci| ci.since);
        let down = SavedNote {
            since,
            id: None,
            down: Some(now.map_or(note.since, |t| t.max(note.since))),
            ..note
        };
        self.set_note(ws, Some(down));
    }

    /// Sets or deletes a workspace's record, here at once and in the state file.
    fn set_note(&mut self, ws: &str, note: Option<SavedNote>) {
        let value = match note.map(serde_json::to_value).transpose() {
            Ok(v) => v,
            // A record is four plain fields, so this never happens.
            Err(_) => return,
        };
        let key = format!("notified.{ws}");
        self.saved.set_entry(&key, value.as_ref());
        self.persist_set(key, value);
    }

    /// Asks the runner to dismiss the notification `id`.
    fn dismiss_note(&mut self, id: String) {
        self.outbox
            .push(Outbound::DismissNotification(NotifyDismiss { id }));
    }

    /// Posts and dismisses each card's notification as its wait begins and
    /// clears (the module's rules). Only the core that draws the sidebar
    /// calls it, once a frame, after the view is built. A card missing
    /// from the list may only be in another window, or moving between
    /// two, so its notification comes down but its record stays, for a
    /// week from its take down (`FORGET_GONE_SECS`).
    pub(crate) fn tend_notify(&mut self, data: &Data) {
        if !self.state_read {
            return;
        }
        let Some(list) = data.workspaces.as_deref().filter(|l| !l.is_empty()) else {
            return;
        };
        let gone: Vec<(String, SavedNote)> = self
            .saved
            .notified
            .iter()
            .filter(|(ws, _)| !list.iter().any(|w| w.id == **ws))
            .map(|(ws, note)| (ws.clone(), note.clone()))
            .collect();
        let now = data.epoch;
        for (ws, note) in gone {
            match (note.down, now) {
                (None, _) => self.take_down(&ws, note, now),
                (Some(down), Some(now)) if now - down >= FORGET_GONE_SECS => {
                    self.set_note(&ws, None);
                }
                (Some(_), _) => {}
            }
        }
        for w in list {
            self.tend_card(data, w);
        }
    }

    /// One card's part of `tend_notify`.
    fn tend_card(&mut self, data: &Data, w: &Workspace) {
        let note = self.saved.notified.get(&w.id).cloned();
        match (self.notifying_wait(data, w), note) {
            // Posted already, or on its way, or failed, or cleared and back.
            (Some(wait), Some(note)) if same_wait(&note, &wait) => {}
            (Some(wait), note) => {
                if let Some(id) = note.and_then(|n| n.id) {
                    self.dismiss_note(id);
                }
                let fresh = SavedNote {
                    since: wait.since,
                    ci: wait.ci,
                    id: None,
                    down: None,
                };
                self.set_note(&w.id, Some(fresh));
                self.outbox.push(Outbound::Notify(NotifyPost {
                    workspace: w.id.clone(),
                    since: wait.since,
                    title: wait.title,
                    body: wait.body,
                }));
            }
            (None, Some(note)) if note.down.is_none() && !self.note_holds(data, w, &note) => {
                self.take_down(&w.id, note, data.epoch);
            }
            (None, _) => {}
        }
    }

    /// The runner's answer to a post. The id is kept when the record still
    /// holds that wait, for the frame's `tend_notify` to dismiss once the
    /// wait clears; a wait already taken down or replaced, or a card
    /// already forgotten, has it dismissed now. An id not in cmux's shape
    /// never reaches a command line.
    pub fn notified(&mut self, answer: Notified) {
        let Some(id) = answer.id.filter(|id| is_uuid(id)) else {
            return;
        };
        match self.saved.notified.get(&answer.workspace).cloned() {
            Some(note) if note.since == answer.since && note.down.is_none() => {
                // A second answer for one post would leave the first
                // notification with no way to clear it.
                if let Some(old) = note.id.clone().filter(|old| *old != id) {
                    self.dismiss_note(old);
                }
                let kept = SavedNote {
                    id: Some(id),
                    ..note
                };
                self.set_note(&answer.workspace, Some(kept));
            }
            _ => self.dismiss_note(id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::SavedState;
    use crate::{Cockpit, Effect, Event, Model};
    use crux_core::App;

    const ID: &str = "74D64488-9CB8-4B8D-900F-1908FF44B8BB";
    const ID2: &str = "0F3E2A10-1B2C-4D5E-8F90-A1B2C3D4E5F6";

    /// The sidebar's core: the state file `state` read, the panel on.
    fn sidebar(state: &str) -> Model {
        let mut core = Model::default();
        let saved = SavedState::from_json(state).unwrap();
        let _ = Cockpit.update(Event::State(Box::new(saved)), &mut core);
        let _ = Cockpit.update(Event::PanelOn, &mut core);
        core
    }

    /// What `event` asks about notifications, in words: `notify <ws>
    /// <since> <title> | <body>`, `dismiss <id>`, or `set <key> <value>`
    /// for a `notified` write.
    fn asked(core: &mut Model, event: Event) -> Vec<String> {
        let mut cmd = Cockpit.update(event, core);
        cmd.effects()
            .filter_map(|e| match e {
                Effect::Notify(r) => {
                    let p = r.operation;
                    Some(format!(
                        "notify {} {} {} | {}",
                        p.workspace, p.since, p.title, p.body
                    ))
                }
                Effect::DismissNotification(r) => Some(format!("dismiss {}", r.operation.id)),
                Effect::Persist(r) if r.operation.key.starts_with("notified.") => {
                    let v = r.operation.value.map_or("delete".into(), |v| v.to_string());
                    Some(format!("set {} {v}", r.operation.key))
                }
                _ => None,
            })
            .collect()
    }

    fn frame(core: &mut Model, data: Data) -> Vec<String> {
        asked(core, Event::Data(data))
    }

    fn answer(core: &mut Model, since: f64, id: Option<&str>) -> Vec<String> {
        let a = Notified {
            workspace: "W".into(),
            since,
            id: id.map(str::to_string),
        };
        asked(core, Event::Notified(Box::new(a)))
    }

    /// A frame at epoch `now` with workspace W ("fix login", its last
    /// words "Please run /login") whose agent is `agent`, and X, which
    /// Jon is on.
    fn data(now: f64, agent: serde_json::Value) -> Data {
        serde_json::from_value(serde_json::json!({"epoch": now,
            "workspaces": [
                {"id": "W", "title": "fix login", "branch": "feat",
                 "latestMessage": "Please run /login", "agents": [agent]},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap()
    }

    /// W's agent stopped on an error at `since`.
    fn stopped(since: f64) -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "working",
            "sinceEpoch": 900, "lastActivityAt": 900,
            "stopped": {"cause": "error", "since": since}})
    }

    /// W's agent at work again.
    fn working(now: f64) -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "working",
            "sinceEpoch": now, "lastActivityAt": now})
    }

    fn idle() -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "idle",
            "sinceEpoch": 900, "lastActivityAt": 900})
    }

    const POSTED: &str = "notify W 1000 fix login | Stopped on an error: Please run /login";

    /// The sidebar's core with W's stop posted and answered with `ID`.
    fn posted() -> Model {
        let mut core = sidebar("{}");
        assert_eq!(
            frame(&mut core, data(1060.0, stopped(1000.0))),
            [r#"set notified.W {"since":1000.0}"#, POSTED]
        );
        assert_eq!(
            answer(&mut core, 1000.0, Some(ID)),
            [format!(r#"set notified.W {{"since":1000.0,"id":"{ID}"}}"#)],
            "the id is kept for the dismiss"
        );
        core
    }

    #[test]
    fn a_stopped_session_notifies_once_for_its_wait() {
        let mut core = posted();
        for now in [1090.0, 1200.0, 5000.0] {
            assert!(
                frame(&mut core, data(now, stopped(1000.0))).is_empty(),
                "{now}"
            );
        }
    }

    #[test]
    fn a_wait_that_clears_dismisses_its_notification_by_id_once() {
        let mut core = posted();
        assert_eq!(
            frame(&mut core, data(1100.0, working(1100.0))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":1000.0,"down":1100.0}"#.to_string()
            ]
        );
        assert!(frame(&mut core, data(1130.0, working(1100.0))).is_empty());
        // The same wait back (restored, say) never notifies twice.
        assert!(frame(&mut core, data(1160.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn dismissed_from_needs_you_takes_the_notification_down() {
        let mut core = posted();
        assert_eq!(
            asked(&mut core, Event::Dismiss { id: "W".into() }),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":1000.0,"down":1060.0}"#.to_string()
            ]
        );
    }

    #[test]
    fn a_new_wait_on_the_same_card_notifies_again() {
        let mut core = posted();
        assert_eq!(
            frame(&mut core, data(2060.0, stopped(2000.0))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":2000.0}"#.to_string(),
                "notify W 2000 fix login | Stopped on an error: Please run /login".to_string()
            ]
        );
    }

    #[test]
    fn asking_and_your_turn_never_notify_claude_code_does() {
        let mut core = sidebar(
            r#"{"asking": {"W": {"reason": "allow git push?", "epoch": 1000, "session": "c"}}}"#,
        );
        let waiting = serde_json::json!({"id": "c", "kind": "claude",
            "status": "needs_input", "sinceEpoch": 1000, "lastActivityAt": 1000});
        assert!(
            frame(&mut core, data(1060.0, waiting.clone())).is_empty(),
            "asking"
        );
        let mut turn = sidebar("{}");
        assert!(
            frame(&mut turn, data(1060.0, waiting)).is_empty(),
            "your turn"
        );
        let data_now = turn.data.clone().unwrap_or_default();
        assert!(
            turn.session.waits_on_you(data_now.ws_by_id("W")),
            "it does wait"
        );
    }

    #[test]
    fn a_restart_neither_posts_again_nor_loses_the_id() {
        let core = posted();
        // The state file as the handler wrote it, read by a new sidebar.
        let file = serde_json::to_string(&core.session.saved).unwrap();
        let mut again = sidebar(&file);
        assert!(frame(&mut again, data(1200.0, stopped(1000.0))).is_empty());
        assert_eq!(
            frame(&mut again, data(1300.0, working(1300.0))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":1000.0,"down":1300.0}"#.to_string()
            ]
        );
        // And restarted once more after the dismiss, still never twice.
        let file = serde_json::to_string(&again.session.saved).unwrap();
        let mut third = sidebar(&file);
        assert!(frame(&mut third, data(1400.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn a_blind_frame_neither_notifies_nor_dismisses() {
        let mut core = posted();
        for blind in [
            serde_json::json!({"epoch": 1100}),
            serde_json::json!({"epoch": 1100, "workspaces": []}),
        ] {
            let d: Data = serde_json::from_value(blind).unwrap();
            assert!(frame(&mut core, d).is_empty());
        }
        assert_eq!(core.session.saved.notified["W"].id.as_deref(), Some(ID));
        // Nor before the state file is read.
        let mut unread = Model::default();
        let _ = Cockpit.update(Event::PanelOn, &mut unread);
        assert!(frame(&mut unread, data(1060.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn the_panes_core_never_notifies() {
        let mut pane = Model::default();
        let _ = Cockpit.update(Event::State(Box::default()), &mut pane);
        assert!(frame(&mut pane, data(1060.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn an_answer_after_the_wait_cleared_dismisses_at_once() {
        let mut core = sidebar("{}");
        assert_eq!(frame(&mut core, data(1060.0, stopped(1000.0))).len(), 2);
        assert_eq!(
            frame(&mut core, data(1100.0, working(1100.0))),
            [r#"set notified.W {"since":1000.0,"down":1100.0}"#],
            "no id yet: marked down, nothing to dismiss"
        );
        assert_eq!(
            answer(&mut core, 1000.0, Some(ID)),
            [format!("dismiss {ID}")]
        );
        // One for a wait already replaced goes straight away too.
        assert_eq!(frame(&mut core, data(2060.0, stopped(2000.0))).len(), 2);
        assert_eq!(
            answer(&mut core, 1000.0, Some(ID2)),
            [format!("dismiss {ID2}")]
        );
    }

    #[test]
    fn a_post_that_failed_or_an_odd_id_is_never_kept_or_tried_again() {
        let mut core = sidebar("{}");
        let _ = frame(&mut core, data(1060.0, stopped(1000.0)));
        assert!(answer(&mut core, 1000.0, None).is_empty());
        assert!(answer(&mut core, 1000.0, Some("--all-read")).is_empty());
        assert!(frame(&mut core, data(1090.0, stopped(1000.0))).is_empty());
        assert_eq!(
            frame(&mut core, data(1100.0, working(1100.0))),
            [r#"set notified.W {"since":1000.0,"down":1100.0}"#],
            "nothing to dismiss"
        );
    }

    #[test]
    fn an_asleep_card_never_notifies() {
        let mut core = sidebar(r#"{"asleep": {"W": {"surfaces": ["S1"], "since": 900}}}"#);
        assert!(frame(&mut core, data(1060.0, stopped(1000.0))).is_empty());
    }

    /// The sidebar's core whose saved state holds W's PR #12 "Docs
    /// layout" with `checks` and `pr`'s fields over it.
    fn ci_sidebar(checks: &str, pr: &str) -> Model {
        sidebar(&format!(
            r#"{{"prs": {{"W": {{"number": 12, "url": "https://github.com/o/r/pull/12",
                "status": "open", "branch": "feat", "title": "Docs layout",
                "checks": {checks} {pr}}}}}}}"#
        ))
    }

    const FAILED: &str = r#"[{"name": "build", "state": "fail", "started": 800}]"#;

    #[test]
    fn red_stuck_and_merge_ready_ci_notify_naming_the_pr() {
        let mut red = ci_sidebar(FAILED, "");
        assert_eq!(
            frame(&mut red, data(1020.0, idle())),
            [
                r#"set notified.W {"since":900.0,"ci":800.0}"#,
                "notify W 900 Docs layout | CI failed, nobody fixing"
            ]
        );
        let queued = r#"[{"name": "build", "state": "pending", "queued": 1000}]"#;
        let mut stuck = ci_sidebar(queued, "");
        let at = 1000.0 + 40.0 * 60.0;
        assert_eq!(
            frame(&mut stuck, data(at, idle()))[1],
            "notify W 1600 Docs layout | CI stuck 40m: rerun?"
        );
        let passed = r#"[{"name": "build", "state": "pass", "started": 800}]"#;
        let mut ready = ci_sidebar(passed, r#", "mergeable": true, "readySince": 1000"#);
        let due = 1000.0 + crate::merge_wait::MERGE_WAIT_SECS;
        assert_eq!(
            frame(&mut ready, data(due + 60.0, idle()))[1],
            format!("notify W {due} Docs layout | Ready to merge: merge?")
        );
    }

    /// The sidebar's core with W's red CI posted at 900 and answered with `ID`.
    fn red_posted() -> Model {
        let mut core = ci_sidebar(FAILED, "");
        assert_eq!(frame(&mut core, data(1020.0, idle())).len(), 2);
        let _ = answer(&mut core, 900.0, Some(ID));
        core
    }

    #[test]
    fn a_ci_wait_whose_start_moves_with_its_sessions_never_posts_again() {
        let mut core = red_posted();
        let ended = serde_json::json!({"id": "c", "kind": "claude", "status": "ended",
            "sinceEpoch": 1100, "lastActivityAt": 900});
        assert!(
            frame(&mut core, data(1200.0, ended)).is_empty(),
            "the session ended"
        );
        let seen = core.data.clone().unwrap_or_default();
        assert_eq!(
            core.session.status_and_since(seen.ws_by_id("W")).1,
            1100.0,
            "the start did move"
        );
        let two: Data = serde_json::from_value(serde_json::json!({"epoch": 1300,
            "workspaces": [
                {"id": "W", "title": "fix login", "branch": "feat", "agents": [idle(),
                    {"id": "d", "kind": "claude", "status": "idle",
                     "sinceEpoch": 1250, "lastActivityAt": 1250}]},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap();
        assert!(
            frame(&mut core, two).is_empty(),
            "another finished beside it"
        );
    }

    #[test]
    fn red_ci_failing_again_or_left_again_posts_anew() {
        let mut core = red_posted();
        // A rerun failed again: the checks' key moved.
        let rerun = r#"[{"name": "build", "state": "fail", "started": 850}]"#;
        let mut again = core.session.saved.clone();
        again.prs = ci_sidebar(rerun, "").session.saved.prs;
        assert_eq!(
            asked(&mut core, Event::State(Box::new(again))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":900.0,"ci":850.0}"#.to_string(),
                "notify W 900 Docs layout | CI failed, nobody fixing".to_string()
            ]
        );
        // A session took it up, then left it red: a new wait.
        let mut left = red_posted();
        assert_eq!(frame(&mut left, data(1040.0, working(1040.0))).len(), 2);
        let after = serde_json::json!({"id": "c", "kind": "claude", "status": "idle",
            "sinceEpoch": 1500, "lastActivityAt": 1500});
        assert_eq!(
            frame(&mut left, data(1560.0, after))[1],
            "notify W 1500 Docs layout | CI failed, nobody fixing"
        );
    }

    #[test]
    fn a_ci_wait_keeps_its_notification_while_its_pr_cannot_be_read() {
        let mut core = red_posted();
        // The PR read as unknown for a while: nothing says CI ended.
        let mut unsure = core.session.saved.clone();
        if let Some(pr) = unsure.prs.get_mut("W") {
            pr.status = crate::data::PrStatus::Unknown;
        }
        assert!(asked(&mut core, Event::State(Box::new(unsure))).is_empty());
        assert!(frame(&mut core, data(1050.0, idle())).is_empty());
        let seen = core.data.clone().unwrap_or_default();
        assert!(
            !core.session.waits_on_you(seen.ws_by_id("W")),
            "the wait is off the card"
        );
        assert_eq!(core.session.saved.notified["W"].id.as_deref(), Some(ID));
        // Merged, it goes.
        let mut merged = core.session.saved.clone();
        if let Some(pr) = merged.prs.get_mut("W") {
            pr.status = crate::data::PrStatus::Merged;
        }
        assert_eq!(
            asked(&mut core, Event::State(Box::new(merged))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":900.0,"ci":800.0,"down":1050.0}"#.to_string()
            ]
        );
        // A session at work on it takes it down too, at the start the
        // wait reads now.
        let mut fixing = red_posted();
        assert_eq!(
            frame(&mut fixing, data(1070.0, working(1060.0))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":1060.0,"ci":800.0,"down":1070.0}"#.to_string()
            ]
        );
    }

    /// W's ended session, which moves a red wait's start to 1100.
    fn ended() -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "ended",
            "sinceEpoch": 1100, "lastActivityAt": 900})
    }

    #[test]
    fn a_ci_start_that_moves_before_the_id_is_back_never_posts_again() {
        let mut core = ci_sidebar(FAILED, "");
        assert_eq!(frame(&mut core, data(1020.0, idle())).len(), 2);
        assert!(
            frame(&mut core, data(1200.0, ended())).is_empty(),
            "the post is on its way"
        );
        assert_eq!(
            answer(&mut core, 900.0, Some(ID)),
            [format!(
                r#"set notified.W {{"since":900.0,"ci":800.0,"id":"{ID}"}}"#
            )],
            "and its id is kept"
        );
        // A post that failed is not tried again when the start moves.
        let mut failed = ci_sidebar(FAILED, "");
        assert_eq!(frame(&mut failed, data(1020.0, idle())).len(), 2);
        assert!(answer(&mut failed, 900.0, None).is_empty());
        assert!(frame(&mut failed, data(1200.0, ended())).is_empty());
    }

    #[test]
    fn a_ci_wait_dismissed_after_its_start_moved_never_posts_on_restore() {
        let mut core = red_posted();
        assert!(frame(&mut core, data(1200.0, ended())).is_empty());
        assert_eq!(
            asked(&mut core, Event::Dismiss { id: "W".into() }),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":1100.0,"ci":800.0,"down":1200.0}"#.to_string()
            ]
        );
        let seen = core.data.clone().unwrap_or_default();
        core.session.restore_needs(seen.ws_by_id("W"));
        assert!(frame(&mut core, data(1300.0, ended())).is_empty());
    }

    #[test]
    fn a_ci_notification_comes_down_once_the_card_leaves_its_branch() {
        let mut core = red_posted();
        let moved: Data = serde_json::from_value(serde_json::json!({"epoch": 1100,
            "workspaces": [
                {"id": "W", "title": "fix login", "branch": "other", "agents": [idle()],
                 "pr": {"number": 12, "url": "https://github.com/o/r/pull/12", "status": "open"}},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap();
        assert_eq!(
            frame(&mut core, moved),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":900.0,"ci":800.0,"down":1100.0}"#.to_string()
            ]
        );
    }

    #[test]
    fn a_session_taking_up_a_ci_wait_takes_it_down_while_its_pr_is_unreadable() {
        let mut core = red_posted();
        let mut unsure = core.session.saved.clone();
        if let Some(pr) = unsure.prs.get_mut("W") {
            pr.status = crate::data::PrStatus::Unknown;
        }
        assert!(asked(&mut core, Event::State(Box::new(unsure))).is_empty());
        assert_eq!(
            frame(&mut core, data(1070.0, working(1060.0))),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":900.0,"ci":800.0,"down":1070.0}"#.to_string()
            ]
        );
    }

    #[test]
    fn a_card_that_leaves_the_list_and_comes_back_never_posts_twice() {
        let mut core = posted();
        let only_x = |now: f64| -> Data {
            serde_json::from_value(serde_json::json!({"epoch": now,
                "workspaces": [{"id": "X", "title": "other", "selected": true}]}))
            .unwrap_or_default()
        };
        assert_eq!(
            frame(&mut core, only_x(1100.0)),
            [
                format!("dismiss {ID}"),
                r#"set notified.W {"since":1000.0,"down":1100.0}"#.to_string()
            ]
        );
        assert!(frame(&mut core, only_x(1130.0)).is_empty());
        assert!(
            frame(&mut core, data(1160.0, stopped(1000.0))).is_empty(),
            "back, with the same wait"
        );
        // Gone for good: the record goes a week after it was taken down.
        let _ = frame(&mut core, only_x(1200.0));
        assert!(frame(&mut core, only_x(1100.0 + FORGET_GONE_SECS - 1.0)).is_empty());
        assert_eq!(
            frame(&mut core, only_x(1100.0 + FORGET_GONE_SECS)),
            ["set notified.W delete"]
        );
        assert!(core.session.saved.notified.is_empty());
    }

    #[test]
    fn a_wait_over_a_week_old_that_leaves_and_comes_back_never_posts_twice() {
        let mut core = posted();
        let left = 1000.0 + 2.0 * FORGET_GONE_SECS;
        let only_x = |now: f64| -> Data {
            serde_json::from_value(serde_json::json!({"epoch": now,
                "workspaces": [{"id": "X", "title": "other", "selected": true}]}))
            .unwrap_or_default()
        };
        assert_eq!(frame(&mut core, only_x(left)).len(), 2, "taken down");
        assert!(frame(&mut core, only_x(left + 60.0)).is_empty(), "kept");
        assert!(frame(&mut core, data(left + 120.0, stopped(1000.0))).is_empty());
    }

    #[test]
    fn a_card_is_named_by_its_title_else_its_tab() {
        let w = |title: Option<&str>| Workspace {
            id: "W1".into(),
            title: title.map(str::to_string),
            ..Workspace::default()
        };
        assert_eq!(
            card_title(&w(Some("  Docs   layout ")), Some("tab")),
            "Docs layout"
        );
        assert_eq!(
            card_title(&w(Some("  ")), Some("Fix the build")),
            "Fix the build"
        );
        assert_eq!(card_title(&w(None), None), NO_TITLE);
    }
}
