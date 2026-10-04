//! What a Claude hook does to an agent's status, moved here from the R1.0
//! spike so the pane and the R2 panel share one copy. The rules follow
//! cmux 0.64.25 as docs/state-loop.md ("What cmux does") describes it.
//!
//! | Hook | Status |
//! | --- | --- |
//! | Notification (the idle nudge too), PermissionRequest, PreToolUse for AskUserQuestion or ExitPlanMode | needs input |
//! | UserPromptSubmit, other PreToolUse, PostToolUse, PreCompact | working |
//! | SessionStart, Stop | idle |
//! | SessionEnd | ended |
//!
//! Any other hook (a subagent finishing, say) leaves the status as it was.

use crate::data::AgentStatus;

/// The status a hook sets, or None when it leaves the status alone.
pub fn status_from_hook(name: &str, tool: Option<&str>) -> Option<AgentStatus> {
    match (name, tool) {
        ("PreToolUse", Some("AskUserQuestion" | "ExitPlanMode")) => Some(AgentStatus::NeedsInput),
        ("Notification" | "PermissionRequest", _) => Some(AgentStatus::NeedsInput),
        ("UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact", _) => {
            Some(AgentStatus::Working)
        }
        ("SessionStart" | "Stop", _) => Some(AgentStatus::Idle),
        ("SessionEnd", _) => Some(AgentStatus::Ended),
        _ => None,
    }
}

/// The status of a session that has a pid but no hook yet: Claude's own
/// busy or idle from Agent View, or none when Agent View has not said.
pub fn status_without_hooks(busy: Option<bool>) -> Option<AgentStatus> {
    busy.map(|b| {
        if b {
            AgentStatus::Working
        } else {
            AgentStatus::Idle
        }
    })
}

/// Whether a hook counts as the agent doing something. A Notification
/// does not: the idle nudge comes about 60 seconds after a Stop, and the
/// core tells it from a real ask by that gap since the last activity.
pub fn moves_activity(name: &str) -> bool {
    name != "Notification"
}

/// How long a working status may sit with no hook while Agent View says
/// the session is idle, before Agent View wins. An Esc mid-turn sends no
/// Stop, so without this the card would say working until the next turn.
pub const STALE_WORKING_SECS: f64 = 5.0;

/// One session as its hooks left it.
#[derive(Debug, Clone, PartialEq)]
pub struct Hooked {
    pub status: AgentStatus,
    /// Epoch seconds the status began: the hook that last changed it.
    pub since: f64,
    /// Epoch seconds of the latest hook that set a status.
    pub last_activity: f64,
    /// The workspace the hook named.
    pub workspace: String,
}

impl Hooked {
    /// The session after a hook at epoch `at` that sets `status`. A status
    /// that does not change keeps its start, so an agent working through
    /// many tool calls counts from the first one.
    /// `activity` is false for a hook that is no sign of work
    /// (`moves_activity`), which keeps the last activity where it was.
    pub fn after(
        prev: Option<&Hooked>,
        status: AgentStatus,
        at: f64,
        activity: bool,
        workspace: &str,
    ) -> Hooked {
        let since = match prev {
            Some(p) if p.status == status => p.since,
            _ => at,
        };
        let last_activity = match prev {
            Some(p) if !activity => p.last_activity,
            _ => at,
        };
        Hooked {
            status,
            since,
            last_activity,
            workspace: workspace.to_string(),
        }
    }

