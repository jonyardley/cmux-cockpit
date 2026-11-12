//! A chat's running background shells from the saved state
//! (src/shared/shells.ts): cmux sends custom sidebars none, so the shell
//! hook records them. A shell counts only for the chat that started it,
//! under any session id that chat ran under (`crate::owner`), and only
//! while that chat is open.

use crate::data::{Agent, AgentStatus, Workspace};
use crate::owner::owns;
use crate::persist::SavedState;

/// How many background shells the agent's chat has running in the
/// workspace; none once it has ended.
pub fn live_shell_count(saved: &SavedState, w: Option<&Workspace>, a: Option<&Agent>) -> usize {
    let (Some(w), Some(a)) = (w, a) else { return 0 };
    if a.status == Some(AgentStatus::Ended) {
        return 0;
    }
    saved.shells.get(&w.id).map_or(0, |shells| {
        let agents: Vec<Agent> = w.agent_list().cloned().collect();
        shells
            .iter()
            .filter(|s| owns(&agents, a, &s.session))
            .count()
    })
}
