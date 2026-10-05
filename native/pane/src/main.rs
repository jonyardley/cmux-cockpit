//! `cockpit-pane`: the cockpit in a terminal pane, fed live by the shell
//! runner.
//!
//! With no options it draws the All view in the terminal (up and down
//! move between cards, `?` shows the keys, `q` quits), with the mouse
//! captured so a card can be dragged. `--print` runs
//! headless: it prints the view model as text whenever it
//! changes, and logs on stderr how long each status change took to reach
//! it. `--once` prints once replay has caught up and every poll has
//! answered, then exits. `--config <dir>` reads state.json and
//! projects.json from another folder; `--after <seq>` replays from a
//! later sequence.

use std::collections::HashMap;
use std::io::Write;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use std::sync::mpsc;
use std::thread;

use cockpit_pane::runner::{self, Feed, Input, Latency, Options, text};
use cockpit_pane::{Outcome, Pane, PaneModel};
use ratatui::crossterm::event::{self, Event};

/// In --once mode, the longest replay may take before the view prints anyway.
const ONCE_LIMIT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq)]
struct Args {
    print: bool,
    once: bool,
    after: u64,
    config: Option<PathBuf>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut out = Args {
        print: false,
        once: false,
        after: 0,
        config: None,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--print" => out.print = true,
            "--once" => out.once = true,
            "--after" => {
                let n = it.next().ok_or("--after needs a sequence")?;
                out.after = n
                    .parse()
                    .map_err(|_| format!("--after: not a number: {n}"))?;
            }
            "--config" => {
                let dir = it.next().ok_or("--config needs a folder")?;
                out.config = Some(PathBuf::from(dir));
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(out)
}

/// The main checkout's config folder, where the sidebars' build reads.
fn default_config() -> PathBuf {
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join(".config/cmux/config")
}

/// The stderr line for a status change that reached the view model.
fn timing_line(l: &Latency, now_epoch: f64) -> String {
    let read_ms = l.read_at.elapsed().as_millis();
    let from_event = l.change.at.map_or("unknown".to_string(), |at| {
        format!("{:.0} ms", ((now_epoch - at) * 1000.0).max(0.0))
    });
    format!(
        "timing: seq {} {}: event to view {from_event}, read to view {read_ms} ms",
        l.change.seq, l.change.hook
    )
}

fn print_live(pane: &Feed, latency: Option<&Latency>, shown: &mut String) {
    if let Some(l) = latency
        && pane.join.health.caught_up()
    {
        eprintln!("{}", timing_line(l, runner::now_epoch()));
    }
    let text = text::render(pane);
    if text != *shown {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "\n── {} ──\n{text}", clock());
        let _ = out.flush();
        *shown = text;
    }
}

/// Local wall-clock time is not in std, so the header shows UTC.
fn clock() -> String {
    let secs = runner::now_epoch() as u64;
    format!(
        "{:02}:{:02}:{:02} UTC",
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60
    )
}

/// `--print --once`: prints once replay has caught up and every poll
/// (Agent View, the workspace list and the groups) has answered, or after
/// `ONCE_LIMIT` whatever it has.
fn print_once(opts: &Options) {
    let started = Instant::now();
    runner::run(
        opts,
        runner::channel(),
        |feed, _| {
            let ready = feed.join.health.caught_up() && feed.join.loaded();
            if !ready && started.elapsed() < ONCE_LIMIT {
                return ControlFlow::Continue(());
            }
            let note = if ready {
                format!("replayed in {:.1}s", started.elapsed().as_secs_f32())
            } else {
                not_ready(feed)
            };
            println!("{}{note}", text::render(feed));
            ControlFlow::Break(())
        },
        |line| eprintln!("cockpit-pane: {line}"),
    );
}

/// Why `--print --once` printed before it was ready: whichever of the
/// replay and the polls had not answered within `ONCE_LIMIT`.
fn not_ready(feed: &runner::Feed) -> String {
    let mut waiting = feed.join.missing();
    if !feed.join.health.caught_up() {
        waiting.insert(0, "replay");
    }
    format!(
        "NOT ready after {}s, no answer from: {}",
        ONCE_LIMIT.as_secs(),
        waiting.join(", ")
    )
}

/// `--print`: reprints the text on every change, with timings on stderr.
fn print_follow(opts: &Options) {
    let mut shown = String::new();
    runner::run(
        opts,
        runner::channel(),
        |feed, call| {
            print_live(feed, call.latency, &mut shown);
            ControlFlow::Continue(())
        },
        |line| eprintln!("cockpit-pane: {line}"),
    );
}

/// Asks the terminal for presses, releases, drags and the wheel, in SGR
/// form, but not bare movement: crossterm's own capture also reports
/// every move of the pointer, which would wake the runner for nothing.
const MOUSE_ON: &str = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF: &str = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/// Holds the mouse captured, so the pane sees presses and drags, and lets
/// it go when dropped: on a clean exit, a failed draw, an early return,
/// or a panic as it unwinds.
struct Mouse;

impl Mouse {
    fn capture() -> Result<Mouse, String> {
        let mut out = std::io::stdout();
        out.write_all(MOUSE_ON.as_bytes())
            .and_then(|()| out.flush())
            .map(|()| Mouse)
            .map_err(|e| format!("no mouse: {e}"))
    }
}

impl Drop for Mouse {
    fn drop(&mut self) {
        // Nothing to do if it fails: the terminal is going away.
        let mut out = std::io::stdout();
        let _ = out
            .write_all(MOUSE_OFF.as_bytes())
            .and_then(|()| out.flush());
    }
}

/// The terminal view: draws each new frame, and hands every key and
/// resize to the pane. A thread reads the terminal and pokes the runner,
/// so a key is answered at once without the runner waking on a timer.
/// Log lines would tear the screen, so they wait until it is restored,
/// tallied so a long session's polls print once each, not once a poll.
/// The held lines come back with the outcome, a failed draw included, so
/// they print either way.
fn terminal(opts: &Options) -> (Vec<String>, Result<(), String>) {
    let (tx, rx) = runner::channel();
    let (keys_tx, keys_rx) = mpsc::channel::<Event>();
    let poke = tx.clone();
    thread::spawn(move || {
        while let Ok(e) = event::read() {
            if keys_tx.send(e).is_err() || poke.send(Input::Poke).is_err() {
                return;
            }
        }
    });
    let mut term = match ratatui::try_init() {
        Ok(t) => t,
        Err(e) => return (Vec::new(), Err(format!("no terminal: {e}"))),
    };
    let mouse = match Mouse::capture() {
        Ok(m) => m,
        Err(e) => {
            ratatui::restore();
            return (Vec::new(), Err(e));
        }
    };
    let mut pane = Pane::new(PaneModel::default());
    let mut logged = Tally::default();
    let mut failed = None;
    runner::run(
        opts,
        (tx, rx),
        |feed, call| {
            // Each new model is drawn before the next event, so a click
            // maps to the cards on screen, not to where they were.
            let mut flow = Ok(());
            if call.fresh && pane.set_view_model(PaneModel::from_core(&mut feed.model)) {
                flow = pane.draw(&mut term).map(drop);
            }
            for e in keys_rx.try_iter() {
                if flow.is_err() {
                    break;
                }
                match pane.handle_event(&e) {
                    Outcome::Quit => return ControlFlow::Break(()),
                    // The core takes the action at once and holds its
                    // placement, so the pane redraws from the core's new
                    // view before the next key: a second quick Shift press
                    // works from where the first put the card.
                    Outcome::Act(action) => {
                        feed.act(action.into());
                        pane.set_view_model(PaneModel::from_core(&mut feed.model));
                        flow = pane.draw(&mut term).map(drop);
                    }
                    Outcome::Nothing | Outcome::Redraw => {}
                }
            }
            match flow.and_then(|()| pane.draw(&mut term).map(drop)) {
                Ok(()) => ControlFlow::Continue(()),
                Err(e) => {
                    failed = Some(format!("drawing failed: {e}"));
                    ControlFlow::Break(())
                }
            }
        },
        |line| logged.push(line),
    );
    drop(mouse);
    ratatui::restore();
    (logged.lines(), failed.map_or(Ok(()), Err))
}

/// Log lines held back while the pane draws: each distinct line once, in
/// the order first seen, with how many times it came. `at` indexes each
/// line's place in `seen`, so a push costs the same however many came.
#[derive(Default)]
struct Tally {
    seen: Vec<(String, usize)>,
    at: HashMap<String, usize>,
}

impl Tally {
    fn push(&mut self, line: String) {
        if let Some((_, n)) = self.at.get(&line).and_then(|&i| self.seen.get_mut(i)) {
            *n += 1;
            return;
        }
        self.at.insert(line.clone(), self.seen.len());
        self.seen.push((line, 1));
    }

