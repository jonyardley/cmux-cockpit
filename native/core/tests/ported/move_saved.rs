//! test/move-saved.test.ts: a chat's saved "Your move" line on the
//! cockpit's cards. The size chip's place in the chips list is
//! card-chips.ts's, so those asserts are left for its lane.

use cockpit_core::data::{Agent, Data, Workspace};
use cockpit_core::moves::{
    MoveSize, NUDGE_WINDOW, asks_nothing, move_size, move_size_text, waiting_move,
};
use cockpit_core::persist::{SavedMove, move_description};
use cockpit_core::session::Session;

use crate::support::*;

const STATE: &str = r#"{
    "asking": {"asks": {"reason": "allow git push?", "epoch": 1000}, "quietAsks": {"reason": "allow git push?", "epoch": 1060}},
    "moves": {
        "quick": {"text": "the work is finished. Run /clear now.", "epoch": 1000, "session": "s-quick"},
        "decide": {"text": "reply \"1b 2a\".", "epoch": 1000, "session": "s-decide", "decisions": 2, "leans": "1b 2a"},
        "plain": {"text": "tell me which one you meant.", "epoch": 1000, "session": "s-plain"},
        "asks": {"text": "go", "epoch": 1000, "session": "s-asks"},
        "owned": {"text": "go", "epoch": 1000, "session": "sessA"},
        "bare": {"text": "go", "epoch": 1000},
        "quiet": {"text": "CI is running on #2171. I report when it lands.", "epoch": 1000, "session": "s-quiet", "idle": true},
        "legacy": {"text": "nothing. Waiting until CI lands.", "epoch": 1000, "session": "s-legacy"},
        "quietAsks": {"text": "CI is running.", "epoch": 1000, "session": "s-quietAsks", "idle": true},
        "quietDecide": {"text": "CI is running.", "epoch": 1000, "session": "s-quietDecide", "idle": true, "decisions": 2}
    }
}"#;

/// The prompt that began the turn, as cmux stamps latestAt.
const PROMPT_AT: f64 = 950.0;

fn setup() -> (Session, Data, Fx) {
    (session(STATE), frame(1060.0, vec![], vec![]), Fx::default())
}

/// The nudge about 60s after Stop, from the Claude session that saved `id`'s move.
fn waiting(fx: &mut Fx, id: &str, since: f64) -> Agent {
    fx.agent(NeedsInput)
        .id(&format!("s-{id}"))
        .kind("claude")
        .since(since)
        .activity(since)
}

/// Claude's Stop leaves the agent idle.
fn stopped(fx: &mut Fx, id: &str, since: f64) -> Agent {
    fx.agent(Idle)
        .id(&format!("s-{id}"))
        .kind("claude")
        .since(since)
        .activity(since)
}

/// A workspace whose last prompt came before the saved moves.
fn at(id: &str, agents: Vec<Agent>) -> Workspace {
    ws(id)
        .agents(agents)
        .latest_at(PROMPT_AT)
        .message("Jon, PR #120 is merged.")
}

fn line(text: &str) -> SavedMove {
    SavedMove {
        text: text.to_string(),
        ..SavedMove::default()
    }
}

fn text_of(m: Option<SavedMove>) -> Option<String> {
    m.map(|m| m.text)
}

mod move_size {
    use super::*;

    #[test]
    fn reads_decide_from_decisions_then_review_then_quick_else_nothing() {
        let decided = SavedMove {
            decisions: Some(1.0),
            ..line("read it")
        };
        assert_eq!(move_size(&decided), Some(MoveSize::Decide));
        let cases: [(&str, Option<MoveSize>); 11] = [
            ("Read the draft in #142 and say go.", Some(MoveSize::Review)),
            ("open https://claude.ai/artifact/x", Some(MoveSize::Review)),
            ("Run /clear now.", Some(MoveSize::Quick)),
            ("Run /clear now (see #2044).", Some(MoveSize::Quick)),
            ("look at the card after reload.", Some(MoveSize::Review)),
            ("paste this: ! gcloud auth login", Some(MoveSize::Quick)),
            ("say go", Some(MoveSize::Quick)),
            (
                "the work is finished and nothing follows.",
                Some(MoveSize::Quick),
            ),
            ("tell me which one you meant.", None),
            ("the algorithm is good", None),
            ("check the build passes.", None),
        ];
        for (text, want) in cases {
            assert_eq!(move_size(&line(text)), want, "{text}");
        }
    }

