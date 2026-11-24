//! Each Ostinato cycle on a card, saved for the agents panel's Details
//! tab (#399), as its waits are (waits_save.rs): the panel reads only
//! config/state.json, so the core writes the cycles of the record each
//! workspace's card carries (`Session::ostinato_cycles`) into its
//! `cycles` map, the newest `MAX_CYCLES` of them.
//!
//! Nothing saved moves with the clock, so an unchanged cycle is never
//! written again; only a change goes out (`Saves`). Before the first
//! Ostinato feed the file's cycles are kept, as a park is, for at most
//! `PARK_GRACE_SECS` after the first frame: a restart then never deletes
//! and writes back every cycle, and a runner with no record, which sends
//! no feed, still clears them.

use std::collections::BTreeMap;

use crate::data::Data;
use crate::ostinato::cycle::{Cycle, Milestone};
use crate::persist::{
    MAX_CYCLE_SESSIONS, MAX_CYCLE_TEXT, MAX_CYCLES, MAX_STAGES, SavedCycle, SavedStage, is_epoch,
    is_id, is_text,
};
use crate::running_save::Saves;
use crate::session::Session;
use crate::text::{clip, js_space};
use crate::waits_save::PARK_GRACE_SECS;

/// What the core sent for the `cycles` map, and when its first frame came.
#[derive(Debug, Clone, Default)]
pub struct CycleSaves {
    pub saves: Saves<Vec<SavedCycle>>,
    first: Option<f64>,
}

impl CycleSaves {
    /// A new state file: what was sent is forgotten (`Saves::file_read`).
    pub fn file_read(&mut self) {
        self.saves.file_read();
    }

    /// Whether the file's cycles still stand while no feed has come, at
    /// the frame's clock `epoch`; with no clock there is no grace.
    fn waiting_for_feed(&mut self, session: &Session, epoch: Option<f64>) -> bool {
        if session.ostinato.fed() {
            return false;
        }
        let Some(now) = epoch else { return false };
        let first = *self.first.get_or_insert(now);
        now - first < PARK_GRACE_SECS
    }

    /// The writes that bring the file's `cycles` to the frame's: None
    /// before the state file is read, while the frame lists no
    /// workspaces, or while the first feed is awaited.
    pub fn writes(
        &mut self,
        session: &Session,
        data: &Data,
    ) -> Option<BTreeMap<String, Option<Vec<SavedCycle>>>> {
        if !session.state_read || self.waiting_for_feed(session, data.epoch) {
            return None;
        }
        let now = cycles(session, data)?;
        Some(self.saves.writes(&session.saved.cycles, &now, data.epoch))
    }
}

/// `t` as one line of plain text cut to fit a cycle, or None when
/// nothing is left. Trimmed as JS trim() does (js_space), byte order
/// marks too, so the script never refuses what the core sends.
fn text(t: &str) -> Option<String> {
    let flat: String = t
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| *c >= ' ' && *c != '\u{7f}')
        .collect();
    let cut = clip(flat.trim_matches(js_space), MAX_CYCLE_TEXT);
    is_text(&cut, MAX_CYCLE_TEXT).then_some(cut)
}

/// Up to MAX_CYCLE_SESSIONS of `sessions` that are ids.
fn sessions(sessions: &[String]) -> Vec<String> {
    sessions
        .iter()
        .filter(|s| is_id(s))
        .take(MAX_CYCLE_SESSIONS)
        .cloned()
        .collect()
}

/// A stage as saved, or None when its name or either number will not fit.
fn stage(m: &Milestone) -> Option<SavedStage> {
    if !is_epoch(m.at) || !is_epoch(m.secs) {
        return None;
    }
    Some(SavedStage {
        name: text(&m.name)?,
        at: m.at,
        secs: m.secs,
        sessions: sessions(&m.sessions),
    })
}

/// A cycle as saved, or None when it cannot fit: each text, number or
/// stage that will not fit is dropped on its own, the item alone being
/// needed.
pub fn saved(c: &Cycle) -> Option<SavedCycle> {
    let skip = c.stages.len().saturating_sub(MAX_STAGES);
    let cycle = SavedCycle {
        item: text(&c.item)?,
        // Trimmed as text() is, so a byte order mark at either end, which
        // JS trim() takes off, never makes the script refuse the list.
        url: c
            .url
            .as_deref()
            .map(|u| u.trim_matches(js_space).to_string())
            .filter(|u| is_text(u, crate::persist::MAX_URL)),
        attempt: c.attempt.filter(|n| *n >= 1),
        outcome: c.outcome.as_deref().and_then(text),
        reason: c.park.as_ref().and_then(|p| text(&p.reason)),
        question: c.park.as_ref().and_then(|p| text(&p.question)),
        pr: c.pr.as_deref().and_then(text),
        sessions: sessions(&c.sessions),
        cost: c.cost_usd.filter(|n| is_epoch(*n)),
        started: c.started.filter(|n| is_epoch(*n)),
        ended: c.ended.filter(|n| is_epoch(*n)),
        stages: c.stages.iter().skip(skip).filter_map(stage).collect(),
    };
    cycle.fits().then_some(cycle)
}

