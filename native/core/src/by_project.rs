//! The Projects view (src/cockpit/by-project.ts): its rows, the quiet
//! projects, projects made or removed here and held until a rebuild
//! carries them, and a new session opened in a project's folder. Which
//! project a workspace is in, and Move to project, are in projects.rs.
//!
//! Collapse is local only: projects are not cmux groups. A project with
//! several paths is one group, keyed by its first match.

use indexmap::IndexMap;
use serde::Serialize;

use crate::data::{Data, Workspace};
use crate::home::{expand_home, is_home, trim_slash};
use crate::lanes::LaneKey;
use crate::model::group_for_lane;
use crate::persist::ProjectSpec;
use crate::projects::{OTHER_KEY, Project, new_project, other, saved_spec};
use crate::session::{Param, Session};

/// The editor key of "+ New project" (state.ts NEW_PROJECT).
pub const NEW_PROJECT: &str = "+new";

/// How many open folders the new project editor offers.
const MAX_SUGGESTIONS: usize = 3;

/// One row of the Projects view. A card's key is `<wsId>@p`; an open editor has a key of its own under its
/// project's header or quiet row, since a row's kind is fixed by its key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectEntry {
    Header {
        id: String,
        project: String,
    },
    Ws {
        id: String,
        #[serde(rename = "wsId")]
        ws_id: String,
    },
    QuietHeader {
        id: String,
    },
    QuietRow {
        id: String,
        project: String,
    },
    Editor {
        id: String,
        project: String,
    },
    NewRow {
        id: String,
    },
}

impl ProjectEntry {
    /// The row's key.
    pub fn id(&self) -> &str {
        match self {
            ProjectEntry::Header { id, .. }
            | ProjectEntry::Ws { id, .. }
            | ProjectEntry::QuietHeader { id }
            | ProjectEntry::QuietRow { id, .. }
            | ProjectEntry::Editor { id, .. }
            | ProjectEntry::NewRow { id } => id,
        }
    }
}

/// A folder as a key: no trailing "/", any case.
pub(crate) fn folder_key(dir: Option<&str>) -> String {
    trim_slash(dir.unwrap_or_default()).to_lowercase()
}

impl Session {
    /// The project whose editor is open: its key, or NEW_PROJECT.
    pub fn editing_project(&self) -> Option<&str> {
        self.editing_project.as_deref()
    }

    pub fn set_editing_project(&mut self, k: Option<&str>) {
        self.editing_project = k.map(str::to_string);
    }

