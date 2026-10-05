//! The project editor as the pane shows it: the draft's words from the
//! core's session, the fields the keys move between, and what each key
//! does in the focused field. Nothing is typed into the pane itself: each
//! key sends the field's whole new text to the core, which holds the draft
//! (cockpit_core::edit), so the pane only remembers which field is focused.
//! It holds that as the field itself, not its place, so a folder on offer
//! leaving between frames never moves the focus onto another field.

use cockpit_core::data::Data;
use cockpit_core::edit::{EditEvent, icon_search};
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Field {
    Folder,
    /// A folder on offer, by its place in the list.
    Suggest(usize),
    #[default]
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
    /// The folder as typed, spaces kept, so a space typed mid-path stays.
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
        let found = icon_search(&d.icon, &search);
        EditorView {
            key: key.to_string(),
            is_new,
            note: found.note,
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
            root: s.folder_text().to_string(),
            search,
            icons: found.rows.concat(),
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

    /// The field `focus` stands for now: itself while the editor still has
    /// it, else the folder (for a folder on offer that went), else the
    /// first field.
    pub fn resolve(&self, focus: Field) -> Field {
        let fields = self.fields();
        if fields.contains(&focus) {
            return focus;
        }
        if matches!(focus, Field::Suggest(_)) && fields.contains(&Field::Folder) {
            return Field::Folder;
        }
        fields.first().copied().unwrap_or_default()
    }
}

/// What a key does in the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditKey {
    /// Sends this to the core.
    Send(EditEvent),
    /// Moves the focus to this field.
    Focus(Field),
    Nothing,
}

/// `list`'s item `by` steps from `current`, going round; the first when
/// `current` is not in it. Case is ignored, as the colour dots ignore it.
fn step_in(list: &[String], current: &str, by: isize) -> Option<String> {
    let n = list.len();
    let at = match list.iter().position(|x| x.eq_ignore_ascii_case(current)) {
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

/// What `code` does with `focus` focused.
pub fn key(view: &EditorView, focus: Field, code: KeyCode) -> EditKey {
    let fields = view.fields();
    let field = view.resolve(focus);
    let at = fields.iter().position(|f| *f == field).unwrap_or(0);
    let to = |i: usize| EditKey::Focus(fields.get(i).copied().unwrap_or(field));
    let send = |e: Option<EditEvent>| e.map_or(EditKey::Nothing, EditKey::Send);
    match code {
        KeyCode::Tab | KeyCode::Down => to((at + 1).min(fields.len().saturating_sub(1))),
        KeyCode::BackTab | KeyCode::Up => to(at.saturating_sub(1)),
        KeyCode::Esc if field == Field::Icon => EditKey::Send(EditEvent::CancelSearch),
        KeyCode::Esc => EditKey::Send(EditEvent::Close),
        KeyCode::Enter => EditKey::Send(match field {
            Field::Suggest(i) => match view.suggestions.get(i) {
                Some(dir) => EditEvent::AddSuggested { dir: dir.clone() },
                None => return EditKey::Nothing,
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
            sent(Field::Name, KeyCode::Char('s')),
            EditKey::Send(EditEvent::Name("Apps".into()))
        );
        assert_eq!(
            sent(Field::Name, KeyCode::Char('q')),
            EditKey::Send(EditEvent::Name("Appq".into())),
            "q types, it does not quit"
        );
        assert_eq!(
            sent(Field::Folder, KeyCode::Backspace),
            EditKey::Send(EditEvent::Folder("~/dev/ap".into()))
        );
        assert_eq!(
            sent(Field::Icon, KeyCode::Char('p')),
            EditKey::Send(EditEvent::Search("p".into()))
        );
        assert_eq!(sent(Field::Colour, KeyCode::Char('x')), EditKey::Nothing);
    }

    #[test]
    fn steps_the_colour_and_icon_round_with_the_arrows() {
        let v = view(false);
        assert_eq!(
            key(&v, Field::Colour, KeyCode::Left),
            EditKey::Send(EditEvent::Color(PROJECT_COLORS[15].into()))
        );
        assert_eq!(
            key(&v, Field::Icon, KeyCode::Right),
            EditKey::Send(EditEvent::Icon("star.fill".into()))
        );
        assert_eq!(key(&v, Field::Name, KeyCode::Right), EditKey::Nothing);
    }

    #[test]
    fn steps_on_from_a_colour_written_in_another_case() {
        let mut v = view(false);
        v.color = PROJECT_COLORS[0].to_lowercase();
        assert_eq!(
            key(&v, Field::Colour, KeyCode::Right),
            EditKey::Send(EditEvent::Color(PROJECT_COLORS[1].into()))
        );
    }

    #[test]
    fn enter_saves_takes_a_folder_on_offer_or_taps_remove_and_esc_cancels() {
        let v = view(true);
        assert_eq!(
            key(&v, Field::Suggest(0), KeyCode::Enter),
            EditKey::Send(EditEvent::AddSuggested { dir: "/a/b".into() })
        );
        assert_eq!(
            key(&v, Field::Folder, KeyCode::Enter),
            EditKey::Send(EditEvent::Save)
        );
        assert_eq!(
            key(&v, Field::Folder, KeyCode::Esc),
            EditKey::Send(EditEvent::Close)
        );
        assert_eq!(
            key(&v, Field::Icon, KeyCode::Esc),
            EditKey::Send(EditEvent::CancelSearch)
        );
        let edit = view(false);
        assert_eq!(
            key(&edit, Field::Remove, KeyCode::Enter),
            EditKey::Send(EditEvent::Remove)
        );
    }

    #[test]
    fn moves_between_fields_without_running_off_either_end() {
        let v = view(false);
        assert_eq!(
            key(&v, Field::Name, KeyCode::Up),
            EditKey::Focus(Field::Name)
        );
        assert_eq!(
            key(&v, Field::Name, KeyCode::Tab),
            EditKey::Focus(Field::Colour)
        );
        assert_eq!(
            key(&v, Field::Remove, KeyCode::Down),
            EditKey::Focus(Field::Remove)
        );
    }

    #[test]
    fn keeps_the_focus_on_its_field_when_a_folder_on_offer_goes() {
        let mut v = view(true);
        v.suggestions = vec!["/a".into(), "/b".into()];
        assert_eq!(
            key(&v, Field::Name, KeyCode::Char('s')),
            EditKey::Send(EditEvent::Name("Apps".into()))
        );
        v.suggestions = vec!["/b".into()];
        assert_eq!(
            key(&v, Field::Name, KeyCode::Char('s')),
            EditKey::Send(EditEvent::Name("Apps".into())),
            "still on Name, not shifted onto Colour"
        );
        assert_eq!(v.resolve(Field::Suggest(1)), Field::Folder);
        assert_eq!(
            key(&v, Field::Suggest(1), KeyCode::Enter),
            EditKey::Send(EditEvent::Save),
            "a folder on offer that went hands the focus to Folder"
        );
    }
}
