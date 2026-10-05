//! Jon's actions driven through the Crux app as the pane will send them:
//! a card moved, a workspace switched to, a Needs you card dismissed, the
//! view flipped. Each checks the effects the shell is asked for against
//! what the sidebar sends for the same action, and that a moved card stays
//! where it was put until cmux's data shows the move.

#![cfg(test)]

use cockpit_core::lane_entries::LaneEntry;
use cockpit_core::lanes::LaneKey;
use cockpit_core::persist::SavedState;
use cockpit_core::session::Session;
use cockpit_core::{Cockpit, Effect, Event, Model};
use crux_core::App;
use serde_json::{Map, Value, json};

const NOW: f64 = 1_000_100.0;

/// The fixture cockpit.test.ts uses: three lane groups, each with its
/// generated anchor, cards in Main and For review, and one in Unsorted.
fn frame(epoch: f64, groups: &[(&str, &str)]) -> Event {
    let place = |id: &str, default: &str| {
        groups
            .iter()
            .find(|(w, _)| *w == id)
            .map_or(default.to_string(), |(_, g)| g.to_string())
    };
    let card = |id: &str, default: &str| {
        let g = place(id, default);
        if g.is_empty() {
            json!({ "id": id })
        } else {
            json!({ "id": id, "group": g })
        }
    };
    let data = json!({
        "epoch": epoch,
        "groups": [
            { "id": "g-main", "name": "Main activity", "anchorId": "anchor-main" },
            { "id": "g-review", "name": "For review", "anchorId": "anchor-review" },
            { "id": "g-parked", "name": "Parked", "anchorId": "anchor-parked" },
        ],
        "workspaces": [
            { "id": "anchor-main", "title": "Main activity", "group": "g-main" },
            card("a", "g-main"),
            card("b", "g-main"),
            { "id": "anchor-review", "title": "For review", "group": "g-review" },
            card("c", "g-review"),
            { "id": "anchor-parked", "title": "Parked", "group": "g-parked" },
            card("p", "g-parked"),
            card("u", ""),
        ],
    });
    Event::Data(serde_json::from_value(data).unwrap())
}

/// The same frame in a different tab order.
fn reordered(epoch: f64, groups: &[(&str, &str)], order: &[&str]) -> Event {
    let Event::Data(mut data) = frame(epoch, groups) else {
        unreachable!()
    };
    if let Some(list) = data.workspaces.as_mut() {
        list.sort_by_key(|w| order.iter().position(|id| *id == w.id));
    }
    Event::Data(data)
}

/// What the shell is asked for, in words: `cmux <method> <params>` or
/// `set <key> <value>`, then `render`.
fn asked(app: &Cockpit, model: &mut Model, event: Event) -> Vec<String> {
    let mut cmd = app.update(event, model);
    cmd.effects()
        .map(|e| match e {
            Effect::Render(_) => "render".to_string(),
            Effect::Cmux(r) => format!("cmux {} {}", r.operation.method, r.operation.params_json()),
            Effect::Persist(r) => {
                let value = r
                    .operation
                    .value
                    .map_or("delete".to_string(), |v| v.to_string());
                format!("set {} {value}", r.operation.key)
            }
        })
        .collect()
}

fn started() -> (Cockpit, Model) {
    let app = Cockpit;
    let mut model = Model::default();
    let _ = app.update(Event::State(Box::default()), &mut model);
    let _ = app.update(frame(NOW, &[]), &mut model);
    (app, model)
}

/// The lane each card shows in, from the view model's rows.
fn lane_of(app: &Cockpit, model: &Model, id: &str) -> Option<LaneKey> {
    app.view(model)
        .lane_entries
        .into_iter()
        .find_map(|e| match e {
            LaneEntry::Ws { ws_id, lane, .. } if ws_id == id => Some(lane),
            _ => None,
        })
}

/// The cards in a lane, top to bottom.
fn lane_cards(app: &Cockpit, model: &Model, lane: LaneKey) -> Vec<String> {
    app.view(model)
        .lane_entries
        .into_iter()
        .filter_map(|e| match e {
            LaneEntry::Ws { ws_id, lane: l, .. } if l == lane => Some(ws_id),
            _ => None,
        })
        .collect()
}

