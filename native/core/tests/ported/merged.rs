//! test/merged.test.ts: a merged card dims and offers Park and Close,
//! with Keep in the card menu, which hides them for that PR. The state is
//! seeded as the TypeScript seeds __STATE__, so a Keep saved before the
//! last reload holds.

use cockpit_core::data::{Data, WorkspaceGroup};
use cockpit_core::lanes::LaneKey;
use cockpit_core::merged::MERGED_OPACITY;
use cockpit_core::persist::SavedState;
use cockpit_core::session::Session;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

const MERGED: &str = r#"{"number": 1, "url": "https://github.com/o/r/pull/1", "status": "merged", "branch": "feat"}"#;
const OPEN: &str =
    r#"{"number": 1, "url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat"}"#;
const LATER: &str = r#"{"number": 2, "url": "https://github.com/o/r/pull/2", "status": "merged", "branch": "feat"}"#;

fn state() -> String {
    let merged = [
        "done", "saved", "kept", "closes", "anchor", "busy", "parks", "inParked", "pinKept",
    ];
    let mut prs: Vec<String> = merged
        .iter()
        .map(|id| format!(r#""{id}": {MERGED}"#))
        .collect();
    prs.push(format!(r#""open": {OPEN}"#));
    prs.push(format!(r#""moved": {LATER}"#));
    format!(
        r#"{{"prs": {{{}}}, "mergeKept": {{"saved": 1, "moved": 1}}}}"#,
        prs.join(", ")
    )
}

fn groups() -> Vec<WorkspaceGroup> {
    vec![group("g-parked", "Parked").anchor("anchor")]
}

fn setup() -> (Session, Data, Fx) {
    (
        session(&state()),
        frame(NOW, groups(), vec![]),
        Fx::default(),
    )
}

/// The workspaces closed, in order.
fn closes(s: &Session) -> Vec<String> {
    calls(s)
        .into_iter()
        .filter(|(m, _)| m == "workspace.close")
        .flat_map(|(_, params)| params.into_iter().map(|(_, v)| v))
        .collect()
}

/// The state writes made, as "key=value".
fn saves(s: &Session) -> Vec<String> {
    sent(s)
        .into_iter()
        .map(|(k, v)| format!("{k}={}", v.map(|v| v.to_string()).unwrap_or_default()))
        .collect()
}

mod merged_cards {
    use super::*;

    #[test]
    fn reads_merged_from_the_pr_not_from_an_open_or_missing_one() {
        let (s, ..) = setup();
        assert!(s.is_merged(Some(&ws("done"))));
        assert!(!s.is_merged(Some(&ws("open"))));
        assert!(!s.is_merged(Some(&ws("none"))));
        assert!(!s.is_merged(None));
    }

    #[test]
    fn dims_a_merged_card_but_not_while_lit_or_while_it_still_wants_jon() {
        let (mut s, _, mut fx) = setup();
        assert_eq!(s.card_opacity(Some(&ws("done")), false), MERGED_OPACITY);
        assert_eq!(
            s.card_opacity(Some(&ws("done")), true),
            1.0,
            "a selected or dragged card reads at full strength"
        );
        assert_eq!(s.card_opacity(Some(&ws("done").unread(2.0)), false), 1.0);
        for st in [Working, NeedsInput] {
            let w = ws("done").agents(vec![fx.agent(st.clone())]);
            assert_eq!(s.card_opacity(Some(&w), false), 1.0, "{st:?}");
        }
        let idle = ws("done").agents(vec![fx.agent(Idle)]);
        assert_eq!(s.card_opacity(Some(&idle), false), MERGED_OPACITY);
        assert_eq!(s.card_opacity(Some(&ws("open")), false), 1.0);
        assert_eq!(s.card_opacity(None, false), 1.0);
    }

    #[test]
    fn offers_the_buttons_on_a_merged_card_only_never_on_an_anchor_or_a_pinned_one() {
        let (s, data, _) = setup();
        assert!(s.offers_merged_actions(&data, Some(&ws("done"))));
        assert!(!s.offers_merged_actions(&data, Some(&ws("open"))));
        assert!(
            !s.offers_merged_actions(&data, Some(&ws("anchor"))),
            "closing it would take the lane's anchor"
        );
        assert!(
            !s.offers_merged_actions(&data, Some(&ws("done").pinned())),
            "cmux will not close a pinned one"
        );
        assert!(!s.offers_merged_actions(&data, None));
    }

    #[test]
    fn offers_close_only_while_no_agent_there_is_working_or_asking() {
        let (mut s, data, mut fx) = setup();
        let idle = ws("busy").agents(vec![fx.agent(Idle)]);
        assert!(s.offers_close(&data, Some(&idle)));
        for st in [Working, NeedsInput] {
            let w = ws("busy").agents(vec![fx.agent(st.clone())]);
            assert!(!s.offers_close(&data, Some(&w)), "{st:?}");
        }
        let working = ws("busy").agents(vec![fx.agent(Working)]);
        s.close_merged(&data, Some(&working));
        assert!(closes(&s).is_empty(), "a live agent is never closed");
    }

    #[test]
    fn holds_a_keep_saved_before_the_last_reload_for_that_pr_only() {
        let (mut s, data, _) = setup();
        assert!(!s.offers_merged_actions(&data, Some(&ws("saved"))));
        assert_eq!(
            s.card_opacity(Some(&ws("saved")), false),
            MERGED_OPACITY,
            "kept cards stay dimmed"
        );
        assert!(
            s.offers_merged_actions(&data, Some(&ws("moved"))),
            "a later PR in that workspace offers them again"
        );
    }

    #[test]
    fn keep_hides_the_buttons_at_once_and_saves_the_prs_number_once() {
        let (mut s, data, _) = setup();
        s.keep_merged(&data, Some(&ws("kept")));
        assert!(!s.offers_merged_actions(&data, Some(&ws("kept"))));
        assert_eq!(saves(&s), ["mergeKept.kept=1"]);
        for w in [Some(ws("kept")), Some(ws("open")), None] {
            s.keep_merged(&data, w.as_ref());
        }
        assert_eq!(sent(&s).len(), 1, "nothing else writes");
    }

    /// Not in the TypeScript: a new state file that has not caught up
    /// with the Keep yet keeps it, as the sidebar's in-memory map does.
    #[test]
    fn keep_holds_over_a_state_file_that_has_not_caught_up() {
        let (mut s, data, _) = setup();
        s.keep_merged(&data, Some(&ws("kept")));
        s.reseed(SavedState::from_json(&state()).unwrap());
        assert!(!s.offers_merged_actions(&data, Some(&ws("kept"))));
    }

    #[test]
    fn close_closes_a_merged_cards_workspace_and_nothing_else() {
        let (mut s, data, _) = setup();
        s.close_merged(&data, Some(&ws("closes")));
        assert_eq!(closes(&s), ["closes"]);
        for w in [
            Some(ws("open")),
            Some(ws("saved")),
            Some(ws("anchor")),
            None,
        ] {
            s.close_merged(&data, w.as_ref());
        }
        assert_eq!(
            closes(&s),
            ["closes"],
            "only a card that offers the button closes"
        );
    }

    #[test]
    fn offers_park_until_the_card_is_in_parked_and_park_files_it_there() {
        let mut s = session(&state());
        let data = frame(
            NOW,
            groups(),
            vec![ws("anchor").title("Parked").group("g-parked"), ws("parks")],
        );
        let in_parked = ws("inParked").group("g-parked");
        assert!(!s.offers_park(&data, Some(&in_parked)), "already parked");
        assert!(
            !s.offers_park(&data, Some(&ws("open"))),
            "an open PR is not parked for you"
        );
        assert!(
            !s.offers_park(&data, Some(&ws("anchor"))),
            "an anchor cannot leave its lane"
        );
        let w = by_id(&data, "parks");
        assert!(s.offers_park(&data, Some(w)));
        assert!(calls(&s).is_empty(), "nothing moves until Park is tapped");
        s.park_merged(&data, Some(w));
        assert_eq!(
            calls(&s).last(),
            Some(&call(
                "workspace.group.add",
                &[("group_id", "g-parked"), ("workspace_id", "parks")]
            ))
        );
        assert_eq!(s.lane_of(&data, w), LaneKey::Parked);
        assert!(
            !s.offers_park(&data, Some(w)),
            "Park goes once it has done its job"
        );
    }

    #[test]
    fn names_keep_in_the_card_menu_by_what_tapping_it_would_do() {
        let (mut s, data, mut fx) = setup();
        assert_eq!(
            s.keep_label(&data, Some(&ws("done"))),
            "Keep, hide Park and Close"
        );
        assert_eq!(
            s.keep_label(&data, Some(&ws("saved"))),
            "Kept, Park and Close hidden"
        );
        assert_eq!(
            s.keep_label(&data, Some(&ws("done").pinned())),
            "Keep, hide Park",
            "a pinned card shows Park alone"
        );
        let parked_busy = ws("done").group("g-parked").agents(vec![fx.agent(Working)]);
        assert_eq!(
            s.keep_label(&data, Some(&parked_busy)),
            "Keep: for a merged PR's buttons",
            "no button shows, so none to hide"
        );
        for w in [Some(ws("open")), Some(ws("anchor")), None] {
            assert_eq!(
                s.keep_label(&data, w.as_ref()),
                "Keep: for a merged PR's buttons"
            );
        }
    }

    #[test]
    fn keep_hides_park_on_a_pinned_card_too() {
        let (mut s, data, _) = setup();
        s.keep_merged(&data, Some(&ws("pinKept").pinned()));
        assert_eq!(saves(&s), ["mergeKept.pinKept=1"]);
        assert!(!s.offers_park(&data, Some(&ws("pinKept").pinned())));
    }

    #[test]
    fn offers_a_merged_button_while_park_or_close_shows() {
        let (mut s, data, mut fx) = setup();
        assert!(s.offers_merged_chip(&data, Some(&ws("done"))));
        assert!(
            s.offers_merged_chip(&data, Some(&ws("done").pinned())),
            "Park alone"
        );
        let parked_busy = ws("done").group("g-parked").agents(vec![fx.agent(Working)]);
        assert!(!s.offers_merged_chip(&data, Some(&parked_busy)));
        assert!(!s.offers_merged_chip(&data, Some(&ws("open"))));
    }

    #[test]
    fn offers_park_alone_on_a_pinned_card_and_none_once_keep_is_tapped() {
        let (mut s, data, _) = setup();
        let pin = ws("parks").pinned();
        assert!(!s.offers_merged_actions(&data, Some(&pin)));
        assert!(
            s.offers_park(&data, Some(&pin)),
            "parking closes nothing, so a pin does not hide it"
        );
        assert!(
            !s.offers_park(&data, Some(&ws("saved"))),
            "Keep hides Park too"
        );
        let n = calls(&s).len();
        s.park_merged(&data, Some(&ws("saved")));
        assert_eq!(calls(&s).len(), n, "a kept card does not park");
    }
}
