//! `cockpit-pane`: the cockpit in a terminal pane, fed live by the shell
//! runner.
//!
//! `--print` runs headless: it prints the view model as text whenever it
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

use cockpit_pane::runner::{self, Latency, Options, Pane, text};

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

fn print_live(pane: &Pane, latency: Option<&Latency>, shown: &mut String) {
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

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cockpit-pane: {e}");
            return ExitCode::from(2);
        }
    };
    if !args.print {
        eprintln!("cockpit-pane: the terminal view arrives with #207; run with --print for now");
        return ExitCode::from(2);
    }
    let opts = Options {
        config: args.config.unwrap_or_else(default_config),
        after: args.after,
        wake: args.once.then_some(Duration::from_secs(1)),
    };
    let started = Instant::now();
    let mut shown = String::new();
    let log = |line: String| eprintln!("cockpit-pane: {line}");
    if args.once {
        runner::run(
            &opts,
            |pane, _| {
                let ready = pane.join.health.caught_up() && pane.join.loaded();
                if !ready && started.elapsed() < ONCE_LIMIT {
                    return ControlFlow::Continue(());
                }
                let note = if ready {
                    format!("replayed in {:.1}s", started.elapsed().as_secs_f32())
                } else {
                    format!("NOT fully replayed after {}s", ONCE_LIMIT.as_secs())
                };
                println!("{}{note}", text::render(pane));
                ControlFlow::Break(())
            },
            log,
        );
    } else {
        runner::run(
            &opts,
            |pane, latency| {
                print_live(pane, latency, &mut shown);
                ControlFlow::Continue(())
            },
            log,
        );
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
