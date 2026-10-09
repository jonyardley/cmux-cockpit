//! Workspaces as the cockpit sees them (src/cockpit/model.ts): which lane
//! each is in, tab order, lane folds and the view mode. Needs you,
//! All's lane entries, the Projects view, Next and the card chips build on
//! this, in their own modules.
//!
//! Optimistic overrides apply at once, then clear once the data agrees or
//! after OVERRIDE_SECS, so a normalised result from the app wins.

use std::cmp::Ordering;

use indexmap::IndexSet;
use serde_json::{Map, Value};

use crate::anchors::is_generated_anchor;
use crate::data::{Data, Workspace, WorkspaceGroup};
use crate::js::num_text;
use crate::lanes::{Density, Lane, LaneKey, Lanes};
use crate::persist::ViewMode;
use crate::projects::{OTHER_KEY, is_project_key};
use crate::session::{LaneMove, OrderMove, PROJECT_FOLD, Param, Session};
use crate::state::OVERRIDE_SECS;
use crate::time::now_epoch;

/// How long a move into a lane whose group is being made holds its lane.
pub const CREATE_SECS: f64 = 30.0;

/// The group a lane matches by name; none for Unsorted.
pub fn group_for_lane<'d>(data: &'d Data, lane: &Lane) -> Option<&'d WorkspaceGroup> {
    if lane.key.is_unsorted() {
        return None;
    }
    data.group_list()
        .iter()
        .find(|g| g.name.as_deref() == Some(lane.name.as_str()))
}

/// A workspace anchoring a group: it cannot leave it, and closing it would take the lane.
pub fn is_anchor(data: &Data, w: &Workspace) -> bool {
    data.group_list()
        .iter()
        .any(|g| g.anchor_id.as_deref() == Some(w.id.as_str()))
}

/// The lane group's generated anchor, if it has one. A workspace not in the
/// data yet counts, so it never flashes up as a card when it arrives.
pub fn generated_anchor_id(data: &Data, lane: &Lane) -> Option<String> {
    let g = group_for_lane(data, lane)?;
    let anchor = g.anchor_id.as_deref().filter(|a| !a.is_empty())?;
    is_generated_anchor(g, data.ws_by_id(anchor)).then(|| anchor.to_string())
}

/// The lane by cmux's data alone, without a pending move.
pub fn actual_lane_of(lanes: &Lanes, data: &Data, w: Option<&Workspace>) -> LaneKey {
    let Some(group) = w.and_then(Workspace::group_id) else {
        return LaneKey::unsorted();
    };
    lanes
        .groups()
        .iter()
        .find(|lane| group_for_lane(data, lane).is_some_and(|g| g.id == group))
        .map_or_else(LaneKey::unsorted, |lane| lane.key.clone())
}

/// How big a card draws: by its lane in cmux's own data, so a drop moves
/// the card at once but resizes it only when cmux catches up.
pub fn card_density(lanes: &Lanes, data: &Data, w: Option<&Workspace>) -> Density {
    lanes.get(&actual_lane_of(lanes, data, w)).density
}

/// How the chosen and hidden view panels size themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelHeight {
    /// Unbounded: the chosen panel.
    Infinity,
    /// Zero: the hidden one.
    Zero,
}

fn expired(o: &LaneMove, now: f64) -> bool {
    now - o.at
        > if o.awaiting {
            CREATE_SECS
        } else {
            OVERRIDE_SECS
        }
}

/// Whether cmux has the workspaces in `order` in that order. One that came
/// or went since does not count.
fn same_order(ws: &[&Workspace], order: &[String]) -> bool {
    let now: Vec<&str> = ws
        .iter()
        .map(|w| w.id.as_str())
        .filter(|id| order.iter().any(|b| b == id))
        .collect();
    let then: Vec<&str> = order
        .iter()
        .map(String::as_str)
        .filter(|id| ws.iter().any(|w| w.id == *id))
        .collect();
    now == then
}

