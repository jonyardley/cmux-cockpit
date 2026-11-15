//! A session that stopped without handing back (issue #376): it waits on
//! Jon as surely as one that asks, but nothing asks. Three ways, each
//! decided in the runner's join from what it alone sees, and carried on the
//! agent as `Agent::stopped` so every rule that reads the agent as the
//! sidebars show it (`Session::effective_agent`) counts it in Needs you:
//!
//! | Cause | Signal | Clears on |
//! | --- | --- | --- |
//! | Error | cmux's `agent.notification.decision` of kind `agent.error.reported`, reason `accepted`, agent `claude`, in a tab a session holds | the next UserPromptSubmit or SessionStart in the tab, or the tab's last session forgotten |
//! | Gone | the process left Agent View with its turn still open (`gone_mid_turn`) | a new session in the tab, the pid coming back, or a restart |
//! | Silent | working with no activity for `SILENT_SECS` (`silent_since`) | any activity |
//!
//! A clean end (Stop, then SessionEnd) closes the turn first, so it never
//! reads as Gone. Dismissed, a Gone session leaves the sidebars
//! (`Session::agents_of`) until "Restore needs you".

use serde::{Deserialize, Serialize};

use crate::data::AgentStatus;
use crate::hooks::Hooked;
use crate::program::{Report, resolve};

/// How long a working session may go with no hook before it reads as
/// stopped. Twice Quiet's ten minutes: a foreground tool call is cut off
/// at ten, and a foreground helper's own hooks come from the same process,
/// so a turn this silent is not waiting on either.
pub const SILENT_SECS: f64 = 20.0 * 60.0;

/// Why a session stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopCause {
    /// Its turn ended on an API error (StopFailure, through cmux).
    Error,
    /// Its process went away mid-turn, with no hook to say so.
    Gone,
    /// Working, but no hook for `SILENT_SECS` or more.
    Silent,
}

/// A stop and when it began, in epoch seconds. The start is taken from
/// the events (the error, the last hook, the last activity), never from
/// the clock, so a dismissal keyed on it holds from frame to frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stop {
    pub cause: StopCause,
    pub since: f64,
}

/// When a session that reads `status` and was last active at
/// `last_activity` went silent, if it is working and has been silent for
/// `SILENT_SECS` or more at epoch `now`; None otherwise or when unknown.
pub fn silent_since(status: &AgentStatus, last_activity: f64, now: f64) -> Option<f64> {
    let silent = *status == AgentStatus::Working
        && last_activity > 0.0
        && now - last_activity >= SILENT_SECS;
    silent.then_some(last_activity)
}

/// Whether a session whose process has gone stopped mid-turn: its hooks
/// left the turn open (a prompt or a tool call, no Stop or SessionEnd
/// since), and what the card last showed, from its hooks, its tab's report
/// and Agent View's last word on it (`busy`), still said working or
/// asking. An Esc mid-turn sends no Stop, but Agent View or Claude's report
/// says idle, so quitting after one is not a stop.
pub fn gone_mid_turn(hook: &Hooked, program: Option<&Report>, busy: Option<bool>) -> bool {
    if !hook.turn_open {
        return false;
    }
    // Far enough on that Agent View's idle has had its say.
    let after = hook.last_hook + crate::hooks::STALE_WORKING_SECS;
    resolve(Some(hook), program, busy, after)
        .is_some_and(|r| matches!(r.status, AgentStatus::Working | AgentStatus::NeedsInput))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{Hooked, moves_activity, status_from_hook};

    /// A session after `hooks` in order, one a second from 100s.
    fn after(hooks: &[&str]) -> Option<Hooked> {
        let mut h: Option<Hooked> = None;
        for (i, name) in hooks.iter().enumerate() {
            let Some(status) = status_from_hook(name, None) else {
                continue;
            };
            let at = 100.0 + i as f64;
            h = Some(Hooked::after(
                h.as_ref(),
                status,
                at,
                moves_activity(name),
                "w",
            ));
        }
        h
    }

    #[test]
    fn a_turn_still_open_when_the_process_goes_is_a_stop() {
        let h = after(&["SessionStart", "UserPromptSubmit", "PreToolUse"]).expect("hooked");
        assert!(gone_mid_turn(&h, None, Some(true)));
        assert!(gone_mid_turn(&h, None, None), "Agent View never said");
        let asked = after(&["UserPromptSubmit", "PermissionRequest"]).expect("hooked");
        assert!(gone_mid_turn(&asked, None, Some(false)), "an ask waits");
    }

    #[test]
    fn a_clean_end_or_an_idle_session_is_not_a_stop() {
        for hooks in [
            &["UserPromptSubmit", "Stop"][..],
            &["UserPromptSubmit", "Stop", "SessionEnd"],
            &["SessionStart"],
            // The idle nudge a minute after a Stop asks nothing.
            &["UserPromptSubmit", "Stop", "Notification"],
        ] {
            let h = after(hooks).expect("hooked");
            assert!(!gone_mid_turn(&h, None, Some(true)), "{hooks:?}");
        }
    }

    #[test]
    fn an_esc_that_agent_view_or_claude_saw_go_idle_is_not_a_stop() {
        let h = after(&["UserPromptSubmit", "PreToolUse"]).expect("hooked");
        assert!(!gone_mid_turn(&h, None, Some(false)));
        let idle = Report {
            status: AgentStatus::Idle,
            since: 110.0,
        };
        assert!(!gone_mid_turn(&h, Some(&idle), Some(true)));
    }

    #[test]
    fn working_with_no_hook_for_the_limit_is_silent_from_its_last_activity() {
        let w = AgentStatus::Working;
        assert_eq!(silent_since(&w, 100.0, 100.0 + SILENT_SECS - 1.0), None);
        assert_eq!(silent_since(&w, 100.0, 100.0 + SILENT_SECS), Some(100.0));
        assert_eq!(
            silent_since(&AgentStatus::Idle, 100.0, 100.0 + SILENT_SECS * 3.0),
            None
        );
        assert_eq!(silent_since(&w, 0.0, SILENT_SECS * 3.0), None, "unknown");
    }
}
