//! The All view's project filter driven through the Crux app as the
//! sidebar drives it: what the lanes show and count, what stays global
//! (Needs you and Next), what clears it, and where a drop among hidden
//! cards lands.

#![cfg(test)]

use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::lanes::LaneKey;
use cockpit_core::{Cockpit, Effect, Event, Model, Panel, Project};
use crux_core::App;
use serde_json::json;

const NOW: f64 = 1_000_100.0;

fn table() -> Vec<Project> {
    serde_json::from_str(
        r##"[{"match": "/dev/app", "name": "App", "color": "#D97757", "icon": "x"},
            {"match": "/dev/web", "name": "Web", "color": "#3B6FB6", "icon": "x"}]"##,
    )
    .unwrap()
}

/// Main activity holding, in tab order, App, Web, App, Web, App cards and
/// a Web card waiting on Jon; one card in the home folder in Unsorted.
fn frame(order: &[&str]) -> Event {
    let card = |id: &str| {
        let dir = match id.chars().next() {
            Some('a') => "/dev/app",
            Some('h') => "/Users/jon",
            _ => "/dev/web",
        };
        let mut w = json!({ "id": id, "directory": dir });
        if id != "h" {
            w["group"] = json!("g-main");
        }
        if id == "n" {
            w["agents"] =
                json!([{ "id": "s1", "status": "needs_input", "sinceEpoch": NOW - 600.0 }]);
        }
        w
    };
    let mut workspaces =
        vec![json!({ "id": "anchor-main", "title": "Main activity", "group": "g-main" })];
    workspaces.extend(order.iter().map(|id| card(id)));
    let data = json!({
        "epoch": NOW,
        "groups": [{ "id": "g-main", "name": "Main activity", "anchorId": "anchor-main" }],
        "workspaces": workspaces,
    });
    Event::Data(serde_json::from_value(data).unwrap())
}

const ORDER: [&str; 7] = ["a1", "w1", "a2", "w2", "a3", "n", "h"];

/// The sidebar's core: the table, a state file, the panel on, a frame.
fn started() -> (Cockpit, Model) {
    let app = Cockpit;
    let mut model = Model::default();
    for event in [
        Event::Projects(table()),
        Event::State(Box::default()),
        Event::PanelOn,
        frame(&ORDER),
    ] {
        let _ = app.update(event, &mut model);
    }
    (app, model)
}

fn filter(key: Option<&str>) -> Event {
    Event::FilterProject {
        key: key.map(str::to_string),
    }
}

/// What the shell is asked for: cmux calls and state writes, in words.
fn asked(app: &Cockpit, model: &mut Model, event: Event) -> Vec<String> {
    let mut cmd = app.update(event, model);
    cmd.effects()
        .filter_map(|e| match e {
            Effect::Cmux(r) => Some(format!(
                "cmux {} {}",
                r.operation.method,
                r.operation.params_json()
            )),
            Effect::Persist(r) => Some(format!(
                "set {} {}",
                r.operation.key,
                r.operation
                    .value
                    .map_or("delete".to_string(), |v| v.to_string())
            )),
            _ => None,
        })
        .collect()
}

/// The cards in a lane, top to bottom.
fn lane_cards(app: &Cockpit, model: &Model, lane: &str) -> Vec<String> {
    app.view(model)
        .lane_entries
        .into_iter()
        .filter_map(|e| match e {
            LaneEntry::Ws { ws_id, lane: l, .. } if l == LaneKey::from(lane) => Some(ws_id),
            _ => None,
        })
        .collect()
}

fn panel(app: &Cockpit, model: &Model) -> Panel {
    app.view(model).panel.unwrap()
}

