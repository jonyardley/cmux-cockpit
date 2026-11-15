//! The one rule for when a hook's saved entry (an ask, a move) still
//! explains an agent's state (src/shared/saved.ts).

use crate::data::{Agent, Workspace};

/// Seconds allowed between a hook's timestamp and cmux's for the same event.
pub const HOOK_SLACK: f64 = 3.0;

/// A saved hook entry: when it was saved and by which session.
pub trait Stamped {
    fn epoch(&self) -> f64;
    fn session(&self) -> Option<&str>;
}

/// A hook's saved entry when it explains `a` from `since` on: saved no
/// earlier than `since`, HOOK_SLACK aside, and `a`'s by `owns`.
pub fn saved_for<'s, T: Stamped>(
    saved: Option<&'s T>,
    a: &Agent,
    w: &Workspace,
    since: f64,
    owns: impl Fn(&T, &Agent, &Workspace) -> bool,
) -> Option<&'s T> {
    saved.filter(|s| s.epoch() >= since - HOOK_SLACK && owns(s, a, w))
}
