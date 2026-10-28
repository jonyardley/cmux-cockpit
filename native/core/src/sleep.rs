//! Parking a card puts its agent to sleep (issue #328): cmux hibernates
//! it, keeping its session, and moving the card out of Parked or opening
//! it wakes it again.
//!
//! cmux's own data never says an agent is asleep: to Agent View and the
//! hooks a hibernated agent looks like one that ended. So the cockpit keeps
//! its own record of the tabs it put to sleep, in the state file's `asleep`
//! map (persist.rs), written when cmux says the agent is asleep and
//! cleared when it wakes, when a newer agent shows up in that workspace, or
//! when the workspace closes. Each call goes out as a cmux call,
//! `agent.hibernate` or `agent.wake`, which the runner carries out on its
//! own thread and answers as `Event::Slept` with cmux's refusal code, if
//! any (runner sleep_ask.rs).
//!
//! Like every move, it draws at once: a parked card reads Asleep while the
//! call is on its way, and a card moved out reads Waking until its agent
//! is back. A refusal shows on the card in plain words; only "active a
//! moment ago" is tried again, a few times, while the card stays parked.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::app::CmuxCall;
use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::lanes::LaneKey;
use crate::persist::SavedAsleep;
use crate::session::{Param, Session};
use crate::status::StatusKind;
use crate::time::now_epoch;

/// The cmux socket command that puts one agent tab to sleep.
pub const HIBERNATE: &str = "agent.hibernate";
/// The cmux socket command that wakes one.
pub const WAKE: &str = "agent.wake";
/// The lane whose cards sleep.
pub const SLEEPING_LANE: &str = "parked";

/// How long a hibernate call may run before its card stops reading
/// Asleep: cmux's own wait (120 s) and a little more.
pub const GOING_SECS: f64 = 130.0;
/// How long a card reads Waking with no agent back: cmux's own wait
/// (30 s) and a little more.
pub const WAKING_SECS: f64 = 40.0;
/// How long a refusal stays on its card.
pub const NOTE_SECS: f64 = 30.0 * 60.0;
/// The wait before a hibernate refused as "active a moment ago" is tried
/// again: cmux wants 5 s of quiet.
pub const RETRY_SECS: f64 = 8.0;
/// How many times it is tried again.
pub const RETRIES: u8 = 4;

/// The code the runner gives a call that ran past its time.
pub const TIMED_OUT: &str = "timed_out";
/// The code the runner gives a call that could not run, or failed with no code.
pub const NOT_SENT: &str = "not_sent";
/// The soft refusal that alone is tried again.
const RECENTLY_ACTIVE: &str = "recently_active";
/// cmux's refusal for a tab on screen; the cockpit gives it too for the
/// card that is open, without asking.
const VISIBLE: &str = "visible";
/// The cockpit's own: a live agent whose tab it does not know.
const NO_TAB: &str = "no_tab";

/// The answer to one `agent.hibernate` or `agent.wake` call, as the
/// runner sends it back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SleepAnswer {
    pub workspace: String,
    pub surface: String,
    /// A wake's answer; else a hibernate's.
    pub wake: bool,
    /// None when cmux said OK, else its refusal code ("visible"), or
    /// TIMED_OUT or NOT_SENT when it never answered.
    #[serde(default)]
    pub refused: Option<String>,
}

/// A sleep call the runner should carry out: whether it wakes, its
/// workspace and its tab. None for any other cmux call.
pub fn sleep_call(call: &CmuxCall) -> Option<(bool, String, String)> {
    let wake = match call.method.as_str() {
        HIBERNATE => false,
        WAKE => true,
        _ => return None,
    };
    let param = |name: &str| {
        call.params.iter().find_map(|(k, v)| match v {
            Param::Str(s) if k == name => Some(s.clone()),
            _ => None,
        })
    };
    Some((wake, param("workspace_id")?, param("surface_id")?))
}

/// The refusal code in what `cmux rpc` printed on a refusal,
/// "Error: visible: This agent is on screen. Switch away from it first.";
/// NOT_SENT when it printed none.
pub fn refusal_code(stderr: &str) -> String {
    let code = stderr.lines().find_map(|line| {
        let (code, _) = line.trim().strip_prefix("Error:")?.trim().split_once(':')?;
        let code = code.trim();
        let plain = !code.is_empty()
            && code
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        plain.then(|| code.to_string())
    });
    code.unwrap_or_else(|| NOT_SENT.to_string())
}

