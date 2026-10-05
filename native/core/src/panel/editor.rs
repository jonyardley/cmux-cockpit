//! The open project editor as the panel shows it: the draft's words from
//! the session (edit.rs holds the draft), and the fields a shell's keys
//! move between.

use serde::Serialize;

use crate::data::Data;
use crate::edit::icon_search;
use crate::session::Session;

/// A field the keys move between.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
