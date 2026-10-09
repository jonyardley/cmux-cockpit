//! The cockpit's author state (src/cockpit/state.ts): the view, the folds
//! it keeps itself, and the selection applied at once. Session::new seeds
//! them from the saved state; model.rs saves them.

use crate::data::{Data, Workspace};
use crate::persist::ViewMode;
use crate::session::Session;
use crate::time::now_epoch;

/// How long an optimistic override holds before cmux's own data wins.
pub const OVERRIDE_SECS: f64 = 4.0;

/// A tapped card shown selected before cmux publishes the change.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SelectOverride {
    /// The workspace tapped.
    pub(crate) id: String,
    /// When, in epoch seconds: it lapses OVERRIDE_SECS later.
    pub(crate) at: f64,
    /// The selections cmux may still publish without that meaning it went
    /// elsewhere: the one it showed at the first tap, and each card tapped
    /// since while this was held. Any other means cmux (or Jon in cmux)
    /// chose another workspace, and the override gives way at once. A
    /// frame with no selection says nothing either way (issue #7).
    pub(crate) stale: Vec<String>,
}

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
    /// the same frame, until cmux publishes the change, publishes some
    /// other selection, refuses the select (`select_failed`) or
    /// OVERRIDE_SECS pass, so the highlight is never left on a card cmux
    /// did not select.
    pub fn is_selected(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        if let Some(o) = &self.select_override {
            let published = data.selected_id.as_deref() == Some(o.id.as_str());
            let elsewhere = data
                .selected_id
                .as_ref()
                .is_some_and(|id| !o.stale.contains(id));
            if published || elsewhere || now_epoch(data) - o.at > OVERRIDE_SECS {
                self.select_override = None;
            } else {
                return w.id == o.id;
            }
        }
        w.selected == Some(true)
    }

    /// A cmux call about this workspace failed: a select of it shows what
    /// cmux has selected again, rather than holding the tap until it lapses.
    pub(crate) fn select_failed(&mut self, ws_id: &str) {
        if self.select_override.as_ref().is_some_and(|o| o.id == ws_id) {
            self.select_override = None;
        }
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
        let mut stale = match self.select_override.take() {
            Some(held) => {
                let mut stale = held.stale;
                stale.push(held.id);
                stale
            }
            None => Vec::new(),
        };
        if let Some(was) = &data.selected_id
            && !stale.contains(was)
        {
            stale.push(was.clone());
        }
        self.select_override = Some(SelectOverride {
            id: id.to_string(),
            at: now_epoch(data),
            stale,
        });
    }
}
