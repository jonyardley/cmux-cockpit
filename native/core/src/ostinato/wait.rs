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
//! A park waits, whichever run wrote it, until a later line picks its
//! item again (run.rs `waiting_parks`). One dismissal covers the
//! record's parks, under `OSTINATO_KEY`, keyed on the newest park's
//! time: only a park newer than that brings the card back, so picking
//! the newest again leaves the older ones dismissed, and the words count
//! only the parks newer than it. The dismissal is saved on the workspace
//! that carries the record and follows the run: when another workspace
//! in the checkout takes the record over (its carrier fell asleep or
//! closed, say), the dismissal moves to it. Only the core that draws the
//! sidebar moves one; the pane's takes the move from the state file. The
//! park is read once a frame, at the frame's clock (`Session::tend_parks`).

use crate::activity::most_active;
use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::session::Session;
use crate::text::clip;

use super::run::RunState;
use super::{Record, RecordState};

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
    /// Each waiting park's time.
    pub times: Vec<f64>,
    /// The workspace is awake: an asleep one waits on nobody by design.
    pub waits: bool,
}

impl ParkWait {
    /// The oldest waiting park's time: a dismissal made at or after it
    /// still covers that park, though a newer one shows now.
    pub fn oldest(&self) -> f64 {
        self.times.iter().copied().fold(self.key, f64::min)
    }

