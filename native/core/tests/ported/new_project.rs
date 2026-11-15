//! test/new-project.test.ts: the home folder, the next colour, where
//! "+ New project" and its editor sit, the folders on offer, the card
//! chip's words and a project's "+", with the editor's draft driven
//! through edit.rs. "Reads its words live" keeps only its label half: that
//! the chip's Text takes a closure is the sidebar view's.

use cockpit_core::data::Data;
use cockpit_core::home::{expand_home, is_home, tilde_home};
use cockpit_core::persist::{ProjectSpec, ViewMode};
use cockpit_core::projects::{PROJECT_COLORS, Project, next_color};
use cockpit_core::session::Session;
use serde_json::json;

use crate::support::*;

const NOW: f64 = 1_000_100.0;
/// As build.ts bakes it in, trailing "/" and all.
const HOME: &str = "/Users/jon/";

fn setup(workspaces: Vec<cockpit_core::data::Workspace>) -> (Session, Data) {
    let mut s = fresh();
    s.home = Some(HOME.into());
    s.set_mode(ViewMode::Projects);
    (s, frame(NOW, vec![], workspaces))
}

const HOME_PROBLEM: &str = "That is your home folder: pick one inside it, such as ~/dev/app.";

fn problem(s: &Session) -> Option<String> {
    s.draft_problem()
}

/// The folders new workspaces opened in.
fn creates(s: &Session) -> Vec<String> {
    calls(s)
        .into_iter()
        .filter(|(m, _)| m == "workspace.create")
        .filter_map(|(_, p)| p.into_iter().find(|(k, _)| k == "cwd").map(|(_, v)| v))
        .collect()
}

/// A project sent from the sidebar and not yet built, as a save leaves it.
fn send_project(s: &mut Session, name: &str, root: &str) -> String {
    let dir = expand_home(root, s.home.as_deref()).unwrap_or_else(|| root.to_string());
    let k = format!("{}/", dir.to_lowercase());
    let spec = ProjectSpec {
        name: name.into(),
        color: PROJECT_COLORS[0].into(),
        icon: "star.fill".into(),
        root: Some(root.into()),
    };
    s.save_project(&k, spec);
    s.take_outbox();
    k
}

mod the_home_folder {
    use super::*;

    const H: Option<&str> = Some(HOME);

    #[test]
    fn expands_a_leading_tilde_and_leaves_other_paths_alone() {
        assert_eq!(
            expand_home(" ~/dev/app ", H).as_deref(),
            Some("/Users/jon/dev/app")
        );
        assert_eq!(expand_home("~", H).as_deref(), Some("/Users/jon"));
        assert_eq!(expand_home("/opt/x", H).as_deref(), Some("/opt/x"));
        assert_eq!(expand_home("~other/x", H).as_deref(), Some("~other/x"));
    }

    #[test]
    fn has_no_answer_for_tilde_when_no_home_is_known() {
        assert_eq!(expand_home("~/dev/app", Some("")), None);
        assert_eq!(expand_home("~/dev/app", None), None);
        assert_eq!(
            expand_home("/dev/app", Some("")).as_deref(),
            Some("/dev/app")
        );
    }

    #[test]
    fn shows_a_path_under_home_with_tilde() {
        assert_eq!(tilde_home("/Users/jon/dev/app", H), "~/dev/app");
        assert_eq!(tilde_home("/Users/jon", H), "~");
        assert_eq!(tilde_home("/Users/jonny/dev", H), "/Users/jonny/dev");
        assert_eq!(tilde_home("/Users/jon/dev", Some("")), "/Users/jon/dev");
    }

    #[test]
    fn knows_the_home_folder_in_any_case_with_or_without_a_trailing_slash() {
        assert!(is_home(Some("/users/JON/"), H));
        assert!(is_home(Some("/Users/jon"), H));
        assert!(!is_home(Some("/Users/jonny"), H));
        assert!(!is_home(Some("/Users/jon"), Some("")));
    }
}

mod the_next_colour {
    use super::*;

    #[test]
    fn is_the_first_one_no_project_uses_and_goes_round_once_all_are_taken() {
        let p = |color: &str| Project {
            name: color.to_string(),
            color: color.to_string(),
            ..cockpit_core::projects::other()
        };
        assert_eq!(next_color(&[]), PROJECT_COLORS[0]);
        assert_eq!(
            next_color(&[p(&PROJECT_COLORS[0].to_lowercase())]),
            PROJECT_COLORS[1]
        );
        let all: Vec<Project> = PROJECT_COLORS.iter().map(|c| p(c)).collect();
        assert_eq!(
            next_color(&all),
            PROJECT_COLORS[all.len() % PROJECT_COLORS.len()]
        );
    }
}

