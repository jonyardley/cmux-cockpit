//! One run record's lines, version 1, read with the core's own types
//! (docs/record-format.md in jonyardley/ostinato, its reading rules
//! table being the contract):
//!
//! - a torn line, an unknown event or a `v` above 1 is skipped, though
//!   an unknown event's time still counts as its run being heard from;
//! - an outcome this version does not know is kept as text;
//! - a field the format does not name is tolerated, and a session named
//!   twice or costs that do not add up are kept as they are;
//! - anything else that breaks the format stops the read with an error
//!   naming the line (`RecordError`), keeping every line read before it.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;
use serde_json::Value;

use crate::time::iso_epoch;

/// A record's text as the runner read it from disk: the file as UTF-8,
/// with the numbers (from 1) of any line that was not, which is an
/// error on that line, and of any line cut in the middle of a character
/// at its end. Built by `RecordText::from_bytes`, so the runner and the
/// reader number lines the same way.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, Deserialize)]
pub struct RecordText {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_utf8: Vec<usize>,
    /// Lines whose last bytes were the start of a character and nothing
    /// more, kept without them: torn when what comes before stops in the
    /// middle of a JSON value, else not UTF-8.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cut: Vec<usize>,
}

impl RecordText {
    /// The file's bytes as text. A line cut in the middle of a character
    /// at its end, as a torn last line can be, keeps what comes before
    /// the cut, and its number is noted in `cut`. A line with a byte that
    /// is not UTF-8 anywhere else is kept with the byte replaced, and its
    /// number noted in `not_utf8`.
    pub fn from_bytes(bytes: &[u8]) -> RecordText {
        let mut text = String::with_capacity(bytes.len());
        let mut not_utf8 = Vec::new();
        let mut cut = Vec::new();
        for (i, part) in bytes.split(|b| *b == b'\n').enumerate() {
            if i > 0 {
                text.push('\n');
            }
            match std::str::from_utf8(part) {
                Ok(s) => text.push_str(s),
                Err(e) if e.error_len().is_none() => {
                    let good = part.get(..e.valid_up_to()).unwrap_or_default();
                    text.push_str(&String::from_utf8_lossy(good));
                    cut.push(i + 1);
                }
                Err(_) => {
                    text.push_str(&String::from_utf8_lossy(part));
                    not_utf8.push(i + 1);
                }
            }
        }
        RecordText {
            text,
            not_utf8,
            cut,
        }
    }
}

/// How a line breaks the format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Broken {
    /// A byte that is not UTF-8.
    NotUtf8,
    /// An empty line, or one of nothing but spaces.
    Empty,
    /// Not JSON, with serde's words for why.
    NotJson(String),
    /// Whole JSON, but not an object.
    NotObject,
    /// `v` missing, or not a whole number from 1.
    Version,
    /// `event` missing, or not text.
    Event,
    /// `at` missing, or not a UTC time.
    At,
    /// `run` missing, empty, or not text.
    Run,
    /// One of the event's own fields: what is wrong with it.
    Field(String),
}

impl fmt::Display for Broken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Broken::NotUtf8 => f.write_str("not UTF-8"),
            Broken::Empty => f.write_str("an empty line"),
            Broken::NotJson(why) => write!(f, "not JSON: {why}"),
            Broken::NotObject => f.write_str("not a JSON object"),
            Broken::Version => f.write_str("`v` is not a whole number from 1"),
            Broken::Event => f.write_str("`event` is not text"),
            Broken::At => f.write_str("`at` is not a UTC time"),
            Broken::Run => f.write_str("`run` is not text, or is empty"),
            Broken::Field(why) => f.write_str(why),
        }
    }
}

/// The line, numbered from 1, that stopped a record's read, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordError {
    pub line: usize,
    pub broken: Broken,
}

impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.broken)
    }
}

/// How an attempt ended. A newer loop may write an outcome this version
/// does not know: it is kept as its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Draft,
    Parked,
    Stalled,
    Capped,
    Failed,
    Cancelled,
    Other(String),
}