/// Why a hibernate was refused, in plain words.
fn sleep_reason(code: &str) -> &'static str {
    match code {
        VISIBLE => "it's on screen",
        NO_TAB => "the cockpit can't find its tab",
        "not_restorable" => "cmux can't resume this agent",
        "lifecycle_unknown" => "cmux can't tell if it's idle",
        "agent_busy" => "it's working or waiting for you",
        "unconfirmed_input" => "it has typed input not yet sent",
        RECENTLY_ACTIVE => "it was active a moment ago",
        "process_scope_unsafe" => "it's running background work",
        "not_running" => "its terminal isn't running",
        "teardown_in_progress" => "it's already going to sleep",
        "teardown_refused" => "its session couldn't be kept safe",
        "surface_not_found" => "its tab has gone",
        TIMED_OUT => "cmux didn't answer",
        _ => "cmux said no",
    }
}

/// Why a wake was refused, in plain words.
fn wake_reason(code: &str) -> &'static str {
    match code {
        "resume_unavailable" => "cmux couldn't start it again",
        "teardown_in_progress" => "it's still going to sleep",
        TIMED_OUT => "cmux didn't answer",
        _ => "cmux said no",
    }
}

/// What a card says when its agent did not sleep or wake.
pub fn refusal_note(wake: bool, code: &str) -> String {
    if wake {
        format!("Didn't wake: {}", wake_reason(code))
    } else {
        format!("Didn't sleep: {}", sleep_reason(code))
    }
}

/// What a card says while a soft refusal waits to be tried again.
fn retry_note(code: &str) -> String {
    format!("Not asleep yet: {}, trying again", sleep_reason(code))
}

/// Whether cards in this lane sleep.
pub fn sleeps_in(lane: &LaneKey) -> bool {
    lane.as_str() == SLEEPING_LANE
}

/// An agent that is running: it has a status, and has not ended.
fn live(a: &Agent) -> bool {
    a.status.as_ref().is_some_and(|s| *s != AgentStatus::Ended)
}

/// Whether a running agent in the workspace began after `since`: one
/// woken from sleep, or started again by hand. The agent put to sleep was
/// quiet before it slept, so it never counts while it lingers in the data.
fn newer_agent(w: &Workspace, since: f64) -> bool {
    w.agent_list().any(|a| {
        live(a)
            && a.since_epoch
                .or(a.last_activity_at)
                .is_some_and(|t| t > since)
    })
}

/// Hibernate calls on their way in one workspace.
#[derive(Debug, Clone, PartialEq)]
struct Going {
    surfaces: Vec<String>,
    at: f64,
}

/// A wake on its way: when it was asked, and the record it cleared, put
/// back if cmux refuses.
#[derive(Debug, Clone, PartialEq)]
struct Waking {
    at: f64,
    record: SavedAsleep,
}

/// Why a workspace's agent did not sleep or wake, and since when.
#[derive(Debug, Clone, PartialEq)]
struct Note {
    text: String,
    at: f64,
}

/// A hibernate to try again once `due`.
#[derive(Debug, Clone, PartialEq)]
struct Retry {
    ws: String,
    surface: String,
    due: f64,
}

/// What the core holds about sleep between frames, beside the state
/// file's record: the calls on their way, the refusals to show, and the
/// tries left.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sleep {
    going: IndexMap<String, Going>,
    waking: IndexMap<String, Waking>,
    notes: IndexMap<String, Note>,
    retries: Vec<Retry>,
    /// Tries made again, by workspace and tab.
    tried: IndexMap<(String, String), u8>,
}

impl Sleep {
    /// Drops everything held about a workspace, as a new move starts afresh.
    fn forget(&mut self, ws: &str) {
        self.going.shift_remove(ws);
        self.waking.shift_remove(ws);
        self.notes.shift_remove(ws);
        self.retries.retain(|r| r.ws != ws);
        self.tried.retain(|(w, _), _| w != ws);
    }

