//! Where a run stands, worked out from a record's lines (line.rs): the
//! latest run's item and attempt, its newest stage, its caps and spend,
//! whether it still runs, and once it has ended what it made, parked and
//! cost. Everything that moves with time is read at the clock the caller
//! gives, the frame's (`time::now_epoch`), never the wall clock.

use std::collections::{BTreeMap, BTreeSet};

use super::line::{Event, Heard, Line, Outcome};

/// How long a run with no end line reads as running after its last line
/// when it has no `session_hours` cap: three hours, the kit's default.
pub const DEFAULT_CAP_SECS: f64 = 3.0 * 3600.0;
/// The window the daily spend is counted over.
pub const DAY_SECS: f64 = 24.0 * 3600.0;

/// The run's caps the card reads, from `run_started`; None when the run
/// gives none.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Caps {
    /// How many issues the run may pick: the m of "issue n of m".
    pub issues: Option<f64>,
    /// How long an attempt may run, in hours.
    pub session_hours: Option<f64>,
    /// What the attempts ended in the last 24 hours may spend, in dollars.
    pub spend_24h_usd: Option<f64>,
}

impl Caps {
    fn of(caps: &BTreeMap<String, f64>) -> Caps {
        Caps {
            issues: caps.get("issues").copied(),
            session_hours: caps.get("session_hours").copied(),
            spend_24h_usd: caps.get("spend_24h_usd").copied(),
        }
    }

    /// The attempt cap in seconds: `session_hours`, else three hours. A
    /// cap of zero hours is taken as none, so a live run never reads as
    /// ended the moment it writes a line.
    pub fn attempt_secs(&self) -> f64 {
        self.session_hours
            .filter(|h| *h > 0.0)
            .map_or(DEFAULT_CAP_SECS, |h| h * 3600.0)
    }
}

/// A stage of an attempt. The first five are the card's strip; a draft
/// line reaches `Draft` too. Any other name is kept as its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stage {
    Brief,
    Built,
    Reviewed,
    Qa,
    Draft,
    Other(String),
}

impl Stage {
    fn of(name: &str) -> Stage {
        match name {
            "brief" => Stage::Brief,
            "built" => Stage::Built,
            "reviewed" => Stage::Reviewed,
            "qa" => Stage::Qa,
            "draft" => Stage::Draft,
            other => Stage::Other(other.to_string()),
        }
    }
}

/// A stage reached, and when.
#[derive(Debug, Clone, PartialEq)]
pub struct StageMark {
    pub stage: Stage,
    pub at: f64,
}

/// How an attempt ended, and when.
#[derive(Debug, Clone, PartialEq)]
pub struct AttemptEnd {
    pub outcome: Outcome,
    pub at: f64,
}

/// One attempt at an item in the run, from its `picked` line.
#[derive(Debug, Clone, PartialEq)]
pub struct Attempt {
    pub item: String,
    pub url: Option<String>,
    pub attempt: u32,
    /// When it was picked.
    pub started: f64,
    /// Its newest stage or draft line.
    pub last_stage: Option<StageMark>,
    /// None while it runs.
    pub ended: Option<AttemptEnd>,
}

/// Dollars at API prices, and whether some of it could not be priced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cost {
    pub usd: f64,
    /// An attempt counted has no `cost_usd`: the figure is short.
    pub unknown: bool,
}

/// A draft pull request the run opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftMade {
    pub item: String,
    pub pr: String,
}

/// An attempt the run parked with a question for Jon.
#[derive(Debug, Clone, PartialEq)]
pub struct Park {
    pub item: String,
    pub attempt: Option<u32>,
    /// Why, as the record's code (`permission_prompt`, `needs_decision`).
    pub reason: String,
    pub question: String,
    pub at: f64,
}

/// Whether the run still runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    Running,
    /// It ended at `at`: by its `run_ended` line, or with `silent` when
    /// it has none and its last line, at `at`, is older than the attempt
    /// cap.
    Ended {
        at: f64,
        silent: bool,
    },
}