    /// The status and its start once Agent View has had its say: working
    /// with no hook for `STALE_WORKING_SECS` while Agent View says idle
    /// reads as idle since the last hook. Everything else is the hook's.
    pub fn with_agent_view(&self, busy: Option<bool>, now: f64) -> (AgentStatus, f64) {
        let stale = now - self.last_activity >= STALE_WORKING_SECS;
        if self.status == AgentStatus::Working && busy == Some(false) && stale {
            return (AgentStatus::Idle, self.last_activity);
        }
        (self.status.clone(), self.since)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asking_hooks_need_input() {
        for (name, tool) in [
            ("Notification", None),
            ("PermissionRequest", Some("Bash")),
            ("PreToolUse", Some("AskUserQuestion")),
            ("PreToolUse", Some("ExitPlanMode")),
        ] {
            assert_eq!(
                status_from_hook(name, tool),
                Some(AgentStatus::NeedsInput),
                "{name} {tool:?}"
            );
        }
    }

    #[test]
    fn tool_and_prompt_hooks_mean_working() {
        for (name, tool) in [
            ("UserPromptSubmit", None),
            ("PreToolUse", Some("Bash")),
            ("PreToolUse", None),
            ("PostToolUse", Some("AskUserQuestion")),
            ("PreCompact", None),
        ] {
            assert_eq!(
                status_from_hook(name, tool),
                Some(AgentStatus::Working),
                "{name}"
            );
        }
    }

    #[test]
    fn start_and_stop_mean_idle_and_session_end_means_ended() {
        assert_eq!(
            status_from_hook("SessionStart", None),
            Some(AgentStatus::Idle)
        );
        assert_eq!(status_from_hook("Stop", None), Some(AgentStatus::Idle));
        assert_eq!(
            status_from_hook("SessionEnd", None),
            Some(AgentStatus::Ended)
        );
    }

    #[test]
    fn other_hooks_leave_the_status_alone() {
        assert_eq!(status_from_hook("SubagentStop", None), None);
        assert_eq!(status_from_hook("PostToolUseFailure", None), None);
    }

    #[test]
    fn a_session_without_hooks_takes_agent_views_word() {
        assert_eq!(status_without_hooks(Some(true)), Some(AgentStatus::Working));
        assert_eq!(status_without_hooks(Some(false)), Some(AgentStatus::Idle));
        assert_eq!(status_without_hooks(None), None);
    }

    #[test]
    fn an_unchanged_status_keeps_its_start_and_a_new_one_starts_now() {
        let first = Hooked::after(None, AgentStatus::Working, 100.0, true, "w");
        assert_eq!((first.since, first.last_activity), (100.0, 100.0));
        let again = Hooked::after(Some(&first), AgentStatus::Working, 160.0, true, "w");
        assert_eq!((again.since, again.last_activity), (100.0, 160.0));
        let asked = Hooked::after(Some(&again), AgentStatus::NeedsInput, 170.0, true, "w");
        assert_eq!(asked.since, 170.0);
    }

    #[test]
    fn a_notification_keeps_the_last_activity_so_the_idle_nudge_shows_its_gap() {
        assert!(!moves_activity("Notification"));
        assert!(moves_activity("PermissionRequest"));
        let stopped = Hooked::after(None, AgentStatus::Idle, 100.0, true, "w");
        let nudge = Hooked::after(Some(&stopped), AgentStatus::NeedsInput, 160.0, false, "w");
        assert_eq!((nudge.since, nudge.last_activity), (160.0, 100.0));
        let first = Hooked::after(None, AgentStatus::NeedsInput, 50.0, false, "w");
        assert_eq!(
            first.last_activity, 50.0,
            "with nothing before, the hook's own time"
        );
    }

    #[test]
    fn agent_view_idle_retires_a_stale_working_status_only() {
        let working = Hooked::after(None, AgentStatus::Working, 100.0, true, "w");
        assert_eq!(
            working.with_agent_view(Some(false), 104.0),
            (AgentStatus::Working, 100.0),
            "too soon: Agent View may lag the hook"
        );
        assert_eq!(
            working.with_agent_view(Some(false), 105.0),
            (AgentStatus::Idle, 100.0)
        );
        assert_eq!(
            working.with_agent_view(Some(true), 500.0),
            (AgentStatus::Working, 100.0)
        );
        assert_eq!(
            working.with_agent_view(None, 500.0),
            (AgentStatus::Working, 100.0)
        );
        let asking = Hooked::after(None, AgentStatus::NeedsInput, 100.0, true, "w");
        assert_eq!(
            asking.with_agent_view(Some(false), 500.0),
            (AgentStatus::NeedsInput, 100.0),
            "an ask waits while Claude idles"
        );
    }
}