    fn note(&mut self, ws: &str, text: String, at: f64) {
        self.notes.insert(ws.to_string(), Note { text, at });
    }

    /// Takes a surface off the workspace's calls on their way; true when
    /// it was one.
    fn arrived(&mut self, ws: &str, surface: &str) -> bool {
        let Some(g) = self.going.get_mut(ws) else {
            return false;
        };
        let before = g.surfaces.len();
        g.surfaces.retain(|s| s != surface);
        let was = g.surfaces.len() != before;
        if g.surfaces.is_empty() {
            self.going.shift_remove(ws);
        }
        was
    }
}

impl Session {
    /// A card moved from lane `from` to `to` (model.rs move_to_lane): into
    /// Parked puts its agents to sleep, out of it wakes them.
    pub(crate) fn lane_moved(&mut self, data: &Data, w: &Workspace, from: &LaneKey, to: &LaneKey) {
        match (sleeps_in(from), sleeps_in(to)) {
            (false, true) => self.put_to_sleep(data, w),
            (true, false) => self.wake_up(data, w),
            _ => {}
        }
    }

    /// Asks cmux to hibernate each running agent's tab in the workspace,
    /// not already asleep. The open card is refused at once, as cmux would
    /// refuse it.
    fn put_to_sleep(&mut self, data: &Data, w: &Workspace) {
        let now = now_epoch(data);
        self.sleep.forget(&w.id);
        if self.is_selected(data, Some(w)) {
            self.sleep.note(&w.id, refusal_note(false, VISIBLE), now);
            return;
        }
        let asleep = self.saved.asleep.get(&w.id);
        let mut surfaces: Vec<String> = Vec::new();
        let mut untabbed = false;
        for a in w.agent_list().filter(|a| live(a)) {
            match &a.surface_id {
                Some(s) if asleep.is_some_and(|r| r.surfaces.contains(s)) => {}
                Some(s) if !surfaces.contains(s) => surfaces.push(s.clone()),
                Some(_) => {}
                None => untabbed = true,
            }
        }
        if untabbed {
            self.sleep.note(&w.id, refusal_note(false, NO_TAB), now);
        }
        for s in &surfaces {
            self.ask_sleep(&w.id, s, false);
        }
        if !surfaces.is_empty() {
            self.sleep
                .going
                .insert(w.id.clone(), Going { surfaces, at: now });
        }
    }

    /// Asks cmux to wake each tab the workspace's record holds, and clears
    /// the record at once; it comes back if cmux refuses.
    fn wake_up(&mut self, data: &Data, w: &Workspace) {
        let now = now_epoch(data);
        self.sleep.forget(&w.id);
        let Some(record) = self.saved.asleep.get(&w.id).cloned() else {
            return;
        };
        for s in &record.surfaces {
            self.ask_sleep(&w.id, s, true);
        }
        self.sleep
            .waking
            .insert(w.id.clone(), Waking { at: now, record });
        self.set_asleep(&w.id, None);
    }

    fn ask_sleep(&mut self, ws: &str, surface: &str, wake: bool) {
        let method = if wake { WAKE } else { HIBERNATE };
        self.cmux(
            method,
            vec![
                ("surface_id", Param::Str(surface.to_string())),
                ("workspace_id", Param::Str(ws.to_string())),
            ],
        );
    }

    /// Sets or clears a workspace's sleep record, here at once and in the
    /// state file.
    fn set_asleep(&mut self, ws: &str, record: Option<SavedAsleep>) {
        let value = match record.map(serde_json::to_value).transpose() {
            Ok(v) => v,
            // A record is two plain fields, so this never happens.
            Err(_) => return,
        };
        let key = format!("asleep.{ws}");
        self.saved.set_entry(&key, value.as_ref());
        self.persist_set(key, value);
    }

    /// Adds a tab to a workspace's sleep record, starting one at `since`.
    fn add_asleep(&mut self, ws: &str, surface: &str, since: f64) {
        let mut record = self.saved.asleep.get(ws).cloned().unwrap_or(SavedAsleep {
            surfaces: Vec::new(),
            since,
        });
        if !record.surfaces.iter().any(|s| s == surface) {
            record.surfaces.push(surface.to_string());
        }
        self.set_asleep(ws, Some(record));
    }

