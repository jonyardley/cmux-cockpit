//! A parked Ostinato attempt waits on Jon (issue #390): its card joins
//! Needs you in Your turn's clay, as a stopped session does, its status
//! "Your turn: Ostinato parked notes-app#41". It follows the CI wait
//! (ci_wait.rs): the card speaks through its most active agent, which
//! reads as needs input from the park, carrying `Agent::ostinato_park` so
//! the words say why; a workspace with no session gets a stand-in.
//!
//! Unlike a CI wait, a session at work in the workspace does not hide a
//! park: the loop runs unattended, so nobody else will answer its
//! question, and its own sessions may be the ones working. The card's
//! own wait (a stop, an ask, a turn, CI) goes first; the park still
//! counts for dismissing.
//!
//! A park waits while the run has not picked its item again since. One
//! dismissal covers the workspace's parks, under `OSTINATO_KEY`, keyed on
//! the newest park's time, so a new park brings the card back. The park
//! is read once a frame, at the frame's clock (`Session::tend_parks`).

use crate::activity::most_active;
use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::session::Session;
use crate::text::clip;

use super::card::live_parks;

/// The dismissal key a workspace's parks are saved under, beside its
/// agents' ids and CI's. No session id takes this shape.
pub const OSTINATO_KEY: &str = "ostinato";

/// A workspace's parked Ostinato attempts, as the last frame read them.
#[derive(Debug, Clone, PartialEq)]
pub struct ParkWait {
    /// The newest park's time: when it began to wait, and the key a
    /// dismissal holds to.
    pub key: f64,
    /// The newest park's item, "notes-app#41".
    pub item: String,
    /// How many parks wait.
    pub count: usize,
    /// The workspace is awake: an asleep one waits on nobody by design.
    pub waits: bool,
}

impl ParkWait {
    /// What the card says waits: "Ostinato parked notes-app#41", or
    /// "Ostinato parked 2 issues".
    pub fn words(&self) -> String {
        match self.count {
            1 => format!("Ostinato parked {}", self.item),
            n => format!("Ostinato parked {n} issues"),
        }
    }
}

/// The id of the agent among `agents` (a workspace's, CI applied) that
/// carries its park: the one the card speaks through, unless that one
/// already waits on Jon for its own reason.
fn park_carrier(agents: &[Agent]) -> Option<&str> {
    most_active(agents)
        .filter(|a| a.status != Some(AgentStatus::NeedsInput))
        .map(|a| a.id.as_str())
}

impl Session {
    /// Reads each workspace's parked attempts at the frame's clock.
    pub(crate) fn tend_parks(&mut self, data: &Data) {
        self.parks.clear();
        let mut found = std::collections::HashMap::new();
        for w in data.workspace_list() {
            let Some(run) = self.ostinato_run(data, w).and_then(|s| s.run) else {
                continue;
            };
            let live = live_parks(&run);
            let Some(newest) = live.last() else { continue };
            found.insert(
                w.id.clone(),
                ParkWait {
                    key: newest.at,
                    item: newest.item.clone(),
                    count: live.len(),
                    waits: self.sleep_kind(&w.id).is_none(),
                },
            );
        }
        self.parks = found;
    }

    /// Whether a park dismissal saved at `key` still holds for `w`: its
    /// newest park is that one, or no record is read for it yet (before
    /// the runner's first feed, say). It lapses once the record says
    /// otherwise: a newer park, or none left.
    pub(crate) fn park_dismissal_holds(&self, w: &Workspace, key: f64) -> bool {
        match self.parks.get(&w.id) {
            Some(p) => p.key == key,
            None => w
                .directory
                .as_deref()
                .and_then(|d| self.ostinato.record_for(d))
                .is_none(),
        }
    }

    /// The workspace's park that counts for dismissing and restoring:
    /// waiting on Jon, dismissed or not.
    pub(crate) fn park_waiting(&self, w: &Workspace) -> Option<&ParkWait> {
        self.parks.get(&w.id).filter(|p| p.waits)
    }

    /// The workspace's park as the sidebars show it: waiting on Jon and
    /// not dismissed.
    pub fn park_shown(&self, w: Option<&Workspace>) -> Option<&ParkWait> {
        let w = w?;
        self.park_waiting(w)
            .filter(|p| !self.dismissed_key(&w.id, OSTINATO_KEY, p.key))
    }

