//! What a chat wants from Jon when its turn ends (src/shared/move.ts): the
//! "Your move" line the Stop hook saves, and how big a job answering it is.
//! The line reaches the sidebar through the workspace's description, and
//! through the saved state when setting the description failed.

use std::sync::LazyLock;

use regex::Regex;

use crate::data::{Agent, AgentStatus, Workspace};
use crate::js::{positive, truthy};
use crate::persist::{SavedMove, SavedState, move_of_description};
use crate::saved::saved_for;

/// The move `w`'s chat last ended a turn on: the description's or the
/// saved one, whichever is newer.
fn saved_move_for(saved: &SavedState, w: &Workspace) -> Option<SavedMove> {
    let stored = saved.moves.get(&w.id);
    let live = move_of_description(w.description.as_deref());
    match (live, stored) {
        (Some(live), Some(stored)) if stored.epoch > live.epoch => Some(stored.clone()),
        (Some(live), _) => Some(live),
        (None, stored) => stored.cloned(),
    }
}

/// A turn end: Claude's Stop sets the agent idle, and the nudge about 60s
/// later moves it to needs_input.
fn at_turn_end(a: &Agent) -> bool {
    matches!(a.status, Some(AgentStatus::Idle | AgentStatus::NeedsInput))
}

/// A move is `a`'s only when `a` is the Claude session that saved it.
fn owns_move(m: &SavedMove, a: &Agent, _w: &Workspace) -> bool {
    m.session.is_some()
        && a.kind.as_deref() == Some("claude")
        && m.session.as_deref() == Some(a.id.as_str())
}

/// The move `a` is waiting on, or None. Pass `a` as the sidebars show it
/// and `asking` from ask_reason. Only a turn end counts, never an ask; the
/// move is current while it is no older than the last prompt (latestAt),
/// HOOK_SLACK aside, and it must be `a`'s own.
pub fn waiting_move(
    saved: &SavedState,
    a: Option<&Agent>,
    w: Option<&Workspace>,
    asking: bool,
) -> Option<SavedMove> {
    let (a, w) = (a?, w?);
    if asking || !at_turn_end(a) {
        return None;
    }
    let prompt_at = w.latest_at.unwrap_or(0.0);
    if !positive(prompt_at) {
        return None;
    }
    let m = saved_move_for(saved, w)?;
    saved_for(Some(&m), a, w, prompt_at, owns_move).cloned()
}

static NOTHING_WAITS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)nothing (?:else )?waits on you").ok());
static NOTHING_FIRST: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)^nothing[.:]").ok());
static REVIEW: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)https?://|claude\.ai/|(?-u:\b)(?:read|review|look at)(?-u:\b)").ok()
});
static QUICK: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"(?i)/clear(?-u:\b)|(?-u:\b)go(?-u:\b)|(?:^|\s)!\s?[A-Za-z0-9_]|(?-u:\b)paste(?-u:\b)|nothing follows|under (?:a|one|two) minutes?",
    )
    .ok()
});

fn test(re: &LazyLock<Option<Regex>>, s: &str) -> bool {
    re.as_ref().is_some_and(|re| re.is_match(s))
}

/// True when the move asks nothing of Jon: saved as idle ("Nothing for
/// you:"), or the older "Your move: nothing." or "nothing waits on you". A
/// reply that laid out decisions always asks something.
pub fn asks_nothing(m: &SavedMove) -> bool {
    !positive(m.decisions.unwrap_or(0.0))
        && (m.idle == Some(true) || test(&NOTHING_WAITS, &m.text) || test(&NOTHING_FIRST, &m.text))
}

/// How long after a saved turn end the idle nudge may turn it into needs_input.
pub const NUDGE_WINDOW: f64 = 120.0;

/// The move behind `a`'s needs_input when it asks nothing of Jon, or None:
/// only the nudge that lands within NUDGE_WINDOW of that turn end.
pub fn quiet_turn(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> Option<SavedMove> {
    if a.status != Some(AgentStatus::NeedsInput) {
        return None;
    }
    let since = truthy(a.since_epoch)?;
    quiet_move(saved, a, w).filter(|m| since - m.epoch <= NUDGE_WINDOW)
}

/// The move `a`'s turn ended on when it asks nothing of Jon, or None.
pub fn quiet_move(saved: &SavedState, a: &Agent, w: Option<&Workspace>) -> Option<SavedMove> {
    waiting_move(saved, Some(a), w, false).filter(asks_nothing)
}

/// How big answering a move is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveSize {
    Quick,
    Decide,
    Review,
}

/// "decide" when the reply laid out decisions, "review" when Jon reads
/// something first, "quick" for a word or a paste; None when nothing waits
/// on Jon or the line gives no clue.
pub fn move_size(m: &SavedMove) -> Option<MoveSize> {
    if m.decisions.unwrap_or(0.0) > 0.0 {
        return Some(MoveSize::Decide);
    }
    if asks_nothing(m) {
        return None;
    }
    if test(&REVIEW, &m.text) {
        return Some(MoveSize::Review);
    }
    if test(&QUICK, &m.text) {
        return Some(MoveSize::Quick);
    }
    None
}

/// The size chip's words: "Quick", "Review", "Decide · 2".
pub fn move_size_text(size: MoveSize, decisions: f64) -> String {
    match size {
        MoveSize::Decide if decisions > 1.0 => {
            format!("Decide · {}", crate::js::num_text(decisions))
        }
        MoveSize::Decide => "Decide".to_string(),
        MoveSize::Quick => "Quick".to_string(),
        MoveSize::Review => "Review".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [&NOTHING_WAITS, &NOTHING_FIRST, &REVIEW, &QUICK] {
            assert!(re.is_some());
        }
    }
}