    /// The lines to print: a repeated one ends with its count, "(x412)".
    fn lines(self) -> Vec<String> {
        self.seen
            .into_iter()
            .map(|(l, n)| if n > 1 { format!("{l} (x{n})") } else { l })
            .collect()
    }
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cockpit-pane: {e}");
            return ExitCode::from(2);
        }
    };
    let opts = Options {
        config: args.config.unwrap_or_else(default_config),
        after: args.after,
        wake: args.once.then_some(Duration::from_secs(1)),
    };
    match (args.print, args.once) {
        (true, true) => print_once(&opts),
        (true, false) => print_follow(&opts),
        (false, _) => {
            let (logged, outcome) = terminal(&opts);
            logged.iter().for_each(|l| eprintln!("cockpit-pane: {l}"));
            if let Err(e) = outcome {
                eprintln!("cockpit-pane: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_pane::runner::join::Change;

    fn args(s: &str) -> Result<Args, String> {
        let v: Vec<String> = s.split_whitespace().map(str::to_string).collect();
        parse_args(&v)
    }

    #[test]
    fn tallies_held_log_lines_once_each_in_the_order_first_seen() {
        let mut t = Tally::default();
        for l in [
            "pr-poll gh none",
            "pr-poll no branch",
            "pr-poll gh none",
            "pr-poll gh none",
        ] {
            t.push(l.to_string());
        }
        assert_eq!(t.lines(), ["pr-poll gh none (x3)", "pr-poll no branch"]);
        assert!(Tally::default().lines().is_empty());
    }

    #[test]
    fn reads_the_options() {
        let a = args("--print --once --after 42 --config /tmp/c").unwrap();
        assert_eq!(
            a,
            Args {
                print: true,
                once: true,
                after: 42,
                config: Some(PathBuf::from("/tmp/c")),
            }
        );
        assert!(!args("").unwrap().print);
    }

    #[test]
    fn refuses_bad_options() {
        assert!(args("--after").is_err());
        assert!(args("--after x").is_err());
        assert!(args("--config").is_err());
        assert!(args("--loud").is_err());
    }

    #[test]
    fn times_a_change_from_cmuxs_clock_and_from_the_read() {
        let l = Latency {
            change: Change {
                seq: 7,
                hook: "Stop".into(),
                at: Some(100.0),
            },
            read_at: Instant::now(),
        };
        let line = timing_line(&l, 100.25);
        assert!(
            line.starts_with("timing: seq 7 Stop: event to view 250 ms, read to view "),
            "{line}"
        );
    }
}
