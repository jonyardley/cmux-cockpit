//! A workspace's subagent runs (src/shared/subagents.ts): cmux's own
//! `children` while any agent carries some, corrected by the hook's saved
//! runs (#83); else the saved runs alone.

use crate::data::{Agent, AgentStatus, SubagentRun, Workspace};
use crate::persist::{SavedState, SavedSubagent};
use crate::session::Session;
use crate::text::readable;

fn ended(a: &Agent) -> bool {
    a.status == Some(AgentStatus::Ended)
}

/// A run cmux sent is live while its owner has not ended and it says it
/// runs; without `running`, while it has no end.
pub fn child_running(c: &SubagentRun, owner: &Agent) -> bool {
    !ended(owner)
        && c.running
            .unwrap_or(c.ended_epoch.is_none_or(|e| e == 0.0 || e.is_nan()))
}

/// A saved run's owner is the agent whose id matches its session; with
/// none, it is live while it has no end and any workspace agent is live.
pub fn saved_running(run: &SavedSubagent, agents: &[Agent]) -> bool {
    if run.ended_epoch.is_some() {
        return false;
    }
    match agents.iter().find(|a| a.id == run.session) {
        Some(owner) => !ended(owner),
        None => agents.iter().any(|a| !ended(a)),
    }
}

/// The workspace's saved runs, oldest first.
fn saved_runs<'s>(saved: &'s SavedState, ws_id: &str) -> &'s [SavedSubagent] {
    saved.subagents.get(ws_id).map_or(&[], Vec::as_slice)
}

/// Either of the hook's ids counts as the same run.
fn same_id(run: &SavedSubagent, c: &SubagentRun) -> bool {
    c.id.as_ref()
        .is_some_and(|id| *id == run.id || Some(id) == run.agent_id.as_ref())
}

/// The fallback when cmux's id is its own: the label as drawn, never the
/// generic "subagent" many runs share.
fn same_label(run: &SavedSubagent, c: &SubagentRun) -> bool {
    let label = readable(c.label.as_deref());
    !label.is_empty() && label != "subagent" && label == readable(Some(&run.label))
}

/// A run whose session is a workspace agent's pairs only with that
/// agent's children; one with no such agent may pair with any.
fn may_pair(run: &SavedSubagent, owner: &Agent, agents: &[Agent]) -> bool {
    run.session == owner.id || !agents.iter().any(|a| a.id == run.session)
}

/// A child of an agent, by position: (agent index, child index).
type ChildAt = (usize, usize);

/// cmux's children beside the saved runs: each live saved run claims the
/// one child that is the same run, by id first and then by label; the claim
/// vouches for the child unless its owner has ended. Returns the vouched
/// children and how many live saved runs no child claims.
fn pair_live(saved: &SavedState, ws_id: &str, agents: &[Agent]) -> (Vec<ChildAt>, usize) {
    let mut unclaimed: Vec<&SavedSubagent> = saved_runs(saved, ws_id)
        .iter()
        .filter(|run| saved_running(run, agents))
        .collect();
    let children: Vec<(ChildAt, &SubagentRun, &Agent)> = agents
        .iter()
        .enumerate()
        .flat_map(|(ai, owner)| {
            owner
                .children
                .iter()
                .flatten()
                .enumerate()
                .filter_map(move |(ci, c)| c.as_ref().map(|c| ((ai, ci), c, owner)))
        })
        .collect();
    let mut claimed: Vec<ChildAt> = Vec::new();
    let mut vouched: Vec<ChildAt> = Vec::new();
    let matchers: [fn(&SavedSubagent, &SubagentRun) -> bool; 2] = [same_id, same_label];
    for same in matchers {
        for (at, c, owner) in &children {
            if claimed.contains(at) {
                continue;
            }
            let Some(i) = unclaimed
                .iter()
                .position(|run| may_pair(run, owner, agents) && same(run, c))
            else {
                continue;
            };
            unclaimed.remove(i);
            claimed.push(*at);
            if !ended(owner) {
                vouched.push(*at);
            }
        }
    }
    (vouched, unclaimed.len())
}

impl Session {
    /// How many subagent runs are live in the workspace.
    pub fn live_run_count(&mut self, w: Option<&Workspace>) -> usize {
        let Some(w) = w else { return 0 };
        let agents = self.agents_of(Some(w));
        if agents.iter().any(|a| a.child_runs().next().is_some()) {
            let (vouched, unclaimed) = pair_live(&self.saved, &w.id, &agents);
            let live: usize = agents
                .iter()
                .enumerate()
                .map(|(ai, a)| {
                    a.children
                        .iter()
                        .flatten()
                        .enumerate()
                        .filter(|(ci, c)| {
                            c.as_ref().is_some_and(|c| {
                                child_running(c, a) || vouched.contains(&(ai, *ci))
                            })
                        })
                        .count()
                })
                .sum();
            return live + unclaimed;
        }
        saved_runs(&self.saved, &w.id)
            .iter()
            .filter(|run| saved_running(run, &agents))
            .count()
    }
}