fn move_card(id: &str, lane: LaneKey, before: Option<&str>) -> Event {
    Event::MoveCard {
        id: id.into(),
        lane,
        before: before.map(str::to_string),
    }
}

mod move_card {
    use super::*;

    #[test]
    fn reorders_then_joins_the_new_group_as_a_drop_does() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, move_card("a", LaneKey::Review, None));
        assert_eq!(
            asked,
            [
                r#"cmux workspace.reorder {"workspace_id":"a","index":4}"#,
                r#"cmux workspace.group.add {"group_id":"g-review","workspace_id":"a"}"#,
                "render",
            ]
        );
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Review));
        assert_eq!(lane_cards(&app, &model, LaneKey::Review), ["c", "a"]);
    }

    #[test]
    fn lands_above_the_card_it_is_dropped_before() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, move_card("a", LaneKey::Review, Some("c")));
        assert_eq!(
            asked[0],
            r#"cmux workspace.reorder {"workspace_id":"a","index":3}"#
        );
        assert_eq!(lane_cards(&app, &model, LaneKey::Review), ["a", "c"]);
    }

    #[test]
    fn only_reorders_within_its_own_lane() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, move_card("b", LaneKey::Main, Some("a")));
        assert_eq!(
            asked,
            [
                r#"cmux workspace.reorder {"workspace_id":"b","index":1}"#,
                "render",
            ]
        );
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["b", "a"]);
    }

    #[test]
    fn leaves_the_group_when_moved_into_unsorted() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, move_card("b", LaneKey::Unsorted, None));
        assert!(asked.contains(&r#"cmux workspace.group.remove {"workspace_id":"b"}"#.to_string()));
        assert_eq!(lane_of(&app, &model, "b"), Some(LaneKey::Unsorted));
    }

    #[test]
    fn writes_nothing_to_the_state_file() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, move_card("a", LaneKey::Parked, None));
        assert!(asked.iter().all(|a| !a.starts_with("set ")), "{asked:?}");
    }

    #[test]
    fn ignores_an_unknown_card_a_lane_anchor_and_a_project_anchor() {
        let (app, mut model) = started();
        for id in ["nope", "anchor-main"] {
            let asked = asked(&app, &mut model, move_card(id, LaneKey::Review, None));
            assert_eq!(asked, ["render"], "{id}");
        }
        let data = json!({
            "epoch": NOW,
            "groups": [{ "id": "g-proj", "name": "app-three", "anchorId": "real" }],
            "workspaces": [{ "id": "real", "group": "g-proj" }],
        });
        let _ = app.update(
            Event::Data(serde_json::from_value(data).unwrap()),
            &mut model,
        );
        let asked = asked(&app, &mut model, move_card("real", LaneKey::Review, None));
        assert_eq!(
            asked,
            ["render"],
            "a project's anchor is that group in cmux"
        );
    }

    #[test]
    fn does_nothing_under_projects_or_before_the_first_frame() {
        let (app, mut model) = started();
        let _ = app.update(Event::FlipView, &mut model);
        let asked = asked(&app, &mut model, move_card("a", LaneKey::Review, None));
        assert_eq!(asked, ["render"]);

        let mut empty = Model::default();
        let asked = super::asked(&app, &mut empty, move_card("a", LaneKey::Review, None));
        assert_eq!(asked, ["render"]);
    }
}

/// The snap-back trap (CLAUDE.md): the moved card must hold its new place
/// past any expiry until cmux's data has caught up.
mod the_moved_card_holds {
    use super::*;