    /// Whether the agent with id `id` carries `w`'s park, with `agents`
    /// the workspace's agents with CI applied.
    pub(crate) fn carries_park(&self, w: &Workspace, agents: &[Agent], id: &str) -> bool {
        self.park_shown(Some(w)).is_some() && park_carrier(agents) == Some(id)
    }

    /// `a`, carrying `w`'s park: needs input from the park.
    pub(crate) fn with_park(&self, a: Agent, w: &Workspace) -> Agent {
        match self.park_shown(Some(w)) {
            Some(p) => Agent {
                status: Some(AgentStatus::NeedsInput),
                since_epoch: Some(p.key),
                ostinato_park: true,
                ..a
            },
            None => a,
        }
    }

    /// `agents`, a workspace's with CI applied, with its park on the
    /// one that carries it.
    pub(crate) fn with_parks(&self, agents: Vec<Agent>, w: &Workspace) -> Vec<Agent> {
        let Some(carrier) = park_carrier(&agents).map(str::to_string) else {
            return agents;
        };
        agents
            .into_iter()
            .map(|a| {
                if a.id == carrier {
                    self.with_park(a, w)
                } else {
                    a
                }
            })
            .collect()
    }

    /// The stand-in agent a workspace with no session left shows its
    /// park by, or None when none shows.
    pub(crate) fn park_stand_in(&self, w: Option<&Workspace>) -> Option<Agent> {
        let p = self.park_shown(w)?;
        Some(Agent {
            id: OSTINATO_KEY.to_string(),
            status: Some(AgentStatus::NeedsInput),
            since_epoch: Some(p.key),
            last_activity_at: Some(p.key),
            ostinato_park: true,
            ..Agent::default()
        })
    }

    /// The park's words for a waiting card, cut to `max`.
    pub(crate) fn park_detail(&self, w: Option<&Workspace>, max: usize) -> String {
        self.park_shown(w)
            .map(|p| clip(&p.words(), max))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::app::{Cockpit, Event, Model};
    use crate::ostinato::{OstinatoFeed, RecordText};
    use crate::status::StatusKind;
    use crate::time::iso_epoch;
    use crux_core::App;

    const PARKED: &str = include_str!("../../../../test/golden/ostinato/parked-then-picked.jsonl");

    fn at(s: &str) -> f64 {
        iso_epoch(s).unwrap()
    }

    /// The parked sample's first `n` lines as the record of the
    /// workspace on /dev/notes-app.
    fn feed(n: usize) -> OstinatoFeed {
        let text: Vec<&str> = PARKED.lines().take(n).collect();
        OstinatoFeed {
            records: BTreeMap::from([(
                "example/notes-app".to_string(),
                RecordText::from_bytes(text.join("\n").as_bytes()),
            )]),
            checkouts: BTreeMap::from([(
                "/dev/notes-app".to_string(),
                "example/notes-app".to_string(),
            )]),
        }
    }

    fn agent(id: &str, status: AgentStatus) -> Agent {
        Agent {
            id: id.into(),
            kind: Some("claude".into()),
            status: Some(status),
            since_epoch: Some(at("2026-11-10T09:00:00Z")),
            last_activity_at: Some(at("2026-11-10T09:00:00Z")),
            ..Agent::default()
        }
    }

    fn frame(agents: Vec<Agent>, now: &str) -> crate::data::Data {
        crate::data::Data {
            epoch: Some(at(now)),
            workspaces: Some(vec![Workspace {
                id: "w".into(),
                directory: Some("/dev/notes-app".into()),
                agents: Some(agents.into_iter().map(Some).collect()),
                ..Workspace::default()
            }]),
            ..crate::data::Data::default()
        }
    }

    /// A model fed the record's first `n` lines and then `d`.
    fn model(n: usize, d: crate::data::Data) -> Model {
        let mut m = Model::default();
        let _ = Cockpit.update(Event::Ostinato(Box::new(feed(n))), &mut m);
        let _ = Cockpit.update(Event::Data(d), &mut m);
        m
    }

    fn needs(m: &mut Model) -> Vec<String> {
        let data = m.data.clone().unwrap();
        m.session
            .needs_list(&data)
            .iter()
            .map(|w| w.id.clone())
            .collect()
    }

    fn line(m: &mut Model) -> String {
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        m.session.needs_line(&data, w.as_ref())
    }

    #[test]
    fn a_park_joins_needs_you_as_your_turn_even_while_a_session_works() {
        let mut m = model(
            5,
            frame(
                vec![agent("a", AgentStatus::Working)],
                "2026-11-10T09:40:00Z",
            ),
        );
        assert_eq!(needs(&mut m), ["w"]);
        assert_eq!(line(&mut m), "Your turn: Ostinato parked notes-app#41");
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        assert_eq!(
            m.session.status_kind(&data, w.as_ref()),
            StatusKind::Plain(crate::status::Status::NeedsInput)
        );
        // Before the park, nothing waits.
        let mut m = model(
            3,
            frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:10:00Z"),
        );
        assert!(needs(&mut m).is_empty());
    }

    #[test]
    fn with_no_session_a_stand_in_carries_it_and_an_ask_goes_first() {
        let mut m = model(5, frame(Vec::new(), "2026-11-10T09:40:00Z"));
        assert_eq!(needs(&mut m), ["w"]);
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        let shown = m.session.agents_of(w.as_ref());
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].id, OSTINATO_KEY);
        assert!(shown[0].ostinato_park);

