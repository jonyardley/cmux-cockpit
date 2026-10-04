//! test/helpers-saved.test.ts: a card's helper count from the saved
//! subagent runs (issues #6 and #47).

use cockpit_core::session::Session;

use crate::support::*;

fn setup() -> Session {
    let run = |id: &str, session: &str, ended: &str| {
        format!(
            r#"{{"id": "{id}", "session": "{session}", "label": "Label {id}", "startedEpoch": 100{ended}}}"#
        )
    };
    let state = format!(
        r#"{{"subagents": {{"w1": [{}, {}, {}], "matched": [{}]}}}}"#,
        run("a", "sess-a", r#", "endedEpoch": 200"#),
        run("b", "sess-b", ""),
        run("c", "sess-c", ""),
        run("m", "owner", ""),
    );
    session(&state)
}

mod saved_helper_count {
    use super::*;

    #[test]
    fn counts_saved_runs_with_no_end_while_a_workspace_agent_is_live() {
        let (mut fx, mut s) = (Fx::default(), setup());
        let w = ws("w1").agents(vec![fx.agent(Working)]);
        assert_eq!(s.live_run_count(Some(&w)), 2);
        assert_eq!(s.helper_text(Some(&w)), "· 2 helpers");
    }

    #[test]
    fn counts_none_once_every_workspace_agent_has_ended() {
        let (mut fx, mut s) = (Fx::default(), setup());
        assert_eq!(
            s.live_run_count(Some(&ws("w1").agents(vec![fx.agent(Ended)]))),
            0
        );
    }

    #[test]
    fn follows_the_owning_agents_status_when_the_session_matches() {
        let (mut fx, mut s) = (Fx::default(), setup());
        let owner = fx.agent(Ended).id("owner");
        let w = ws("matched").agents(vec![owner, fx.agent(Working)]);
        assert_eq!(s.live_run_count(Some(&w)), 0);
    }

    #[test]
    fn counts_cmuxs_own_children_once_any_agent_carries_some_with_the_saved_runs_still_live_83() {
        let (mut fx, mut s) = (Fx::default(), setup());
        // cmux settled "c", but its saved run has no end, so it still
        // counts; "b" is live and cmux no longer sends it; "a" ended.
        let settled = |id| fx_child(id);
        let w = ws("w1").agents(vec![fx.agent(Working).children(vec![settled("c")])]);
        assert_eq!(s.live_run_count(Some(&w)), 2);
        let ended = ws("w1").agents(vec![fx.agent(Working).children(vec![settled("a")])]);
        assert_eq!(s.live_run_count(Some(&ended)), 2);
    }

    #[test]
    fn counts_nothing_for_a_workspace_with_no_saved_runs() {
        let (mut fx, mut s) = (Fx::default(), setup());
        assert_eq!(
            s.live_run_count(Some(&ws("none").agents(vec![fx.agent(Working)]))),
            0
        );
    }

    fn fx_child(id: &str) -> Option<cockpit_core::data::SubagentRun> {
        run(id, Some(false), Some(5.0))
    }
}
