//! A chat's running background shells from the saved state
//! (src/shared/shells.ts): cmux sends custom sidebars none, so the shell
//! hook records them. A shell counts only for the chat that started it and
//! only while that chat is open.

use crate::data::{Agent, AgentStatus, Workspace};
use crate::persist::SavedState;

/// How many background shells the agent's chat has running in the
/// workspace; none once it has ended.
pub fn live_shell_count(saved: &SavedState, w: Option<&Workspace>, a: Option<&Agent>) -> usize {
    let (Some(w), Some(a)) = (w, a) else { return 0 };
    if a.status == Some(AgentStatus::Ended) {
        return 0;
    }
    saved.shells.get(&w.id).map_or(0, |shells| {
        shells.iter().filter(|s| s.session == a.id).count()
    })
}