    fn built_project(&self, k: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id() == k)
    }

    /// The project as it now stands: the last spec sent, else its saved
    /// or built one. None once removed, or for Other.
    pub fn spec_of(&self, k: &str) -> Option<ProjectSpec> {
        if let Some(sent) = self.sent_specs.get(k) {
            return sent.clone();
        }
        let p = self.built_project(k)?;
        Some(
            saved_spec(&self.saved, k)
                .cloned()
                .unwrap_or_else(|| p.spec()),
        )
    }

    /// Every project as it now stands, keyed by its first match, sent but
    /// not built ones included.
    pub fn known_projects(&self) -> Vec<Project> {
        let mut keys: Vec<String> = self.projects.iter().map(|p| p.id().to_string()).collect();
        for k in self.sent_specs.keys() {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
        keys.iter()
            .filter_map(|k| self.spec_of(k).map(|spec| Project::from_spec(k, &spec)))
            .collect()
    }

    /// True when the card sits in Other (no path match, no override), so
    /// its folder can become a project.
    pub fn can_create_project(&self, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        if self.project_key(w) != OTHER_KEY || is_home(w.directory.as_deref(), self.home.as_deref())
        {
            return false;
        }
        match new_project(w.directory.as_deref(), &self.known_projects()) {
            // Already sent and waiting on the rebuild: a second tap would only rename it.
            Some((key, _)) => !matches!(self.sent_specs.get(&key), Some(Some(_))),
            None => false,
        }
    }

    /// True once the project was removed here, before the rebuild drops it.
    fn is_removed_project(&self, k: &str) -> bool {
        matches!(self.sent_specs.get(k), Some(None))
    }

    /// Saves a project's name, colour, icon and folder.
    pub fn save_project(&mut self, k: &str, spec: ProjectSpec) {
        let value = serde_json::to_value(&spec).ok();
        self.sent_specs.insert(k.to_string(), Some(spec));
        self.persist_set(format!("projects.{k}"), value);
    }

    /// Makes the card's folder a project, named after the folder.
    pub fn create_project_from(&mut self, w: Option<&Workspace>) {
        if !self.can_create_project(w) {
            return;
        }
        let dir = w.and_then(|w| w.directory.as_deref());
        if let Some((key, spec)) = new_project(dir, &self.known_projects()) {
            self.save_project(&key, spec);
        }
    }

    /// The card chip's words: `Make "Pianola" a project`.
    pub fn make_project_label(&self, w: Option<&Workspace>) -> String {
        let dir = w.and_then(|w| w.directory.as_deref());
        match new_project(dir, &self.known_projects()) {
            Some((_, spec)) => format!("Make \"{}\" a project", spec.name),
            None => "Make a project".to_string(),
        }
    }

    /// Folders of open workspaces that could become a project, each once.
    pub fn folder_suggestions(&mut self, data: &Data) -> Vec<String> {
        let mut dirs: IndexMap<String, String> = IndexMap::new();
        for w in self.card_workspaces(data) {
            if let Some(dir) = w.directory.as_deref().filter(|d| !d.is_empty())
                && self.can_create_project(Some(w))
            {
                dirs.insert(folder_key(Some(dir)), trim_slash(dir).to_string());
            }
        }
        dirs.into_values().take(MAX_SUGGESTIONS).collect()
    }

    /// Opens a workspace in `dir`, unless one is open there already.
    pub fn open_folder_once(&mut self, data: &Data, dir: &str) {
        let key = folder_key(Some(dir));
        let open = self
            .all_workspaces(data)
            .iter()
            .any(|w| folder_key(w.directory.as_deref()) == key);
        if !open {
            let cwd = Param::Str(dir.to_string());
            self.cmux(
                "workspace.create",
                vec![("cwd", cwd), ("focus", Param::Bool(true))],
            );
        }
    }

    /// Removes a project and every override pointing at it. One from
    /// projects.json is saved as removed, since deleting its entry would
    /// bring the file's back on the next build.
    pub fn remove_project(&mut self, k: &str) {
        if self.spec_of(k).is_none() {
            return;
        }
        let pointing: Vec<String> = self
            .project_override
            .iter()
            .filter(|(_, key)| *key == k)
            .map(|(id, _)| id.clone())
            .collect();
        for id in pointing {
            self.project_override.shift_remove(&id);
            self.persist_set(format!("projectOverride.{id}"), None);
        }
        self.sent_specs.insert(k.to_string(), None);
        let seeded = self
            .built_project(k)
            .is_some_and(|p| p.seeded == Some(true));
        let value = seeded.then(|| serde_json::json!({ "removed": true }));
        self.persist_set(format!("projects.{k}"), value);
    }

    /// The built project with this key, else Other.
    pub fn project_by_key(&self, k: &str) -> Project {
        self.built_project(k).cloned().unwrap_or_else(other)
    }

    /// The cards a project header counts and tints its pill by.
    pub fn project_workspaces<'d>(&mut self, data: &'d Data, k: &str) -> Vec<&'d Workspace> {
        self.card_workspaces(data)
            .into_iter()
            .filter(|w| self.project_key(w) == k)
            .collect()
    }

    /// Whether the project's header offers "+": it has a folder to open.
    pub fn can_open_project(&self, k: &str) -> bool {
        self.built_project(k)
            .and_then(|p| p.root.as_deref())
            .is_some_and(|r| !r.is_empty())
    }

    /// The folder "+" opens: until the rebuild lands, the last root sent,
    /// its "~" expanded as the build will, else the built one.
    fn root_to_open(&self, k: &str) -> Option<String> {
        let sent = self
            .sent_specs
            .get(k)
            .and_then(|s| s.as_ref())
            .and_then(|s| s.root.as_deref());
        let dir = sent.and_then(|r| expand_home(r, self.home.as_deref()));
        match dir {
            Some(d) if d.starts_with('/') => Some(d),
            _ => self
                .built_project(k)
                .and_then(|p| p.root.clone())
                .filter(|r| !r.is_empty()),
        }
    }

    /// Opens a new workspace in the project's root, if it has one. A
    /// folded project unfolds first, so the new card is not hidden. Given
    /// a lane whose group exists, it opens at the top of that group, which
    /// unfolds for the same reason; with no group yet it opens ungrouped.
    pub fn open_project_workspace(&mut self, data: &Data, k: &str, lane: Option<LaneKey>) {
        let Some(root) = self.root_to_open(k) else {
            return;
        };
        if self.is_project_collapsed(k) {
            self.toggle_project(data, k);
        }
        let lane = lane.map(|k| self.lanes.get(&k).clone());
        let group = lane.as_ref().and_then(|l| group_for_lane(data, l));
        if let (Some(l), Some(_)) = (&lane, group)
            && self.is_collapsed(data, l)
        {
            self.toggle_lane(data, &l.key);
        }
        let mut params = vec![("cwd", Param::Str(root)), ("focus", Param::Bool(true))];
        if let Some(g) = group {
            params.push(("group_id", Param::Str(g.id.clone())));
            params.push(("group_placement", Param::Str("top".to_string())));
        }
        self.cmux("workspace.create", params);
    }

    fn open_label(&self, k: &str) -> String {
        format!("New session in {}", self.project_by_key(k).name)
    }

    /// The card menu's new session label: a project with no folder says why.
    pub fn new_session_label(&self, w: Option<&Workspace>) -> String {
        match w {
            Some(w) => self.project_new_label(&self.project_key(w)),
            None => "New session (no workspace)".to_string(),
        }
    }

    /// Opens a new session in the card's project folder, in the first
    /// lane, a no-op without one.
    pub fn new_session_for(&mut self, data: &Data, w: Option<&Workspace>) {
        if let Some(w) = w {
            let k = self.project_key(w);
            let first = self.lanes.first().clone();
            self.open_project_workspace(data, &k, Some(first));
        }
    }

    /// A project menu's first item: what it opens, or why it opens nothing.
    pub fn project_new_label(&self, k: &str) -> String {
        if self.can_open_project(k) {
            self.open_label(k)
        } else {
            "New session (project has no folder)".to_string()
        }
    }

    /// A quiet row's label: what a tap does, or why it does nothing.
    pub fn quiet_label(&self, k: &str) -> String {
        if self.can_open_project(k) {
            self.open_label(k)
        } else {
            format!("{} has no folder to open", self.project_by_key(k).name)
        }
    }

    /// Configured projects with no sessions, in table order. A project
    /// whose only sessions wait in Needs you is not quiet.
    pub fn quiet_projects(&mut self, data: &Data) -> Vec<String> {
        let busy: Vec<String> = self
            .card_workspaces(data)
            .into_iter()
            .map(|w| self.project_key(w))
            .collect();
        self.projects
            .iter()
            .map(|p| p.id().to_string())
            .filter(|k| !busy.contains(k) && !self.is_removed_project(k))
            .collect()
    }

    /// The cards grouped by project key, in one pass.
    fn cards_by_project<'d>(&mut self, data: &'d Data) -> IndexMap<String, Vec<&'d Workspace>> {
        let mut groups: IndexMap<String, Vec<&'d Workspace>> = IndexMap::new();
        for w in self.card_workspaces(data) {
            groups.entry(self.project_key(w)).or_default().push(w);
        }
        groups
    }

    /// The open editor, under its project's header or quiet row.
    fn push_editor(&self, entries: &mut Vec<ProjectEntry>, k: &str) {
        if self.editing_project() == Some(k) {
            entries.push(ProjectEntry::Editor {
                id: format!("e:{k}"),
                project: k.to_string(),
            });
        }
    }

    /// A project's header, its editor, then its cards. A card waiting on
    /// Jon stays in its place and says so itself (issue #281).
    fn push_group(&self, entries: &mut Vec<ProjectEntry>, k: &str, rows: &[&Workspace]) {
        entries.push(ProjectEntry::Header {
            id: format!("p:{k}"),
            project: k.to_string(),
        });
        self.push_editor(entries, k);
        if self.is_project_collapsed(k) {
            return;
        }
        for w in rows {
            let ws_id = w.id.clone();
            entries.push(ProjectEntry::Ws {
                id: format!("{ws_id}@p"),
                ws_id,
            });
        }
    }

    /// The Projects view's rows: each busy project in table order, then
    /// Other once something falls into it, "+ New project", then the quiet
    /// projects under one header. A project removed before the rebuild
    /// loses its header at once; its cards wait in Other.
    pub fn project_entries(&mut self, data: &Data) -> Vec<ProjectEntry> {
        let groups = self.cards_by_project(data);
        let keys: Vec<String> = self.projects.iter().map(|p| p.id().to_string()).collect();
        let gone: Vec<&String> = keys.iter().filter(|k| self.is_removed_project(k)).collect();
        let mut entries = Vec::new();
        for k in &keys {
            if let Some(rows) = groups.get(k)
                && !gone.contains(&k)
            {
                self.push_group(&mut entries, k, rows);
            }
        }
        let other_keys = std::iter::once(OTHER_KEY).chain(gone.iter().map(|k| k.as_str()));
        let other: Vec<&Workspace> = other_keys
            .clone()
            .flat_map(|k| groups.get(k).into_iter().flatten().copied())
            .collect();
        if other_keys.into_iter().any(|k| groups.contains_key(k)) {
            self.push_group(&mut entries, OTHER_KEY, &other);
        }
        entries.push(ProjectEntry::NewRow { id: "new".into() });
        self.push_editor(&mut entries, NEW_PROJECT);
        let quiet = self.quiet_projects(data);
        if quiet.is_empty() {
            return entries;
        }
        // Ids outside the "p:" space, so a project matching "quiet" cannot clash.
        entries.push(ProjectEntry::QuietHeader { id: "quiet".into() });
        if self.quiet_collapsed() {
            return entries;
        }
        for k in &quiet {
            entries.push(ProjectEntry::QuietRow {
                id: format!("q:{k}"),
                project: k.clone(),
            });
            self.push_editor(&mut entries, k);
        }
        entries
    }
}