/// Where the record's latest run stands at a clock.
#[derive(Debug, Clone, PartialEq)]
pub struct RunState {
    pub run: String,
    /// `owner/repo` as `run_started` names it; None with no such line.
    pub project: Option<String>,
    /// When `run_started` was written; None with no such line.
    pub started: Option<f64>,
    pub caps: Caps,
    /// How many items the run has picked so far, each counted once: the
    /// n of "issue n of m".
    pub picked: usize,
    /// The newest attempt still running, else the newest one picked.
    pub current: Option<Attempt>,
    /// What the attempts ended in the 24 hours to the clock cost, in any
    /// run, each attempt's share of a shared session counted once.
    pub spend_24h: Cost,
    pub phase: Phase,
    /// The run's drafts and parks, oldest first.
    pub drafts: Vec<DraftMade>,
    pub parks: Vec<Park>,
    /// What the run cost: each session once at its latest figure, plus
    /// any attempt priced only as a whole.
    pub cost: Cost,
    /// From start to end, in seconds, once it has ended.
    pub length: Option<f64>,
}

/// One `attempt_ended` line's own share of what its sessions cost.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Share {
    pub at: f64,
    pub usd: f64,
    /// The line has a `cost_usd`, so every session it ran was priced.
    pub known: bool,
}

/// Each `attempt_ended` line's share, in file order across every run
/// (the format's per-attempt rule): from `session_costs`, a session's
/// rise since the last line that priced it, its whole figure the first
/// time, and nothing when it fell; from a line with no `session_costs`,
/// its `cost_usd`.
pub fn shares(lines: &[Line]) -> Vec<Share> {
    let mut base: BTreeMap<&str, f64> = BTreeMap::new();
    let mut out = Vec::new();
    for l in lines {
        let Event::AttemptEnded {
            cost_usd,
            session_costs,
            ..
        } = &l.event
        else {
            continue;
        };
        let usd = match session_costs {
            Some(costs) => costs
                .iter()
                .map(|(session, figure)| {
                    let was = base.insert(session, *figure);
                    was.map_or(*figure, |was| (figure - was).max(0.0))
                })
                .sum(),
            None => cost_usd.unwrap_or(0.0),
        };
        out.push(Share {
            at: l.at,
            usd,
            known: cost_usd.is_some(),
        });
    }
    out
}

/// The latest run's lines: those of the run the last `run_started`
/// names, from that line on; with no `run_started`, the last line's run.
fn latest_run(lines: &[Line]) -> Option<(&str, &[Line])> {
    let start = lines
        .iter()
        .rposition(|l| matches!(l.event, Event::RunStarted { .. }));
    let run = match start {
        Some(i) => lines.get(i)?.run.as_str(),
        None => lines.last()?.run.as_str(),
    };
    Some((run, lines.get(start.unwrap_or(0)..)?))
}

/// The attempt a line about `item` belongs to: its own attempt number's,
/// else the item's newest one still running, else its newest.
fn attempt_of<'a>(
    attempts: &'a mut [Attempt],
    item: &str,
    attempt: Option<u32>,
) -> Option<&'a mut Attempt> {
    let of_item = |a: &&mut Attempt| a.item == item;
    match attempt {
        Some(n) => attempts
            .iter_mut()
            .rev()
            .filter(of_item)
            .find(|a| a.attempt == n),
        None => {
            let open = attempts
                .iter()
                .rposition(|a| a.item == item && a.ended.is_none());
            let any = attempts.iter().rposition(|a| a.item == item);
            attempts.get_mut(open.or(any)?)
        }
    }
}

/// What the run's lines say, before the clock is read.
#[derive(Default)]
struct Walk {
    project: Option<String>,
    started: Option<f64>,
    caps: Caps,
    attempts: Vec<Attempt>,
    drafts: Vec<DraftMade>,
    parks: Vec<Park>,
    ended: Option<f64>,
    /// Each session's latest figure in the run.
    latest: BTreeMap<String, f64>,
    /// Attempts priced only as a whole, and whether any was not priced.
    whole: f64,
    unknown: bool,
}

