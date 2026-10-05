//! `cockpit-publish`: the runner, headless, for the Swift sidebar. The
//! helper app starts it and it runs until that app goes: it writes the
//! panel model to panel.json in the shared folder after each change,
//! posts the "changed" signal, and takes actions from outbox/ (the
//! runner's publish.rs has the formats).
//!
//! Options: `--root <dir>` writes to another folder than the App Group's
//! (so does `COCKPIT_GROUP_DIR`, the flag winning); `--config <dir>`
//! reads state.json and projects.json from another folder than the main
//! checkout's; `--after <seq>` replays cmux events from a later sequence;
//! `--parent <pid>` names the process to stop with, which must be the
//! one that started it; the helper app passes its own, so it going before
//! this process looked is caught too. It defaults to whoever started it.
//!
//! It stops when its parent does, polling for that each wake: a stdin
//! pipe would need the helper app to wire one up, and an app's stdin is
//! /dev/null otherwise, which would read as gone at once.

use std::ops::ControlFlow;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use cockpit_runner::publish::{self, Parent, Publisher, ROOT_ENV};
use cockpit_runner::{self as runner, Options, signal};

/// How often the runner wakes with nothing new, to take the outbox and
/// check on the parent: an action shows within this, at a cost of a
/// directory read.
const WAKE: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq)]
struct Args {
    root: Option<PathBuf>,
    config: Option<PathBuf>,
    after: u64,
    parent: Option<u32>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut out = Args {
        root: None,
        config: None,
        after: 0,
        parent: None,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |what: &str| it.next().ok_or(format!("{a} needs {what}"));
        match a.as_str() {
            "--root" => out.root = Some(PathBuf::from(value("a folder")?)),
            "--config" => out.config = Some(PathBuf::from(value("a folder")?)),
            "--after" => {
                let n = value("a sequence")?;
                out.after = n
                    .parse()
                    .map_err(|_| format!("--after: not a number: {n}"))?;
            }
            "--parent" => {
                let n = value("a process id")?;
                out.parent = Some(
                    n.parse()
                        .map_err(|_| format!("--parent: not a process id: {n}"))?,
                );
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(out)
}

/// The shared folder: the flag, else the environment, else the App
/// Group's under home. None with nothing to go on.
fn root_of(flag: Option<PathBuf>, env: Option<String>, home: Option<&str>) -> Option<PathBuf> {
    flag.or_else(|| env.filter(|e| !e.is_empty()).map(PathBuf::from))
        .or_else(|| home.map(|h| publish::default_root(&PathBuf::from(h))))
}

fn log(line: String) {
    eprintln!("cockpit-publish: {line}");
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            log(e);
            return ExitCode::from(2);
        }
    };
    let Some(parent) = Parent::of(args.parent) else {
        log("its parent has already gone, so not starting".to_string());
        return ExitCode::FAILURE;
    };
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !cockpit_core::trim_slash(h).is_empty());
    let Some(root) = root_of(args.root, std::env::var(ROOT_ENV).ok(), home.as_deref()) else {
        log(format!(
            "no shared folder: pass --root or set {ROOT_ENV} or HOME"
        ));
        return ExitCode::from(2);
    };
    let signal = Box::new(|| signal::post(signal::CHANGED));
    let mut publisher = match Publisher::new(root.clone(), signal) {
        Ok(p) => p,
        Err(e) => {
            log(format!("{}: {e}", root.display()));
            return ExitCode::FAILURE;
        }
    };
    let config = args.config.unwrap_or_else(|| {
        PathBuf::from(home.as_deref().unwrap_or_default()).join(".config/cmux/config")
    });
    let opts = Options {
        config,
        after: args.after,
        wake: Some(WAKE),
        home,
    };
    log(format!("writing to {}", root.display()));
    let started = Instant::now();
    runner::run(
        &opts,
        runner::channel(),
        |feed, call| {
            if parent.gone() {
                log("parent gone, stopping".to_string());
                return ControlFlow::Break(());
            }
            if publish::ready(feed, started) {
                publisher.step(feed, call.fresh, &mut log);
            }
            ControlFlow::Continue(())
        },
        log,
    );
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        let owned: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        parse_args(&owned)
    }

    #[test]
    fn reads_each_option() {
        assert_eq!(
            args(&[
                "--root", "/tmp/r", "--config", "/tmp/c", "--after", "7", "--parent", "42"
            ]),
            Ok(Args {
                root: Some(PathBuf::from("/tmp/r")),
                config: Some(PathBuf::from("/tmp/c")),
                after: 7,
                parent: Some(42),
            })
        );
        assert!(args(&["--after", "x"]).is_err());
        assert!(args(&["--parent"]).is_err());
        assert!(args(&["--loud"]).is_err());
    }

    #[test]
    fn the_flag_beats_the_environment_beats_home() {
        let flag = Some(PathBuf::from("/flag"));
        let env = Some("/env".to_string());
        assert_eq!(
            root_of(flag, env.clone(), Some("/h")),
            Some(PathBuf::from("/flag"))
        );
        assert_eq!(root_of(None, env, Some("/h")), Some(PathBuf::from("/env")));
        assert_eq!(
            root_of(None, Some(String::new()), Some("/h")),
            Some(publish::default_root(&PathBuf::from("/h")))
        );
        assert_eq!(root_of(None, None, None), None);
    }
}
