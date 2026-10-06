//! The cockpit's author state (src/cockpit/state.ts): the view, the folds
//! it keeps itself, and the selection applied at once. Session::new seeds
//! them from the saved state; model.rs saves them.

use crate::data::{Data, Workspace};
use crate::persist::ViewMode;
use crate::session::Session;
use crate::time::now_epoch;

/// How long an optimistic override holds before cmux's own data wins.
pub const OVERRIDE_SECS: f64 = 4.0;

/// A card being dragged: its row's key (`w:<wsId>`) and the slot it is over.
#[derive(Debug, Clone, PartialEq)]
pub struct DragState {
    pub id: String,
    pub index: f64,
}

impl Session {
    /// The chosen view.
    pub fn mode(&self) -> ViewMode {
        self.mode
    }

    pub fn set_mode(&mut self, m: ViewMode) {
        self.mode = m;
    }

    /// Whether `m` is the chosen view.
    pub fn is_mode(&self, m: ViewMode) -> bool {
        self.mode == m
    }

    pub fn projects_mode(&self) -> bool {
        self.is_mode(ViewMode::Projects)
    }

    pub fn unsorted_collapsed(&self) -> bool {
        self.unsorted_collapsed
    }

    pub fn set_unsorted_collapsed(&mut self, v: bool) {
        self.unsorted_collapsed = v;
    }

    pub fn quiet_collapsed(&self) -> bool {
        self.quiet_collapsed
    }

    pub fn set_quiet_collapsed(&mut self, v: bool) {
        self.quiet_collapsed = v;
    }

    /// The drag under way, if any.
    pub fn drag(&self) -> Option<&DragState> {
        self.drag.as_ref()
    }

    pub fn set_drag(&mut self, d: Option<DragState>) {
        self.drag = d;
    }

    /// The folded projects' keys.
    pub fn collapsed_projects(&self) -> &[String] {
        &self.collapsed_projects
    }

    pub fn set_collapsed_projects(&mut self, keys: Vec<String>) {
        self.collapsed_projects = keys;
    }

    /// Whether the project with this key is folded.
    pub fn is_project_collapsed(&self, k: &str) -> bool {
        self.collapsed_projects.iter().any(|x| x == k)
    }

    /// Whether the workspace is selected: a tapped card reads as selected
    /// the same frame, until cmux publishes the change or OVERRIDE_SECS
    /// pass, so a select cmux refused cannot pin the highlight.
    pub fn is_selected(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        if let Some((id, at)) = &self.select_override {
            let published = data.selected_id.as_deref() == Some(id.as_str());
            if published || now_epoch(data) - at > OVERRIDE_SECS {
                self.select_override = None;
            } else {
                return w.id == *id;
            }
        }
        w.selected == Some(true)
    }

    /// Selects a workspace, showing it selected at once.
    pub fn select_workspace(&mut self, data: &Data, id: Option<&str>) {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return;
        };
        self.mark_selected(data, id);
        self.cmux(
            "workspace.select",
            vec![("workspace_id", crate::session::Param::Str(id.to_string()))],
        );
    }

    /// Shows a workspace selected at once that the shell has already asked
    /// cmux to select itself (the sidebar's SDK select), with no cmux call
    /// of its own. It lapses as a select through the core does.
    pub fn mark_selected(&mut self, data: &Data, id: &str) {
        if id.is_empty() {
            return;
        }
        self.select_override = Some((id.to_string(), now_epoch(data)));
    }
}
