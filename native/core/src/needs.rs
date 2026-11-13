//! "Needs you", corrected the same way in both sidebars
//! (src/shared/needs.ts). An agent's needs_input reads as idle when it is
//! Claude Code's idle nudge (issue #4), when Jon has dismissed it, or when
//! the turn ended on "Nothing for you". Asking or your turn (issue #81)
//! comes from the saved asks.
//!
//! The Cockpit also reads a turn end as Jon's turn from its closing line,
//! not from the nudge: an idle or nudged agent whose turn ended on a move
//! that asks something of him (`waiting_turn`) reads as needs_input from
//! the moment the turn ended. The runner never moves the last activity on
//! a Notification, so the nudge alone always reads as idle there, and
//! Claude Code may send none while background work runs. Every rule that
//! asks whether a card waits on Jon reads the agent this gives, so Needs
//! you, the status, the waiting look and the size chip cannot disagree.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::activity::since_or_activity;
use crate::data::{Agent, AgentStatus, Workspace};
use crate::js::{json_num, truthy};
use crate::moves::{asks_nothing, quiet_turn, waiting_move};
use crate::persist::{SavedAsk, SavedMove, SavedState};
use crate::saved::saved_for;
use crate::session::Session;

/// Seconds between an agent's last activity and a needs_input that is only a nudge.
pub const NUDGE_GAP: f64 = 45.0;

fn needs_input(a: &Agent) -> bool {
    a.status == Some(AgentStatus::NeedsInput)
}

/// Whether `a`'s needs_input is Claude Code's idle nudge: it began well
/// after the agent's last activity (or the workspace's latest prompt), with
/// no fresh saved ask to say it is real.
pub fn is_idle_nudge(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> bool {
    if !needs_input(a) || a.kind.as_deref() != Some("claude") {
        return false;
    }
    let Some(since) = truthy(a.since_epoch) else {
        return false;
    };
    if fresh_ask(saved, a, w).is_some() {
        return false;
    }
    let before = a
        .last_activity_at
        .unwrap_or(0.0)
        .max(w.and_then(|w| w.latest_at).unwrap_or(0.0));
    before > 0.0 && since - before >= NUDGE_GAP
}

/// Whether a saved entry can be `a`'s: when one of the workspace's agents
/// carries the entry's session as its id, only that agent owns it;
/// otherwise it belongs to the workspace as a whole.
fn is_own_saved(saved: &SavedAsk, a: &Agent, w: &Workspace) -> bool {
    let session = saved.session.as_deref();
    let owned = session.is_some_and(|s| w.agent_list().any(|x| x.id == s));
    !owned || session == Some(a.id.as_str())
}

/// The move behind `a`'s nudge when that turn ended on "Nothing for you",
/// unless a fresh saved ask says it is really asking.
fn quiet_of(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> Option<SavedMove> {
    if needs_input(a) && fresh_ask(saved, a, w).is_none() {
        quiet_turn(saved, a, w)
    } else {
        None
    }
}

/// The saved ask that explains `a`'s current needs_input spell, if any.
fn fresh_ask<'s>(saved: &'s SavedState, a: &Agent, w: Option<&Workspace>) -> Option<&'s SavedAsk> {
    let w = w?;
    if !needs_input(a) {
        return None;
    }
    let since = truthy(a.since_epoch)?;
    saved_for(saved.asking.get(&w.id), a, w, since, is_own_saved)
}

