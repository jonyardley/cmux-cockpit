//! The project table the sidebars' build bakes in: config/projects.json
//! with config/state.json's saved projects laid over it
//! (mergeProjects in scripts/projects-config.ts). The pane reads both
//! files itself, so it builds the same table here.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::persist::{ProjectSpec, SavedProject};
use crate::projects::{Match, Project};

// A file project with its saved edit laid over. Its matches stay: a
// fragment such as "/.config/cmux" also catches that folder's worktrees,
// and a saved key could not say so.
fn edited(p: &Project, spec: &ProjectSpec) -> Project {
    Project {
        matches: p.matches.clone(),
        name: spec.name.clone(),
        color: spec.color.clone(),
        icon: spec.icon.clone(),
        root: spec.root.clone(),
        seeded: Some(true),
    }
}

fn with_edits(file: &[Project], edits: &HashMap<&str, &SavedProject>) -> Vec<Project> {
    file.iter()
        .filter_map(|p| match edits.get(p.id()) {
            Some(SavedProject::Removed { .. }) => None,
            Some(SavedProject::Spec(spec)) => Some(edited(p, spec)),
            None => Some(Project {
                seeded: Some(true),
                ..p.clone()
            }),
        })
        .collect()
}

// The edited file projects whose name another project also has.
fn clashing(projects: &[Project], edits: &HashMap<&str, &SavedProject>) -> Vec<String> {
    let mut count: HashMap<&str, usize> = HashMap::new();
    for p in projects {
        *count.entry(p.name.as_str()).or_default() += 1;
    }
    projects
        .iter()
        .filter(|p| {
            count.get(p.name.as_str()).is_some_and(|n| *n > 1) && edits.contains_key(p.id())
        })
        .map(|p| p.id().to_string())
        .collect()
}

