//! Each Ostinato cycle in a record (issue #399): one attempt at one item,
//! from its `picked` line to its `attempt_ended`, with when each stage
//! came and how long it took, so the agents panel's Details tab can list
//! them (cycles_save.rs saves them). Worked out once per read, as the
//! shares are, never per frame.
//!
//! The runner hands on only what a card reads (bound.rs): the latest
//! run whole, and from earlier runs their `attempt_ended` lines from
//! about a day before the runner's clock, each session's latest older
//! end line before those (the base its next share counts from), and the
//! parks still waiting. Every end line handed on makes a cycle, so an
//! earlier run's cycles are those end lines, not every attempt of the
//! last day, and as the runner's clock moves the oldest drop out of what
//! is handed on. The latest run's cycles have their stages, and an
//! earlier one has only its end: outcome, sessions, cost and when, and
//! its park when one was handed on. A park with no `picked` or
//! `attempt_ended` beside it makes no cycle of its own; it waits on Jon
//! in Needs you.
//!
//! A run that ends, or is followed by another run, with a cycle still
//! open closes it: `ended` is set to that line's time and `outcome` stays
//! absent, so the panel reads "ended without an end line", never running.
//!
//! Nothing worked out here moves with the clock: times are epochs and
//! lengths are between two lines, never an age. Only which older lines
//! the runner hands on does.

use super::line::{Event, Line};
use super::run::{Share, shares};

/// One stage reached, or the park, as a milestone of a cycle.
#[derive(Debug, Clone, PartialEq)]
pub struct Milestone {
    /// The stage's name as the record writes it (`brief`, `qa`), `draft`
    /// for a draft line, or `parked`.
    pub name: String,
    pub at: f64,
    /// Seconds since the milestone before it, the `picked` line for the
    /// first; never below zero.
    pub secs: f64,
    /// The sessions behind it: the line's own, else the cycle's (the
    /// real records so far run one session an attempt, which their stage
    /// lines do not name).
    pub sessions: Vec<String>,
}

/// Why a cycle parked.
#[derive(Debug, Clone, PartialEq)]
pub struct CyclePark {
    /// The record's code (`needs_decision`).
    pub reason: String,
    pub question: String,
}

/// One attempt at one item.
#[derive(Debug, Clone, PartialEq)]
pub struct Cycle {
    /// The run that wrote it, so a line is matched within its own run.
    pub run: String,
    pub item: String,
    pub url: Option<String>,
    /// None only for an end line from before attempts were numbered.
    pub attempt: Option<u32>,
    /// When it was picked; None when its `picked` line was not handed on.
    pub started: Option<f64>,
    pub stages: Vec<Milestone>,
    /// The draft pull request it opened, as `repo#12`.
    pub pr: Option<String>,
    pub park: Option<CyclePark>,
    /// The sessions it ran: its end line's, else those its other lines
    /// name, each once.
    pub sessions: Vec<String>,
    /// How it ended, as the record's word; None while it runs.
    pub outcome: Option<String>,
    pub cost_usd: Option<f64>,
    pub ended: Option<f64>,
}

/// A park whose cycle's `picked` line was not handed on, held for the
/// `attempt_ended` line that makes its cycle.
struct Held {
    run: String,
    item: String,
    attempt: Option<u32>,
    park: CyclePark,
    sessions: Vec<String>,
}

/// The cycles being read, with the sessions the lines before the end
/// named, and the parks that found no cycle yet.
#[derive(Default)]
struct Walk {
    cycles: Vec<Cycle>,
    named: Vec<Vec<String>>,
    held: Vec<Held>,
}

impl Walk {
    /// The index of the cycle a line of `run` about `item` belongs to:
    /// its own attempt number's, else the item's newest one still open,
    /// within the run. A line with no number never joins an ended cycle,
    /// so two end lines never merge.
    fn find(&self, run: &str, item: &str, attempt: Option<u32>) -> Option<usize> {
        let mine = |c: &Cycle| c.run == run && c.item == item;
        match attempt {
            Some(n) => self
                .cycles
                .iter()
                .rposition(|c| mine(c) && c.attempt == Some(n)),
            None => self
                .cycles
                .iter()
                .rposition(|c| mine(c) && c.ended.is_none()),
        }
    }

    /// Closes each open cycle `which` picks at `at`, its outcome left
    /// absent: the run ended without its end line.
    fn close(&mut self, at: f64, which: impl Fn(&Cycle) -> bool) {
        for c in &mut self.cycles {
            if c.ended.is_none() && which(c) {
                c.ended = Some(at);
            }
        }
    }

