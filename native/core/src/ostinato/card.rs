//! The Ostinato run as its workspace's card draws it (issue #390): every
//! word and colour token, worked out from where the record stands
//! (run.rs) at the frame's clock, so a view only lays them out.
//!
//! Three states. During a run: which issue of how many, the last stage
//! done and how long ago, the item and attempt, the five-step strip, and
//! the attempt's time and the day's spend, each against its cap when it
//! has one. After a run: when it ended, its drafts, parks, cost and
//! length, a row per item and the park's question. With no end line past
//! the attempt cap: "no end written", faint, with the last line's age. A
//! record that broke says at which line, under what came before it.

use serde::Serialize;

use super::RecordState;
use super::line::Outcome;
use super::run::{Attempt, Cost, Park, Phase, RunState, STRIP, Stage};
use crate::js::num_text;
use crate::panel::Piece;
use crate::theme::Token;
use crate::time::fmt_elapsed;

/// Before every title.
pub const RUN_WORD: &str = "Ostinato run";
/// The strip's steps as the card names them.
pub const STRIP_NAMES: [&str; 5] = ["Brief", "Built", "Reviewed", "QA", "Draft"];

/// One of the run's gauges: its label, its words, and how full its bar
/// is, None for no bar (no cap to measure against).
#[derive(Debug, Clone, PartialEq, Serialize, facet::Facet)]
pub struct Gauge {
    /// "Attempt", "Last 24h".
    pub label: String,
    /// "1h 12m of 3h", "$96.40 of $150", or the figure alone.
    pub text: String,
    /// 0 to 1.
    pub fraction: Option<f64>,
    pub fill: Token,
    pub track: Token,
    pub ink: Token,
}

/// The five-step strip: how many of its steps are done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct Strip {
    /// "Brief" to "Draft", under the steps.
    pub names: Vec<String>,
    /// How many, from the first, are filled.
    pub done: usize,
    pub fill: Token,
    pub track: Token,
    pub ink: Token,
}

/// A chip after a run: its words in `ink` on `face` inside `edge`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct RunChip {
    pub text: String,
    pub ink: Token,
    pub face: Token,
    pub edge: Token,
}

/// An item the run picked, and how its newest attempt came out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, facet::Facet)]
pub struct RunRow {
    /// Its key, "notes-app#41".
    pub item: String,
    /// "draft notes-app#57", "parked, needs a decision", "running".
    pub outcome: String,
    pub ink: Token,
}

/// An Ostinato run on its workspace's card.
#[derive(Debug, Clone, PartialEq, Serialize, facet::Facet)]
pub struct RunCard {
    /// "Ostinato run, issue 2 of 3", "Ostinato run ended", "Ostinato run,
    /// no end written", or with nothing read, "Ostinato record unreadable
    /// at line 1".
    pub title: String,
    /// When the run ended, in epoch seconds, after its `run_ended` line:
    /// the shell writes the local time after the title, "ended 14:40".
    pub ended_at: Option<f64>,
    /// The title's ink: faint for a run with no end written.
    pub title_ink: Token,
    /// The status dot: blue while it runs, faint with no end written,
    /// clear after a run.
    pub dot: Token,
    /// The status line: "Built" in blue and "12m ago"; "Last line 3h 20m
    /// ago". Empty after a run.
    pub status: Vec<Piece>,
    /// "app-one#2806, attempt 1" while it runs, else "".
    pub item: String,
    /// Where a tap on the item goes: its issue.
    pub url: Option<String>,
    /// While an attempt runs.
    pub strip: Option<Strip>,
    /// While it runs: the attempt's time, the day's spend.
    pub gauges: Vec<Gauge>,
    /// After a run: drafts, parks, cost, length.
    pub chips: Vec<RunChip>,
    /// After a run: one per item, in the order they were picked.
    pub rows: Vec<RunRow>,
    /// The newest park's question while a park waits on Jon, else "".
    pub question: String,
    /// The question's face.
    pub question_face: Token,
    /// "Ostinato record unreadable at line 14" when a line stopped the
    /// read and something came before it, else "".
    pub error: String,
    pub error_ink: Token,
}

/// "Ostinato record unreadable at line 14".
pub fn unreadable(line: usize) -> String {
    format!("Ostinato record unreadable at line {line}")
}

