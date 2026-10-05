//! Drag and drop in All's flat list (src/cockpit/drop.ts), and the pane's
//! card move built on it.
//!
//! A drop resolves the target lane from the row above the slot, then asks
//! cmux for `workspace.reorder` and `workspace.group.add` (or
//! `workspace.group.remove` for Unsorted). A lane and its order live in
//! cmux's groups and tab order, so a move writes nothing to
//! config/state.json.

use crate::data::{Data, Workspace};
use crate::lane_entries::LaneEntry;
use crate::lanes::{FIRST_LANE, LaneKey, lane_by_key};
use crate::model::{actual_lane_of, group_for_lane};
use crate::persist::ViewMode;
use crate::session::{Param, Session};

/// Where a drop lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DropTarget {
    pub lane: LaneKey,
    /// The card that will sit below the dropped one, in the same lane.
    pub next_ref: Option<String>,
    /// The card that will sit above it, in any lane.
    pub prev_ref: Option<String>,
}

/// A card's or a placeholder's workspace: a placeholder stands for a real
/// tab in its lane, so it anchors a drop as a card does.
fn tab_of(e: Option<&LaneEntry>) -> Option<(&str, LaneKey)> {
    match e? {
        LaneEntry::Ws { ws_id, lane, .. } | LaneEntry::Ghost { ws_id, lane, .. } => {
            Some((ws_id, *lane))
        }
        _ => None,
    }
}

/// Whether the workspace anchors a group other than a lane's generated
/// anchor. The anchor IS that group in cmux, so it cannot leave it; the
/// sidebar keeps its card undraggable, and the pane refuses its move.
pub fn is_foreign_anchor(s: &Session, data: &Data, ws_id: &str) -> bool {
    let lanes = s.lane_anchor_ids(data);
    data.group_list()
        .iter()
        .any(|g| g.anchor_id.as_deref() == Some(ws_id) && !lanes.contains(ws_id))
}

/// The tab index a dropped workspace should move to among the others, or
/// None to leave its position alone.
fn target_index(
    data: &Data,
    w: &Workspace,
    others: &[String],
    drop: &DropTarget,
    changes_lane: bool,
) -> Option<usize> {
    let index_of = |id: &str| others.iter().position(|x| x == id);
    if let Some(next) = &drop.next_ref {
        return index_of(next);
    }
    if let Some(prev) = &drop.prev_ref {
        return index_of(prev).map(|p| p + 1);
    }
    // Dropped straight under a header (an empty lane, say): land after the
    // group's last member, else after its anchor. cmux keeps a group as one
    // contiguous run of tabs, and its lane order differs from ours, so a
    // card left sitting before the anchor falls into the group above it.
    if !changes_lane {
        return None;
    }
    let g = group_for_lane(data, &lane_by_key(drop.lane))?;
    let last = data.workspace_list().iter().rfind(|x| {
        x.id != w.id
            && (x.group.as_deref() == Some(g.id.as_str())
                || g.anchor_id.as_deref() == Some(x.id.as_str()))
    })?;
    index_of(&last.id).map(|p| p + 1)
}

impl Session {
    /// All's rows without the dragged one, the slot clamped into them, and
    /// the lane of the row above it (the first lane above every row).
    fn slot_of(
        &mut self,
        data: &Data,
        key: &str,
        index: usize,
    ) -> (Vec<LaneEntry>, usize, LaneKey) {
        let entries: Vec<LaneEntry> = self
            .lane_entries(data)
            .into_iter()
            .filter(|e| e.id() != key)
            .collect();
        let at = index.min(entries.len());
        let lane = at
            .checked_sub(1)
            .and_then(|i| entries.get(i))
            .map_or(FIRST_LANE, LaneEntry::lane);
        (entries, at, lane)
    }