    #[test]
    fn through_frames_that_still_show_the_old_lane_past_any_expiry() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        for later in [1.0, 5.0, 60.0, 3600.0] {
            let _ = app.update(frame(NOW + later, &[]), &mut model);
            assert_eq!(
                lane_of(&app, &model, "a"),
                Some(LaneKey::Review),
                "{later}s on"
            );
        }
    }

    #[test]
    fn through_a_new_state_file() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        let _ = app.update(Event::State(Box::default()), &mut model);
        let _ = app.update(frame(NOW + 60.0, &[]), &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Review));
    }

    #[test]
    fn until_the_data_shows_the_move_then_follows_cmux() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        let _ = app.update(frame(NOW + 2.0, &[("a", "g-review")]), &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Review));
        // The override is gone: a later move in the sidebar shows at once.
        let _ = app.update(frame(NOW + 90.0, &[("a", "")]), &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Unsorted));
    }

    #[test]
    fn until_cmux_puts_the_card_somewhere_else_itself() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        // Parked starts folded, so Unsorted stands in for somewhere else.
        let _ = app.update(frame(NOW + 2.0, &[("a", "")]), &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Unsorted));
    }

    #[test]
    fn in_its_new_order_until_cmux_has_it() {
        let (app, mut model) = started();
        let _ = app.update(move_card("b", LaneKey::Main, Some("a")), &mut model);
        let _ = app.update(frame(NOW + 60.0, &[]), &mut model);
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["b", "a"]);
        let order = [
            "anchor-main",
            "b",
            "a",
            "anchor-review",
            "c",
            "anchor-parked",
            "p",
            "u",
        ];
        let _ = app.update(reordered(NOW + 61.0, &[], &order), &mut model);
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["b", "a"]);
        // The override is gone: cmux's own later order shows at once.
        let _ = app.update(frame(NOW + 90.0, &[]), &mut model);
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["a", "b"]);
    }

    #[test]
    fn but_a_card_moved_back_before_cmux_shows_the_move_asks_for_its_lane_again() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        let asked = asked(&app, &mut model, move_card("a", LaneKey::Main, None));
        // The Review join is already on its way, so cmux is asked to put it back.
        assert!(
            asked.contains(
                &r#"cmux workspace.group.add {"group_id":"g-main","workspace_id":"a"}"#.to_string()
            ),
            "{asked:?}"
        );
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Main));
    }

    #[test]
    fn until_a_cmux_call_for_it_fails() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        let _ = app.update(Event::CmuxFailed { id: "a".into() }, &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Main));
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["a", "b"]);
    }

    #[test]
    fn through_a_second_move_while_cmux_shows_only_the_first() {
        let (app, mut model) = started();
        let _ = app.update(move_card("a", LaneKey::Review, None), &mut model);
        let _ = app.update(move_card("a", LaneKey::Unsorted, None), &mut model);
        // cmux has made the first move but not the second yet.
        let _ = app.update(frame(NOW + 2.0, &[("a", "g-review")]), &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Unsorted));
        let _ = app.update(frame(NOW + 3.0, &[("a", "")]), &mut model);
        assert_eq!(lane_of(&app, &model, "a"), Some(LaneKey::Unsorted));
    }

    #[test]
    fn in_order_through_a_second_reorder_while_cmux_shows_only_the_first() {
        let (app, mut model) = started();
        let _ = app.update(move_card("c", LaneKey::Main, Some("a")), &mut model);
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["c", "a", "b"]);
        let asked = asked(&app, &mut model, move_card("b", LaneKey::Main, Some("c")));
        // Counted in the order the first move asked for, which cmux will
        // have by the time this one reaches it.
        assert_eq!(
            asked[0],
            r#"cmux workspace.reorder {"workspace_id":"b","index":1}"#
        );
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["b", "c", "a"]);
        let first = [
            "anchor-main",
            "c",
            "a",
            "b",
            "anchor-review",
            "anchor-parked",
            "p",
            "u",
        ];
        let _ = app.update(reordered(NOW + 2.0, &[("c", "g-main")], &first), &mut model);
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["b", "c", "a"]);
        let both = [
            "anchor-main",
            "b",
            "c",
            "a",
            "anchor-review",
            "anchor-parked",
            "p",
            "u",
        ];
        let _ = app.update(reordered(NOW + 3.0, &[("c", "g-main")], &both), &mut model);
        assert_eq!(lane_cards(&app, &model, LaneKey::Main), ["b", "c", "a"]);
    }
}

/// A new state file reseeds only what the file holds.
mod a_new_state_file {
    use super::*;