    /// Whether the workspace's card should be asleep now: in Parked, and
    /// not open.
    fn wants_sleep(&mut self, data: &Data, ws: &str) -> bool {
        let Some(w) = data.ws_by_id(ws) else {
            return false;
        };
        let lane = self.lane_of(data, w);
        sleeps_in(&lane) && !self.is_selected(data, Some(w))
    }

    /// The runner's answer to a sleep call.
    pub fn sleep_answered(&mut self, data: &Data, a: SleepAnswer) {
        let now = now_epoch(data);
        if a.wake {
            self.woke(a, now);
        } else {
            self.slept(data, a, now);
        }
    }

    fn slept(&mut self, data: &Data, a: SleepAnswer, now: f64) {
        let ws = a.workspace.as_str();
        let asked = self.sleep.arrived(ws, &a.surface);
        match a.refused.as_deref() {
            None | Some("already_hibernated") => {
                self.add_asleep(ws, &a.surface, now);
                // Moved out of Parked, or opened, while it went to sleep.
                if !self.wants_sleep(data, ws)
                    && let Some(w) = data.ws_by_id(ws)
                {
                    self.wake_up(data, w);
                }
            }
            // A move since asked for something else.
            Some(_) if !asked => {}
            Some(RECENTLY_ACTIVE) if self.tries_left(ws, &a.surface) => {
                self.sleep.retries.push(Retry {
                    ws: ws.to_string(),
                    surface: a.surface.clone(),
                    due: now + RETRY_SECS,
                });
                self.sleep.note(ws, retry_note(RECENTLY_ACTIVE), now);
            }
            Some(code) => self.sleep.note(ws, refusal_note(false, code), now),
        }
    }

    /// Whether a soft refusal may be tried again; counts the try.
    fn tries_left(&mut self, ws: &str, surface: &str) -> bool {
        let tried = self
            .sleep
            .tried
            .entry((ws.to_string(), surface.to_string()))
            .or_insert(0);
        *tried += 1;
        *tried <= RETRIES
    }

    fn woke(&mut self, a: SleepAnswer, now: f64) {
        let ws = a.workspace.as_str();
        let Some(waking) = self.sleep.waking.get_mut(ws) else {
            return;
        };
        waking.record.surfaces.retain(|s| *s != a.surface);
        let since = waking.record.since;
        match a.refused.as_deref() {
            // Awake now, or never asleep, or its tab has gone.
            None | Some("not_hibernated" | "surface_not_found") => {}
            Some(code) => {
                self.sleep.waking.shift_remove(ws);
                self.add_asleep(ws, &a.surface, since);
                self.sleep.note(ws, refusal_note(true, code), now);
            }
        }
    }

    /// Tidies sleep each update: lapses what has waited too long, clears
    /// a record a newer agent or a closed workspace makes stale, wakes a
    /// sleeping card that is open, and tries a soft refusal again.
    pub(crate) fn tend_sleep(&mut self, data: &Data) {
        let now = now_epoch(data);
        self.sleep.going.retain(|_, g| now - g.at <= GOING_SECS);
        self.sleep.notes.retain(|_, n| now - n.at <= NOTE_SECS);
        self.sleep.waking.retain(|ws, k| {
            let back = data
                .ws_by_id(ws)
                .is_some_and(|w| newer_agent(w, k.record.since));
            now - k.at <= WAKING_SECS && !back
        });
        let records: Vec<(String, f64)> = self
            .saved
            .asleep
            .iter()
            .map(|(ws, r)| (ws.clone(), r.since))
            .collect();
        for (ws, since) in records {
            match data.ws_by_id(&ws) {
                // An empty frame says nothing about which workspaces closed.
                None if !data.workspace_list().is_empty() => self.set_asleep(&ws, None),
                None => {}
                Some(w) if newer_agent(w, since) => self.set_asleep(&ws, None),
                Some(w) if self.is_selected(data, Some(w)) => self.wake_up(data, w),
                Some(_) => {}
            }
        }
        self.retry_due(data, now);
    }

