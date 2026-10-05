//! test/card.test.ts: the status line with its time and helper count, the
//! agent's message, the progress fraction, the outline, chipsFor, and
//! chips.ts: showsChipsRow, cardChips, chipsFitOneLine, chipsSplit and
//! secondLineFits.

use cockpit_core::card_chips::Chip;
use cockpit_core::chips::{FULL_LINE_CHARS, PROJECT_LINE_CHARS};
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
                Chip::Size { text, .. } => ("size", text.clone(), false),
                Chip::Pr { tag, .. } => ("pr", tag.clone(), false),
                Chip::Branch { text, dirty } => ("br", text.clone(), *dirty),
                Chip::Port { text, .. } => ("port", text.clone(), false),
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

/// Each chip's id, in order.
fn ids(chips: &[Chip]) -> Vec<&'static str> {
    chips
        .iter()
        .map(|c| match c {
            Chip::Size { .. } => "size",
            Chip::Pr { .. } => "pr",
            Chip::Branch { .. } => "br",
            Chip::Port { .. } => "port",
        })
        .collect()
}

fn pinned(w: Workspace) -> Workspace {
    Workspace {
        pinned: Some(true),
        ..w
    }
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
fn fits(s: &mut Session, data: &Data, w: &Workspace) -> bool {
    let chips = s.chips_for(Some(w), true);
    s.chips_fit_one_line(data, &chips, Some(w), PROJECT_LINE_CHARS)
}

/// cardChips with the branch, as a full card draws them.
fn full_chips(s: &mut Session, data: &Data, w: &Workspace) -> Vec<Chip> {
    s.card_chips(data, Some(w), true)
}

mod shows_chips_row {
    use super::*;

    fn shows(s: &mut Session, w: Option<&Workspace>, with_branch: bool) -> bool {
        let chips = s.chips_for(w, with_branch);
        s.shows_chips_row(&data(), &chips, w)
    }

    #[test]
    fn has_no_row_with_no_chips() {
        let mut s = fresh();
        assert!(!shows(&mut s, Some(&ws("x")), true));
        assert!(!shows(&mut s, None, true));
    }

    #[test]
    fn keeps_the_row_for_a_pr_alone_which_sits_in_it_on_every_card() {
        let mut s = fresh();
        let w = ws("x").pr(pr(7.0, Some(PrStatus::Open)));
        assert!(shows(&mut s, Some(&w), true));
    }

    #[test]
    fn keeps_the_row_for_a_branch_or_ports_chip() {
        let mut s = fresh();
        assert!(shows(&mut s, Some(&ws("x").branch("feat")), true));
        assert!(shows(&mut s, Some(&ws("x").ports(&[5173.0])), true));
    }

    #[test]
    fn leaves_the_branch_out_when_the_card_does() {
        let mut s = fresh();
        assert!(!shows(&mut s, Some(&ws("x").branch("feat")), false));
    }

    #[test]
    fn agrees_with_has_chips_row_when_the_pr_chip_is_in_the_row() {
        let mut s = fresh();
        let all = [
            ws("a"),
            ws("b").pr(pr(7.0, None)),
            ws("c").branch("feat"),
            ws("d").ports(&[80.0]),
        ];
        for w in &all {
            let has = s.has_chips_row(&data(), Some(w), true);
            assert_eq!(shows(&mut s, Some(w), true), has, "{}", w.id);
        }
    }
}

mod card_chips {
    use super::*;

    fn merged() -> PullRequest {
        pr(7.0, Some(PrStatus::Merged))
    }

    #[test]
    fn leaves_a_merged_cards_clean_branch_out_while_park_or_close_takes_its_room() {
        let mut s = fresh();
        let w = ws("x").pr(merged()).branch("feat");
        assert_eq!(ids(&full_chips(&mut s, &data(), &w)), ["pr"]);
        let open = ws("x").pr(pr(7.0, Some(PrStatus::Open))).branch("feat");
        assert_eq!(ids(&full_chips(&mut s, &data(), &open)), ["pr", "br"]);
    }

    #[test]
    fn keeps_a_branch_with_uncommitted_changes_its_dot_is_the_only_sign_of_work_left() {
        let mut s = fresh();
        let w = ws("x").pr(merged()).branch("feat").dirty();
        assert_eq!(ids(&full_chips(&mut s, &data(), &w)), ["pr", "br"]);
    }

    #[test]
    fn keeps_the_branch_when_no_merged_button_shows() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let data = frame(
            NOW,
            vec![group("g-parked", "Parked").anchor("anchor-parked")],
            vec![],
        );
        let busy = ws("x")
            .pr(merged())
            .branch("feat")
            .group("g-parked")
            .agents(vec![fx.agent(Working)]);
        assert_eq!(
            ids(&full_chips(&mut s, &data, &busy)),
            ["pr", "br"],
            "in Parked with an agent working: no Park, no Close"
        );
    }
}

mod chips_fit_one_line {
    use super::*;

