//! A card whose chat is idle while a background agent it started still
//! runs reads "Running 4m · 1 agent" in working blue, as a shell does,
//! rather than Idle (the #2800 qualify-4b card, 2026-11-12; one Running
//! status since #359, read from the `background` record). The `subagents`
//! map still feeds the helper words and the agent run counts.

use cockpit_core::data::{Agent, Data};
use cockpit_core::session::Session;
use cockpit_core::status::{Status, StatusKind};
use cockpit_core::theme::Token;
use cockpit_core::ui::Urgency;

use crate::support::*;

const NOW: f64 = 1_000_000.0;

const STATE: &str = r#"{
    "subagents": {
        "one": [{"id": "t1", "session": "chat", "label": "Build and run seven crew checks", "startedEpoch": 100}],
        "two": [
            {"id": "t1", "session": "chat", "label": "First", "startedEpoch": 100},
            {"id": "t2", "session": "chat", "label": "Second", "startedEpoch": 100}
        ],
        "done": [{"id": "t1", "session": "chat", "label": "Done", "startedEpoch": 100, "endedEpoch": 200}],
        "both": [{"id": "t1", "session": "chat", "label": "Alongside", "startedEpoch": 100}],
        "quiet": [{"id": "t1", "session": "chat", "label": "Checks", "startedEpoch": 100}],
        "said": [{"id": "t1", "session": "chat", "label": "Checks", "startedEpoch": 100}],
        "prReady": [{"id": "t1", "session": "chat", "label": "Checks", "startedEpoch": 100}],
        "theirs": [{"id": "t1", "session": "other-chat", "label": "Theirs", "startedEpoch": 100}],
        "oldOnly": [{"id": "t1", "session": "chat", "label": "Old", "startedEpoch": 100}]
    },
    "background": {
        "one": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}],
        "two": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}, {"id": "t2", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999800, "seenEpoch": 999900}],
        "both": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999800, "seenEpoch": 999900}, {"id": "b1", "type": "shell", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}],
        "quiet": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}],
        "said": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}],
        "prReady": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "chat", "startedEpoch": 999760, "seenEpoch": 999900}],
        "theirs": [{"id": "t1", "type": "subagent", "status": "running", "description": "d", "session": "other-chat", "startedEpoch": 999760, "seenEpoch": 999900}]
    },
    "shells": {
        "both": [{"id": "b1", "session": "chat", "startedEpoch": 100}]
    },
    "moves": {
        "quiet": {"text": "the checks agent is still waiting on its check session.", "epoch": 1000, "session": "chat", "idle": true}
    },
    "prs": {
        "prReady": {"url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat", "checks": [{"name": "build", "state": "pass"}], "number": 1, "mergeable": true}
    }
}"#;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(NOW, vec![], vec![]), Fx::default())
}

fn idle(fx: &mut Fx) -> Agent {
    fx.agent(Idle)
        .id("chat")
        .since(NOW - 240.0)
        .activity(NOW - 240.0)
}

mod background_agents_on_the_card {
    use super::*;

