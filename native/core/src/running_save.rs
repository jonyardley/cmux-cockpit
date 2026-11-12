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
use crate::persist::{SavedCount, SavedRunning};
use crate::running::running_work;
use crate::session::Session;

/// What the core sent for the `running` map since it last read the file.
#[derive(Debug, Clone, Default)]
pub struct RunningSaves {
    sent: BTreeMap<String, Option<SavedRunning>>,
}

impl RunningSaves {
    /// A new state file: what was sent is forgotten, so an entry the file
    /// still does not show (a write that failed, or another writer's) goes
    /// out again on the next update that differs from it.
    pub fn file_read(&mut self) {
        self.sent.clear();
    }

    /// The writes that bring `file` (the `running` map as last read) to
    /// `now`: each verdict it does not hold, and None for each entry it
    /// holds that `now` has not, less what was already sent. Marks them
    /// sent.
    pub fn writes(
        &mut self,
        file: &BTreeMap<String, SavedRunning>,
        now: &BTreeMap<String, SavedRunning>,
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
            .filter(|(id, v)| self.sent.get(id) != Some(v))
            .collect();
        self.sent
            .extend(out.iter().map(|(id, v)| (id.clone(), v.clone())));
        out
    }
}

/// Each workspace's verdict in `data`: its card's agent and the work that
/// agent's chat runs, for every workspace whose chat runs any. None when
/// the frame lists no workspaces, so a frame that briefly lacks them
/// never deletes every saved verdict.
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
        out.insert(
            w.id.clone(),
            SavedRunning {
                agent: a.id.clone(),
                since: r.since,
                counts,
            },
        );
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

        let first = saves.writes(&file, &now);
        let want: BTreeMap<String, Option<SavedRunning>> = [
            ("w2".to_string(), Some(two.clone())),
            ("w9".to_string(), None),
        ]
        .into();
        assert_eq!(first, want, "w1 is in the file already");
        assert!(saves.writes(&file, &now).is_empty(), "sent, not yet read");

        // A change before the file catches up still goes out.
        let changed = map(&[("w1", one.clone()), ("w2", one.clone())]);
        let next = saves.writes(&file, &changed);
        assert_eq!(next.get("w2"), Some(&Some(one.clone())));
        assert_eq!(next.len(), 1);

        // A read that still lacks it sends it again; one that holds it, nothing.
        saves.file_read();
        assert_eq!(saves.writes(&file, &changed).len(), 2);
        saves.file_read();
        assert!(saves.writes(&changed, &changed).is_empty());
    }
}
