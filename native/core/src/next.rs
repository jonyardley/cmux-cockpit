//! Next and its Needs you pill's way back to a card (src/cockpit/next.ts):
//! where a session came from, the Next queue and its "1 of N", and
//! revealing a card by unfolding what hides it.

use std::cmp::Ordering;

use crate::data::{Data, Workspace};
use crate::lanes::lane_by_key;
use crate::persist::ViewMode;
use crate::session::{LastJump, Session};
use crate::theme::Token;
use crate::time::finished_at;

/// A colour the logic picks: a theme token, or a project's own hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Colour {
    Token(Token),
    Hex(String),
}

/// Where a session came from: its lane, or its project group in Projects view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub name: String,
    pub color: Colour,
}

/// Where the next press of Next goes.
#[derive(Debug, Clone, PartialEq)]
pub struct NextStep<'d> {
    pub target: &'d Workspace,
    /// 1-based, for "1 of 6".
    pub position: usize,
    pub total: usize,
}

impl Session {
    /// Where a session came from: its lane and marker, or its project
    /// group in Projects view. A lane's generated anchor is in no
    /// project group, so it names its lane in both views.
    pub fn origin_of(&mut self, data: &Data, w: Option<&Workspace>) -> Origin {
        let Some(w) = w else {
            return Origin {
                name: String::new(),
                color: Colour::Token(Token::Clear),
            };
        };
        if self.projects_mode() && !self.lane_anchor_ids(data).contains(&w.id) {
            let p = self.project_of_workspace(Some(w));
            return Origin {
                name: p.name,
                color: Colour::Hex(p.color),
            };
        }
        let lane = lane_by_key(self.lane_of(data, w));
        Origin {
            name: lane.name.to_string(),
            color: Colour::Token(lane.color),
        }
    }

    /// Ready workspaces, longest finished first, dated as the Ready card
    /// dates them (issue #98), ties in tab order.
    fn ready_by_finish<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        let mut ready: Vec<(f64, &Workspace)> = Vec::new();
        for w in self.all_workspaces(data) {
            if let Some(a) = self.ready_agent(data, Some(w)) {
                ready.push((finished_at(&a), w));
            }
        }
        // A stable sort, as Array.prototype.sort is.
        ready.sort_by(|(x, _), (y, _)| x.partial_cmp(y).unwrap_or(Ordering::Equal));
        ready.into_iter().map(|(_, w)| w).collect()
    }

    /// What the Next button walks through: needs you, then Ready, each
    /// longest waiting first.
    pub fn next_queue<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        let needs = self.needs_list(data);
        self.next_queue_after(data, needs)
    }

    /// The queue from a Needs you list already built this frame.
    pub fn next_queue_after<'d>(
        &mut self,
        data: &'d Data,
        mut needs: Vec<&'d Workspace>,
    ) -> Vec<&'d Workspace> {
        needs.extend(self.ready_by_finish(data));
        needs
    }

    /// Each press moves on from where Jon is: after the selected workspace
    /// when it is in the queue; after the one Next last opened when that
    /// has dropped out and he is still on it; else from the top.
    fn next_index(&mut self, data: &Data, queue: &[&Workspace]) -> usize {
        let len = queue.len().max(1);
        let mut on = None;
        for (i, w) in queue.iter().enumerate() {
            if self.is_selected(data, Some(w)) {
                on = Some(i);
                break;
            }
        }
        if let Some(on) = on {
            return (on + 1) % len;
        }
        if let Some(last) = self.last_jump.clone()
            && !self.is_selected(data, data.ws_by_id(&last.id))
        {
            self.last_jump = None;
        }
        let Some(last) = &self.last_jump else {
            return 0;
        };
        let after = last
            .after_id
            .as_deref()
            .and_then(|id| queue.iter().position(|w| w.id == id));
        after.unwrap_or(last.index % len)
    }

    /// Where the next press goes, or None when nothing needs Jon or is
    /// Ready, or the only one waiting is the one Jon is on.
    pub fn next_step<'d>(&mut self, data: &'d Data) -> Option<NextStep<'d>> {
        let queue = self.next_queue(data);
        self.next_step_in(data, &queue)
    }

    /// Where the next press goes in a queue already built this frame.
    pub fn next_step_in<'d>(
        &mut self,
        data: &Data,
        queue: &[&'d Workspace],
    ) -> Option<NextStep<'d>> {
        if queue.is_empty() {
            return None;
        }
        let i = self.next_index(data, queue);
        let target = *queue.get(i)?;
        if self.is_selected(data, Some(target)) {
            return None;
        }
        Some(NextStep {
            target,
            position: i + 1,
            total: queue.len(),
        })
    }

    /// The Next button: selects the next workspace in the queue.
    pub fn jump_next(&mut self, data: &Data) {
        let queue = self.next_queue(data);
        let Some(step) = self.next_step_in(data, &queue) else {
            return;
        };
        self.last_jump = Some(LastJump {
            id: step.target.id.clone(),
            index: step.position - 1,
            after_id: queue.get(step.position).map(|w| w.id.clone()),
        });
        self.reveal_workspace(data, Some(step.target));
    }

    /// Selects a workspace from Next or its Needs you pill, first
    /// unfolding what hides its card in the chosen view: its lane in All,
    /// its project in Projects. A lane's generated anchor has no card; its status sits on
    /// the lane header, which shows only in All, so Projects switches to All.
    pub fn reveal_workspace(&mut self, data: &Data, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        if self.lane_anchor_ids(data).contains(&w.id) {
            self.choose_mode(ViewMode::All);
        } else {
            self.unfold_card_of(data, w);
        }
        self.select_workspace(data, Some(&w.id));
    }

    fn unfold_card_of(&mut self, data: &Data, w: &Workspace) {
        if self.is_mode(ViewMode::All) {
            let lane = lane_by_key(self.lane_of(data, w));
            if self.is_collapsed(data, &lane) {
                self.toggle_lane(data, &lane);
            }
            return;
        }
        let k = self.project_key(w);
        if self.is_project_collapsed(&k) {
            self.toggle_project(data, &k);
        }
    }
}
