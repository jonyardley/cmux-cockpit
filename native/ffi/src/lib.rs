//! The cockpit core inside the Swift sidebar (issues #268, #270): crux's
//! bridge in its JSON form, behind C-convention calls Swift can see through
//! `include/cockpit_ffi.h`. One core per process, made on first use.
//!
//! - `cockpit_load`: the helper's data.json (runner/src/publish.rs) in. The
//!   first load turns the panel and the PR poll on; each sends Home, the
//!   project table, the state and cmux's data, in that order, only where
//!   that part of the file differs from the last load's.
//! - `cockpit_update`: one event as JSON in (`{"At": {"now": …, "event":
//!   …}}` for a click, an inbox/ answer as it is).
//! - Both hand back what the core asked for as `Out`: whether to draw
//!   again, and each other effect as the JSON text of one outbox/ effect
//!   file (runner/src/effect.rs), oldest first.
//! - `cockpit_view`: the view as JSON, the whole panel under `panel` once
//!   `"PanelOn"` has been sent.
//! - `cockpit_free`: hands back the bytes any call gave out.
//!
//! No effect the core asks for has an answer it waits on (each is a
//! notification, its answer an event in inbox/), so crux's `resolve` has
//! no call here.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, OnceLock};

use cockpit_core::Cockpit;
use crux_core::Core;
use crux_core::bridge::{Bridge, JsonFfiFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

type Shell = Bridge<Cockpit, JsonFfiFormat>;

/// What a call reports.
pub const COCKPIT_OK: i32 = 0;
/// The event was not one the core reads.
pub const COCKPIT_BAD_EVENT: i32 = 1;
/// The core could not write its answer.
pub const COCKPIT_FAILED: i32 = 2;
/// A null pointer where bytes were due.
pub const COCKPIT_NULL: i32 = 3;

/// Bytes the core hands out. Swift reads `len` bytes at `ptr`, then gives
/// them back with `cockpit_free`.
#[repr(C)]
pub struct CockpitBytes {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl CockpitBytes {
    fn empty() -> Self {
        CockpitBytes {
            ptr: std::ptr::null_mut(),
            len: 0,
            cap: 0,
        }
    }

    fn from_vec(v: Vec<u8>) -> Self {
        let mut v = std::mem::ManuallyDrop::new(v);
        CockpitBytes {
            ptr: v.as_mut_ptr(),
            len: v.len(),
            cap: v.capacity(),
        }
    }
}

fn shell() -> &'static Shell {
    static SHELL: OnceLock<Shell> = OnceLock::new();
    SHELL.get_or_init(|| Bridge::new(Core::new()))
}

/// What one call asked of the shell.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Out {
    /// The core asked to be drawn again: read `cockpit_view`.
    pub redraw: bool,
    /// Every other effect, oldest first, each the JSON text of one
    /// outbox/ file, written as it is.
    pub effects: Vec<String>,
}

impl Out {
    /// Adds the requests crux's bridge wrote for one event: a list of
    /// `{"id": …, "effect": {"<Name>": …}}`.
    fn add(&mut self, requests: &[u8]) -> Result<(), i32> {
        let requests: Vec<Value> = serde_json::from_slice(requests).map_err(|_| COCKPIT_FAILED)?;
        for request in requests {
            let effect = &request["effect"];
            if effect.get("Render").is_some() {
                self.redraw = true;
            } else {
                self.effects
                    .push(serde_json::to_string(effect).map_err(|_| COCKPIT_FAILED)?);
            }
        }
        Ok(())
    }
}

/// One event through the bridge, its requests added to `out`.
fn send(event: &[u8], out: &mut Out) -> Result<(), i32> {
    let mut requests = Vec::new();
    match shell().update(event, &mut requests) {
        Ok(()) => out.add(&requests),
        Err(crux_core::bridge::BridgeError::DeserializeEvent(_)) => Err(COCKPIT_BAD_EVENT),
        Err(_) => Err(COCKPIT_FAILED),
    }
}

/// Runs `call`, its `Out` as JSON, or the code to report. A panic in the
/// core is reported, never let out across the C boundary.
fn answer(call: impl FnOnce(&mut Out) -> Result<(), i32>) -> Result<Vec<u8>, i32> {
    let run = || {
        let mut out = Out::default();
        call(&mut out)?;
        serde_json::to_vec(&out).map_err(|_| COCKPIT_FAILED)
    };
    catch_unwind(AssertUnwindSafe(run)).unwrap_or(Err(COCKPIT_FAILED))
}

