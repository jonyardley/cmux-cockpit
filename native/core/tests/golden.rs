//! The core matches the TypeScript model's golden JSON
//! (test/golden/README.md) for every cockpit scene: the view mode, every
//! workspace's placement, and the All view as the app builds it (Needs
//! you, Next, All's rows, and each lane header's fold, cards and merge
//! line), the Projects rows, quiet projects and headers, and every card's
//! chips, what it draws of them and how they fit, its To review action
//! and a merged card's Park, Close and dimming.

#![cfg(test)]

use std::path::PathBuf;

use cockpit_core::app::build_view;
use cockpit_core::by_project::ProjectEntry;
use cockpit_core::card_chips::Chip;
use cockpit_core::chips::{FULL_LINE_CHARS, PROJECT_LINE_CHARS};
use cockpit_core::data::{Data, Workspace};
use cockpit_core::js::json_num;
use cockpit_core::lanes::LANES;
use cockpit_core::model::{actual_lane_of, card_density};
use cockpit_core::persist::SavedState;
use cockpit_core::projects::Project;
use cockpit_core::session::Session;
use serde_json::{Map, Value, json};

/// How a card's drawn chips fit a line `chars` wide.
fn fit(s: &mut Session, data: &Data, drawn: &[Chip], w: &Workspace, chars: usize) -> Value {
    json!({
        "fitsOneLine": s.chips_fit_one_line(data, drawn, Some(w), chars),
        "secondLineFits": s.second_line_fits(data, drawn, Some(w), chars),
        "splits": s.chips_split(data, drawn, Some(w), chars),
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
        let drawn = s.card_chips(&data, Some(w), true);
        let row = json!({
            "canFileForReview": s.can_file_for_review(&data, Some(w)),
            "cardChips": drawn,
            "cardOpacity": json_num(s.card_opacity(Some(w), false)),
            "chips": s.chips_for(Some(w), true),
            "fullLine": fit(&mut s, &data, &drawn, w, FULL_LINE_CHARS),
            "keepLabel": s.keep_label(&data, Some(w)),
            "offersClose": s.offers_close(&data, Some(w)),
            "offersMergedActions": s.offers_merged_actions(&data, Some(w)),
            "offersPark": s.offers_park(&data, Some(w)),
            "projectLine": fit(&mut s, &data, &drawn, w, PROJECT_LINE_CHARS),
            "reviewIsGreen": s.review_is_green(Some(w)),
            "showsChipsRow": s.shows_chips_row(&data, &drawn, Some(w)),
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

/// The TypeScript model with R4.5's one deliberate difference taken out
/// (issue #281): the JS cockpit, being retired, still lifts waiting cards
/// into a strip and leaves a placeholder; the core keeps each card in its
/// place. So each placeholder reads as its card in the same spot, and
/// Needs you keeps only its list and clock.
fn without_the_strip(mut want: Value) -> Value {
    if let Some(entries) = want["laneEntries"].as_array_mut() {
        for e in entries.iter_mut().filter(|e| e["kind"] == "ghost") {
            e["kind"] = json!("ws");
            e["id"] = json!(format!("w:{}", e["wsId"].as_str().unwrap_or_default()));
        }
    }
    if let Some(entries) = want["projectEntries"].as_array_mut() {
        for e in entries.iter_mut().filter(|e| e["kind"] == "ghost") {
            e["kind"] = json!("ws");
            e["id"] = json!(format!("{}@p", e["wsId"].as_str().unwrap_or_default()));
        }
    }
    if let Some(needs) = want["needs"].as_object_mut() {
        needs.retain(|k, _| ["list", "waitText", "late"].contains(&k.as_str()));
    }
    want
}

fn check(scene: &str) {
    let input = golden(&format!("{scene}.input.json"));
    let want = without_the_strip(golden(&format!("{scene}.json")));
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
