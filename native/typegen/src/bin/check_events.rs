//! Decodes, as the core's `Event`, every event the Swift sidebar encoded
//! with the generated types (native/mac/Tests/Outbox writes them), and
//! checks each is the action native/runner/tests/actions.json spells in
//! the same place. The file holds every action alone, then each again
//! wrapped in `At`. native/mac/test.sh runs it:
//!
//! ```sh
//! cargo run -q -p cockpit_typegen --bin check_events -- <actions.json> <swift-events.json>
//! ```
//!
//! Every line reads `ok:`, and any `FAIL:` line fails the run.

use std::process::ExitCode;

use cockpit_core::Event;
use serde_json::Value;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let [_, actions, swift] = args.as_slice() else {
        eprintln!("usage: check_events <actions.json> <swift-events.json>");
        return ExitCode::from(2);
    };
    match check(actions, swift) {
        Ok(0) => {
            println!("all passed");
            ExitCode::SUCCESS
        }
        Ok(n) => {
            println!("{n} failed");
            ExitCode::FAILURE
        }
        Err(e) => {
            println!("FAIL: {e}");
            ExitCode::FAILURE
        }
    }
}

fn read(path: &str) -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))
}

fn event(v: &Value) -> Result<Event, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}

/// The time native/mac/Tests/Outbox stamps each event with, in seconds.
const NOW: f64 = 1_791_229_864.123;

/// Whether Swift's `got` decodes as the same action as `want`, alone or
/// (`stamped`) inside `At` at `NOW`.
fn same(got: &Value, want: &Value, stamped: bool) -> Result<(), String> {
    let want = event(want)?;
    let got = match (event(got)?, stamped) {
        (Event::At { now, event }, true) if now.to_bits() == NOW.to_bits() => *event,
        (Event::At { now, .. }, true) => return Err(format!("stamped {now}, not {NOW}")),
        (e, false) => e,
        (e, true) => return Err(format!("{e:?} is not stamped")),
    };
    if !got.is_action() {
        return Err(format!("{got:?} is not an action"));
    }
    // Event has no PartialEq; its Debug spells every field.
    if format!("{got:?}") != format!("{want:?}") {
        return Err(format!("{got:?} is not {want:?}"));
    }
    Ok(())
}

/// How many failed.
fn check(actions: &str, swift: &str) -> Result<usize, String> {
    let want = read(actions)?;
    let got = read(swift)?;
    let mut failed = 0;
    if got.len() != want.len() * 2 {
        println!(
            "FAIL: Swift wrote {} events for {} actions",
            got.len(),
            want.len()
        );
        failed += 1;
    }
    let (alone, stamped) = got.split_at(want.len().min(got.len()));
    for (round, list) in [(false, alone), (true, stamped)] {
        for (g, w) in list.iter().zip(&want) {
            let what = if round { "stamped " } else { "" };
            match same(g, w, round) {
                Ok(()) => println!("ok: Swift's {what}{g} decodes as {w}"),
                Err(e) => {
                    println!("FAIL: Swift's {what}{g}: {e}");
                    failed += 1;
                }
            }
        }
    }
    Ok(failed)
}
