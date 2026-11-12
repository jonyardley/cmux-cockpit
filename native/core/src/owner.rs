//! Which chat a saved piece of background work belongs to. The hooks save
//! shells and subagent runs under the session id they started in, but
//! `/clear` gives a chat a new session id in the same Claude process while
//! that work runs on. So a chat owns work saved under its current session
//! id or any id its process ran under before (`Agent::earlier_sessions`,
//! from the runner's memory of Agent View). Every match of saved work to a
//! chat goes through here.

use crate::data::Agent;

/// The session ids that belong to the agent's chat: its current one
/// first, then the ones its process ran under before, newest first.
pub fn chat_sessions(a: &Agent) -> impl Iterator<Item = &str> {
    std::iter::once(a.id.as_str()).chain(earlier(a))
}

fn earlier(a: &Agent) -> impl Iterator<Item = &str> {
    a.earlier_sessions.iter().flatten().map(String::as_str)
}

fn ran_before(a: &Agent, session: &str) -> bool {
    earlier(a).any(|id| id == session)
}

/// The agent among `agents` whose chat `session` belongs to. A current id
/// wins over another agent's earlier one, since a resumed session runs
/// again under its old id in a new process; between earlier ids, the
/// first agent listed.
pub fn owner<'a>(agents: &'a [Agent], session: &str) -> Option<&'a Agent> {
    agents
        .iter()
        .find(|a| a.id == session)
        .or_else(|| agents.iter().find(|a| ran_before(a, session)))
}

/// Whether `session` belongs to `a`'s chat, among the workspace's
/// `agents`: its current id always does; an earlier one does unless
/// `owner` gives it to another agent. `a` need not be in `agents`.
pub fn owns(agents: &[Agent], a: &Agent, session: &str) -> bool {
    a.id == session
        || (ran_before(a, session) && owner(agents, session).is_none_or(|o| o.id == a.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, earlier: &[&str]) -> Agent {
        Agent {
            id: id.to_string(),
            earlier_sessions: (!earlier.is_empty())
                .then(|| earlier.iter().map(|s| (*s).to_string()).collect()),
            ..Agent::default()
        }
    }

    #[test]
    fn a_chat_owns_its_current_session_and_those_before_a_clear() {
        let a = agent("now", &["before", "first"]);
        assert_eq!(
            chat_sessions(&a).collect::<Vec<_>>(),
            ["now", "before", "first"]
        );
        let agents = [a.clone(), agent("other", &[])];
        assert!(owns(&agents, &a, "now"));
        assert!(owns(&agents, &a, "first"));
        assert!(!owns(&agents, &a, "other"));
        assert_eq!(owner(&agents, "before").map(|o| o.id.as_str()), Some("now"));
        assert_eq!(owner(&agents, "nobody"), None);
    }

    #[test]
    fn a_chat_with_no_history_owns_only_its_current_session() {
        let a = agent("now", &[]);
        assert_eq!(chat_sessions(&a).collect::<Vec<_>>(), ["now"]);
        assert!(owns(&[], &a, "now"));
        assert!(!owns(&[], &a, "before"));
    }

    #[test]
    fn a_session_running_again_elsewhere_belongs_to_that_chat() {
        let cleared = agent("new", &["old"]);
        let resumed = agent("old", &[]);
        let agents = [cleared.clone(), resumed.clone()];
        assert_eq!(owner(&agents, "old").map(|o| o.id.as_str()), Some("old"));
        assert!(!owns(&agents, &cleared, "old"));
        assert!(owns(&agents, &resumed, "old"));
    }

    #[test]
    fn an_earlier_session_two_chats_claim_goes_to_the_first_listed() {
        let first = agent("a", &["shared"]);
        let second = agent("b", &["shared"]);
        let agents = [first.clone(), second.clone()];
        assert!(owns(&agents, &first, "shared"));
        assert!(!owns(&agents, &second, "shared"));
    }
}