    /// Gives a new cycle `i` the park held for it, if one was.
    fn attach_held(&mut self, i: usize) {
        let Some(c) = self.cycles.get(i) else { return };
        let Some(h) = self.held.iter().rposition(|h| {
            h.run == c.run
                && h.item == c.item
                && (h.attempt.is_none() || c.attempt.is_none() || h.attempt == c.attempt)
        }) else {
            return;
        };
        let h = self.held.remove(h);
        self.name(i, &h.sessions);
        if let Some(c) = self.cycles.get_mut(i) {
            c.park = Some(h.park);
        }
    }

    fn push(&mut self, cycle: Cycle) -> usize {
        self.cycles.push(cycle);
        self.named.push(Vec::new());
        self.cycles.len() - 1
    }

    /// Pushes a cycle made by its end line, with any park held for it.
    fn fresh(&mut self, cycle: Cycle) -> usize {
        let i = self.push(cycle);
        self.attach_held(i);
        i
    }

    /// Notes the sessions a line names for cycle `i`, each once.
    fn name(&mut self, i: usize, sessions: &[String]) {
        if let Some(named) = self.named.get_mut(i) {
            for s in sessions {
                if !named.contains(s) {
                    named.push(s.clone());
                }
            }
        }
    }

    /// Adds a milestone to cycle `i`, timed from the one before it; none
    /// when the cycle has no start to time it from.
    fn mark(&mut self, i: usize, name: &str, at: f64, sessions: &[String]) {
        self.name(i, sessions);
        let Some(c) = self.cycles.get_mut(i) else {
            return;
        };
        let Some(before) = c.stages.last().map(|m| m.at).or(c.started) else {
            return;
        };
        c.stages.push(Milestone {
            name: name.to_string(),
            at,
            secs: (at - before).max(0.0),
            sessions: sessions.to_vec(),
        });
    }

    /// Reads line `l`; `share` is its own when it is an end line.
    fn take(&mut self, l: &Line, share: Option<&Share>) {
        let run = l.run.as_str();
        match &l.event {
            Event::Picked { item, url, attempt } => {
                self.push(Cycle {
                    run: l.run.clone(),
                    item: item.clone(),
                    url: url.clone(),
                    attempt: Some(*attempt),
                    started: Some(l.at),
                    stages: Vec::new(),
                    pr: None,
                    park: None,
                    sessions: Vec::new(),
                    outcome: None,
                    cost_usd: None,
                    ended: None,
                });
            }
            Event::Stage {
                item,
                stage,
                attempt,
                sessions,
            } => {
                if let Some(i) = self.find(run, item, *attempt) {
                    self.mark(i, stage, l.at, sessions);
                }
            }
            Event::Draft {
                item,
                pr,
                attempt,
                sessions,
            } => {
                if let Some(i) = self.find(run, item, *attempt) {
                    self.mark(i, "draft", l.at, sessions);
                    if let Some(c) = self.cycles.get_mut(i) {
                        c.pr = Some(pr.clone());
                    }
                }
            }
            Event::Parked {
                item,
                reason,
                question,
                attempt,
                sessions,
            } => {
                let park = CyclePark {
                    reason: reason.clone(),
                    question: question.clone(),
                };
                match self.find(run, item, *attempt) {
                    Some(i) => {
                        self.mark(i, "parked", l.at, sessions);
                        if let Some(c) = self.cycles.get_mut(i) {
                            c.park = Some(park);
                        }
                    }
                    // An earlier run's park, its pick bounded away: held
                    // for the end line that makes its cycle.
                    None => self.held.push(Held {
                        run: l.run.clone(),
                        item: item.clone(),
                        attempt: *attempt,
                        park,
                        sessions: sessions.clone(),
                    }),
                }
            }
            Event::AttemptEnded {
                item,
                outcome,
                attempt,
                sessions,
                ..
            } => {
                let i = match self.find(run, item, *attempt) {
                    Some(i) => i,
                    None => self.fresh(Cycle {
                        run: l.run.clone(),
                        item: item.clone(),
                        url: None,
                        attempt: *attempt,
                        started: None,
                        stages: Vec::new(),
                        pr: None,
                        park: None,
                        sessions: Vec::new(),
                        outcome: None,
                        cost_usd: None,
                        ended: None,
                    }),
                };
                if let Some(c) = self.cycles.get_mut(i) {
                    c.outcome = Some(outcome.as_str().to_string());
                    // Its share, as the card counts it, never the
                    // session's running total `cost_usd` carries.
                    c.cost_usd = share.filter(|s| s.known).map(|s| s.usd);
                    c.ended = Some(l.at);
                    c.sessions = sessions.clone();
                }
            }
            Event::RunEnded { .. } => self.close(l.at, |c| c.run == run),
            Event::RunStarted { .. } => self.close(l.at, |c| c.run != run),
        }
    }

