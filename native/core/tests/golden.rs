//! The core matches the TypeScript model's golden JSON
//! (test/golden/README.md) for every cockpit scene: the view mode, every
//! workspace's placement, and the All view as the app builds it (Needs
//! you, Next, All's rows, and each lane header's fold, cards and merge
//! line), the Projects rows, quiet projects and headers, and every card's
//! chips, how they fit, and a merged card's dimming.

#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::app::build_view;
use cockpit_core::by_project::ProjectEntry;
use cockpit_core::card_chips::Chip;
use cockpit_core::chips::{FULL_LINE_CHARS, PROJECT_LINE_CHARS, chips_fit_one_line, chips_split};
use cockpit_core::data::Data;
use cockpit_core::js::json_num;
use cockpit_core::lanes::LANES;
use cockpit_core::model::{actual_lane_of, card_density};
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use cockpit_core::session::Session;
use serde_json::{Map, Value, json};

/// How a card's chips fit a line `chars` wide.
fn fit(drawn: &[Chip], chars: usize) -> Value {
    json!({
        "fitsOneLine": chips_fit_one_line(drawn, chars),
        "splits": chips_split(drawn, chars),
    })
}

fn golden(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../test/golden/{name}"));
    let text = std::fs::read_to_string(&path).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// What the port computes for the scene, in the golden file's shape.
fn computed(input: &Value) -> Value {
    let data: Data = serde_json::from_value(input["data"].clone()).unwrap();
    let projects: Vec<Project> = serde_json::from_value(input["projects"].clone()).unwrap();
    let saved: SavedState = serde_json::from_value(input["state"].clone()).unwrap();
    let mut s = Session::new(projects, saved);

    let cards: Vec<String> = s
        .card_workspaces(&data)
        .iter()
        .map(|w| w.id.clone())
        .collect();
    let mut placement = Map::new();
    for w in s.all_workspaces(&data) {
        let place = json!({
            "actualLane": actual_lane_of(&data, Some(w)).as_str(),
            "card": cards.contains(&w.id),
            "density": card_density(&data, Some(w)).as_str(),
            "lane": s.lane_of(&data, w).as_str(),
            "project": s.project_key(w),
            "status": s.status_of(Some(w)).as_str(),
        });
        placement.insert(w.id.clone(), place);
    }
    let mut chips = Map::new();
    for w in s.card_workspaces(&data) {
        let drawn = s.chips_for(Some(w), true);
        let row = json!({
            "cardOpacity": json_num(s.card_opacity(Some(w), false)),
            "chips": drawn,
            "fullLine": fit(&drawn, FULL_LINE_CHARS),
            "projectLine": fit(&drawn, PROJECT_LINE_CHARS),
        });
        chips.insert(w.id.clone(), row);
    }
    let entries = s.project_entries(&data);
    let mut headers = Map::new();
    for e in &entries {
        let (ProjectEntry::Header { project, .. } | ProjectEntry::QuietRow { project, .. }) = e
        else {
            continue;
        };
        let workspaces: Vec<String> = s
            .project_workspaces(&data, project)
            .iter()
            .map(|w| w.id.clone())
            .collect();
        let header = json!({
            "canOpen": s.can_open_project(project),
            "name": s.project_by_key(project).name,
            "workspaces": workspaces,
        });
        headers.insert(project.clone(), header);
    }
    let quiet = s.quiet_projects(&data);
    let view = serde_json::to_value(build_view(&mut s, &data)).unwrap();
    json!({
        "chips": chips,
        "mode": s.mode().as_str(),
        "placement": placement,
        "projectEntries": entries,
        "projectHeaders": headers,
        "quietProjects": quiet,
        "view": view,
    })
}

fn check(scene: &str) {
    let input = golden(&format!("{scene}.input.json"));
    let want = golden(&format!("{scene}.json"));
    let got = computed(&input);

    assert_eq!(got["mode"], want["mode"], "{scene}: mode");
    assert_eq!(got["placement"], want["placement"], "{scene}: placement");
    for field in ["projectEntries", "projectHeaders", "quietProjects", "chips"] {
        assert_eq!(got[field], want[field], "{scene}: {field}");
    }
    let view = &got["view"];
    assert_eq!(view["mode"], want["mode"], "{scene}: the view's mode");
    for field in ["needs", "next", "laneEntries"] {
        assert_eq!(view[field], want[field], "{scene}: {field}");
    }
    let headers = want["laneHeaders"].as_object().unwrap();
    assert_eq!(headers.len(), LANES.len(), "{scene}: one header per lane");
    for (lane, header) in headers {
        for field in ["collapsed", "workspaces", "mergeReady"] {
            assert_eq!(
                view["laneHeaders"][lane][field], header[field],
                "{scene}: laneHeaders.{lane}.{field}"
            );
        }
    }
}

#[test]
fn lanes_scene_matches_the_golden_model() {
    check("lanes");
}

#[test]
fn needs_and_next_scene_matches_the_golden_model() {
    check("needs-and-next");
}

#[test]
fn projects_scene_matches_the_golden_model() {
    check("projects");
}

#[test]
fn review_verdicts_scene_matches_the_golden_model() {
    check("review-verdicts");
}