/// The tab index, among the other tabs, just after the group's last member.
fn index_after_group(data: &Data, ws_id: &str, g: &WorkspaceGroup) -> Option<usize> {
    let others: Vec<&Workspace> = data
        .workspace_list()
        .iter()
        .filter(|x| x.id != ws_id)
        .collect();
    others
        .iter()
        .rposition(|x| {
            x.group.as_deref() == Some(g.id.as_str())
                || g.anchor_id.as_deref() == Some(x.id.as_str())
        })
        .map(|i| i + 1)
}

impl Session {
    fn awaiting_lane(&self, key: &LaneKey, now: f64) -> bool {
        self.lane_override
            .values()
            .any(|o| o.awaiting && &o.lane == key && !expired(o, now))
    }

    /// Each lane group's generated anchor, which is not a real card, plus
    /// any workspace that looks like the anchor of a lane whose group is on
    /// its way. In lane order, each once.
    pub fn lane_anchor_ids(&self, data: &Data) -> IndexSet<String> {
        let now = now_epoch(data);
        let mut out: IndexSet<String> = IndexSet::new();
        for lane in self.lanes.groups() {
            if let Some(id) = generated_anchor_id(data, lane) {
                out.insert(id);
            } else if group_for_lane(data, lane).is_none() && self.awaiting_lane(&lane.key, now) {
                // cmux can publish a new group's anchor a frame before the
                // group, so an ungrouped workspace that looks like it hides.
                let name = lane.name.trim().to_lowercase();
                for w in data.workspace_list() {
                    let title = w.title.as_deref().unwrap_or_default().trim().to_lowercase();
                    if w.group_id().is_none() && w.agent_slots() == 0 && title == name {
                        out.insert(w.id.clone());
                    }
                }
            }
        }
        out
    }

    /// The lane a workspace shows in: a pending move's, until the data
    /// agrees or the move expires, else cmux's.
    pub fn lane_of(&mut self, data: &Data, w: &Workspace) -> LaneKey {
        let actual = actual_lane_of(&self.lanes, data, Some(w));
        let now = now_epoch(data);
        if let Some(o) = self.lane_override.get(&w.id).cloned() {
            let done = match &o.held_from {
                Some(from) => {
                    actual == o.lane || !from.contains(&actual) || (o.awaiting && expired(&o, now))
                }
                None => o.lane == actual || expired(&o, now),
            };
            if done {
                self.lane_override.shift_remove(&w.id);
            } else {
                return o.lane;
            }
        }
        actual
    }

    /// Moves a workspace into a lane (no reorder), for the card menu and
    /// drops. Moving a card back to where cmux still has it cancels the
    /// pending move. A lane's generated anchor is its group, so never moves.
    /// A key the lane table does not hold (lanes.json changed under a menu
    /// or a drag) does nothing.
    pub fn move_to_lane(&mut self, data: &Data, w: Option<&Workspace>, key: LaneKey) {
        let Some(w) = w else { return };
        let Some(lane) = self.lanes.find(&key).cloned() else {
            return;
        };
        if self.lane_anchor_ids(data).contains(&w.id) {
            return;
        }
        if actual_lane_of(&self.lanes, data, Some(w)) == key {
            self.lane_override.shift_remove(&w.id);
            return;
        }
        let g = group_for_lane(data, &lane);
        let ws_id = Param::Str(w.id.clone());
        if key.is_unsorted() {
            self.cmux("workspace.group.remove", vec![("workspace_id", ws_id)]);
        } else if let Some(g) = g {
            let group = Param::Str(g.id.clone());
            self.cmux(
                "workspace.group.add",
                vec![("group_id", group), ("workspace_id", ws_id)],
            );
        } else {
            self.request_lane_group(data, &lane);
        }
        let awaiting = !key.is_unsorted() && g.is_none();
        let at = now_epoch(data);
        self.lane_override.insert(
            w.id.clone(),
            LaneMove {
                lane: key,
                at,
                awaiting,
                held_from: None,
            },
        );
    }

    /// Asks cmux for a lane's group, once per wait. No anchor is named, so
    /// cmux makes a generated one; the key is fresh each time.
    fn request_lane_group(&mut self, data: &Data, lane: &Lane) {
        let now = now_epoch(data);
        if self.awaiting_lane(&lane.key, now) {
            return;
        }
        let key = format!("cockpit-lane-{}-{}", lane.key.as_str(), num_text(now));
        self.cmux(
            "workspace.group.create",
            vec![
                ("name", Param::Str(lane.name.to_string())),
                ("idempotency_key", Param::Str(key)),
            ],
        );
    }

