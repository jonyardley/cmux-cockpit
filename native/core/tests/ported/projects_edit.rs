//! test/projects-edit.test.ts: the by-project half of editing and
//! removing a project. The editor itself (edit.ts: its draft, problems,
//! icon search, fields and remove's second tap) and the menus (views) are
//! not ported, so their cases are left out; a case that also shows where
//! the editor sits, or what a save leaves behind, keeps those asserts,
//! with the editor set open or the save sent through by-project's own
//! calls.

use cockpit_core::data::Data;
use cockpit_core::persist::{ProjectSpec, SavedState};
use cockpit_core::projects::Project;
use cockpit_core::session::Session;
use serde_json::{Value, json};

use crate::support::*;

const NOW: f64 = 1_000_100.0;
const APP_ONE: &str = "/dev/app-one";
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

mod the_editor {
    use super::*;

    /// Partly ported: the draft is edit.ts's; spec_of is what it opens on.
    #[test]
    fn opens_on_a_file_project_as_it_stands_and_sits_under_its_header() {
        let (mut s, data) = setup(vec![ws("a").directory("/Users/jon/dev/app-one")]);
        s.set_editing_project(Some(APP_ONE));
        assert_eq!(s.editing_project(), Some(APP_ONE));
        let want = ProjectSpec {
            name: "App One".into(),
            color: "#D97757".into(),
            icon: "star.fill".into(),
            root: Some("~/dev/app-one".into()),
        };
        assert_eq!(s.spec_of(APP_ONE), Some(want));
        let ids = entry_ids(&mut s, &data);
        assert_eq!(
            after(&ids, &format!("p:{APP_ONE}")),
            Some(format!("e:{APP_ONE}"))
        );
    }

    #[test]
    fn sits_under_a_quiet_projects_row_too() {
        let (mut s, data) = setup(vec![]);
        s.set_editing_project(Some(APP_THREE));
        let ids = entry_ids(&mut s, &data);
        assert_eq!(
            after(&ids, &format!("q:{APP_THREE}")),
            Some(format!("e:{APP_THREE}"))
        );
    }

    /// Partly ported: the draft and Done are edit.ts's; the save goes
    /// through save_project, and what it reopens on is spec_of.
    #[test]
    fn saves_a_renamed_restyled_file_project_once_on_done_under_its_first_match() {
        let (mut s, _) = setup(vec![]);
        let saved = ProjectSpec {
            name: "Alpha".into(),
            color: "#C2A83E".into(),
            icon: "house.fill".into(),
            root: Some("~/dev/app-one".into()),
        };
        s.save_project(APP_ONE, saved.clone());
        let value = serde_json::to_value(&saved).unwrap();
        assert_eq!(sent(&s), [(format!("projects.{APP_ONE}"), Some(value))]);
        // Before the rebuild lands, it reopens on what was sent.
        assert_eq!(s.spec_of(APP_ONE), Some(saved));
    }

    /// Partly ported: the folder is saved through save_project in place of the editor.
    #[test]
    fn opens_plus_in_the_folder_just_saved_before_the_rebuild_once_it_is_a_full_path() {
        let (mut s, data) = setup(vec![]);
        let with_root = |root: &str| ProjectSpec {
            root: Some(root.into()),
            ..spec()
        };
        s.save_project(KEY, with_root("/Users/jon/dev/scratch-two"));
        s.open_project_workspace(&data, KEY, None);
        assert_eq!(last_cwd(&s).as_deref(), Some("/Users/jon/dev/scratch-two"));
        // A "~" folder waits for the build to expand it, so the built one opens.
        s.save_project(KEY, with_root("~/dev/scratch-two"));
        s.open_project_workspace(&data, KEY, None);
        assert_eq!(last_cwd(&s), spec().root);
    }
}

mod removing_a_project {
    use super::*;

    /// Partly ported: remove's two taps are edit.ts's; the second calls remove_project.
    #[test]
    fn asks_once_then_saves_a_file_project_as_removed_and_clears_overrides_to_it() {
        let (mut s, data) = setup(vec![ws("a").directory("/Users/jon/dev/app-one")]);
        s.remove_project(APP_ONE);
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
        assert!(!s.has_project_override(Some(&ws("w3"))));
        // Its header goes at once; its card waits in Other for the rebuild.
        let ids = entry_ids(&mut s, &data);
        assert!(!ids.contains(&format!("p:{APP_ONE}")), "{ids:?}");
        assert!(!ids.contains(&format!("q:{APP_ONE}")), "{ids:?}");
        assert_eq!(after(&ids, "p:other").as_deref(), Some("a@p"));
        // Gone until the rebuild, so the editor has nothing to open on.
        assert_eq!(s.spec_of(APP_ONE), None);
    }

    #[test]
    fn deletes_a_sidebar_made_projects_entry_outright_once() {
        let (mut s, _) = setup(vec![]);
        s.remove_project(KEY);
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
}
