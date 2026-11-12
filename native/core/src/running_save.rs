//! The core's background verdict, saved for the agents panel (#360), as
//! the PR poll's answers are since #300: the panel reads only
//! config/state.json, so the core writes what each card's chat runs
//! (`crate::running::running_work`) into its `running` map, and the panel
//! says Running from it rather than from a rule of its own. On 12 November
//! the panel said Working while the card said Idle; with one verdict they
//! cannot disagree, the panel lagging by one paced rebuild.
//!
//! What is saved is the record, never the status: the card's agent, when
//! its earliest work started, and how many of each kind run. The panel
//! applies the card's rule on top, Running while that agent is idle, from
//! cmux's live status, so a turn starting or ending writes nothing. Only
//! a change goes out: an entry the file as last read does not already
//! hold, and not one already sent since that read, since `update` runs on
//! every frame and click.

use std::collections::BTreeMap;

use crate::data::Data;
use crate::persist::{SavedCount, SavedRunning, is_id};
use crate::running::running_work;
use crate::session::Session;

/// How long a sent write waits for the file to show it before it goes
/// out again, in seconds of the frame's clock: a save that failed (the
/// state file's lock held, no node) is retried rather than lost until some
/// other writer changes the file. Well past the watcher's poll and the
/// script's own lock wait, so a save that worked is never sent twice.
pub const RESEND_SECS: f64 = 60.0;

/// What the core sent for the `running` map since it last read the file,
/// and when, by the frame's clock.
#[derive(Debug, Clone, Default)]
pub struct RunningSaves {
    sent: BTreeMap<String, (Option<SavedRunning>, Option<f64>)>,
}

impl RunningSaves {
    /// A new state file: what was sent is forgotten, so an entry the file
    /// still does not show (a write that failed, or another writer's) goes
    /// out again on the next update that differs from it.
    pub fn file_read(&mut self) {
        self.sent.clear();
    }

    /// Whether `v` went out for `id` less than RESEND_SECS before `epoch`.
    /// Without a clock on either side, a send holds until the next read.
    fn sent_lately(&self, id: &str, v: &Option<SavedRunning>, epoch: Option<f64>) -> bool {
        match self.sent.get(id) {
            Some((was, at)) if was == v => match (*at, epoch) {
                (Some(at), Some(now)) => now - at < RESEND_SECS,
                _ => true,
            },
            _ => false,
        }
    }

    /// The writes that bring `file` (the `running` map as last read) to
    /// `now`: each verdict it does not hold, and None for each entry it
    /// holds that `now` has not, less what was sent within RESEND_SECS of
    /// `epoch` (the frame's clock). Marks them sent at `epoch`.
    pub fn writes(
        &mut self,
        file: &BTreeMap<String, SavedRunning>,
        now: &BTreeMap<String, SavedRunning>,
        epoch: Option<f64>,
    ) -> BTreeMap<String, Option<SavedRunning>> {
        let set = now
            .iter()
            .filter(|(id, v)| file.get(*id) != Some(*v))
            .map(|(id, v)| (id.clone(), Some(v.clone())));
        let gone = file
            .keys()
            .filter(|id| !now.contains_key(*id))
            .map(|id| (id.clone(), None));
        let out: BTreeMap<String, Option<SavedRunning>> = set
            .chain(gone)
            .filter(|(id, v)| !self.sent_lately(id, v, epoch))
            .collect();
        self.sent
            .extend(out.iter().map(|(id, v)| (id.clone(), (v.clone(), epoch))));
        out
    }
}

