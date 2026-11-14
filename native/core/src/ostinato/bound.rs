//! What of a record the runner publishes (issue #390, option a): only the
//! lines its card reads, not the whole file, as records only grow and
//! data.json is written several times a minute. That is the latest run,
//! from its `run_started` to the end or the line that stopped the read,
//! with the run's own unknown events from before it, plus what the day's
//! spend needs from older runs: their `attempt_ended` lines of the last
//! 24 hours, and before those, each session's latest earlier figure, the
//! base its next share is worked out from (run.rs `shares`).
//!
//! Each kept line keeps its number in the file (`RecordText::numbers`),
//! so an error still names the line Jon would open.
//!
//! The day is cut `MARGIN_SECS` early, so a frame clock a little behind
//! the runner's still reads the same spend: a reading at or after
//! `now - MARGIN_SECS` gives the same state as the whole file.

use std::collections::{BTreeMap, BTreeSet};

use super::line::{Event, Line, RecordText, read};
use super::run::DAY_SECS;

/// How far before the day's start older `attempt_ended` lines are kept.
pub const MARGIN_SECS: f64 = 3600.0;

fn is_ended(l: &Line) -> bool {
    matches!(l.event, Event::AttemptEnded { .. })
}

/// The sessions an `attempt_ended` line prices, by id; none for any
/// other line.
fn priced(l: &Line) -> Option<&BTreeMap<String, f64>> {
    match &l.event {
        Event::AttemptEnded { session_costs, .. } => session_costs.as_ref(),
        _ => None,
    }
}

/// The numbers of the lines a card reads at a clock from `now -
/// MARGIN_SECS` on, other than the tail from `from` (the latest
/// `run_started`'s number, else 1) to the end.
fn kept_before(lines: &[Line], heard: &[(usize, &str)], now: f64) -> (usize, BTreeSet<usize>) {
    let mut keep = BTreeSet::new();
    let Some(start) = lines
        .iter()
        .rposition(|l| matches!(l.event, Event::RunStarted { .. }))
    else {
        // With no run_started the latest run reads from the first line.
        return (1, keep);
    };
    let Some(started) = lines.get(start) else {
        return (1, keep);
    };
    let before = lines.get(..start).unwrap_or_default();
    // Every attempt_ended from the first one in the day on is kept, so
    // each one kept has its earlier shares beside it.
    let day = now - DAY_SECS - MARGIN_SECS;
    let cut = before
        .iter()
        .position(|l| is_ended(l) && l.at > day)
        .unwrap_or(before.len());
    let kept = lines.get(cut..).unwrap_or_default();
    keep.extend(kept.iter().filter(|l| is_ended(l)).map(|l| l.number));
    // Each session those price, at its latest figure before them.
    let sessions: BTreeSet<&str> = kept
        .iter()
        .filter_map(priced)
        .flat_map(|costs| costs.keys().map(String::as_str))
        .collect();
    let older = before.get(..cut).unwrap_or_default();
    for s in sessions {
        let base = older
            .iter()
            .rev()
            .find(|l| priced(l).is_some_and(|c| c.contains_key(s)));
        keep.extend(base.map(|l| l.number));
    }
    // The run's own unknown events before its start still say it is alive.
    keep.extend(
        heard
            .iter()
            .filter(|(n, run)| *n < started.number && *run == started.run)
            .map(|(n, _)| *n),
    );
    (started.number, keep)
}

/// `record` cut to the lines its card reads at a clock from `now -
/// MARGIN_SECS` on: the same `Record::state` as the whole text there.
pub fn bound(record: &RecordText, now: f64) -> RecordText {
    let read = read(record);
    let heard: Vec<(usize, &str)> = read
        .heard
        .iter()
        .map(|h| (h.number, h.run.as_str()))
        .collect();
    let (from, keep) = kept_before(&read.lines, &heard, now);
    // Nothing after the line that stops the read is ever read.
    let to = read.error.as_ref().map_or(usize::MAX, |e| e.line);
    let number = |i: usize| record.numbers.get(i).copied().unwrap_or(i + 1);
    let mut out = RecordText::default();
    let mut all = true;
    for (i, raw) in record.text.split_terminator('\n').enumerate() {
        let n = number(i);
        if !((from..=to).contains(&n) || keep.contains(&n)) {
            all = false;
            continue;
        }
        out.text.push_str(raw);
        out.text.push('\n');
        out.numbers.push(n);
    }
    if all {
        return record.clone();
    }
    let kept: BTreeSet<usize> = out.numbers.iter().copied().collect();
    out.not_utf8 = record
        .not_utf8
        .iter()
        .copied()
        .filter(|n| kept.contains(n))
        .collect();
    out.cut = record
        .cut
        .iter()
        .copied()
        .filter(|n| kept.contains(n))
        .collect();
    out
}

#[cfg(test)]
mod tests {
    use std::fmt::Write;

    use super::*;
    use crate::ostinato::Record;
    use crate::time::iso_epoch;

    const ONE_ISSUE: &str = include_str!("../../../../test/golden/ostinato/one-issue.jsonl");
    const PARKED: &str = include_str!("../../../../test/golden/ostinato/parked-then-picked.jsonl");
    const TEAM: &str = include_str!("../../../../test/golden/ostinato/standing-team.jsonl");
    const TORN: &str = include_str!("../../../../test/golden/ostinato/torn-last-line.jsonl");

    fn at(s: &str) -> f64 {
        iso_epoch(s).unwrap()
    }

    fn text(s: &str) -> RecordText {
        RecordText::from_bytes(s.as_bytes())
    }