    /// The cycles, each one's sessions settled and lent to the stages
    /// that name none.
    fn finish(self) -> Vec<Cycle> {
        self.cycles
            .into_iter()
            .zip(self.named)
            .map(|(mut c, named)| {
                if c.sessions.is_empty() {
                    c.sessions = named;
                }
                for m in &mut c.stages {
                    if m.sessions.is_empty() {
                        m.sessions.clone_from(&c.sessions);
                    }
                }
                c
            })
            .collect()
    }
}

/// Every cycle in `lines`, oldest first.
pub fn cycles(lines: &[Line]) -> Vec<Cycle> {
    let mut walk = Walk::default();
    // One share per end line, in file order, as the card counts spend.
    let mut costs = shares(lines).into_iter();
    for l in lines {
        let share = match l.event {
            Event::AttemptEnded { .. } => costs.next(),
            _ => None,
        };
        walk.take(l, share.as_ref());
    }
    walk.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ostinato::line::read;
    use crate::ostinato::{RecordText, bound};
    use crate::time::iso_epoch;

    /// A trimmed copy of a real record, its names changed: an earlier
    /// run's cancelled attempt, then a run that briefed, built, reviewed
    /// and tested an issue, parked it on a question and stalled.
    const REAL: &str = r#"{"v":1,"at":"2026-11-18T06:59:50Z","run":"r-a","event":"run_started","project":"example/app-two","caps":{"issues":1,"spend_24h_usd":150,"session_hours":3}}
{"v":1,"at":"2026-11-18T06:59:53Z","run":"r-a","event":"picked","item":"app-two#2793","url":"https://github.com/example/app-two/issues/2793","attempt":1}
{"v":1,"at":"2026-11-18T07:16:29Z","run":"r-a","event":"attempt_ended","item":"app-two#2793","outcome":"cancelled","cost_usd":5.7877,"attempt":1,"sessions":["s-a"],"session_costs":{"s-a":5.7877}}
{"v":1,"at":"2026-11-18T07:16:29Z","run":"r-a","event":"run_ended","attempts":1}
{"v":1,"at":"2026-11-18T07:53:49Z","run":"r-b","event":"run_started","project":"example/app-two","caps":{"issues":1,"spend_24h_usd":150,"session_hours":3}}
{"v":1,"at":"2026-11-18T07:53:51Z","run":"r-b","event":"picked","item":"app-two#2845","url":"https://github.com/example/app-two/issues/2845","attempt":1}
{"v":1,"at":"2026-11-18T07:54:57Z","run":"r-b","event":"stage","item":"app-two#2845","stage":"brief","attempt":1}
{"v":1,"at":"2026-11-18T07:55:41Z","run":"r-b","event":"stage","item":"app-two#2845","stage":"built","attempt":1}
{"v":1,"at":"2026-11-18T08:01:41Z","run":"r-b","event":"stage","item":"app-two#2845","stage":"reviewed","attempt":1}
{"v":1,"at":"2026-11-18T08:03:23Z","run":"r-b","event":"stage","item":"app-two#2845","stage":"qa","attempt":1}
{"v":1,"at":"2026-11-18T08:07:47Z","run":"r-b","event":"parked","item":"app-two#2845","reason":"needs_decision","question":"Clear the advisory on main, then rerun CI?","attempt":1}
{"v":1,"at":"2026-11-18T08:09:42Z","run":"r-b","event":"attempt_ended","item":"app-two#2845","outcome":"stalled","cost_usd":2.9886,"attempt":1,"sessions":["s-b"],"session_costs":{"s-b":2.9886}}
{"v":1,"at":"2026-11-18T08:09:42Z","run":"r-b","event":"run_ended","attempts":1}
"#;

    #[test]
    fn two_attempts_on_one_session_each_cost_their_own_share() {
        let all = of(
            r#"{"v":1,"at":"2026-11-18T09:00:00Z","run":"r-1","event":"run_started","project":"example/app-one"}
{"v":1,"at":"2026-11-18T09:01:00Z","run":"r-1","event":"picked","item":"app-one#1","attempt":1}
{"v":1,"at":"2026-11-18T09:02:00Z","run":"r-1","event":"attempt_ended","item":"app-one#1","outcome":"failed","cost_usd":3.0,"attempt":1,"sessions":["s1"],"session_costs":{"s1":3.0}}
{"v":1,"at":"2026-11-18T09:03:00Z","run":"r-1","event":"picked","item":"app-one#1","attempt":2}
{"v":1,"at":"2026-11-18T09:04:00Z","run":"r-1","event":"attempt_ended","item":"app-one#1","outcome":"draft","cost_usd":5.0,"attempt":2,"sessions":["s1"],"session_costs":{"s1":5.0}}
"#,
        );
        let costs: Vec<Option<f64>> = all.iter().map(|c| c.cost_usd).collect();
        assert_eq!(costs, vec![Some(3.0), Some(2.0)]);
    }

    fn of(text: &str) -> Vec<Cycle> {
        cycles(&read(&RecordText::from_bytes(text.as_bytes())).lines)
    }

    fn at(s: &str) -> f64 {
        iso_epoch(s).unwrap()
    }

    fn timing(c: &Cycle) -> Vec<(&str, f64)> {
        c.stages.iter().map(|m| (m.name.as_str(), m.secs)).collect()
    }

    #[test]
    fn the_real_record_times_each_stage_and_the_park() {
        let all = of(REAL);
        assert_eq!(all.len(), 2);
        let c = &all[1];
        assert_eq!(c.item, "app-two#2845");
        assert_eq!(c.attempt, Some(1));
        assert_eq!(c.started, Some(at("2026-11-18T07:53:51Z")));
        assert_eq!(
            timing(c),
            [
                ("brief", 66.0),
                ("built", 44.0),
                ("reviewed", 360.0),
                ("qa", 102.0),
                ("parked", 264.0)
            ]
        );
        assert_eq!(c.outcome.as_deref(), Some("stalled"));
        assert_eq!(c.cost_usd, Some(2.9886));
        assert_eq!(c.ended, Some(at("2026-11-18T08:09:42Z")));
        assert_eq!(
            c.park,
            Some(CyclePark {
                reason: "needs_decision".into(),
                question: "Clear the advisory on main, then rerun CI?".into()
            })
        );
        assert_eq!(c.pr, None);
        assert_eq!(c.sessions, ["s-b"]);
        // Its stage lines name no session: the cycle's one covers each.
        assert!(c.stages.iter().all(|m| m.sessions == ["s-b"]));
        assert_eq!(all[0].outcome.as_deref(), Some("cancelled"));
    }

    #[test]
    fn an_earlier_run_handed_on_keeps_its_end_but_no_stages() {
        let text = RecordText::from_bytes(REAL.as_bytes());
        let now = at("2026-11-18T09:00:00Z");
        let all = cycles(&read(&bound::bound(&text, now)).lines);
        let first = all.first().unwrap();
        assert_eq!(first.item, "app-two#2793");
        assert_eq!(first.started, None, "its picked line is not handed on");
        assert!(first.stages.is_empty());
        assert_eq!(first.outcome.as_deref(), Some("cancelled"));
        assert_eq!(first.cost_usd, Some(5.7877));
        assert_eq!(first.sessions, ["s-a"]);
        assert_eq!(all.last().map(|c| c.stages.len()), Some(5));
    }

    const RUN: &str = r#"{"v":1,"at":"2026-11-13T14:00:00Z","run":"r-1","event":"run_started","project":"example/x","caps":{}}
{"v":1,"at":"2026-11-13T14:00:10Z","run":"r-1","event":"picked","item":"x#1","attempt":1}
{"v":1,"at":"2026-11-13T14:01:10Z","run":"r-1","event":"stage","item":"x#1","stage":"brief","attempt":1,"sessions":["s1"]}
{"v":1,"at":"2026-11-13T14:02:10Z","run":"r-1","event":"stage","item":"x#1","stage":"built","attempt":1}
{"v":1,"at":"2026-11-13T14:03:00Z","run":"r-1","event":"picked","item":"x#2","attempt":2}
{"v":1,"at":"2026-11-13T14:04:00Z","run":"r-1","event":"draft","item":"x#1","pr":"x#9","attempt":1,"sessions":["s2"]}
{"v":1,"at":"2026-11-13T14:05:00Z","run":"r-1","event":"stage","item":"x#2","stage":"brief"}
"#;

    #[test]
    fn a_draft_belongs_to_its_attempt_and_sessions_come_from_the_lines() {
        let all = of(RUN);
        let one = &all[0];
        assert_eq!(one.pr.as_deref(), Some("x#9"));
        assert_eq!(one.outcome, None, "still running");
        assert_eq!(one.sessions, ["s1", "s2"], "no end line: the lines' own");
        assert_eq!(
            timing(one),
            [("brief", 60.0), ("built", 60.0), ("draft", 110.0)]
        );
        let built = &one.stages[1];
        assert_eq!(built.sessions, ["s1", "s2"], "names none: the cycle's");
        assert_eq!(one.stages[0].sessions, ["s1"]);
        let two = &all[1];
        assert_eq!(two.pr, None);
        assert_eq!(timing(two), [("brief", 120.0)], "no attempt: the open one");
        assert!(two.sessions.is_empty());
    }

    /// An earlier run that parks app-one#4 on a question, then stalls;
    /// then a later run on another item.
    const PARKED_EARLIER: &str = r#"{"v":1,"at":"2026-11-18T06:00:00Z","run":"r-a","event":"run_started","project":"example/app-one","caps":{}}
{"v":1,"at":"2026-11-18T06:00:05Z","run":"r-a","event":"picked","item":"app-one#4","attempt":1}
{"v":1,"at":"2026-11-18T06:10:00Z","run":"r-a","event":"parked","item":"app-one#4","reason":"needs_decision","question":"Which way?","attempt":1,"sessions":["s-p"]}
{"v":1,"at":"2026-11-18T06:12:00Z","run":"r-a","event":"attempt_ended","item":"app-one#4","outcome":"stalled","cost_usd":1.0,"attempt":1}
{"v":1,"at":"2026-11-18T06:12:00Z","run":"r-a","event":"run_ended","attempts":1}
{"v":1,"at":"2026-11-18T07:00:00Z","run":"r-b","event":"run_started","project":"example/app-one","caps":{}}
{"v":1,"at":"2026-11-18T07:00:05Z","run":"r-b","event":"picked","item":"app-one#5","attempt":1}
"#;

    #[test]
    fn an_earlier_runs_park_survives_its_pick_being_bounded_away() {
        let text = RecordText::from_bytes(PARKED_EARLIER.as_bytes());
        let all = cycles(&read(&bound::bound(&text, at("2026-11-18T09:00:00Z"))).lines);
        let first = all.first().unwrap();
        assert_eq!(first.item, "app-one#4");
        assert_eq!(first.started, None, "its picked line is not handed on");
        assert_eq!(first.outcome.as_deref(), Some("stalled"));
        assert_eq!(
            first.park,
            Some(CyclePark {
                reason: "needs_decision".into(),
                question: "Which way?".into()
            })
        );
        assert_eq!(first.sessions, ["s-p"], "the park's session, no end's");
    }

    #[test]
    fn a_park_with_no_cycle_or_end_makes_no_cycle() {
        let lone = r#"{"v":1,"at":"2026-11-18T06:10:00Z","run":"r-a","event":"parked","item":"app-one#4","reason":"needs_decision","question":"Which?"}
"#;
        assert!(of(lone).is_empty());
    }

    #[test]
    fn two_unnumbered_end_lines_make_two_cycles() {
        let text = r#"{"v":1,"at":"2026-11-13T14:00:00Z","run":"r-1","event":"attempt_ended","item":"x#1","outcome":"abandoned","cost_usd":1.0}
{"v":1,"at":"2026-11-13T15:00:00Z","run":"r-1","event":"attempt_ended","item":"x#1","outcome":"merged","cost_usd":2.0}
"#;
        let all = of(text);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].outcome.as_deref(), Some("abandoned"));
        assert_eq!(all[0].cost_usd, Some(1.0));
        assert_eq!(all[1].outcome.as_deref(), Some("merged"));
    }

    #[test]
    fn a_run_that_ends_without_an_end_line_closes_its_cycles() {
        let text = r#"{"v":1,"at":"2026-11-13T14:00:00Z","run":"r-1","event":"picked","item":"x#1","attempt":1}
{"v":1,"at":"2026-11-13T14:10:00Z","run":"r-1","event":"run_ended","attempts":1}
{"v":1,"at":"2026-11-13T15:00:00Z","run":"r-2","event":"picked","item":"x#2","attempt":1}
{"v":1,"at":"2026-11-13T16:00:00Z","run":"r-3","event":"run_started","project":"example/x","caps":{}}
{"v":1,"at":"2026-11-13T16:00:05Z","run":"r-3","event":"picked","item":"x#3","attempt":1}
"#;
        let all = of(text);
        let ends: Vec<_> = all
            .iter()
            .map(|c| (c.outcome.as_deref(), c.ended))
            .collect();
        assert_eq!(
            ends,
            [
                (None, Some(at("2026-11-13T14:10:00Z"))),
                (None, Some(at("2026-11-13T16:00:00Z"))),
                (None, None),
            ],
            "closed by its run_ended, by the next run_started, still running"
        );
    }
}
