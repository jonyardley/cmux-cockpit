//! test/needs.test.ts

use cockpit_core::status::Status;

use crate::support::*;

/// A Claude turn that ended at `ended`, then flagged needs_input at `flagged`.
fn claude(fx: &mut Fx, ended: f64, flagged: f64) -> cockpit_core::data::Agent {
    fx.agent(NeedsInput)
        .kind("claude")
        .activity(ended)
        .since(flagged)
}

mod effective_agent {
    use super::*;

    #[test]
    fn shows_every_needs_input_as_it_came_however_long_after_the_last_activity() {
        let mut fx = Fx::default();
        let s = fresh();
        for flagged in [1001.0, 1060.0, 5000.0] {
            let ask = claude(&mut fx, 1000.0, flagged);
            assert_eq!(s.effective_agent(&ask, None), ask, "{flagged}");
        }
        let by_message = fx.agent(NeedsInput).kind("claude").since(1060.0);
        let m = ws("m").latest_at(1000.0);
        assert_eq!(s.effective_agent(&by_message, Some(&m)), by_message);
        let busy = fx.agent(Working);
        assert_eq!(s.effective_agent(&busy, None), busy);
    }

    #[test]
    fn leaves_an_idle_agent_idle_from_the_end_of_its_turn() {
        let mut fx = Fx::default();
        let s = fresh();
        let idle = fx.agent(Idle).kind("claude").activity(1000.0).since(1000.0);
        assert_eq!(s.effective_agent(&idle, None), idle);
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
    fn dismiss_a_needs_input_that_came_a_minute_after_the_last_activity() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let w = ws("n").agents(vec![claude(&mut fx, 1000.0, 1060.0)]);
        s.dismiss_needs(Some(&w));
        assert!(s.is_needs_dismissed(Some(&w)));
        assert_eq!(statuses(&mut s, &w), [Some(Idle)]);
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
    fn the_cockpit_reads_a_needs_input_as_an_ask_late_or_not() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let late = ws("late").agents(vec![claude(&mut fx, 1000.0, 1060.0)]);
        assert_eq!(s.status_of(Some(&late)), Status::NeedsInput);
        let w = ws("c").agents(vec![
            claude(&mut fx, 1000.0, 1001.0),
            fx.agent(Working).activity(900.0),
        ]);
        assert_eq!(s.status_of(Some(&w)), Status::NeedsInput);
    }
}
