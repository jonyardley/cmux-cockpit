//! The project editor as the pane shows it: the draft's words from the
//! core's session, the fields the keys move between, and what each key
//! does in the focused field. Nothing is typed into the pane itself: each
//! key sends the field's whole new text to the core, which holds the draft
//! (cockpit_core::edit), so the pane only remembers which field is focused.

use cockpit_core::data::Data;
use cockpit_core::edit::{EditEvent, icon_rows, search_note};
use cockpit_core::projects::PROJECT_COLORS;
use cockpit_core::session::Session;
use ratatui::crossterm::event::KeyCode;

/// The fields' labels, padded to one column.
pub const FOLDER_LABEL: &str = "Folder";
pub const NAME_LABEL: &str = "Name";
pub const COLOUR_LABEL: &str = "Colour";
pub const ICON_LABEL: &str = "Icon";
/// Before a folder on offer.
pub const USE_WORD: &str = "Use";
/// The line at the foot while the draft would save.
pub const EDITOR_HINT: &str = "Enter saves · Esc cancels";
/// Under the icon while it is focused and nothing is searched.
pub const ICON_HINT: &str = "← → to pick, type to search";

/// A field the keys move between.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Folder,
    /// A folder on offer, by its place in the list.
    Suggest(usize),
    Name,
    Colour,
    Icon,
    Remove,
}

/// The open editor, as the pane draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorView {
    /// The project it edits, or the core's NEW_PROJECT.
    pub key: String,
    pub is_new: bool,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub root: String,
    pub search: String,
    /// The icons on offer: the common row, or the search's matches.
    pub icons: Vec<String>,
    /// Under the icons: none found, or how many more.
    pub note: String,
    /// Why Done would not save, or None when it would.
    pub problem: Option<String>,
    pub remove: &'static str,
    /// "Sessions in …", for a project being edited.
    pub matches: String,
    /// Folders of open workspaces that could become a project, for a new one.
    pub suggestions: Vec<String>,
}

impl EditorView {
    /// The editor open on `key`, as the session holds it.
    pub fn from_session(s: &mut Session, data: &Data, key: &str) -> EditorView {
        let is_new = s.is_new_draft();
        let d = s.draft_spec().clone();
        let search = s.icon_search().to_string();
        let icons = icon_rows(&d.icon, &search).concat();
        EditorView {
            key: key.to_string(),
            is_new,
            note: search_note(&search),
            problem: s.draft_problem(),
            remove: s.remove_label(),
            matches: if is_new {
                String::new()
            } else {
                s.matches_line(key)
            },
            suggestions: if is_new {
                s.folder_suggestions(data)
            } else {
                Vec::new()
            },
            name: d.name,
            color: d.color,
            icon: d.icon,
            root: d.root.unwrap_or_default(),
            search,
            icons,
        }
    }

    /// The fields top to bottom: a new project starts on its folder and
    /// the folders on offer; one being edited starts on its name and ends
    /// on Remove.
    pub fn fields(&self) -> Vec<Field> {
        let mut out = Vec::new();
        if self.is_new {
            out.push(Field::Folder);
            out.extend((0..self.suggestions.len()).map(Field::Suggest));
        }
        out.extend([Field::Name, Field::Colour, Field::Icon]);
        if !self.is_new {
            out.extend([Field::Folder, Field::Remove]);
        }
        out
    }
}

/// What a key does in the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditKey {
    /// Sends this to the core.
    Send(EditEvent),
    /// Moves the focus to this field, by its place.
    Focus(usize),
    Nothing,
}

/// `list`'s item `by` steps from `current`, going round; the first when
/// `current` is not in it.
fn step_in(list: &[String], current: &str, by: isize) -> Option<String> {
    let n = list.len();
    let at = match list.iter().position(|x| x == current) {
        Some(i) => (i + n).saturating_add_signed(by) % n.max(1),
        None => 0,
    };
    list.get(at).cloned()
}

fn typed(text: &str, code: KeyCode) -> Option<String> {
    let mut out = text.to_string();
    match code {
        KeyCode::Char(c) => out.push(c),
        KeyCode::Backspace => {
            out.pop()?;
        }
        _ => return None,
    }
    Some(out)
}

