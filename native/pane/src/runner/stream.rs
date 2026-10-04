//! Follows `cmux events`: replay from a sequence, then live, reconnecting
//! itself rather than with `--reconnect`. After a cmux restart the
//! sequence starts at 1 again, so a new boot id on the ack means replay
//! the new run from 0 instead of skipping up to the old sequence (the
//! spike's boot check). The process sits behind `EventSource`, so the
//! reconnect logic runs against a fake stream in the tests.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::Input;

/// The first wait before reconnecting; it doubles to `RETRY_MAX` while
/// the stream keeps failing, and starts over once a connection acks.
pub const RETRY_FIRST: Duration = Duration::from_secs(1);
pub const RETRY_MAX: Duration = Duration::from_secs(8);

/// Somewhere to read event lines from.
pub trait EventSource {
    /// Opens a stream replaying events after `after`.
    fn open(&mut self, after: u64) -> Result<Box<dyn BufRead + Send>, String>;
    /// Why the last stream ended, once it has.
    fn ended(&mut self) -> String;
    /// Waits before the next try; false gives up (tests only).
    fn pause(&mut self, d: Duration) -> bool;
}

/// How one connection ended.
#[derive(Debug, PartialEq, Eq)]
enum End {
    /// The runner has gone.
    Closed,
    /// cmux restarted since our last sequence: start again from 0.
    Restarted,
    /// The stream ended; `acked` says whether it got as far as its ack.
    Exited { acked: bool },
}

/// Follows the stream until the runner goes or the source gives up.
pub fn follow(source: &mut dyn EventSource, mut after: u64, tx: &Sender<Input>) {
    let mut boot: Option<String> = None;
    let mut wait = RETRY_FIRST;
    loop {
        let why = match source.open(after) {
            Ok(lines) => match read(lines, &mut after, &mut boot, tx) {
                End::Closed => return,
                End::Restarted => {
                    after = 0;
                    continue;
                }
                End::Exited { acked } => {
                    if acked {
                        wait = RETRY_FIRST;
                    }
                    source.ended()
                }
            },
            Err(why) => why,
        };
        if tx.send(Input::StreamDown(why)).is_err() || !source.pause(wait) {
            return;
        }
        wait = (wait * 2).min(RETRY_MAX);
    }
}

/// Reads frames until the stream ends or something ends it early.
fn read(
    lines: Box<dyn BufRead + Send>,
    after: &mut u64,
    boot: &mut Option<String>,
    tx: &Sender<Input>,
) -> End {
    let mut acked = false;
    for line in lines.lines().map_while(Result::ok) {
        let read_at = Instant::now();
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("resume").is_some() {
            let this_boot = v["boot_id"].as_str().unwrap_or_default().to_string();
            if *after > 0 && boot.as_ref().is_some_and(|b| *b != this_boot) {
                return End::Restarted;
            }
            *boot = Some(this_boot);
            acked = true;
        } else if let Some(seq) = v["seq"].as_u64() {
            *after = seq;
        }
        if tx.send(Input::Event(Box::new(v), read_at)).is_err() {
            return End::Closed;
        }
    }
    End::Exited { acked }
}

/// The real `cmux events` process. The child is shared so the runner can
/// stop it on the way out.
#[derive(Debug, Default, Clone)]
pub struct CmuxEvents {
    pub child: Arc<Mutex<Option<Child>>>,
}

impl CmuxEvents {
    /// Stops the current `cmux events`, if one runs, and says how it ended.
    pub fn stop(&self) -> String {
        let Ok(mut slot) = self.child.lock() else {
            return "cmux events: lost track of the process".to_string();
        };
        let Some(mut child) = slot.take() else {
            return "cmux events was not running".to_string();
        };
        let _ = child.kill();
        match child.wait() {
            Ok(status) => format!("cmux events exited ({status})"),
            Err(e) => format!("cmux events exited ({e})"),
        }
    }
}

impl EventSource for CmuxEvents {
    fn open(&mut self, after: u64) -> Result<Box<dyn BufRead + Send>, String> {
        self.stop();
        let mut child = Command::new("cmux")
            .args(["events", "--no-heartbeat", "--after", &after.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("cmux events did not start: {e}"))?;
        let stdout = child.stdout.take().ok_or("cmux events gave no output")?;
        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
        }
        Ok(Box::new(BufReader::new(stdout)))
    }

    fn ended(&mut self) -> String {
        self.stop()
    }

