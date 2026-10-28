//! Carries out the core's sleep calls (cockpit_core::sleep): a cmux call
//! to `agent.hibernate` or `agent.wake`, each on its own thread, never on
//! the ordered outbox worker. A hibernate can take cmux up to two minutes
//! (it saves the transcript and waits for the agent to exit), so it must
//! not hold up a reorder, nor be killed at the worker's ten seconds, which
//! would leave cmux putting an agent to sleep the core thinks refused.
//! Nor may a refusal reach the core as a failed cmux call, which would
//! snap the card back out of Parked: each call answers as `Input::Slept`
//! with cmux's refusal code, read from what `cmux rpc` prints on a
//! refusal ("Error: visible: This agent is on screen.").

use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Duration;

use cockpit_core::CmuxCall;
use cockpit_core::pr_poll::Ran;
use cockpit_core::sleep::{NOT_SENT, SleepAnswer, TIMED_OUT, refusal_code, sleep_call};

use super::Input;
use super::pr_ask::ran_within;

/// The longest a hibernate may run: cmux's own wait is 120 seconds.
pub const HIBERNATE_LIMIT: Duration = Duration::from_secs(125);
/// The longest a wake may run: cmux's own wait is 30 seconds.
pub const WAKE_LIMIT: Duration = Duration::from_secs(35);

/// The answer to a sleep call from how its command ran.
pub fn answer_of(wake: bool, workspace: String, surface: String, ran: &Ran) -> SleepAnswer {
    let refused = match ran.status {
        Some(0) => None,
        Some(_) => Some(refusal_code(&ran.stderr)),
        None if ran.missing => Some(NOT_SENT.to_string()),
        None => Some(TIMED_OUT.to_string()),
    };
    SleepAnswer {
        workspace,
        surface,
        wake,
        refused,
    }
}

/// Runs one sleep call as `cmux rpc <method> <params>`. None for a call
/// that is not one.
pub fn run(call: &CmuxCall) -> Option<SleepAnswer> {
    let (wake, workspace, surface) = sleep_call(call)?;
    let limit = if wake { WAKE_LIMIT } else { HIBERNATE_LIMIT };
    let args = vec![
        "rpc".to_string(),
        call.method.clone(),
        call.params_json().to_string(),
    ];
    let ran = ran_within("cmux", &args, None, &[], limit);
    Some(answer_of(wake, workspace, surface, &ran))
}

/// The log line for an answer: the call and cmux's code, never a message.
pub fn log_line(a: &SleepAnswer) -> String {
    let what = if a.wake { "wake" } else { "hibernate" };
    format!("{what}: {}", a.refused.as_deref().unwrap_or("ok"))
}

/// Takes each sleep call as it comes and runs it on its own thread, its
/// answer going back as an input.
pub fn serve(
    calls: &Receiver<CmuxCall>,
    tx: &Sender<Input>,
    run: fn(&CmuxCall) -> Option<SleepAnswer>,
) {
    for call in calls {
        let tx = tx.clone();
        thread::spawn(move || {
            if let Some(answer) = run(&call) {
                let _ = tx.send(Input::Log(log_line(&answer)));
                let _ = tx.send(Input::Slept(Box::new(answer)));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::session::Param;
    use std::sync::mpsc;

    fn ran(status: Option<i32>, stderr: &str, missing: bool) -> Ran {
        Ran {
            status,
            stdout: String::new(),
            stderr: stderr.to_string(),
            missing,
        }
    }

    fn answer(r: &Ran) -> Option<String> {
        answer_of(false, "W1".into(), "S1".into(), r).refused
    }

    #[test]
    fn reads_ok_a_refusal_a_time_out_and_a_missing_cmux() {
        assert_eq!(answer(&ran(Some(0), "", false)), None);
        // As cmux 0.65.2 prints it, seen with a surface that cannot exist.
        let said = "Error: surface_not_found: No terminal matches that surface.\n";
        assert_eq!(
            answer(&ran(Some(1), said, false)).as_deref(),
            Some("surface_not_found")
        );
        assert_eq!(answer(&ran(Some(1), "", false)).as_deref(), Some(NOT_SENT));
        assert_eq!(answer(&ran(None, "", false)).as_deref(), Some(TIMED_OUT));
        assert_eq!(answer(&ran(None, "", true)).as_deref(), Some(NOT_SENT));
    }

    #[test]
    fn logs_the_code_and_never_cmuxs_words() {
        let a = answer_of(
            true,
            "W1".into(),
            "S1".into(),
            &ran(Some(1), "Error: resume_unavailable: secret words", false),
        );
        assert_eq!(log_line(&a), "wake: resume_unavailable");
    }

    #[test]
    fn serves_each_call_and_sends_its_answer_back_as_an_input() {
        let (calls_tx, calls_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel();
        calls_tx
            .send(CmuxCall {
                method: "agent.hibernate".into(),
                params: vec![
                    ("surface_id".into(), Param::Str("S1".into())),
                    ("workspace_id".into(), Param::Str("W1".into())),
                ],
            })
            .unwrap();
        drop(calls_tx);
        let fake = |call: &CmuxCall| {
            let (wake, ws, surface) = sleep_call(call)?;
            Some(answer_of(
                wake,
                ws,
                surface,
                &ran(Some(1), "Error: visible: x", false),
            ))
        };
        serve(&calls_rx, &tx, fake);
        let mut got = None;
        while got.is_none() {
            match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                Input::Slept(a) => got = Some(a),
                Input::Log(line) => assert_eq!(line, "hibernate: visible"),
                other => panic!("{other:?}"),
            }
        }
        let a = got.unwrap();
        assert_eq!(
            (
                a.workspace.as_str(),
                a.surface.as_str(),
                a.refused.as_deref()
            ),
            ("W1", "S1", Some("visible"))
        );
    }
}
