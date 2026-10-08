//! Watches config/state.json and config/projects.json by polling their
//! size and modified time. Two files checked every two seconds cost next
//! to nothing, need no new crate, and catch the state handler's
//! write-then-rename as readily as an edit in place.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use cockpit_core::lanes::{LaneConfig, Lanes};
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

/// A file's text; None when it does not exist, which is no error.
fn text_of(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// config/state.json; a missing file reads as empty, as a first run has
/// none. An unreadable one is an error, so the caller keeps what it had.
pub fn read_state(path: &Path) -> Result<SavedState, String> {
    match text_of(path)? {
        Some(text) => SavedState::from_json(&text).map_err(|e| format!("{}: {e}", path.display())),
        None => Ok(SavedState::default()),
    }
}

/// config/projects.json, the project table; a missing file reads as no
/// projects, an unreadable one as an error.
pub fn read_projects(path: &Path) -> Result<Vec<Project>, String> {
    match text_of(path)? {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        None => Ok(Vec::new()),
    }
}

/// config/lanes.json, the lane table; a missing file reads as no lanes
/// (today's four), and one that will not read, or that the core could not
/// draw (lanes.rs), as an error.
pub fn read_lanes(path: &Path) -> Result<Vec<LaneConfig>, String> {
    let Some(text) = text_of(path)? else {
        return Ok(Vec::new());
    };
    let lanes: Vec<LaneConfig> =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Lanes::from_config(&lanes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(lanes)
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
    fn reads_the_state_and_project_files() {
        let state = temp("state.json");
        fs::write(&state, r#"{"ui": {"mode": "projects"}}"#).unwrap();
        let s = read_state(&state).unwrap();
        assert_eq!(s.ui.mode.map(|m| m.as_str()), Some("projects"));

        let projects = temp("projects.json");
        fs::write(
            &projects,
            r##"[{"match": "/dev/a", "name": "A", "color": "#000", "icon": "star"}]"##,
        )
        .unwrap();
        assert_eq!(read_projects(&projects).unwrap().len(), 1);
    }

    #[test]
    fn reads_the_lane_file_and_refuses_one_the_core_cannot_draw() {
        assert_eq!(read_lanes(&temp("missing.json")), Ok(Vec::new()));
        let lanes = temp("lanes.json");
        fs::write(
            &lanes,
            r#"[{"name": "Doing"}, {"id": "later", "name": "Later"}]"#,
        )
        .unwrap();
        let read = read_lanes(&lanes).unwrap();
        let names: Vec<&str> = read.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Doing", "Later"]);
        fs::write(&lanes, r#"[{"name": "Doing", "color": "red"}]"#).unwrap();
        let refused = read_lanes(&lanes).unwrap_err();
        assert!(refused.contains("unknown colour"), "{refused}");
        fs::write(&lanes, r#"[{"name": "Doing", "colour": "laneMain"}]"#).unwrap();
        let misspelt = read_lanes(&lanes).unwrap_err();
        assert!(misspelt.contains("unknown field"), "{misspelt}");
        fs::write(&lanes, r#"[{"name": "Doing", "left_off": true}]"#).unwrap();
        assert!(read_lanes(&lanes).is_err(), "leftOff, not left_off");
        fs::write(&lanes, r#"[{"name": "Unsorted"}]"#).unwrap();
        assert!(read_lanes(&lanes).is_err(), "Unsorted's name");
        fs::write(&lanes, r#"[{"name": "#).unwrap();
        assert!(read_lanes(&lanes).is_err());
    }

    #[test]
    fn a_missing_file_is_empty_and_a_torn_one_an_error() {
        assert_eq!(read_state(&temp("missing.json")), Ok(SavedState::default()));
        assert_eq!(read_projects(&temp("missing.json")), Ok(Vec::new()));
        let torn = temp("torn.json");
        fs::write(&torn, "[{\"match\": ").unwrap();
        assert!(read_projects(&torn).is_err());
        assert!(read_state(&torn).is_err());
    }
}
