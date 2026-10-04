//! Watches config/state.json and config/projects.json by polling their
//! size and modified time. Two files checked every two seconds cost next
//! to nothing, need no new crate, and catch the state handler's
//! write-then-rename as readily as an edit in place.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;

/// What identifies one version of a file: when it changed, and its size.
type Stamp = Option<(SystemTime, u64)>;

fn stamp(path: &Path) -> Stamp {
    let m = fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// One watched file.
#[derive(Debug)]
pub struct Watched {
    pub path: PathBuf,
    /// None until the first check, so the first check always reads.
    last: Option<Stamp>,
}

impl Watched {
    pub fn new(path: PathBuf) -> Watched {
        Watched { path, last: None }
    }

    /// True on the first check and whenever the file changed, appeared or
    /// went since the last one.
    pub fn changed(&mut self) -> bool {
        let now = stamp(&self.path);
        let changed = self.last.as_ref() != Some(&now);
        self.last = Some(now);
        changed
    }
}

/// config/state.json; a missing or unreadable file reads as empty, as a
/// first run has none. The error says why, for the log.
pub fn read_state(path: &Path) -> (SavedState, Option<String>) {
    match fs::read_to_string(path) {
        Ok(text) => match SavedState::from_json(&text) {
            Ok(s) => (s, None),
            Err(e) => (
                SavedState::default(),
                Some(format!("{}: {e}", path.display())),
            ),
        },
        Err(e) => (
            SavedState::default(),
            Some(format!("{}: {e}", path.display())),
        ),
    }
}

/// config/projects.json, the project table; a missing or unreadable
/// file reads as no projects.
pub fn read_projects(path: &Path) -> (Vec<Project>, Option<String>) {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => return (Vec::new(), Some(format!("{}: {e}", path.display()))),
    };
    match serde_json::from_str(&text) {
        Ok(p) => (p, None),
        Err(e) => (Vec::new(), Some(format!("{}: {e}", path.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cockpit-pane-watch-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn sees_the_first_check_a_change_and_a_removal() {
        let path = temp("w.json");
        let _ = fs::remove_file(&path);
        let mut w = Watched::new(path.clone());
        assert!(w.changed(), "the first check always reads");
        assert!(!w.changed());
        fs::write(&path, "[]").unwrap();
        assert!(w.changed(), "appeared");
        assert!(!w.changed());
        fs::write(&path, "[1, 2]").unwrap();
        assert!(w.changed(), "a new size");
        fs::remove_file(&path).unwrap();
        assert!(w.changed(), "went");
    }

    #[test]
    fn reads_the_state_and_project_files_or_falls_back_to_empty() {
        let state = temp("state.json");
        fs::write(&state, r#"{"ui": {"mode": "projects"}}"#).unwrap();
        let (s, err) = read_state(&state);
        assert_eq!(
            (s.ui.mode.map(|m| m.as_str()), err),
            (Some("projects"), None)
        );

        let projects = temp("projects.json");
        fs::write(
            &projects,
            r##"[{"match": "/dev/a", "name": "A", "color": "#000", "icon": "star"}]"##,
        )
        .unwrap();
        let (p, err) = read_projects(&projects);
        assert_eq!((p.len(), err), (1, None));

        fs::write(&projects, "not json").unwrap();
        let (p, err) = read_projects(&projects);
        assert!(p.is_empty() && err.is_some());

        let (s, err) = read_state(&temp("missing.json"));
        assert!(err.is_some());
        assert_eq!(s, SavedState::default());
    }
}