    #[test]
    fn gives_no_size_when_nothing_waits_on_jon() {
        let idle = SavedMove {
            idle: Some(true),
            ..line("CI is running; say go if you want it sooner.")
        };
        assert_eq!(move_size(&idle), None);
        for text in [
            "nothing. Waiting until CI lands.",
            "PR #130 is merged; nothing waits on you.",
            "done, nothing else waits on you. Read the notes if curious.",
        ] {
            assert_eq!(move_size(&line(text)), None, "{text}");
        }
    }

    #[test]
    fn words_the_chip() {
        assert_eq!(move_size_text(MoveSize::Quick, 0.0), "Quick");
        assert_eq!(move_size_text(MoveSize::Review, 0.0), "Review");
        assert_eq!(move_size_text(MoveSize::Decide, 1.0), "Decide");
        assert_eq!(move_size_text(MoveSize::Decide, 3.0), "Decide · 3");
    }
}

mod move_of {
    use super::*;

    #[test]
    fn shows_at_idle_straight_after_stop_when_the_move_is_newer_than_the_last_prompt() {
        let (mut s, _, mut fx) = setup();
        let w = at("quick", vec![stopped(&mut fx, "quick", 1000.0)]);
        assert_eq!(s.agent_of(Some(&w)).and_then(|a| a.status), Some(Idle));
        let want = "the work is finished. Run /clear now.";
        assert_eq!(text_of(s.move_of(Some(&w))).as_deref(), Some(want));
        assert_eq!(s.card_detail(Some(&w)), want);
        let late = at("quick", vec![stopped(&mut fx, "quick", 1000.0)]).latest_at(1003.0);
        assert!(
            s.move_of(Some(&late)).is_some(),
            "Stop in iMessage mode, slack aside"
        );
    }

    #[test]
    fn shows_none_when_no_prompt_is_known_since_the_moves_age_cannot_be_told() {
        let (mut s, _, mut fx) = setup();
        let w = ws("quick").agents(vec![stopped(&mut fx, "quick", 1000.0)]);
        assert_eq!(s.move_of(Some(&w)), None, "no latestAt");
        let zero = ws("quick")
            .agents(vec![stopped(&mut fx, "quick", 1000.0)])
            .latest_at(0.0);
        assert_eq!(s.move_of(Some(&zero)), None, "latestAt 0");
    }

    #[test]
    fn still_shows_after_the_nudge_restamps_the_spell_and_the_activity_a_minute_on() {
        let (mut s, _, mut fx) = setup();
        let w = at("quick", vec![waiting(&mut fx, "quick", 1060.0)]);
        assert_eq!(
            s.agent_of(Some(&w)).and_then(|a| a.status),
            Some(NeedsInput)
        );
        let want = "the work is finished. Run /clear now.";
        assert_eq!(text_of(s.move_of(Some(&w))).as_deref(), Some(want));
        assert_eq!(s.card_detail(Some(&w)), want);
        assert_eq!(s.needs_detail(Some(&w)), want);
    }

    #[test]
    fn is_gone_once_a_prompt_comes_after_it_a_new_turn_or_an_interrupted_one() {
        let (mut s, _, mut fx) = setup();
        let new_turn = at("quick", vec![stopped(&mut fx, "quick", 1000.0)]).latest_at(1100.0);
        assert_eq!(s.move_of(Some(&new_turn)), None);
        let interrupted = at("quick", vec![stopped(&mut fx, "quick", 1150.0)]).latest_at(1100.0);
        assert_eq!(s.move_of(Some(&interrupted)), None);
        let nudged = at("quick", vec![waiting(&mut fx, "quick", 1210.0)]).latest_at(1100.0);
        assert_eq!(s.move_of(Some(&nudged)), None, "nudged after the interrupt");
        let past = at("quick", vec![stopped(&mut fx, "quick", 1000.0)]).latest_at(1004.0);
        assert_eq!(s.move_of(Some(&past)), None, "past the slack");
    }