impl Outcome {
    fn of(text: &str) -> Outcome {
        match text {
            "draft" => Outcome::Draft,
            "parked" => Outcome::Parked,
            "stalled" => Outcome::Stalled,
            "capped" => Outcome::Capped,
            "failed" => Outcome::Failed,
            "cancelled" => Outcome::Cancelled,
            other => Outcome::Other(other.to_string()),
        }
    }
}

/// What a line says happened, by event.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    RunStarted {
        project: String,
        /// The run's caps by name, each a number zero or more.
        caps: BTreeMap<String, f64>,
    },
    Picked {
        item: String,
        url: Option<String>,
        attempt: u32,
    },
    Stage {
        item: String,
        stage: String,
        attempt: Option<u32>,
        sessions: Vec<String>,
    },
    Draft {
        item: String,
        pr: String,
        attempt: Option<u32>,
    },
    Parked {
        item: String,
        reason: String,
        question: String,
        attempt: Option<u32>,
    },
    AttemptEnded {
        item: String,
        outcome: Outcome,
        cost_usd: Option<f64>,
        attempt: Option<u32>,
        sessions: Vec<String>,
        /// Each session's running total, by session id; None when the
        /// line has none.
        session_costs: Option<BTreeMap<String, f64>>,
    },
    RunEnded {
        attempts: Option<u64>,
    },
}

/// One line the reader kept.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    /// Its number in the file, from 1.
    pub number: usize,
    /// When it happened, in epoch seconds.
    pub at: f64,
    pub run: String,
    pub event: Event,
}

/// A line of an event this version does not know: skipped, but its run
/// was heard from at its time.
#[derive(Debug, Clone, PartialEq)]
pub struct Heard {
    pub at: f64,
    pub run: String,
}

/// A record as read: every line kept, in file order, each unknown event
/// heard, and the error that stopped the read, if one did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Read {
    pub lines: Vec<Line>,
    pub heard: Vec<Heard>,
    pub error: Option<RecordError>,
}

/// What one line gave the reader.
enum Got {
    Line(f64, String, Event),
    /// An unknown event whose `at` and `run` read.
    Heard(f64, String),
    /// A torn line, a newer version, or an unknown event whose `at` or
    /// `run` did not read.
    Skipped,
}

/// Whether a line stops in the middle of a JSON value: a writer did not
/// finish it.
fn is_torn(raw: &str) -> bool {
    !raw.trim_matches(json_space).is_empty()
        && serde_json::from_str::<Value>(raw).is_err_and(|e| e.is_eof())
}

/// Reads a record's text, as `RecordText::from_bytes` made it.
pub fn read(record: &RecordText) -> Read {
    let mut out = Read::default();
    // The text after the last newline is a line only when it is not empty.
    for (i, raw) in record.text.split_terminator('\n').enumerate() {
        let number = i + 1;
        let got = if record.not_utf8.contains(&number) {
            Err(Broken::NotUtf8)
        } else if record.cut.contains(&number) {
            // Cut mid character: torn only when what is left is unfinished.
            if is_torn(raw) {
                Ok(Got::Skipped)
            } else {
                Err(Broken::NotUtf8)
            }
        } else {
            read_line(raw)
        };
        match got {
            Ok(Got::Line(at, run, event)) => out.lines.push(Line {
                number,
                at,
                run,
                event,
            }),
            Ok(Got::Heard(at, run)) => out.heard.push(Heard { at, run }),
            Ok(Got::Skipped) => {}
            Err(broken) => {
                out.error = Some(RecordError {
                    line: number,
                    broken,
                });
                return out;
            }
        }
    }
    out
}

/// JSON's own whitespace, which is all a line may hold around its object.
fn json_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r')
}

