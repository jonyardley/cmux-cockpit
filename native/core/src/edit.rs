//! The project editor under a project's header (src/cockpit/edit.ts): one
//! project open at a time, its draft held here until Done saves it in one
//! go, so a whole edit costs one rebuild rather than one per change. Any
//! project can be edited, whether it came from config/projects.json or was
//! made here; "+ New project" opens it blank to make one from a folder.
//! The icon search's rows and the line under them are here too.

use crate::by_project::{NEW_PROJECT, folder_key};
use crate::data::Data;
use crate::home::{expand_home, is_home, tilde_home};
use crate::js::utf16_len;
use crate::persist::ProjectSpec;
use crate::project_rules::{MAX_PROJECT_KEY, is_hex, is_match_key, is_name, is_root, is_symbol};
use crate::projects::{MAX_NAME, PROJECT_COLORS, PROJECT_ICONS, Project, new_project, next_color};
use crate::session::Session;
use crate::symbols::SYMBOLS;

/// Icons to a row in the picker.
pub const ICONS_PER_ROW: usize = 8;
/// The most matches the picker shows: two rows.
const MAX_MATCHES: usize = 2 * ICONS_PER_ROW;

/// The editor's state: the draft, whether Remove has had its first tap,
/// the icon search's words, and the folder as typed. The draft's root is
/// that text trimmed; the text keeps its spaces, as the sidebar's field
/// keeps its own, so a pane that sends each key as the field's whole new
/// text can type a space mid-path.
#[derive(Debug, Clone, PartialEq)]
pub struct Editor {
    draft: ProjectSpec,
    removing: bool,
    icon_query: String,
    folder_text: String,
}

impl Default for Editor {
    fn default() -> Editor {
        Editor {
            draft: ProjectSpec {
                name: String::new(),
                color: PROJECT_COLORS[0].to_string(),
                icon: PROJECT_ICONS[0].to_string(),
                root: None,
            },
            removing: false,
            icon_query: String::new(),
            folder_text: String::new(),
        }
    }
}

/// What Jon does in the editor, as the core's events carry it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub enum EditEvent {
    /// "+ New project": opens the editor blank, or closes it when open.
    OpenNew,
    /// "Edit project" on a project's header or quiet row.
    Open {
        key: String,
    },
    /// Cancel, or Escape in a field.
    Close,
    Name(String),
    Color(String),
    Icon(String),
    Folder(String),
    /// The icon search's words.
    Search(String),
    /// Escape in the icon search.
    CancelSearch,
    /// Done.
    Save,
    /// A folder on offer, made a project in one go.
    AddSuggested {
        dir: String,
    },
    /// Remove, which asks first.
    Remove,
}

/// A project made from a folder: its key and spec.
type Made = (String, ProjectSpec);

/// Whether a project can be saved from here: its first match is the key it
/// saves under, and the state file refuses one shorter than two segments
/// (a projects.json match such as "applet").
pub fn can_save_project(k: &str) -> bool {
    is_match_key(k)
}

/// The project menu's edit item: what it opens, or why it opens nothing.
pub fn edit_label(k: &str) -> &'static str {
    if can_save_project(k) {
        "Edit project"
    } else {
        "Edit project (its first match is too short to save)"
    }
}

/// A known project's folder, "~" expanded and lowercased, ending in "/";
/// "" without one.
fn root_key(p: &Project, home: Option<&str>) -> String {
    match p.root.as_deref().and_then(|r| expand_home(r, home)) {
        Some(dir) => format!("{}/", folder_key(Some(&dir))),
        None => String::new(),
    }
}

impl Session {
    /// The draft as it stands.
    pub fn draft_spec(&self) -> &ProjectSpec {
        &self.editor.draft
    }

    /// Opens the editor on the project as it now stands; nothing for
    /// Other, a removed one, or one that cannot save.
    pub fn open_editor(&mut self, k: &str) {
        let spec = if can_save_project(k) {
            self.spec_of(k)
        } else {
            None
        };
        let Some(spec) = spec else { return };
        self.editor.folder_text = spec.root.clone().unwrap_or_default();
        self.editor.draft = spec;
        self.editor.removing = false;
        // Opening the open project again keeps the search's words.
        if self.editing_project() != Some(k) {
            self.editor.icon_query.clear();
        }
        self.set_editing_project(Some(k));
    }

