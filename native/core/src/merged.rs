//! Merged PRs offer their own tidy-up (src/cockpit/merged.ts): once a
//! workspace's PR merges, its card dims and offers Park, which files it
//! into Parked; Close, which closes the workspace through the socket; and,
//! in the card menu, Keep, which stops the offer for that PR for good.
//! Nothing moves the card by itself. Keep is saved (`mergeKept.<ws>`, the
//! kept PR's number), so a later PR in the same workspace offers the
//! buttons again.

use crate::data::{Data, Workspace};
use crate::js::{json_num, truthy};
use crate::lanes::LaneKey;
use crate::model::is_anchor;
use crate::prs::{is_merged_pr, pr_of};
use crate::session::{Param, Session};
use crate::status::Status;

/// How faint a merged card sits while nothing in it wants Jon.
pub const MERGED_OPACITY: f64 = 0.6;

impl Session {
    /// The card's PR has merged, by the rule its chip reads.
    pub fn is_merged(&self, w: Option<&Workspace>) -> bool {
        w.is_some() && is_merged_pr(pr_of(&self.saved, w).as_deref())
    }

    /// Keep was tapped for the PR the card shows now.
    fn is_kept(&self, w: &Workspace) -> bool {
        let number = pr_of(&self.saved, Some(w)).and_then(|p| p.number);
        self.saved
            .merge_kept
            .get(&w.id)
            .is_some_and(|at| Some(*at) == number)
    }

    /// An agent working or asking: one tap must never kill it.
    fn is_live(&mut self, w: &Workspace) -> bool {
        matches!(
            self.status_of(Some(w)),
            Status::Working | Status::NeedsInput
        )
    }

    /// Dimmed when merged, but at full strength while lit (selected or
    /// dragged) or while an agent works or asks or there is unread output.
    pub fn card_opacity(&mut self, w: Option<&Workspace>, lit: bool) -> f64 {
        let Some(w) = w else { return 1.0 };
        let wants_jon = self.is_live(w) || w.unread.unwrap_or(0.0) > 0.0;
        if self.is_merged(Some(w)) && !lit && !wants_jon {
            MERGED_OPACITY
        } else {
            1.0
        }
    }

    /// A merged card offers Keep until Keep is tapped for that PR. Never on
    /// a group's anchor (closing it would take the lane) or a pinned
    /// workspace (cmux refuses to close one while pinned).
    pub fn offers_merged_actions(&self, data: &Data, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        self.is_merged(Some(w)) && !self.is_kept(w) && !is_anchor(data, w) && w.pinned != Some(true)
    }

    /// Close is offered only while no agent there is working or asking.
    pub fn offers_close(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        self.offers_merged_actions(data, Some(w)) && !self.is_live(w)
    }

    /// Park shows on a merged card until it is in Parked or Keep is
    /// tapped. A pinned workspace offers it alone: parking closes nothing.
    pub fn offers_park(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        self.is_merged(Some(w))
            && !self.is_kept(w)
            && !is_anchor(data, w)
            && self.lane_of(data, w) != LaneKey::Parked
    }

    /// Park or Close shows, so the card has a merged button to lay out.
    pub fn offers_merged_chip(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        self.offers_park(data, w) || self.offers_close(data, w)
    }

    /// Files a merged card into Parked.
    pub fn park_merged(&mut self, data: &Data, w: Option<&Workspace>) {
        if self.offers_park(data, w) {
            self.move_to_lane(data, w, LaneKey::Parked);
        }
    }

    /// The merged buttons on the card now, in words: "Park and Close",
    /// "Park" or "".
    fn shown_buttons(&mut self, data: &Data, w: Option<&Workspace>) -> String {
        let mut shown = Vec::new();
        if self.offers_park(data, w) {
            shown.push("Park");
        }
        if self.offers_close(data, w) {
            shown.push("Close");
        }
        shown.join(" and ")
    }

    /// The card menu's Keep item, named by what tapping it would do.
    pub fn keep_label(&mut self, data: &Data, w: Option<&Workspace>) -> String {
        let shown = self.shown_buttons(data, w);
        if !shown.is_empty() {
            return format!("Keep, hide {shown}");
        }
        match w {
            Some(w) if self.is_merged(Some(w)) && self.is_kept(w) => {
                "Kept, Park and Close hidden".to_string()
            }
            _ => "Keep: for a merged PR's buttons".to_string(),
        }
    }

    /// Hides a merged card's buttons for this PR; the card stays dimmed.
    pub fn keep_merged(&mut self, data: &Data, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        let Some(number) = truthy(pr_of(&self.saved, Some(w)).and_then(|p| p.number)) else {
            return;
        };
        if !self.offers_merged_chip(data, Some(w)) {
            return;
        }
        self.saved.merge_kept.insert(w.id.clone(), number);
        self.persist_set(format!("mergeKept.{}", w.id), Some(json_num(number)));
    }

    /// Closes a merged card's workspace; the worktree stays for the
    /// close-out command.
    pub fn close_merged(&mut self, data: &Data, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        if self.offers_close(data, Some(w)) {
            self.cmux(
                "workspace.close",
                vec![("workspace_id", Param::Str(w.id.clone()))],
            );
        }
    }
}