    /// The ISO time `secs` after 1 November 2026, midnight UTC.
    fn iso(secs: u64) -> String {
        let (d, rest) = (secs / 86_400, secs % 86_400);
        let (h, m, s) = (rest / 3600, rest % 3600 / 60, rest % 60);
        format!("2026-11-{:02}T{h:02}:{m:02}:{s:02}Z", d + 1)
    }

    /// Twenty days of runs, one a day of two attempts at 08:00, sharing
    /// a session across attempts and the first of them across days, each
    /// day's run ending; the last day's run still going.
    fn long_record() -> String {
        let mut out = String::new();
        let mut line = |secs: u64, run: &str, rest: &str| {
            let _ = writeln!(
                out,
                r#"{{"v":1,"at":"{}","run":"{run}",{rest}}}"#,
                iso(secs)
            );
        };
        let mut shared = 0.0;
        for day in 0..20u64 {
            let t = day * 86_400 + 8 * 3600;
            let run = format!("r-{day}");
            line(
                t,
                &run,
                r#""event":"run_started","project":"example/app-one","caps":{"issues":2,"session_hours":3,"spend_24h_usd":150}"#,
            );
            for n in 0..2u64 {
                let s = t + 60 + n * 1800;
                let item = format!("app-one#{}", day * 2 + n);
                line(
                    s,
                    &run,
                    &format!(r#""event":"picked","item":"{item}","attempt":1"#),
                );
                line(
                    s + 300,
                    &run,
                    &format!(r#""event":"stage","item":"{item}","stage":"built","attempt":1"#),
                );
                line(s + 400, &run, r#""event":"board_synced""#);
                shared += 2.5;
                let own = format!("own-{day}-{n}");
                line(
                    s + 900,
                    &run,
                    &format!(
                        r#""event":"attempt_ended","item":"{item}","outcome":"draft","cost_usd":3,"attempt":1,"session_costs":{{"pm":{shared},"{own}":1.25}}"#
                    ),
                );
            }
            if day < 19 {
                line(t + 4 * 3600, &run, r#""event":"run_ended""#);
            }
        }
        out
    }

    /// Whether the bounded text reads as the whole one at each clock.
    fn same_state(whole: &str, cut_at: f64, clocks: &[f64]) -> RecordText {
        let full = text(whole);
        let small = bound(&full, cut_at);
        let a = Record::read("example/app-one", full);
        let b = Record::read("example/app-one", small.clone());
        for now in clocks {
            assert_eq!(a.state(*now), b.state(*now), "at {now}");
        }
        small
    }

    #[test]
    fn a_long_record_publishes_a_bounded_payload_with_the_same_state() {
        let whole = long_record();
        let now = at("2026-11-20T09:00:00Z");
        let clocks = [now - MARGIN_SECS, now, now + 600.0, now + 3.0 * 86_400.0];
        let small = same_state(&whole, now, &clocks);
        assert!(
            small.text.len() * 5 < whole.len(),
            "{} of {} bytes",
            small.text.len(),
            whole.len()
        );
        // Ten lines a day. The day from 08:00 on 19 November holds day 18's
        // two ends; the shared session's base is day 17's last end, line
        // 179; then the latest run from its start, line 191, to the end.
        let ends = [179, 185, 189];
        let tail: Vec<usize> = (191..=whole.lines().count()).collect();
        assert_eq!(small.numbers, [&ends[..], &tail[..]].concat());
    }

    #[test]
    fn the_samples_read_the_same_bounded() {
        for (whole, now) in [
            (ONE_ISSUE, "2026-11-13T15:00:00Z"),
            (PARKED, "2026-11-11T10:00:00Z"),
            (PARKED, "2026-11-12T09:00:00Z"),
            (TEAM, "2026-11-11T19:00:00Z"),
            (TEAM, "2026-11-12T10:47:00Z"),
            (TORN, "2026-11-12T10:30:00Z"),
            (TORN, "2026-11-12T13:09:41Z"),
        ] {
            let now = at(now);
            same_state(whole, now, &[now - MARGIN_SECS, now, now + 86_400.0]);
        }
        // A day after the first run, its lines are gone; the second run,
        // from line 14, is all that is sent.
        let small = bound(&text(PARKED), at("2026-11-12T09:00:00Z"));
        let second: Vec<usize> = (14..=PARKED.lines().count()).collect();
        assert_eq!(small.numbers, second);
    }

    #[test]
    fn a_broken_line_keeps_its_number_and_nothing_after_it_is_sent() {
        let mut lines: Vec<String> = long_record().lines().map(String::from).collect();
        let broken = lines.len() - 3;
        lines.insert(broken, "not json".into());
        let whole = format!("{}\n", lines.join("\n"));
        let now = at("2026-11-20T09:00:00Z");
        let small = same_state(&whole, now, &[now]);
        let error = Record::read("x", small.clone()).state(now).error.unwrap();
        assert_eq!(error.line, broken + 1);
        assert_eq!(small.numbers.last(), Some(&(broken + 1)));
    }

    #[test]
    fn a_record_with_no_run_started_is_kept_whole_and_lines_keep_their_marks() {
        let no_start: String = TORN.lines().skip(1).collect::<Vec<_>>().join("\n");
        let t = text(&no_start);
        assert_eq!(bound(&t, at("2026-11-12T10:30:00Z")), t);

        // A bad byte in a kept line is still that line's error.
        let mut bytes = ONE_ISSUE.as_bytes().to_vec();
        let last = bytes.len() - 2;
        bytes.insert(last, 0xFF);
        let t = RecordText::from_bytes(&bytes);
        let now = at("2026-11-13T15:00:00Z");
        let small = bound(&t, now);
        assert_eq!(small, t, "one run from line 1: every line is read");
        assert_eq!(
            Record::read("x", small).state(now).error,
            Record::read("x", t).state(now).error
        );
    }
}
