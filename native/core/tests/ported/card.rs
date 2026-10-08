//! test/card.test.ts: the status line with its time and helper count, the
//! agent's message, the progress fraction, the outline, chipsFor, and
//! chips.ts: showsChipsRow, cardChips, chipsFitOneLine, chipsSplit and
//! secondLineFits.

use cockpit_core::card_chips::Chip;
use cockpit_core::chips::{FULL_LINE_CHARS, PROJECT_LINE_CHARS, chips_fit_one_line, chips_split};
use cockpit_core::data::{Data, PrStatus, Progress, PullRequest, Workspace};
use cockpit_core::session::Session;
use cockpit_core::status::{
    DETAIL_MAX, OUTLINE_MAX, Outline, PrRef, open_pr_label, outline, progress_fraction,
};
use cockpit_core::theme::Token;

use crate::support::*;

const NOW: f64 = 1_000_100.0;

fn data() -> Data {
    frame(NOW, vec![], vec![])
}

mod status_line {
    use super::*;

    #[test]
    fn says_how_long_the_status_has_held() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![fx.agent(Working).since(NOW - 14.0 * 60.0)]);
        assert_eq!(s.status_line(&data(), Some(&w)), "Working 14m");
    }

    #[test]
    fn reads_the_most_active_agents_time() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![
            fx.agent(Idle).since(NOW - 7200.0),
            fx.agent(Working).since(NOW - 30.0),
        ]);
        assert_eq!(s.status_line(&data(), Some(&w)), "Working <1m");
    }

    #[test]
    fn leaves_the_time_off_when_nothing_says_when_the_status_began() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![fx.agent(Idle)]);
        assert_eq!(s.status_line(&data(), Some(&w)), "Idle");
    }

    #[test]
    fn never_reads_last_activity_or_latest_at_as_the_status_start() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x")
            .latest_at(NOW - 600.0)
            .agents(vec![fx.agent(Working).activity(NOW - 5.0)]);
        assert_eq!(s.status_line(&data(), Some(&w)), "Working");
    }

    #[test]
    fn gives_no_time_for_a_workspace_with_no_agent() {
        let mut s = fresh();
        let w = ws("x").latest_at(NOW - 600.0);
        assert_eq!(s.status_line(&data(), Some(&w)), "No agent");
        assert_eq!(s.status_line(&data(), None), "No agent");
    }
}

mod open_pr_label {
    use super::*;

    #[test]
    fn names_the_pr_it_opens() {
        let pr = PrRef {
            tag: "#130",
            url: Some("https://x/130"),
        };
        assert_eq!(open_pr_label(Some(pr)), "Open PR #130");
    }

    #[test]
    fn says_when_the_pr_has_no_link_rather_than_that_there_is_no_pr() {
        let pr = PrRef {
            tag: "#130",
            url: None,
        };
        assert_eq!(open_pr_label(Some(pr)), "PR #130 has no link");
    }

    #[test]
    fn says_when_there_is_no_pr() {
        assert_eq!(open_pr_label(None), "No PR to open");
    }
}

mod status_has_age {
    use super::*;

    #[test]
    fn is_true_when_the_status_line_carries_a_time_so_the_full_card_drops_its_top_right_one() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![fx.agent(Working).since(NOW - 30.0)]);
        assert!(s.status_has_age(&data(), Some(&w)));
    }

    #[test]
    fn is_false_when_the_status_line_has_no_time_so_the_top_right_age_stays() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        assert!(!s.status_has_age(&data(), Some(&ws("x").agents(vec![fx.agent(Idle)]))));
        assert!(!s.status_has_age(&data(), Some(&ws("x").latest_at(NOW - 600.0))));
        assert!(!s.status_has_age(&data(), None));
    }
}

mod card_detail {
    use super::*;

    #[test]
    fn shows_the_agents_latest_message() {
        let mut s = fresh();
        let w = ws("x").message("Running the recovery tests").prompt("go");
        assert_eq!(s.card_detail(Some(&w)), "Running the recovery tests");
    }

    #[test]
    fn hides_a_message_that_only_echoes_the_prompt_and_never_shows_the_prompt() {
        let mut s = fresh();
        let echo = ws("x").message("go on then").prompt("go on then");
        assert_eq!(s.card_detail(Some(&echo)), "");
        assert_eq!(s.card_detail(Some(&ws("x").prompt("go on then"))), "");
    }

    #[test]
    fn falls_back_on_the_workspace_description() {
        let mut s = fresh();
        let w = ws("x").description("Fixing the lanes");
        assert_eq!(s.card_detail(Some(&w)), "Fixing the lanes");
    }