    #[test]
    fn is_null_while_it_works_while_it_asks_once_it_ended_or_without_a_saved_move() {
        let (mut s, _, mut fx) = setup();
        let own = |a: Agent| a.id("s-quick").kind("claude");
        let working = at("quick", vec![own(fx.agent(Working).since(1000.0))]);
        assert_eq!(s.move_of(Some(&working)), None);
        assert_eq!(
            s.move_of(Some(&at("asks", vec![waiting(&mut fx, "asks", 1000.0)]))),
            None
        );
        let ended = at("quick", vec![own(fx.agent(Ended).since(1010.0))]);
        assert_eq!(s.move_of(Some(&ended)), None);
        assert_eq!(
            s.move_of(Some(&at("none", vec![stopped(&mut fx, "none", 1000.0)]))),
            None
        );
    }
}

mod whose_move_it_is {
    use super::*;

    fn claude(fx: &mut Fx, id: &str) -> Agent {
        fx.agent(NeedsInput)
            .id(id)
            .kind("claude")
            .since(1000.0)
            .activity(1000.0)
    }

    #[test]
    fn goes_only_to_the_claude_agent_whose_id_is_the_moves_session() {
        let (s, _, mut fx) = setup();
        let mine = claude(&mut fx, "sessA");
        let other = claude(&mut fx, "sessB");
        let w = at("owned", vec![mine.clone(), other.clone()]);
        assert_eq!(
            text_of(waiting_move(&s.saved, Some(&mine), Some(&w), false)).as_deref(),
            Some("go")
        );
        assert_eq!(waiting_move(&s.saved, Some(&other), Some(&w), false), None);
    }

    #[test]
    fn shows_none_for_a_move_saved_with_no_session() {
        let (s, _, mut fx) = setup();
        let a = claude(&mut fx, "sessA");
        let w = at("bare", vec![a.clone()]);
        assert_eq!(waiting_move(&s.saved, Some(&a), Some(&w), false), None);
    }

    #[test]
    fn shows_none_to_a_new_session_in_the_same_workspace_clear_a_relaunch_resume() {
        let (s, _, mut fx) = setup();
        let fresh_one = claude(&mut fx, "sessNew");
        let w = at("owned", vec![fresh_one.clone()]);
        assert_eq!(
            waiting_move(&s.saved, Some(&fresh_one), Some(&w), false),
            None
        );
    }

    #[test]
    fn shows_none_while_the_agent_is_still_on_its_pending_claude_alias() {
        let (s, _, mut fx) = setup();
        let pending = claude(&mut fx, "pending-claude-1");
        let w = at("owned", vec![pending.clone()]);
        assert_eq!(
            waiting_move(&s.saved, Some(&pending), Some(&w), false),
            None
        );
    }

    #[test]
    fn shows_none_to_a_codex_agent_even_one_carrying_the_session_as_its_id() {
        let (s, _, mut fx) = setup();
        let codex = claude(&mut fx, "sessA").kind("codex");
        let w = at("owned", vec![codex.clone()]);
        assert_eq!(waiting_move(&s.saved, Some(&codex), Some(&w), false), None);
        let unknown = fx
            .agent(NeedsInput)
            .id("sessA")
            .since(1000.0)
            .activity(1000.0);
        let w = at("owned", vec![unknown.clone()]);
        assert_eq!(
            waiting_move(&s.saved, Some(&unknown), Some(&w), false),
            None,
            "no kind reported"
        );
    }
}

mod the_card {
    use super::*;

    #[test]
    fn quotes_the_move_over_the_message_on_the_card_and_the_needs_you_row() {
        let (mut s, _, mut fx) = setup();
        let w = at("quick", vec![waiting(&mut fx, "quick", 1000.0)]);
        let want = "the work is finished. Run /clear now.";
        assert_eq!(s.card_detail(Some(&w)), want);
        assert_eq!(s.needs_detail(Some(&w)), want);
    }

    #[test]
    fn keeps_the_message_once_the_move_is_stale() {
        let (mut s, _, mut fx) = setup();
        let w = at("quick", vec![waiting(&mut fx, "quick", 2000.0)])
            .latest_at(1900.0)
            .message("Something new.");
        assert_eq!(s.card_detail(Some(&w)), "Something new.");
    }

    #[test]
    fn falls_back_to_the_message_then_a_plain_line_when_there_is_no_move() {
        let (mut s, _, mut fx) = setup();
        let w = at("none", vec![stopped(&mut fx, "none", 1000.0)]).message("Jon, the reply.");
        assert_eq!(s.card_detail(Some(&w)), "Jon, the reply.");
        let needs = at("none", vec![waiting(&mut fx, "none", 1000.0)]).message("");
        assert_eq!(s.needs_detail(Some(&needs)), "Waiting for your reply");
    }

