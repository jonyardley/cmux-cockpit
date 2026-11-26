//! The agents each workspace shows, saved for the agents panel (#429),
//! as the quiet verdict is since #425 (quiet_save.rs): the panel reads
//! only config/state.json, so the core writes each workspace's agents as
//! it shows them (`Session::agents_of`, dismissals, the CI carrier, parks
//! and stand-ins laid) into the `agents` map, and the panel can drop its
//! own copies of the turn, ask, stop, CI and park rules.
//!
//! Nothing saved moves with the clock: each agent's status, when it began
//! and why it waits on Jon. Only a change goes out, as for the running
//! map (`Saves`).

use std::collections::BTreeMap;

use crate::ci_wait::CI_KEY;
use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::needs::ask_reason;
use crate::ostinato::wait::OSTINATO_KEY;
use crate::persist::{
    MAX_LABEL, SavedAgent, SavedState, SavedStatus, WaitWhy, agents_fit, is_id, is_text,
};
use crate::quiet_save::whole_ms;
use crate::running_save::Saves;
use crate::session::Session;
use crate::text::clip;

/// The `agents` map's sends.
pub type AgentSaves = Saves<Vec<SavedAgent>>;

/// The id a CI or park stand-in is saved under.
pub const STAND_IN: &str = "stand-in";

fn saved_status(s: Option<&AgentStatus>) -> Option<SavedStatus> {
    match s? {
        AgentStatus::NeedsInput => Some(SavedStatus::NeedsInput),
        AgentStatus::Working => Some(SavedStatus::Working),
        AgentStatus::Idle => Some(SavedStatus::Idle),
        AgentStatus::Ended => Some(SavedStatus::Ended),
        AgentStatus::Other(_) => None,
    }
}

/// Why `a`, shown as needs_input, waits on Jon: a stop, then CI, as the
/// card's status reads them (`Session::status_kind`), then a park, then
/// an ask, else its turn. The core lays the first three on different
/// agents, and `ask_reason` says nothing for any of them.
fn why_of(saved: &SavedState, a: &Agent, w: &Workspace) -> (WaitWhy, Option<String>) {
    if a.stopped.is_some() {
        return (WaitWhy::Stop, None);
    }
    if a.ci.is_some() {
        return (WaitWhy::Ci, None);
    }
    if a.ostinato_park {
        return (WaitWhy::Park, None);
    }
    let reason = ask_reason(saved, Some(a), Some(w))
        .map(|r| clip(r.trim(), MAX_LABEL))
        .filter(|r| is_text(r, MAX_LABEL));
    match reason {
        Some(r) => (WaitWhy::Ask, Some(r)),
        None => (WaitWhy::Turn, None),
    }
}

/// `a`, as `agents_of` shows it in `w`, as the file saves it, or None
/// for a status the core does not know. A stand-in's id is one no agent
/// of `w` carries.
fn saved_agent(saved: &SavedState, a: &Agent, w: &Workspace) -> Option<SavedAgent> {
    let status = saved_status(a.status.as_ref())?;
    let stand_in =
        [CI_KEY, OSTINATO_KEY].contains(&a.id.as_str()) && !w.agent_list().any(|x| x.id == a.id);
    let (why, reason) = match status {
        SavedStatus::NeedsInput => {
            let (why, reason) = why_of(saved, a, w);
            (Some(why), reason)
        }
        _ => (None, None),
    };
    Some(SavedAgent {
        id: if stand_in { STAND_IN } else { &a.id }.to_string(),
        status,
        since: whole_ms(a.since_epoch.unwrap_or(0.0)),
        why,
        reason,
    })
}