        // A session waiting on Jon itself keeps its own words.
        // Its last activity at the ask, so it is no idle nudge.
        let asking = Agent {
            since_epoch: Some(at("2026-11-10T09:35:00Z")),
            last_activity_at: Some(at("2026-11-10T09:35:00Z")),
            ..agent("a", AgentStatus::NeedsInput)
        };
        let mut m = model(5, frame(vec![asking], "2026-11-10T09:40:00Z"));
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        let shown = m.session.agents_of(w.as_ref());
        assert!(!shown[0].ostinato_park, "its own wait goes first");
        assert!(m.session.has_real_ask(w.as_ref()));
    }

    #[test]
    fn a_dismissal_holds_until_a_new_park() {
        let mut m = model(
            5,
            frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:40:00Z"),
        );
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        assert!(needs(&mut m).is_empty());
        assert!(m.session.is_needs_dismissed(w.as_ref()));
        // Another frame keeps it dismissed.
        let _ = Cockpit.update(Event::Data(data.clone()), &mut m);
        assert!(needs(&mut m).is_empty());

        // A new park: back in Needs you.
        let newer = format!(
            "{}\n{}",
            PARKED.lines().take(5).collect::<Vec<_>>().join("\n"),
            r#"{"v":1,"at":"2026-11-10T09:45:00Z","run":"r-1110","event":"parked","item":"notes-app#42","reason":"needs_decision","question":"Which?"}"#
        );
        let mut f = feed(5);
        f.records.insert(
            "example/notes-app".into(),
            RecordText::from_bytes(newer.as_bytes()),
        );
        let _ = Cockpit.update(Event::Ostinato(Box::new(f)), &mut m);
        let _ = Cockpit.update(Event::Data(data.clone()), &mut m);
        assert_eq!(needs(&mut m), ["w"]);
        assert_eq!(line(&mut m), "Your turn: Ostinato parked 2 issues");
    }

    #[test]
    fn a_dismissed_park_leaves_the_card_free_to_read_ready() {
        let mut d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:40:00Z");
        if let Some(w) = d.workspaces.as_mut().and_then(|ws| ws.first_mut()) {
            w.unread = Some(2.0);
        }
        let mut m = model(5, d);
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        assert!(m.session.has_real_ask(w.as_ref()), "the park waits");
        m.session.dismiss_needs(w.as_ref());
        assert!(!m.session.has_real_ask(w.as_ref()));
        assert!(m.session.is_needs_dismissed(w.as_ref()), "still restorable");
        assert_eq!(m.session.status_kind(&data, w.as_ref()), StatusKind::Ready);
    }

    #[test]
    fn a_park_picked_again_waits_no_more_and_its_dismissal_lapses() {
        let mut m = model(
            5,
            frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:40:00Z"),
        );
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned().unwrap();
        m.session.dismiss_needs(Some(&w));
        assert!(
            m.session
                .park_dismissal_holds(&w, at("2026-11-10T09:31:10Z"))
        );
        // The second run picks #41 again: its park is the run before's.
        let _ = Cockpit.update(Event::Ostinato(Box::new(feed(16))), &mut m);
        let _ = Cockpit.update(Event::Data(data), &mut m);
        assert!(needs(&mut m).is_empty());
        assert!(
            !m.session
                .park_dismissal_holds(&w, at("2026-11-10T09:31:10Z"))
        );
    }

    #[test]
    fn a_dismissal_seeded_before_the_records_arrive_is_kept() {
        let s = Session::default();
        let w = Workspace {
            id: "w".into(),
            directory: Some("/dev/notes-app".into()),
            ..Workspace::default()
        };
        assert!(s.park_dismissal_holds(&w, 1.0));
    }
}
