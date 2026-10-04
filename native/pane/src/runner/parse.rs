//! Reads what the runner's commands print: `claude agents --json`,
//! `cmux --json workspace list`, and the timestamps on `cmux events`.
//! Plain functions over bytes and JSON, so the tests need no processes.

use std::collections::HashMap;

use cockpit_core::data::Workspace;
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