/// What `code` does with the field at `focus` focused.
pub fn key(view: &EditorView, focus: usize, code: KeyCode) -> EditKey {
    let fields = view.fields();
    let last = fields.len().saturating_sub(1);
    let field = fields.get(focus.min(last)).copied().unwrap_or(Field::Name);
    let send = |e: Option<EditEvent>| e.map_or(EditKey::Nothing, EditKey::Send);
    match code {
        KeyCode::Tab | KeyCode::Down => EditKey::Focus((focus + 1).min(last)),
        KeyCode::BackTab | KeyCode::Up => EditKey::Focus(focus.saturating_sub(1)),
        KeyCode::Esc if field == Field::Icon => EditKey::Send(EditEvent::CancelSearch),
        KeyCode::Esc => EditKey::Send(EditEvent::Close),
        KeyCode::Enter => EditKey::Send(match field {
            Field::Suggest(i) => match view.suggestions.get(i) {
                Some(dir) => EditEvent::AddSuggested { dir: dir.clone() },
                None => EditEvent::Save,
            },
            Field::Remove => EditEvent::Remove,
            _ => EditEvent::Save,
        }),
        KeyCode::Left | KeyCode::Right => {
            let by = if code == KeyCode::Left { -1 } else { 1 };
            match field {
                Field::Colour => {
                    let colours: Vec<String> =
                        PROJECT_COLORS.iter().map(|c| c.to_string()).collect();
                    send(step_in(&colours, &view.color, by).map(EditEvent::Color))
                }
                Field::Icon => send(step_in(&view.icons, &view.icon, by).map(EditEvent::Icon)),
                _ => EditKey::Nothing,
            }
        }
        code => send(match field {
            Field::Folder => typed(&view.root, code).map(EditEvent::Folder),
            Field::Name => typed(&view.name, code).map(EditEvent::Name),
            Field::Icon => typed(&view.search, code).map(EditEvent::Search),
            _ => None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(is_new: bool) -> EditorView {
        EditorView {
            key: "k".into(),
            is_new,
            name: "App".into(),
            color: PROJECT_COLORS[0].into(),
            icon: "folder.fill".into(),
            root: "~/dev/app".into(),
            search: String::new(),
            icons: vec!["folder.fill".into(), "star.fill".into()],
            note: String::new(),
            problem: None,
            remove: "Remove project",
            matches: String::new(),
            suggestions: vec!["/a/b".into()],
        }
    }

    #[test]
    fn a_new_project_starts_on_its_folder_and_an_edit_on_its_name() {
        assert_eq!(
            view(true).fields(),
            [
                Field::Folder,
                Field::Suggest(0),
                Field::Name,
                Field::Colour,
                Field::Icon
            ]
        );
        assert_eq!(
            view(false).fields(),
            [
                Field::Name,
                Field::Colour,
                Field::Icon,
                Field::Folder,
                Field::Remove
            ]
        );
    }

    #[test]
    fn types_into_the_focused_field_as_its_whole_new_text() {
        let v = view(false);
        let sent = |focus, code| key(&v, focus, code);
        assert_eq!(
            sent(0, KeyCode::Char('s')),
            EditKey::Send(EditEvent::Name("Apps".into()))
        );
        assert_eq!(
            sent(0, KeyCode::Char('q')),
            EditKey::Send(EditEvent::Name("Appq".into())),
            "q types, it does not quit"
        );
        assert_eq!(
            sent(3, KeyCode::Backspace),
            EditKey::Send(EditEvent::Folder("~/dev/ap".into()))
        );
        assert_eq!(
            sent(2, KeyCode::Char('p')),
            EditKey::Send(EditEvent::Search("p".into()))
        );
        assert_eq!(sent(1, KeyCode::Char('x')), EditKey::Nothing);
    }

    #[test]
    fn steps_the_colour_and_icon_round_with_the_arrows() {
        let v = view(false);
        assert_eq!(
            key(&v, 1, KeyCode::Left),
            EditKey::Send(EditEvent::Color(PROJECT_COLORS[15].into()))
        );
        assert_eq!(
            key(&v, 2, KeyCode::Right),
            EditKey::Send(EditEvent::Icon("star.fill".into()))
        );
        assert_eq!(key(&v, 0, KeyCode::Right), EditKey::Nothing);
    }

    #[test]
    fn enter_saves_takes_a_folder_on_offer_or_taps_remove_and_esc_cancels() {
        let v = view(true);
        assert_eq!(
            key(&v, 1, KeyCode::Enter),
            EditKey::Send(EditEvent::AddSuggested { dir: "/a/b".into() })
        );
        assert_eq!(key(&v, 0, KeyCode::Enter), EditKey::Send(EditEvent::Save));
        assert_eq!(key(&v, 0, KeyCode::Esc), EditKey::Send(EditEvent::Close));
        assert_eq!(
            key(&v, 4, KeyCode::Esc),
            EditKey::Send(EditEvent::CancelSearch)
        );
        let edit = view(false);
        assert_eq!(
            key(&edit, 4, KeyCode::Enter),
            EditKey::Send(EditEvent::Remove)
        );
    }

    #[test]
    fn moves_between_fields_without_running_off_either_end() {
        let v = view(false);
        assert_eq!(key(&v, 0, KeyCode::Up), EditKey::Focus(0));
        assert_eq!(key(&v, 0, KeyCode::Tab), EditKey::Focus(1));
        assert_eq!(key(&v, 4, KeyCode::Down), EditKey::Focus(4));
    }
}
