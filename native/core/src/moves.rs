//! What a chat wants from Jon when its turn ends (src/shared/move.ts): the
//! "Your move" line the Stop hook saves, and how big a job answering it is.
//! The line reaches the sidebar through the workspace's description, and
//! through the saved state when setting the description failed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::data::{Agent, AgentStatus, Workspace};
use crate::js::positive;
use crate::owner::owns;
use crate::persist::{SavedMove, SavedState, TaskType, move_of_description};
use crate::saved::saved_for;

/// Descriptions parsed so far, at most PARSED_MAX: the move is read
/// several times per card on every frame, and the description rarely
/// changes between them.
const PARSED_MAX: usize = 64;

thread_local! {
    static PARSED: RefCell<HashMap<String, Option<SavedMove>>> = RefCell::new(HashMap::new());
}

/// The move a description carries, parsed once per distinct description.
fn live_move(d: Option<&str>) -> Option<SavedMove> {
    let d = d?;
    PARSED.with(|cell| {
        // A read already under way (never expected) parses afresh.
        let Ok(mut cache) = cell.try_borrow_mut() else {
            return move_of_description(Some(d));
        };
        if let Some(m) = cache.get(d) {
            return m.clone();
        }
        if cache.len() >= PARSED_MAX {
            cache.clear();
        }
        let m = move_of_description(Some(d));
        cache.insert(d.to_string(), m.clone());
        m
    })
}

/// The move `w`'s chat last ended a turn on: the description's or the
/// saved one, whichever is newer.
fn saved_move_for(saved: &SavedState, w: &Workspace) -> Option<SavedMove> {
    let stored = saved.moves.get(&w.id);
    let live = live_move(w.description.as_deref());
    match (live, stored) {
        (Some(live), Some(stored)) if stored.epoch > live.epoch => Some(stored.clone()),
        (Some(live), _) => Some(live),
        (None, stored) => stored.cloned(),
    }
}

/// A turn end: Claude's Stop sets the agent idle, or a real ask since
/// moved it to needs_input.
fn at_turn_end(a: &Agent) -> bool {
    matches!(a.status, Some(AgentStatus::Idle | AgentStatus::NeedsInput))
}

/// A move is `a`'s only when `a` is the Claude session that saved it.
fn owns_move(m: &SavedMove, a: &Agent, _w: &Workspace) -> bool {
    m.session.is_some()
        && a.kind.as_deref() == Some("claude")
        && m.session.as_deref() == Some(a.id.as_str())
}

/// A move is `a`'s chat's when `a` is a Claude session and saved it under
/// any session id its chat ran under (`crate::owner`), so a turn from
/// before a /clear is still the chat's.
fn chat_owns_move(m: &SavedMove, a: &Agent, w: &Workspace) -> bool {
    let agents = w.agent_list().filter(|x| x.status.is_some());
    a.kind.as_deref() == Some("claude") && m.session.as_deref().is_some_and(|s| owns(agents, a, s))
}

/// The move `a`'s chat's last turn ended on when it asks nothing of Jon
/// for now (`asks_nothing_yet`, so a reply held on Running counts), matched
/// on any session id the chat ran under, with the same freshness rule as
/// waiting_move. Only the Ready guard reads it: a turn that ended on
/// "Nothing for you" before a /clear still keeps the card off Ready while
/// its work runs. What a card shows as waiting stays on the current id,
/// since a clear starts afresh.
pub fn chat_quiet_move(saved: &SavedState, a: &Agent, w: &Workspace) -> Option<SavedMove> {
    turn_move(saved, a, w, chat_owns_move).filter(|m| asks_nothing_yet(saved, m, a, Some(w)))
}