    #[test]
    fn cuts_a_long_message_to_two_lines_worth() {
        let mut s = fresh();
        let long = "word ".repeat(80);
        let out = s.card_detail(Some(&ws("x").message(&long)));
        assert_eq!(out.chars().count(), DETAIL_MAX);
        assert!(out.ends_with('…'));
    }
}

mod helpers {
    use super::*;

    #[test]
    fn counts_running_cmux_children_across_the_workspaces_agents() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![
            fx.agent(Working).children(vec![
                run("a", Some(true), None),
                run("b", Some(false), Some(5.0)),
                run("c", None, None),
            ]),
            fx.agent(Working).children(vec![run("d", Some(true), None)]),
        ]);
        assert_eq!(s.live_run_count(Some(&w)), 3);
        assert_eq!(s.helper_text(Some(&w)), "· 3 helpers");
    }

    #[test]
    fn says_one_helper_in_the_singular() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![fx.agent(Working).children(vec![run(
            "a",
            Some(true),
            None,
        )])]);
        assert_eq!(s.helper_text(Some(&w)), "· 1 helper");
    }

    #[test]
    fn counts_nothing_under_an_ended_session_whatever_the_run_says() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![fx.agent(Ended).children(vec![run(
            "a",
            Some(true),
            None,
        )])]);
        assert_eq!(s.live_run_count(Some(&w)), 0);
        assert_eq!(s.helper_text(Some(&w)), "");
    }

    #[test]
    fn is_empty_with_no_workspace_or_no_runs() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        assert_eq!(s.live_run_count(None), 0);
        assert_eq!(
            s.helper_text(Some(&ws("x").agents(vec![fx.agent(Working)]))),
            ""
        );
    }

    #[test]
    fn skips_holes_in_a_children_array() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let w = ws("x").agents(vec![
            fx.agent(Working)
                .children(vec![None, run("a", Some(true), None)]),
        ]);
        assert_eq!(s.live_run_count(Some(&w)), 1);
    }
}

mod progress_fraction {
    use super::*;

    fn at(value: Option<f64>) -> Option<Progress> {
        Some(Progress { value, label: None })
    }

    #[test]
    fn is_the_progress_value_held_between_0_and_1() {
        assert_eq!(
            progress_fraction(Some(&ws("x").progress(at(Some(0.62))))),
            Some(0.62)
        );
        assert_eq!(
            progress_fraction(Some(&ws("x").progress(at(Some(1.4))))),
            Some(1.0)
        );
        assert_eq!(
            progress_fraction(Some(&ws("x").progress(at(Some(-1.0))))),
            Some(0.0)
        );
    }

    #[test]
    fn is_null_when_no_value_is_sent() {
        assert_eq!(progress_fraction(Some(&ws("x"))), None);
        assert_eq!(progress_fraction(Some(&ws("x").progress(None))), None);
        let label_only = Some(Progress {
            value: None,
            label: Some("Building".into()),
        });
        assert_eq!(progress_fraction(Some(&ws("x").progress(label_only))), None);
        assert_eq!(
            progress_fraction(Some(&ws("x").progress(at(Some(f64::NAN))))),
            None
        );
        assert_eq!(progress_fraction(None), None);
    }
}

mod outline {
    use super::*;

    #[test]
    fn rings_the_selected_workspace_in_ink_at_the_widest_a_drag_in_ink_just_under_it() {
        let select = |width| Outline {
            color: Token::Select,
            width,
        };
        assert_eq!(outline(true, false, Token::CardEdge), select(OUTLINE_MAX));
        assert_eq!(outline(true, true, Token::CardEdge), select(1.5));
        assert_eq!(outline(false, true, Token::Clear), select(1.5));
    }

    #[test]
    fn keeps_the_rows_own_resting_edge_at_1pt_on_the_rest() {
        let rest = |color| Outline { color, width: 1.0 };
        assert_eq!(
            outline(false, false, Token::CardEdge),
            rest(Token::CardEdge)
        );
        assert_eq!(outline(false, false, Token::Clear), rest(Token::Clear));
    }

    #[test]
    fn never_draws_wider_than_outline_max_which_rings_hold_steady() {
        for selected in [true, false] {
            for dragged in [true, false] {
                assert!(outline(selected, dragged, Token::Clear).width <= OUTLINE_MAX);
            }
        }
    }
}

mod chips_for {
    use super::*;

    /// Each chip's id and words, and the branch's dirty flag.
    fn shape(chips: &[Chip]) -> Vec<(&'static str, String, bool)> {
        chips
            .iter()
            .map(|c| match c {
                Chip::Pr { tag, .. } => (chip_id(c), tag.clone(), false),
                Chip::Branch { text, dirty } => (chip_id(c), text.clone(), *dirty),
                Chip::Size { text, .. } | Chip::Port { text, .. } => {
                    (chip_id(c), text.clone(), false)
                }
            })
            .collect()
    }

