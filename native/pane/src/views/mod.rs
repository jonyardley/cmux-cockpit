//! View builders only: each takes the pane's model and lays it out. Every
//! word and colour comes from the model and the theme; a decision a view
//! would need goes in the model (model.rs, cursor.rs, text.rs) with a test.

mod keys;
mod lanes;
mod needs;
mod parts;
mod top;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::text::Line;
use ratatui::widgets::{Block, Paragraph};

use crate::cursor::{Scroll, scroll_for};
use crate::model::PaneModel;
use crate::theme;

/// What one draw shows: the model, the card under the cursor and whether
/// it is the last, the line scroll with no card to move to, and whether
/// the keys are up.
#[derive(Debug, Clone, Copy)]
pub struct Shown<'a> {
    pub model: &'a PaneModel,
    pub cursor: Option<&'a str>,
    pub last: bool,
    pub manual: usize,
    pub keys: bool,
}

/// Draws the whole pane into the frame; returns how far the body scrolled.
pub fn draw(frame: &mut Frame<'_>, shown: Shown<'_>) -> usize {
    let area = frame.area();
    frame.render_widget(Block::new().style(theme::base()), area);
    let inner = parts::inner(area.width);
    let [top_area, body_area] =
        Layout::vertical([Constraint::Length(2), Constraint::Fill(1)]).areas(area);

    let top = vec![top::switch(inner), top::next(&shown.model.next, inner)];
    frame.render_widget(Paragraph::new(top), top_area);

    let mut body: Vec<Line<'static>> = Vec::new();
    let needs = needs::lines(&shown.model.needs, inner);
    let gap = if needs.is_empty() {
        0
    } else {
        body.push(Line::default());
        1
    };
    let lead = gap + needs.len();
    body.extend(needs);
    let (lanes, focus) = lanes::lines(&shown.model.lanes, inner, shown.cursor);
    body.extend(lanes);
    let scroll = scroll_for(&Scroll {
        focus: focus.map(|r| r.start + lead..r.end + lead),
        last: shown.last,
        manual: shown.manual,
        total: body.len(),
        height: usize::from(body_area.height),
    });
    let offset = u16::try_from(scroll).unwrap_or(u16::MAX);
    frame.render_widget(Paragraph::new(body).scroll((offset, 0)), body_area);

    if shown.keys {
        keys::draw(frame, area);
    }
    scroll
}