    fn pause(&mut self, d: Duration) -> bool {
        thread::sleep(d);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc;

    /// A scripted stream: each open hands out the next connection's lines,
    /// or fails; once the script runs out, it gives up.
    struct Fake {
        script: Vec<Result<String, String>>,
        opened_after: Vec<u64>,
        pauses: Vec<Duration>,
    }

    impl Fake {
        fn new(script: Vec<Result<&str, &str>>) -> Fake {
            let script = script
                .into_iter()
                .rev()
                .map(|c| c.map(str::to_string).map_err(str::to_string))
                .collect();
            Fake {
                script,
                opened_after: Vec::new(),
                pauses: Vec::new(),
            }
        }
    }

    impl EventSource for Fake {
        fn open(&mut self, after: u64) -> Result<Box<dyn BufRead + Send>, String> {
            self.opened_after.push(after);
            match self.script.pop() {
                Some(Ok(text)) => Ok(Box::new(Cursor::new(text))),
                Some(Err(why)) => Err(why),
                None => Err("script done".to_string()),
            }
        }

        fn ended(&mut self) -> String {
            "killed".to_string()
        }

        fn pause(&mut self, d: Duration) -> bool {
            self.pauses.push(d);
            !self.script.is_empty()
        }
    }

    fn ack(boot: &str, after: u64, latest: u64) -> String {
        format!(
            r#"{{"boot_id":"{boot}","type":"ack","resume":{{"requested_after_seq":{after},"latest_seq":{latest}}}}}"#
        )
    }

    fn ev(seq: u64) -> String {
        format!(r#"{{"type":"event","seq":{seq},"name":"agent.hook.Stop"}}"#)
    }

    /// What reached the runner: "ack", the event's seq, or "down: why".
    fn run(fake: &mut Fake, after: u64) -> Vec<String> {
        let (tx, rx) = mpsc::channel();
        follow(fake, after, &tx);
        drop(tx);
        rx.iter()
            .map(|i| match i {
                Input::Event(v, _) if v.get("resume").is_some() => "ack".to_string(),
                Input::Event(v, _) => v["seq"].to_string(),
                Input::StreamDown(why) => format!("down: {why}"),
                _ => "other".to_string(),
            })
            .collect()
    }

    #[test]
    fn a_killed_stream_shows_as_down_then_resumes_after_its_last_sequence() {
        let first = [ack("B", 0, 2), ev(1), ev(2)].join("\n");
        let second = [ack("B", 2, 3), ev(3)].join("\n");
        let mut fake = Fake::new(vec![Ok(&first), Ok(&second)]);
        let got = run(&mut fake, 0);
        assert_eq!(
            got,
            vec!["ack", "1", "2", "down: killed", "ack", "3", "down: killed"]
        );
        assert_eq!(fake.opened_after, vec![0, 2]);
    }

    #[test]
    fn a_new_boot_replays_from_zero_without_a_down_line() {
        let first = [ack("OLD", 0, 5), ev(5)].join("\n");
        let restarted = [ack("NEW", 5, 1), ev(1)].join("\n");
        let fresh = [ack("NEW", 0, 1), ev(1)].join("\n");
        let mut fake = Fake::new(vec![Ok(&first), Ok(&restarted), Ok(&fresh)]);
        let got = run(&mut fake, 0);
        assert_eq!(fake.opened_after, vec![0, 5, 0]);
        assert_eq!(
            got,
            vec!["ack", "5", "down: killed", "ack", "1", "down: killed"],
            "the restarted connection's ack is dropped, not passed on"
        );
    }

    #[test]
    fn retries_back_off_while_cmux_is_away_and_start_over_after_an_ack() {
        let ok = ack("B", 0, 0);
        let mut fake = Fake::new(vec![
            Err("no cmux"),
            Err("no cmux"),
            Err("no cmux"),
            Err("no cmux"),
            Err("no cmux"),
            Ok(&ok),
            Err("no cmux"),
        ]);
        run(&mut fake, 0);
        let secs: Vec<u64> = fake.pauses.iter().map(Duration::as_secs).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 8, 1, 2]);
    }

    #[test]
    fn skips_lines_that_are_not_json() {
        let text = [ack("B", 0, 1), "not json".to_string(), ev(1)].join("\n");
        let mut fake = Fake::new(vec![Ok(&text)]);
        assert_eq!(run(&mut fake, 0)[..2], ["ack", "1"]);
    }

    #[test]
    fn stops_when_the_runner_has_gone() {
        let text = [ack("B", 0, 1), ev(1)].join("\n");
        let mut fake = Fake::new(vec![Ok(&text), Ok(&text)]);
        let (tx, rx) = mpsc::channel();
        drop(rx);
        follow(&mut fake, 0, &tx);
        assert_eq!(
            fake.opened_after,
            vec![0],
            "no reconnect once nobody listens"
        );
    }
}