    #[test]
    fn keeps_an_undated_dismissal_which_is_never_saved() {
        let (app, mut model) = started();
        let data = json!({
            "epoch": NOW,
            "groups": [],
            "workspaces": [{ "id": "c", "agents": [{ "id": "s1", "status": "needs_input" }] }],
        });
        let _ = app.update(
            Event::Data(serde_json::from_value(data).unwrap()),
            &mut model,
        );
        assert_eq!(app.view(&model).needs.list, ["c"]);
        let asked = asked(&app, &mut model, Event::Dismiss { id: "c".into() });
        assert_eq!(asked, ["set dismissed.c delete", "render"]);
        let _ = app.update(Event::State(Box::default()), &mut model);
        assert!(app.view(&model).needs.list.is_empty());
    }

    #[test]
    fn does_not_undo_a_second_flip_with_the_first_flips_write() {
        let (app, mut model) = started();
        let _ = app.update(Event::FlipView, &mut model);
        let _ = app.update(Event::FlipView, &mut model);
        let first = SavedState::from_json(r#"{"ui":{"mode":"projects"}}"#).unwrap();
        let _ = app.update(Event::State(Box::new(first)), &mut model);
        assert_eq!(app.view(&model).mode, "all");
    }

    #[test]
    fn keeps_a_dated_dismissal_until_the_handler_has_written_it() {
        let (app, mut model) = started();
        let _ = app.update(asking_frame(), &mut model);
        let _ = app.update(Event::Dismiss { id: "c".into() }, &mut model);
        // A hook's write lands first, without the dismissal.
        let _ = app.update(Event::State(Box::default()), &mut model);
        assert!(app.view(&model).needs.list.is_empty());
    }
}

mod switch_to {
    use super::*;

    #[test]
    fn selects_the_workspace_in_cmux_as_a_tap_on_its_card_does() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, Event::SwitchTo { id: "c".into() });
        assert_eq!(
            asked,
            [r#"cmux workspace.select {"workspace_id":"c"}"#, "render"]
        );
    }

    #[test]
    fn does_nothing_for_an_empty_id_or_before_the_first_frame() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, Event::SwitchTo { id: String::new() });
        assert_eq!(asked, ["render"]);
        let mut empty = Model::default();
        let asked = super::asked(&app, &mut empty, Event::SwitchTo { id: "c".into() });
        assert_eq!(asked, ["render"]);
    }
}

/// A frame where `c` waits on Jon: a real ask since 900.
fn asking_frame() -> Event {
    let data = json!({
        "epoch": NOW,
        "groups": [{ "id": "g-review", "name": "For review", "anchorId": "anchor-review" }],
        "workspaces": [
            { "id": "anchor-review", "title": "For review", "group": "g-review" },
            {
                "id": "c",
                "group": "g-review",
                "agents": [{ "id": "s1", "status": "needs_input", "sinceEpoch": 900 }],
            },
        ],
    });
    Event::Data(serde_json::from_value(data).unwrap())
}

mod dismiss {
    use super::*;

    #[test]
    fn writes_the_spell_to_dismissed_as_the_sidebar_does_and_leaves_needs_you() {
        let (app, mut model) = started();
        let _ = app.update(asking_frame(), &mut model);
        assert_eq!(app.view(&model).needs.list, ["c"]);
        let asked = asked(&app, &mut model, Event::Dismiss { id: "c".into() });
        assert_eq!(asked, [r#"set dismissed.c {"s1":900}"#, "render"]);
        assert!(app.view(&model).needs.list.is_empty());
    }

    #[test]
    fn writes_nothing_for_a_card_not_waiting() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, Event::Dismiss { id: "a".into() });
        assert_eq!(asked, ["render"]);
    }
}

mod flip_view {
    use super::*;