    /// Whether the open editor is making a new project rather than editing one.
    pub fn is_new_draft(&self) -> bool {
        self.editing_project() == Some(NEW_PROJECT)
    }

    /// Opens the editor blank, in the next free colour, to make a project
    /// from a folder; a second call closes it.
    pub fn open_new_project(&mut self) {
        if self.is_new_draft() {
            self.close_editor();
            return;
        }
        self.editor.draft = ProjectSpec {
            name: String::new(),
            color: next_color(&self.known_projects()).to_string(),
            icon: PROJECT_ICONS[0].to_string(),
            root: None,
        };
        self.editor.removing = false;
        self.editor.icon_query.clear();
        self.editor.folder_text.clear();
        self.set_editing_project(Some(NEW_PROJECT));
    }

    pub fn close_editor(&mut self) {
        self.set_editing_project(None);
        self.editor.removing = false;
    }

    pub fn set_draft_name(&mut self, name: &str) {
        self.editor.draft.name = name.to_string();
    }

    pub fn set_draft_color(&mut self, color: &str) {
        self.editor.draft.color = color.to_string();
    }

    pub fn set_draft_icon(&mut self, icon: &str) {
        self.editor.draft.icon = icon.to_string();
    }

    /// The icon search's words.
    pub fn icon_search(&self) -> &str {
        &self.editor.icon_query
    }

    pub fn set_icon_search(&mut self, text: &str) {
        self.editor.icon_query = text.to_string();
    }

    /// An empty folder clears it, so the header loses its "+". A new
    /// project takes its name from the folder.
    pub fn set_draft_folder(&mut self, text: &str) {
        self.editor.folder_text = text.to_string();
        let root = text.trim();
        if self.is_new_draft() {
            self.editor.draft.name = self
                .made_from(root)
                .map(|(_, spec)| spec.name)
                .unwrap_or_default();
        }
        self.editor.draft.root = (!root.is_empty()).then(|| root.to_string());
    }

    /// The folder as typed, spaces kept.
    pub fn folder_text(&self) -> &str {
        &self.editor.folder_text
    }

    /// The typed folder, "~" expanded once: missing, not a full path, or home.
    fn path_problem(&self, root: &str) -> Result<String, String> {
        if root.trim().is_empty() {
            return Err("Type the project's folder.".into());
        }
        let home = self.home.as_deref();
        let dir = match expand_home(root, home) {
            Some(dir) if dir.starts_with('/') => dir,
            _ => return Err("Type the folder's full path, starting with / or ~/.".into()),
        };
        if is_home(Some(&dir), home) {
            return Err("That is your home folder: pick one inside it, such as ~/dev/app.".into());
        }
        Ok(dir)
    }

    /// Where a project matches: every match of a built one, else its key.
    fn matches_for(&self, p: &Project) -> Vec<String> {
        let built = self.projects.iter().find(|x| x.id() == p.id());
        built.unwrap_or(p).matches_of().to_vec()
    }

    /// The project already holding the folder, or one the folder would
    /// swallow. Known projects count those sent but not built, and not
    /// those removed.
    fn overlap_problem(&self, made: &Made, known: &[Project]) -> Option<String> {
        let (d, spec) = made;
        let owner = known
            .iter()
            .find(|p| self.matches_for(p).iter().any(|m| d.contains(m.as_str())));
        if let Some(owner) = owner {
            return Some(format!("That folder is already in {}.", owner.name));
        }
        let home = self.home.as_deref();
        let inside = known.iter().find(|p| {
            let mut keys = self.matches_for(p);
            keys.push(root_key(p, home));
            keys.iter().any(|m| m != d && m.starts_with(d.as_str()))
        })?;
        let shown = tilde_home(spec.root.as_deref().unwrap_or_default(), home);
        Some(format!(
            "{shown} holds other projects, such as {}: pick a folder inside it.",
            inside.name
        ))
    }