    /// Sends each retry that is due, while its card is still parked and
    /// its agent still runs in that tab.
    fn retry_due(&mut self, data: &Data, now: f64) {
        let (due, later): (Vec<Retry>, Vec<Retry>) = std::mem::take(&mut self.sleep.retries)
            .into_iter()
            .partition(|r| r.due <= now);
        self.sleep.retries = later;
        for r in due {
            let running = data.ws_by_id(&r.ws).is_some_and(|w| {
                w.agent_list()
                    .any(|a| live(a) && a.surface_id.as_deref() == Some(r.surface.as_str()))
            });
            if !running || !self.wants_sleep(data, &r.ws) {
                continue;
            }
            self.ask_sleep(&r.ws, &r.surface, false);
            let going = self.sleep.going.entry(r.ws.clone()).or_insert(Going {
                surfaces: Vec::new(),
                at: now,
            });
            going.surfaces.push(r.surface);
        }
    }

    /// The card's sleep look, ahead of its agent's: Waking while a wake is
    /// on its way, Asleep while a hibernate is or the record holds it.
    pub fn sleep_kind(&self, ws: &str) -> Option<StatusKind> {
        if self.sleep.waking.contains_key(ws) {
            return Some(StatusKind::Waking);
        }
        let asleep = self.sleep.going.contains_key(ws) || self.saved.asleep.contains_key(ws);
        asleep.then_some(StatusKind::Asleep)
    }

    /// When the workspace's agent went to sleep, from its record.
    pub fn asleep_since(&self, ws: &str) -> Option<f64> {
        self.saved.asleep.get(ws).map(|r| r.since)
    }