    /// Partly ported: the chips list is card-chips.ts's; the card's detail line is checked here.
    #[test]
    fn leads_the_chips_with_the_size_and_has_no_size_chip_when_the_line_gives_no_clue() {
        let (mut s, _, mut fx) = setup();
        let decide = s.move_of(Some(&at(
            "decide",
            vec![waiting(&mut fx, "decide", 1000.0)],
        )));
        let decide = decide.unwrap();
        assert_eq!(move_size(&decide), Some(MoveSize::Decide));
        assert_eq!(
            move_size_text(MoveSize::Decide, decide.decisions.unwrap_or(0.0)),
            "Decide · 2"
        );
        let plain_ws = at("plain", vec![waiting(&mut fx, "plain", 1000.0)]);
        let plain = s.move_of(Some(&plain_ws)).unwrap();
        assert_eq!(move_size(&plain), None);
        assert_eq!(
            s.card_detail(Some(&plain_ws)),
            "tell me which one you meant."
        );
    }
}

mod a_turn_that_ended_on_nothing_for_you {
    use super::*;

    #[test]
    fn asks_nothing_when_saved_as_idle_or_in_the_older_wordings_but_not_for_nothing_follows() {
        let idle = SavedMove {
            idle: Some(true),
            ..line("CI is running.")
        };
        assert!(asks_nothing(&idle));
        assert!(asks_nothing(&line("nothing. Waiting until CI lands.")));
        assert!(asks_nothing(&line("Nothing: the pass is running.")));
        assert!(asks_nothing(&line(
            "PR #130 is merged; nothing waits on you."
        )));
        assert!(!asks_nothing(&line(
            "the work is finished and nothing follows. /clear now."
        )));
        assert!(!asks_nothing(&line("Nothing follows: /clear now.")));
        assert!(!asks_nothing(&line("nothing pending. /clear now.")));
        assert!(!asks_nothing(&line("nothing to decide, say go.")));
        let decided = SavedMove {
            decisions: Some(1.0),
            ..idle.clone()
        };
        assert!(!asks_nothing(&decided), "decisions still wait");
        assert!(!asks_nothing(&line("say go.")));
    }

    /// Partly ported: the chips list is card-chips.ts's; the size chip itself is checked.
    #[test]
    fn reads_as_idle_once_the_nudge_lands_since_the_turn_ended_and_leaves_needs_you() {
        let (mut s, _, mut fx) = setup();
        let w = at("quiet", vec![waiting(&mut fx, "quiet", 1060.0)]);
        let data = frame(1060.0, vec![], vec![w.clone()]);
        let a = s.agent_of(Some(&w));
        assert_eq!(a.as_ref().and_then(|a| a.status.clone()), Some(Idle));
        assert_eq!(
            a.and_then(|a| a.since_epoch),
            Some(1000.0),
            "idle since the turn ended, not since the nudge"
        );
        assert!(!s.has_real_ask(Some(&w)));
        assert!(s.needs_list(&data).is_empty());
        assert_eq!(
            s.card_detail(Some(&w)),
            "CI is running on #2171. I report when it lands."
        );
        assert_eq!(
            s.move_of(Some(&w)).as_ref().and_then(move_size),
            None,
            "no size chip"
        );
    }

    #[test]
    fn reads_the_older_your_move_nothing_line_the_same_way() {
        let (mut s, _, mut fx) = setup();
        let w = at("legacy", vec![waiting(&mut fx, "legacy", 1060.0)]);
        assert_eq!(s.agent_of(Some(&w)).and_then(|a| a.status), Some(Idle));
    }

    #[test]
    fn still_needs_jon_on_a_your_move_line_a_new_prompt_since_or_a_real_ask() {
        let (mut s, _, mut fx) = setup();
        let quick = at("quick", vec![waiting(&mut fx, "quick", 1060.0)]);
        assert_eq!(
            s.agent_of(Some(&quick)).and_then(|a| a.status),
            Some(NeedsInput)
        );
        let later = at("quiet", vec![waiting(&mut fx, "quiet", 1160.0)]).latest_at(1100.0);
        assert_eq!(
            s.agent_of(Some(&later)).and_then(|a| a.status),
            Some(NeedsInput)
        );
        let asks = waiting(&mut fx, "quietAsks", 1060.0);
        let aw = at("quietAsks", vec![asks.clone()]);
        assert_eq!(s.effective_agent(&asks, Some(&aw)).status, Some(NeedsInput));
    }