/// One event's `Out` as JSON, or the code to report.
pub fn update(event: &[u8]) -> Result<Vec<u8>, i32> {
    answer(|out| send(event, out))
}

/// The parts of data.json the core reads (runner/src/publish.rs
/// `PublishedData`); its envelope and each part's `_seq` are left, since a
/// restarted helper counts from 1 again.
#[derive(Deserialize)]
struct DataFile {
    home: Option<String>,
    projects: Option<Box<RawValue>>,
    state: Option<Box<RawValue>>,
    data: Option<Box<RawValue>>,
}

/// What the last load sent, so the next sends only what differs.
#[derive(Default)]
struct Loaded {
    started: bool,
    home: Option<Option<String>>,
    projects: Option<String>,
    state: Option<String>,
    data: Option<String>,
}

fn loaded() -> &'static Mutex<Loaded> {
    static LOADED: OnceLock<Mutex<Loaded>> = OnceLock::new();
    LOADED.get_or_init(Mutex::default)
}

/// Sends `{"<name>": <raw>}` when `raw` is there and differs from `last`.
fn send_part(
    name: &str,
    raw: Option<&RawValue>,
    last: &mut Option<String>,
    out: &mut Out,
) -> Result<(), i32> {
    let Some(raw) = raw.map(RawValue::get) else {
        return Ok(());
    };
    if last.as_deref() == Some(raw) {
        return Ok(());
    }
    send(format!("{{\"{name}\":{raw}}}").as_bytes(), out)?;
    *last = Some(raw.to_string());
    Ok(())
}

fn load_into(file: &[u8], out: &mut Out) -> Result<(), i32> {
    let file: DataFile = serde_json::from_slice(file).map_err(|_| COCKPIT_BAD_EVENT)?;
    let mut last = loaded().lock().map_err(|_| COCKPIT_FAILED)?;
    let first = !last.started;
    if first {
        send(b"\"PanelOn\"", out)?;
    }
    if last.home.as_ref() != Some(&file.home) {
        let home = serde_json::json!({ "Home": { "home": file.home } });
        send(home.to_string().as_bytes(), out)?;
        last.home = Some(file.home);
    }
    send_part(
        "Projects",
        file.projects.as_deref(),
        &mut last.projects,
        out,
    )?;
    send_part("State", file.state.as_deref(), &mut last.state, out)?;
    send_part("Data", file.data.as_deref(), &mut last.data, out)?;
    if first {
        // After the inputs, so the first asks go out with a frame to ask
        // about.
        send(b"\"PrPollOn\"", out)?;
        last.started = true;
    }
    Ok(())
}

/// Loads one data.json; its `Out` as JSON, or the code to report.
pub fn load(file: &[u8]) -> Result<Vec<u8>, i32> {
    answer(|out| load_into(file, out))
}

/// The view as JSON, or the code to report.
pub fn view() -> Result<Vec<u8>, i32> {
    let run = || {
        let mut out = Vec::new();
        shell()
            .view(&mut out)
            .map(|()| out)
            .map_err(|_| COCKPIT_FAILED)
    };
    catch_unwind(AssertUnwindSafe(run)).unwrap_or(Err(COCKPIT_FAILED))
}

/// Writes `result` to `out`, which may hold anything beforehand; returns
/// the code.
///
/// # Safety
///
/// `out` is non-null and valid for a write of one `CockpitBytes`.
unsafe fn hand_out(result: Result<Vec<u8>, i32>, out: *mut CockpitBytes) -> i32 {
    let (bytes, code) = match result {
        Ok(bytes) => (CockpitBytes::from_vec(bytes), COCKPIT_OK),
        Err(code) => (CockpitBytes::empty(), code),
    };
    // SAFETY: the caller's promise; a write never reads what was there.
    unsafe { out.write(bytes) };
    code
}