mod plus_new_project {
    use super::*;

    #[test]
    fn sits_after_the_busy_projects_and_before_the_quiet_ones_its_editor_under_it() {
        let (mut s, data) = setup(vec![ws("a").directory("/Users/jon/dev/app-one")]);
        s.open_new_project();
        let ids: Vec<String> = s
            .project_entries(&data)
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        let at = ids.iter().position(|id| id == "new").unwrap();
        assert_eq!(ids[at..at + 3], ["new", "e:+new", "quiet"]);
    }

    #[test]
    fn opens_blank_in_the_next_free_colour_and_a_second_tap_closes_it() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        assert!(s.is_new_draft());
        assert_eq!(s.draft_spec().name, "");
        assert_eq!(s.draft_spec().color, next_color(&s.known_projects()));
        s.open_new_project();
        assert_eq!(s.editing_project(), None);
    }

    #[test]
    fn names_the_project_after_the_folder_as_it_is_typed() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        s.set_draft_folder("~/dev/pianola-roll");
        assert_eq!(s.draft_spec().name, "Pianola-roll");
        s.set_draft_folder("~");
        assert_eq!(s.draft_spec().name, "");
    }

    #[test]
    fn says_what_is_wrong_with_the_folder_in_words() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        assert_eq!(problem(&s).as_deref(), Some("Type the project's folder."));
        s.set_draft_folder("~");
        assert_eq!(problem(&s).as_deref(), Some(HOME_PROBLEM));
        s.set_draft_folder("/opt");
        assert_eq!(
            problem(&s).as_deref(),
            Some("Pick a folder at least two levels deep, such as ~/dev/app.")
        );
        s.set_draft_folder("/opt/tools");
        assert_eq!(problem(&s).as_deref(), None);
        s.set_draft_folder("~/dev/app-one/web");
        assert_eq!(
            problem(&s).as_deref(),
            Some("That folder is already in App One.")
        );
    }

    #[test]
    fn wants_a_full_path_not_a_relative_one_or_another_users_tilde() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        for typed in ["dev/app", "~bob/app"] {
            s.set_draft_folder(typed);
            assert_eq!(
                problem(&s).as_deref(),
                Some("Type the folder's full path, starting with / or ~/."),
                "{typed}"
            );
        }
    }

    #[test]
    fn calls_the_home_folder_home_in_any_case() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        s.set_draft_folder("/USERS/jon/");
        assert_eq!(problem(&s).as_deref(), Some(HOME_PROBLEM));
    }

    #[test]
    fn says_when_a_folder_is_too_long_once_its_tilde_is_expanded() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        s.set_draft_folder(&format!("~/{}", "x".repeat(505)));
        assert_eq!(
            problem(&s).as_deref(),
            Some("Keep the folder's path under 512 characters.")
        );
        assert_eq!(s.draft_spec().name, "");
    }

    #[test]
    fn counts_a_project_sent_but_not_yet_built() {
        let (mut s, _) = setup(vec![]);
        send_project(&mut s, "Sent Only", "/Users/jon/dev/sent-only");
        s.open_new_project();
        s.set_draft_folder("~/dev/sent-only/src");
        assert_eq!(
            problem(&s).as_deref(),
            Some("That folder is already in Sent Only.")
        );
    }

    #[test]
    fn refuses_a_folder_that_holds_other_projects() {
        let (mut s, _) = setup(vec![]);
        s.open_new_project();
        s.set_draft_folder("~/dev");
        assert_eq!(
            problem(&s).as_deref(),
            Some("~/dev holds other projects, such as App One: pick a folder inside it.")
        );
    }

    #[test]
    fn takes_a_removed_projects_folder_again() {
        let (mut s, _) = setup(vec![]);
        let k = send_project(&mut s, "Gone Soon", "/Users/jon/dev/gone-soon");
        s.remove_project(&k);
        s.open_new_project();
        s.set_draft_folder("~/dev/gone-soon");
        assert_eq!(problem(&s).as_deref(), None);
        assert_eq!(s.draft_spec().name, "Gone-soon");
    }

    #[test]
    fn saves_under_the_expanded_folder_and_opens_a_workspace_there() {
        let (mut s, data) = setup(vec![]);
        let color = next_color(&s.known_projects()).to_string();
        s.open_new_project();
        s.set_draft_folder("~/dev/fresh-1");
        s.set_draft_icon("music.note");
        s.save_draft(&data);
        let dir = "/Users/jon/dev/fresh-1";
        assert_eq!(
            sent(&s),
            [(
                format!("projects.{}/", dir.to_lowercase()),
                Some(
                    json!({ "name": "Fresh-1", "color": color, "icon": "music.note", "root": dir })
                )
            )]
        );
        assert_eq!(creates(&s), [dir]);
        assert_eq!(s.editing_project(), None);
    }

    #[test]
    fn opens_no_second_workspace_in_a_folder_that_has_one() {
        let (mut s, data) = setup(vec![ws("s").directory("/Users/jon/dev/sketch/")]);
        s.open_new_project();
        s.set_draft_folder("~/dev/sketch");
        s.save_draft(&data);
        assert_eq!(sent(&s).len(), 1);
        assert!(creates(&s).is_empty());
    }

    #[test]
    fn saves_nothing_while_the_folder_has_a_problem() {
        let (mut s, data) = setup(vec![]);
        s.open_new_project();
        s.set_draft_folder("~");
        s.save_draft(&data);
        assert!(sent(&s).is_empty());
        assert!(s.is_new_draft());
    }
}