    /// One check for the editor's words, Done and a suggested folder: the
    /// project the folder would make, or why it cannot, in words.
    fn check_folder(&self, root: &str) -> Result<Made, String> {
        let dir = self.path_problem(root)?;
        let known = self.known_projects();
        let made = new_project(Some(&dir), &known).ok_or_else(|| {
            "Pick a folder at least two levels deep, such as ~/dev/app.".to_string()
        })?;
        if !is_match_key(&made.0) {
            return Err(format!(
                "Keep the folder's path under {MAX_PROJECT_KEY} characters."
            ));
        }
        match self.overlap_problem(&made, &known) {
            Some(problem) => Err(problem),
            None => Ok(made),
        }
    }

    /// The project a typed folder would make; None when it cannot make one.
    fn made_from(&self, root: &str) -> Option<Made> {
        self.check_folder(root).ok()
    }

    /// Escape in the search: with words typed it does nothing, so the
    /// draft is not lost; empty, it closes as Cancel does.
    pub fn cancel_search(&mut self) {
        if self.editor.icon_query.trim().is_empty() {
            self.close_editor();
        }
    }

    /// The name is trimmed first, so the state file's rule fails it only
    /// on length or a control character; each gets its own words.
    fn name_problem(&self, name: &str) -> Option<String> {
        if name.is_empty() {
            return Some("Give the project a name.".into());
        }
        if utf16_len(name) > MAX_NAME {
            return Some(format!("Keep the name to {MAX_NAME} characters."));
        }
        if !is_name(name) {
            return Some("The name cannot hold tabs or line breaks.".into());
        }
        let k = self.editing_project();
        let taken = self
            .known_projects()
            .iter()
            .any(|p| p.name == name && Some(p.id()) != k);
        taken.then(|| format!("Another project is called {name}."))
    }

    /// Why Done would not save, in words, or None when it would: the rules
    /// the state file holds (project_rules.rs).
    pub fn draft_problem(&self) -> Option<String> {
        let d = &self.editor.draft;
        if self.is_new_draft()
            && let Err(problem) = self.check_folder(d.root.as_deref().unwrap_or_default())
        {
            return Some(problem);
        }
        if let Some(problem) = self.name_problem(d.name.trim()) {
            return Some(problem);
        }
        if !is_hex(&d.color) {
            return Some("Pick a colour from the dots.".into());
        }
        if !is_symbol(&d.icon) {
            return Some("Pick an icon.".into());
        }
        if d.root.as_deref().is_some_and(|r| !is_root(r)) {
            return Some("The folder needs a full path, starting with / or ~/.".into());
        }
        None
    }

    /// Saves the draft and closes, or does nothing while draft_problem()
    /// has a reason. Unchanged, it only closes. A new project opens a
    /// workspace in its folder unless one is open there already.
    pub fn save_draft(&mut self, data: &Data) {
        let Some(k) = self.editing_project().map(str::to_string) else {
            return;
        };
        if self.draft_problem().is_some() {
            return;
        }
        if k == NEW_PROJECT {
            self.save_new(data);
            return;
        }
        let mut spec = self.editor.draft.clone();
        spec.name = spec.name.trim().to_string();
        if self.spec_of(&k).as_ref() != Some(&spec) {
            self.save_project(&k, spec);
        }
        self.close_editor();
    }

    /// Saved under the folder's own key, its "~" expanded.
    fn save_new(&mut self, data: &Data) {
        let Some((key, made)) =
            self.made_from(self.editor.draft.root.as_deref().unwrap_or_default())
        else {
            return;
        };
        let d = &self.editor.draft;
        let spec = ProjectSpec {
            name: d.name.trim().to_string(),
            color: d.color.clone(),
            icon: d.icon.clone(),
            root: made.root,
        };
        let root = spec.root.clone();
        self.save_project(&key, spec);
        self.close_editor();
        if let Some(root) = root {
            self.open_folder_once(data, &root);
        }
    }

