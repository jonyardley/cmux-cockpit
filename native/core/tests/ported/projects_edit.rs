//! test/projects-edit.test.ts: editing and removing a project through
//! the editor (edit.rs), its icon search, and the project menu's words.
//! What a case asserts of the sidebar's view nodes (which menu items a
//! header builds, the fields' handlers and placeholders, the picker's
//! Images and Rectangles) is the views', so it is left out; the case keeps
//! what the same taps do to the draft and what they save. "The card menu"
//! is left for the card menu's port.

use cockpit_core::data::Data;
use cockpit_core::edit::{
    ICONS_PER_ROW, can_save_project, edit_label, icon_matches, icon_rows, rows_of, search_note,
};
use cockpit_core::persist::{ProjectSpec, SavedState};
use cockpit_core::projects::{PROJECT_COLORS, PROJECT_ICONS, Project};
use cockpit_core::session::Session;
use serde_json::{Value, json};

use crate::support::*;

const NOW: f64 = 1_000_100.0;
const APP_ONE: &str = "/dev/app-one";
const APP_TWO: &str = "/dev/app-two";
const APP_THREE: &str = "/dev/app-three";
/// A project made in the sidebar, saved and built.
const KEY: &str = "/users/jon/dev/scratch/";

fn spec() -> ProjectSpec {
    ProjectSpec {
        name: "Scratch".into(),
        color: "#6A9BCC".into(),
        icon: "folder.fill".into(),
        root: Some("/Users/jon/dev/scratch".into()),
    }
}

/// The example table marked seeded, as the build marks projects.json's,
/// two more seeded ones, and the sidebar-made Scratch.
fn table() -> Vec<Project> {
    let mut t: Vec<Project> = example_projects()
        .into_iter()
        .map(|p| Project {
            seeded: Some(true),
            ..p
        })
        .collect();
    let more: Vec<Project> = serde_json::from_value(json!([
        { "match": "applet", "name": "Applet", "color": "#9B6FB0", "icon": "music.note", "seeded": true },
        { "match": "/dev/app-four", "name": "App Four", "color": "#4F9C94", "icon": "pianokeys", "seeded": true },
        { "match": KEY, "name": "Scratch", "color": "#6A9BCC", "icon": "folder.fill", "root": "/Users/jon/dev/scratch" },
    ]))
    .unwrap();
    t.extend(more);
    t
}

fn setup(workspaces: Vec<cockpit_core::data::Workspace>) -> (Session, Data) {
    let state = json!({
        "projectOverride": { "w2": KEY, "w3": APP_ONE },
        "projects": { KEY: spec() },
    });
    let saved = SavedState::from_json(&state.to_string()).unwrap();
    (Session::new(table(), saved), frame(NOW, vec![], workspaces))
}

fn entry_ids(s: &mut Session, data: &Data) -> Vec<String> {
    s.project_entries(data)
        .iter()
        .map(|e| e.id().to_string())
        .collect()
}

fn after(ids: &[String], id: &str) -> Option<String> {
    let at = ids.iter().position(|x| x == id)?;
    ids.get(at + 1).cloned()
}

/// The cwd of the last cmux call.
fn last_cwd(s: &Session) -> Option<String> {
    let (_, params) = calls(s).pop()?;
    params.into_iter().find(|(k, _)| k == "cwd").map(|(_, v)| v)
}

mod the_project_menu {
    use super::*;

    /// Partly ported: which menu items a header builds is the views'; here
    /// the edit item's words, and that it opens nothing.
    #[test]
    fn says_why_a_project_whose_first_match_is_too_short_cannot_be_edited_and_opens_nothing() {
        let (mut s, _) = setup(vec![]);
        assert_eq!(
            edit_label("applet"),
            "Edit project (its first match is too short to save)"
        );
        assert_eq!(edit_label(APP_ONE), "Edit project");
        assert!(!can_save_project("applet"));
        assert!(can_save_project(APP_ONE));
        s.open_editor("applet");
        assert_eq!(s.editing_project(), None);
    }

    /// Partly ported: the item's words, without the menu around them.
    #[test]
    fn says_why_a_project_with_no_folder_opens_no_session() {
        let (s, _) = setup(vec![]);
        assert_eq!(
            s.project_new_label(APP_THREE),
            "New session (project has no folder)"
        );
    }
}

mod the_editor {
    use super::*;

    fn problem_with_name(s: &mut Session, name: &str) -> Option<String> {
        s.set_draft_name(name);
        s.draft_problem()
    }