/// The move `a`'s turn ended on when it waits on Jon: `a`'s own, current
/// (no prompt since), not an ask, and asking something of him. A reply
/// with no label counts, as a turn with no closing line still waits on
/// him (#322); only "Nothing for you" does not. None otherwise.
pub fn waiting_turn(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> Option<SavedMove> {
    let asking = fresh_ask(saved, a, w).is_some();
    waiting_move(saved, Some(a), w, asking).filter(|m| !asks_nothing(m))
}

/// When `a`'s wait on Jon began, which a dismissal is keyed on: the end
/// of a turn that waits on him, so the nudge landing a minute on keeps
/// the dismissal, else the start of its needs_input spell.
fn wait_start(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> f64 {
    waiting_turn(saved, a, w).map_or_else(|| since_or_activity(a), |m| m.epoch)
}

/// Why the agent is asking ("allow git push?"), or None when its
/// needs_input is only its turn. Pass the agent as the sidebars show it, so
/// a nudge or a dismissal is never an ask.
pub fn ask_reason(saved: &SavedState, a: Option<&Agent>, w: Option<&Workspace>) -> Option<String> {
    fresh_ask(saved, a?, w).map(|s| s.reason.clone())
}

/// A needs_input that is not Jon's: the idle nudge, or a quiet turn's nudge.
fn not_jons(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> bool {
    is_idle_nudge(saved, a, w) || quiet_of(saved, a, w).is_some()
}

/// Whether `a` waits on Jon, dismissals aside: a turn that ended on a move
/// asking something of him, or a needs_input that is not a nudge.
fn waits_on_jon(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> bool {
    waiting_turn(saved, a, w).is_some() || (needs_input(a) && !not_jons(saved, a, w))
}

/// The workspace's agents that wait on Jon, its real asks among them.
fn asking<'w>(saved: &SavedState, w: Option<&'w Workspace>) -> Vec<&'w Agent> {
    let Some(w) = w else { return Vec::new() };
    w.agent_list()
        .filter(|a| waits_on_jon(saved, a, Some(w)))
        .collect()
}

impl Session {
    /// Whether Jon dismissed `a`'s wait that began at `start`.
    fn dismissed_at(&self, w: Option<&Workspace>, a: &Agent, start: f64) -> bool {
        w.and_then(|w| self.dismissed.get(&w.id))
            .and_then(|starts| starts.get(&a.id))
            .is_some_and(|s| *s == start)
    }

    fn is_dismissed(&self, w: Option<&Workspace>, a: &Agent) -> bool {
        let turn = waiting_turn(&self.saved, a, w);
        let start = turn
            .as_ref()
            .map_or_else(|| since_or_activity(a), |m| m.epoch);
        (needs_input(a) || turn.is_some()) && self.dismissed_at(w, a, start)
    }

    /// Drops dismissals whose spell has ended, for agents the workspace
    /// reports: straight after a reload cmux can report a workspace before
    /// its agents, and that must not wipe a dismissal seeded from disk.
    fn prune(&mut self, w: &Workspace) {
        // Most workspaces have no dismissal: leave before working out their asks.
        if !self.dismissed.contains_key(&w.id) {
            return;
        }
        let live: IndexMap<String, f64> = asking(&self.saved, Some(w))
            .into_iter()
            .map(|a| (a.id.clone(), wait_start(&self.saved, a, Some(w))))
            .collect();
        let Some(by_agent) = self.dismissed.get_mut(&w.id) else {
            return;
        };
        by_agent.retain(|id, start| {
            let reported = w.agent_list().any(|a| &a.id == id);
            !reported || live.get(id) == Some(start)
        });
        if by_agent.is_empty() {
            self.dismissed.shift_remove(&w.id);
        }
    }

    /// The agent as the sidebars show it: a turn that ended on a move
    /// asking something of Jon reads as needs_input from its end, idle or
    /// nudged; any other needs_input reads as idle when it is a nudge,
    /// dismissed, or a turn that ended on "Nothing for you".
    pub fn effective_agent(&self, a: &Agent, w: Option<&Workspace>) -> Agent {
        // Ahead of Running too: background work never hides a turn that
        // asks Jon something. A dismissed one reads as it would without it.
        if let Some(turn) = waiting_turn(&self.saved, a, w)
            && !self.dismissed_at(w, a, turn.epoch)
        {
            return Agent {
                status: Some(AgentStatus::NeedsInput),
                since_epoch: Some(turn.epoch),
                ..a.clone()
            };
        }
        if !needs_input(a) {
            return a.clone();
        }
        let idle = |since: Option<f64>| Agent {
            status: Some(AgentStatus::Idle),
            since_epoch: since,
            ..a.clone()
        };
        let nudge = is_idle_nudge(&self.saved, a, w);
        // A nudge's idle spell began when the turn ended, not when it landed.
        if nudge && let Some(last) = truthy(a.last_activity_at) {
            return idle(Some(last));
        }
        // A turn that ended on "Nothing for you" waits on the agent.
        if let Some(quiet) = quiet_of(&self.saved, a, w) {
            return idle(Some(quiet.epoch));
        }
        if nudge || self.is_dismissed(w, a) {
            return idle(a.since_epoch);
        }
        a.clone()
    }

    /// A workspace's agents with nudges and dismissals applied, in the
    /// app's order. An agent sent with no status is left out (issue #7).
    pub fn agents_of(&mut self, w: Option<&Workspace>) -> Vec<Agent> {
        let Some(w) = w else { return Vec::new() };
        self.prune(w);
        w.agent_list()
            .filter(|a| a.status.is_some())
            .map(|a| self.effective_agent(a, Some(w)))
            .collect()
    }

    /// True while any agent in the workspace is really asking, dismissed or not.
    pub fn has_real_ask(&self, w: Option<&Workspace>) -> bool {
        !asking(&self.saved, w).is_empty()
    }

    /// True when dismissals are all that keep the workspace from showing needs you.
    pub fn is_needs_dismissed(&self, w: Option<&Workspace>) -> bool {
        let list = asking(&self.saved, w);
        !list.is_empty() && list.iter().all(|a| self.is_dismissed(w, a))
    }

    /// Dismisses every real ask in the workspace; each comes back when that
    /// agent asks again. Only dated spells are saved, so an undated ask
    /// cannot stay hidden across reloads.
    pub fn dismiss_needs(&mut self, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        let starts: IndexMap<String, f64> = asking(&self.saved, Some(w))
            .into_iter()
            .map(|a| (a.id.clone(), wait_start(&self.saved, a, Some(w))))
            .collect();
        if starts.is_empty() {
            return;
        }
        let dated: Map<String, Value> = starts
            .iter()
            .filter(|(_, start)| **start > 0.0)
            .map(|(id, start)| (id.clone(), json_num(*start)))
            .collect();
        self.dismissed.insert(w.id.clone(), starts);
        let value = (!dated.is_empty()).then_some(Value::Object(dated));
        self.persist_set(format!("dismissed.{}", w.id), value);
    }

    /// Brings back the workspace's dismissed asks.
    pub fn restore_needs(&mut self, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        if self.dismissed.shift_remove(&w.id).is_none() {
            return;
        }
        self.persist_set(format!("dismissed.{}", w.id), None);
    }
}

#[cfg(test)]
mod tests {
    use super::waiting_turn;
    use crate::data::{Agent, AgentStatus, Workspace};
    use crate::persist::SavedState;
    use crate::session::Session;

    /// Whether `c`'s turn, ended at 1000 on `move_json`, waits on Jon,
    /// with `asking_json` as the workspace's saved ask.
    fn waits(move_json: &str, asking_json: &str, status: AgentStatus) -> bool {
        let saved = SavedState::from_json(&format!(
            r#"{{"moves": {{"w": {move_json}}}, "asking": {{{asking_json}}}}}"#
        ))
        .unwrap();
        let a = Agent {
            id: "c".into(),
            kind: Some("claude".into()),
            status: Some(status),
            since_epoch: Some(1000.0),
            last_activity_at: Some(1000.0),
            ..Agent::default()
        };
        let w = Workspace {
            id: "w".into(),
            latest_at: Some(900.0),
            agents: Some(vec![Some(a.clone())]),
            ..Workspace::default()
        };
        waiting_turn(&saved, &a, Some(&w)).is_some()
    }

    #[test]
    fn a_turn_waits_on_jon_unless_it_asks_nothing_is_an_ask_or_is_not_its_own() {
        let idle = || AgentStatus::Idle;
        let asks = r#"{"text": "Your move: go", "epoch": 1000, "session": "c"}"#;
        assert!(waits(asks, "", idle()));
        let bare =
            r#"{"text": "Shall I go on?", "unlabelled": true, "epoch": 1000, "session": "c"}"#;
        assert!(
            waits(bare, "", idle()),
            "a reply with no label still waits (#322)"
        );
        let quiet =
            r#"{"text": "Nothing for you: CI runs.", "idle": true, "epoch": 1000, "session": "c"}"#;
        assert!(!waits(quiet, "", idle()));
        let other = r#"{"text": "Your move: go", "epoch": 1000, "session": "d"}"#;
        assert!(!waits(other, "", idle()), "another session's move");
        let ask = r#""w": {"reason": "allow git push?", "epoch": 1000}"#;
        assert!(
            waits(asks, ask, idle()),
            "an ask only counts while needs_input"
        );
        assert!(
            !waits(asks, ask, AgentStatus::NeedsInput),
            "Asking, not Your turn"
        );
        assert!(!waits(asks, "", AgentStatus::Working), "only at a turn end");
    }

    #[test]
    fn saves_a_dismissal_in_the_workspaces_agent_order() {
        let ask = |id: &str, since: f64| Agent {
            id: id.into(),
            status: Some(AgentStatus::NeedsInput),
            since_epoch: Some(since),
            ..Agent::default()
        };
        let w = Workspace {
            id: "w".into(),
            agents: Some(vec![Some(ask("a2", 600.0)), Some(ask("a1", 500.0))]),
            ..Workspace::default()
        };
        let mut s = Session::default();
        s.dismiss_needs(Some(&w));
        let url = s.take_outbox().pop().and_then(|o| o.persist_url(""));
        assert_eq!(
            url.as_deref(),
            Some("cmux-cockpit://set?key=dismissed.w&value=%7B%22a2%22%3A600%2C%22a1%22%3A500%7D")
        );
    }
}
