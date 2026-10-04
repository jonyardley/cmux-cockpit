//! Small pieces every section lays out with: the side margin, the cursor's
//! bar, a count pill, and a line with words at both ends.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use crate::text::width;
use crate::theme;
use cockpit_core::ui::PillColors;

/// Cells kept clear at each side.
pub const MARGIN: usize = 1;
/// The bar at the left edge of the card under the cursor.
pub const CURSOR_BAR: &str = "▌";

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
/// the margins; the left margin carries the cursor's bar when `cursor`.
/// Callers fit both ends first, so the two never overlap.
pub fn spread(
    left: Vec<Span<'static>>,
    right: Vec<Span<'static>>,
    inner: usize,
    cursor: bool,
) -> Line<'static> {
    let gap = inner.saturating_sub(spans_width(&left) + spans_width(&right));
    let mut spans = vec![margin(cursor)];
    spans.extend(left);
    spans.push(Span::raw(" ".repeat(gap)));
    spans.extend(right);
    spans.push(Span::raw(" ".repeat(MARGIN)));
    Line::from(spans)
}

/// The left margin: the cursor's bar, or blank.
fn margin(cursor: bool) -> Span<'static> {
    if cursor {
        Span::styled(CURSOR_BAR, theme::ink(cockpit_core::theme::Token::Select))
    } else {
        Span::raw(" ".repeat(MARGIN))
    }
}
