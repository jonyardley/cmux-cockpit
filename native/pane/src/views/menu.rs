//! The open card or project menu: a box over the pane listing its items,
//! the lit one with the cursor's bar and face, a rule for each divider,
//! and how to pick or close under them.

use ratatui::Frame;
use ratatui::layout::{Constraint, Flex, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use super::parts::CURSOR_BAR;
use crate::menu::{MENU_HINT, title, window};
use crate::text::fit;
use crate::theme;
use cockpit_core::menu::{MenuItem, MenuView};
use cockpit_core::theme::Token;

/// The box's widest, borders included.
const MAX_WIDTH: u16 = 44;
/// A divider's rule.
const RULE: &str = "─";

fn line(item: &MenuItem, room: usize, lit: bool) -> Line<'static> {
    match item {
        MenuItem::Divider => Line::from(Span::styled(
            RULE.repeat(room + 2),
            theme::ink(Token::Faint),
        )),
        MenuItem::Item { label, .. } => {
            let bar = if lit {
                Span::styled(CURSOR_BAR, theme::ink(Token::Select))
            } else {
                Span::raw(" ")
            };
            let words = fit(label, room);
            let pad = " ".repeat(room.saturating_sub(crate::text::width(&words)) + 1);
            let l = Line::from(vec![
                bar,
                Span::styled(words, theme::ink(Token::Heading)),
                Span::raw(pad),
            ]);
            if lit {
                l.patch_style(Style::new().bg(theme::rgb(theme::CURSOR_BG)))
            } else {
                l
            }
        }
    }
}

/// Draws `view` in the middle of `area`, the item at `at` lit.
pub fn draw(frame: &mut Frame<'_>, area: Rect, view: &MenuView, at: usize) {
    let box_width = MAX_WIDTH.min(area.width);
    // Borders, and the bar's column and a space after the words.
    let room = usize::from(box_width).saturating_sub(4);
    // Borders take two lines.
    let tall = usize::from(area.height).saturating_sub(2);
    let shown = window(view.items.len(), at, tall);
    let lines: Vec<Line<'static>> = view
        .items
        .iter()
        .enumerate()
        .skip(shown.start)
        .take(shown.len())
        .map(|(i, item)| line(item, room, i == at))
        .collect();
    let height = u16::try_from(lines.len() + 2).unwrap_or(u16::MAX);
    let [row] = Layout::vertical([Constraint::Length(height)])
        .flex(Flex::Center)
        .areas(area);
    let [spot] = Layout::horizontal([Constraint::Length(box_width)])
        .flex(Flex::Center)
        .areas(row);
    let hint_room = room.saturating_sub(2);
    let block = Block::new()
        .borders(Borders::ALL)
        .border_style(theme::ink(Token::Faint))
        .title(Span::styled(
            format!(" {} ", title(&view.target)),
            theme::strong(Token::Heading),
        ))
        .title_bottom(Span::styled(
            format!(" {} ", fit(MENU_HINT, hint_room)),
            theme::ink(Token::MetaText),
        ))
        .style(theme::base());
    frame.render_widget(Clear, spot);
    frame.render_widget(Paragraph::new(lines).block(block), spot);
}
