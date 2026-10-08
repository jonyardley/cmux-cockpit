//! Merged PRs (src/cockpit/merged.ts): once a workspace's PR merges, its
//! card dims while nothing in it wants Jon. Nothing moves or closes the
//! card by itself; filing it away is a lane move, and removing the
//! worktree stays in the close-out command.

use crate::data::Workspace;
use crate::prs::{is_merged_pr, pr_of};
use crate::session::Session;
use crate::status::Status;

/// How faint a merged card sits while nothing in it wants Jon.
pub const MERGED_OPACITY: f64 = 0.6;

impl Session {
    /// The card's PR has merged, by the rule its chip reads.
    pub fn is_merged(&self, w: Option<&Workspace>) -> bool {
        w.is_some() && is_merged_pr(pr_of(&self.saved, w).as_deref())
    }

    /// An agent working or asking: the card still wants Jon.
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
}
