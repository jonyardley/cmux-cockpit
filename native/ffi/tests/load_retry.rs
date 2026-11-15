//! A data.json the core refuses part of (#279 review): the next good file
//! still brings the panel and the PR poll up. Its own process, so its own
//! core.

#![cfg(test)]

use cockpit_ffi::{COCKPIT_BAD_EVENT, Out, load, view};
use serde_json::{Value, json};

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/golden/lanes.input.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn file(input: &Value, state: &Value) -> Vec<u8> {
    let file = json!({
        "seq": 1, "written_at_ms": 1, "home": "/Users/coder",
        "projects": input["projects"], "state": state, "data": input["data"],
    });
    file.to_string().into_bytes()
}

#[test]
fn a_load_refused_part_way_goes_in_whole_next_time() {
    let input = golden();
    assert_eq!(load(&file(&input, &json!(5))), Err(COCKPIT_BAD_EVENT));

    let out: Out = serde_json::from_slice(&load(&file(&input, &input["state"])).unwrap()).unwrap();
    assert!(out.redraw);
    assert!(
        out.effects.iter().any(|e| e.starts_with(r#"{"PrPoll""#)),
        "the PR poll is on after all: {:?}",
        out.effects
    );
    let v: Value = serde_json::from_slice(&view().unwrap()).unwrap();
    assert!(
        v["panel"]["lanes"]
            .as_array()
            .is_some_and(|l| !l.is_empty())
    );
}
