//! A quiet agent (src/shared/quiet.ts): still working, but with no
//! activity for a while, and nothing of its own running for it to wait on.
//!
//! What counts is the chat's own agent runs, under any session id it ran
//! under, the same owner scope as the card's Running status
//! (`Session::own_run_count`, which sees a foreground agent mid-turn,
//! before any Stop lists it). The background record is left out: it is
//! written on Stop only, so during a turn it can still hold a task that
//! has just finished and woken the chat, which would keep a hung turn from
//! ever reading quiet. The agents panel's quiet.ts still counts every
//! helper in the workspace until it reads the core's verdict (#360).

use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::session::Session;
use crate::time::{age_since, now_epoch};
use crate::words::QUIET_WORD;

/// How long a working agent may go without activity before it reads quiet.
pub const QUIET_SECS: f64 = 10.0 * 60.0;

impl Session {
    /// When `a` last showed activity, if it is working, that was at least
    /// QUIET_SECS ago, and its chat runs no agent of its own; else 0.
    pub fn quiet_since(&mut self, data: &Data, a: Option<&Agent>, w: Option<&Workspace>) -> f64 {
        let last = match a {
            Some(a) if a.status == Some(AgentStatus::Working) => a.last_activity_at.unwrap_or(0.0),
            _ => 0.0,
        };
        if !(last > 0.0 && now_epoch(data) - last >= QUIET_SECS) {
            return 0.0;
        }
        let Some(a) = a else { return 0.0 };
        if self.own_run_count(w, a) > 0 {
            0.0
        } else {
            last
        }
    }

    /// " · quiet 17m" after a quiet agent's status, else "".
    pub fn quiet_suffix(
        &mut self,
        data: &Data,
        a: Option<&Agent>,
        w: Option<&Workspace>,
    ) -> String {
        let since = self.quiet_since(data, a, w);
        if since > 0.0 {
            format!(" · {QUIET_WORD} {}", age_since(data, Some(since)))
        } else {
            String::new()
        }
    }
}
