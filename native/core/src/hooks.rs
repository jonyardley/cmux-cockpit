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

/// One session as its hooks left it.
#[derive(Debug, Clone, PartialEq)]
pub struct Hooked {
    pub status: AgentStatus,
    /// Epoch seconds the status began: the hook that last changed it.
    pub since: f64,
    /// Epoch seconds of the latest hook that set a status.
    pub last_activity: f64,
    /// The event sequence of that hook.
    pub seq: u64,
    /// The workspace the hook named.
    pub workspace: String,
}

impl Hooked {
    /// The session after a hook at epoch `at` that sets `status`. A status
    /// that does not change keeps its start, so an agent working through
    /// many tool calls counts from the first one.
    pub fn after(
        prev: Option<&Hooked>,
        status: AgentStatus,
        at: f64,
        seq: u64,
        workspace: &str,
    ) -> Hooked {
        let since = match prev {
            Some(p) if p.status == status => p.since,
            _ => at,
        };
        Hooked {
            status,
            since,
            last_activity: at,
            seq,
            workspace: workspace.to_string(),
        }
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
        let first = Hooked::after(None, AgentStatus::Working, 100.0, 1, "w");
        assert_eq!((first.since, first.last_activity), (100.0, 100.0));
        let again = Hooked::after(Some(&first), AgentStatus::Working, 160.0, 2, "w");
        assert_eq!(
            (again.since, again.last_activity, again.seq),
            (100.0, 160.0, 2)
        );
        let asked = Hooked::after(Some(&again), AgentStatus::NeedsInput, 170.0, 3, "w");
        assert_eq!(asked.since, 170.0);
    }
}