    /// A suggested folder, in one go: saved in the draft's colour and
    /// icon, named after the folder. Its workspace is already open.
    pub fn add_suggested(&mut self, dir: &str) {
        let Some((key, made)) = self.made_from(dir) else {
            return;
        };
        let spec = ProjectSpec {
            color: self.editor.draft.color.clone(),
            icon: self.editor.draft.icon.clone(),
            ..made
        };
        self.save_project(&key, spec);
        self.close_editor();
    }

    /// Remove's words: asking, or asked once.
    pub fn remove_label(&self) -> &'static str {
        if self.editor.removing {
            "Tap again to remove"
        } else {
            "Remove project"
        }
    }

    /// The first call asks, the second removes.
    pub fn remove_tapped(&mut self) {
        let Some(k) = self.editing_project().map(str::to_string) else {
            return;
        };
        if !self.editor.removing {
            self.editor.removing = true;
            return;
        }
        self.remove_project(&k);
        self.close_editor();
    }

    /// Which folders put a session in the project, for the line under the
    /// folder field.
    pub fn matches_line(&self, k: &str) -> String {
        let matches = match self.projects.iter().find(|x| x.id() == k) {
            Some(p) => p.matches_of().to_vec(),
            None => vec![k.to_string()],
        };
        format!("Sessions in {}", matches.join(", "))
    }

    /// One of Jon's actions in the editor.
    pub fn edit(&mut self, data: &Data, e: EditEvent) {
        match e {
            EditEvent::OpenNew => self.open_new_project(),
            EditEvent::Open { key } => self.open_editor(&key),
            EditEvent::Close => self.close_editor(),
            EditEvent::Name(v) => self.set_draft_name(&v),
            EditEvent::Color(v) => self.set_draft_color(&v),
            EditEvent::Icon(v) => self.set_draft_icon(&v),
            EditEvent::Folder(v) => self.set_draft_folder(&v),
            EditEvent::Search(v) => self.set_icon_search(&v),
            EditEvent::CancelSearch => self.cancel_search(),
            EditEvent::Save => self.save_draft(data),
            EditEvent::AddSuggested { dir } => self.add_suggested(&dir),
            EditEvent::Remove => self.remove_tapped(),
        }
    }
}

/// `list` cut into rows of `n`, the last one short.
pub fn rows_of<T: Clone>(list: &[T], n: usize) -> Vec<Vec<T>> {
    list.chunks(n.max(1)).map(<[T]>::to_vec).collect()
}

/// The common row: PROJECT_ICONS, always one row. A project whose icon is
/// not one of them gets it as the first choice, so it shows selected and
/// can be picked again; the last common icon gives up its place.
pub fn common_icons(current: &str) -> Vec<String> {
    let known = PROJECT_ICONS.iter().map(|s| s.to_string());
    if PROJECT_ICONS.contains(&current) || !is_symbol(current) {
        return known.collect();
    }
    std::iter::once(current.to_string())
        .chain(known.take(ICONS_PER_ROW - 1))
        .collect()
}

fn words_of(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '.')
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Every word starts one of the name's dotted parts: "cat" is cat.fill,
/// not location.fill.
fn starts_parts(name: &str, words: &[String]) -> bool {
    words
        .iter()
        .all(|w| name.split('.').any(|p| p.starts_with(w.as_str())))
}

/// Every stored symbol holding each word typed, across the dots, so
/// "music note" finds music.note. Names whose parts start with the words
/// come first.
fn all_matches(query: &str) -> Vec<&'static str> {
    let words = words_of(query);
    if words.is_empty() {
        return Vec::new();
    }
    let hits: Vec<&'static str> = SYMBOLS
        .iter()
        .copied()
        .filter(|n| words.iter().all(|w| n.contains(w.as_str())))
        .collect();
    let (first, rest): (Vec<&str>, Vec<&str>) =
        hits.into_iter().partition(|n| starts_parts(n, &words));
    first.into_iter().chain(rest).collect()
}

/// The matches the picker shows: as many as two rows take.
pub fn icon_matches(query: &str) -> Vec<String> {
    all_matches(query)
        .into_iter()
        .take(MAX_MATCHES)
        .map(str::to_string)
        .collect()
}