    #[test]
    fn counts_a_merged_cards_park_and_close_towards_the_line() {
        let mut s = fresh();
        let d = data();
        let merged = pr(174.0, Some(PrStatus::Merged));
        let closed = pr(174.0, Some(PrStatus::Closed));
        let ports = [5173.0, 3000.0];
        assert!(
            fits(&mut s, &d, &ws("x").pr(merged.clone())),
            "#174 merged, Park and Close fit"
        );
        assert!(
            fits(&mut s, &d, &ws("x").pr(closed).ports(&ports)),
            "a closed PR has no buttons"
        );
        assert!(
            !fits(&mut s, &d, &ws("x").pr(merged.clone()).ports(&ports)),
            "Park and Close push it over"
        );
        assert!(
            fits(&mut s, &d, &pinned(ws("x").pr(merged).ports(&ports))),
            "a pinned card offers Park alone"
        );
    }

    #[test]
    fn fits_a_merged_full_cards_park_and_close_beside_its_pr_but_not_beside_ports_too() {
        let mut s = fresh();
        let d = data();
        let merged = pr(1234.0, Some(PrStatus::Merged));
        let mut full = |w: &Workspace| {
            let chips = full_chips(&mut s, &d, w);
            s.chips_fit_one_line(&d, &chips, Some(w), FULL_LINE_CHARS)
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
        assert!(fits(&mut s, &data(), &w));
    }

    #[test]
    fn splits_a_draft_pr_with_its_diff_size_and_a_long_branch() {
        let mut s = fresh();
        let w = ws("x")
            .branch("parser-streaming-tokeniser")
            .pr(sized(148.0, true, 342.0, 17.0));
        assert!(!fits(&mut s, &data(), &w));
    }

    #[test]
    fn counts_the_diff_size_towards_the_line() {
        let mut s = fresh();
        let d = data();
        let branch = "draft-pages-b";
        let bare = ws("x").branch(branch).pr(pr(148.0, Some(PrStatus::Open)));
        assert!(fits(&mut s, &d, &bare));
        let w = ws("x").branch(branch).pr(sized(148.0, false, 342.0, 17.0));
        assert!(!fits(&mut s, &d, &w));
    }

    #[test]
    fn counts_the_to_review_button_towards_the_line() {
        let (mut fx, mut s) = (Fx::default(), fresh());
        let open = || pr(12.0, Some(PrStatus::Open));
        let w = ws("x").branch("fix-card-layout").pr(open());
        assert!(fits(&mut s, &data(), &w));
        let idle = fx.agent(Idle).since(NOW - 600.0).activity(NOW - 600.0);
        let ready = ws("y")
            .branch("fix-card-layout")
            .pr(open())
            .unread(1.0)
            .agents(vec![idle]);
        let d = frame(NOW, vec![], vec![ready.clone()]);
        assert!(s.can_file_for_review(&d, Some(&ready)));
        assert!(!fits(&mut s, &d, &ready));
    }

    #[test]
    fn fits_a_card_with_nothing_in_its_chips_row() {
        let mut s = fresh();
        assert!(fits(&mut s, &data(), &ws("x")));
    }

    #[test]
    fn counts_the_uncommitted_changes_dot_on_the_branch() {
        let mut s = fresh();
        let d = data();
        let open = || pr(148.0, Some(PrStatus::Open));
        assert!(fits(
            &mut s,
            &d,
            &ws("x").branch("fix-card-layout-a").pr(open())
        ));
        let dirty = ws("x").branch("fix-card-layout-a").dirty().pr(open());
        assert!(!fits(&mut s, &d, &dirty));
    }
}

mod chips_split {
    use super::*;

    fn splits(s: &mut Session, w: &Workspace) -> bool {
        let chips = s.chips_for(Some(w), true);
        s.chips_split(&data(), &chips, Some(w), PROJECT_LINE_CHARS)
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
        let d = data();
        let w = ws("x")
            .branch("fix-card-layout")
            .pr(pr(148.0, Some(PrStatus::Open)));
        assert!(!splits(&mut s, &w), "fits a project card");
        let mut full = |w: &Workspace| {
            let chips = full_chips(&mut s, &d, w);
            s.chips_split(&d, &chips, Some(w), FULL_LINE_CHARS)
        };
        assert!(full(&w), "too wide for a full card");
        let short = ws("x").branch("main").pr(pr(12.0, Some(PrStatus::Open)));
        assert!(!full(&short));
    }
}

mod second_line_fits {
    use super::*;

    fn second(s: &mut Session, w: &Workspace) -> bool {
        let d = data();
        let chips = full_chips(s, &d, w);
        s.second_line_fits(&d, &chips, Some(w), FULL_LINE_CHARS)
    }

    fn merged() -> PullRequest {
        pr(178.0, Some(PrStatus::Merged))
    }

    #[test]
    fn keeps_a_merged_cards_park_and_close_beside_its_port() {
        let mut s = fresh();
        let w = ws("x").pr(merged()).branch("feat").ports(&[5173.0]);
        assert!(second(&mut s, &w));
    }

    #[test]
    fn drops_them_under_a_long_uncommitted_branch_and_ports() {
        let mut s = fresh();
        let w = ws("x")
            .pr(merged())
            .branch("all-view-card-fit")
            .dirty()
            .ports(&[5173.0]);
        assert!(!second(&mut s, &w));
    }

    #[test]
    fn fits_a_second_line_with_no_park_or_close() {
        let mut s = fresh();
        let w = ws("x").pr(pr(178.0, Some(PrStatus::Open))).branch("feat");
        assert!(second(&mut s, &w));
    }
}
