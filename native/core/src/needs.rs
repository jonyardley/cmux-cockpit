//! "Needs you", corrected the same way in both sidebars
//! (src/shared/needs.ts). An agent's needs_input reads as idle when it is
//! Claude Code's idle nudge (issue #4), when Jon has dismissed it, or when
//! the turn ended on "Nothing for you". Asking or your turn (issue #81)
//! comes from the saved asks.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::activity::since_or_activity;
use crate::data::{Agent, AgentStatus, Workspace};
use crate::js::{json_num, truthy};
use crate::moves::quiet_turn;
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

/// The workspace's real asks: needs_input agents that are not a nudge.
fn asking<'w>(saved: &SavedState, w: Option<&'w Workspace>) -> Vec<&'w Agent> {
    let Some(w) = w else { return Vec::new() };
    w.agent_list()
        .filter(|a| needs_input(a) && !not_jons(saved, a, Some(w)))
        .collect()
}

impl Session {
    fn is_dismissed(&self, w: Option<&Workspace>, a: &Agent) -> bool {
        let Some(w) = w else { return false };
        needs_input(a)
            && self
                .dismissed
                .get(&w.id)
                .and_then(|starts| starts.get(&a.id))
                .is_some_and(|start| *start == since_or_activity(a))
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
            .map(|a| (a.id.clone(), since_or_activity(a)))
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

    /// The agent as the sidebars show it: needs_input reads as idle when it
    /// is a nudge, dismissed, or a turn that ended on "Nothing for you".
    pub fn effective_agent(&self, a: &Agent, w: Option<&Workspace>) -> Agent {
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
            .map(|a| (a.id.clone(), since_or_activity(a)))
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
    use crate::data::{Agent, AgentStatus, Workspace};
    use crate::session::Session;

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
