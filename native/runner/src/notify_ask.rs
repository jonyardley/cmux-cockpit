//! Posts the core's desktop notifications (cockpit_core::notify, #379):
//! each as `cmux notify --workspace <id> --title <title> --body <body>
//! --json`, on its own thread, never on the ordered outbox worker, since
//! the core needs what it prints: the id cmux gave the notification,
//! which the core keeps to dismiss it once the wait clears. Each post
//! answers as `Input::Notified`, with the id, or none when cmux refused
//! it or never answered. The dismiss needs no answer, so it goes on the
//! worker (outbox.rs).

use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Duration;

use cockpit_core::persist::is_uuid;
use cockpit_core::pr_poll::Ran;
use cockpit_core::sleep::{NOT_SENT, TIMED_OUT, refusal_code};
use cockpit_core::{Notified, NotifyPost};
use serde_json::Value;

use super::Input;
use super::pr_ask::ran_within;

/// The longest a post may run: cmux answers at once.
pub const NOTIFY_LIMIT: Duration = Duration::from_secs(15);

/// The arguments to `cmux` that post `p`. Each value is its own
/// argument, never read as shell; the banner is cmux's default.
pub fn post_args(p: &NotifyPost) -> Vec<String> {
    vec![
        "notify".to_string(),
        "--workspace".to_string(),
        p.workspace.clone(),
        "--title".to_string(),
        p.title.clone(),
        "--body".to_string(),
        p.body.clone(),
        "--json".to_string(),
    ]
}

/// The id in what `cmux notify --json` printed,
/// `{"id": "74D64488-...", "surface_id": "...", "workspace_id": "..."}`;
/// None when it printed none in cmux's UUID shape.
pub fn id_of(stdout: &str) -> Option<String> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    let id = v.get("id")?.as_str()?;
    is_uuid(id).then(|| id.to_string())
}

/// How a post went, for the log: "ok", cmux's refusal code, or why it
/// never answered.
fn outcome(ran: &Ran, id: Option<&str>) -> String {
    match (ran.status, id) {
        (Some(0), Some(_)) => "ok".to_string(),
        (Some(0), None) => "no id".to_string(),
        (Some(_), _) => refusal_code(&ran.stderr),
        (None, _) if ran.missing => NOT_SENT.to_string(),
        (None, _) => TIMED_OUT.to_string(),
    }
}

/// The answer to a post from how its command ran, and the log line for
/// it: the outcome alone, never the words or the id.
pub fn answer_of(p: &NotifyPost, ran: &Ran) -> (Notified, String) {
    let id = (ran.status == Some(0))
        .then(|| id_of(&ran.stdout))
        .flatten();
    let line = format!("notify: {}", outcome(ran, id.as_deref()));
    let answer = Notified {
        workspace: p.workspace.clone(),
        since: p.since,
        id,
    };
    (answer, line)
}

/// Posts one notification.
pub fn run(p: &NotifyPost) -> (Notified, String) {
    let ran = ran_within("cmux", &post_args(p), None, &[], NOTIFY_LIMIT);
    answer_of(p, &ran)
}

/// Takes each post as it comes and runs it on its own thread, its answer
/// going back as an input after its log line.
pub fn serve(
    posts: &Receiver<NotifyPost>,
    tx: &Sender<Input>,
    run: fn(&NotifyPost) -> (Notified, String),
) {
    for post in posts {
        let tx = tx.clone();
        thread::spawn(move || {
            let (answer, line) = run(&post);
            let _ = tx.send(Input::Log(line));
            let _ = tx.send(Input::Notified(Box::new(answer)));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    const ID: &str = "74D64488-9CB8-4B8D-900F-1908FF44B8BB";

    fn post() -> NotifyPost {
        NotifyPost {
            workspace: "W1".into(),
            since: 1_791_229_800.0,
            title: "Docs layout".into(),
            body: "CI stuck 40m: rerun?".into(),
        }
    }

    fn ran(status: Option<i32>, stdout: &str, stderr: &str, missing: bool) -> Ran {
        Ran {
            status,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            missing,
        }
    }

    /// As cmux 0.65 printed it in the one smoke run, 13 November 2026.
    fn printed() -> String {
        format!(
            "{{\n  \"id\" : \"{ID}\",\n  \"surface_id\" : \"B10A1371-B812-4780-A835-5F0B86CBD696\",\n  \"workspace_id\" : \"AC255A66-2FA7-4D4A-AA65-ED0E1B5ED05B\"\n}}\n"
        )
    }

    #[test]
    fn posts_with_the_exact_cmux_command_line() {
        assert_eq!(
            post_args(&post()),
            [
                "notify",
                "--workspace",
                "W1",
                "--title",
                "Docs layout",
                "--body",
                "CI stuck 40m: rerun?",
                "--json"
            ]
        );
        let dash = NotifyPost {
            title: "--clear".into(),
            ..post()
        };
        assert_eq!(post_args(&dash)[4], "--clear", "a value stays one argument");
    }

    #[test]
    fn reads_the_id_cmux_prints_and_nothing_else() {
        assert_eq!(id_of(&printed()).as_deref(), Some(ID));
        assert_eq!(id_of(r#"{"id": "not-a-uuid"}"#), None);
        assert_eq!(id_of(r#"{"id": 7}"#), None);
        assert_eq!(id_of("OK"), None);
        assert_eq!(id_of(""), None);
    }

    #[test]
    fn answers_with_the_id_or_none_and_logs_only_the_outcome() {
        let (a, line) = answer_of(&post(), &ran(Some(0), &printed(), "", false));
        assert_eq!(
            (a.workspace.as_str(), a.since, a.id.as_deref()),
            ("W1", 1_791_229_800.0, Some(ID))
        );
        assert_eq!(line, "notify: ok");
        let refused = "Error: not_found: Workspace not found\n";
        let (a, line) = answer_of(&post(), &ran(Some(1), &printed(), refused, false));
        assert_eq!((a.id, line.as_str()), (None, "notify: not_found"));
        let (a, line) = answer_of(&post(), &ran(None, "", "", false));
        assert_eq!((a.id, line.as_str()), (None, "notify: timed_out"));
        let (_, line) = answer_of(&post(), &ran(None, "", "", true));
        assert_eq!(line, "notify: not_sent");
        let (a, line) = answer_of(&post(), &ran(Some(0), "{}", "", false));
        assert_eq!((a.id, line.as_str()), (None, "notify: no id"));
    }

    #[test]
    fn serves_each_post_and_sends_its_answer_back_as_an_input() {
        let (posts_tx, posts_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel();
        posts_tx.send(post()).unwrap();
        drop(posts_tx);
        let fake = |p: &NotifyPost| answer_of(p, &ran(Some(0), &printed(), "", false));
        serve(&posts_rx, &tx, fake);
        let mut got = None;
        while got.is_none() {
            match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                Input::Notified(a) => got = Some(a),
                Input::Log(line) => assert_eq!(line, "notify: ok"),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(got.unwrap().id.as_deref(), Some(ID));
    }
}
