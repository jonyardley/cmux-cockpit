//! The Ostinato records reach the sidebar's core through data.json (issue
//! #390): the part the helper writes for them is one the core reads, and
//! one it cannot read is refused rather than dropped. Its own process, so
//! its own core.

#![cfg(test)]

use std::collections::BTreeMap;

use cockpit_core::ostinato::{OstinatoFeed, RecordText};
use cockpit_ffi::{COCKPIT_BAD_EVENT, load};
use cockpit_runner::publish::PublishedData;
use cockpit_runner::{Feed, Input};
use serde_json::{Value, json};

const RECORD: &str = include_str!("../../../test/golden/ostinato/one-issue.jsonl");

/// data.json as the helper writes it, from a feed with no core that was
/// handed the records.
fn published() -> Value {
    let mut feed = Feed::without_core(Some("/Users/coder".into()));
    let ostinato = OstinatoFeed {
        records: BTreeMap::from([(
            "example/app-one".to_string(),
            RecordText::from_bytes(RECORD.as_bytes()),
        )]),
        checkouts: BTreeMap::from([("/dev/app-one".to_string(), "example/app-one".to_string())]),
    };
    let (changed, _, _) = feed.input(Input::Ostinato(Box::new(ostinato)));
    assert!(changed, "news for data.json");
    let file = PublishedData {
        seq: 1,
        written_at_ms: 1,
        home: Some("/Users/coder"),
        inputs: &feed.inputs,
    };
    serde_json::to_value(&file).unwrap()
}

#[test]
fn the_records_part_of_data_json_goes_into_the_core() {
    let file = published();
    assert_eq!(file["ostinato_seq"], 1);
    assert!(
        file["ostinato"]["records"]["example/app-one"]["text"]
            .as_str()
            .is_some_and(|t| t == RECORD)
    );
    assert!(load(file.to_string().as_bytes()).is_ok());

    let mut broken = file.clone();
    broken["ostinato"] = json!({ "records": 3 });
    assert_eq!(load(broken.to_string().as_bytes()), Err(COCKPIT_BAD_EVENT));
}
