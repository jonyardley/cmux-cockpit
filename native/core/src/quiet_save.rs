//! The core's quiet verdict, saved for the agents panel (#425), as its
//! background verdicts are since #360 (running_save.rs): the panel reads
//! only config/state.json and cannot see the session ids a chat ran under
//! before a `/clear`, so it cannot count that chat's own helpers. The core
//! can (`Session::quiet_since`), so it writes each card's quiet agent and
//! when it last showed activity into the `quiet` map, and the panel draws
//! the age from its own clock.
//!
//! Nothing saved moves with the clock: an entry goes out when the card's
//! agent passes QUIET_SECS and a removal when it stops being quiet, and
//! only a change goes out, as for the running map (`Saves`).

use std::collections::BTreeMap;

use crate::data::Data;
use crate::persist::{SavedQuiet, is_id};
use crate::running_save::Saves;
use crate::session::Session;

/// The `quiet` map's sends.
pub type QuietSaves = Saves<SavedQuiet>;

/// Each workspace's quiet verdict in `data`: its card's agent and when
/// that agent last showed activity, for every card whose agent reads
/// quiet. None before the state file is read, since the chat's own runs
/// come partly from it, or when the frame lists no workspaces, so neither
/// deletes every saved verdict.
pub fn quiet(session: &mut Session, data: &Data) -> Option<BTreeMap<String, SavedQuiet>> {
    if !session.state_read {
        return None;
    }
    let list = data.workspaces.as_deref().filter(|l| !l.is_empty())?;
    let mut out = BTreeMap::new();
    for w in list.iter().filter(|w| is_id(&w.id)) {
        let Some(a) = session.card_running(data, Some(w)).agent else {
            continue;
        };
        let since = session.quiet_since(data, Some(&a), Some(w));
        let v = SavedQuiet { agent: a.id, since };
        if since > 0.0 && v.fits() {
            out.insert(w.id.clone(), v);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use crate::app::{Cockpit, Effect, Event, Model};
    use crate::data::Data;
    use crate::persist::SavedState;
    use crate::quiet::QUIET_SECS;
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

    /// The quiet verdicts `event` saves, as JSON: one object per save.
    fn saved(m: &mut Model, event: Event) -> Vec<serde_json::Value> {
        let mut cmd = Cockpit.update(event, m);
        cmd.effects()
            .filter_map(|e| match e {
                Effect::SaveQuiet(r) => serde_json::to_value(r.operation.quiet).ok(),
                _ => None,
            })
            .collect()
    }

    /// A frame at epoch `now` with workspace W, its one agent `agent`.
    fn frame(now: f64, agent: serde_json::Value) -> Event {
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": now,
            "workspaces": [
                {"id": "W", "title": "fix login", "agents": [agent]},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap();
        Event::Data(data)
    }

    /// W's agent `c`, working since 500 and last active at `last`.
    fn working(last: f64) -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "working",
            "sinceEpoch": 500, "lastActivityAt": last})
    }

    /// W's agent `c` with a helper of its own running.
    fn with_helper(last: f64) -> serde_json::Value {
        serde_json::json!({"id": "c", "kind": "claude", "status": "working",
            "sinceEpoch": 500, "lastActivityAt": last,
            "children": [{"id": "h1", "label": "explore", "running": true, "startedEpoch": last}]})
    }

    const LAST: f64 = 1000.0;

    #[test]
    fn saves_once_the_agent_passes_ten_quiet_minutes_and_never_moves_with_the_clock() {
        let mut m = core("{}", true);
        assert!(saved(&mut m, frame(LAST + QUIET_SECS - 60.0, working(LAST))).is_empty());
        let due = LAST + QUIET_SECS;
        assert_eq!(
            saved(&mut m, frame(due, working(LAST))),
            [serde_json::json!({"W": {"agent": "c", "since": LAST}})]
        );
        let shown = r#"{"quiet": {"W": {"agent": "c", "since": 1000}}}"#;
        assert!(saved(&mut m, Event::State(Box::new(read(shown)))).is_empty());
        for later in [due + 60.0, due + 600.0, due + 7200.0] {
            assert!(
                saved(&mut m, frame(later, working(LAST))).is_empty(),
                "{later}"
            );
        }
        assert_eq!(
            saved(&mut m, frame(due + 7300.0, working(due + 7300.0))),
            [serde_json::json!({"W": null})],
            "activity ends quiet"
        );
    }

    #[test]
    fn a_chat_waiting_on_its_own_helper_is_not_quiet() {
        let mut m = core("{}", true);
        let due = LAST + QUIET_SECS + 60.0;
        assert!(saved(&mut m, frame(due, with_helper(LAST))).is_empty());
    }

    #[test]
    fn the_panes_core_never_saves() {
        let mut m = core("{}", false);
        assert!(saved(&mut m, frame(LAST + QUIET_SECS, working(LAST))).is_empty());
    }

    #[test]
    fn says_nothing_before_the_file_is_read_or_with_no_workspaces() {
        let mut m = Model::default();
        let _ = Cockpit.update(Event::PanelOn, &mut m);
        assert!(saved(&mut m, frame(LAST + QUIET_SECS, working(LAST))).is_empty());
        let held = r#"{"quiet": {"W": {"agent": "c", "since": 1000}}}"#;
        let mut m = core(held, true);
        let empty: Data =
            serde_json::from_value(serde_json::json!({"epoch": 5000, "workspaces": []})).unwrap();
        assert!(saved(&mut m, Event::Data(empty)).is_empty());
        assert!(saved(&mut m, Event::Data(Data::default())).is_empty());
    }
}