/// Each workspace's agents in `data` as the core shows them, in its
/// order, for every workspace that shows any. None before the state file
/// is read, since the turns and asks come from it, or when the frame
/// lists no workspaces, so neither deletes every saved list.
pub fn agents(session: &mut Session, data: &Data) -> Option<BTreeMap<String, Vec<SavedAgent>>> {
    if !session.state_read {
        return None;
    }
    let list = data.workspaces.as_deref().filter(|l| !l.is_empty())?;
    let mut out = BTreeMap::new();
    for w in list.iter().filter(|w| is_id(&w.id)) {
        let shown: Vec<SavedAgent> = session
            .agents_of(Some(w))
            .iter()
            .filter_map(|a| saved_agent(&session.saved, a, w))
            .collect();
        if agents_fit(&shown) {
            out.insert(w.id.clone(), shown);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{Cockpit, Effect, Event, Model};
    use crate::ci_wait::CiTrouble;
    use crate::stopped::{Stop, StopCause};
    use crux_core::App;
    use serde_json::{Value, json};

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

    /// The agent lists `event` saves, as JSON: one object per save.
    fn saved(m: &mut Model, event: Event) -> Vec<Value> {
        let mut cmd = Cockpit.update(event, m);
        cmd.effects()
            .filter_map(|e| match e {
                Effect::SaveAgents(r) => serde_json::to_value(r.operation.agents).ok(),
                _ => None,
            })
            .collect()
    }

    /// A frame at epoch 2000 with workspace W, its one agent `c` in
    /// `status` since 1000.
    fn frame(status: &str) -> Event {
        let data: Data = serde_json::from_value(json!({"epoch": 2000,
            "workspaces": [
                {"id": "W", "title": "fix login", "latestAt": 900, "agents": [
                    {"id": "c", "kind": "claude", "status": status,
                     "sinceEpoch": 1000, "lastActivityAt": 1000}]},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap();
        Event::Data(data)
    }

    /// The one save `event` makes for W's list.
    fn one(m: &mut Model, event: Event) -> Value {
        let sent = saved(m, event);
        let [map] = sent.as_slice() else {
            panic!("one save, got {sent:?}");
        };
        map["W"].clone()
    }

    const TURN: &str =
        r#""moves": {"W": {"text": "Your move: go", "epoch": 1000, "session": "c"}}"#;

    #[test]
    fn a_turn_end_saves_needs_input_with_why_turn() {
        let mut m = core(&format!("{{{TURN}}}"), true);
        assert_eq!(
            one(&mut m, frame("idle")),
            json!([{"id": "c", "status": "needs_input", "since": 1000.0, "why": "turn"}])
        );
    }

    #[test]
    fn an_ask_saves_why_ask_and_its_reason() {
        let state = r#"{"asking": {"W": {"reason": "allow git push?", "epoch": 1000}}}"#;
        let mut m = core(state, true);
        assert_eq!(
            one(&mut m, frame("needs_input")),
            json!([{"id": "c", "status": "needs_input", "since": 1000.0,
                    "why": "ask", "reason": "allow git push?"}])
        );
    }

    #[test]
    fn a_dismissed_ask_saves_idle() {
        let state = r#"{"dismissed": {"W": {"c": 1000}}}"#;
        let mut m = core(state, true);
        assert_eq!(
            one(&mut m, frame("needs_input")),
            json!([{"id": "c", "status": "idle", "since": 1000.0}])
        );
    }

    #[test]
    fn an_unchanged_frame_sends_nothing_and_a_change_goes_out() {
        let mut m = core("{}", true);
        let first = one(&mut m, frame("working"));
        assert!(
            saved(&mut m, frame("working")).is_empty(),
            "sent, not yet read"
        );
        let shown = json!({"agents": {"W": first}}).to_string();
        assert!(saved(&mut m, Event::State(Box::new(read(&shown)))).is_empty());
        assert!(
            saved(&mut m, frame("working")).is_empty(),
            "the file holds it"
        );
        assert_eq!(
            one(&mut m, frame("idle")),
            json!([{"id": "c", "status": "idle", "since": 1000.0}])
        );
    }

    #[test]
    fn a_workspace_that_shows_no_agent_is_removed() {
        let held = r#"{"agents": {"X": [{"id": "d", "status": "idle", "since": 1}]}}"#;
        let mut m = core(held, true);
        let sent = saved(&mut m, frame("working"));
        let [map] = sent.as_slice() else {
            panic!("one save, got {sent:?}");
        };
        assert_eq!(map["X"], Value::Null);
    }

    #[test]
    fn the_panes_core_never_saves() {
        let mut m = core("{}", false);
        assert!(saved(&mut m, frame("working")).is_empty());
    }

    #[test]
    fn says_nothing_before_the_file_is_read_or_with_no_workspaces() {
        let mut m = Model::default();
        let _ = Cockpit.update(Event::PanelOn, &mut m);
        assert!(saved(&mut m, frame("working")).is_empty());
        let held = r#"{"agents": {"W": [{"id": "c", "status": "working", "since": 1000}]}}"#;
        let mut m = core(held, true);
        let empty: Data = serde_json::from_value(json!({"epoch": 5000, "workspaces": []})).unwrap();
        assert!(saved(&mut m, Event::Data(empty)).is_empty());
        assert!(saved(&mut m, Event::Data(Data::default())).is_empty());
    }

    // The stop, CI and park waits are laid by `agents_of` from the runner's
    // join, the PR poll and the Ostinato feed; these read the agent as it
    // lays them.

    fn ws(agents: &[&str]) -> Workspace {
        let list = agents
            .iter()
            .map(|id| {
                Some(Agent {
                    id: (*id).to_string(),
                    ..Agent::default()
                })
            })
            .collect();
        Workspace {
            id: "W".into(),
            agents: Some(list),
            ..Workspace::default()
        }
    }

    fn waiting(id: &str) -> Agent {
        Agent {
            id: id.into(),
            status: Some(AgentStatus::NeedsInput),
            since_epoch: Some(1000.25),
            ..Agent::default()
        }
    }

    fn why(a: &Agent, w: &Workspace) -> Value {
        let s = saved_agent(&SavedState::default(), a, w).unwrap();
        serde_json::to_value(s).unwrap()
    }

    #[test]
    fn a_stop_a_ci_carrier_and_a_park_save_their_why() {
        let w = ws(&["c"]);
        let stop = Agent {
            stopped: Some(Stop {
                cause: StopCause::Error,
                since: 1000.25,
            }),
            ci: Some(CiTrouble::Failing),
            ..waiting("c")
        };
        assert_eq!(why(&stop, &w)["why"], "stop", "a stop comes first");
        let ci = Agent {
            ci: Some(CiTrouble::Failing),
            ostinato_park: true,
            ..waiting("c")
        };
        assert_eq!(why(&ci, &w)["why"], "ci", "then CI");
        let park = Agent {
            ostinato_park: true,
            ..waiting("c")
        };
        assert_eq!(
            why(&park, &w),
            json!({"id": "c", "status": "needs_input", "since": 1000.25, "why": "park"})
        );
    }

    #[test]
    fn a_stand_in_is_saved_by_its_own_id() {
        let none = ws(&[]);
        for key in [CI_KEY, OSTINATO_KEY] {
            assert_eq!(why(&waiting(key), &none)["id"], STAND_IN, "{key}");
        }
        let named = ws(&["ci"]);
        assert_eq!(
            why(&waiting("ci"), &named)["id"],
            "ci",
            "a real agent named ci"
        );
    }

    #[test]
    fn an_unknown_status_is_left_out() {
        let a = Agent {
            status: Some(AgentStatus::Other("napping".into())),
            ..waiting("c")
        };
        assert!(saved_agent(&SavedState::default(), &a, &ws(&["c"])).is_none());
    }
}