/// A persisted value for a removed project from projects.json.
#[cfg(test)]
fn removed() -> serde_json::Value {
    serde_json::json!({ "removed": true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::SavedState;

    fn table() -> Vec<Project> {
        serde_json::from_str(
            r##"[{"match": "/dev/app", "name": "App", "color": "#000000", "icon": "x", "root": "/r/app", "seeded": true}]"##,
        )
        .unwrap()
    }

    #[test]
    fn keeps_what_it_sent_across_a_new_state_file() {
        let mut s = Session::new(table(), SavedState::default());
        s.set_editing_project(Some(NEW_PROJECT));
        s.remove_project("/dev/app");
        s.reseed(SavedState::default());
        assert_eq!(s.editing_project(), Some(NEW_PROJECT));
        assert!(s.is_removed_project("/dev/app"));
        assert_eq!(s.spec_of("/dev/app"), None);
    }

    #[test]
    fn opens_a_folder_once_whatever_its_case_or_trailing_slash() {
        let mut s = Session::new(table(), SavedState::default());
        let data: Data = serde_json::from_str(
            r#"{"epoch": 1, "workspaces": [{"id": "w", "directory": "/Users/X/dev/App/"}]}"#,
        )
        .unwrap();
        s.open_folder_once(&data, "/users/x/dev/app");
        assert!(s.take_outbox().is_empty(), "one is open there already");
        s.open_folder_once(&data, "/users/x/dev/other");
        let out = s.take_outbox();
        assert!(
            matches!(out.as_slice(), [crate::session::Outbound::Cmux { method, .. }] if method == "workspace.create"),
            "{out:?}"
        );
    }

    #[test]
    fn forgets_what_it_sent_once_a_rebuild_brings_a_new_table() {
        let mut s = Session::new(table(), SavedState::default());
        s.remove_project("/dev/app");
        assert!(s.is_removed_project("/dev/app"));
        s.set_projects(table());
        assert!(!s.is_removed_project("/dev/app"));
        assert!(s.spec_of("/dev/app").is_some());
    }

    #[test]
    fn saves_a_seeded_project_as_removed() {
        let mut s = Session::new(table(), SavedState::default());
        s.remove_project("/dev/app");
        let last = s.take_outbox().pop();
        assert_eq!(
            last,
            Some(crate::session::Outbound::Persist {
                key: "projects./dev/app".into(),
                value: Some(removed()),
            })
        );
        s.remove_project("/dev/app");
        assert!(s.take_outbox().is_empty(), "removed once");
    }
}
