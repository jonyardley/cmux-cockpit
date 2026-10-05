//! Small pieces every section lays out with: the side margin with the
//! cursor's bar or a drop's mark, a count pill, and a line with words at
//! both ends.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use crate::model::DROP_MARK;
use crate::text::width;
use crate::theme;
use cockpit_core::ui::PillColors;

/// Cells kept clear at each side.
pub const MARGIN: usize = 1;
/// The bar at the left edge of the card under the cursor.
pub const CURSOR_BAR: &str = "▌";

/// What the left margin of a line carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Plain,
    /// The card under the cursor.
    Cursor,
    /// The first line of the card a drag would land above.
    Drop,
}

/// The columns between the margins.
pub fn inner(total: u16) -> usize {
    usize::from(total).saturating_sub(MARGIN * 2)
}

/// The cells `spans` take.
pub fn spans_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| width(&s.content)).sum()
}

/// A count in a pill: " 3 " on its tint.
pub fn pill(count: usize, colours: PillColors) -> Span<'static> {
    Span::styled(
        format!(" {count} "),
        Style::new()
            .fg(theme::colour(colours.fg))
            .bg(theme::colour(colours.bg)),
    )
}

/// `left` at the start and `right` against the end of `inner` cells, inside
/// the margins; the left margin carries `edge`. Callers fit both ends
/// first, so the two never overlap.
pub fn spread(
    left: Vec<Span<'static>>,
    right: Vec<Span<'static>>,
    inner: usize,
    edge: Edge,
) -> Line<'static> {
    let gap = inner.saturating_sub(spans_width(&left) + spans_width(&right));
    let mut spans = vec![margin(edge)];
    spans.extend(left);
    spans.push(Span::raw(" ".repeat(gap)));
    spans.extend(right);
    spans.push(Span::raw(" ".repeat(MARGIN)));
    Line::from(spans)
}

/// The left margin: the cursor's bar, a drop's mark, or blank.
fn margin(edge: Edge) -> Span<'static> {
    let select = theme::ink(cockpit_core::theme::Token::Select);
    match edge {
        Edge::Plain => Span::raw(" ".repeat(MARGIN)),
        Edge::Cursor => Span::styled(CURSOR_BAR, select),
        Edge::Drop => Span::styled(DROP_MARK, select),
    }
}