/// Each workspace's cycles in `data`, the newest `MAX_CYCLES`, oldest
/// first, for every workspace whose card carries any. None when the
/// frame lists no workspaces, so a frame that briefly lacks them never
/// deletes every saved cycle.
pub fn cycles(session: &Session, data: &Data) -> Option<BTreeMap<String, Vec<SavedCycle>>> {
    let list = data.workspaces.as_deref().filter(|l| !l.is_empty())?;
    let mut out = BTreeMap::new();
    for w in list.iter().filter(|w| is_id(&w.id)) {
        // Newest first, stopping at MAX_CYCLES that fit, so a frame
        // never builds the older ones only to drop them.
        let mut kept: Vec<SavedCycle> = session
            .ostinato_cycles(data, w)
            .iter()
            .rev()
            .filter_map(saved)
            .take(MAX_CYCLES)
            .collect();
        kept.reverse();
        if !kept.is_empty() {
            out.insert(w.id.clone(), kept);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{Cockpit, Effect, Event, Model};
    use crate::ostinato::{OstinatoFeed, RecordText};
    use crate::persist::SavedState;
    use crux_core::App;

    const DIR: &str = "/dev/app";

    /// A record of `picked` cycles of x#1 to x#n, each ended an hour on.
    fn record(n: u32) -> String {
        let mut out = String::from(
            r#"{"v":1,"at":"2026-11-13T09:00:00Z","run":"r-1","event":"run_started","project":"example/x","caps":{}}
"#,
        );
        for i in 1..=n {
            out.push_str(&format!(
                r#"{{"v":1,"at":"2026-11-13T10:{i:02}:00Z","run":"r-1","event":"picked","item":"x#{i}","url":"https://github.com/example/x/issues/{i}","attempt":1}}
{{"v":1,"at":"2026-11-13T10:{i:02}:30Z","run":"r-1","event":"stage","item":"x#{i}","stage":"brief","attempt":1}}
{{"v":1,"at":"2026-11-13T10:{i:02}:45Z","run":"r-1","event":"attempt_ended","item":"x#{i}","outcome":"abandoned","cost_usd":1.5,"attempt":1,"sessions":["s{i}"]}}
"#
            ));
        }
        out
    }

    fn feed(text: &str) -> Event {
        let mut f = OstinatoFeed::default();
        f.records
            .insert("example/x".into(), RecordText::from_bytes(text.as_bytes()));
        f.checkouts.insert(DIR.into(), "example/x".into());
        Event::Ostinato(Box::new(f))
    }

    fn frame(now: f64) -> Event {
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": now,
            "workspaces": [{"id": "W", "title": "app", "directory": DIR},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap();
        Event::Data(data)
    }

    fn core(state: &str, sidebar: bool) -> Model {
        let mut m = Model::default();
        if sidebar {
            let _ = Cockpit.update(Event::PanelOn, &mut m);
        }
        let _ = Cockpit.update(Event::State(Box::new(read(state))), &mut m);
        m
    }

    fn read(state: &str) -> SavedState {
        SavedState::from_json(state).unwrap()
    }

    fn sent(m: &mut Model, event: Event) -> Vec<serde_json::Value> {
        let mut cmd = Cockpit.update(event, m);
        cmd.effects()
            .filter_map(|e| match e {
                Effect::SaveCycles(r) => serde_json::to_value(r.operation.cycles).ok(),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_sidebars_core_saves_once_resends_then_deletes() {
        let mut m = core("{}", true);
        let _ = sent(&mut m, frame(1000.0));
        let got = sent(&mut m, feed(&record(1)));
        let want = serde_json::json!({"W": [{"item": "x#1",
            "url": "https://github.com/example/x/issues/1", "attempt": 1,
            "outcome": "abandoned", "sessions": ["s1"], "cost": 1.5,
            "started": 1794564060.0, "ended": 1794564105.0,
            "stages": [{"name": "brief", "at": 1794564090.0, "secs": 30.0,
                "sessions": ["s1"]}]}]});
        assert_eq!(got, std::slice::from_ref(&want));
        assert!(sent(&mut m, frame(1030.0)).is_empty(), "sent already");
        assert_eq!(sent(&mut m, frame(1070.0)).len(), 1, "the file lacks it");
        // The file shows it: nothing more. Its record gone: a delete.
        let shown = format!(r#"{{"cycles": {want}}}"#);
        assert!(sent(&mut m, Event::State(Box::new(read(&shown)))).is_empty());
        assert!(sent(&mut m, frame(5000.0)).is_empty());
        assert_eq!(
            sent(&mut m, Event::Ostinato(Box::default())),
            [serde_json::json!({"W": null})]
        );
    }

    #[test]
    fn the_panes_core_never_saves() {
        let mut m = core("{}", false);
        let _ = sent(&mut m, frame(1000.0));
        assert!(sent(&mut m, feed(&record(1))).is_empty());
    }

    #[test]
    fn the_files_cycles_are_kept_a_minute_before_the_first_feed() {
        let held = r#"{"cycles": {"W": [{"item": "x#1"}]}}"#;
        let mut m = core(held, true);
        assert!(sent(&mut m, frame(1000.0)).is_empty());
        assert!(sent(&mut m, frame(1059.0)).is_empty());
        assert_eq!(
            sent(&mut m, frame(1060.0)),
            [serde_json::json!({"W": null})],
            "no feed came"
        );
    }

    #[test]
    fn keeps_the_newest_cycles_and_reads_back_what_it_wrote() {
        let mut m = core("{}", true);
        let _ = sent(&mut m, frame(1000.0));
        let got = sent(&mut m, feed(&record(MAX_CYCLES as u32 + 2)));
        let list = got[0]["W"].as_array().unwrap();
        assert_eq!(list.len(), MAX_CYCLES);
        assert_eq!(list[0]["item"], "x#3");
        assert_eq!(list[MAX_CYCLES - 1]["item"], "x#12");
        // What goes out reads back the same, so it is never sent again.
        let back = read(&format!(r#"{{"cycles": {}}}"#, got[0]));
        let again = serde_json::to_value(&back.cycles).unwrap();
        assert_eq!(again, got[0]);
    }

    #[test]
    fn long_and_multi_line_text_is_cut_to_one_line() {
        let long = format!("Why?\n{}", "a ".repeat(100));
        let t = text(&long).unwrap();
        assert!(t.starts_with("Why? a a"));
        assert!(is_text(&t, MAX_CYCLE_TEXT));
        assert_eq!(text(" \n "), None);
    }

    #[test]
    fn a_byte_order_mark_at_either_end_is_trimmed_as_js_does() {
        assert_eq!(text("\u{FEFF}x#1\u{FEFF}").as_deref(), Some("x#1"));
        assert_eq!(text("\u{FEFF}"), None);
    }

    #[test]
    fn a_byte_order_mark_round_a_url_is_trimmed_and_never_sent() {
        let mut c = bare("x#1");
        c.url = Some("\u{FEFF}https://github.com/example/x/issues/1\u{FEFF}".into());
        let got = saved(&c).unwrap();
        assert_eq!(
            got.url.as_deref(),
            Some("https://github.com/example/x/issues/1")
        );
        c.url = Some("\u{FEFF}".into());
        assert_eq!(saved(&c).unwrap().url, None);
        // What JS trim() would take off is refused, as the script does.
        let mut bad = got.clone();
        bad.url = Some("\u{FEFF}https://github.com/example/x/issues/1".into());
        assert!(!bad.fits());
        bad.url = None;
        bad.pr = Some("x#2\u{FEFF}".into());
        assert!(!bad.fits());
    }

    fn bare(item: &str) -> Cycle {
        Cycle {
            run: "r-1".into(),
            item: item.into(),
            url: None,
            attempt: Some(1),
            started: Some(10.0),
            stages: Vec::new(),
            pr: None,
            park: None,
            sessions: Vec::new(),
            outcome: Some("merged".into()),
            cost_usd: Some(1.0),
            ended: Some(20.0),
        }
    }

    #[test]
    fn a_bad_number_drops_only_itself() {
        let mut c = bare("x#1");
        c.attempt = Some(0);
        c.cost_usd = Some(-1.0);
        c.started = Some(f64::NAN);
        c.ended = Some(-5.0);
        c.stages = vec![
            Milestone {
                name: "brief".into(),
                at: -1.0,
                secs: 0.0,
                sessions: Vec::new(),
            },
            Milestone {
                name: "built".into(),
                at: 15.0,
                secs: 5.0,
                sessions: Vec::new(),
            },
        ];
        let got = saved(&c).unwrap();
        assert_eq!(got.item, "x#1");
        assert_eq!(got.outcome.as_deref(), Some("merged"));
        assert_eq!(
            (got.attempt, got.cost, got.started, got.ended),
            (None, None, None, None)
        );
        let names: Vec<&str> = got.stages.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["built"]);
    }
}
