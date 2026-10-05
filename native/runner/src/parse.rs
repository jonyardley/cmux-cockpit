//! Reads what the runner's commands print: `claude agents --json`,
//! `cmux --json workspace list`, `cmux rpc workspace.group.list`, and the
//! timestamps on `cmux events`.
//! Plain functions over bytes and JSON, so the tests need no processes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cockpit_core::data::{Workspace, WorkspaceGroup};
use serde_json::Value;

/// Claude's own view of its sessions, from `claude agents --json`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentView {
    /// pid to busy, for interactive sessions.
    pub busy: HashMap<u32, bool>,
    /// pid to session id, which the core keys dismissals by.
    pub session: HashMap<u32, String>,
}

/// `claude agents --json`, or None when it is not a list. Background
/// sessions carry no pid, so they cannot be joined and are skipped.
pub fn agents(out: &[u8]) -> Option<AgentView> {
    let list: Vec<Value> = serde_json::from_slice(out).ok()?;
    let mut view = AgentView::default();
    for a in &list {
        let Some(pid) = a["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) else {
            continue;
        };
        view.busy.insert(pid, a["status"] == "busy");
        if let Some(id) = a["sessionId"].as_str() {
            view.session.insert(pid, id.to_string());
        }
    }
    Some(view)
}

/// Agent Views read from several Claude config dirs, as one.
pub fn merged(views: impl IntoIterator<Item = AgentView>) -> AgentView {
    let mut all = AgentView::default();
    for v in views {
        all.busy.extend(v.busy);
        all.session.extend(v.session);
    }
    all
}

/// Each config dir's last good Agent View, keyed by the dir the read was
/// made with (None for the runner's own, read with nothing set).
#[derive(Debug, Default)]
pub struct AgentViews(HashMap<Option<PathBuf>, AgentView>);

impl AgentViews {
    /// Takes one poll's reads and returns every dir's latest view as one.
    /// A failed read keeps that dir's last view, so a dir that missed one
    /// poll does not have its sessions counted absent and forgotten, and
    /// one that never read contributes nothing without holding the others
    /// up. A dir no longer polled is dropped. None until some dir has read.
    pub fn update(
        &mut self,
        reads: impl IntoIterator<Item = (Option<PathBuf>, Option<AgentView>)>,
    ) -> Option<AgentView> {
        let mut polled = HashMap::new();
        for (dir, view) in reads {
            let last = self.0.remove(&dir);
            if let Some(v) = view.or(last) {
                polled.insert(dir, v);
            }
        }
        self.0 = polled;
        (!self.0.is_empty()).then(|| merged(self.0.values().cloned()))
    }
}

/// The Claude config dirs besides the default one that Agent View must
/// also read: each `.claude-<name>` folder in `home` holding a `sessions`
/// folder, which only a Claude config dir has, and `.claude` itself when
/// the runner inherited a CLAUDE_CONFIG_DIR (`inherited`), since the
/// default read then covers that dir instead. The inherited dir is never
/// read twice: both sides are compared as `canonical` gives them.
/// `claude agents --json` lists one config dir's sessions only, so a
/// session started with another CLAUDE_CONFIG_DIR would read as gone.
pub fn other_config_dirs(
    home: &Path,
    names: impl IntoIterator<Item = String>,
    has_sessions: impl Fn(&Path) -> bool,
    inherited: Option<&Path>,
    canonical: impl Fn(&Path) -> PathBuf,
) -> Vec<PathBuf> {
    let inherited = inherited.map(&canonical);
    let mut dirs: Vec<PathBuf> = names
        .into_iter()
        .filter_map(|n| {
            let default = n == ".claude" && inherited.is_some();
            let named = n
                .strip_prefix(".claude-")
                .is_some_and(|rest| !rest.is_empty());
            let d = home.join(n);
            (default || (named && has_sessions(&d))).then_some(d)
        })
        .filter(|d| inherited.as_ref() != Some(&canonical(d)))
        .collect();
    dirs.sort();
    dirs
}

/// The window a reply answers for (`window:1`), from its `window_ref`.
pub fn window_ref(out: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(out).ok()?;
    v["window_ref"].as_str().map(str::to_string)
}

/// `cmux --json workspace list` as the core's workspaces, in cmux's
/// order, or None when the output has no list.
pub fn workspaces(out: &[u8]) -> Option<Vec<Workspace>> {
    let v: Value = serde_json::from_slice(out).ok()?;
    let list = v["workspaces"].as_array()?;
    Some(list.iter().filter_map(workspace).collect())
}