/// Runs `call` on `len` bytes at `input`, its answer into `out`. Nothing
/// runs unless both pointers are there.
///
/// # Safety
///
/// As `cockpit_update`'s.
unsafe fn take_in(
    input: *const u8,
    len: usize,
    out: *mut CockpitBytes,
    call: fn(&[u8]) -> Result<Vec<u8>, i32>,
) -> i32 {
    if out.is_null() {
        return COCKPIT_NULL;
    }
    if input.is_null() {
        // SAFETY: `out` is non-null, and the caller's promise covers it.
        return unsafe { hand_out(Err(COCKPIT_NULL), out) };
    }
    // SAFETY: the caller's promise about `input` and `len`.
    let input = unsafe { std::slice::from_raw_parts(input, len) };
    // SAFETY: as above.
    unsafe { hand_out(call(input), out) }
}

/// Sends one event, `len` bytes of JSON at `event`; its `Out` lands in
/// `out`.
///
/// # Safety
///
/// `event` points at `len` readable bytes or is null, and `out` is null
/// or valid for a write of one `CockpitBytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cockpit_update(
    event: *const u8,
    len: usize,
    out: *mut CockpitBytes,
) -> i32 {
    // SAFETY: the caller's promise, passed on.
    unsafe { take_in(event, len, out, update) }
}

/// Loads data.json, `len` bytes at `file`; its `Out` lands in `out`.
///
/// # Safety
///
/// As `cockpit_update`'s, for `file`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cockpit_load(file: *const u8, len: usize, out: *mut CockpitBytes) -> i32 {
    // SAFETY: the caller's promise, passed on.
    unsafe { take_in(file, len, out, load) }
}

/// The current view, into `out`.
///
/// # Safety
///
/// `out` is null or valid for a write of one `CockpitBytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cockpit_view(out: *mut CockpitBytes) -> i32 {
    if out.is_null() {
        return COCKPIT_NULL;
    }
    // SAFETY: `out` is non-null, and the caller's promise covers it.
    unsafe { hand_out(view(), out) }
}

/// Gives back bytes from `cockpit_load`, `cockpit_update` or
/// `cockpit_view`.
///
/// # Safety
///
/// `bytes` came from one of those calls and has not been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cockpit_free(bytes: CockpitBytes) {
    if bytes.ptr.is_null() {
        return;
    }
    // SAFETY: ptr, len and cap are the Vec's own, from `from_vec`.
    drop(unsafe { Vec::from_raw_parts(bytes.ptr, bytes.len, bytes.cap) });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn json_of(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    fn send(event: Value) -> Result<Out, i32> {
        update(event.to_string().as_bytes()).map(|b| serde_json::from_slice(&b).unwrap())
    }

    /// One test, since the core is one per process.
    #[test]
    fn a_fold_click_redraws_the_panel_from_the_core_in_process() {
        assert_eq!(send(json!("PanelOn")).map(|o| o.redraw), Ok(true));
        let frame = json!({ "Data": { "epoch": 1000.0, "workspaces": [
            { "id": "a", "directory": "/a", "title": "One" },
        ]}});
        assert!(send(frame).unwrap().redraw);
        let lane = |v: &Value| v["panel"]["lanes"][4].clone();
        let folded = |v: &Value| lane(v)["key"] == "unsorted" && lane(v)["collapsed"] == true;
        assert!(!folded(&json_of(&view().unwrap())));

        let click =
            json!({ "At": { "now": 1001.0, "event": { "ToggleLane": { "lane": "unsorted" } } } });
        let out = send(click).unwrap();
        assert!(out.redraw);
        assert!(out.effects.iter().all(|e| !e.contains("Render")));
        assert!(folded(&json_of(&view().unwrap())));

        assert_eq!(send(json!({ "Nope": 1 })), Err(COCKPIT_BAD_EVENT));
    }

    #[test]
    fn bytes_go_out_and_come_back_through_the_c_calls() {
        let mut out = CockpitBytes::empty();
        // SAFETY: `out` is ours; null event is the case under test.
        let code = unsafe { cockpit_update(std::ptr::null(), 0, &mut out) };
        assert_eq!(code, COCKPIT_NULL);
        // SAFETY: a null `out` is the case under test.
        let code = unsafe { cockpit_update(b"\"Refresh\"".as_ptr(), 9, std::ptr::null_mut()) };
        assert_eq!(code, COCKPIT_NULL);
        // SAFETY: `out` is ours.
        assert_eq!(unsafe { cockpit_view(&mut out) }, COCKPIT_OK);
        assert!(out.len > 0);
        // SAFETY: `out` came from `cockpit_view`.
        unsafe { cockpit_free(out) };
    }
}
