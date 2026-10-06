//! data.json through `load` as the Swift sidebar reads it (#270): the
//! panel matches a core fed the same inputs by hand, a file that only
//! moved its envelope sends nothing, and every effect handed back is an
//! outbox/ file the helper takes. Its own process, so its own core.

#![cfg(test)]

use cockpit_core::{Cockpit, Data, Event, Model, Project, SavedState};
use cockpit_ffi::{COCKPIT_BAD_EVENT, Out, load, update, view};
use cockpit_runner::effect::EffectFile;
use crux_core::App;
use serde_json::{Value, json};

const HOME: &str = "/Users/coder";

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/golden/lanes.input.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// data.json as the helper writes it (runner/src/publish.rs).
fn file(seq: u64, input: &Value) -> Vec<u8> {
    let file = json!({
        "seq": seq, "written_at_ms": 1_000_000_000 + seq, "home": HOME,
        "projects": input["projects"], "projects_seq": seq,
        "state": input["state"], "state_seq": seq,
        "data": input["data"], "data_seq": seq,
    });
    file.to_string().into_bytes()
}

fn loaded(bytes: &[u8]) -> Out {
    serde_json::from_slice(&load(bytes).unwrap()).unwrap()
}

fn panel() -> Value {
    let v: Value = serde_json::from_slice(&view().unwrap()).unwrap();
    v["panel"].clone()
}

/// The panel of a core fed the same inputs one event at a time.
fn by_hand(input: &Value) -> Value {
    let mut model = Model::default();
    let events = [
        Event::PanelOn,
        Event::Home {
            home: Some(HOME.into()),
        },
        Event::Projects(serde_json::from_value::<Vec<Project>>(input["projects"].clone()).unwrap()),
        Event::State(Box::new(
            serde_json::from_value::<SavedState>(input["state"].clone()).unwrap(),
        )),
        Event::Data(serde_json::from_value::<Data>(input["data"].clone()).unwrap()),
        Event::PrPollOn,
    ];
    for event in events {
        let _effects = Cockpit.update(event, &mut model);
    }
    serde_json::to_value(Cockpit.view(&model).panel).unwrap()
}

/// One test, since the core is one per process.
#[test]
fn data_json_loads_into_the_core_and_only_what_changed_goes_in_again() {
    let input = golden();
    let first = loaded(&file(1, &input));
    assert!(first.redraw);
    assert_eq!(panel(), by_hand(&input));
    assert!(
        !first.effects.is_empty(),
        "the scene's folders are asked about"
    );
    for effect in &first.effects {
        assert!(
            EffectFile::parse(effect).is_ok(),
            "the helper takes {effect}"
        );
    }
    assert!(
        first.effects.iter().any(|e| e.starts_with(r#"{"PrPoll""#)),
        "the PR poll is on: {:?}",
        first.effects
    );

    let again = loaded(&file(2, &input));
    assert_eq!(again, Out::default(), "a new envelope alone sends nothing");

    let restarted = loaded(&file(1, &input));
    assert_eq!(
        restarted,
        Out::default(),
        "nor does a helper counting from 1 again"
    );

    let mut later = input.clone();
    later["data"]["epoch"] = json!(1_000_030);
    later["data"]["workspaces"][1]["title"] = json!("Renamed in cmux");
    assert!(loaded(&file(3, &later)).redraw);
    assert!(panel().to_string().contains("Renamed in cmux"));
    assert_eq!(panel(), by_hand(&later));

    let id = later["data"]["workspaces"][1]["id"].clone();
    let answer = json!({ "CmuxFailed": { "id": id } }).to_string();
    let out: Out = serde_json::from_slice(&update(answer.as_bytes()).unwrap()).unwrap();
    assert!(out.redraw, "an inbox/ answer goes in as it is");

    assert_eq!(load(b"[1]"), Err(COCKPIT_BAD_EVENT));
    assert_eq!(load(br#"{"home": 3}"#), Err(COCKPIT_BAD_EVENT));
}