/// One row of the workspace list, renamed to the fields the sidebar's
/// data uses. The list has no groups, agents or pull requests.
fn workspace(w: &Value) -> Option<Workspace> {
    let text = |k: &str| w[k].as_str().map(str::to_string);
    let ports: Vec<f64> = w["listening_ports"]
        .as_array()
        .map(|ps| ps.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    Some(Workspace {
        id: w["id"].as_str()?.to_string(),
        title: text("title"),
        directory: text("current_directory"),
        selected: w["selected"].as_bool(),
        pinned: w["pinned"].as_bool(),
        description: text("description"),
        latest_prompt: text("latest_submitted_message"),
        latest_message: text("latest_conversation_message"),
        latest_at: w["latest_submitted_at"].as_str().and_then(iso_epoch),
        ports: Some(ports),
        ..Workspace::default()
    })
}

/// cmux's workspace groups, from `cmux rpc workspace.group.list`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Groups {
    /// Each group as the sidebar's `data.groups()` has it, in cmux's order.
    pub list: Vec<WorkspaceGroup>,
    /// Workspace id to the id of the group listing it as a member, which
    /// the sidebar's data has as each workspace's `group`. A workspace two
    /// groups list keeps the first.
    pub member_of: HashMap<String, String>,
}

/// `cmux rpc workspace.group.list` as the core's groups and each
/// workspace's group, or None when the reply has no list, or answers for
/// a window other than `window` (when given). A group with no id is
/// skipped, as are its members.
pub fn groups(out: &[u8], window: Option<&str>) -> Option<Groups> {
    let v: Value = serde_json::from_slice(out).ok()?;
    if window.is_some_and(|w| v["window_ref"].as_str() != Some(w)) {
        return None;
    }
    let list = v["groups"].as_array()?;
    let mut groups = Groups::default();
    for g in list {
        let Some(id) = g["id"].as_str() else {
            continue;
        };
        let members = g["member_workspace_ids"].as_array().into_iter().flatten();
        for ws in members.filter_map(Value::as_str) {
            groups
                .member_of
                .entry(ws.to_string())
                .or_insert_with(|| id.to_string());
        }
        groups.list.push(WorkspaceGroup {
            id: id.to_string(),
            name: g["name"].as_str().map(str::to_string),
            anchor_id: g["anchor_workspace_id"].as_str().map(str::to_string),
            collapsed: g["is_collapsed"].as_bool(),
        });
    }
    Some(groups)
}