/// One line: its time, run and event; for an unknown event, its time and
/// run when they read; else skipped (torn, a newer version).
fn read_line(raw: &str) -> Result<Got, Broken> {
    if raw.trim_matches(json_space).is_empty() {
        return Err(Broken::Empty);
    }
    let value: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        // It stops in the middle of a JSON value: a writer did not finish it.
        Err(e) if e.is_eof() => return Ok(Got::Skipped),
        Err(e) => return Err(Broken::NotJson(e.to_string())),
    };
    if !value.is_object() {
        return Err(Broken::NotObject);
    }
    let map = &value;
    match map.get("v").and_then(Value::as_u64) {
        Some(1) => {}
        Some(v) if v > 1 => return Ok(Got::Skipped),
        _ => return Err(Broken::Version),
    }
    let Some(name) = map.get("event").and_then(Value::as_str) else {
        return Err(Broken::Event);
    };
    let at = map.get("at").and_then(Value::as_str).and_then(iso_epoch);
    let run = map
        .get("run")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty());
    if !KNOWN.contains(&name) {
        // Skipped either way, never an error: only its time is used.
        return Ok(match (at, run) {
            (Some(at), Some(run)) => Got::Heard(at, run.to_string()),
            _ => Got::Skipped,
        });
    }
    let at = at.ok_or(Broken::At)?;
    let run = run.ok_or(Broken::Run)?;
    let event = event_of(name, map)?;
    Ok(Got::Line(at, run.to_string(), event))
}

const KNOWN: [&str; 7] = [
    "run_started",
    "picked",
    "stage",
    "draft",
    "parked",
    "attempt_ended",
    "run_ended",
];

#[derive(Deserialize)]
struct RunStartedLine {
    project: String,
    #[serde(default)]
    caps: BTreeMap<String, f64>,
}

#[derive(Deserialize)]
struct PickedLine {
    item: String,
    url: Option<String>,
    attempt: u32,
}

#[derive(Deserialize)]
struct StageLine {
    item: String,
    #[serde(rename = "url")]
    _url: Option<String>,
    stage: String,
    attempt: Option<u32>,
    #[serde(default)]
    sessions: Vec<String>,
}

#[derive(Deserialize)]
struct DraftLine {
    item: String,
    #[serde(rename = "url")]
    _url: Option<String>,
    pr: String,
    attempt: Option<u32>,
    #[serde(default)]
    sessions: Vec<String>,
}

#[derive(Deserialize)]
struct ParkedLine {
    item: String,
    #[serde(rename = "url")]
    _url: Option<String>,
    reason: String,
    question: String,
    attempt: Option<u32>,
    #[serde(default)]
    sessions: Vec<String>,
}

#[derive(Deserialize)]
struct AttemptEndedLine {
    item: String,
    #[serde(rename = "url")]
    _url: Option<String>,
    outcome: String,
    cost_usd: Option<f64>,
    attempt: Option<u32>,
    #[serde(default)]
    sessions: Vec<String>,
    session_costs: Option<BTreeMap<String, f64>>,
}

#[derive(Deserialize)]
struct RunEndedLine {
    attempts: Option<u64>,
}

/// The line's fields as `T`; serde's words when they are not.
fn fields<'a, T: Deserialize<'a>>(line: &'a Value) -> Result<T, Broken> {
    T::deserialize(line).map_err(|e| Broken::Field(e.to_string()))
}

/// Fails with `why` unless `ok`.
fn check(ok: bool, why: &str) -> Result<(), Broken> {
    if ok {
        Ok(())
    } else {
        Err(Broken::Field(why.to_string()))
    }
}

/// An owner, repo or key side: letters, digits, dots, dashes and
/// underscores, not empty.
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// An item or pull request key: `repo#id`.
fn is_key(s: &str) -> bool {
    s.split_once('#')
        .is_some_and(|(repo, id)| is_name(repo) && is_name(id))
}

/// A project: `owner/repo`, neither `.` nor `..`.
pub(crate) fn is_project(s: &str) -> bool {
    let named = |p: &str| is_name(p) && p != "." && p != "..";
    s.split_once('/')
        .is_some_and(|(owner, repo)| named(owner) && named(repo))
}