/// A stage as the card says it: "Built", "QA", a name outside the strip
/// with its first letter raised, "Criteria".
pub fn stage_word(stage: &Stage) -> String {
    match stage {
        Stage::Other(name) => sentence(name),
        known => STRIP
            .iter()
            .position(|s| s == known)
            .and_then(|i| STRIP_NAMES.get(i))
            .map_or_else(String::new, |n| (*n).to_string()),
    }
}

/// A code as words, its first letter raised: "end_of_day", "End of day".
fn sentence(code: &str) -> String {
    let words = code.replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Why an attempt parked, in words: "needs a decision".
pub fn reason_words(reason: &str) -> String {
    match reason {
        "needs_decision" => "needs a decision".to_string(),
        "permission_prompt" => "asked for a permission".to_string(),
        other => other.replace('_', " "),
    }
}

/// Dollars as the card says them, "$41.80".
fn dollars(usd: f64) -> String {
    format!("${usd:.2}")
}

/// A cap in dollars as written, "$150", "$12.5".
fn cap_dollars(usd: f64) -> String {
    format!("${}", num_text(usd))
}

/// "s" after a count other than one.
fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// The parks that still wait: each one whose item the run has not picked
/// again since, oldest first.
pub fn live_parks(run: &RunState) -> Vec<&Park> {
    run.parks
        .iter()
        .filter(|p| {
            !run.attempts
                .iter()
                .any(|a| a.item == p.item && a.started > p.at)
        })
        .collect()
}

/// The run's title while it runs: "Ostinato run, issue 2 of 3", "issue 2"
/// with no cap, the bare words before anything is picked.
fn running_title(run: &RunState) -> String {
    match (run.picked, run.caps.issues) {
        (0, _) => RUN_WORD.to_string(),
        (n, Some(m)) if m > 0.0 => format!("{RUN_WORD}, issue {n} of {}", num_text(m)),
        (n, _) => format!("{RUN_WORD}, issue {n}"),
    }
}

/// The last thing done and how long ago: the current attempt's newest
/// stage, else its pick, else the run's start.
fn running_status(run: &RunState, now: f64) -> Vec<Piece> {
    let ago = |at: f64| format!("{} ago", fmt_elapsed((now - at).max(0.0)));
    let (word, at) = match &run.current {
        Some(Attempt {
            last_stage: Some(mark),
            ..
        }) => (stage_word(&mark.stage), mark.at),
        Some(a) => ("Picked".to_string(), a.started),
        None => ("Started".to_string(), run.started.unwrap_or(now)),
    };
    vec![
        Piece {
            text: word,
            ink: Token::BlueText,
        },
        Piece {
            text: ago(at),
            ink: Token::MetaText,
        },
    ]
}

fn gauge(label: &str, text: String, fraction: Option<f64>) -> Gauge {
    Gauge {
        label: label.to_string(),
        text,
        fraction: fraction
            .filter(|f| f.is_finite())
            .map(|f| f.clamp(0.0, 1.0)),
        fill: Token::Secondary,
        track: Token::CountBg,
        ink: Token::MetaText,
    }
}

/// The attempt's time against the session cap, while one runs, and the
/// day's spend against the daily cap.
fn gauges(run: &RunState, now: f64) -> Vec<Gauge> {
    let mut out = Vec::new();
    if let Some(a) = run.current.as_ref().filter(|a| a.ended.is_none()) {
        let took = (now - a.started).max(0.0);
        let time = fmt_elapsed(took);
        out.push(match run.caps.session_hours.filter(|h| *h > 0.0) {
            Some(h) => gauge(
                "Attempt",
                format!("{time} of {}h", num_text(h)),
                Some(took / (h * 3600.0)),
            ),
            None => gauge("Attempt", time, None),
        });
    }
    let spend = spend_words(&run.spend_24h);
    out.push(match run.caps.spend_24h_usd.filter(|c| *c > 0.0) {
        Some(cap) => gauge(
            "Last 24h",
            format!("{spend} of {}", cap_dollars(cap)),
            Some(run.spend_24h.usd / cap),
        ),
        None => gauge("Last 24h", spend, None),
    });
    out
}

/// The day's spend: "$11.42", "or more" after it when an attempt in it
/// has no cost.
fn spend_words(cost: &Cost) -> String {
    if cost.unknown {
        format!("{} or more", dollars(cost.usd))
    } else {
        dollars(cost.usd)
    }
}

/// How an item's newest attempt came out, and its ink.
fn outcome_of(run: &RunState, a: &Attempt) -> (String, Token) {
    let parked = |reason: &str| (format!("parked, {}", reason_words(reason)), Token::ClayText);
    let park = run
        .parks
        .iter()
        .rev()
        .find(|p| p.item == a.item && p.at >= a.started);
    let draft = || {
        run.drafts
            .iter()
            .rev()
            .find(|d| d.item == a.item)
            .map_or_else(|| "draft".to_string(), |d| format!("draft {}", d.pr))
    };
    let Some(end) = &a.ended else {
        return match park {
            Some(p) => parked(&p.reason),
            None if run.phase == Phase::Running => ("running".to_string(), Token::MetaText),
            None => ("no end written".to_string(), Token::MetaText),
        };
    };
    match &end.outcome {
        Outcome::Draft => (draft(), Token::MetaText),
        Outcome::Parked => parked(park.map_or("", |p| p.reason.as_str())),
        Outcome::Stalled => ("stalled".to_string(), Token::MetaText),
        Outcome::Capped => ("stopped at its cap".to_string(), Token::MetaText),
        Outcome::Failed => ("failed".to_string(), Token::MetaText),
        Outcome::Cancelled => ("cancelled".to_string(), Token::MetaText),
        Outcome::Other(text) => (text.replace('_', " "), Token::MetaText),
    }
}

/// One row per item, in pick order, from its newest attempt.
fn rows(run: &RunState) -> Vec<RunRow> {
    let mut out: Vec<RunRow> = Vec::new();
    for (i, a) in run.attempts.iter().enumerate() {
        let later = run.attempts.get(i + 1..).unwrap_or_default();
        if later.iter().any(|b| b.item == a.item) {
            continue;
        }
        let (outcome, ink) = outcome_of(run, a);
        out.push(RunRow {
            item: a.item.clone(),
            outcome,
            ink,
        });
    }
    // Pick order: by each item's first attempt.
    let first = |item: &str| run.attempts.iter().position(|a| a.item == item);
    out.sort_by_key(|r| first(&r.item));
    out
}

fn chip(text: String, ink: Token) -> RunChip {
    RunChip {
        text,
        ink,
        face: Token::ChipFace,
        edge: Token::ChipEdge,
    }
}

/// After a run: its drafts, its parks, what it cost and how long it ran.
fn chips(run: &RunState, rows: &[RunRow]) -> Vec<RunChip> {
    let count = |lead: &str| rows.iter().filter(|r| r.outcome.starts_with(lead)).count();
    let mut out = Vec::new();
    let drafts = count("draft");
    if drafts > 0 {
        out.push(chip(plural(drafts, "draft"), Token::MergeText));
    }
    let parked = count("parked");
    if parked > 0 {
        out.push(RunChip {
            face: Token::ClayChipFace,
            edge: Token::ClayChipEdge,
            ..chip(format!("{parked} parked"), Token::ClayText)
        });
    }
    let cost = if run.cost.unknown {
        "cost unknown".to_string()
    } else {
        dollars(run.cost.usd)
    };
    out.push(chip(cost, Token::Secondary));
    if let Some(length) = run.length {
        out.push(chip(fmt_elapsed(length.max(0.0)), Token::Secondary));
    }
    out
}

/// A card with no words yet, in its resting tokens.
fn blank(title: String) -> RunCard {
    RunCard {
        title,
        ended_at: None,
        title_ink: Token::Text,
        dot: Token::Clear,
        status: Vec::new(),
        item: String::new(),
        url: None,
        strip: None,
        gauges: Vec::new(),
        chips: Vec::new(),
        rows: Vec::new(),
        question: String::new(),
        question_face: Token::ClayWash,
        error: String::new(),
        error_ink: Token::ClayText,
    }
}

/// The card while the run runs.
fn running(run: &RunState, now: f64) -> RunCard {
    let current = run.current.as_ref();
    let open = current.filter(|a| a.ended.is_none());
    RunCard {
        dot: Token::Blue,
        status: running_status(run, now),
        item: current.map_or_else(String::new, |a| {
            format!("{}, attempt {}", a.item, a.attempt)
        }),
        url: current.and_then(|a| a.url.clone()),
        strip: open.map(|a| Strip {
            names: STRIP_NAMES.iter().map(|n| (*n).to_string()).collect(),
            done: a.steps,
            fill: Token::Blue,
            track: Token::CountBg,
            ink: Token::MetaText,
        }),
        gauges: gauges(run, now),
        ..blank(running_title(run))
    }
}

/// The card after the run's `run_ended` line.
fn ended(run: &RunState, at: f64) -> RunCard {
    let rows = rows(run);
    RunCard {
        ended_at: Some(at),
        chips: chips(run, &rows),
        rows,
        ..blank(format!("{RUN_WORD} ended"))
    }
}

/// The card of a run with no end line, past its attempt cap.
fn silent(at: f64, now: f64) -> RunCard {
    RunCard {
        title_ink: Token::Faint,
        dot: Token::Faint,
        status: vec![Piece {
            text: format!("Last line {} ago", fmt_elapsed((now - at).max(0.0))),
            ink: Token::MetaText,
        }],
        ..blank(format!("{RUN_WORD}, no end written"))
    }
}

/// The card for a record as it stands at epoch `now`; None when it has
/// nothing to say (no line read and no error).
pub fn run_card(state: &RecordState, now: f64) -> Option<RunCard> {
    let error = state.error.as_ref().map(|e| unreadable(e.line));
    let Some(run) = &state.run else {
        return error.map(|e| RunCard {
            title_ink: Token::Faint,
            ..blank(e)
        });
    };
    let mut card = match run.phase {
        Phase::Running => running(run, now),
        Phase::Ended { at, silent: false } => ended(run, at),
        Phase::Ended { at, silent: true } => silent(at, now),
    };
    if let Some(p) = live_parks(run).last() {
        card.question = p.question.clone();
    }
    card.error = error.unwrap_or_default();
    Some(card)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ostinato::Record;
    use crate::ostinato::line::RecordText;
    use crate::time::iso_epoch;

    const ONE_ISSUE: &str = include_str!("../../../../test/golden/ostinato/one-issue.jsonl");
    const PARKED: &str = include_str!("../../../../test/golden/ostinato/parked-then-picked.jsonl");
    const TEAM: &str = include_str!("../../../../test/golden/ostinato/standing-team.jsonl");
    const TORN: &str = include_str!("../../../../test/golden/ostinato/torn-last-line.jsonl");

    fn at(s: &str) -> f64 {
        iso_epoch(s).unwrap()
    }

    fn card(text: &str, now: &str) -> RunCard {
        let r = Record::read("example/x", RecordText::from_bytes(text.as_bytes()));
        run_card(&r.state(at(now)), at(now)).unwrap()
    }

    fn first(text: &str, n: usize) -> String {
        text.lines().take(n).collect::<Vec<_>>().join("\n")
    }

    fn words(pieces: &[Piece]) -> Vec<&str> {
        pieces.iter().map(|p| p.text.as_str()).collect()
    }

    #[test]
    fn during_a_run_it_says_the_issue_stage_strip_and_gauges() {
        let c = card(&first(ONE_ISSUE, 4), "2026-11-13T14:36:38Z");
        assert_eq!(c.title, "Ostinato run, issue 1 of 3");
        assert_eq!(words(&c.status), ["Built", "12m ago"]);
        assert_eq!(c.status[0].ink, Token::BlueText);
        assert_eq!(c.dot, Token::Blue);
        assert_eq!(c.item, "app-one#2806, attempt 1");
        assert_eq!(
            c.url.as_deref(),
            Some("https://github.com/example/app-one/issues/2806")
        );
        let strip = c.strip.unwrap();
        assert_eq!(strip.done, 2);
        assert_eq!(strip.names, ["Brief", "Built", "Reviewed", "QA", "Draft"]);
        let g: Vec<(&str, &str)> = c
            .gauges
            .iter()
            .map(|g| (g.label.as_str(), g.text.as_str()))
            .collect();
        assert_eq!(g, [("Attempt", "13m of 3h"), ("Last 24h", "$0.00 of $150")]);
        let f = c.gauges[0].fraction.unwrap();
        assert!((f - 831.0 / 10800.0).abs() < 1e-9, "{f}");
        assert!(c.chips.is_empty() && c.rows.is_empty() && c.ended_at.is_none());
    }

    #[test]
    fn with_no_caps_the_gauges_give_figures_alone_and_no_bars() {
        // The team's run has no issues, hours or spend cap.
        let c = card(&first(TEAM, 9), "2026-11-11T10:06:00Z");
        assert_eq!(c.title, "Ostinato run, issue 2");
        let bars: Vec<Option<f64>> = c.gauges.iter().map(|g| g.fraction).collect();
        assert_eq!(bars, [None, None]);
        assert_eq!(c.gauges[0].text, "1h 1m", "#102, picked at 09:05");
        // A stage outside the strip is its name; the strip keeps its steps.
        let c = card(&first(TEAM, 4), "2026-11-11T09:04:30Z");
        assert_eq!(words(&c.status), ["Criteria", "30s ago"]);
        assert_eq!(c.strip.map(|s| s.done), Some(0));
    }

    #[test]
    fn after_a_run_it_shows_chips_rows_and_ended_time() {
        let c = card(TEAM, "2026-11-11T19:00:00Z");
        assert_eq!(c.title, "Ostinato run ended");
        assert_eq!(c.ended_at, Some(at("2026-11-11T18:00:00Z")));
        assert_eq!(c.dot, Token::Clear);
        let chips: Vec<&str> = c.chips.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(chips, ["3 drafts", "$54.25", "9h 0m"]);
        let rows: Vec<(&str, &str)> = c
            .rows
            .iter()
            .map(|r| (r.item.as_str(), r.outcome.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("inbox-demo#101", "draft inbox-demo#110"),
                ("inbox-demo#102", "draft inbox-demo#112"),
                ("inbox-demo#103", "draft inbox-demo#111"),
            ],
            "#102 parked, then drafted: its newest attempt"
        );
        assert_eq!(c.question, "", "the park was picked again");
        assert!(c.strip.is_none() && c.gauges.is_empty());
    }

    #[test]
    fn a_park_shows_its_reason_chip_and_question() {
        let first_run = first(PARKED, 5);
        let ended = format!(
            "{first_run}\n{}",
            r#"{"v":1,"at":"2026-11-10T09:40:00Z","run":"r-1110","event":"run_ended"}"#
        );
        let c = card(&ended, "2026-11-10T10:00:00Z");
        let chips: Vec<(&str, Token)> = c.chips.iter().map(|c| (c.text.as_str(), c.face)).collect();
        assert_eq!(
            chips,
            [
                ("1 parked", Token::ClayChipFace),
                ("$6.10", Token::ChipFace),
                ("40m", Token::ChipFace)
            ]
        );
        assert_eq!(c.rows[0].outcome, "parked, asked for a permission");
        assert_eq!(c.rows[0].ink, Token::ClayText);
        assert!(c.question.starts_with("May the session run"));
        // Mid run the question shows too.
        let c = card(&first_run, "2026-11-10T09:32:00Z");
        assert!(c.question.starts_with("May the session run"));
    }

    #[test]
    fn a_missing_cost_reads_cost_unknown() {
        let unpriced = ONE_ISSUE.replace(r#""cost_usd":11.42,"#, "");
        let c = card(&unpriced, "2026-11-13T15:00:00Z");
        assert!(c.chips.iter().any(|c| c.text == "cost unknown"));
        let c = card(&first(&unpriced, 8), "2026-11-13T14:40:05Z");
        assert_eq!(c.gauges.last().unwrap().text, "$11.42 or more of $150");
    }

    #[test]
    fn with_no_end_past_the_cap_it_reads_faint() {
        let c = card(TORN, "2026-11-12T13:30:00Z");
        assert_eq!(c.title, "Ostinato run, no end written");
        assert_eq!((c.title_ink, c.dot), (Token::Faint, Token::Faint));
        assert_eq!(words(&c.status), ["Last line 3h 20m ago"]);
        assert!(c.strip.is_none() && c.gauges.is_empty() && c.chips.is_empty());
    }

    #[test]
    fn a_broken_line_is_named_under_what_came_before() {
        let mut lines: Vec<&str> = ONE_ISSUE.lines().collect();
        lines.insert(4, "not json");
        let c = card(&lines.join("\n"), "2026-11-13T14:40:00Z");
        assert_eq!(c.error, "Ostinato record unreadable at line 5");
        assert_eq!(c.title, "Ostinato run, issue 1 of 3");
        let c = card("not json\n", "2026-11-13T14:40:00Z");
        assert_eq!(c.title, "Ostinato record unreadable at line 1");
        assert_eq!(c.error, "");
    }

    #[test]
    fn words_for_stages_and_reasons() {
        assert_eq!(stage_word(&Stage::Qa), "QA");
        assert_eq!(stage_word(&Stage::Other("end_of_day".into())), "End of day");
        assert_eq!(stage_word(&Stage::Other(String::new())), "");
        assert_eq!(reason_words("needs_decision"), "needs a decision");
        assert_eq!(reason_words("rate_limited"), "rate limited");
        assert_eq!(plural(1, "draft"), "1 draft");
        assert_eq!(cap_dollars(12.5), "$12.5");
    }
}
