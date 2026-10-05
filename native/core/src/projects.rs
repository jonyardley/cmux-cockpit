//! Project identity from the workspace directory (src/shared/projects.ts),
//! the colours and icons a project steps through (project-sets.ts), a new
//! project made from a folder, and the cockpit's Move to project choice
//! that overrides the path match (the project-of-a-workspace part of
//! src/cockpit/by-project.ts; by_project.rs has the rest).

use serde::Deserialize;
use serde_json::Value;

use crate::data::Workspace;
use crate::js::utf16_prefix;
use crate::persist::{ProjectSpec, SavedProject, SavedState};
use crate::session::Session;

/// Colours a sidebar-made project steps through.
pub const PROJECT_COLORS: [&str; 16] = [
    "#D97757", "#6A9BCC", "#788C5D", "#C2A83E", "#9B6FB0", "#CC6B8E", "#4F9C94", "#8A7F72",
    "#B8503C", "#E0934A", "#98AE4E", "#3E7FA8", "#6C74C9", "#8E4F7E", "#5D8A6A", "#5E6670",
];

/// The editor's common icons; a new project starts on the first.
pub const PROJECT_ICONS: [&str; 8] = [
    "folder.fill",
    "chevron.left.forwardslash.chevron.right",
    "terminal.fill",
    "music.note",
    "house.fill",
    "bag.fill",
    "star.fill",
    "bolt.fill",
];

/// The longest project name (project-rules.ts).
pub const MAX_NAME: usize = 64;

/// A project's path fragment, or several.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Match {
    One(String),
    Many(Vec<String>),
}

/// One row of the project table.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Project {
    /// Path fragment, or several, any of which puts a directory in this project.
    #[serde(rename = "match")]
    pub matches: Match,
    pub name: String,
    pub color: String,
    /// SF Symbol name.
    pub icon: String,
    /// The folder a new workspace opens in.
    #[serde(default)]
    pub root: Option<String>,
    /// From config/projects.json, so removing it saves a removal.
    #[serde(default)]
    pub seeded: Option<bool>,
}

impl Project {
    /// Every path fragment the project matches, one or many.
    pub fn matches_of(&self) -> &[String] {
        match &self.matches {
            Match::One(m) => std::slice::from_ref(m),
            Match::Many(ms) => ms,
        }
    }

    /// A stable key for the project: its first match.
    pub fn id(&self) -> &str {
        self.matches_of().first().map_or("", String::as_str)
    }
}

/// The key of Other, the group for a card no project matches.
pub const OTHER_KEY: &str = "other";

/// Other: the group for a card no project matches, in palette.ts's grey.
pub fn other() -> Project {
    Project {
        matches: Match::One(OTHER_KEY.to_string()),
        name: "Other".to_string(),
        color: "#A09E95".to_string(),
        icon: "terminal".to_string(),
        root: None,
        seeded: None,
    }
}

impl Project {
    /// A project made from a spec, matched by its key.
    pub fn from_spec(key: &str, spec: &ProjectSpec) -> Project {
        Project {
            matches: Match::One(key.to_string()),
            name: spec.name.clone(),
            color: spec.color.clone(),
            icon: spec.icon.clone(),
            root: spec.root.clone(),
            seeded: None,
        }
    }

    /// The project's look and folder as a spec.
    pub fn spec(&self) -> ProjectSpec {
        ProjectSpec {
            name: self.name.clone(),
            color: self.color.clone(),
            icon: self.icon.clone(),
            root: self.root.clone(),
        }
    }
}

/// The saved spec behind a project, or None when it was never edited in
/// the sidebar or was removed there.
pub fn saved_spec<'s>(saved: &'s SavedState, key: &str) -> Option<&'s ProjectSpec> {
    match saved.projects.get(key)? {
        SavedProject::Spec(spec) => Some(spec),
        SavedProject::Removed { .. } => None,
    }
}

/// The folder's last segment as a name the state contract accepts:
/// control characters out, trimmed, capitalised, and short enough to take
/// a number.
fn name_from(segment: &str) -> String {
    let clean: String = segment.chars().filter(|c| u32::from(*c) >= 32).collect();
    let clean = utf16_prefix(clean.trim(), MAX_NAME - 4);
    let clean = clean.trim();
    let mut chars = clean.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// An absolute folder at least two segments deep, "/a/b".
fn deep_enough(dir: &str) -> bool {
    match dir.strip_prefix('/') {
        Some(rest) => {
            let parts: Vec<&str> = rest.split('/').collect();
            parts.len() >= 2 && parts.iter().all(|p| !p.is_empty())
        }
        None => false,
    }
}

/// A new project for `directory`, keyed by it: matched and rooted there,
/// named after its last segment (numbered if the name is taken), in the
/// first colour no project uses yet. `existing` should include projects
/// sent but not yet built. None without an absolute folder at least two
/// segments deep.
pub fn new_project(directory: Option<&str>, existing: &[Project]) -> Option<(String, ProjectSpec)> {
    let dir = directory.unwrap_or_default().trim_end_matches('/');
    let last = dir.rfind('/').map_or(dir, |i| &dir[i + 1..]);
    let base = name_from(last);
    if !deep_enough(dir) || base.is_empty() {
        return None;
    }
    let taken = |n: &str| existing.iter().any(|p| p.name == n);
    let mut name = base.clone();
    let mut n = 2;
    while taken(&name) {
        name = format!("{base} {n}");
        n += 1;
    }
    let spec = ProjectSpec {
        name,
        color: next_color(existing).to_string(),
        icon: PROJECT_ICONS[0].to_string(),
        root: Some(dir.to_string()),
    };
    Some((format!("{}/", dir.to_lowercase()), spec))
}

/// The first colour no project in `existing` uses yet; once all are
/// taken, they go round again.
pub fn next_color(existing: &[Project]) -> &'static str {
    let used: Vec<String> = existing.iter().map(|p| p.color.to_lowercase()).collect();
    PROJECT_COLORS
        .iter()
        .find(|c| !used.contains(&c.to_lowercase()))
        .copied()
        .unwrap_or(PROJECT_COLORS[existing.len() % PROJECT_COLORS.len()])
}