impl Walk {
    fn stage(&mut self, item: &str, attempt: Option<u32>, stage: Stage, at: f64) {
        if let Some(a) = attempt_of(&mut self.attempts, item, attempt) {
            a.last_stage = Some(StageMark { stage, at });
        }
    }

    fn take(&mut self, l: &Line) {
        match &l.event {
            Event::RunStarted { project, caps } => {
                self.project = Some(project.clone());
                self.started = Some(l.at);
                self.caps = Caps::of(caps);
            }
            Event::Picked { item, url, attempt } => self.attempts.push(Attempt {
                item: item.clone(),
                url: url.clone(),
                attempt: *attempt,
                started: l.at,
                last_stage: None,
                ended: None,
            }),
            Event::Stage {
                item,
                stage,
                attempt,
                ..
            } => self.stage(item, *attempt, Stage::of(stage), l.at),
            Event::Draft { item, pr, attempt } => {
                self.stage(item, *attempt, Stage::Draft, l.at);
                self.drafts.push(DraftMade {
                    item: item.clone(),
                    pr: pr.clone(),
                });
            }
            Event::Parked {
                item,
                reason,
                question,
                attempt,
            } => self.parks.push(Park {
                item: item.clone(),
                attempt: *attempt,
                reason: reason.clone(),
                question: question.clone(),
                at: l.at,
            }),
            Event::AttemptEnded {
                item,
                outcome,
                cost_usd,
                attempt,
                session_costs,
                ..
            } => {
                if let Some(a) = attempt_of(&mut self.attempts, item, *attempt) {
                    a.ended = Some(AttemptEnd {
                        outcome: outcome.clone(),
                        at: l.at,
                    });
                }
                self.unknown |= cost_usd.is_none();
                match session_costs {
                    Some(costs) => {
                        let figures = costs.iter().map(|(s, c)| (s.clone(), *c));
                        self.latest.extend(figures);
                    }
                    None => self.whole += cost_usd.unwrap_or(0.0),
                }
            }
            Event::RunEnded { .. } => self.ended = Some(l.at),
        }
    }
}

/// Where the latest run in `lines` stands at epoch `now`; `heard` is the
/// record's unknown events, whose times count as the run's last line;
/// `shares` is `shares(lines)`, worked out once per read. None with no
/// lines.
pub fn run_state(lines: &[Line], heard: &[Heard], shares: &[Share], now: f64) -> Option<RunState> {
    let (run, own) = latest_run(lines)?;
    let mut walk = Walk::default();
    for l in own.iter().filter(|l| l.run == run) {
        walk.take(l);
    }
    let read = own
        .iter()
        .rev()
        .find(|l| l.run == run)
        .map_or(0.0, |l| l.at);
    // A newer loop's event this reader skips still shows the run is alive.
    let last = heard
        .iter()
        .filter(|h| h.run == run)
        .fold(read, |last, h| last.max(h.at));
    let phase = match walk.ended {
        Some(at) => Phase::Ended { at, silent: false },
        None if now - last > walk.caps.attempt_secs() => Phase::Ended {
            at: last,
            silent: true,
        },
        None => Phase::Running,
    };
    let length = match (&phase, walk.started) {
        (Phase::Ended { at, .. }, Some(start)) => Some(at - start),
        _ => None,
    };
    let picked: BTreeSet<&str> = walk.attempts.iter().map(|a| a.item.as_str()).collect();
    let current = walk
        .attempts
        .iter()
        .rev()
        .find(|a| a.ended.is_none())
        .or(walk.attempts.last())
        .cloned();
    let in_day = shares.iter().filter(|s| s.at > now - DAY_SECS);
    let spend_24h = in_day.fold(Cost::default(), |c, s| Cost {
        usd: c.usd + s.usd,
        unknown: c.unknown || !s.known,
    });
    let cost = Cost {
        usd: walk.latest.values().sum::<f64>() + walk.whole,
        unknown: walk.unknown,
    };
    Some(RunState {
        run: run.to_string(),
        picked: picked.len(),
        project: walk.project,
        started: walk.started,
        caps: walk.caps,
        current,
        spend_24h,
        phase,
        drafts: walk.drafts,
        parks: walk.parks,
        cost,
        length,
    })
}
