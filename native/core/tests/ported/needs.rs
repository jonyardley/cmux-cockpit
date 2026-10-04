//! test/needs.test.ts

use cockpit_core::needs::{NUDGE_GAP, is_idle_nudge};
use cockpit_core::persist::SavedState;
use cockpit_core::status::Status;

use crate::support::*;

fn saved() -> SavedState {
    SavedState::default()
}

/// A Claude turn that ended at `ended`, then flagged needs_input at `flagged`.
fn claude(fx: &mut Fx, ended: f64, flagged: f64) -> cockpit_core::data::Agent {
    fx.agent(NeedsInput)
        .kind("claude")
        .activity(ended)
        .since(flagged)
}

mod is_idle_nudge {
    use super::*;

    #[test]
    fn reads_a_needs_input_a_minute_after_the_last_activity_as_the_idle_nudge() {
        let mut fx = Fx::default();
        assert!(is_idle_nudge(
            &saved(),
            &claude(&mut fx, 1000.0, 1060.0),
            None
        ));
        assert!(is_idle_nudge(
            &saved(),
            &claude(&mut fx, 1000.0, 1000.0 + NUDGE_GAP),
            None
        ));
    }

    #[test]
    fn keeps_a_real_ask_that_follows_the_agents_activity() {
        let mut fx = Fx::default();
        assert!(!is_idle_nudge(
            &saved(),
            &claude(&mut fx, 1000.0, 1002.0),
            None
        ));
        assert!(!is_idle_nudge(
            &saved(),
            &claude(&mut fx, 1000.0, 1000.0 + NUDGE_GAP - 1.0),
            None
        ));
    }

    #[test]
    fn closes_the_gap_when_the_workspaces_latest_message_is_newer() {
        let mut fx = Fx::default();
        let w = ws("w").latest_at(1058.0);
        assert!(!is_idle_nudge(
            &saved(),
            &claude(&mut fx, 1000.0, 1060.0),
            Some(&w)
        ));
    }

    #[test]
    fn fails_towards_needs_you_when_a_timestamp_is_missing_or_the_agent_is_not_claude() {
        let mut fx = Fx::default();
        let s = saved();
        assert!(!is_idle_nudge(
            &s,
            &fx.agent(NeedsInput).kind("claude").activity(1000.0),
            None
        ));
        assert!(!is_idle_nudge(
            &s,
            &fx.agent(NeedsInput).kind("claude").since(1060.0),
            None
        ));
        let codex = fx
            .agent(NeedsInput)
            .kind("codex")
            .activity(1000.0)
            .since(1060.0);
        assert!(!is_idle_nudge(&s, &codex, None));
        let idle = fx.agent(Idle).kind("claude").activity(1000.0).since(1060.0);
        assert!(!is_idle_nudge(&s, &idle, None));
    }
}

mod effective_agent {
    use super::*;

    #[test]
    fn shows_a_nudge_as_idle_and_leaves_other_agents_alone() {
        let mut fx = Fx::default();
        let s = fresh();
        let nudge = claude(&mut fx, 1000.0, 1060.0);
        assert_eq!(s.effective_agent(&nudge, None).status, Some(Idle));
        assert_eq!(
            nudge.status,
            Some(NeedsInput),
            "the app's object is not changed"
        );
        let ask = claude(&mut fx, 1000.0, 1001.0);
        assert_eq!(s.effective_agent(&ask, None), ask);
        let busy = fx.agent(Working);
        assert_eq!(s.effective_agent(&busy, None), busy);
    }

    #[test]
    fn dates_a_nudges_idle_from_the_end_of_the_turn() {
        let mut fx = Fx::default();
        let s = fresh();
        let nudge = claude(&mut fx, 1000.0, 1060.0);
        assert_eq!(s.effective_agent(&nudge, None).since_epoch, Some(1000.0));
        let by_message = fx.agent(NeedsInput).kind("claude").since(1060.0);
        let m = ws("m").latest_at(1000.0);
        let shown = s.effective_agent(&by_message, Some(&m));
        assert_eq!(shown.status, Some(Idle));
        assert_eq!(shown.since_epoch, Some(1060.0));
    }
}

mod dismissals {
    use super::*;

    fn statuses(
        s: &mut cockpit_core::session::Session,
        w: &cockpit_core::data::Workspace,
    ) -> Vec<Option<cockpit_core::data::AgentStatus>> {
        s.agents_of(Some(w)).into_iter().map(|a| a.status).collect()
    }