/// Epoch seconds from cmux's `2026-10-04T15:17:37.889Z`; None for any
/// other shape. Only UTC with a `Z`, which is all cmux writes.
pub fn iso_epoch(s: &str) -> Option<f64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (Some(Some(y)), Some(Some(mo)), Some(Some(day))) = (d.next(), d.next(), d.next()) else {
        return None;
    };
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (Some(Some(h)), Some(Some(mi)), Some(Some(sec))) = (t.next(), t.next(), t.next()) else {
        return None;
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&day) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let frac = if frac.is_empty() {
        0.0
    } else {
        format!("0.{frac}").parse::<f64>().ok()?
    };
    let days = days_from_civil(y, mo, day);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec;
    // Epoch seconds fit an f64 exactly for any date cmux will write.
    Some(secs as f64 + frac)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_views_from_every_config_dir_read_as_one() {
        let main = agents(br#"[{"pid": 9533, "sessionId": "20a0", "status": "busy"}]"#);
        let personal = agents(br#"[{"pid": 59557, "sessionId": "0407", "status": "busy"}]"#);
        let v = merged(main.into_iter().chain(personal));
        assert_eq!(v.busy.get(&59557), Some(&true));
        assert_eq!(v.session.get(&9533).map(String::as_str), Some("20a0"));
    }

    fn view(pid: u32) -> Option<AgentView> {
        agents(format!(r#"[{{"pid": {pid}, "sessionId": "s{pid}", "status": "busy"}}]"#).as_bytes())
    }

    #[test]
    fn a_failed_read_keeps_that_dirs_last_view() {
        let personal = Some(PathBuf::from("/Users/me/.claude-personal"));
        let mut views = AgentViews::default();
        let v = views
            .update([(None, view(1)), (personal.clone(), view(2))])
            .unwrap();
        assert_eq!(v.busy.len(), 2);
        let v = views
            .update([(None, view(3)), (personal.clone(), None)])
            .unwrap();
        assert_eq!(v.busy.get(&1), None, "a good read replaces the last");
        assert_eq!(v.busy.get(&3), Some(&true));
        assert_eq!(v.busy.get(&2), Some(&true), "a missed poll keeps the last");
        let v = views.update([(None, view(3))]).unwrap();
        assert_eq!(v.busy.get(&2), None, "a dir no longer polled is dropped");
    }

    #[test]
    fn a_dir_that_never_read_does_not_hold_the_others_up() {
        let broken = Some(PathBuf::from("/Users/me/.claude-broken"));
        let mut views = AgentViews::default();
        assert_eq!(views.update([(None, None), (broken.clone(), None)]), None);
        let v = views.update([(None, view(1)), (broken, None)]).unwrap();
        assert_eq!(v.session.get(&1).map(String::as_str), Some("s1"));
        assert_eq!(v.busy.len(), 1);
    }

    #[test]
    fn other_config_dirs_are_the_claude_folders_with_sessions() {
        let home = Path::new("/Users/me");
        let names = [
            ".claude",
            ".claude-personal",
            ".claude-empty",
            ".claude-",
            ".claude.json",
            ".claude-work",
            "Dev",
        ]
        .map(String::from);
        let has = |d: &Path| !d.ends_with(".claude-empty");
        let raw = Path::to_path_buf;
        assert_eq!(
            other_config_dirs(home, names.clone(), has, None, raw),
            vec![home.join(".claude-personal"), home.join(".claude-work")]
        );
        let inherited = home.join(".claude-work");
        assert_eq!(
            other_config_dirs(home, names, has, Some(&inherited), raw),
            vec![home.join(".claude"), home.join(".claude-personal")],
            "the runner's own dir is the default read already, so .claude is not"
        );
    }

    #[test]
    fn the_inherited_dir_is_never_read_twice_however_it_is_spelt() {
        let home = Path::new("/Users/me");
        let names = [".claude", ".claude-work"].map(String::from);
        // A symlink, say: ~/.claude-work points at ~/.claude.
        let canonical = |d: &Path| {
            if d.ends_with(".claude-work") {
                home.join(".claude")
            } else {
                d.to_path_buf()
            }
        };
        let inherited = PathBuf::from("/Users/me/./.claude");
        let tidy = |d: &Path| canonical(&d.components().collect::<PathBuf>());
        assert_eq!(
            other_config_dirs(home, names.clone(), |_| true, Some(&inherited), tidy),
            Vec::<PathBuf>::new()
        );
        assert_eq!(
            other_config_dirs(
                home,
                [".claude-other"].map(String::from),
                |_| true,
                Some(&inherited),
                tidy
            ),
            vec![home.join(".claude-other")],
            "with no .claude folder, only the named ones"
        );
    }

    #[test]
    fn reads_agent_view_skipping_background_sessions() {
        let out = br#"[
            {"id": "b8", "kind": "background", "state": "blocked"},
            {"pid": 9533, "kind": "interactive", "sessionId": "77bc", "status": "busy"},
            {"pid": 27486, "kind": "interactive", "sessionId": "7a72", "status": "idle"}
        ]"#;
        let v = agents(out).unwrap();
        assert_eq!(v.busy.len(), 2);
        assert_eq!(v.busy.get(&9533), Some(&true));
        assert_eq!(v.busy.get(&27486), Some(&false));
        assert_eq!(v.session.get(&9533).map(String::as_str), Some("77bc"));
    }

    #[test]
    fn agent_view_that_is_not_a_list_reads_as_none() {
        assert_eq!(agents(b"error: not logged in"), None);
        assert_eq!(agents(br#"{"pid": 1}"#), None);
    }

    #[test]
    fn maps_the_workspace_list_to_the_sidebars_field_names() {
        let out = br#"{"workspaces": [
            {"id": "A", "title": "Session design", "current_directory": "/dev/app-one",
             "selected": true, "pinned": false, "description": "d",
             "latest_submitted_message": "go", "latest_conversation_message": "done",
             "latest_submitted_at": "1970-01-01T00:01:00.500Z", "listening_ports": [3000]},
            {"title": "no id, skipped"},
            {"id": "B"}
        ]}"#;
        let list = workspaces(out).unwrap();
        assert_eq!(list.len(), 2);
        let a = &list[0];
        assert_eq!(a.id, "A");
        assert_eq!(a.title.as_deref(), Some("Session design"));
        assert_eq!(a.directory.as_deref(), Some("/dev/app-one"));
        assert_eq!(a.selected, Some(true));
        assert_eq!(a.latest_prompt.as_deref(), Some("go"));
        assert_eq!(a.latest_message.as_deref(), Some("done"));
        assert_eq!(a.latest_at, Some(60.5));
        assert_eq!(a.ports, Some(vec![3000.0]));
        assert_eq!(list[1].title, None);
        assert_eq!(workspaces(b"{}"), None);
    }

    /// A real `cmux rpc workspace.group.list` reply, captured 2026-10-04,
    /// less its `idempotency_key`s, which gitleaks reads as secrets. They
    /// repeat each `external_id`, and the parser reads neither.
    const GROUP_LIST: &[u8] = include_bytes!("fixtures/workspace-group-list.json");

    #[test]
    fn maps_a_captured_group_list_to_the_sidebars_groups() {
        let g = groups(GROUP_LIST, Some("window:1")).unwrap();
        assert_eq!(window_ref(GROUP_LIST).as_deref(), Some("window:1"));
        let names: Vec<_> = g.list.iter().filter_map(|g| g.name.as_deref()).collect();
        assert_eq!(
            names,
            ["Main activity", "Background", "For review", "Parked"]
        );
        let main = &g.list[0];
        assert_eq!(main.id, "889939BC-2C0F-4361-9C96-AA3246A61413");
        assert_eq!(
            main.anchor_id.as_deref(),
            Some("D42ABC88-C998-4828-A567-3DA107F32601")
        );
        assert_eq!(main.collapsed, Some(false));
        assert_eq!(g.member_of.len(), 6);
        let group_of = |ws: &str| g.member_of.get(ws).map(String::as_str);
        assert_eq!(
            group_of("E6302E5A-02BA-472A-8CFB-831601964AC8"),
            Some(main.id.as_str())
        );
        assert_eq!(
            group_of("06FC078B-815B-4BF7-8222-DA1DB68899C6"),
            Some("2E5C7EC0-B9BA-4365-85C0-60CAEDB3B3FA"),
            "a Parked card"
        );
        assert_eq!(
            group_of("F9725AB1-2F85-4BCB-84DD-A3BB998B4007"),
            Some("2E5C7EC0-B9BA-4365-85C0-60CAEDB3B3FA"),
            "an anchor is a member of its own group"
        );
    }

    #[test]
    fn a_group_list_keeps_what_it_can_read() {
        let out = br#"{"groups": [
            {"name": "no id, skipped", "member_workspace_ids": ["X"]},
            {"id": "g1", "name": 7, "is_collapsed": "yes", "member_workspace_ids": ["A", 3]},
            {"id": "g2", "member_workspace_ids": ["A", "B"]},
            {"id": "g3"}
        ]}"#;
        let g = groups(out, None).unwrap();
        let ids: Vec<_> = g.list.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["g1", "g2", "g3"]);
        assert_eq!(
            (g.list[0].name.as_deref(), g.list[0].collapsed),
            (None, None)
        );
        assert_eq!(g.member_of.get("A").map(String::as_str), Some("g1"));
        assert_eq!(g.member_of.get("B").map(String::as_str), Some("g2"));
        assert_eq!(g.member_of.get("X"), None);
        assert_eq!(groups(br#"{"groups": []}"#, None), Some(Groups::default()));
        assert_eq!(groups(b"{}", None), None);
        assert_eq!(groups(b"Error: method not found", None), None);
    }

    #[test]
    fn a_group_list_for_another_window_reads_as_none() {
        assert_eq!(groups(GROUP_LIST, Some("window:2")), None);
        let unmarked = br#"{"groups": []}"#;
        assert_eq!(groups(unmarked, Some("window:1")), None);
        assert_eq!(groups(unmarked, None), Some(Groups::default()));
        assert_eq!(window_ref(b"{}"), None);
    }

    #[test]
    fn reads_cmux_timestamps_as_epoch_seconds() {
        assert_eq!(iso_epoch("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(iso_epoch("2000-03-01T00:00:00Z"), Some(951_868_800.0));
        let t = iso_epoch("2026-10-04T15:17:37.889Z").unwrap();
        assert!((t - 1_791_127_057.889).abs() < 1e-3, "{t}");
    }

    #[test]
    fn rejects_other_timestamp_shapes() {
        for s in [
            "",
            "2026-10-04",
            "2026-10-04T15:17:37",
            "2026-10-04T15:17:37+01:00",
            "2026-13-04T15:17:37Z",
            "2026-10-04T25:17:37Z",
            "2026-10-04Tab:17:37Z",
            "2026-10-04T15:17:37.xZ",
        ] {
            assert_eq!(iso_epoch(s), None, "{s}");
        }
    }
}