/// A reason code: lower case letters, digits, underscores and dashes.
fn is_code(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

fn check_item(item: &str) -> Result<(), Broken> {
    check(is_key(item), "`item` is not a key such as repo#12")
}

fn check_attempt(attempt: Option<u32>) -> Result<(), Broken> {
    check(
        attempt.is_none_or(|a| a >= 1),
        "`attempt` is not a whole number from 1",
    )
}

fn check_sessions(sessions: &[String]) -> Result<(), Broken> {
    check(
        sessions
            .iter()
            .all(|s| !s.is_empty() && !s.chars().any(char::is_whitespace)),
        "a session id is empty or has a space in it",
    )
}

fn non_negative(n: f64) -> bool {
    n.is_finite() && n >= 0.0
}

fn event_of(name: &str, map: &Value) -> Result<Event, Broken> {
    match name {
        "run_started" => {
            let l: RunStartedLine = fields(map)?;
            check(is_project(&l.project), "`project` is not owner/repo")?;
            check(
                l.caps.values().all(|c| non_negative(*c)),
                "a cap is below zero",
            )?;
            Ok(Event::RunStarted {
                project: l.project,
                caps: l.caps,
            })
        }
        "picked" => {
            let l: PickedLine = fields(map)?;
            check_item(&l.item)?;
            check_attempt(Some(l.attempt))?;
            Ok(Event::Picked {
                item: l.item,
                url: l.url,
                attempt: l.attempt,
            })
        }
        "stage" => {
            let l: StageLine = fields(map)?;
            check_item(&l.item)?;
            check(!l.stage.is_empty(), "`stage` is empty")?;
            check_attempt(l.attempt)?;
            check_sessions(&l.sessions)?;
            Ok(Event::Stage {
                item: l.item,
                stage: l.stage,
                attempt: l.attempt,
                sessions: l.sessions,
            })
        }
        "draft" => {
            let l: DraftLine = fields(map)?;
            check_item(&l.item)?;
            check(is_key(&l.pr), "`pr` is not a key such as repo#12")?;
            check_attempt(l.attempt)?;
            check_sessions(&l.sessions)?;
            Ok(Event::Draft {
                item: l.item,
                pr: l.pr,
                attempt: l.attempt,
            })
        }
        "parked" => {
            let l: ParkedLine = fields(map)?;
            check_item(&l.item)?;
            check(is_code(&l.reason), "`reason` is not a code")?;
            check(!l.question.is_empty(), "`question` is empty")?;
            check_attempt(l.attempt)?;
            check_sessions(&l.sessions)?;
            Ok(Event::Parked {
                item: l.item,
                reason: l.reason,
                question: l.question,
                attempt: l.attempt,
            })
        }
        "attempt_ended" => {
            let l: AttemptEndedLine = fields(map)?;
            check_item(&l.item)?;
            check(!l.outcome.is_empty(), "`outcome` is empty")?;
            check(
                l.cost_usd.is_none_or(non_negative),
                "`cost_usd` is below zero",
            )?;
            check_attempt(l.attempt)?;
            check_sessions(&l.sessions)?;
            Ok(Event::AttemptEnded {
                item: l.item,
                outcome: Outcome::of(&l.outcome),
                cost_usd: l.cost_usd,
                attempt: l.attempt,
                sessions: l.sessions,
                session_costs: l.session_costs,
            })
        }
        _ => {
            let l: RunEndedLine = fields(map)?;
            Ok(Event::RunEnded {
                attempts: l.attempts,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> RecordText {
        RecordText {
            text: s.to_string(),
            ..RecordText::default()
        }
    }

    const STARTED: &str = r#"{"v":1,"at":"2026-11-13T14:22:30Z","run":"r-1","event":"run_started","project":"example/app-one"}"#;
    const PICKED: &str = r#"{"v":1,"at":"2026-11-13T14:22:47Z","run":"r-1","event":"picked","item":"app-one#1","attempt":1}"#;

    fn lines(rows: &[&str]) -> RecordText {
        text(&format!("{}\n", rows.join("\n")))
    }

    #[test]
    fn reads_every_event_and_its_fields() {
        let r = read(&lines(&[
            STARTED,
            PICKED,
            r#"{"v":1,"at":"2026-11-13T14:23:00.5Z","run":"r-1","event":"stage","item":"app-one#1","stage":"brief","sessions":["s1"]}"#,
            r#"{"v":1,"at":"2026-11-13T14:24:00Z","run":"r-1","event":"attempt_ended","item":"app-one#1","outcome":"draft","cost_usd":2.5,"attempt":1,"session_costs":{"s1":2.5}}"#,
            r#"{"v":1,"at":"2026-11-13T14:25:00Z","run":"r-1","event":"run_ended"}"#,
        ]));
        assert_eq!(r.error, None);
        assert_eq!(r.lines.len(), 5);
        assert_eq!(r.lines[2].number, 3);
        assert!((r.lines[2].at - r.lines[1].at - 13.5).abs() < 1e-6);
        assert_eq!(
            r.lines[3].event,
            Event::AttemptEnded {
                item: "app-one#1".into(),
                outcome: Outcome::Draft,
                cost_usd: Some(2.5),
                attempt: Some(1),
                sessions: Vec::new(),
                session_costs: Some(BTreeMap::from([("s1".to_string(), 2.5)])),
            }
        );
        assert_eq!(r.lines[4].event, Event::RunEnded { attempts: None });
    }

    #[test]
    fn skips_torn_lines_unknown_events_and_newer_versions_wherever_they_are() {
        let r = lines(&[
            STARTED,
            r#"{"v":1,"at":"2026-11-13T14:22:40Z","run":"r-1","event":"pic"#,
            r#"{"v":1,"at":"2026-11-13T14:22:41Z","run":"r-1","event":"board_synced","tickets":"x"}"#,
            r#"{"v":2,"run":"r-1","event":"picked","item":7}"#,
            r#"{"v":1,"at":"2026-11-13T14:22:42Z","run":"r-1","event":"attempt_ended","item":"app-one#1","outcome":"abandoned","seat":"dev"}"#,
            PICKED,
        ]);
        let r = read(&r);
        assert_eq!(r.error, None);
        let numbers: Vec<usize> = r.lines.iter().map(|l| l.number).collect();
        assert_eq!(numbers, [1, 5, 6]);
        // The unknown event is heard from; the torn and newer lines are not.
        assert_eq!(
            r.heard,
            [Heard {
                at: iso_epoch("2026-11-13T14:22:41Z").unwrap(),
                run: "r-1".into()
            }]
        );
        let Event::AttemptEnded { outcome, .. } = &r.lines[1].event else {
            panic!("an attempt_ended line");
        };
        assert_eq!(outcome, &Outcome::Other("abandoned".into()));
    }

    #[test]
    fn a_line_cut_mid_character_is_torn_and_a_bad_byte_elsewhere_is_named() {
        let mut bytes = format!("{STARTED}\n").into_bytes();
        bytes.extend_from_slice(
            br#"{"v":1,"at":"2026-11-13T14:22:47Z","run":"r-1","event":"picked","item":"caf"#,
        );
        bytes.extend_from_slice(&[0xC3]);
        let torn = RecordText::from_bytes(&bytes);
        assert!(torn.not_utf8.is_empty());
        let r = read(&torn);
        assert_eq!((r.lines.len(), r.error), (1, None));

        // A whole object with a lone lead byte after it is no torn line,
        // in the middle of the file or at its end.
        for end in [&b"\n"[..], &b""[..]] {
            let mut bytes = format!("{STARTED}\n{PICKED}").into_bytes();
            bytes.push(0xE2);
            bytes.extend_from_slice(end);
            let r = read(&RecordText::from_bytes(&bytes));
            assert_eq!(r.lines.len(), 1);
            assert_eq!(
                r.error.map(|e| (e.line, e.broken)),
                Some((2, Broken::NotUtf8))
            );
        }

        let mut bytes = format!("{STARTED}\n").into_bytes();
        bytes.extend_from_slice(
            br#"{"v":1,"at":"2026-11-13T14:22:47Z","run":"r-1","event":"picked","item":"a"#,
        );
        bytes.extend_from_slice(&[0xFF]);
        bytes.extend_from_slice(b"#1\",\"attempt\":1}\n");
        let bad = RecordText::from_bytes(&bytes);
        assert_eq!(bad.not_utf8, [2]);
        let r = read(&bad);
        assert_eq!(r.lines.len(), 1);
        assert_eq!(
            r.error,
            Some(RecordError {
                line: 2,
                broken: Broken::NotUtf8
            })
        );
    }

    #[test]
    fn a_broken_line_stops_the_read_naming_it_and_keeps_what_came_before() {
        let cases = [
            ("", Broken::Empty),
            ("  ", Broken::Empty),
            ("{} {}", Broken::NotJson(String::new())),
            ("[1]", Broken::NotObject),
            (r#"{"at":"2026-11-13T14:22:47Z"}"#, Broken::Version),
            (r#"{"v":0,"event":"picked"}"#, Broken::Version),
            (r#"{"v":1.5,"event":"picked"}"#, Broken::Version),
            (r#"{"v":1,"event":3}"#, Broken::Event),
            (
                r#"{"v":1,"at":"2026-11-13 14:22","run":"r-1","event":"run_ended"}"#,
                Broken::At,
            ),
            (
                r#"{"v":1,"at":"2026-11-13T14:22:47Z","run":"","event":"run_ended"}"#,
                Broken::Run,
            ),
        ];
        for (line, want) in cases {
            let r = read(&lines(&[STARTED, line, PICKED]));
            assert_eq!(r.lines.len(), 1, "{line}");
            let error = r.error.unwrap();
            assert_eq!(error.line, 2, "{line}");
            match (&error.broken, &want) {
                (Broken::NotJson(_), Broken::NotJson(_)) => {}
                (got, want) => assert_eq!(got, want, "{line}"),
            }
        }
    }

    #[test]
    fn a_known_event_with_a_missing_or_wrong_field_is_named() {
        let head = r#"{"v":1,"at":"2026-11-13T14:22:47Z","run":"r-1","#;
        for rest in [
            r#""event":"run_started"}"#,
            r#""event":"run_started","project":"a/.."}"#,
            r#""event":"run_started","project":"a/b","caps":{"issues":-1}}"#,
            r#""event":"picked","item":"app-one#1"}"#,
            r#""event":"picked","item":"app-one#1","attempt":0}"#,
            r#""event":"picked","item":"app-one#1","attempt":1.5}"#,
            r#""event":"picked","item":"app one#1","attempt":1}"#,
            r#""event":"stage","item":"app-one#1"}"#,
            r#""event":"stage","item":"app-one#1","stage":""}"#,
            r#""event":"stage","item":"app-one#1","stage":"qa","sessions":["a b"]}"#,
            r#""event":"draft","item":"app-one#1","pr":"12"}"#,
            r#""event":"parked","item":"app-one#1","reason":"Needs","question":"?"}"#,
            r#""event":"parked","item":"app-one#1","reason":"silence","question":""}"#,
            r#""event":"attempt_ended","item":"app-one#1"}"#,
            r#""event":"attempt_ended","item":"app-one#1","outcome":"draft","cost_usd":-2}"#,
            r#""event":"attempt_ended","item":"app-one#1","outcome":"draft","session_costs":{"s":"1"}}"#,
            r#""event":"run_ended","attempts":"2"}"#,
        ] {
            let line = format!("{head}{rest}");
            let r = read(&lines(&[STARTED, &line]));
            let error = r.error.unwrap();
            assert_eq!(error.line, 2, "{line}");
            assert!(matches!(error.broken, Broken::Field(_)), "{line}");
            assert_eq!(r.lines.len(), 1);
        }
    }

    #[test]
    fn keeps_extra_fields_twice_named_sessions_and_costs_that_do_not_add_up() {
        let r = read(&lines(&[
            r#"{"v":1,"at":"2026-11-13T14:22:30Z","run":"r-1","event":"run_started","project":"example/app-one","shape":"team","caps":{"issues":3,"tickets_at_once":2}}"#,
            r#"{"v":1,"at":"2026-11-13T14:24:00Z","run":"r-1","event":"attempt_ended","item":"app-one#1","outcome":"draft","cost_usd":9,"sessions":["s1","s1"],"session_costs":{"s2":1}}"#,
        ]));
        assert_eq!((r.lines.len(), r.error), (2, None));
    }

    #[test]
    fn names_its_error_in_words() {
        let e = RecordError {
            line: 4,
            broken: Broken::Field("missing field `stage`".into()),
        };
        assert_eq!(e.to_string(), "line 4: missing field `stage`");
        assert_eq!(
            RecordError {
                line: 1,
                broken: Broken::Empty
            }
            .to_string(),
            "line 1: an empty line"
        );
    }
}
