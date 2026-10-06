//! The cockpit core inside the Swift sidebar (issue #268): crux's bridge in
//! its JSON form, behind C-convention calls Swift can see through
//! `include/cockpit_ffi.h`. One core per process, made on first use.
//!
//! - `cockpit_update`: one event as JSON (`{"At": {"now": …, "event": …}}`
//!   for a click) in, the effects it asks for as JSON out, each with the id
//!   crux gives it.
//! - `cockpit_view`: the view as JSON, the whole panel under `panel` once
//!   `"PanelOn"` has been sent.
//! - `cockpit_free`: hands back the bytes either call gave out.
//!
//! No effect the core asks for has an answer it waits on (each is a
//! notification), so crux's `resolve` has no call here yet.

use std::sync::OnceLock;

use cockpit_core::Cockpit;
use crux_core::Core;
use crux_core::bridge::{Bridge, JsonFfiFormat};

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

/// The event's effects as JSON, or the code to report.
pub fn update(event: &[u8]) -> Result<Vec<u8>, i32> {
    let mut out = Vec::new();
    match shell().update(event, &mut out) {
        Ok(()) => Ok(out),
        Err(crux_core::bridge::BridgeError::DeserializeEvent(_)) => Err(COCKPIT_BAD_EVENT),
        Err(_) => Err(COCKPIT_FAILED),
    }
}

/// The view as JSON, or the code to report.
pub fn view() -> Result<Vec<u8>, i32> {
    let mut out = Vec::new();
    shell()
        .view(&mut out)
        .map(|()| out)
        .map_err(|_| COCKPIT_FAILED)
}

/// Writes `result` to `out`; returns the code.
///
/// # Safety
///
/// `out` is null or points at a `CockpitBytes` the caller owns.
unsafe fn hand_out(result: Result<Vec<u8>, i32>, out: *mut CockpitBytes) -> i32 {
    // SAFETY: the caller's promise above; a null `out` was refused by `as_mut`.
    let Some(out) = (unsafe { out.as_mut() }) else {
        return COCKPIT_NULL;
    };
    match result {
        Ok(bytes) => {
            *out = CockpitBytes::from_vec(bytes);
            COCKPIT_OK
        }
        Err(code) => {
            *out = CockpitBytes::empty();
            code
        }
    }
}

/// Sends one event, `len` bytes of JSON at `event`; the effects it asks
/// for land in `out`.
///
/// # Safety
///
/// `event` points at `len` readable bytes (or is null with `len` 0), and
/// `out` points at a `CockpitBytes` the caller owns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cockpit_update(
    event: *const u8,
    len: usize,
    out: *mut CockpitBytes,
) -> i32 {
    if event.is_null() {
        // SAFETY: the caller's promise about `out`.
        return unsafe { hand_out(Err(COCKPIT_NULL), out) };
    }
    // SAFETY: the caller's promise about `event` and `len`.
    let event = unsafe { std::slice::from_raw_parts(event, len) };
    // SAFETY: the caller's promise about `out`.
    unsafe { hand_out(update(event), out) }
}

/// The current view, into `out`.
///
/// # Safety
///
/// `out` points at a `CockpitBytes` the caller owns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cockpit_view(out: *mut CockpitBytes) -> i32 {
    // SAFETY: the caller's promise about `out`.
    unsafe { hand_out(view(), out) }
}

/// Gives back bytes from `cockpit_update` or `cockpit_view`.
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

    fn send(event: Value) -> Result<Value, i32> {
        update(event.to_string().as_bytes()).map(|b| json_of(&b))
    }

    /// One test, since the core is one per process.
    #[test]
    fn a_fold_click_redraws_the_panel_from_the_core_in_process() {
        assert_eq!(send(json!("PanelOn")).map(|_| ()), Ok(()));
        let frame = json!({ "Data": { "epoch": 1000.0, "workspaces": [
            { "id": "a", "directory": "/a", "title": "One" },
        ]}});
        let effects = send(frame).unwrap();
        assert!(effects.as_array().is_some_and(|e| !e.is_empty()));
        let lane = |v: &Value| v["panel"]["lanes"][4].clone();
        let folded = |v: &Value| lane(v)["key"] == "unsorted" && lane(v)["collapsed"] == true;
        assert!(!folded(&json_of(&view().unwrap())));

        let click =
            json!({ "At": { "now": 1001.0, "event": { "ToggleLane": { "lane": "unsorted" } } } });
        send(click).unwrap();
        assert!(folded(&json_of(&view().unwrap())));

        assert_eq!(send(json!({ "Nope": 1 })), Err(COCKPIT_BAD_EVENT));
    }

    #[test]
    fn bytes_go_out_and_come_back_through_the_c_calls() {
        let mut out = CockpitBytes::empty();
        // SAFETY: `out` is ours; null event is the case under test.
        let code = unsafe { cockpit_update(std::ptr::null(), 0, &mut out) };
        assert_eq!(code, COCKPIT_NULL);
        // SAFETY: `out` is ours.
        assert_eq!(unsafe { cockpit_view(&mut out) }, COCKPIT_OK);
        assert!(out.len > 0);
        // SAFETY: `out` came from `cockpit_view`.
        unsafe { cockpit_free(out) };
    }
}