    #[test]
    fn reads_running_in_working_blue_not_idle_while_its_background_agent_runs() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").agents(vec![idle(&mut fx)]);
        assert_eq!(s.status_kind(&data, Some(&w)), StatusKind::Running);
        assert_eq!(s.status_line(&data, Some(&w)), "Running 4m · 1 agent");
        let info = s.status_info(&data, Some(&w));
        assert_eq!(info.dot, Some(Token::Blue));
        assert_eq!(info.urgency, Urgency::Working);
    }

    #[test]
    fn counts_each_live_background_agent() {
        let (mut s, data, mut fx) = setup();
        let w = ws("two").agents(vec![idle(&mut fx)]);
        assert_eq!(s.status_line(&data, Some(&w)), "Running 4m · 2 agents");
    }

    #[test]
    fn falls_back_to_the_word_and_age_alone_with_the_agent_count_dropped_whole() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").agents(vec![idle(&mut fx)]);
        assert_eq!(
            s.status_forms(&data, Some(&w)),
            ("Running 4m · 1 agent".to_string(), "Running 4m".to_string())
        );
    }

    #[test]
    fn reads_idle_once_its_background_agent_has_ended_or_with_none() {
        let (mut s, data, mut fx) = setup();
        let done = ws("done").agents(vec![idle(&mut fx)]);
        assert_eq!(s.status_line(&data, Some(&done)), "Idle 4m");
        let none = ws("none").agents(vec![idle(&mut fx)]);
        assert_eq!(s.status_line(&data, Some(&none)), "Idle 4m");
    }

    #[test]
    fn reads_only_the_background_record_never_the_old_subagent_map() {
        let (mut s, data, mut fx) = setup();
        let w = ws("oldOnly").agents(vec![idle(&mut fx)]);
        let a = idle(&mut fx);
        assert_eq!(
            s.own_run_count(Some(&w), &a),
            1,
            "the helper words still see it"
        );
        assert_eq!(s.status_line(&data, Some(&w)), "Idle 4m");
    }

    #[test]
    fn reads_idle_when_only_another_chat_in_the_workspace_runs_a_background_agent() {
        let (mut s, data, mut fx) = setup();
        let other = fx
            .agent(Idle)
            .id("other-chat")
            .since(NOW - 600.0)
            .activity(NOW - 600.0);
        let w = ws("theirs").agents(vec![idle(&mut fx), other]);
        let a = idle(&mut fx);
        assert_eq!(
            s.status_kind(&data, Some(&w)),
            StatusKind::Plain(Status::Idle),
            "the card speaks for the newer chat"
        );
        assert_eq!(s.status_line(&data, Some(&w)), "Idle 4m");
        assert_eq!(s.own_run_count(Some(&w), &a), 0);
        assert_eq!(
            s.live_run_count(Some(&w)),
            1,
            "the workspace still counts it"
        );
    }

    #[test]
    fn counts_no_saved_run_whose_chat_is_not_in_the_workspace() {
        let (mut s, _, mut fx) = setup();
        let w = ws("theirs").agents(vec![idle(&mut fx)]);
        let a = idle(&mut fx);
        assert_eq!(s.own_run_count(Some(&w), &a), 0);
    }

    #[test]
    fn counts_its_own_shell_beside_a_background_agent_from_the_earlier_start() {
        let (mut s, data, mut fx) = setup();
        let w = ws("both").agents(vec![idle(&mut fx)]);
        assert_eq!(s.status_kind(&data, Some(&w)), StatusKind::Running);
        assert_eq!(
            s.status_line(&data, Some(&w)),
            "Running 4m · 1 shell, 1 agent"
        );
    }

    #[test]
    fn leaves_a_working_chat_as_working() {
        let (mut s, data, mut fx) = setup();
        let w = ws("one").agents(vec![fx.agent(Working).id("chat").since(NOW - 60.0)]);
        assert!(s.status_line(&data, Some(&w)).starts_with("Working"));
    }

    #[test]
    fn stays_running_not_ready_on_a_nothing_for_you_turn_while_its_agent_runs() {
        let (mut s, data, mut fx) = setup();
        let a = fx
            .agent(Idle)
            .id("chat")
            .kind("claude")
            .since(1000.0)
            .activity(1000.0);
        let w = ws("quiet").unread(1.0).latest_at(950.0).agents(vec![a]);
        assert!(!s.is_ready(&data, Some(&w)));
        assert_eq!(s.status_kind(&data, Some(&w)), StatusKind::Running);
    }

    #[test]
    fn stays_ready_while_a_turn_that_wants_jon_is_unread() {
        let (mut s, data, mut fx) = setup();
        let w = ws("said").unread(2.0).agents(vec![idle(&mut fx)]);
        assert!(s.is_ready(&data, Some(&w)));
    }

    #[test]
    fn never_says_ready_to_merge_while_its_background_agent_runs() {
        let (mut s, data, mut fx) = setup();
        let w = ws("prReady").agents(vec![idle(&mut fx)]);
        assert!(!s.shows_merge_ready(&data, Some(&w)));
        assert_eq!(s.status_kind(&data, Some(&w)), StatusKind::Running);
    }

    #[test]
    fn sorts_with_the_working_cards() {
        let (mut s, data, mut fx) = setup();
        let helper = ws("one").agents(vec![idle(&mut fx)]);
        let working = ws("w").agents(vec![fx.agent(Working).id("other").since(NOW - 60.0)]);
        let plain = ws("none").agents(vec![idle(&mut fx)]);
        assert_eq!(
            s.state_rank(&data, Some(&helper)),
            s.state_rank(&data, Some(&working))
        );
        assert!(s.state_rank(&data, Some(&helper)) < s.state_rank(&data, Some(&plain)));
    }
}