    #[test]
    fn shows_the_pr_then_the_branch_with_its_dirty_flag() {
        let mut s = fresh();
        let seven = PullRequest {
            url: Some("https://x/7".into()),
            ..pr(7.0, Some(PrStatus::Open))
        };
        let chips = s.chips_for(Some(&ws("x").pr(seven).branch("feat").dirty()), true);
        assert_eq!(
            shape(&chips),
            [
                ("pr", "#7".to_string(), false),
                ("br", "feat".to_string(), true)
            ]
        );
        // The number and the state words ride apart, so the chip inks each its own way.
        let Some(Chip::Pr {
            tag,
            state,
            url,
            diff,
            ..
        }) = chips.first()
        else {
            panic!("no PR chip: {chips:?}");
        };
        assert_eq!((tag.as_str(), state.as_str()), ("#7", "open"));
        assert_eq!(url.as_deref(), Some("https://x/7"));
        assert_eq!(diff, "");
        let draft = PullRequest {
            draft: Some(true),
            ..pr(8.0, Some(PrStatus::Open))
        };
        let chips = s.chips_for(Some(&ws("d").pr(draft)), false);
        assert!(
            matches!(chips.first(), Some(Chip::Pr { tag, state, .. }) if tag == "#8" && state == "draft")
        );
        let sized = PullRequest {
            additions: Some(40.0),
            deletions: Some(2.0),
            ..pr(9.0, Some(PrStatus::Open))
        };
        let chips = s.chips_for(Some(&ws("s").pr(sized)), false);
        assert!(matches!(chips.first(), Some(Chip::Pr { diff, .. }) if diff == "+40 \u{2212}2"));
        assert!(s.chips_for(Some(&ws("y").branch("feat")), false).is_empty());
        let chips = s.chips_for(Some(&ws("y").branch("feat")), true);
        assert!(matches!(
            chips.first(),
            Some(Chip::Branch { dirty: false, .. })
        ));
    }

    #[test]
    fn adds_a_ports_chip_that_opens_the_first_port_on_localhost() {
        let mut s = fresh();
        let chips = s.chips_for(Some(&ws("x").ports(&[5173.0])), true);
        assert_eq!(
            chips,
            [Chip::Port {
                text: ":5173 \u{2197}".into(),
                url: "http://localhost:5173".into()
            }]
        );
    }

    #[test]
    fn shows_the_first_port_and_how_many_more() {
        let mut s = fresh();
        let w = ws("x").ports(&[5173.0, 3000.0, 5173.0, 8080.0]);
        let chips = s.chips_for(Some(&w), true);
        assert!(matches!(chips.first(), Some(Chip::Port { text, url })
            if text == ":5173 +2 \u{2197}" && url == "http://localhost:5173"));
    }

    #[test]
    fn skips_ports_that_are_not_real_port_numbers() {
        let mut s = fresh();
        assert!(
            s.chips_for(Some(&ws("x").ports(&[0.0, 70000.0, 1.5])), true)
                .is_empty()
        );
        assert!(s.chips_for(Some(&ws("x").ports(&[])), true).is_empty());
        assert!(s.chips_for(None, true).is_empty());
    }

    #[test]
    fn orders_the_chips_pr_branch_ports() {
        let mut s = fresh();
        let w = ws("x").pr(pr(7.0, None)).branch("main").ports(&[5173.0]);
        let ids: Vec<&str> = shape(&s.chips_for(Some(&w), true))
            .into_iter()
            .map(|(id, ..)| id)
            .collect();
        assert_eq!(ids, ["pr", "br", "port"]);
    }
}

/// A chip's id, as the TypeScript names it.
fn chip_id(c: &Chip) -> &'static str {
    match c {
        Chip::Size { .. } => "size",
        Chip::Pr { .. } => "pr",
        Chip::Branch { .. } => "br",
        Chip::Port { .. } => "port",
    }
}

/// Each chip's id, in order.
fn ids(chips: &[Chip]) -> Vec<&'static str> {
    chips.iter().map(chip_id).collect()
}

fn sized(number: f64, draft: bool, additions: f64, deletions: f64) -> PullRequest {
    PullRequest {
        draft: Some(draft),
        additions: Some(additions),
        deletions: Some(deletions),
        ..pr(number, Some(PrStatus::Open))
    }
}

/// chipsFor with the branch, fitted to a project card's line.
fn fits(s: &mut Session, w: &Workspace) -> bool {
    let chips = s.chips_for(Some(w), true);
    chips_fit_one_line(&chips, PROJECT_LINE_CHARS)
}

mod a_merged_cards_chips {
    use super::*;