    #[test]
    fn still_needs_jon_on_a_later_stop_with_no_prompt_between_or_with_decisions_laid_out() {
        let (mut s, _, mut fx) = setup();
        let woke = at(
            "quiet",
            vec![waiting(&mut fx, "quiet", 1000.0 + NUDGE_WINDOW + 1.0)],
        );
        assert_eq!(
            s.agent_of(Some(&woke)).and_then(|a| a.status),
            Some(NeedsInput)
        );
        let decide = at("quietDecide", vec![waiting(&mut fx, "quietDecide", 1060.0)]);
        assert_eq!(
            s.agent_of(Some(&decide)).and_then(|a| a.status),
            Some(NeedsInput)
        );
    }

    #[test]
    fn is_no_ask_ready_once_there_is_output_and_no_shell_runs_and_nothing_to_dismiss() {
        let (mut s, data, mut fx) = setup();
        let w = at("quiet", vec![waiting(&mut fx, "quiet", 1060.0)]).unread(1.0);
        assert!(!s.has_real_ask(Some(&w)));
        assert!(!s.is_needs_dismissed(Some(&w)));
        assert!(s.is_ready(&data, Some(&w)));
    }

    #[test]
    fn is_ready_with_unread_output_when_the_turn_ended_on_a_your_move_line() {
        let (mut s, data, mut fx) = setup();
        let w = at("quick", vec![stopped(&mut fx, "quick", 1000.0)]).unread(1.0);
        assert!(s.is_ready(&data, Some(&w)));
    }

    #[test]
    fn leaves_another_sessions_agent_alone() {
        let (mut s, _, mut fx) = setup();
        let other = fx
            .agent(NeedsInput)
            .id("s-other")
            .kind("claude")
            .since(1060.0)
            .activity(1060.0);
        let w = at("quiet", vec![other]);
        assert_eq!(
            s.agent_of(Some(&w)).and_then(|a| a.status),
            Some(NeedsInput)
        );
    }
}

mod a_move_in_the_workspace_description {
    use super::*;

    fn described(
        fx: &mut Fx,
        id: &str,
        text: &str,
        epoch: f64,
        decisions: Option<f64>,
    ) -> Workspace {
        let m = SavedMove {
            text: text.to_string(),
            epoch,
            session: Some(format!("s-{id}")),
            decisions,
            ..SavedMove::default()
        };
        at(id, vec![stopped(fx, id, epoch)]).description(&move_description(&m))
    }

    #[test]
    fn shows_with_no_saved_move_and_no_rebuild_decisions_and_all() {
        let (mut s, _, mut fx) = setup();
        let w = described(&mut fx, "live", "reply \"1a\".", 1000.0, Some(1.0));
        let m = s.move_of(Some(&w));
        assert_eq!(m.as_ref().map(|m| m.text.as_str()), Some("reply \"1a\"."));
        assert_eq!(m.and_then(|m| m.decisions), Some(1.0));
        assert_eq!(s.card_detail(Some(&w)), "reply \"1a\".");
    }

    #[test]
    fn loses_to_a_newer_saved_move_and_wins_over_an_older_one() {
        let (mut s, _, mut fx) = setup();
        let older = described(&mut fx, "quick", "older", 990.0, None);
        assert_eq!(
            text_of(s.move_of(Some(&older))).as_deref(),
            Some("the work is finished. Run /clear now.")
        );
        let newer = described(&mut fx, "quick", "newer", 1010.0, None);
        assert_eq!(text_of(s.move_of(Some(&newer))).as_deref(), Some("newer"));
    }

    #[test]
    fn never_shows_its_raw_form_once_a_prompt_has_retired_it() {
        let (mut s, _, mut fx) = setup();
        let w = described(&mut fx, "live", "say go", 1000.0, None)
            .latest_at(1100.0)
            .message("");
        assert_eq!(s.move_of(Some(&w)), None);
        assert_eq!(s.card_detail(Some(&w)), "");
        let own = ws("own").description("Jon's own words");
        assert_eq!(s.card_detail(Some(&own)), "Jon's own words");
    }
}