    #[test]
    fn flips_between_all_and_projects_saving_each_switch() {
        let (app, mut model) = started();
        let asked = asked(&app, &mut model, Event::FlipView);
        assert_eq!(asked, [r#"set ui.mode "projects""#, "render"]);
        assert_eq!(app.view(&model).mode, "projects");
        let asked = super::asked(&app, &mut model, Event::FlipView);
        assert_eq!(asked, [r#"set ui.mode "all""#, "render"]);
        assert_eq!(app.view(&model).mode, "all");
    }

    #[test]
    fn works_before_the_first_frame() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::FlipView, &mut model);
        assert_eq!(app.view(&model).mode, "projects");
    }
}

/// Each write, as the handler takes it from its URL (scripts/state-url.ts
/// parses the query, state-config.ts's applySet sets the one entry), leaves
/// a state file the sidebar's shape still reads, holding what Jon did.
mod round_trip {
    use super::*;

    /// decodeURIComponent, for the URLs persist_url writes.
    fn decode(s: &str) -> String {
        let bytes = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// The key and value a `cmux-cockpit://set` URL carries.
    fn parse(url: &str) -> (String, Option<Value>) {
        let query = url.strip_prefix("cmux-cockpit://set?").unwrap();
        let mut key = None;
        let mut value = None;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap();
            match k {
                "key" => key = Some(decode(v)),
                "value" => value = Some(serde_json::from_str(&decode(v)).unwrap()),
                "token" => assert_eq!(decode(v), "tok en"),
                other => panic!("the handler refuses a {other} param"),
            }
        }
        (key.unwrap(), value)
    }

    /// applySet for one entry: `<map>.<id>` set, or deleted with no value.
    fn apply(state: &mut Map<String, Value>, key: &str, value: Option<Value>) {
        let (map, id) = key.split_once('.').unwrap();
        let entries = state
            .entry(map)
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .unwrap();
        match value {
            Some(v) => entries.insert(id.to_string(), v),
            None => entries.remove(id),
        };
    }

    /// Every write the events ask for, through its URL into `state`.
    fn write_all(
        app: &Cockpit,
        model: &mut Model,
        events: Vec<Event>,
        state: &mut Map<String, Value>,
    ) {
        for event in events {
            let mut cmd = app.update(event, model);
            for e in cmd.effects() {
                if let Effect::Persist(r) = e {
                    let (key, value) = parse(&r.operation.url("tok en"));
                    assert_eq!(key, r.operation.key);
                    assert_eq!(value, r.operation.value);
                    apply(state, &key, value);
                }
            }
        }
    }

    #[test]
    fn a_dismissal_and_a_view_flip_survive_the_file_and_a_reload() {
        let (app, mut model) = started();
        let mut state = Map::new();
        state.insert("ui".into(), json!({ "collapsed": { "lane:main": 1 } }));
        let events = vec![
            asking_frame(),
            Event::Dismiss { id: "c".into() },
            Event::FlipView,
        ];
        write_all(&app, &mut model, events, &mut state);
        assert_eq!(
            Value::Object(state.clone()),
            json!({
                "ui": { "collapsed": { "lane:main": 1 }, "mode": "projects" },
                "dismissed": { "c": { "s1": 900 } },
            })
        );

        let text = Value::Object(state).to_string();
        let saved = SavedState::from_json(&text).unwrap();
        let mut reloaded = Model::default();
        let _ = app.update(Event::State(Box::new(saved.clone())), &mut reloaded);
        let _ = app.update(asking_frame(), &mut reloaded);
        let view = app.view(&reloaded);
        assert_eq!(view.mode, "projects");
        assert!(
            view.needs.list.is_empty(),
            "the dismissal holds across a reload"
        );
        let seeded = Session::new(Vec::new(), saved);
        assert!(seeded.projects_mode());
    }

    #[test]
    fn flipping_back_leaves_the_folds_alone() {
        let (app, mut model) = started();
        let mut state = Map::new();
        state.insert("ui".into(), json!({ "collapsed": { "quiet": 1 } }));
        write_all(
            &app,
            &mut model,
            vec![Event::FlipView, Event::FlipView],
            &mut state,
        );
        let saved = SavedState::from_json(&Value::Object(state).to_string()).unwrap();
        assert_eq!(saved.ui.mode.map(|m| m.as_str()), Some("all"));
        assert_eq!(saved.ui.collapsed.get("quiet"), Some(&1.0));
    }
}