/// The picker's rows and the line under them, from one pass over the
/// symbols.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconSearch {
    pub rows: Vec<Vec<String>>,
    pub note: String,
}

/// The picker for `query`: the common row while the search is empty,
/// else its matches eight to a row, with the note under them.
pub fn icon_search(current: &str, query: &str) -> IconSearch {
    if query.trim().is_empty() {
        return IconSearch {
            rows: rows_of(&common_icons(current), ICONS_PER_ROW),
            note: String::new(),
        };
    }
    let all = all_matches(query);
    let shown: Vec<String> = all
        .iter()
        .take(MAX_MATCHES)
        .map(|s| s.to_string())
        .collect();
    let n = all.len();
    let note = if n == 0 {
        format!("No icons match \"{}\".", query.trim())
    } else if n > MAX_MATCHES {
        format!("{} more: type more of the name.", n - MAX_MATCHES)
    } else {
        String::new()
    };
    IconSearch {
        rows: rows_of(&shown, ICONS_PER_ROW),
        note,
    }
}

/// The picker's rows, eight to a row: the common row while the search is
/// empty, else its matches.
pub fn icon_rows(current: &str, query: &str) -> Vec<Vec<String>> {
    icon_search(current, query).rows
}

/// The line under the rows: none found, or how many more a longer word
/// would reach; "" otherwise.
pub fn search_note(query: &str) -> String {
    icon_search("", query).note
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::SavedState;

    fn session(home: Option<&str>) -> Session {
        let table: Vec<Project> = serde_json::from_str(
            r##"[{"match": "/dev/app", "name": "App", "color": "#000000", "icon": "x", "root": "~/dev/App/"}]"##,
        )
        .unwrap();
        let mut s = Session::new(table, SavedState::default());
        s.home = home.map(str::to_string);
        s
    }

    #[test]
    fn keys_a_root_lowercased_with_one_trailing_slash() {
        let s = session(Some("/Users/me"));
        assert_eq!(
            root_key(&s.projects[0], Some("/Users/me")),
            "/users/me/dev/app/"
        );
        let bare = Project {
            root: None,
            ..s.projects[0].clone()
        };
        assert_eq!(root_key(&bare, None), "");
    }

    #[test]
    fn reads_a_tilde_folder_only_once_home_is_known() {
        let known = session(Some("/Users/me"));
        assert_eq!(
            known.path_problem("~/dev/quill"),
            Ok("/Users/me/dev/quill".to_string())
        );
        assert!(known.path_problem("~").is_err(), "home itself is refused");
        let unknown = session(None);
        assert_eq!(
            unknown.path_problem("~/dev/quill"),
            Err("Type the folder's full path, starting with / or ~/.".to_string())
        );
        assert_eq!(
            unknown.path_problem("  "),
            Err("Type the project's folder.".to_string())
        );
    }

    #[test]
    fn keeps_a_space_typed_mid_folder_while_the_draft_takes_it_trimmed() {
        let mut s = session(Some("/Users/me"));
        s.open_new_project();
        s.set_draft_folder("/Users/me/My ");
        assert_eq!(s.folder_text(), "/Users/me/My ");
        assert_eq!(s.draft_spec().root.as_deref(), Some("/Users/me/My"));
        s.set_draft_folder("/Users/me/My C");
        assert_eq!(s.draft_spec().root.as_deref(), Some("/Users/me/My C"));
        s.open_new_project();
        s.open_new_project();
        assert_eq!(s.folder_text(), "", "a new editor starts blank");
    }

    #[test]
    fn opens_an_edit_on_the_projects_folder_as_written() {
        let mut s = session(Some("/Users/me"));
        s.open_editor("/dev/app");
        assert_eq!(s.folder_text(), "~/dev/App/");
    }

    #[test]
    fn finds_the_rows_and_the_note_in_one_search() {
        let found = icon_search("folder.fill", "zzz");
        assert!(found.rows.is_empty());
        assert_eq!(found.note, "No icons match \"zzz\".");
        let common = icon_search("folder.fill", " ");
        assert_eq!(common.rows.len(), 1);
        assert_eq!(common.note, "");
    }
}
