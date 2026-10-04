//! Project identity from the workspace directory (src/shared/projects.ts),
//! and the cockpit's Move to project choice that overrides it (the
//! project-of-a-workspace part of src/cockpit/by-project.ts; the Projects
//! view's rows stay for the lane that ports them).

use serde::Deserialize;
use serde_json::Value;

use crate::data::Workspace;
use crate::session::Session;

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

/// Other: the group for a card no project matches.
pub fn other() -> Project {
    Project {
        matches: Match::One(OTHER_KEY.to_string()),
        name: "Other".to_string(),
        color: "grey".to_string(),
        icon: "terminal".to_string(),
        root: None,
        seeded: None,
    }
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
    fn prefers_a_configured_choice_over_the_path() {
        let t = table();
        let p = project_for(&t, Some("/dev/app"), Some("/dev/two"));
        assert_eq!(p.map(Project::id), Some("/dev/two"));
        let p = project_for(&t, Some("/dev/app"), Some("nope"));
        assert_eq!(p.map(Project::id), Some("/dev/app"));
    }
}
