//! Needs you (src/cockpit/strip.ts): who waits on Jon and how long the
//! oldest has waited. The TypeScript draws them as a strip with
//! placeholders left in the lanes; here each card stays in its lane and
//! says so itself, and Next's pill carries the count (issue #281). A
//! dismissal holds the card at the top of its lane until its status moves
//! on; lane entries read that hold.
//!
//! The TypeScript memoises the list once per change. Here `needs` builds
//! it once and answers every field from that; the single getters are for
//! callers that want one field.

use std::cmp::Ordering;

use crate::data::{Data, Workspace};
use crate::js::positive;
use crate::session::Session;
use crate::status::Status;
use crate::time::{fmt_age, now_epoch};

/// Next's clock turns clay once the oldest ask has waited this long (issue #153).
pub const NEEDS_LATE_SECS: f64 = 30.0 * 60.0;

/// Needs you for one frame, every field from one build of the list.
#[derive(Debug, Clone, PartialEq)]
pub struct NeedsStrip<'d> {
    /// Every workspace waiting on Jon, longest waiting first.
    pub list: Vec<&'d Workspace>,
    /// Next's clock: "12m" for the oldest ask, "" when nothing says.
    pub wait_text: String,
    /// Whether the oldest ask has waited NEEDS_LATE_SECS or more.
    pub late: bool,
}

impl Session {
    /// Each waiting workspace with when its wait began, longest waiting
    /// first, ties in tab order. A lane's generated anchor counts too: it
    /// is off the cards, but an agent in it can still ask.
    fn waiting<'d>(&mut self, data: &'d Data) -> Vec<(f64, &'d Workspace)> {
        let mut waiting: Vec<(f64, &Workspace)> = Vec::new();
        for w in self.all_workspaces(data) {
            let (status, since) = self.status_and_since(Some(w));
            if status == Status::NeedsInput {
                waiting.push((since, w));
            }
        }
        // A stable sort, as Array.prototype.sort is.
        waiting.sort_by(|(a, _), (b, _)| a.partial_cmp(b).unwrap_or(Ordering::Equal));
        waiting
    }

    /// Needs you for this frame.
    pub fn needs<'d>(&mut self, data: &'d Data) -> NeedsStrip<'d> {
        let waiting = self.waiting(data);
        let wait = oldest_wait(data, &waiting);
        NeedsStrip {
            list: waiting.into_iter().map(|(_, w)| w).collect(),
            wait_text: wait.map(fmt_age).unwrap_or_default(),
            late: wait.unwrap_or(0.0) >= NEEDS_LATE_SECS,
        }
    }

    /// Workspaces waiting on Jon, longest waiting first.
    pub fn needs_list<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        self.needs(data).list
    }

    /// Next's clock: "12m" for the oldest ask, "" when nothing says.
    pub fn needs_wait_text(&mut self, data: &Data) -> String {
        self.needs(data).wait_text
    }

    /// Whether the oldest ask has waited NEEDS_LATE_SECS or more.
    pub fn needs_wait_late(&mut self, data: &Data) -> bool {
        self.needs(data).late
    }

    /// Dismisses a waiting session from Needs you, holding its card at the
    /// top of its lane. The card menu offers this on cards that are
    /// not waiting too; only a real dismissal holds.
    pub fn dismiss_waiting(&mut self, data: &Data, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        self.dismiss_needs(Some(w));
        if !self.is_needs_dismissed(Some(w)) {
            return;
        }
        self.dismissed_hold
            .retain(|id, _| data.ws_by_id(id).is_some());
        let status = self.status_of(Some(w));
        self.dismissed_hold.insert(w.id.clone(), status);
    }

    /// Lets go of a dismissed card's hold, as a new ask does.
    pub fn release_hold(&mut self, w: &Workspace) {
        self.dismissed_hold.remove(&w.id);
    }

    /// Whether a dismissed card still holds the top of its lane: until its
    /// status moves on from the one it was dismissed in, when the hold goes.
    pub fn held_at_top(&mut self, w: &Workspace) -> bool {
        let Some(held) = self.dismissed_hold.get(&w.id).cloned() else {
            return false;
        };
        if held == self.status_of(Some(w)) {
            return true;
        }
        self.dismissed_hold.remove(&w.id);
        false
    }
}