mod the_folders_on_offer {
    use super::*;

    #[test]
    fn lists_each_open_folder_with_no_project_once_not_ones_that_have_one() {
        let (mut s, data) = setup(vec![
            ws("x").directory("/Users/jon/dev/offer-one"),
            ws("y").directory("/Users/jon/dev/offer-one/"),
            ws("z").directory("/Users/jon/dev/app-one"),
        ]);
        assert_eq!(s.folder_suggestions(&data), ["/Users/jon/dev/offer-one"]);
    }

    #[test]
    fn makes_one_a_project_in_a_tap_and_it_leaves_the_list() {
        let (mut s, data) = setup(vec![ws("x").directory("/Users/jon/dev/offer-two")]);
        s.open_new_project();
        s.add_suggested("/Users/jon/dev/offer-two");
        assert_eq!(
            sent(&s).first().map(|(k, _)| k.as_str()),
            Some("projects./users/jon/dev/offer-two/")
        );
        assert!(creates(&s).is_empty());
        assert!(s.folder_suggestions(&data).is_empty());
        assert_eq!(s.editing_project(), None);
    }

    #[test]
    fn ignores_a_folder_that_is_already_a_project_or_the_home_folder() {
        let (mut s, _) = setup(vec![]);
        send_project(&mut s, "Owned", "/Users/jon/dev/owned");
        for dir in [
            "/Users/jon",
            "/Users/jon/dev/owned",
            "/Users/jon/dev/app-one",
            "/x",
        ] {
            s.add_suggested(dir);
        }
        assert!(sent(&s).is_empty());
    }

    #[test]
    fn never_offers_the_home_folder_itself() {
        let (mut s, data) = setup(vec![ws("h").directory("/Users/jon")]);
        assert!(s.folder_suggestions(&data).is_empty());
        assert!(!s.can_create_project(Some(by_id(&data, "h"))));
    }
}

mod the_card_chip {
    use super::*;

    #[test]
    fn names_the_project_it_would_make() {
        let (s, _) = setup(vec![]);
        let w = ws("c").directory("/Users/jon/dev/chip-card");
        assert_eq!(
            s.make_project_label(Some(&w)),
            "Make \"Chip-card\" a project"
        );
        assert_eq!(s.make_project_label(None), "Make a project");
    }

    /// Partly ported: that the chip's Text takes a closure is the view's;
    /// here the label is read again after the first folder is made.
    #[test]
    fn reads_its_words_live_so_a_second_folder_of_the_same_name_says_foo_2() {
        let one = ws("f1").directory("/Users/jon/dev/foo");
        let two = ws("f2").directory("/Users/jon/work/foo");
        let (mut s, _) = setup(vec![one.clone(), two.clone()]);
        assert_eq!(s.make_project_label(Some(&two)), "Make \"Foo\" a project");
        s.create_project_from(Some(&one));
        assert_eq!(s.make_project_label(Some(&two)), "Make \"Foo 2\" a project");
    }
}

mod a_projects_plus {
    use super::*;

    #[test]
    fn opens_a_just_sent_tilde_folder_expanded_before_the_rebuild() {
        let (mut s, data) = setup(vec![]);
        let k = send_project(&mut s, "Rooty", "~/dev/rooty");
        s.open_project_workspace(&data, &k, None);
        let cwds: Vec<String> = calls(&s)
            .into_iter()
            .filter(|(m, _)| m == "workspace.create")
            .filter_map(|(_, p)| p.into_iter().find(|(k, _)| k == "cwd").map(|(_, v)| v))
            .collect();
        assert_eq!(cwds, ["/Users/jon/dev/rooty"]);
    }
}
