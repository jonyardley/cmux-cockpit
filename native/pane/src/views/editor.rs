//! The project editor's lines: a row per field, a label column, the
//! focused field with the cursor's bar and face and a caret after its text,
//! then why Done would not save, or how to save.

use std::ops::Range;

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::parts::{Edge, spread};
use crate::editor::{
    COLOUR_LABEL, EDITOR_HINT, EditorView, FOLDER_LABEL, Field, ICON_HINT, ICON_LABEL, NAME_LABEL,
    USE_WORD,
};
use crate::model::{DOT, HOLLOW};
use crate::text::{fit, width};
use crate::theme;
use cockpit_core::projects::PROJECT_COLORS;
use cockpit_core::theme::Token;

/// The label column's width, labels included.
const LABEL: usize = 9;
/// After the focused text field's words.
const CARET: &str = "▏";

/// The editor laid out, and the focused field's line.
pub struct Laid {
    pub lines: Vec<Line<'static>>,
    pub focus: Option<Range<usize>>,
}

fn padded(label: &str) -> String {
    format!("  {label:<width$}", width = LABEL - 2)
}

/// One field's line: its label, then `value`, lit when focused.
fn row(label: &str, value: Vec<Span<'static>>, inner: usize, on: bool) -> Line<'static> {
    let mut left = vec![Span::styled(padded(label), theme::ink(Token::Faint))];
    left.extend(value);
    let edge = if on { Edge::Cursor } else { Edge::Plain };
    let line = spread(left, Vec::new(), inner, edge);
    if on {
        line.patch_style(Style::new().bg(theme::rgb(theme::CURSOR_BG)))
    } else {
        line
    }
}

fn text(words: &str, inner: usize, on: bool) -> Vec<Span<'static>> {
    let room = inner.saturating_sub(LABEL + 1);
    let mut out = vec![Span::styled(fit(words, room), theme::title())];
    if on {
        out.push(Span::styled(CARET, theme::ink(Token::Select)));
    }
    out
}

/// The colours as dots in their own colour, the draft's hollow.
fn dots(chosen: &str) -> Vec<Span<'static>> {
    PROJECT_COLORS
        .iter()
        .map(|c| {
            let mark = if c.eq_ignore_ascii_case(chosen) {
                HOLLOW
            } else {
                DOT
            };
            let ink = theme::parse_hex(c).unwrap_or(theme::GREY);
            Span::styled(mark, theme::plain(ink))
        })
        .collect()
}

/// A line under a field, indented to the values, in `ink`.
fn under(words: &str, inner: usize, ink: Style) -> Line<'static> {
    let spans = vec![
        Span::raw(" ".repeat(LABEL)),
        Span::styled(fit(words, inner.saturating_sub(LABEL)), ink),
    ];
    spread(spans, Vec::new(), inner, Edge::Plain)
}

/// The icon's line: the draft's icon name and, while a search is typed,
/// its words.
fn icon_value(e: &EditorView, inner: usize, on: bool) -> Vec<Span<'static>> {
    let room = inner.saturating_sub(LABEL + 1);
    let mut out = vec![Span::styled(fit(&e.icon, room), theme::title())];
    if !e.search.is_empty() || on {
        let left = room.saturating_sub(width(&e.icon) + 2);
        out.push(Span::raw("  "));
        let words = fit(&e.search, left);
        out.push(Span::styled(words, theme::plain(theme::SECONDARY)));
        if on {
            out.push(Span::styled(CARET, theme::ink(Token::Select)));
        }
    }
    out
}

/// The editor's lines; `focus` is the focused field's place.
pub fn lines(e: &EditorView, inner: usize, focus: usize) -> Laid {
    let fields = e.fields();
    let focus = focus.min(fields.len().saturating_sub(1));
    let mut out = Vec::new();
    let mut at = None;
    for (i, f) in fields.iter().enumerate() {
        let on = i == focus;
        if on {
            at = Some(out.len()..out.len() + 1);
        }
        let line = match f {
            Field::Folder => row(FOLDER_LABEL, text(&e.root, inner, on), inner, on),
            Field::Suggest(n) => {
                let dir = e.suggestions.get(*n).cloned().unwrap_or_default();
                let words = format!("{USE_WORD} {dir}");
                let value = vec![Span::styled(words, theme::plain(theme::SECONDARY))];
                row("", value, inner, on)
            }
            Field::Name => row(NAME_LABEL, text(&e.name, inner, on), inner, on),
            Field::Colour => row(COLOUR_LABEL, dots(&e.color), inner, on),
            Field::Icon => row(ICON_LABEL, icon_value(e, inner, on), inner, on),
            Field::Remove => {
                let value = vec![Span::styled(e.remove, theme::ink(Token::RedText))];
                row("", value, inner, on)
            }
        };
        out.push(line);
        if *f == Field::Icon {
            let faint = theme::ink(Token::Faint);
            if !e.note.is_empty() {
                out.push(under(&e.note, inner, faint));
            } else if on && e.search.is_empty() {
                out.push(under(ICON_HINT, inner, faint));
            }
        }
        if *f == Field::Folder && !e.matches.is_empty() {
            out.push(under(&e.matches, inner, theme::ink(Token::Faint)));
        }
    }
    let foot = match &e.problem {
        Some(p) => under(p, inner, theme::ink(Token::RedText)),
        None => under(EDITOR_HINT, inner, theme::ink(Token::Faint)),
    };
    out.push(foot);
    Laid {
        lines: out,
        focus: at,
    }
}
