//! A box over the pane listing keys and what each does: the `?` overlay,
//! and the lane picker after `m`.

use ratatui::Frame;
use ratatui::layout::{Constraint, Flex, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use crate::model::fit_rows;
use crate::text::{fit, width};
use crate::theme;
use cockpit_core::theme::Token;

/// The box's widest, borders included.
const MAX_WIDTH: u16 = 38;

/// Draws a box titled `title` listing `rows` in the middle of `area`.
pub fn draw(frame: &mut Frame<'_>, area: Rect, title: &str, rows: &[(&str, &str)]) {
    let key_width = rows.iter().map(|(k, _)| width(k)).max().unwrap_or(0);
    let box_width = MAX_WIDTH.min(area.width);
    // Borders and a space each side of the words.
    let room = usize::from(box_width).saturating_sub(4);
    // Borders take two lines; a short pane keeps the last row, Esc.
    let tall = usize::from(area.height).saturating_sub(2);
    let rows = fit_rows(rows, tall);
    let lines: Vec<Line<'static>> = rows
        .iter()
        .map(|(key, what)| {
            let pad = key_width.saturating_sub(width(key)) + 2;
            let what_room = room.saturating_sub(key_width + 2);
            Line::from(vec![
                Span::raw(" "),
                Span::styled(key.to_string(), theme::strong(Token::Heading)),
                Span::raw(" ".repeat(pad)),
                Span::styled(fit(what, what_room), theme::ink(Token::MetaText)),
            ])
        })
        .collect();
    let height = u16::try_from(lines.len() + 2).unwrap_or(u16::MAX);
    let [row] = Layout::vertical([Constraint::Length(height)])
        .flex(Flex::Center)
        .areas(area);
    let [spot] = Layout::horizontal([Constraint::Length(box_width)])
        .flex(Flex::Center)
        .areas(row);
    let block = Block::new()
        .borders(Borders::ALL)
        .border_style(theme::ink(Token::Faint))
        .title(Span::styled(
            format!(" {title} "),
            theme::strong(Token::Heading),
        ))
        .style(theme::base());
    frame.render_widget(Clear, spot);
    frame.render_widget(Paragraph::new(lines).block(block), spot);
}