    #[test]
    fn opens_on_a_file_project_as_it_stands_and_sits_under_its_header() {
        let (mut s, data) = setup(vec![ws("a").directory("/Users/jon/dev/app-one")]);
        s.open_editor(APP_ONE);
        assert_eq!(s.editing_project(), Some(APP_ONE));
        let want = ProjectSpec {
            name: "App One".into(),
            color: "#D97757".into(),
            icon: "star.fill".into(),
            root: Some("~/dev/app-one".into()),
        };
        assert_eq!(s.draft_spec(), &want);
        let ids = entry_ids(&mut s, &data);
        assert_eq!(
            after(&ids, &format!("p:{APP_ONE}")),
            Some(format!("e:{APP_ONE}"))
        );
    }

    #[test]
    fn sits_under_a_quiet_projects_row_too() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(APP_THREE);
        let ids = entry_ids(&mut s, &data);
        assert_eq!(
            after(&ids, &format!("q:{APP_THREE}")),
            Some(format!("e:{APP_THREE}"))
        );
    }

    #[test]
    fn does_not_open_for_other() {
        let (mut s, _) = setup(vec![]);
        s.open_editor("other");
        assert_eq!(s.editing_project(), None);
    }

    #[test]
    fn saves_a_renamed_restyled_file_project_once_on_done_under_its_first_match() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(APP_ONE);
        s.set_draft_name("  Alpha ");
        s.set_draft_color(PROJECT_COLORS[3]);
        s.set_draft_icon(PROJECT_ICONS[4]);
        assert!(sent(&s).is_empty());
        s.save_draft(&data);
        let saved = ProjectSpec {
            name: "Alpha".into(),
            color: PROJECT_COLORS[3].into(),
            icon: PROJECT_ICONS[4].into(),
            root: Some("~/dev/app-one".into()),
        };
        let value = serde_json::to_value(&saved).unwrap();
        assert_eq!(sent(&s), [(format!("projects.{APP_ONE}"), Some(value))]);
        assert_eq!(s.editing_project(), None);
        // Before the rebuild lands, it reopens on what was sent.
        s.open_editor(APP_ONE);
        assert_eq!(s.draft_spec(), &saved);
    }

    #[test]
    fn only_closes_when_nothing_changed() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.save_draft(&data);
        assert!(sent(&s).is_empty());
        assert_eq!(s.editing_project(), None);
    }

    #[test]
    fn says_why_done_will_not_save_and_stays_open() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(APP_TWO);
        let p = |s: &mut Session, name: &str| problem_with_name(s, name);
        assert_eq!(p(&mut s, "  ").as_deref(), Some("Give the project a name."));
        assert_eq!(
            p(&mut s, &"x".repeat(65)).as_deref(),
            Some("Keep the name to 64 characters.")
        );
        assert_eq!(
            p(&mut s, "a\tb").as_deref(),
            Some("The name cannot hold tabs or line breaks.")
        );
        assert_eq!(
            p(&mut s, "Scratch").as_deref(),
            Some("Another project is called Scratch.")
        );
        assert_eq!(p(&mut s, "App Two"), None);
        s.set_draft_folder("dev/two");
        assert_eq!(
            s.draft_problem().as_deref(),
            Some("The folder needs a full path, starting with / or ~/.")
        );
        s.save_draft(&data);
        assert!(sent(&s).is_empty());
        assert_eq!(s.editing_project(), Some(APP_TWO));
    }

    #[test]
    fn says_why_a_colour_or_icon_will_not_save() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.set_draft_color("red");
        assert_eq!(
            s.draft_problem().as_deref(),
            Some("Pick a colour from the dots.")
        );
        s.set_draft_color(PROJECT_COLORS[1]);
        s.set_draft_icon("Not An Icon");
        assert_eq!(s.draft_problem().as_deref(), Some("Pick an icon."));
        s.set_draft_icon(PROJECT_ICONS[2]);
        assert_eq!(s.draft_problem(), None);
    }

    fn common() -> Vec<String> {
        PROJECT_ICONS.iter().map(|s| s.to_string()).collect()
    }

    /// Partly ported: the Images the editor draws are the view's; here the rows.
    #[test]
    fn offers_a_projects_own_icon_first_when_the_common_row_does_not_list_it_still_one_row() {
        assert_eq!(icon_rows(PROJECT_ICONS[0], ""), [common()]);
        let mut own = vec!["pianokeys".to_string()];
        own.extend(common().into_iter().take(7));
        assert_eq!(icon_rows("pianokeys", ""), [own.clone()]);
        assert_eq!(icon_rows("Not An Icon", ""), [common()]);
        let (mut s, _) = setup(vec![]);
        s.open_editor("/dev/app-four");
        assert_eq!(icon_rows(&s.draft_spec().icon, s.icon_search()), [own]);
    }

    #[test]
    fn searches_the_stored_symbols_by_every_word_typed_across_the_dots_two_rows_at_most() {
        assert!(icon_matches("  ").is_empty());
        assert_eq!(
            icon_matches("Music Note"),
            ["music.note", "music.note.list", "music.quarternote.3"]
        );
        assert_eq!(icon_matches("cloud.bolt"), ["cloud.bolt.fill"]);
        assert_eq!(icon_matches("fill").len(), 16);
        let lens: Vec<usize> = icon_rows("folder.fill", "fill")
            .iter()
            .map(Vec::len)
            .collect();
        assert_eq!(lens, [8, 8]);
        assert!(icon_rows("folder.fill", "zzz").is_empty());
    }

    #[test]
    fn puts_names_whose_parts_start_with_the_words_first() {
        assert_eq!(icon_matches("cat"), ["cat.fill", "location.fill"]);
        // Unranked, list order would put books.vertical.fill and star.fill first.
        assert_eq!(
            icon_matches("cal")[..2],
            ["calendar", "calendar.badge.clock"]
        );
        assert_eq!(icon_matches("tar")[0], "target");
    }

    #[test]
    fn says_when_nothing_matches_or_how_many_more_a_longer_word_would_reach() {
        assert_eq!(search_note("zzz "), "No icons match \"zzz\".");
        let more = search_note("fill");
        let (n, rest) = more.split_once(' ').unwrap();
        assert!(n.parse::<usize>().is_ok(), "{more}");
        assert_eq!(rest, "more: type more of the name.");
        assert_eq!(search_note("music"), "");
        assert_eq!(search_note(""), "");
    }

    #[test]
    fn cuts_a_list_into_rows_the_last_one_short() {
        assert_eq!(rows_of(&[1, 2, 3], 2), [vec![1, 2], vec![3]]);
        assert!(rows_of::<i32>(&[], 8).is_empty());
    }

    /// Partly ported: the field's onEdit and the drawn Images and
    /// Rectangles are the view's; here the search's words and its rows.
    #[test]
    fn draws_the_matches_as_the_search_is_typed_keeping_short_rows_to_the_columns() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.set_icon_search("piano");
        assert_eq!(s.icon_search(), "piano");
        let rows = icon_rows(&s.draft_spec().icon, s.icon_search());
        let drawn: Vec<&String> = rows.iter().flatten().collect();
        assert!(drawn.iter().any(|n| *n == "pianokeys"));
        assert!(!drawn.iter().any(|n| *n == "folder.fill"));
        assert!(rows.iter().all(|r| r.len() <= ICONS_PER_ROW));
    }

    /// Partly ported: that no field takes a submit handler is the view's;
    /// here a name typed, then a colour picked, saves both on Done.
    #[test]
    fn gives_no_field_a_submit_handler_so_a_tap_after_typing_lands_and_done_saves_both() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.set_draft_name("Renamed");
        s.set_draft_color(PROJECT_COLORS[3]);
        assert_eq!(s.editing_project(), Some(APP_TWO));
        assert!(sent(&s).is_empty());
        s.save_draft(&data);
        let last = sent(&s).pop().and_then(|(_, v)| v).unwrap();
        assert_eq!(last["name"], "Renamed");
        assert_eq!(last["color"], PROJECT_COLORS[3]);
    }

    #[test]
    fn keeps_the_draft_on_escape_while_searching() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.set_draft_name("Renamed");
        s.set_icon_search("piano");
        s.cancel_search();
        assert_eq!(s.editing_project(), Some(APP_TWO));
        assert_eq!(s.draft_spec().name, "Renamed");
        assert!(sent(&s).is_empty());
    }

    #[test]
    fn closes_on_escape_in_an_empty_search_and_keeps_the_search_when_the_open_project_is_opened_again()
     {
        let (mut s, _) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.set_icon_search("piano");
        s.open_editor(APP_TWO);
        assert_eq!(s.icon_search(), "piano");
        s.cancel_search();
        assert_eq!(s.editing_project(), Some(APP_TWO));
        s.set_icon_search("");
        s.cancel_search();
        assert_eq!(s.editing_project(), None);
        s.set_icon_search("piano");
        s.open_editor(KEY);
        assert_eq!(s.icon_search(), "");
    }

    #[test]
    fn opens_plus_in_the_folder_just_saved_before_the_rebuild_once_it_is_a_full_path() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(KEY);
        s.set_draft_folder("/Users/jon/dev/scratch-two");
        s.save_draft(&data);
        s.open_project_workspace(&data, KEY, None);
        assert_eq!(last_cwd(&s).as_deref(), Some("/Users/jon/dev/scratch-two"));
        // A "~" folder waits for the build to expand it, so the built one opens.
        s.open_editor(KEY);
        s.set_draft_folder("~/dev/scratch-two");
        s.save_draft(&data);
        s.open_project_workspace(&data, KEY, None);
        assert_eq!(last_cwd(&s), spec().root);
    }

    #[test]
    fn drops_the_folder_when_the_field_is_emptied() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(KEY);
        s.set_draft_folder("   ");
        assert_eq!(s.draft_spec().root, None);
        s.set_draft_folder(" ~/dev/scratch ");
        assert_eq!(s.draft_spec().root.as_deref(), Some("~/dev/scratch"));
    }

    /// Partly ported: the fields' words and placeholders are the view's;
    /// here the field's text it opens on, a name typed, and Done.
    #[test]
    fn types_into_the_fields_and_saves_on_done_as_the_renderer_would() {
        let (mut s, data) = setup(vec![]);
        s.open_editor(KEY);
        assert_eq!(s.draft_spec().name, spec().name);
        assert_eq!(s.icon_search(), "");
        assert_eq!(s.draft_spec().root, spec().root);
        s.set_draft_name("Scratchpad");
        s.save_draft(&data);
        let want = ProjectSpec {
            name: "Scratchpad".into(),
            ..spec()
        };
        let value = serde_json::to_value(&want).unwrap();
        assert_eq!(sent(&s), [(format!("projects.{KEY}"), Some(value))]);
    }

    #[test]
    fn closes_on_escape_without_saving() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.set_draft_name("Never saved");
        s.close_editor();
        assert_eq!(s.editing_project(), None);
        assert!(sent(&s).is_empty());
    }

    #[test]
    fn lists_the_folders_that_put_a_session_in_the_project() {
        let (s, _) = setup(vec![]);
        assert_eq!(
            s.matches_line(APP_TWO),
            "Sessions in /dev/app-two, /.config/app-two"
        );
    }
}

