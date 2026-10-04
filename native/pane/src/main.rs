//! `cockpit-pane`: the cockpit in a terminal pane, fed live by the shell
//! runner.
//!
//! With no options it draws the All view in the terminal (up and down
//! move between cards, `?` shows the keys, `q` quits). `--print` runs
//! headless: it prints the view model as text whenever it
//! changes, and logs on stderr how long each status change took to reach
//! it. `--once` prints once replay has caught up and both polls have
//! answered, then exits. `--config <dir>` reads state.json and
//! projects.json from another folder; `--after <seq>` replays from a
//! later sequence.

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

/// `--print --once`: prints once replay has caught up and both polls
/// have answered, or after `ONCE_LIMIT` whatever it has.
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
                format!("NOT fully replayed after {}s", ONCE_LIMIT.as_secs())
            };
            println!("{}{note}", text::render(feed));
            ControlFlow::Break(())
        },
        |line| eprintln!("cockpit-pane: {line}"),
    );
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

/// The terminal view: draws each new frame, and hands every key and
/// resize to the pane. A thread reads the terminal and pokes the runner,
/// so a key is answered at once without the runner waking on a timer.
/// Log lines would tear the screen, so they wait until it is restored.
fn terminal(opts: &Options) -> Result<Vec<String>, String> {
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
    let mut term = ratatui::try_init().map_err(|e| format!("no terminal: {e}"))?;
    let mut pane = Pane::new(PaneModel::default());
    let mut logged = Vec::new();
    let mut failed = None;
    runner::run(
        opts,
        (tx, rx),
        |feed, call| {
            if call.fresh {
                pane.set_view_model(PaneModel::from_core(&mut feed.model));
            }
            for e in keys_rx.try_iter() {
                if pane.handle_event(&e) == Outcome::Quit {
                    return ControlFlow::Break(());
                }
            }
            match pane.draw(&mut term) {
                Ok(_) => ControlFlow::Continue(()),
                Err(e) => {
                    failed = Some(format!("drawing failed: {e}"));
                    ControlFlow::Break(())
                }
            }
        },
        |line| logged.push(line),
    );
    ratatui::restore();
    failed.map_or(Ok(logged), Err)
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
        (false, _) => match terminal(&opts) {
            Ok(logged) => logged.iter().for_each(|l| eprintln!("cockpit-pane: {l}")),
            Err(e) => {
                eprintln!("cockpit-pane: {e}");
                return ExitCode::FAILURE;
            }
        },
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