    /// Files each waiting card whose group has shown up: to just after the
    /// group's run of tabs, then into it. A wait past CREATE_SECS is
    /// dropped, so a late group never pulls back a card that fell back.
    fn file_awaiting_cards(&mut self, data: &Data) {
        let now = now_epoch(data);
        let waiting: Vec<(String, LaneMove)> = self
            .lane_override
            .iter()
            .filter(|(_, o)| o.awaiting)
            .map(|(id, o)| (id.clone(), o.clone()))
            .collect();
        for (ws_id, o) in waiting {
            if expired(&o, now) {
                self.lane_override.shift_remove(&ws_id);
                continue;
            }
            let Some(g) = self
                .lanes
                .find(&o.lane)
                .and_then(|l| group_for_lane(data, l))
            else {
                continue;
            };
            if let Some(at) = index_after_group(data, &ws_id, g) {
                self.cmux(
                    "workspace.reorder",
                    vec![
                        ("workspace_id", Param::Str(ws_id.clone())),
                        ("index", Param::Num(at as f64)),
                    ],
                );
            }
            self.cmux(
                "workspace.group.add",
                vec![
                    ("group_id", Param::Str(g.id.clone())),
                    ("workspace_id", Param::Str(ws_id.clone())),
                ],
            );
            self.lane_override.insert(
                ws_id,
                LaneMove {
                    lane: o.lane,
                    at: now,
                    awaiting: false,
                    held_from: o.held_from,
                },
            );
        }
    }

    /// Records a reorder the app has not reflected yet.
    pub fn override_order(&mut self, data: &Data, ids: Vec<String>) {
        self.order_override = Some(OrderMove {
            ids,
            at: now_epoch(data),
            held_bases: Vec::new(),
        });
    }