/// The file's table with the saved projects laid over it. A saved entry
/// under a file project's first match edits or removes that project; an
/// edit that would give two projects one name is dropped, the file's
/// entry kept. The rest are sidebar-made projects, appended, deepest
/// folder first; one whose folder a standing file project's match claims,
/// or whose name is taken, is dropped. Roots are left as written.
pub fn merge_projects(file: &[Project], saved: &BTreeMap<String, SavedProject>) -> Vec<Project> {
    let ids: HashSet<&str> = file.iter().map(Project::id).collect();
    let mut edits: HashMap<&str, &SavedProject> = saved
        .iter()
        .filter(|(id, _)| ids.contains(id.as_str()))
        .map(|(id, s)| (id.as_str(), s))
        .collect();
    let mut projects = with_edits(file, &edits);
    loop {
        let clash = clashing(&projects, &edits);
        if clash.is_empty() {
            break;
        }
        for id in &clash {
            edits.remove(id.as_str());
        }
        projects = with_edits(file, &edits);
    }
    // Only the file projects still standing claim folders: a removed one's
    // matches must not block a sidebar-made project in its old folder.
    let file_matches: Vec<String> = projects
        .iter()
        .flat_map(|p| p.matches_of().to_vec())
        .collect();
    let mut matches: HashSet<String> = file_matches.iter().cloned().collect();
    let mut names: HashSet<String> = projects.iter().map(|p| p.name.clone()).collect();
    let mut deepest_first: Vec<(&String, &SavedProject)> = saved.iter().collect();
    deepest_first.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
    for (key, entry) in deepest_first {
        // A key with no trailing "/" is only ever a file project's.
        let SavedProject::Spec(spec) = entry else {
            continue;
        };
        if ids.contains(key.as_str()) || !key.ends_with('/') {
            continue;
        }
        if matches.contains(key)
            || names.contains(&spec.name)
            || file_matches.iter().any(|m| key.contains(m.as_str()))
        {
            continue;
        }
        matches.insert(key.clone());
        names.insert(spec.name.clone());
        projects.push(Project {
            matches: Match::One(key.clone()),
            name: spec.name.clone(),
            color: spec.color.clone(),
            icon: spec.icon.clone(),
            root: spec.root.clone(),
            seeded: None,
        });
    }
    projects
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file() -> Vec<Project> {
        serde_json::from_str(
            r##"[{"match": "/dev/a", "name": "A", "color": "#000000", "icon": "x"},
                {"match": ["/dev/b", "/dev/b2"], "name": "B", "color": "#000000", "icon": "x"}]"##,
        )
        .unwrap()
    }

    fn spec(name: &str) -> SavedProject {
        SavedProject::Spec(ProjectSpec {
            name: name.to_string(),
            color: "#6A9BCC".to_string(),
            icon: "folder.fill".to_string(),
            root: None,
        })
    }

    fn removed() -> SavedProject {
        SavedProject::Removed { removed: true }
    }

    fn saved(entries: Vec<(&str, SavedProject)>) -> BTreeMap<String, SavedProject> {
        entries
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    fn names(ps: &[Project]) -> Vec<&str> {
        ps.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn appends_sidebar_made_projects_after_the_files() {
        let merged = merge_projects(&file(), &saved(vec![("/dev/c/", spec("C"))]));
        assert_eq!(names(&merged), ["A", "B", "C"]);
        assert_eq!(merged[2].id(), "/dev/c/");
        assert_eq!(merged[2].icon, "folder.fill");
    }

    #[test]
    fn drops_a_sidebar_made_project_in_a_claimed_folder_or_with_a_taken_name() {
        let merged = merge_projects(
            &file(),
            &saved(vec![("/dev/b2/sub/", spec("Y")), ("/dev/z/", spec("A"))]),
        );
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn marks_the_files_projects_as_seeded_and_no_others() {
        let merged = merge_projects(&file(), &saved(vec![("/dev/c/", spec("C"))]));
        let seeded: Vec<bool> = merged.iter().map(|p| p.seeded == Some(true)).collect();
        assert_eq!(seeded, [true, true, false]);
    }

    #[test]
    fn lets_a_saved_edit_win_over_the_file_project_keeping_its_matches() {
        let edit = SavedProject::Spec(ProjectSpec {
            name: "Bee".to_string(),
            color: "#6A9BCC".to_string(),
            icon: "folder.fill".to_string(),
            root: Some("~/dev/b".to_string()),
        });
        let merged = merge_projects(&file(), &saved(vec![("/dev/b", edit)]));
        assert_eq!(merged[1].matches_of(), ["/dev/b", "/dev/b2"]);
        assert_eq!(merged[1].name, "Bee");
        assert_eq!(merged[1].root.as_deref(), Some("~/dev/b"));
    }

    #[test]
    fn drops_the_files_root_when_the_edit_has_none() {
        let mut with_root = file();
        with_root[0].root = Some("~/dev/a".to_string());
        let merged = merge_projects(&with_root, &saved(vec![("/dev/a", spec("A"))]));
        assert_eq!(merged[0].root, None);
    }

    #[test]
    fn lets_a_sidebar_made_project_take_a_removed_file_projects_folder_and_name() {
        let merged = merge_projects(
            &file(),
            &saved(vec![
                ("/dev/a", removed()),
                ("/users/jon/dev/a/", spec("A")),
            ]),
        );
        let ids: Vec<&str> = merged.iter().map(Project::id).collect();
        assert_eq!(ids, ["/dev/b", "/users/jon/dev/a/"]);
    }

    #[test]
    fn leaves_out_a_file_project_saved_as_removed() {
        let merged = merge_projects(&file(), &saved(vec![("/dev/a", removed())]));
        assert_eq!(names(&merged), ["B"]);
    }

    #[test]
    fn ignores_a_removal_or_a_fragment_key_no_file_project_has() {
        let merged = merge_projects(
            &file(),
            &saved(vec![("/dev/gone", spec("Gone")), ("/dev/c/", removed())]),
        );
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn drops_an_edit_that_would_give_two_projects_one_name() {
        let merged = merge_projects(&file(), &saved(vec![("/dev/a", spec("B"))]));
        assert_eq!(names(&merged), ["A", "B"]);
    }

    #[test]
    fn lets_two_file_projects_swap_names_in_one_merge() {
        let merged = merge_projects(
            &file(),
            &saved(vec![("/dev/a", spec("B")), ("/dev/b", spec("A"))]),
        );
        assert_eq!(names(&merged), ["B", "A"]);
    }

    #[test]
    fn puts_the_deeper_of_two_sidebar_made_folders_first() {
        let merged = merge_projects(
            &file(),
            &saved(vec![("/dev/c/", spec("C")), ("/dev/c/deep/", spec("D"))]),
        );
        assert_eq!(names(&merged), ["A", "B", "D", "C"]);
    }
}
