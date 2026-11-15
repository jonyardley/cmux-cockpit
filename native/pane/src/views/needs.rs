//! Needs you as one line under Next: how many wait ("3 need you") in the
//! pill's ink, and the oldest wait on the right, bold clay once late.
//! Nothing at all while nobody waits. The cards themselves stay in their
//! lanes with a waiting edge (issue #281), so the line is no cursor stop.

use ratatui::text::{Line, Span};

use super::parts::{Edge, spread};
use crate::model::Needs;
use crate::text::{fit, width};
use crate::theme;
use cockpit_core::panel::Token;

/// The line, or none while nobody waits.
pub fn line(needs: &Needs, inner: usize) -> Option<Line<'static>> {
    if needs.count == 0 {
        return None;
    }
    let label = fit(&needs.label, inner);
    let room = inner.saturating_sub(width(&label) + 1);
    let wait = fit(&needs.wait, room);
    let wait_ink = if needs.late {
        theme::strong(Token::ClayText)
    } else {
        theme::ink(needs.ink)
    };
    let left = vec![Span::styled(label, theme::strong(needs.ink))];
    let right = if width(&wait) == 0 {
        Vec::new()
    } else {
        vec![Span::styled(wait, wait_ink)]
    };
    Some(spread(left, right, inner, Edge::Plain))
}
