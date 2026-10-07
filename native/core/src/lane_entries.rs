//! All mode's rows (src/cockpit/lane-entries.ts): lane headers, cards in
//! state order, and what each header counts and says. A card waiting on
//! Jon stays in its lane and says so itself (issue #281), so unlike the
//! TypeScript there are no placeholders.

use serde::Serialize;

use crate::data::{Data, Workspace};
use crate::lanes::{LANES, Lane, LaneKey, lane_by_key};
use crate::model::{actual_lane_of, generated_anchor_id};
use crate::prs::{PrHealth, pr_health};
use crate::session::Session;
use crate::status::Status;
use crate::theme::Token;

/// One row of All. A header's key carries the anchor it shows (issue #49);
/// an empty lane is a zone (issue #50); a card's key is `w:` and its
/// workspace, without its lane, so a lane move keeps its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LaneEntry {
    Header {
        id: String,
        lane: LaneKey,
        #[serde(rename = "anchorId")]
        anchor_id: Option<String>,
    },
    Zone {
        id: String,
        lane: LaneKey,
    },
    Ws {
        id: String,
        #[serde(rename = "wsId")]
        ws_id: String,
        lane: LaneKey,
    },
}

impl LaneEntry {
    /// The row's key.
    pub fn id(&self) -> &str {
        match self {
            LaneEntry::Header { id, .. }
            | LaneEntry::Zone { id, .. }
            | LaneEntry::Ws { id, .. } => id,
        }
    }

    /// The lane the row is in.
    pub fn lane(&self) -> LaneKey {
        match self {
            LaneEntry::Header { lane, .. }
            | LaneEntry::Zone { lane, .. }
            | LaneEntry::Ws { lane, .. } => *lane,
        }
    }
}

/// The words at a lane header's trailing edge, and their ink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderHint {
    pub text: String,
    pub color: Token,
}

/// A lane with its cards in state order and the anchor its header shows.
struct LaneSection<'d> {
    lane: Lane,
    rows: Vec<&'d Workspace>,
    anchor_id: Option<String>,
}

impl LaneSection<'_> {
    /// Nothing to show: no cards, and no anchor status on the header.
    fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.anchor_id.is_none()
    }
}

/// A lane's generated anchor when it has an agent (a hole counts, as the
/// list's length does) or unread messages, so its header shows them.
fn header_anchor_id(data: &Data, lane: &Lane) -> Option<String> {
    let id = generated_anchor_id(data, lane)?;
    let w = data.ws_by_id(&id)?;
    (w.agent_slots() > 0 || w.unread.unwrap_or(0.0) > 0.0).then(|| w.id.clone())
}

/// Lanes you come back to after a while, where a card also says what you last asked.
const LEFT_OFF_LANES: [LaneKey; 2] = [LaneKey::Bg, LaneKey::Parked];

/// Whether the card shows your last prompt: in Background and Parked, by
/// cmux's own data as card_density is.
pub fn shows_left_off(data: &Data, w: Option<&Workspace>) -> bool {
    LEFT_OFF_LANES.contains(&actual_lane_of(data, w))
}

impl Session {
    fn live_rank(&mut self, data: &Data, w: Option<&Workspace>) -> u8 {
        let s = self.status_of(w);
        if s == Status::NeedsInput {
            if let Some(w) = w {
                self.release_hold(w);
            }
            return 0;
        }
        if let Some(w) = w
            && self.held_at_top(w)
        {
            return 0;
        }
        if self.is_ready(data, w) {
            return 1;
        }
        // A Waiting card is drawn in working blue, so it sorts with the working.
        let a = self.agent_of(w);
        if s == Status::Working || self.is_waiting(a.as_ref(), w) {
            2
        } else {
            3
        }
    }

    /// A card's place in its lane (issue #74): needs you, then Ready, then
    /// working, then the rest. The selected card keeps the best of its
    /// live rank and the one it last had while not selected, so it never
    /// slides out from under the pointer and settles once Jon moves on.
    pub fn state_rank(&mut self, data: &Data, w: Option<&Workspace>) -> u8 {
        let rank = self.live_rank(data, w);
        let Some(w) = w else { return rank };
        if !self.is_selected(data, Some(w)) {
            self.held_rank.insert(w.id.clone(), rank);
            return rank;
        }
        self.held_rank
            .get(&w.id)
            .map_or(rank, |held| rank.min(*held))
    }

