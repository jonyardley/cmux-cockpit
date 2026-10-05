//! Carries out the core's PR asks (`Effect::PrPoll`), each on its own
//! thread so a slow `gh` never holds up a frame: `git` for the
//! directory's branch, then `gh` for that branch's PRs, the commands and
//! limits scripts/pr-poll.ts uses, read by the core's rules
//! (pr_poll::answer). Every failure is an answer, never a panic, and the
//! log line names only what kind of answer it was: no branch, title, URL
//! or anything gh printed, so no token can reach the log.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use cockpit_core::pr_poll::{PollAnswer, PrPolled, Ran, answer, gh_args, git_args};

use super::{Input, now_epoch};

/// The longest `git` or `gh` may run before it is killed (TIMEOUT_MS).
pub const LIMIT: Duration = Duration::from_secs(15);
/// How often a running command is checked on.
const CHECK_EVERY: Duration = Duration::from_millis(50);
/// How long the output may take to drain once the command has ended.
const DRAIN: Duration = Duration::from_secs(1);

/// The tool's usual install path when it has one, else its name for PATH.
fn tool(name: &str, fallbacks: &[&str]) -> String {
    fallbacks
        .iter()
        .find(|p| Path::new(p).exists())
        .map_or_else(|| name.to_string(), |p| (*p).to_string())
}

/// Reads a pipe to the end on its own thread, so a large output never fills it.
fn drain(pipe: Option<impl Read + Send + 'static>) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut pipe) = pipe {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
        });
    }
    rx
}

/// Waits for the child until `limit`, killing it past that. The exit
/// code, or None when it was killed or could not be waited on.
fn wait_within(child: &mut Child, limit: Duration) -> Option<i32> {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(CHECK_EVERY),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Runs a command with gh's prompts off, as the TypeScript's spawn does,
/// and gives back what it said. A program that is not there is `missing`.
pub fn ran_within(program: &str, args: &[String], cwd: Option<&str>, limit: Duration) -> Ran {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CMUX_QUIET", "1")
        .env("GH_PROMPT_DISABLED", "1");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Ran {
                missing: e.kind() == std::io::ErrorKind::NotFound,
                ..Ran::default()
            };
        }
    };
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let status = wait_within(&mut child, limit);
    // A grandchild holding a pipe open must not hold the answer up.
    let read = |rx: Receiver<String>| rx.recv_timeout(DRAIN).unwrap_or_default();
    Ran {
        status,
        stdout: read(stdout),
        stderr: read(stderr),
        missing: false,
    }
}

/// The real ask: `git` for the branch, then `gh` for its PR.
pub fn ask(directory: &str) -> PollAnswer {
    let git = tool("git", &["/opt/homebrew/bin/git", "/usr/bin/git"]);
    let gh = tool("gh", &["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
    let branch = ran_within(&git, &git_args(directory), Some(directory), LIMIT);
    answer(&branch, |b| {
        ran_within(&gh, &gh_args(b), Some(directory), LIMIT)
    })
}

/// The log line for an answer: whether gh was asked, and what kind of answer came.
pub fn log_line(a: &PollAnswer) -> String {
    let asked_gh = matches!(a, PollAnswer::Answered { .. } | PollAnswer::Failed { .. });
    let via = if asked_gh { "gh " } else { "" };
    format!("pr-poll {via}{}", a.log_word())
}

/// Takes each directory from `asks` and answers it on a thread of its
/// own (the core keeps at most two out), sending the answer and its log
/// line back as inputs. Ends once the feed lets go of `asks`.
pub fn serve(asks: &Receiver<String>, tx: &Sender<Input>, ask: fn(&str) -> PollAnswer) {
    for directory in asks {
        let tx = tx.clone();
        thread::spawn(move || {
            let answer = ask(&directory);
            let _ = tx.send(Input::Log(log_line(&answer)));
            let polled = PrPolled {
                directory,
                answer,
                epoch: now_epoch(),
            };
            let _ = tx.send(Input::PrPolled(Box::new(polled)));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::pr_poll::GhFailure;

    #[test]
    fn a_command_that_hangs_is_killed_and_one_not_there_is_missing() {
        let start = Instant::now();
        let hung = ran_within(
            "sleep",
            &["5".to_string()],
            None,
            Duration::from_millis(100),
        );
        assert_eq!(hung.status, None);
        assert!(start.elapsed() < Duration::from_secs(3));
        let gone = ran_within("no-such-tool-here", &[], None, LIMIT);
        assert!(gone.missing);
        let said = ran_within(
            "sh",
            &["-c".into(), "echo out; echo err >&2; exit 3".into()],
            None,
            LIMIT,
        );
        assert_eq!(
            (said.status, said.stdout.as_str(), said.stderr.as_str()),
            (Some(3), "out\n", "err\n")
        );
    }

    #[test]
    fn a_log_line_never_carries_what_gh_printed() {
        let failed = PollAnswer::Failed {
            branch: "secret-branch".into(),
            why: GhFailure::SignedOut,
        };
        assert_eq!(log_line(&failed), "pr-poll gh signed-out");
        assert_eq!(log_line(&PollAnswer::NoBranch), "pr-poll no branch");
    }

    #[test]
    fn each_ask_comes_back_as_its_answer() {
        let (ask_tx, ask_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel();
        ask_tx.send("/a".to_string()).unwrap();
        drop(ask_tx);
        serve(&ask_rx, &tx, |_| PollAnswer::GitFailed);
        let mut got = Vec::new();
        while got.len() < 2 {
            got.push(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        assert!(matches!(&got[0], Input::Log(l) if l == "pr-poll git failed"));
        assert!(
            matches!(&got[1], Input::PrPolled(p) if p.directory == "/a" && p.answer == PollAnswer::GitFailed)
        );
    }
}