    #[test]
    fn hide_every_ask_in_the_workspace_until_one_asks_again() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let mut w = ws("d").agents(vec![
            fx.agent(NeedsInput).since(500.0),
            fx.agent(NeedsInput).since(600.0),
        ]);
        assert!(!s.is_needs_dismissed(Some(&w)));
        s.dismiss_needs(Some(&w));
        assert!(s.is_needs_dismissed(Some(&w)));
        assert_eq!(statuses(&mut s, &w), [Some(Idle), Some(Idle)]);
        w = w.agents(vec![fx.agent(NeedsInput).since(900.0)]);
        assert!(!s.is_needs_dismissed(Some(&w)));
        assert_eq!(statuses(&mut s, &w), [Some(NeedsInput)]);
    }

    #[test]
    fn are_per_workspace_and_can_be_restored() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let a = ws("a").agents(vec![fx.agent(NeedsInput).since(500.0)]);
        let b = ws("b").agents(vec![fx.agent(NeedsInput).since(500.0)]);
        s.dismiss_needs(Some(&a));
        assert!(!s.is_needs_dismissed(Some(&b)));
        s.restore_needs(Some(&a));
        assert!(!s.is_needs_dismissed(Some(&a)));
        s.restore_needs(Some(&a));
        assert!(!s.is_needs_dismissed(Some(&a)));
    }

    #[test]
    fn end_with_the_spell_so_a_later_ask_with_the_same_start_still_shows() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let asker = fx.agent(NeedsInput);
        let mut w = ws("s").agents(vec![asker.clone()]);
        s.dismiss_needs(Some(&w));
        assert_eq!(statuses(&mut s, &w), [Some(Idle)]);
        let mut working = asker.clone();
        working.status = Some(Working);
        w = w.agents(vec![working]);
        s.agents_of(Some(&w));
        w = w.agents(vec![asker]);
        assert_eq!(statuses(&mut s, &w), [Some(NeedsInput)]);
    }

    #[test]
    fn do_not_hide_a_second_agent_that_asks_after_the_dismissal() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let first = fx.agent(NeedsInput).since(500.0);
        let mut w = ws("t").agents(vec![first.clone()]);
        s.dismiss_needs(Some(&w));
        w = w.agents(vec![first, fx.agent(NeedsInput).since(500.0)]);
        assert!(
            !s.is_needs_dismissed(Some(&w)),
            "the menu offers Dismiss, not Restore"
        );
        assert_eq!(statuses(&mut s, &w), [Some(Idle), Some(NeedsInput)]);
    }

    #[test]
    fn have_nothing_to_dismiss_when_the_only_ask_is_a_nudge() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let w = ws("n").agents(vec![claude(&mut fx, 1000.0, 1060.0)]);
        s.dismiss_needs(Some(&w));
        assert!(!s.is_needs_dismissed(Some(&w)));
    }

    #[test]
    fn ignore_a_workspace_with_nothing_to_dismiss() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let w = ws("q").agents(vec![fx.agent(Working)]);
        s.dismiss_needs(Some(&w));
        s.dismiss_needs(None);
        assert!(!s.is_needs_dismissed(Some(&w)));
        assert!(s.agents_of(None).is_empty());
    }

    #[test]
    fn dismiss_needs_persists_the_workspaces_dismissed_asks_restore_needs_a_delete_issue_5() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let asker = fx.agent(NeedsInput).since(500.0);
        let w = ws("persist-d").agents(vec![asker.clone()]);
        s.dismiss_needs(Some(&w));
        let value = format!("{{\"{}\":500}}", asker.id);
        let expected = format!(
            "cmux-cockpit://set?key=dismissed.persist-d&value={}",
            cockpit_core::js::encode_uri_component(&value)
        );
        assert_eq!(opened(&s), [expected]);
        s.take_outbox();
        s.restore_needs(Some(&w));
        assert_eq!(opened(&s), ["cmux-cockpit://set?key=dismissed.persist-d"]);
    }

    #[test]
    fn persists_only_dated_spells_so_an_undated_ask_cannot_stay_hidden_across_reloads() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let w = ws("undated").agents(vec![fx.agent(NeedsInput)]);
        s.dismiss_needs(Some(&w));
        assert!(s.is_needs_dismissed(Some(&w)));
        assert_eq!(opened(&s), ["cmux-cockpit://set?key=dismissed.undated"]);
    }

    #[test]
    fn keep_a_dismissal_while_its_agent_is_not_reported_yet_as_straight_after_a_reload() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let asker = fx.agent(NeedsInput).since(700.0);
        let mut w = ws("late-agents").agents(vec![asker.clone()]);
        s.dismiss_needs(Some(&w));
        w = w.agents(vec![]);
        s.agents_of(Some(&w));
        w = w.agents(vec![asker]);
        assert!(s.is_needs_dismissed(Some(&w)));
    }

    #[test]
    fn does_not_persist_anything_when_there_is_nothing_to_dismiss_or_restore() {
        let mut fx = Fx::default();
        let mut s = fresh();
        s.dismiss_needs(Some(&ws("empty-persist").agents(vec![fx.agent(Working)])));
        s.dismiss_needs(None);
        s.restore_needs(Some(&ws("never-dismissed")));
        s.restore_needs(None);
        assert!(opened(&s).is_empty());
    }
}

mod both_sidebars_apply_the_rule {
    use super::*;

    #[test]
    fn the_cockpit_ranks_a_working_agent_over_a_nudge_beside_it() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let w = ws("c").agents(vec![
            claude(&mut fx, 1000.0, 1060.0),
            fx.agent(Working).activity(900.0),
        ]);
        assert_eq!(s.status_of(Some(&w)), Status::Working);
        let n = ws("n").agents(vec![claude(&mut fx, 1000.0, 1060.0)]);
        assert_eq!(s.status_of(Some(&n)), Status::Idle);
    }
}
