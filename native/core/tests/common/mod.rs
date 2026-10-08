//! Helpers the golden tests share (app.rs and golden.rs).

use serde_json::{Value, json};

/// The TypeScript model with R4.5's one deliberate difference taken out
/// (issue #281): the JS cockpit, being retired, still lifts waiting cards
/// into a strip and leaves a placeholder; the core keeps each card in its
/// place. So each placeholder reads as its card in the same spot, and
/// Needs you keeps only its list and clock. The Projects entries map the
/// same way; app.rs, which checks All alone, never reads them.
pub fn without_the_strip(mut want: Value) -> Value {
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