#[test]
fn the_lanes_show_the_chosen_projects_cards_and_count_them_of_the_whole() {
    let (app, mut model) = started();
    let main = |p: &Panel| {
        let lane = p
            .lanes
            .iter()
            .find(|l| l.key == LaneKey::from("main"))
            .unwrap();
        (lane.count, lane.total)
    };
    assert_eq!(main(&panel(&app, &model)), (6, None), "unfiltered as today");
    assert_eq!(
        asked(&app, &mut model, filter(Some("/dev/app"))),
        [r#"set ui.filter "/dev/app""#]
    );
    // The waiting card sorts first, so it is the one to look for.
    assert_eq!(lane_cards(&app, &model, "main"), ["a1", "a2", "a3"]);
    assert_eq!(main(&panel(&app, &model)), (3, Some(6)), "3 of 6");
    let view = app.view(&model);
    let header = view.lane_headers.get(&LaneKey::from("main")).unwrap();
    assert_eq!(header.total, Some(6));
    // Unsorted holds only the home folder's card: every card hidden, so
    // it draws as an empty lane whose header still says what it holds.
    let unsorted = panel(&app, &model);
    let unsorted = unsorted.lanes.iter().find(|l| l.key.is_unsorted()).unwrap();
    assert!(unsorted.empty && unsorted.rows.is_empty());
    assert_eq!((unsorted.count, unsorted.total), (0, Some(1)), "0 of 1");
    let _ = app.update(filter(Some("other")), &mut model);
    assert_eq!(lane_cards(&app, &model, "unsorted"), ["h"]);
    assert!(lane_cards(&app, &model, "main").is_empty());
    let _ = app.update(filter(None), &mut model);
    assert_eq!(
        lane_cards(&app, &model, "main"),
        ["n", "a1", "w1", "a2", "w2", "a3"]
    );
}

#[test]
fn needs_you_and_next_stay_global_while_filtered() {
    let (app, mut model) = started();
    let before = app.view(&model);
    let _ = app.update(filter(Some("/dev/app")), &mut model);
    let after = app.view(&model);
    assert!(!lane_cards(&app, &model, "main").contains(&"n".to_string()));
    assert_eq!(
        after.needs, before.needs,
        "the hidden waiting card still counts"
    );
    assert_eq!(after.needs.list, ["n"]);
    assert_eq!(after.next, before.next);
    let p = panel(&app, &model);
    assert_eq!(p.needs.count, 1);
    assert_eq!(p.needs.target.map(|t| t.ws_id).as_deref(), Some("n"));
}

#[test]
fn a_needs_click_on_a_hidden_card_clears_the_filter_so_it_shows() {
    let (app, mut model) = started();
    let _ = app.update(filter(Some("/dev/app")), &mut model);
    let asked = asked(&app, &mut model, Event::Reveal { id: "n".into() });
    assert!(
        asked.contains(&"set ui.filter delete".to_string()),
        "{asked:?}"
    );
    assert!(lane_cards(&app, &model, "main").contains(&"n".to_string()));
    // A shown card leaves the filter alone.
    let _ = app.update(filter(Some("/dev/app")), &mut model);
    let asked = self::asked(&app, &mut model, Event::Reveal { id: "a2".into() });
    assert!(
        !asked.iter().any(|a| a.starts_with("set ui.filter")),
        "{asked:?}"
    );
    assert_eq!(lane_cards(&app, &model, "main"), ["a1", "a2", "a3"]);
}

#[test]
fn next_to_a_hidden_card_clears_the_filter_so_it_shows() {
    let (app, mut model) = started();
    let _ = app.update(filter(Some("/dev/app")), &mut model);
    let target = app.view(&model).next.step.map(|s| s.target);
    assert_eq!(
        target.as_deref(),
        Some("n"),
        "Next steps to the waiting card"
    );
    let asked = asked(&app, &mut model, Event::Next);
    assert!(
        asked.contains(&"set ui.filter delete".to_string()),
        "{asked:?}"
    );
    assert!(lane_cards(&app, &model, "main").contains(&"n".to_string()));
}

#[test]
fn a_drop_between_two_shown_cards_lands_beside_the_one_below_past_hidden_ones() {
    let (app, mut model) = started();
    let _ = app.update(filter(Some("/dev/app")), &mut model);
    // a3 dropped between a1 and a2, with w1 hidden between them.
    let drop = Event::MoveCard {
        id: "a3".into(),
        lane: LaneKey::from("main"),
        before: Some("a2".into()),
    };
    let asked = asked(&app, &mut model, drop);
    assert_eq!(
        asked,
        [r#"cmux workspace.reorder {"workspace_id":"a3","before_workspace_id":"a2"}"#]
    );
    assert_eq!(lane_cards(&app, &model, "main"), ["a1", "a3", "a2"]);
    let _ = app.update(filter(None), &mut model);
    assert_eq!(
        lane_cards(&app, &model, "main"),
        ["n", "a1", "w1", "a3", "a2", "w2"],
        "the hidden cards keep their places"
    );
}

#[test]
fn a_drop_at_a_slot_among_shown_cards_names_the_shown_neighbour() {
    let (_, mut model) = started();
    let app = Cockpit;
    let _ = app.update(filter(Some("/dev/app")), &mut model);
    // Rows: Main's header, a1, a2, a3. Without a3 the slot after a1 is 2.
    let data = model.data.clone().unwrap();
    let target = model.session.resolve_drop(&data, "w:a3", 2);
    assert_eq!(target.next_ref.as_deref(), Some("a2"));
}

#[test]
fn the_add_menu_ticks_and_leads_with_the_filtered_project() {
    let (app, mut model) = started();
    let names = |p: &Panel| {
        let add = p.add.clone().unwrap();
        let list: Vec<(String, bool)> = add
            .projects
            .into_iter()
            .map(|p| (p.name, p.chosen))
            .collect();
        (list, add.home_chosen)
    };
    let unfiltered = names(&panel(&app, &model));
    assert_eq!(
        unfiltered,
        (vec![("App".into(), false), ("Web".into(), false)], false)
    );
    let _ = app.update(filter(Some("/dev/web")), &mut model);
    assert_eq!(
        names(&panel(&app, &model)),
        (vec![("Web".into(), true), ("App".into(), false)], false)
    );
    let menu = panel(&app, &model).filter.unwrap();
    let ticks: Vec<(&str, bool)> = menu
        .projects
        .iter()
        .map(|p| (p.name.as_str(), p.chosen))
        .collect();
    assert_eq!(
        ticks,
        [("App", false), ("Web", true)],
        "the filter's own menu keeps its order"
    );
    assert!(!menu.no_project_chosen);
    let _ = app.update(filter(Some(&menu.no_project)), &mut model);
    assert_eq!(
        names(&panel(&app, &model)),
        (vec![("App".into(), false), ("Web".into(), false)], true),
        "No project ticked in place"
    );
    assert!(panel(&app, &model).filter.unwrap().no_project_chosen);
    let _ = app.update(Event::FlipView, &mut model);
    let p = panel(&app, &model);
    assert_eq!(
        (p.add, p.filter),
        (None, None),
        "Projects is never filtered"
    );
}

#[test]
fn the_filter_survives_a_reload_and_goes_with_its_project() {
    let (app, mut model) = started();
    let _ = app.update(filter(Some("/dev/web")), &mut model);
    // A reload: a new core seeded from the state file holding the write.
    let saved = serde_json::from_value(json!({ "ui": { "filter": "/dev/web" } })).unwrap();
    let mut fresh = Model::default();
    for event in [
        Event::Projects(table()),
        Event::State(Box::new(saved)),
        Event::PanelOn,
        frame(&ORDER),
    ] {
        let _ = app.update(event, &mut fresh);
    }
    assert_eq!(lane_cards(&app, &fresh, "main"), ["n", "w1", "w2"]);
    let only_app = table().into_iter().take(1).collect();
    let asked = asked(&app, &mut fresh, Event::Projects(only_app));
    assert_eq!(asked, ["set ui.filter delete"]);
    assert_eq!(lane_cards(&app, &fresh, "main").len(), 6);
}