/// Each workspace's verdict in `data`: its card's agent and the work that
/// agent's chat runs, for every workspace whose chat runs any. None when
/// the frame lists no workspaces, so a frame that briefly lacks them
/// never deletes every saved verdict. Only a verdict the state file's
/// contract keeps (`SavedRunning::fits`, an id for the workspace) is
/// given, so the script never refuses one that would then go out again.
pub fn verdicts(session: &mut Session, data: &Data) -> Option<BTreeMap<String, SavedRunning>> {
    let list = data.workspaces.as_deref().filter(|l| !l.is_empty())?;
    let mut out = BTreeMap::new();
    for w in list {
        let Some(a) = session.agent_of(Some(w)) else {
            continue;
        };
        let Some(r) = running_work(&session.saved, data, Some(w), Some(&a)) else {
            continue;
        };
        let counts = r
            .counts
            .into_iter()
            .map(|(kind, n)| SavedCount { kind, n })
            .collect();
        let v = SavedRunning {
            agent: a.id.clone(),
            since: r.since,
            counts,
        };
        if is_id(&w.id) && v.fits() {
            out.insert(w.id.clone(), v);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{Agent, AgentStatus, Workspace};
    use crate::persist::{SavedState, TaskType};

    fn verdict(agent: &str, since: f64, counts: &[(TaskType, usize)]) -> SavedRunning {
        SavedRunning {
            agent: agent.to_string(),
            since,
            counts: counts
                .iter()
                .map(|(kind, n)| SavedCount { kind: *kind, n: *n })
                .collect(),
        }
    }

    fn map(entries: &[(&str, SavedRunning)]) -> BTreeMap<String, SavedRunning> {
        entries
            .iter()
            .map(|(id, v)| ((*id).to_string(), v.clone()))
            .collect()
    }

    fn chat(id: &str, status: AgentStatus) -> Agent {
        Agent {
            id: id.to_string(),
            status: Some(status),
            ..Agent::default()
        }
    }

    fn ws(id: &str, agents: &[Agent]) -> Workspace {
        Workspace {
            id: id.to_string(),
            agents: Some(agents.iter().cloned().map(Some).collect()),
            ..Workspace::default()
        }
    }

    fn session(json: &str) -> Session {
        let mut s = Session::default();
        s.reseed(SavedState::from_json(json).unwrap());
        s
    }

    #[test]
    fn counts_each_card_chats_work_by_kind_from_the_earliest_start() {
        let mut s = session(
            r#"{"background": {"w1": [
                {"id": "b1", "type": "shell", "status": "running", "description": "d",
                 "session": "c", "startedEpoch": 200, "seenEpoch": 900},
                {"id": "m1", "type": "monitor", "status": "running", "description": "d",
                 "session": "c", "startedEpoch": 300, "seenEpoch": 900},
                {"id": "a1", "type": "subagent", "status": "running", "description": "d",
                 "session": "c", "startedEpoch": 100, "seenEpoch": 900}
            ]}}"#,
        );
        let data = Data {
            workspaces: Some(vec![
                ws("w1", &[chat("c", AgentStatus::Working)]),
                ws("w2", &[chat("d", AgentStatus::Idle)]),
            ]),
            ..Data::default()
        };
        let want = map(&[(
            "w1",
            verdict("c", 100.0, &[(TaskType::Shell, 2), (TaskType::Subagent, 1)]),
        )]);
        assert_eq!(
            verdicts(&mut s, &data),
            Some(want),
            "the agent's status aside"
        );
    }

    #[test]
    fn says_nothing_for_a_frame_with_no_workspaces() {
        let mut s = Session::default();
        assert_eq!(verdicts(&mut s, &Data::default()), None);
        let empty = Data {
            workspaces: Some(Vec::new()),
            ..Data::default()
        };
        assert_eq!(verdicts(&mut s, &empty), None);
    }

    #[test]
    fn writes_only_what_the_file_lacks_and_only_once_until_the_next_read() {
        let mut saves = RunningSaves::default();
        let one = verdict("c", 100.0, &[(TaskType::Shell, 1)]);
        let two = verdict("c", 100.0, &[(TaskType::Shell, 2)]);
        let file = map(&[("w1", one.clone()), ("w9", one.clone())]);
        let now = map(&[("w1", one.clone()), ("w2", two.clone())]);

        let first = saves.writes(&file, &now, Some(1000.0));
        let want: BTreeMap<String, Option<SavedRunning>> = [
            ("w2".to_string(), Some(two.clone())),
            ("w9".to_string(), None),
        ]
        .into();
        assert_eq!(first, want, "w1 is in the file already");
        assert!(
            saves.writes(&file, &now, Some(1000.0)).is_empty(),
            "sent, not yet read"
        );

        // A change before the file catches up still goes out.
        let changed = map(&[("w1", one.clone()), ("w2", one.clone())]);
        let next = saves.writes(&file, &changed, Some(1000.0));
        assert_eq!(next.get("w2"), Some(&Some(one.clone())));
        assert_eq!(next.len(), 1);

        // A read that still lacks it sends it again; one that holds it, nothing.
        saves.file_read();
        assert_eq!(saves.writes(&file, &changed, Some(1000.0)).len(), 2);
        saves.file_read();
        assert!(saves.writes(&changed, &changed, Some(1000.0)).is_empty());
    }

    #[test]
    fn sends_a_write_the_file_still_lacks_again_after_a_minute() {
        let mut saves = RunningSaves::default();
        let one = verdict("c", 100.0, &[(TaskType::Shell, 1)]);
        let file = BTreeMap::new();
        let now = map(&[("w1", one.clone())]);
        assert_eq!(saves.writes(&file, &now, Some(1000.0)).len(), 1);
        let soon = 1000.0 + RESEND_SECS - 1.0;
        assert!(saves.writes(&file, &now, Some(soon)).is_empty(), "too soon");
        let late = 1000.0 + RESEND_SECS;
        assert_eq!(
            saves.writes(&file, &now, Some(late)).len(),
            1,
            "the save failed"
        );
        assert!(
            saves.writes(&file, &now, Some(late + 1.0)).is_empty(),
            "sent again, held again"
        );
        // Once the file shows it, nothing, however late.
        saves.file_read();
        assert!(saves.writes(&now, &now, Some(late + 600.0)).is_empty());
        // With no clock, a send holds until the next read.
        let mut quiet = RunningSaves::default();
        assert_eq!(quiet.writes(&file, &now, None).len(), 1);
        assert!(quiet.writes(&file, &now, None).is_empty());
    }

    #[test]
    fn never_gives_a_verdict_the_file_would_refuse() {
        // The file's own reader never yields such a workspace id, so the
        // state is built past it, as a bad write could leave it in memory.
        let json = r#"{"background": {"w1": [
            {"id": "b1", "type": "shell", "status": "running", "description": "d",
             "session": "c", "startedEpoch": 200, "seenEpoch": 900}
        ]}}"#;
        let mut state = SavedState::from_json(json).unwrap();
        let long = "w".repeat(129);
        let tasks = state.background.get("w1").cloned().unwrap_or_default();
        state.background.insert(long.clone(), tasks);
        let mut s = Session::default();
        s.reseed(state);
        let data = Data {
            workspaces: Some(vec![
                ws("w1", &[chat("c", AgentStatus::Idle)]),
                ws(&long, &[chat("c", AgentStatus::Idle)]),
            ]),
            ..Data::default()
        };
        let got = verdicts(&mut s, &data).unwrap_or_default();
        assert_eq!(
            got.keys().collect::<Vec<_>>(),
            ["w1"],
            "an id past 128 would be refused"
        );
    }
}