/// True when `key` is a configured project's key.
pub fn is_project_key(projects: &[Project], key: &str) -> bool {
    projects.iter().any(|p| p.id() == key)
}

/// The matching project, or None when none matches. The trailing "/" lets
/// a folder match ("/dev/app/") skip "/dev/app-old".
pub fn project_of<'p>(projects: &'p [Project], directory: Option<&str>) -> Option<&'p Project> {
    let d = format!("{}/", directory.unwrap_or_default().to_lowercase());
    projects
        .iter()
        .find(|p| p.matches_of().iter().any(|m| d.contains(m.as_str())))
}

/// A workspace's project: the Move to project choice while it names a
/// configured project, else its path match.
pub fn project_for<'p>(
    projects: &'p [Project],
    directory: Option<&str>,
    choice: Option<&str>,
) -> Option<&'p Project> {
    choice
        .filter(|c| !c.is_empty())
        .and_then(|c| projects.iter().find(|p| p.id() == c))
        .or_else(|| project_of(projects, directory))
}

impl Session {
    /// A workspace's project: its Move to project choice while that stands,
    /// else its path match, else Other.
    pub fn project_of_workspace(&self, w: Option<&Workspace>) -> Project {
        let Some(w) = w else { return other() };
        let choice = self.project_override.get(&w.id).map(String::as_str);
        project_for(&self.projects, w.directory.as_deref(), choice)
            .cloned()
            .unwrap_or_else(other)
    }

    /// The key of the workspace's project, "other" when none.
    pub fn project_key(&self, w: &Workspace) -> String {
        self.project_of_workspace(Some(w)).id().to_string()
    }

    /// Moves a workspace to a project, kept across a reload until cleared.
    pub fn move_to_project(&mut self, w: Option<&Workspace>, key: &str) {
        let Some(w) = w else { return };
        if !is_project_key(&self.projects, key) {
            return;
        }
        self.project_override.insert(w.id.clone(), key.to_string());
        self.persist_set(format!("projectOverride.{}", w.id), Some(Value::from(key)));
    }

    /// Drops the override, so the workspace falls back to its path match.
    pub fn clear_project_override(&mut self, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        if self.project_override.shift_remove(&w.id).is_none() {
            return;
        }
        self.persist_set(format!("projectOverride.{}", w.id), None);
    }

    /// Whether the workspace has a Move to project choice.
    pub fn has_project_override(&self, w: Option<&Workspace>) -> bool {
        w.is_some_and(|w| self.project_override.contains_key(&w.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Vec<Project> {
        serde_json::from_str(
            r##"[{"match": "/dev/app", "name": "App", "color": "#000000", "icon": "x"},
                {"match": ["/dev/two", "/.config/two"], "name": "Two", "color": "#000000", "icon": "x"}]"##,
        )
        .unwrap()
    }

    #[test]
    fn matches_a_folder_by_any_fragment_and_keys_by_the_first() {
        let t = table();
        assert_eq!(
            project_of(&t, Some("/Users/x/.config/two")).map(Project::id),
            Some("/dev/two")
        );
        assert_eq!(
            project_of(&t, Some("/Users/x/DEV/APP")).map(Project::id),
            Some("/dev/app")
        );
        assert_eq!(
            project_of(&t, Some("/Users/x/dev/app-old")).map(Project::id),
            Some("/dev/app")
        );
        assert_eq!(project_of(&t, None), None);
        assert!(is_project_key(&t, "/dev/two"));
        assert!(!is_project_key(&t, "/.config/two"));
    }

    #[test]
    fn names_a_new_project_after_its_folder_and_numbers_a_taken_name() {
        let (key, spec) = new_project(Some("/Users/x/dev/pianola/"), &[]).unwrap();
        assert_eq!(key, "/users/x/dev/pianola/");
        assert_eq!(spec.name, "Pianola");
        assert_eq!(spec.root.as_deref(), Some("/Users/x/dev/pianola"));
        assert_eq!(spec.color, PROJECT_COLORS[0]);
        assert_eq!(spec.icon, PROJECT_ICONS[0]);
        let made = Project::from_spec(&key, &spec);
        let (_, again) = new_project(Some("/elsewhere/pianola"), &[made]).unwrap();
        assert_eq!(again.name, "Pianola 2");
        assert_eq!(again.color, PROJECT_COLORS[1]);
        assert!(new_project(Some("/opt"), &[]).is_none(), "one segment deep");
        assert!(new_project(Some("dev/app"), &[]).is_none(), "not absolute");
        assert!(new_project(None, &[]).is_none());
        let long = format!("/a/{}", "x".repeat(80));
        let (_, cut) = new_project(Some(&long), &[]).unwrap();
        assert_eq!(cut.name.len(), MAX_NAME - 4);
    }

    #[test]
    fn prefers_a_configured_choice_over_the_path() {
        let t = table();
        let p = project_for(&t, Some("/dev/app"), Some("/dev/two"));
        assert_eq!(p.map(Project::id), Some("/dev/two"));
        let p = project_for(&t, Some("/dev/app"), Some("nope"));
        assert_eq!(p.map(Project::id), Some("/dev/app"));
    }
}