/// The move `a`'s last turn ended on, when `owns` gives it to `a`: only at
/// a turn end, and while the move is no older than the last prompt
/// (latestAt), HOOK_SLACK aside. waiting_move and chat_quiet_move differ
/// only in `owns`.
fn turn_move(
    saved: &SavedState,
    a: &Agent,
    w: &Workspace,
    owns: fn(&SavedMove, &Agent, &Workspace) -> bool,
) -> Option<SavedMove> {
    if !at_turn_end(a) {
        return None;
    }
    let prompt_at = w.latest_at.unwrap_or(0.0);
    if !positive(prompt_at) {
        return None;
    }
    let m = saved_move_for(saved, w)?;
    saved_for(Some(&m), a, w, prompt_at, owns).cloned()
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
    if asking {
        return None;
    }
    turn_move(saved, a, w, owns_move)
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

/// Whether `m` asks nothing of Jon for now: `asks_nothing`, or a reply
/// that asked nothing at all (`no_ask`) while `a`'s chat still runs
/// subagents by the core's saved verdict (running_save.rs). Only agents
/// hold it: a shell, monitor or background session can run for hours, so
/// the turn would hide all that time. Once the agents stop the turn waits
/// on him again, so a quiet chat never hides for good.
pub fn asks_nothing_yet(
    saved: &SavedState,
    m: &SavedMove,
    a: &Agent,
    w: Option<&Workspace>,
) -> bool {
    let agents_run = w.and_then(|w| saved.running.get(&w.id)).is_some_and(|r| {
        r.agent == a.id
            && r.counts
                .iter()
                .any(|c| c.kind == TaskType::Subagent && c.n > 0)
    });
    let no_ask = m.no_ask == Some(true) && !positive(m.decisions.unwrap_or(0.0));
    asks_nothing(m) || (no_ask && agents_run)
}

/// How big answering a move is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
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
    if asks_nothing(m) || m.unlabelled == Some(true) {
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

    #[test]
    fn gives_a_quoted_last_line_no_size_unless_it_laid_out_decisions() {
        let quoted = SavedMove {
            text: "Let me know if you want me to go further.".into(),
            unlabelled: Some(true),
            ..SavedMove::default()
        };
        assert_eq!(move_size(&quoted), None);
        let deciding = SavedMove {
            decisions: Some(2.0),
            ..quoted
        };
        assert_eq!(move_size(&deciding), Some(MoveSize::Decide));
    }

    fn claude(id: &str, earlier: &[&str]) -> Agent {
        Agent {
            id: id.to_string(),
            kind: Some("claude".into()),
            status: Some(AgentStatus::Idle),
            earlier_sessions: Some(earlier.iter().map(|s| (*s).to_string()).collect()),
            ..Agent::default()
        }
    }

    fn quiet_saved(session: &str) -> SavedState {
        SavedState::from_json(&format!(
            r#"{{"moves": {{"w": {{"text": "Nothing for you: tests run on", "idle": true,
                "epoch": 1000, "session": "{session}"}}}}}}"#
        ))
        .unwrap()
    }

    fn ws(agents: &[Agent], latest_at: f64) -> Workspace {
        Workspace {
            id: "w".into(),
            latest_at: Some(latest_at),
            agents: Some(agents.iter().cloned().map(Some).collect()),
            ..Workspace::default()
        }
    }

    #[test]
    fn finds_the_chats_quiet_move_under_an_id_from_before_a_clear() {
        let a = claude("now", &["before"]);
        let w = ws(std::slice::from_ref(&a), 950.0);
        let saved = quiet_saved("before");
        assert!(chat_quiet_move(&saved, &a, &w).is_some());
        assert!(
            waiting_move(&saved, Some(&a), Some(&w), false).is_none(),
            "what the card shows as waiting stays on the current id"
        );
    }

    #[test]
    fn a_prompt_after_the_move_leaves_it_behind() {
        let a = claude("now", &["before"]);
        let w = ws(std::slice::from_ref(&a), 1100.0);
        assert!(chat_quiet_move(&quiet_saved("before"), &a, &w).is_none());
    }

    #[test]
    fn never_finds_another_chats_move() {
        let a = claude("now", &["before"]);
        let resumed = claude("before", &[]);
        let w = ws(&[a.clone(), resumed], 950.0);
        assert!(
            chat_quiet_move(&quiet_saved("before"), &a, &w).is_none(),
            "a resumed session owns its id again"
        );
        let w = ws(std::slice::from_ref(&a), 950.0);
        assert!(chat_quiet_move(&quiet_saved("stranger"), &a, &w).is_none());
    }
}