    /// Why the workspace's agent did not sleep or wake, while that shows.
    pub fn sleep_note(&self, ws: &str) -> Option<&str> {
        self.sleep.notes.get(ws).map(|n| n.text.as_str())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::session::Outbound;

    const NOW: f64 = 1_000_000.0;

    fn session() -> Session {
        let mut s = Session::default();
        s.reseed(crate::persist::SavedState::default());
        s
    }

    /// Main and Parked, with `a` in Main running one idle agent in tab
    /// S1, `b` open, and `c` in Parked.
    fn data(epoch: f64) -> Data {
        data_with(epoch, json!([agent("S1", "idle", NOW - 60.0)]))
    }

    fn agent(surface: &str, status: &str, since: f64) -> Value {
        json!({"id": format!("s-{surface}"), "status": status, "surfaceId": surface, "sinceEpoch": since})
    }

    fn data_with(epoch: f64, agents: Value) -> Data {
        data_in("g-main", epoch, agents)
    }

    /// As cmux has it once a move into Parked has landed.
    fn parked(epoch: f64, agents: Value) -> Data {
        data_in("g-parked", epoch, agents)
    }

    fn idle_s1() -> Value {
        json!([agent("S1", "idle", NOW - 60.0)])
    }

    fn data_in(group: &str, epoch: f64, agents: Value) -> Data {
        serde_json::from_value(json!({
            "epoch": epoch,
            "selectedId": "b",
            "groups": [
                {"id": "g-main", "name": "Main activity"},
                {"id": "g-parked", "name": "Parked"},
            ],
            "workspaces": [
                {"id": "a", "title": "A", "group": group, "agents": agents},
                {"id": "b", "title": "B", "group": "g-main", "selected": true,
                 "agents": [agent("S9", "idle", NOW - 60.0)]},
                {"id": "c", "title": "C", "group": "g-parked"},
            ],
        }))
        .unwrap()
    }

    /// The outbox in words.
    fn sent(s: &mut Session) -> Vec<String> {
        s.take_outbox()
            .into_iter()
            .map(|o| match o {
                Outbound::Cmux { method, params } => {
                    let p: Vec<String> = params
                        .iter()
                        .map(|(k, v)| match v {
                            Param::Str(v) => format!("{k}={v}"),
                            other => format!("{k}={other:?}"),
                        })
                        .collect();
                    format!("{method} {}", p.join(" "))
                }
                Outbound::Persist { key, value } => match value {
                    Some(v) => format!("persist {key} {v}"),
                    None => format!("clear {key}"),
                },
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn park(s: &mut Session, d: &Data, id: &str) {
        s.move_to_lane(d, d.ws_by_id(id), LaneKey::from("parked"));
    }

    fn unpark(s: &mut Session, d: &Data, id: &str) {
        s.move_to_lane(d, d.ws_by_id(id), LaneKey::from("main"));
    }

    fn answer(ws: &str, surface: &str, wake: bool, refused: Option<&str>) -> SleepAnswer {
        SleepAnswer {
            workspace: ws.into(),
            surface: surface.into(),
            wake,
            refused: refused.map(str::to_string),
        }
    }

    fn hibernate(surface: &str, ws: &str) -> String {
        format!("{HIBERNATE} surface_id={surface} workspace_id={ws}")
    }

    fn wake(surface: &str, ws: &str) -> String {
        format!("{WAKE} surface_id={surface} workspace_id={ws}")
    }

    #[test]
    fn parking_asks_cmux_to_hibernate_each_running_tab_and_reads_asleep_at_once() {
        let mut s = session();
        let d = data_with(
            NOW,
            json!([
                agent("S1", "idle", NOW - 60.0),
                agent("S2", "idle", NOW - 60.0),
                agent("S3", "ended", NOW - 60.0),
                agent("S1", "idle", NOW - 60.0),
            ]),
        );
        park(&mut s, &d, "a");
        let out = sent(&mut s);
        assert_eq!(
            out[1..],
            [hibernate("S1", "a"), hibernate("S2", "a")],
            "after the group join, one call per running tab: {out:?}"
        );
        assert_eq!(s.sleep_kind("a"), Some(StatusKind::Asleep));
        assert_eq!(s.sleep_note("a"), None);
    }

    #[test]
    fn an_ok_saves_the_record_and_a_reload_still_reads_asleep() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        sent(&mut s);
        s.sleep_answered(&d, answer("a", "S1", false, None));
        assert_eq!(
            sent(&mut s),
            [format!(
                r#"persist asleep.a {{"surfaces":["S1"],"since":{NOW:?}}}"#
            )]
        );
        assert_eq!(s.asleep_since("a"), Some(NOW));

        // A new state file that shows the write, as a reload reads it.
        let saved = s.saved.clone();
        let mut fresh = Session::default();
        fresh.reseed(saved);
        assert_eq!(fresh.sleep_kind("a"), Some(StatusKind::Asleep));
    }

    #[test]
    fn the_open_card_is_refused_at_once_with_no_call() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "b");
        let out = sent(&mut s);
        assert!(!out.iter().any(|o| o.starts_with(HIBERNATE)), "{out:?}");
        assert_eq!(s.sleep_note("b"), Some("Didn't sleep: it's on screen"));
        assert_eq!(s.sleep_kind("b"), None);
    }

    #[test]
    fn a_refusal_shows_its_reason_in_words_and_the_card_stays_parked() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        sent(&mut s);
        s.sleep_answered(&d, answer("a", "S1", false, Some("process_scope_unsafe")));
        assert_eq!(
            s.sleep_note("a"),
            Some("Didn't sleep: it's running background work")
        );
        assert_eq!(s.sleep_kind("a"), None, "not asleep");
        assert!(sent(&mut s).is_empty(), "no retry, no record");
        let a = d.ws_by_id("a").unwrap();
        assert_eq!(s.lane_of(&d, a), LaneKey::from("parked"));
    }

