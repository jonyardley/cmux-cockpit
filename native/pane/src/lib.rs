//! The cockpit in a terminal: a ratatui pane that draws the core's All
//! view (Next, Needs you and the lanes) and lets up and down walk the
//! cards. It reads only; nothing here writes to cmux or the state file.
//!
//! A runner owns the terminal and the core. Each frame it builds a
//! `PaneModel` from the core and hands it to `Pane::set_view_model`, passes
//! each terminal event to `Pane::handle_event`, and calls `Pane::draw`,
//! which only draws when something changed: a new model, a key that moved
//! the cursor or the keys overlay, or a new terminal size.

pub mod cursor;
pub mod model;
pub mod text;
pub mod theme;
mod views;

use ratatui::Terminal;
use ratatui::backend::Backend;
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Size;

use crate::cursor::Cursor;
pub use crate::model::PaneModel;

/// What an event asks of the runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing changed.
    Nothing,
    /// Something on screen changed; `draw` will draw it.
    Redraw,
    /// Leave the pane.
    Quit,
}

/// The pane: the model it draws, the card cursor and the keys overlay.
#[derive(Debug, Clone, Default)]
pub struct Pane {
    model: PaneModel,
    cursor: Cursor,
    keys: bool,
    /// Something changed since the last draw.
    dirty: bool,
    /// The size the last draw filled; None before the first.
    drawn_at: Option<Size>,
}

impl Pane {
    /// A pane drawing `model`.
    pub fn new(model: PaneModel) -> Pane {
        Pane {
            model,
            dirty: true,
            ..Pane::default()
        }
    }

    /// The model it draws.
    pub fn model(&self) -> &PaneModel {
        &self.model
    }

    /// The card under the cursor, by workspace id.
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.on()
    }

    /// Whether the keys overlay is up.
    pub fn keys_shown(&self) -> bool {
        self.keys
    }

    /// Takes a new frame's model. Only a model that differs from the one on
    /// screen asks for a draw; the cursor stays on its card if it is still
    /// there. True when it changed.
    pub fn set_view_model(&mut self, model: PaneModel) -> bool {
        if model == self.model {
            return false;
        }
        self.model = model;
        self.cursor.settle(&self.model.card_ids());
        self.dirty = true;
        true
    }

    /// Whether the next `draw` will draw: something changed, or the
    /// terminal is not the size last drawn.
    pub fn needs_draw(&self, size: Size) -> bool {
        self.dirty || self.drawn_at != Some(size)
    }

    /// Handles a terminal event: keys, and a resize, which asks for a draw.
    pub fn handle_event(&mut self, event: &Event) -> Outcome {
        match event {
            Event::Key(key) => self.handle_key(*key),
            Event::Resize(..) => {
                self.dirty = true;
                Outcome::Redraw
            }
            _ => Outcome::Nothing,
        }
    }

    /// Handles a key: up and down move the cursor, `?` shows or hides the
    /// keys, Esc hides them, `q` or Ctrl-C quits.
    pub fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if key.kind == KeyEventKind::Release {
            return Outcome::Nothing;
        }
        let changed = match key.code {
            KeyCode::Char('q') => return Outcome::Quit,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Outcome::Quit;
            }
            KeyCode::Up => self.cursor.step(&self.model.card_ids(), -1),
            KeyCode::Down => self.cursor.step(&self.model.card_ids(), 1),
            KeyCode::Char('?') => {
                self.keys = !self.keys;
                true
            }
            KeyCode::Esc if self.keys => {
                self.keys = false;
                true
            }
            _ => false,
        };
        if changed {
            self.dirty = true;
            Outcome::Redraw
        } else {
            Outcome::Nothing
        }
    }

    /// Draws when something changed or the terminal was resized; true when
    /// it drew.
    pub fn draw<B: Backend>(&mut self, terminal: &mut Terminal<B>) -> Result<bool, B::Error> {
        let size = terminal.size()?;
        if !self.needs_draw(size) {
            return Ok(false);
        }
        let shown = views::Shown {
            model: &self.model,
            cursor: self.cursor.on(),
            keys: self.keys,
        };
        terminal.draw(|frame| views::draw(frame, shown))?;
        self.dirty = false;
        self.drawn_at = Some(size);
        Ok(true)
    }
}