/// How long the oldest ask has waited in seconds, timed as its card is;
/// None with no timed ask or no clock. An untimed ask sorts first, so it
/// is skipped rather than left to blank the clock.
fn oldest_wait(data: &Data, waiting: &[(f64, &Workspace)]) -> Option<f64> {
    let at = waiting
        .iter()
        .map(|(since, _)| *since)
        .find(|t| positive(*t))?;
    let now = now_epoch(data);
    (now != 0.0 && !now.is_nan()).then(|| (now - at).max(0.0))
}

#[cfg(test)]
mod tests {
    use crate::data::{Agent, AgentStatus, Data, Workspace};
    use crate::persist::SavedState;
    use crate::session::Session;

    fn asking(id: &str, since: f64) -> Workspace {
        Workspace {
            id: id.into(),
            agents: Some(vec![Some(Agent {
                id: format!("{id}-agent"),
                status: Some(AgentStatus::NeedsInput),
                since_epoch: Some(since),
                ..Agent::default()
            })]),
            ..Workspace::default()
        }
    }

    fn frame(epoch: f64, workspaces: Vec<Workspace>) -> Data {
        Data {
            epoch: Some(epoch),
            workspaces: Some(workspaces),
            ..Data::default()
        }
    }

    fn ids(list: &[&Workspace]) -> Vec<String> {
        list.iter().map(|w| w.id.clone()).collect()
    }

    #[test]
    fn keeps_tab_order_between_asks_that_began_together() {
        let data = frame(2000.0, vec![asking("x", 500.0), asking("y", 500.0)]);
        let mut s = Session::default();
        assert_eq!(ids(&s.needs_list(&data)), ["x", "y"]);
    }

    #[test]
    fn leaves_out_the_r1_0_expected_differences_nothing_for_you_and_dismissed() {
        let saved = SavedState::from_json(
            r#"{
                "moves": {"quiet": {"text": "CI is running.", "epoch": 1000, "session": "s-quiet", "idle": true}},
                "dismissed": {"dismissed": {"dismissed-agent": 500}}
            }"#,
        )
        .unwrap();
        let quiet = Workspace {
            id: "quiet".into(),
            latest_at: Some(950.0),
            agents: Some(vec![Some(Agent {
                id: "s-quiet".into(),
                kind: Some("claude".into()),
                status: Some(AgentStatus::NeedsInput),
                since_epoch: Some(1060.0),
                last_activity_at: Some(1060.0),
                ..Agent::default()
            })]),
            ..Workspace::default()
        };
        let data = frame(
            1100.0,
            vec![quiet, asking("dismissed", 500.0), asking("real", 900.0)],
        );
        let raw: Vec<_> = data
            .workspace_list()
            .iter()
            .flat_map(Workspace::agent_list)
            .map(|a| a.status.clone())
            .collect();
        assert!(raw.iter().all(|st| *st == Some(AgentStatus::NeedsInput)));
        let mut s = Session::new(Vec::new(), saved);
        assert_eq!(ids(&s.needs_list(&data)), ["real"]);
    }

    #[test]
    fn drops_holds_for_workspaces_gone_from_the_data_on_the_next_dismissal() {
        let gone = asking("gone", 500.0);
        let here = asking("here", 600.0);
        let mut s = Session::default();
        s.dismiss_waiting(&frame(2000.0, vec![gone.clone()]), Some(&gone));
        assert!(s.dismissed_hold.contains_key("gone"));
        s.dismiss_waiting(&frame(2100.0, vec![here.clone()]), Some(&here));
        assert!(!s.dismissed_hold.contains_key("gone"));
        assert!(s.held_at_top(&here));
    }
}