    #[test]
    fn active_a_moment_ago_is_tried_again_a_few_times_while_parked() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        sent(&mut s);
        let mut at = NOW;
        for _ in 0..RETRIES {
            s.sleep_answered(
                &parked(at, idle_s1()),
                answer("a", "S1", false, Some(RECENTLY_ACTIVE)),
            );
            assert_eq!(
                s.sleep_note("a"),
                Some("Not asleep yet: it was active a moment ago, trying again")
            );
            s.tend_sleep(&parked(at + 1.0, idle_s1()));
            assert!(sent(&mut s).is_empty(), "not due yet");
            at += RETRY_SECS;
            s.tend_sleep(&parked(at, idle_s1()));
            assert_eq!(sent(&mut s), [hibernate("S1", "a")]);
        }
        s.sleep_answered(
            &parked(at, idle_s1()),
            answer("a", "S1", false, Some(RECENTLY_ACTIVE)),
        );
        assert_eq!(
            s.sleep_note("a"),
            Some("Didn't sleep: it was active a moment ago"),
            "out of tries"
        );
        s.tend_sleep(&parked(at + RETRY_SECS, idle_s1()));
        assert!(sent(&mut s).is_empty());
    }

    #[test]
    fn a_retry_is_dropped_once_the_card_leaves_parked() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        sent(&mut s);
        s.sleep_answered(&d, answer("a", "S1", false, Some(RECENTLY_ACTIVE)));
        unpark(&mut s, &d, "a");
        sent(&mut s);
        s.tend_sleep(&data(NOW + RETRY_SECS));
        assert!(sent(&mut s).is_empty());
        assert_eq!(s.sleep_note("a"), None, "a new move starts afresh");
    }

    #[test]
    fn only_recently_active_is_retried() {
        for code in ["agent_busy", "visible", "lifecycle_unknown", TIMED_OUT] {
            let mut s = session();
            let d = data(NOW);
            park(&mut s, &d, "a");
            sent(&mut s);
            s.sleep_answered(&d, answer("a", "S1", false, Some(code)));
            s.tend_sleep(&data(NOW + RETRY_SECS));
            assert!(sent(&mut s).is_empty(), "{code}");
            assert!(
                s.sleep_note("a")
                    .is_some_and(|n| n.starts_with("Didn't sleep: ")),
                "{code}"
            );
        }
    }

    #[test]
    fn leaving_parked_wakes_each_sleeping_tab_and_reads_waking_until_it_is_back() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        s.sleep_answered(&d, answer("a", "S1", false, None));
        sent(&mut s);
        let later = parked(NOW + 600.0, json!([]));
        unpark(&mut s, &later, "a");
        let out = sent(&mut s);
        assert!(out.contains(&wake("S1", "a")), "{out:?}");
        assert!(out.contains(&"clear asleep.a".to_string()), "{out:?}");
        assert_eq!(s.sleep_kind("a"), Some(StatusKind::Waking));

        s.sleep_answered(&later, answer("a", "S1", true, None));
        s.tend_sleep(&later);
        assert_eq!(s.sleep_kind("a"), Some(StatusKind::Waking), "no agent yet");
        // The agent comes back, a new process.
        let back = parked(NOW + 605.0, json!([agent("S1", "idle", NOW + 603.0)]));
        s.tend_sleep(&back);
        assert_eq!(s.sleep_kind("a"), None);
    }

    #[test]
    fn waking_lapses_when_no_agent_comes_back() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        s.sleep_answered(&d, answer("a", "S1", false, None));
        unpark(&mut s, &d, "a");
        s.tend_sleep(&data_with(NOW + WAKING_SECS + 1.0, json!([])));
        assert_eq!(s.sleep_kind("a"), None);
    }

    #[test]
    fn a_refused_wake_puts_the_record_back_and_says_why() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        s.sleep_answered(&d, answer("a", "S1", false, None));
        unpark(&mut s, &d, "a");
        sent(&mut s);
        s.sleep_answered(
            &data(NOW + 5.0),
            answer("a", "S1", true, Some("resume_unavailable")),
        );
        assert_eq!(s.sleep_kind("a"), Some(StatusKind::Asleep));
        assert_eq!(s.asleep_since("a"), Some(NOW), "since stays");
        assert_eq!(
            s.sleep_note("a"),
            Some("Didn't wake: cmux couldn't start it again")
        );
    }

    #[test]
    fn opening_a_sleeping_card_wakes_it() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        s.sleep_answered(&d, answer("a", "S1", false, None));
        sent(&mut s);
        s.select_workspace(&d, Some("a"));
        sent(&mut s);
        s.tend_sleep(&d);
        let out = sent(&mut s);
        assert_eq!(out, [wake("S1", "a"), "clear asleep.a".to_string()]);
        assert_eq!(s.sleep_kind("a"), Some(StatusKind::Waking));
    }

    #[test]
    fn an_ok_that_comes_back_after_the_card_left_parked_wakes_it_straight_away() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        unpark(&mut s, &d, "a");
        sent(&mut s);
        s.sleep_answered(&d, answer("a", "S1", false, None));
        let out = sent(&mut s);
        assert!(out.contains(&wake("S1", "a")), "{out:?}");
        assert!(!s.saved.asleep.contains_key("a"));
    }

    #[test]
    fn a_refusal_for_a_call_no_longer_wanted_shows_nothing() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        unpark(&mut s, &d, "a");
        s.sleep_answered(&d, answer("a", "S1", false, Some("agent_busy")));
        assert_eq!(s.sleep_note("a"), None);
    }

    #[test]
    fn a_newer_agent_or_a_closed_workspace_clears_the_record() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        s.sleep_answered(&d, answer("a", "S1", false, None));
        sent(&mut s);

        // The old agent lingering in the data does not count.
        s.tend_sleep(&data(NOW + 2.0));
        assert!(sent(&mut s).is_empty());
        assert_eq!(s.sleep_kind("a"), Some(StatusKind::Asleep));

        s.tend_sleep(&data_with(
            NOW + 60.0,
            json!([agent("S4", "working", NOW + 50.0)]),
        ));
        assert_eq!(sent(&mut s), ["clear asleep.a"]);
        assert_eq!(s.sleep_kind("a"), None);

        s.add_asleep("gone", "S5", NOW);
        sent(&mut s);
        s.tend_sleep(&data(NOW + 70.0));
        assert_eq!(sent(&mut s), ["clear asleep.gone"]);
        s.add_asleep("gone", "S5", NOW);
        sent(&mut s);
        s.tend_sleep(&Data::default());
        assert!(sent(&mut s).is_empty(), "an empty frame closes nothing");
    }

    #[test]
    fn a_hibernate_with_no_answer_stops_reading_asleep() {
        let mut s = session();
        let d = data(NOW);
        park(&mut s, &d, "a");
        s.tend_sleep(&data(NOW + GOING_SECS + 1.0));
        assert_eq!(s.sleep_kind("a"), None);
    }

    #[test]
    fn a_running_agent_with_no_known_tab_is_named() {
        let mut s = session();
        let d = data_with(NOW, json!([{"id": "x", "status": "idle"}]));
        park(&mut s, &d, "a");
        assert_eq!(
            s.sleep_note("a"),
            Some("Didn't sleep: the cockpit can't find its tab")
        );
        assert_eq!(s.sleep_kind("a"), None);
    }

    #[test]
    fn moving_between_lanes_that_do_not_sleep_asks_nothing() {
        let mut s = session();
        let d = data(NOW);
        s.move_to_lane(&d, d.ws_by_id("a"), LaneKey::from("review"));
        let out = sent(&mut s);
        assert!(!out.iter().any(|o| o.starts_with("agent.")), "{out:?}");
    }

    #[test]
    fn reads_the_refusal_code_cmux_prints() {
        assert_eq!(
            refusal_code("Error: surface_not_found: No terminal matches that surface.\n"),
            "surface_not_found"
        );
        assert_eq!(
            refusal_code("warning\nError: recently_active: Try again in a few seconds."),
            RECENTLY_ACTIVE
        );
        assert_eq!(refusal_code(""), NOT_SENT);
        assert_eq!(refusal_code("Error: Something Odd: x"), NOT_SENT);
    }

    #[test]
    fn knows_a_sleep_call_by_its_method() {
        let call = CmuxCall {
            method: WAKE.into(),
            params: vec![
                ("surface_id".into(), Param::Str("S1".into())),
                ("workspace_id".into(), Param::Str("a".into())),
            ],
        };
        assert_eq!(sleep_call(&call), Some((true, "a".into(), "S1".into())));
        let other = CmuxCall {
            method: "workspace.select".into(),
            ..call
        };
        assert_eq!(sleep_call(&other), None);
    }

    #[test]
    fn every_refusal_reads_as_plain_words() {
        for code in [
            "surface_not_found",
            "not_restorable",
            "already_hibernated",
            "teardown_in_progress",
            "visible",
            "lifecycle_unknown",
            "agent_busy",
            "unconfirmed_input",
            "recently_active",
            "process_scope_unsafe",
            "not_running",
            "teardown_refused",
            "something_new",
            TIMED_OUT,
            NOT_SENT,
        ] {
            for wake in [false, true] {
                let note = refusal_note(wake, code);
                assert!(!note.contains('_'), "{note}");
            }
        }
    }
}