    /// What the card says waits, `dismissed` the key of the dismissal on
    /// its parks: "Ostinato parked notes-app#41", or "Ostinato parked 2
    /// issues". Only the parks newer than the dismissal count, as those
    /// are what brought the card back; with none newer, all of them.
    pub fn words(&self, dismissed: Option<f64>) -> String {
        let newer = dismissed.map_or(0, |key| self.times.iter().filter(|t| **t > key).count());
        let count = if newer == 0 { self.times.len() } else { newer };
        match count {
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
    /// Reads each workspace's parked attempts at the frame's clock,
    /// first moving a park dismissal to the workspace carrying its record
    /// when `owns`: only the core that draws the sidebar moves and saves
    /// one, so the pane's, which can see a sleep call's carrier a moment
    /// apart, never moves it back; it takes the move from the state file.
    pub(crate) fn tend_parks(&mut self, data: &Data, owns: bool) {
        let read: Vec<(&Workspace, RecordState)> = data
            .workspace_list()
            .iter()
            .filter_map(|w| self.ostinato_run(data, w).map(|state| (w, state)))
            .collect();
        // Most frames have no park dismissal to move.
        if owns
            && self
                .dismissed
                .values()
                .any(|d| d.contains_key(OSTINATO_KEY))
        {
            for (w, _) in &read {
                self.carry_park_dismissal(data, w);
            }
        }
        let mut found = std::collections::HashMap::new();
        let mut cards = std::collections::HashSet::new();
        for (w, state) in read {
            cards.insert(w.id.clone());
            let Some(run) = state.run else { continue };
            let Some(newest) = run.waiting.iter().max_by(|a, b| a.at.total_cmp(&b.at)) else {
                continue;
            };
            found.insert(
                w.id.clone(),
                ParkWait {
                    key: self.park_key(&w.id, newest.at),
                    item: newest.item.clone(),
                    times: run.waiting.iter().map(|p| p.at).collect(),
                    waits: self.sleep_kind(&w.id).is_none(),
                },
            );
        }
        self.parks = found;
        self.park_cards = cards;
    }

    /// Moves each park dismissal made on this record's parks, wherever
    /// it is saved, onto `carrier`, the workspace carrying the record now,
    /// so a dismissal follows the run rather than staying where it was
    /// made: on another workspace in the checkout, or one that has closed
    /// (before a restart even). A dismissal's key is the time of a park
    /// it was made on, so the record that parked then is its own; one
    /// with no such park here stays where it is. A workspace open on a
    /// checkout whose own record also parked then keeps its dismissal,
    /// so two records that parked in the same second never trade one
    /// back and forth. Two meet as the later key, which covers what both
    /// did. A dismissal saved before this moves the same way.
    fn carry_park_dismissal(&mut self, data: &Data, carrier: &Workspace) {
        let Some(record) = carrier
            .directory
            .as_deref()
            .and_then(|d| self.ostinato.record_for(d))
        else {
            return;
        };
        let from: Vec<String> = self
            .dismissed
            .iter()
            .filter(|(id, _)| **id != carrier.id)
            .filter_map(|(id, d)| d.get(OSTINATO_KEY).map(|key| (id, *key)))
            .filter(|(id, key)| {
                record.parked_at(*key) && !self.parked_elsewhere(data, id, *key, record)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in from {
            self.move_park_dismissal(&id, &carrier.id);
        }
    }

    /// Whether workspace `ws` is open on a main checkout whose own record,
    /// not `record`, parked at `key` too.
    fn parked_elsewhere(&self, data: &Data, ws: &str, key: f64, record: &Record) -> bool {
        data.ws_by_id(ws)
            .and_then(|w| w.directory.as_deref())
            .and_then(|d| self.ostinato.record_for(d))
            .is_some_and(|own| !std::ptr::eq(own, record) && own.parked_at(key))
    }

    /// Moves workspace `from`'s park dismissal to workspace `to`, saving
    /// both.
    fn move_park_dismissal(&mut self, from: &str, to: &str) {
        let Some(starts) = self.dismissed.get_mut(from) else {
            return;
        };
        let Some(key) = starts.shift_remove(OSTINATO_KEY) else {
            return;
        };
        if starts.is_empty() {
            self.dismissed.shift_remove(from);
        }
        let starts = self.dismissed.entry(to.to_string()).or_default();
        let held = starts.get(OSTINATO_KEY).map_or(key, |k| k.max(key));
        starts.insert(OSTINATO_KEY.to_string(), held);
        self.persist_dismissed(from);
        self.persist_dismissed(to);
    }

    /// The key of the park dismissal saved on workspace `ws`, if any.
    fn park_dismissal(&self, ws: &str) -> Option<f64> {
        self.dismissed
            .get(ws)
            .and_then(|d| d.get(OSTINATO_KEY))
            .copied()
    }

    /// The key `ws`'s parks wait under, `newest` the newest waiting
    /// park's time: a dismissal's own key while no park newer than the
    /// one it was made on waits, so picking the newest park again leaves
    /// the older ones dismissed; else `newest`.
    fn park_key(&self, ws: &str, newest: f64) -> f64 {
        self.park_dismissal(ws)
            .filter(|key| *key >= newest)
            .unwrap_or(newest)
    }

    /// Whether a park dismissal saved at `key` still holds for `w`: a
    /// park it covers still waits (one at or before `key`), though a
    /// newer one may show now and stays dismissed once that one is
    /// picked again; or `w`'s card carried no record at the last read
    /// (none read yet, before the runner's first feed, say; when another
    /// workspace in the checkout carries it, the dismissal has moved
    /// there). It lapses once no park it covers waits.
    pub(crate) fn park_dismissal_holds(&self, w: &Workspace, key: f64) -> bool {
        match self.parks.get(&w.id) {
            Some(p) => p.key == key || p.oldest() <= key,
            None => !self.park_cards.contains(&w.id),
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

    /// The question `w`'s card shows while its park waits in Needs you:
    /// the newest waiting park's in `run`, `w`'s record's latest run,
    /// though an earlier run parked it. None when no park shows; the
    /// card then shows its own run's newest waiting park's (card.rs).
    pub fn park_question<'r>(&self, w: Option<&Workspace>, run: &'r RunState) -> Option<&'r str> {
        self.park_shown(w)?;
        run.waiting
            .iter()
            .max_by(|a, b| a.at.total_cmp(&b.at))
            .map(|p| p.question.as_str())
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
        let (Some(w), Some(p)) = (w, self.park_shown(w)) else {
            return String::new();
        };
        clip(&p.words(self.park_dismissal(&w.id)), max)
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
        // Only the new park counts: #41 was dismissed.
        assert_eq!(line(&mut m), "Your turn: Ostinato parked notes-app#42");
        // Restored, both wait again.
        m.session.restore_needs(w.as_ref());
        assert_eq!(line(&mut m), "Your turn: Ostinato parked 2 issues");
    }

    /// The parked sample's first five lines (#41 parked at 09:31:10),
    /// then a park line for each of `parks`, an item and its time.
    fn with_parks(parks: &[(&str, &str)]) -> String {
        let mut text = PARKED.lines().take(5).collect::<Vec<_>>().join("\n");
        for (item, when) in parks {
            text.push('\n');
            text.push_str(&format!(
                r#"{{"v":1,"at":"{when}","run":"r-1110","event":"parked","item":"{item}","reason":"needs_decision","question":"Which?"}}"#
            ));
        }
        text
    }

    #[test]
    fn the_words_count_only_the_parks_newer_than_the_dismissal() {
        let d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T10:30:00Z");
        let two = with_parks(&[("notes-app#42", "2026-11-10T09:45:00Z")]);
        let mut m = model_of(&two, d.clone());
        assert_eq!(line(&mut m), "Your turn: Ostinato parked 2 issues");
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        assert!(needs(&mut m).is_empty());

        // Two newer parks: "2 issues", not the four that wait.
        let four = with_parks(&[
            ("notes-app#42", "2026-11-10T09:45:00Z"),
            ("notes-app#43", "2026-11-10T10:00:00Z"),
            ("notes-app#44", "2026-11-10T10:05:00Z"),
        ]);
        refeed(&mut m, &four, &d);
        assert_eq!(needs(&mut m), ["w"]);
        assert_eq!(line(&mut m), "Your turn: Ostinato parked 2 issues");
        // #44 picked again: #43 alone is new, and named.
        let picked = format!(
            "{four}\n{}",
            r#"{"v":1,"at":"2026-11-10T10:10:00Z","run":"r-1110","event":"picked","item":"notes-app#44","attempt":2}"#,
        );
        refeed(&mut m, &picked, &d);
        assert_eq!(line(&mut m), "Your turn: Ostinato parked notes-app#43");
        // Restored, all three that wait count.
        m.session.restore_needs(w.as_ref());
        assert_eq!(line(&mut m), "Your turn: Ostinato parked 3 issues");
    }

    #[test]
    fn with_no_dismissal_every_waiting_park_counts() {
        let p = ParkWait {
            key: 30.0,
            item: "notes-app#43".into(),
            times: vec![10.0, 20.0, 30.0],
            waits: true,
        };
        assert_eq!(p.words(None), "Ostinato parked 3 issues");
        assert_eq!(p.words(Some(20.0)), "Ostinato parked notes-app#43");
        assert_eq!(p.words(Some(10.0)), "Ostinato parked 2 issues");
        // A dismissal covering them all (none shows then) counts them all.
        assert_eq!(p.words(Some(30.0)), "Ostinato parked 3 issues");
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

    /// The model fed `text` as the record and then `d`.
    fn model_of(text: &str, d: crate::data::Data) -> Model {
        let mut f = feed(0);
        f.records.insert(
            "example/notes-app".into(),
            RecordText::from_bytes(text.as_bytes()),
        );
        let mut m = Model::default();
        let _ = Cockpit.update(Event::Ostinato(Box::new(f)), &mut m);
        let _ = Cockpit.update(Event::Data(d), &mut m);
        m
    }

    #[test]
    fn a_park_waits_past_its_run_until_its_item_is_picked_again() {
        // The first run parks #41 and ends; the next one starts and picks
        // #43, not #41.
        let first: Vec<&str> = PARKED.lines().take(13).collect();
        let text = format!(
            "{}\n{}\n{}",
            first.join("\n"),
            r#"{"v":1,"at":"2026-11-11T08:00:00Z","run":"r-1111","event":"run_started","project":"example/notes-app","caps":{"issues":3,"session_hours":3}}"#,
            r#"{"v":1,"at":"2026-11-11T08:00:15Z","run":"r-1111","event":"picked","item":"notes-app#43","attempt":1}"#,
        );
        let d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-11T08:30:00Z");
        let mut m = model_of(&text, d.clone());
        assert_eq!(needs(&mut m), ["w"]);
        assert_eq!(line(&mut m), "Your turn: Ostinato parked notes-app#41");
        // The card shows its question, though the run on it did not park.
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        let run = m
            .session
            .ostinato_run(&data, w.as_ref().unwrap())
            .unwrap()
            .run
            .unwrap();
        assert!(run.parks.is_empty());
        assert_eq!(
            m.session.park_question(w.as_ref(), &run),
            Some(
                "May the session run the database migration script, or should it stop at the plan?"
            )
        );
        m.session.dismiss_needs(w.as_ref());
        assert_eq!(m.session.park_question(w.as_ref(), &run), None, "dismissed");

        // Picking #41 again ends the wait.
        let again = format!(
            "{text}\n{}",
            r#"{"v":1,"at":"2026-11-11T09:00:00Z","run":"r-1111","event":"picked","item":"notes-app#41","attempt":2}"#,
        );
        let mut m = model_of(&again, d);
        assert!(needs(&mut m).is_empty());
    }

    #[test]
    fn picking_the_newest_park_again_leaves_the_older_dismissed() {
        let two = format!(
            "{}\n{}",
            PARKED.lines().take(5).collect::<Vec<_>>().join("\n"),
            r#"{"v":1,"at":"2026-11-10T09:45:00Z","run":"r-1110","event":"parked","item":"notes-app#42","reason":"needs_decision","question":"Which?"}"#
        );
        let d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:50:00Z");
        let mut m = model_of(&two, d.clone());
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        assert!(needs(&mut m).is_empty());

        // #42, the newer park, is picked again; #41 still waits, dismissed.
        let picked = format!(
            "{two}\n{}",
            r#"{"v":1,"at":"2026-11-10T09:55:00Z","run":"r-1110","event":"picked","item":"notes-app#42","attempt":2}"#,
        );
        let mut f = feed(0);
        f.records.insert(
            "example/notes-app".into(),
            RecordText::from_bytes(picked.as_bytes()),
        );
        let _ = Cockpit.update(Event::Ostinato(Box::new(f)), &mut m);
        let _ = Cockpit.update(Event::Data(d.clone()), &mut m);
        assert!(needs(&mut m).is_empty(), "the older park stays dismissed");
        assert!(m.session.is_needs_dismissed(w.as_ref()), "still restorable");

        // A newer park than the dismissed one brings the card back.
        let newer = format!(
            "{picked}\n{}",
            r#"{"v":1,"at":"2026-11-10T10:05:00Z","run":"r-1110","event":"parked","item":"notes-app#42","reason":"needs_decision","question":"Which now?"}"#,
        );
        let mut f = feed(0);
        f.records.insert(
            "example/notes-app".into(),
            RecordText::from_bytes(newer.as_bytes()),
        );
        let _ = Cockpit.update(Event::Ostinato(Box::new(f)), &mut m);
        let _ = Cockpit.update(Event::Data(d), &mut m);
        assert_eq!(needs(&mut m), ["w"]);
    }

    /// Feeds `text` as the record and `d` as the frame to `m`.
    fn refeed(m: &mut Model, text: &str, d: &crate::data::Data) {
        let mut f = feed(0);
        f.records.insert(
            "example/notes-app".into(),
            RecordText::from_bytes(text.as_bytes()),
        );
        let _ = Cockpit.update(Event::Ostinato(Box::new(f)), m);
        let _ = Cockpit.update(Event::Data(d.clone()), m);
    }

    #[test]
    fn a_newer_park_picked_again_leaves_the_dismissed_ones_dismissed() {
        let two = format!(
            "{}\n{}",
            PARKED.lines().take(5).collect::<Vec<_>>().join("\n"),
            r#"{"v":1,"at":"2026-11-10T09:45:00Z","run":"r-1110","event":"parked","item":"notes-app#42","reason":"needs_decision","question":"Which?"}"#
        );
        let d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T10:30:00Z");
        let mut m = model_of(&two, d.clone());
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        assert!(needs(&mut m).is_empty());

        // A third park brings the card back...
        let three = format!(
            "{two}\n{}",
            r#"{"v":1,"at":"2026-11-10T10:00:00Z","run":"r-1110","event":"parked","item":"notes-app#43","reason":"needs_decision","question":"Where?"}"#,
        );
        refeed(&mut m, &three, &d);
        assert_eq!(needs(&mut m), ["w"]);
        // ...and once it is picked again, the two Jon dismissed stay so.
        let picked = format!(
            "{three}\n{}",
            r#"{"v":1,"at":"2026-11-10T10:10:00Z","run":"r-1110","event":"picked","item":"notes-app#43","attempt":2}"#,
        );
        refeed(&mut m, &picked, &d);
        assert!(needs(&mut m).is_empty());
    }

    /// The frame with `w` (idle agent "a") and `w2` (no session) both
    /// open on /dev/notes-app, `w` first in tab order.
    fn two_frame() -> crate::data::Data {
        let mut d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:40:00Z");
        if let Some(ws) = d.workspaces.as_mut() {
            ws.push(Workspace {
                id: "w2".into(),
                directory: Some("/dev/notes-app".into()),
                ..Workspace::default()
            });
        }
        d
    }

    /// `m` as the core that draws the sidebar, the one that moves a
    /// park dismissal.
    fn sidebar(mut m: Model) -> Model {
        let _ = Cockpit.update(Event::PanelOn, &mut m);
        m
    }

    fn asleep() -> crate::persist::SavedAsleep {
        crate::persist::SavedAsleep {
            surfaces: Vec::new(),
            since: at("2026-11-10T09:41:00Z"),
        }
    }

    /// The park dismissal saved on each workspace that has one.
    fn park_dismissals(m: &Model) -> Vec<(String, f64)> {
        m.session
            .dismissed
            .iter()
            .filter_map(|(ws, d)| d.get(OSTINATO_KEY).map(|k| (ws.clone(), *k)))
            .collect()
    }

    /// The write last asked for under `key`, if any.
    fn written(m: &Model, key: &str) -> Option<Option<serde_json::Value>> {
        m.session
            .pending
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    #[test]
    fn a_dismissal_follows_the_run_to_another_workspace_in_the_checkout() {
        let d = two_frame();
        let mut m = sidebar(model(5, d.clone()));
        let w = d.ws_by_id("w").cloned();
        let w2 = d.ws_by_id("w2").cloned();
        m.session.dismiss_needs(w.as_ref());
        // w sleeps: w2 carries the run, and the park stays dismissed.
        m.session.saved.asleep.insert("w".into(), asleep());
        let _ = Cockpit.update(Event::Data(d.clone()), &mut m);
        assert!(needs(&mut m).is_empty(), "the dismissal moved to w2");
        let park = at("2026-11-10T09:31:10Z");
        assert_eq!(park_dismissals(&m), [("w2".to_string(), park)]);
        assert_eq!(written(&m, "dismissed.w"), Some(None));
        assert_eq!(
            written(&m, "dismissed.w2"),
            Some(Some(
                serde_json::json!({ "ostinato": crate::js::json_num(park) })
            ))
        );
        // Restorable where it shows now.
        assert!(m.session.is_needs_dismissed(w2.as_ref()));
        m.session.restore_needs(w2.as_ref());
        assert_eq!(needs(&mut m), ["w2"]);
        m.session.dismiss_needs(w2.as_ref());
        assert!(needs(&mut m).is_empty());

        // w wakes and carries it again: the dismissal made on w2 comes too.
        m.session.saved.asleep.clear();
        let _ = Cockpit.update(Event::Data(d.clone()), &mut m);
        assert!(needs(&mut m).is_empty(), "w carries it again, dismissed");
        assert_eq!(park_dismissals(&m), [("w".to_string(), park)]);

        // A newer park still brings the card back, on the carrier.
        let newer = with_parks(&[("notes-app#42", "2026-11-10T09:45:00Z")]);
        refeed(&mut m, &newer, &d);
        assert_eq!(needs(&mut m), ["w"]);
        assert_eq!(line(&mut m), "Your turn: Ostinato parked notes-app#42");
    }

    #[test]
    fn a_moved_dismissal_lapses_once_no_park_it_covers_waits() {
        let d = two_frame();
        let mut m = sidebar(model(5, d.clone()));
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        m.session.saved.asleep.insert("w".into(), asleep());
        // #41 is picked again while w2 carries the run.
        let _ = Cockpit.update(Event::Ostinato(Box::new(feed(16))), &mut m);
        let _ = Cockpit.update(Event::Data(d.clone()), &mut m);
        assert!(needs(&mut m).is_empty());
        assert!(park_dismissals(&m).is_empty(), "it lapsed on w2");
        // w wakes to nothing dismissed for the run.
        m.session.saved.asleep.clear();
        let _ = Cockpit.update(Event::Data(d), &mut m);
        assert!(park_dismissals(&m).is_empty());
    }

    #[test]
    fn a_dismissal_follows_the_run_when_its_workspace_closes() {
        let d = two_frame();
        let mut m = sidebar(model(5, d.clone()));
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        // w closes: w2 carries the run, and the park stays dismissed.
        let mut closed = d.clone();
        if let Some(ws) = closed.workspaces.as_mut() {
            ws.retain(|x| x.id != "w");
        }
        let _ = Cockpit.update(Event::Data(closed), &mut m);
        assert!(needs(&mut m).is_empty(), "the dismissal moved to w2");
        let park = at("2026-11-10T09:31:10Z");
        assert_eq!(park_dismissals(&m), [("w2".to_string(), park)]);
        assert_eq!(written(&m, "dismissed.w"), Some(None));
    }

    #[test]
    fn the_after_run_parked_chip_counts_a_dismissed_park_too() {
        // The first run parks #41, drafts #42 and ends.
        let text = PARKED.lines().take(13).collect::<Vec<_>>().join("\n");
        let d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T11:00:00Z");
        let mut m = model_of(&text, d.clone());
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        assert!(needs(&mut m).is_empty());
        let data = m.data.clone().unwrap();
        let state = m.session.ostinato_run(&data, w.as_ref().unwrap()).unwrap();
        let card = super::super::card::run_card(&state, at("2026-11-10T11:00:00Z")).unwrap();
        let chips: Vec<&str> = card.chips.iter().map(|c| c.text.as_str()).collect();
        assert!(chips.contains(&"1 parked"), "{chips:?}");
    }

    /// A model seeded with the saved state `json` (as a state file holds
    /// it), then fed the record's first five lines and `d`.
    fn seeded(json: &str, d: &crate::data::Data) -> Model {
        seeded_in(json, d, true)
    }

    /// `seeded`, as the core that draws the sidebar when `panel`, else
    /// as the pane's.
    fn seeded_in(json: &str, d: &crate::data::Data, panel: bool) -> Model {
        let saved = crate::persist::SavedState::from_json(json).unwrap();
        let mut m = Model {
            session: Session::new(Vec::new(), saved),
            ..Model::default()
        };
        if panel {
            m = sidebar(m);
        }
        let _ = Cockpit.update(Event::Ostinato(Box::new(feed(5))), &mut m);
        let _ = Cockpit.update(Event::Data(d.clone()), &mut m);
        m
    }

    #[test]
    fn a_dismissal_saved_on_the_asleep_workspace_before_this_still_applies() {
        // A state file from before: dismissed on w, and w asleep since.
        let park = at("2026-11-10T09:31:10Z");
        let json = format!(
            r#"{{"dismissed": {{"w": {{"a": 1, "ostinato": {park}}}}},
                "asleep": {{"w": {{"surfaces": [], "since": 1}}}}}}"#
        );
        let d = two_frame();
        let mut m = seeded(&json, &d);
        assert!(needs(&mut m).is_empty(), "w2 carries it, still dismissed");
        assert_eq!(park_dismissals(&m), [("w2".to_string(), park)]);
        // w keeps its agent's dismissal; only the park's moved.
        assert_eq!(
            written(&m, "dismissed.w"),
            Some(Some(serde_json::json!({ "a": 1 })))
        );
        // A state file that has not caught up yet does not bring it back.
        let stale = crate::persist::SavedState::from_json(&json).unwrap();
        m.session.reseed(stale);
        let _ = Cockpit.update(Event::Data(d), &mut m);
        assert!(needs(&mut m).is_empty());
        assert_eq!(park_dismissals(&m), [("w2".to_string(), park)]);
    }

    #[test]
    fn a_dismissal_saved_on_a_workspace_that_does_not_carry_the_run_moves_to_the_one_that_does() {
        // From before, made on w2 while w slept; w is awake now.
        let park = at("2026-11-10T09:31:10Z");
        let json = format!(r#"{{"dismissed": {{"w2": {{"ostinato": {park}}}}}}}"#);
        let d = two_frame();
        let mut m = seeded(&json, &d);
        assert!(needs(&mut m).is_empty(), "w carries it, dismissed");
        assert_eq!(park_dismissals(&m), [("w".to_string(), park)]);
        assert_eq!(written(&m, "dismissed.w2"), Some(None));
        let w = d.ws_by_id("w").cloned();
        assert!(m.session.is_needs_dismissed(w.as_ref()));
    }

    #[test]
    fn two_saved_dismissals_in_a_checkout_meet_as_the_later() {
        let park = at("2026-11-10T09:31:10Z");
        let earlier = park - 600.0;
        let json = format!(
            r#"{{"dismissed": {{"w": {{"ostinato": {earlier}}}, "w2": {{"ostinato": {park}}}}}}}"#
        );
        let d = two_frame();
        let mut m = seeded(&json, &d);
        assert_eq!(park_dismissals(&m), [("w".to_string(), park)]);
        assert!(needs(&mut m).is_empty());
    }

    #[test]
    fn a_dismissal_left_on_a_workspace_closed_before_a_restart_moves_to_the_carrier() {
        // Saved on "gone", which closed before this session began.
        let park = at("2026-11-10T09:31:10Z");
        let json = format!(r#"{{"dismissed": {{"gone": {{"a": 1, "ostinato": {park}}}}}}}"#);
        let d = two_frame();
        let mut m = seeded(&json, &d);
        assert!(needs(&mut m).is_empty(), "w carries it, dismissed");
        assert_eq!(park_dismissals(&m), [("w".to_string(), park)]);
        assert_eq!(
            written(&m, "dismissed.gone"),
            Some(Some(serde_json::json!({ "a": 1 })))
        );
    }

    #[test]
    fn a_stray_dismissal_that_names_no_park_here_stays_where_it_is() {
        // Its key is no park of this record: another record's, say.
        let other = at("2026-11-10T09:31:10Z") - 60.0;
        let json = format!(r#"{{"dismissed": {{"gone": {{"ostinato": {other}}}}}}}"#);
        let d = two_frame();
        let mut m = seeded(&json, &d);
        assert_eq!(needs(&mut m), ["w"]);
        assert_eq!(park_dismissals(&m), [("gone".to_string(), other)]);
        assert_eq!(written(&m, "dismissed.gone"), None);
    }

    /// A model as the sidebar's core over the state file `json` and four
    /// workspaces: `w` (idle agent "a") and `w2` on /dev/notes-app, then
    /// `w3` and `w4` on /dev/other-app, whose record parked
    /// other-app#7 at `other_park`.
    fn two_checkouts(json: &str, other_park: &str) -> Model {
        let mut d = two_frame();
        if let Some(ws) = d.workspaces.as_mut() {
            for id in ["w3", "w4"] {
                ws.push(Workspace {
                    id: id.into(),
                    directory: Some("/dev/other-app".into()),
                    ..Workspace::default()
                });
            }
        }
        let other: String = PARKED
            .lines()
            .take(5)
            .collect::<Vec<_>>()
            .join("\n")
            .replace("notes-app", "other-app")
            .replace("#41", "#7")
            .replace("2026-11-10T09:31:10Z", other_park);
        let mut f = feed(5);
        f.records.insert(
            "example/other-app".into(),
            RecordText::from_bytes(other.as_bytes()),
        );
        f.checkouts
            .insert("/dev/other-app".into(), "example/other-app".into());
        let saved = crate::persist::SavedState::from_json(json).unwrap();
        let mut m = sidebar(Model {
            session: Session::new(Vec::new(), saved),
            ..Model::default()
        });
        let _ = Cockpit.update(Event::Ostinato(Box::new(f)), &mut m);
        let _ = Cockpit.update(Event::Data(d), &mut m);
        m
    }

    #[test]
    fn a_dismissal_on_another_checkout_goes_to_its_own_record_and_hides_nothing_there() {
        // w4, on other-app's checkout, holds notes-app's dismissal (it was
        // open on notes-app's when it was made). other-app#7 parked
        // earlier than that key, so on w3 it would hide #7.
        let park = at("2026-11-10T09:31:10Z");
        let json = format!(r#"{{"dismissed": {{"w4": {{"ostinato": {park}}}}}}}"#);
        let mut m = two_checkouts(&json, "2026-11-10T09:20:00Z");
        assert_eq!(park_dismissals(&m), [("w".to_string(), park)]);
        assert_eq!(needs(&mut m), ["w3"], "#7 waits on other-app's carrier");
    }

    #[test]
    fn two_records_that_parked_in_the_same_second_keep_their_own_dismissals() {
        // Both records parked at 09:31:10: w3's dismissal is its own
        // record's, and stays, written nowhere.
        let park = at("2026-11-10T09:31:10Z");
        let json = format!(r#"{{"dismissed": {{"w3": {{"ostinato": {park}}}}}}}"#);
        let mut m = two_checkouts(&json, "2026-11-10T09:31:10Z");
        assert_eq!(park_dismissals(&m), [("w3".to_string(), park)]);
        assert_eq!(written(&m, "dismissed.w3"), None);
        assert_eq!(needs(&mut m), ["w"]);
    }

    #[test]
    fn the_panes_core_leaves_the_move_to_the_sidebars() {
        // Dismissed on w, asleep since: the pane's core moves nothing and
        // saves nothing, so it never moves a dismissal back while it sees
        // a different carrier for a moment.
        let park = at("2026-11-10T09:31:10Z");
        let asleep = r#""asleep": {"w": {"surfaces": [], "since": 1}}"#;
        let json = format!(r#"{{"dismissed": {{"w": {{"ostinato": {park}}}}}, {asleep}}}"#);
        let d = two_frame();
        let mut m = seeded_in(&json, &d, false);
        assert_eq!(park_dismissals(&m), [("w".to_string(), park)]);
        assert!(m.session.pending.is_empty(), "{:?}", m.session.pending);
        assert_eq!(needs(&mut m), ["w2"]);
        // The sidebar's move reaches it through the state file.
        let moved = format!(r#"{{"dismissed": {{"w2": {{"ostinato": {park}}}}}, {asleep}}}"#);
        m.session
            .reseed(crate::persist::SavedState::from_json(&moved).unwrap());
        let _ = Cockpit.update(Event::Data(d), &mut m);
        assert!(needs(&mut m).is_empty());
        assert_eq!(park_dismissals(&m), [("w2".to_string(), park)]);
    }

    #[test]
    fn an_asleep_workspace_hands_the_park_to_an_awake_one_in_the_checkout() {
        let mut d = frame(Vec::new(), "2026-11-10T09:40:00Z");
        if let Some(ws) = d.workspaces.as_mut() {
            let second = Workspace {
                id: "w2".into(),
                directory: Some("/dev/notes-app".into()),
                ..Workspace::default()
            };
            ws.push(second);
        }
        let mut m = model(5, d.clone());
        assert_eq!(needs(&mut m), ["w"], "the first in tab order");
        m.session.saved.asleep.insert(
            "w".into(),
            crate::persist::SavedAsleep {
                surfaces: Vec::new(),
                since: at("2026-11-10T09:35:00Z"),
            },
        );
        let _ = Cockpit.update(Event::Data(d), &mut m);
        assert_eq!(needs(&mut m), ["w2"]);
    }

    #[test]
    fn a_dismissal_made_while_asleep_keeps_the_park_dismissed() {
        let d = frame(vec![agent("a", AgentStatus::Idle)], "2026-11-10T09:40:00Z");
        let mut m = model(5, d);
        let data = m.data.clone().unwrap();
        let w = data.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        // Asleep, the park waits on nobody; an ask there is dismissed too.
        m.session.saved.asleep.insert(
            "w".into(),
            crate::persist::SavedAsleep {
                surfaces: Vec::new(),
                since: at("2026-11-10T09:41:00Z"),
            },
        );
        let asking = Agent {
            since_epoch: Some(at("2026-11-10T09:42:00Z")),
            last_activity_at: Some(at("2026-11-10T09:42:00Z")),
            ..agent("a", AgentStatus::NeedsInput)
        };
        let d = frame(vec![asking], "2026-11-10T09:43:00Z");
        let _ = Cockpit.update(Event::Data(d.clone()), &mut m);
        let w = d.ws_by_id("w").cloned();
        m.session.dismiss_needs(w.as_ref());
        // Awake again: the park stays dismissed.
        m.session.saved.asleep.clear();
        let _ = Cockpit.update(Event::Data(d), &mut m);
        assert!(m.session.park_shown(w.as_ref()).is_none());
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