    fn merged() -> PullRequest {
        pr(7.0, Some(PrStatus::Merged))
    }

    #[test]
    fn shows_its_branch_as_any_card_does() {
        let mut s = fresh();
        let w = ws("x").pr(merged()).branch("feat");
        assert_eq!(ids(&s.chips_for(Some(&w), true)), ["pr", "br"]);
        let dirty = ws("x").pr(merged()).branch("feat").dirty();
        assert_eq!(ids(&s.chips_for(Some(&dirty), true)), ["pr", "br"]);
    }
}

mod chips_fit_one_line {
    use super::*;

    #[test]
    fn fits_a_merged_full_cards_pr_and_branch_but_not_with_ports_too() {
        let mut s = fresh();
        let merged = pr(1234.0, Some(PrStatus::Merged));
        let mut full = |w: &Workspace| {
            let chips = s.chips_for(Some(w), true);
            chips_fit_one_line(&chips, FULL_LINE_CHARS)
        };
        assert!(full(&ws("x").pr(merged.clone()).branch("feat")));
        assert!(
            !full(&ws("x").pr(merged).branch("feat").ports(&[5173.0])),
            "so the full card splits"
        );
    }

    #[test]
    fn keeps_a_short_pr_and_branch_on_one_line() {
        let mut s = fresh();
        let w = ws("x").branch("main").pr(pr(12.0, Some(PrStatus::Open)));
        assert!(fits(&mut s, &w));
    }

    #[test]
    fn splits_a_draft_pr_with_its_diff_size_and_a_long_branch() {
        let mut s = fresh();
        let w = ws("x")
            .branch("parser-streaming-tokeniser")
            .pr(sized(148.0, true, 342.0, 17.0));
        assert!(!fits(&mut s, &w));
    }

    #[test]
    fn counts_the_diff_size_towards_the_line() {
        let mut s = fresh();
        let branch = "draft-pages-b";
        let bare = ws("x").branch(branch).pr(pr(148.0, Some(PrStatus::Open)));
        assert!(fits(&mut s, &bare));
        let w = ws("x").branch(branch).pr(sized(148.0, false, 342.0, 17.0));
        assert!(!fits(&mut s, &w));
    }

    #[test]
    fn fits_a_card_with_nothing_in_its_chips_row() {
        let mut s = fresh();
        assert!(fits(&mut s, &ws("x")));
    }

    #[test]
    fn counts_the_uncommitted_changes_dot_on_the_branch() {
        let mut s = fresh();
        let open = || pr(148.0, Some(PrStatus::Open));
        assert!(fits(
            &mut s,
            &ws("x").branch("fix-card-layout-a").pr(open())
        ));
        let dirty = ws("x").branch("fix-card-layout-a").dirty().pr(open());
        assert!(!fits(&mut s, &dirty));
    }
}

mod chips_split {
    use super::*;

    fn splits(s: &mut Session, w: &Workspace) -> bool {
        let chips = s.chips_for(Some(w), true);
        chips_split(&chips, PROJECT_LINE_CHARS)
    }

    fn long() -> PullRequest {
        sized(148.0, true, 342.0, 17.0)
    }

    #[test]
    fn splits_a_pr_and_branch_that_do_not_fit_on_one_line() {
        let mut s = fresh();
        let w = ws("x").branch("parser-streaming-tokeniser").pr(long());
        assert!(splits(&mut s, &w));
    }

    #[test]
    fn keeps_a_pair_that_fits_on_one_line() {
        let mut s = fresh();
        let w = ws("x").branch("main").pr(pr(12.0, Some(PrStatus::Open)));
        assert!(!splits(&mut s, &w));
    }

    #[test]
    fn never_splits_with_nothing_for_the_second_line() {
        let mut s = fresh();
        assert!(!splits(&mut s, &ws("x").pr(long())));
    }

    #[test]
    fn never_splits_with_no_pr_for_the_first_line() {
        let mut s = fresh();
        let w = ws("x").branch("a-very-long-branch-name-that-cannot-fit-on-one-line");
        assert!(!splits(&mut s, &w));
    }

    #[test]
    fn splits_sooner_on_the_full_cards_narrower_line() {
        let mut s = fresh();
        let w = ws("x")
            .branch("fix-card-layout")
            .pr(pr(148.0, Some(PrStatus::Open)));
        assert!(!splits(&mut s, &w), "fits a project card");
        let mut full = |w: &Workspace| {
            let chips = s.chips_for(Some(w), true);
            chips_split(&chips, FULL_LINE_CHARS)
        };
        assert!(full(&w), "too wide for a full card");
        let short = ws("x").branch("main").pr(pr(12.0, Some(PrStatus::Open)));
        assert!(!full(&short));
    }
}