mod removing_a_project {
    use super::*;

    #[test]
    fn asks_once_then_saves_a_file_project_as_removed_and_clears_overrides_to_it() {
        let (mut s, data) = setup(vec![ws("a").directory("/Users/jon/dev/app-one")]);
        s.open_editor(APP_ONE);
        assert_eq!(s.remove_label(), "Remove project");
        s.remove_tapped();
        assert_eq!(s.remove_label(), "Tap again to remove");
        assert!(sent(&s).is_empty());
        s.remove_tapped();
        assert_eq!(
            sent(&s),
            [
                ("projectOverride.w3".to_string(), None),
                (
                    format!("projects.{APP_ONE}"),
                    Some(json!({ "removed": true }))
                ),
            ]
        );
        assert_eq!(s.editing_project(), None);
        assert!(!s.has_project_override(Some(&ws("w3"))));
        // Its header goes at once; its card waits in Other for the rebuild.
        let ids = entry_ids(&mut s, &data);
        assert!(!ids.contains(&format!("p:{APP_ONE}")), "{ids:?}");
        assert!(!ids.contains(&format!("q:{APP_ONE}")), "{ids:?}");
        assert_eq!(after(&ids, "p:other").as_deref(), Some("a@p"));
        // Gone until the rebuild, so it does not reopen.
        s.open_editor(APP_ONE);
        assert_eq!(s.editing_project(), None);
    }

    #[test]
    fn deletes_a_sidebar_made_projects_entry_outright_once() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(KEY);
        s.remove_tapped();
        s.remove_tapped();
        assert_eq!(
            sent(&s),
            [
                ("projectOverride.w2".to_string(), None::<Value>),
                (format!("projects.{KEY}"), None),
            ]
        );
        s.remove_project(KEY);
        assert_eq!(sent(&s).len(), 2);
    }

    #[test]
    fn forgets_a_first_tap_when_the_editor_closes() {
        let (mut s, _) = setup(vec![]);
        s.open_editor(APP_TWO);
        s.remove_tapped();
        s.close_editor();
        s.open_editor(APP_TWO);
        assert_eq!(s.remove_label(), "Remove project");
    }
}