    /// Where a drop of the row `key` at `index` (its slot in the flat list
    /// with the row removed) lands. Cards sort by state inside a lane, and
    /// the drag order only holds among cards in the same state, so a drop
    /// anchors to the nearest card in the dragged card's own state: just
    /// before the first one below the slot, else just after the last one
    /// above it. With no peer in the lane it falls back to the neighbours:
    /// before the card below, else after the card above.
    pub fn resolve_drop(&mut self, data: &Data, key: &str, index: usize) -> DropTarget {
        let (entries, at, lane) = self.slot_of(data, key, index);
        let dragged = self.lane_entries(data).into_iter().find(|e| e.id() == key);
        // Above every row the slot is outside any lane, so it keeps the header rule below.
        let rank = match &dragged {
            Some(LaneEntry::Ws { ws_id, .. }) if at > 0 => {
                Some(self.state_rank(data, data.ws_by_id(ws_id)))
            }
            _ => None,
        };
        let peer = |s: &mut Session, e: &LaneEntry| match (tab_of(Some(e)), rank) {
            (Some((ws_id, l)), Some(r)) if l == lane => {
                s.state_rank(data, data.ws_by_id(ws_id)) == r
            }
            _ => false,
        };
        let below = entries[at..]
            .iter()
            .find(|e| peer(self, e))
            .and_then(|e| tab_of(Some(e)));
        if let Some((id, _)) = below {
            return DropTarget {
                lane,
                next_ref: Some(id.to_string()),
                prev_ref: None,
            };
        }
        let above = entries[..at]
            .iter()
            .filter(|e| peer(self, e))
            .last()
            .and_then(|e| tab_of(Some(e)));
        if let Some((id, _)) = above {
            return DropTarget {
                lane,
                next_ref: None,
                prev_ref: Some(id.to_string()),
            };
        }
        let prev = at.checked_sub(1).and_then(|i| entries.get(i));
        let next_ref = tab_of(entries.get(at))
            .filter(|(_, l)| *l == lane)
            .map(|(id, _)| id.to_string());
        let prev_ref = tab_of(prev).map(|(id, _)| id.to_string());
        DropTarget {
            lane,
            next_ref,
            prev_ref,
        }
    }

    /// Reorderable's onMove: reorders the tab, then files it into its new
    /// lane. Clears the drag; does nothing outside All, where the lanes
    /// stay mounted but hidden.
    pub fn handle_move(&mut self, data: &Data, key: &str, index: usize) {
        self.drag = None;
        if !self.is_mode(ViewMode::All) {
            return;
        }
        let entries = self.lane_entries(data);
        let Some(LaneEntry::Ws { ws_id, .. }) = entries.iter().find(|e| e.id() == key) else {
            return;
        };
        let Some(w) = data.ws_by_id(ws_id) else {
            return;
        };
        let target = self.resolve_drop(data, key, index);
        // Against the lane on screen, so dragging a card back out of a lane
        // it is still waiting to join cancels that move.
        let changes_lane = self.lane_of(data, w) != target.lane;
        let others: Vec<String> = data
            .workspace_list()
            .iter()
            .map(|x| x.id.clone())
            .filter(|id| *id != w.id)
            .collect();
        // Position first, then membership, so the tab is already inside the
        // group's run when it joins.
        if let Some(at) = target_index(data, w, &others, &target, changes_lane) {
            let mut order = others;
            order.insert(at, w.id.clone());
            self.override_order(data, order);
            self.cmux(
                "workspace.reorder",
                vec![
                    ("workspace_id", Param::Str(w.id.clone())),
                    ("index", Param::Num(at as f64)),
                ],
            );
        }
        if changes_lane {
            self.move_to_lane(data, Some(w), target.lane);
        }
    }

    /// The pane's move: the card `id` lands in `lane` just above the card
    /// `before`, or at the end of the lane when that is None or not in it.
    /// It goes through the sidebar's drop, at the slot that position is,
    /// so the same peer rule places it. Its lane and order then hold until
    /// cmux's data stops showing the card where it was, with no timer, so
    /// a slow cmux never snaps the card back.
    pub fn move_card(&mut self, data: &Data, id: &str, lane: LaneKey, before: Option<&str>) {
        if is_foreign_anchor(self, data, id) {
            return;
        }
        let key = format!("w:{id}");
        let (entries, _, _) = self.slot_of(data, &key, 0);
        let above = |b: &str| {
            entries
                .iter()
                .position(|e| tab_of(Some(e)).is_some_and(|(ws, l)| ws == b && l == lane))
        };
        let index = before.and_then(above).or_else(|| {
            entries
                .iter()
                .rposition(|e| e.lane() == lane)
                .map(|i| i + 1)
        });
        let Some(index) = index else { return };
        let from = actual_lane_of(data, data.ws_by_id(id));
        let base: Vec<String> = data.workspace_list().iter().map(|w| w.id.clone()).collect();
        let lane_before = self.lane_override.get(id).copied();
        let order_before = self.order_override.clone();
        self.handle_move(data, &key, index);
        if let Some(o) = self.lane_override.get_mut(id)
            && Some(*o) != lane_before
        {
            o.held_from = Some(from);
        }
        if let Some(o) = self.order_override.as_mut()
            && Some(&*o) != order_before.as_ref()
        {
            o.held_base = Some(base);
        }
    }
}
