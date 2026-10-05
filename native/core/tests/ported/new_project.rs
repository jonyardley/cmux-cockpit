//! test/new-project.test.ts: the home folder, the next colour, where
//! "+ New project" and its editor sit, the folders on offer, the card
//! chip's words and a project's "+". Every case that drives the editor's
//! draft (edit.ts: openNewProject, setDraftFolder, draftProblem,
//! saveDraft, addSuggested) is left out: the editor is not ported, and
//! the pane has none.

use cockpit_core::by_project::NEW_PROJECT;
use cockpit_core::data::Data;
use cockpit_core::home::{expand_home, is_home, tilde_home};
use cockpit_core::persist::{ProjectSpec, ViewMode};
use cockpit_core::projects::{PROJECT_COLORS, Project, next_color};
use cockpit_core::session::Session;

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

    /// Partly ported: openNewProject is edit.ts's; here the editor is set open.
    #[test]
    fn sits_after_the_busy_projects_and_before_the_quiet_ones_its_editor_under_it() {
        let (mut s, data) = setup(vec![ws("a").directory("/Users/jon/dev/app-one")]);
        s.set_editing_project(Some(NEW_PROJECT));
        let ids: Vec<String> = s
            .project_entries(&data)
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        let at = ids.iter().position(|id| id == "new").unwrap();
        assert_eq!(ids[at..at + 3], ["new", "e:+new", "quiet"]);
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
