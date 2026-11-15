//! Agent ranking shared by both sidebars (src/shared/activity.ts):
//! needs_input beats working beats idle beats ended, then the most recent
//! activity wins.

use crate::data::{Agent, AgentStatus};
use crate::js::or_zero;

/// How active a status is; -1 for none or one this port does not know.
fn rank(a: &Agent) -> i32 {
    match a.status {
        Some(AgentStatus::NeedsInput) => 3,
        Some(AgentStatus::Working) => 2,
        Some(AgentStatus::Idle) => 1,
        Some(AgentStatus::Ended) => 0,
        Some(AgentStatus::Other(_)) | None => -1,
    }
}

/// A workspace's status comes from its most active agent: the first alone
/// can be a stale idle session beside a working one. Ties keep the first.
pub fn most_active<'a>(agents: impl IntoIterator<Item = &'a Agent>) -> Option<&'a Agent> {
    let mut best: Option<&Agent> = None;
    for a in agents {
        best = match best {
            None => Some(a),
            Some(b) => {
                let d = rank(a) - rank(b);
                let later = or_zero(a.last_activity_at) > or_zero(b.last_activity_at);
                if d > 0 || (d == 0 && later) {
                    Some(a)
                } else {
                    Some(b)
                }
            }
        };
    }
    best
}

/// When the agent's current status began, else its last activity; 0 when
/// neither is known. `??`, so a 0 start is kept.
pub fn since_or_activity(a: &Agent) -> f64 {
    a.since_epoch.or(a.last_activity_at).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, status: AgentStatus, last: f64) -> Agent {
        Agent {
            id: id.to_string(),
            status: Some(status),
            last_activity_at: Some(last),
            ..Agent::default()
        }
    }

    #[test]
    fn ranks_by_status_then_latest_activity_keeping_the_first_on_a_tie() {
        let idle = agent("i", AgentStatus::Idle, 900.0);
        let working = agent("w", AgentStatus::Working, 100.0);
        let later = agent("l", AgentStatus::Working, 200.0);
        let same = agent("s", AgentStatus::Working, 200.0);
        let all = [idle, working, later, same];
        assert_eq!(most_active(&all).map(|a| a.id.as_str()), Some("l"));
        assert_eq!(most_active(&[]), None);
    }

    #[test]
    fn keeps_a_zero_start() {
        let a = Agent {
            since_epoch: Some(0.0),
            last_activity_at: Some(5.0),
            ..Agent::default()
        };
        assert_eq!(since_or_activity(&a), 0.0);
    }
}
