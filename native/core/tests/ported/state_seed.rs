//! test/state-seed.test.ts: a dismissal or a project override made before
//! the last reload still holds at the next one (issues #5 and #8).

use cockpit_core::session::Session;

use crate::support::*;

const STATE: &str = r#"{
    "dismissed": {"w1": {"a1": 500}},
    "projectOverride": {"w2": "/dev/app-one", "w3": "not-a-project"},
    "projects": {}, "prs": {}, "subagents": {}, "ui": {}
}"#;

fn setup() -> Session {
    session(STATE)
}

mod needs_seeds_dismissed_from_the_saved_state_issue_5 {
    use super::*;

    #[test]
    fn shows_the_saved_dismissals_agent_as_idle_and_only_that_exact_spell() {
        let (mut fx, mut s) = (Fx::default(), setup());
        // The first agent here gets id "a1", to match the seed.
        let asker = fx.agent(NeedsInput).since(500.0);
        let mut w = ws("w1").agents(vec![asker.clone()]);
        assert!(s.is_needs_dismissed(Some(&w)));
        assert_eq!(s.agents_of(Some(&w))[0].status, Some(Idle));
        w = w.agents(vec![asker.since(900.0)]);
        assert!(!s.is_needs_dismissed(Some(&w)));
    }
}

mod by_project_seeds_project_override_from_the_saved_state_issue_8 {
    use super::*;

    #[test]
    fn keeps_a_saved_override_for_a_configured_project() {
        let s = setup();
        assert!(s.has_project_override(Some(&ws("w2"))));
        let w2 = ws("w2").directory("/Users/coder/dev/app-two");
        assert_eq!(s.project_key(&w2), "/dev/app-one");
    }

    #[test]
    fn drops_a_saved_override_that_no_longer_names_a_configured_project() {
        assert!(!setup().has_project_override(Some(&ws("w3"))));
    }

    #[test]
    fn keeps_the_seeded_override_through_an_empty_or_partial_workspace_list_at_startup() {
        let mut s = setup();
        let mut data = frame(1_000_000.0, vec![], vec![]);
        s.card_workspaces(&data);
        assert!(s.has_project_override(Some(&ws("w2"))));

        data.workspaces = Some(vec![ws("other")]);
        s.card_workspaces(&data);
        assert!(s.has_project_override(Some(&ws("w2"))));

        data.workspaces = Some(vec![
            ws("w2").directory("/Users/coder/dev/app-two"),
            ws("other"),
        ]);
        assert_eq!(s.project_key(by_id(&data, "w2")), "/dev/app-one");
    }
}