    /// Rows in state order, tab order kept within a state. Every rank is
    /// read once before the stable sort, since reading one can release a
    /// hold or save a rank.
    fn by_state<'d>(&mut self, data: &Data, rows: Vec<&'d Workspace>) -> Vec<&'d Workspace> {
        let mut ranked: Vec<(u8, &Workspace)> = rows
            .into_iter()
            .map(|w| (self.state_rank(data, Some(w)), w))
            .collect();
        ranked.sort_by_key(|(rank, _)| *rank);
        ranked.into_iter().map(|(_, w)| w).collect()
    }

    /// Every lane with the cards it counts, in tab order: one pass over the
    /// cards for every lane. Ranks kept for workspaces gone from the data
    /// are dropped here, so the map never outgrows the open workspaces.
    pub fn lane_cards<'d>(&mut self, data: &'d Data) -> Vec<(Lane, Vec<&'d Workspace>)> {
        self.held_rank.retain(|id, _| data.ws_by_id(id).is_some());
        let mut out: Vec<(Lane, Vec<&Workspace>)> =
            LANES.iter().map(|l| (*l, Vec::new())).collect();
        for w in self.card_workspaces(data) {
            let key = self.lane_of(data, w);
            if let Some((_, cards)) = out.iter_mut().find(|(l, _)| l.key == key) {
                cards.push(w);
            }
        }
        out
    }

    /// All mode's rows, top to bottom. An empty lane is a zone row in its
    /// own place, at rest and mid-drag alike, so the drop index always
    /// counts the same rows. Built in both modes: the lanes panel stays
    /// mounted under Projects.
    pub fn lane_entries(&mut self, data: &Data) -> Vec<LaneEntry> {
        let cards = self.lane_cards(data);
        self.lane_entries_from(data, &cards)
    }

    /// All's rows from the lanes' cards, already worked out this frame.
    pub fn lane_entries_from(
        &mut self,
        data: &Data,
        cards: &[(Lane, Vec<&Workspace>)],
    ) -> Vec<LaneEntry> {
        let mut out = Vec::new();
        for (lane, lane_cards) in cards {
            let section = LaneSection {
                lane: *lane,
                rows: self.by_state(data, lane_cards.clone()),
                anchor_id: header_anchor_id(data, lane),
            };
            let key = section.lane.key;
            if section.is_empty() {
                out.push(LaneEntry::Zone {
                    id: format!("z:{}", key.as_str()),
                    lane: key,
                });
                continue;
            }
            let id = match &section.anchor_id {
                Some(anchor) => format!("h:{}:{anchor}", key.as_str()),
                None => format!("h:{}", key.as_str()),
            };
            out.push(LaneEntry::Header {
                id,
                lane: key,
                anchor_id: section.anchor_id.clone(),
            });
            if self.is_collapsed(data, &section.lane) {
                continue;
            }
            for w in section.rows {
                let ws_id = w.id.clone();
                out.push(LaneEntry::Ws {
                    id: format!("w:{ws_id}"),
                    ws_id,
                    lane: key,
                });
            }
        }
        out
    }

    /// The cards a lane header counts, in tab order: every card it lists,
    /// folded or not.
    pub fn lane_workspaces<'d>(&mut self, data: &'d Data, key: LaneKey) -> Vec<&'d Workspace> {
        let mut out = Vec::new();
        for w in self.card_workspaces(data) {
            if self.lane_of(data, w) == key {
                out.push(w);
            }
        }
        out
    }

    /// A lane header's merge line: "2 ready to merge" when that many of its
    /// workspaces hold a PR GitHub would merge now, else "". Every card the
    /// lane counts, and its generated anchor, which has
    /// no card of its own.
    pub fn merge_ready_text(&mut self, data: &Data, key: LaneKey) -> String {
        let cards = self.lane_workspaces(data, key);
        self.merge_ready_of(data, key, &cards)
    }

    /// The merge line from the lane's cards, already worked out this frame.
    pub fn merge_ready_of(&self, data: &Data, key: LaneKey, cards: &[&Workspace]) -> String {
        let anchor = generated_anchor_id(data, &lane_by_key(key));
        let anchor = anchor.as_deref().and_then(|id| data.ws_by_id(id));
        let n = cards
            .iter()
            .copied()
            .chain(anchor)
            .filter(|w| pr_health(&self.saved, Some(w)) == PrHealth::Ready)
            .count();
        if n == 0 {
            String::new()
        } else {
            format!("{n} ready to merge")
        }
    }

    /// "Drop here" while a drag is over the lane, else its merge line:
    /// faint in Parked, as its title is, else in Ready's green.
    pub fn header_hint(&mut self, data: &Data, key: LaneKey, dropping: bool) -> HeaderHint {
        if dropping {
            return HeaderHint {
                text: "Drop here".to_string(),
                color: Token::Heading,
            };
        }
        HeaderHint {
            text: self.merge_ready_text(data, key),
            color: if key == LaneKey::Parked {
                Token::Faint
            } else {
                Token::GreenDeep
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::data::{Data, Workspace};
    use crate::session::Session;

    fn frame(ids: &[&str]) -> Data {
        Data {
            epoch: Some(1000.0),
            workspaces: Some(
                ids.iter()
                    .map(|id| Workspace {
                        id: (*id).into(),
                        ..Workspace::default()
                    })
                    .collect(),
            ),
            ..Data::default()
        }
    }

    #[test]
    fn forgets_the_rank_of_a_workspace_gone_from_the_data() {
        let mut s = Session::default();
        s.lane_entries(&frame(&["a", "b"]));
        assert!(s.held_rank.contains_key("a"));
        s.lane_entries(&frame(&["b"]));
        assert!(!s.held_rank.contains_key("a"));
        assert!(s.held_rank.contains_key("b"));
    }
}
