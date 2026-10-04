//! The Needs you strip (src/cockpit/strip.ts): who waits on Jon, how long
//! the oldest has waited, the row cap and its "+N more", and the cards the
//! strip stands in for. A dismissal from the strip holds the card at the
//! top of its lane until its status moves on; lane entries read that hold.

use std::cmp::Ordering;

use indexmap::IndexSet;

use crate::data::{Data, Workspace};
use crate::js::positive;
use crate::session::Session;
use crate::status::Status;
use crate::time::{fmt_age, now_epoch};

/// The strip lists this many rows, then "+N more" (issue #74), so a long
/// queue never pushes the lanes off screen.
pub const NEEDS_ROWS: usize = 4;

/// The header's clock turns clay once the oldest ask has waited this long (issue #153).
pub const NEEDS_LATE_SECS: f64 = 30.0 * 60.0;

/// The row key a dragged card carries.
fn card_key(id: &str) -> String {
    format!("w:{id}")
}

impl Session {
    /// Workspaces waiting on Jon, longest waiting first, ties in tab order.
    /// A lane's generated anchor counts too: it is off the cards, but an
    /// agent in it can still ask.
    pub fn needs_list<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        let mut waiting: Vec<(f64, &Workspace)> = Vec::new();
        for w in self.all_workspaces(data) {
            if self.status_of(Some(w)) == Status::NeedsInput {
                waiting.push((self.since_of(Some(w)), w));
            }
        }
        // A stable sort, as Array.prototype.sort is.
        waiting.sort_by(|(a, _), (b, _)| a.partial_cmp(b).unwrap_or(Ordering::Equal));
        waiting.into_iter().map(|(_, w)| w).collect()
    }

    /// The rows the strip lists: the first NEEDS_ROWS of the list.
    pub fn needs_shown<'d>(&mut self, data: &'d Data) -> Vec<&'d Workspace> {
        let mut list = self.needs_list(data);
        list.truncate(NEEDS_ROWS);
        list
    }

    /// How many waiting workspaces the strip leaves out, its "+N more".
    pub fn needs_more(&mut self, data: &Data) -> usize {
        self.needs_list(data).len().saturating_sub(NEEDS_ROWS)
    }

    /// How long the oldest ask has waited in seconds, timed as its row is;
    /// None with no timed ask or no clock. An untimed ask sorts first, so
    /// it is skipped rather than left to blank the clock.
    fn oldest_wait(&mut self, data: &Data) -> Option<f64> {
        let list = self.needs_list(data);
        let at = list
            .into_iter()
            .map(|w| self.since_of(Some(w)))
            .find(|t| positive(*t))?;
        let now = now_epoch(data);
        (now != 0.0 && !now.is_nan()).then(|| (now - at).max(0.0))
    }

    /// The header's clock: "12m" for the oldest ask, "" when nothing says.
    pub fn needs_wait_text(&mut self, data: &Data) -> String {
        self.oldest_wait(data).map(fmt_age).unwrap_or_default()
    }

    /// Whether the oldest ask has waited NEEDS_LATE_SECS or more.
    pub fn needs_wait_late(&mut self, data: &Data) -> bool {
        self.oldest_wait(data).unwrap_or(0.0) >= NEEDS_LATE_SECS
    }

    /// The workspaces the strip lists whose card leaves its lane or project
    /// for a placeholder in the same spot. One past the cap keeps its card,
    /// and so does the card being dragged, so it never vanishes from under
    /// the pointer. In the strip's order.
    pub fn in_strip(&mut self, data: &Data) -> IndexSet<String> {
        let dragged = self.drag.as_ref().map(|d| d.id.clone());
        self.needs_shown(data)
            .into_iter()
            .filter(|w| dragged.as_deref() != Some(card_key(&w.id).as_str()))
            .map(|w| w.id.clone())
            .collect()
    }

    /// Dismisses a waiting session from Needs you, holding its card where
    /// its placeholder sat. The card menu offers this on cards that are
    /// not waiting too; only a real dismissal holds.
    pub fn dismiss_waiting(&mut self, data: &Data, w: Option<&Workspace>) {
        let Some(w) = w else { return };
        self.dismiss_needs(Some(w));
        if !self.is_needs_dismissed(Some(w)) {
            return;
        }
        let live: IndexSet<&str> = data
            .workspace_list()
            .iter()
            .map(|x| x.id.as_str())
            .collect();
        self.dismissed_hold
            .retain(|id, _| live.contains(id.as_str()));
        let status = self.status_of(Some(w));
        self.dismissed_hold.insert(w.id.clone(), status);
    }

    /// Lets go of a dismissed card's hold, as a new ask does.
    pub fn release_hold(&mut self, w: &Workspace) {
        self.dismissed_hold.shift_remove(&w.id);
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
        self.dismissed_hold.shift_remove(&w.id);
        false
    }
}

#[cfg(test)]
mod tests {
    use crate::data::{Agent, AgentStatus, Data, Workspace};
    use crate::persist::SavedState;
    use crate::session::Session;
    use crate::state::DragState;

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
    fn leaves_the_dragged_card_out_of_the_placeholders_only() {
        let data = frame(2000.0, vec![asking("x", 500.0), asking("y", 600.0)]);
        let mut s = Session::default();
        s.set_drag(Some(DragState {
            id: "w:x".into(),
            index: 1.0,
        }));
        assert_eq!(ids(&s.needs_shown(&data)), ["x", "y"]);
        assert_eq!(s.in_strip(&data).into_iter().collect::<Vec<_>>(), ["y"]);
        s.set_drag(None);
        assert_eq!(
            s.in_strip(&data).into_iter().collect::<Vec<_>>(),
            ["x", "y"]
        );
    }

    #[test]
    fn counts_none_more_and_keeps_no_clock_with_nothing_waiting() {
        let data = frame(2000.0, vec![]);
        let mut s = Session::new(Vec::new(), SavedState::default());
        assert_eq!(s.needs_more(&data), 0);
        assert_eq!(s.needs_wait_text(&data), "");
        assert!(!s.needs_wait_late(&data));
    }

    /// The R1.0 spike's expected differences (native/spike/README.md): cmux
    /// says needs_input for a turn that ended on "Nothing for you" and for a
    /// dismissed spell, and the strip leaves both out. Both read from
    /// config/state.json as the sidebar reads them: the move from `moves`,
    /// the dismissal from `dismissed`.
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
