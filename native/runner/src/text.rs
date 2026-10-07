//! The view model as plain text, for `cockpit-pane --print`: the stream's
//! health, Needs you, Next and All's lanes, each workspace by title with
//! the status and age of its most active agent, so the join can be
//! checked against the sidebar by eye.

use std::fmt::Write;

use cockpit_core::activity::{most_active, since_or_activity};
use cockpit_core::data::Data;
use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::time::age_since;

use super::Feed;
use super::join::Health;

/// The stream's line: live, replaying or down.
pub fn health_line(h: &Health) -> String {
    match (&h.down, h.replay_to) {
        (Some(why), _) => format!("EVENT STREAM DOWN, statuses may be stale: {why}"),
        (None, None) => "cmux events: connecting".to_string(),
        (None, Some(to)) if !h.caught_up() => {
            format!("cmux events: replaying, seq {} of {to}", h.last_seq)
        }
        (None, Some(_)) => format!("cmux events: live, seq {}", h.last_seq),
    }
}

fn title(data: &Data, id: &str) -> String {
    data.ws_by_id(id)
        .and_then(|w| w.title.clone())
        .unwrap_or_else(|| format!("? {id}"))
}

/// A card's line: title, then its most active agent's status and age.
fn card(data: &Data, id: &str) -> String {
    let w = data.ws_by_id(id);
    let agent = w.and_then(|w| most_active(w.agent_list()));
    let status = match agent {
        Some(a) => {
            let word = a.status.as_ref().map_or("no status", |s| s.as_str());
            let age = age_since(data, Some(since_or_activity(a)));
            if age.is_empty() {
                word.to_string()
            } else {
                format!("{word} {age}")
            }
        }
        None => "-".to_string(),
    };
    format!("{:<40} {status}", clip(&title(data, id)))
}

fn clip(s: &str) -> String {
    if s.chars().count() <= 39 {
        return s.to_string();
    }
    let mut t: String = s.chars().take(38).collect();
    t.push('…');
    t
}

/// The whole view as text. Everything but the stream line depends only
/// on the view model and the frame, so a reprint means something moved.
pub fn render(feed: &Feed) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "{}", health_line(&feed.join.health));
    let Some(data) = &feed.model.data else {
        out.push_str("no data yet\n");
        return out;
    };
    let v = &feed.model.view;
    let _ = writeln!(out, "mode: {}", v.mode);

    let wait = if v.needs.late {
        format!("{} (late)", v.needs.wait_text)
    } else {
        v.needs.wait_text.clone()
    };
    let _ = writeln!(out, "\nNEEDS YOU ({}) {wait}", v.needs.list.len());
    for id in &v.needs.list {
        let _ = writeln!(out, "  {}", card(data, id));
    }

    match &v.next.step {
        Some(s) => {
            let _ = writeln!(
                out,
                "\nNEXT: {} ({} of {})",
                title(data, &s.target),
                s.position,
                s.total
            );
        }
        None => out.push_str("\nNEXT: nothing waiting\n"),
    }

    for entry in &v.lane_entries {
        match entry {
            LaneEntry::Header { lane, .. } => {
                let h = v.lane_headers.get(lane);
                let folded = if h.is_some_and(|h| h.collapsed) {
                    " (folded)"
                } else {
                    ""
                };
                let count = h.map_or(0, |h| h.workspaces.len());
                let merge = h.map_or("", |h| h.merge_ready.as_str());
                let _ = writeln!(
                    out,
                    "\n{} ({count}){folded} {merge}",
                    lane.as_str().to_uppercase()
                );
            }
            LaneEntry::Zone { lane, .. } => {
                let _ = writeln!(out, "\n{} (empty)", lane.as_str().to_uppercase());
            }
            LaneEntry::Ws { ws_id, .. } => {
                let _ = writeln!(out, "  {}", card(data, ws_id));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Input;
    use cockpit_core::data::Workspace;
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn says_how_the_stream_stands() {
        let mut h = Health::default();
        assert_eq!(health_line(&h), "cmux events: connecting");
        h.replay_to = Some(9);
        h.last_seq = 4;
        assert_eq!(health_line(&h), "cmux events: replaying, seq 4 of 9");
        h.last_seq = 9;
        assert_eq!(health_line(&h), "cmux events: live, seq 9");
        h.down = Some("cmux events exited (signal: 15)".into());
        assert!(health_line(&h).starts_with("EVENT STREAM DOWN"));
    }

    #[test]
    fn prints_needs_you_and_the_lanes_by_title_with_status_and_age() {
        let mut feed = Feed::default();
        feed.state(cockpit_core::persist::SavedState::default());
        let list = ["A", "B"]
            .map(|id| Workspace {
                id: id.to_string(),
                title: Some(format!("Title {id}")),
                ..Workspace::default()
            })
            .to_vec();
        feed.input(Input::Workspaces(list));
        let e = json!({"type": "event", "seq": 1, "name": "agent.hook.PermissionRequest",
                       "occurred_at": "1970-01-01T00:00:01Z",
                       "payload": {"_ppid": 7, "workspace_id": "B"}});
        feed.input(Input::Event(Box::new(e), Instant::now()));
        feed.frame(600.0);
        let text = render(&feed);
        assert!(text.contains("NEEDS YOU (1)"), "{text}");
        assert!(text.contains("Title B"), "{text}");
        assert!(text.contains("needs_input 9m"), "{text}");
        assert!(text.contains("UNSORTED"), "{text}");
        assert!(text.contains("Title A"), "{text}");
    }

    #[test]
    fn says_so_before_the_first_frame() {
        let feed = Feed::default();
        assert!(render(&feed).contains("no data yet"));
    }

    #[test]
    fn clips_long_titles() {
        let long = "x".repeat(60);
        assert_eq!(clip(&long).chars().count(), 39);
        assert_eq!(clip("short"), "short");
    }
}