    /// Every workspace in tab order, a pending reorder applied. The read
    /// every frame starts with, so it also renames the group of a lane
    /// renamed in lanes.json and files cards waiting on a group.
    pub fn all_workspaces<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        self.rename_lane_groups(data);
        self.file_awaiting_cards(data);
        let mut ws: Vec<&Workspace> = data.workspace_list().iter().collect();
        if let Some(o) = self.order_override.clone() {
            let ids: Vec<String> = o
                .ids
                .into_iter()
                .filter(|id| ws.iter().any(|w| w.id == *id))
                .collect();
            let done = if o.held_bases.is_empty() {
                let caught_up =
                    ws.len() == ids.len() && ws.iter().zip(&ids).all(|(w, id)| w.id == *id);
                caught_up || now_epoch(data) - o.at > OVERRIDE_SECS
            } else {
                same_order(&ws, &ids) || !o.held_bases.iter().any(|b| same_order(&ws, b))
            };
            if done {
                self.order_override = None;
            } else {
                // A Map from the ids keeps the last index of a repeated one.
                let rank = |w: &Workspace| {
                    ids.iter()
                        .rposition(|id| *id == w.id)
                        .map_or(1e9, |i| i as f64)
                };
                ws.sort_by(|a, b| rank(a).partial_cmp(&rank(b)).unwrap_or(Ordering::Equal));
            }
        }
        ws
    }

    /// Real cards: every workspace except the generated lane anchors.
    pub fn card_workspaces<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        let anchors = self.lane_anchor_ids(data);
        self.all_workspaces(data)
            .into_iter()
            .filter(|w| !anchors.contains(&w.id))
            .collect()
    }

    /// Whether a lane is folded: Unsorted locally, a lane group by cmux,
    /// a tap applied at once. A lane that starts folded stays so until touched.
    pub fn is_collapsed(&mut self, data: &Data, lane: &Lane) -> bool {
        if lane.key.is_unsorted() {
            return self.unsorted_collapsed;
        }
        let Some(g) = group_for_lane(data, lane) else {
            return false;
        };
        if let Some(v) = self.collapse_override.get(&g.id).copied() {
            if Some(v) == g.collapsed {
                self.collapse_override.shift_remove(&g.id);
            } else {
                return v;
            }
        }
        if lane.starts_collapsed && !self.touched_lanes.contains(&lane.key) {
            return true;
        }
        g.collapsed == Some(true)
    }

    /// Folds or unfolds a lane, and saves every fold. A key the lane table
    /// does not hold does nothing.
    pub fn toggle_lane(&mut self, data: &Data, key: &LaneKey) {
        let Some(lane) = &self.lanes.find(key).cloned() else {
            return;
        };
        let next = !self.is_collapsed(data, lane);
        if !self.touched_lanes.contains(&lane.key) {
            self.touched_lanes.push(lane.key.clone());
        }
        if lane.key.is_unsorted() {
            self.unsorted_collapsed = next;
            self.save_folds(data);
            return;
        }
        let Some(g) = group_for_lane(data, lane) else {
            return;
        };
        self.collapse_override.insert(g.id.clone(), next);
        let method = if next {
            "workspace.group.collapse"
        } else {
            "workspace.group.expand"
        };
        self.cmux(method, vec![("group_id", Param::Str(g.id.clone()))]);
        self.save_folds(data);
    }

    /// Folds or unfolds a project, and saves every fold.
    pub fn toggle_project(&mut self, data: &Data, k: &str) {
        if self.is_project_collapsed(k) {
            self.collapsed_projects.retain(|x| x != k);
        } else {
            self.collapsed_projects.push(k.to_string());
        }
        self.save_folds(data);
    }

    /// Folds or unfolds the Quiet header, and saves every fold.
    pub fn toggle_quiet(&mut self, data: &Data) {
        self.quiet_collapsed = !self.quiet_collapsed;
        self.save_folds(data);
    }

    /// Sends every fold at once, so the saved copy never lags a quick
    /// second tap: touched lanes, folded projects still in the table (or
    /// Other), and the Quiet header while folded, keys sorted. A touched
    /// lane the table no longer holds keeps the fold saved for it, so
    /// taking a lane out of lanes.json for a while does not lose it.
    pub fn save_folds(&mut self, data: &Data) {
        let mut folds: Vec<(String, f64)> = Vec::new();
        let lanes: Vec<Lane> = self.lanes.iter().cloned().collect();
        for lane in &lanes {
            if self.touched_lanes.contains(&lane.key) {
                let flag = if self.is_collapsed(data, lane) {
                    1.0
                } else {
                    0.0
                };
                folds.push((format!("lane:{}", lane.key.as_str()), flag));
            }
        }
        for key in &self.touched_lanes {
            if self.lanes.find(key).is_some() {
                continue;
            }
            let k = format!("lane:{}", key.as_str());
            if let Some(flag) = self.saved.ui.collapsed.get(&k).copied() {
                folds.push((k, flag));
            }
        }
        for k in &self.collapsed_projects {
            if is_project_key(&self.projects, k) || k == OTHER_KEY {
                folds.push((format!("{PROJECT_FOLD}{k}"), 1.0));
            }
        }
        if self.quiet_collapsed {
            folds.push(("quiet".to_string(), 1.0));
        }
        folds.sort_by(|(a, _), (b, _)| a.cmp(b));
        let value = (!folds.is_empty()).then(|| {
            let map: Map<String, Value> = folds
                .into_iter()
                .map(|(k, v)| (k, crate::js::json_num(v)))
                .collect();
            Value::Object(map)
        });
        self.persist_set("ui.collapsed".to_string(), value);
    }

    /// Switches between All and Projects, kept across a reload.
    pub fn choose_mode(&mut self, m: ViewMode) {
        if self.mode == m {
            return;
        }
        self.mode = m;
        self.persist_set("ui.mode".to_string(), Some(Value::from(m.as_str())));
    }

    /// 1 while `m` is the chosen view, else 0: the panel's opacity.
    pub fn panel_opacity(&self, m: ViewMode) -> f64 {
        if self.is_mode(m) { 1.0 } else { 0.0 }
    }

    /// Unbounded while `m` is the chosen view, else zero: the panel's height.
    pub fn panel_max_height(&self, m: ViewMode) -> PanelHeight {
        if self.is_mode(m) {
            PanelHeight::Infinity
        } else {
            PanelHeight::Zero
        }
    }
}
