//! Carries out what the core asks of the world besides drawing, the way
//! the sidebar's own requests reach it:
//!
//! - a cmux call, as `cmux rpc <method> <params>`, the socket command the
//!   sidebar's `cmux(method, params)` sends;
//! - a state write, by opening its `cmux-cockpit://set` URL with the
//!   install's token (config/url-token), as the sidebar's `persistSet`
//!   does. The installed handler (scripts/state-set.ts) does the locked
//!   read-modify-write on config/state.json; the pane sees the result on
//!   its next check of the file;
//! - a link, such as the card menu's Open PR, opened in the browser;
//! - Jon's words for the agent in a workspace, as
//!   `cmux agent message <workspace> --from Cockpit -- <text>`. cmux
//!   delivers them through the agent's hooks; `--from` names the sender,
//!   since the headless publisher sits in no workspace of its own;
//! - the PR poll's answers for config/state.json's `prs` map (#300), as
//!   `scripts/pr-save.sh '<json>'` beside the config folder: it finds node
//!   and runs pr-save.ts, which writes them under the state file's lock
//!   and schedules the sidebars' rebuild, so it returns at once.
//!
//! One worker thread takes them in the order asked, so a reorder always
//! reaches cmux before the group join that follows it, and a slow cmux
//! never holds up a frame.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;

use cockpit_core::app::{AgentMessage, CmuxCall, OpenUrl, PrSave, StateSet};
use cockpit_core::session::Param;
use serde::Serialize;

/// A request the core made of the shell. Written out, it is the core's
/// effect as its bridge writes it, an effect file (effect.rs).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Outgoing {
    Cmux(CmuxCall),
    Persist(StateSet),
    /// A link to open in the browser.
    OpenUrl(OpenUrl),
    /// Words for the agent in a workspace.
    AgentMessage(AgentMessage),
    /// The PR poll's answers for the state file.
    SavePrs(PrSave),
}

/// Who a message says it is from.
pub const MESSAGE_FROM: &str = "Cockpit";

/// The script that saves the PR poll's answers: in the repo that holds
/// `config`, as the TypeScript poll's is.
pub fn pr_save_script(config: &Path) -> PathBuf {
    config
        .parent()
        .unwrap_or(config)
        .join("scripts")
        .join("pr-save.sh")
}

/// The program and arguments that carry out a request, or why it cannot
/// go: a state write with no token would only be refused by the handler.
pub fn command_for(
    o: &Outgoing,
    token: Option<&str>,
    config: &Path,
) -> Result<(String, Vec<String>), String> {
    match o {
        Outgoing::Cmux(call) => Ok((
            "cmux".to_string(),
            vec![
                "rpc".to_string(),
                call.method.clone(),
                call.params_json().to_string(),
            ],
        )),
        Outgoing::Persist(set) => {
            let Some(token) = token.filter(|t| !t.is_empty()) else {
                return Err(format!(
                    "state write {:?} not sent: no config/url-token yet (a build makes it)",
                    set.key
                ));
            };
            // -g leaves the handler in the background, so a tap never takes focus.
            Ok((
                "/usr/bin/open".to_string(),
                vec!["-g".to_string(), set.url(token)],
            ))
        }
        // In the foreground: Jon asked to see the page.
        // `-u` reads it as a link, never a file or a flag.
        Outgoing::OpenUrl(link) => Ok((
            "/usr/bin/open".to_string(),
            vec!["-u".to_string(), link.url.clone()],
        )),
        // `--` ends the flags, so words that start with a dash stay words.
        Outgoing::AgentMessage(m) => Ok((
            "cmux".to_string(),
            vec![
                "agent".to_string(),
                "message".to_string(),
                m.workspace.clone(),
                "--from".to_string(),
                MESSAGE_FROM.to_string(),
                "--".to_string(),
                m.text.clone(),
            ],
        )),
        Outgoing::SavePrs(save) => {
            let json =
                serde_json::to_string(&save.prs).map_err(|e| format!("pr save not sent: {e}"))?;
            Ok((
                "/bin/sh".to_string(),
                vec![pr_save_script(config).display().to_string(), json],
            ))
        }
    }
}

/// What a request is, for a log line: never a URL, so never the token.
fn describe(o: &Outgoing) -> String {
    match o {
        Outgoing::Cmux(call) => format!("cmux rpc {}", call.method),
        Outgoing::Persist(set) => format!("state write {:?}", set.key),
        Outgoing::OpenUrl(_) => "opening a link".to_string(),
        // Never the words: they are Jon's.
        Outgoing::AgentMessage(_) => "cmux agent message".to_string(),
        // How many, never which PR: a title can be anything.
        Outgoing::SavePrs(save) => format!("pr save of {}", save.prs.len()),
    }
}

/// The install's token, read afresh for each write so a first build that
/// makes it is picked up without a restart.
pub fn read_token(config: &Path) -> Option<String> {
    fs::read_to_string(config.join("url-token"))
        .ok()
        .map(|t| t.trim().to_string())
}

/// The workspace a cmux call is about, from its `workspace_id` param.
fn workspace_of(o: &Outgoing) -> Option<&str> {
    let Outgoing::Cmux(call) = o else { return None };
    call.params.iter().find_map(|(k, v)| match v {
        Param::Str(id) if k == "workspace_id" => Some(id.as_str()),
        _ => None,
    })
}

/// Where the worker reports back.
pub struct Reports<L: Fn(String), F: Fn(String)> {
    /// A line for each request that could not go or failed.
    pub log: L,
    /// The workspace of each cmux call about one that failed.
    pub failed: F,
}

/// Carries out each request as it arrives, in order, until the sending
/// side goes. `exec` runs a program and says whether it succeeded.
pub fn perform<L: Fn(String), F: Fn(String)>(
    rx: &Receiver<Outgoing>,
    config: &Path,
    exec: impl Fn(&str, &[String]) -> bool,
    reports: &Reports<L, F>,
) {
    let log = &reports.log;
    while let Ok(o) = rx.recv() {
        let token = match o {
            Outgoing::Persist(_) => read_token(config),
            Outgoing::Cmux(_)
            | Outgoing::OpenUrl(_)
            | Outgoing::AgentMessage(_)
            | Outgoing::SavePrs(_) => None,
        };
        match command_for(&o, token.as_deref(), config) {
            Ok((program, args)) => {
                if !exec(&program, &args) {
                    log(format!("{} failed or timed out", describe(&o)));
                    if let Some(id) = workspace_of(&o) {
                        (reports.failed)(id.to_string());
                    }
                }
            }
            Err(why) => log(why),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::sync::mpsc;

    fn reorder() -> Outgoing {
        Outgoing::Cmux(CmuxCall {
            method: "workspace.reorder".into(),
            params: vec![
                ("workspace_id".into(), Param::Str("a".into())),
                ("index".into(), Param::Num(4.0)),
            ],
        })
    }

    fn dismissal() -> Outgoing {
        Outgoing::Persist(StateSet {
            key: "dismissed.c".into(),
            value: Some(json!({ "s1": 900 })),
        })
    }

    #[test]
    fn a_cmux_call_goes_as_cmux_rpc_with_its_params_in_order() {
        let (program, args) = command_for(&reorder(), None, Path::new("/c")).unwrap();
        assert_eq!(program, "cmux");
        assert_eq!(
            args,
            [
                "rpc",
                "workspace.reorder",
                r#"{"workspace_id":"a","index":4}"#
            ]
        );
    }

    #[test]
    fn a_link_opens_in_the_foreground_and_its_log_line_leaves_the_url_out() {
        let link = Outgoing::OpenUrl(OpenUrl {
            url: "https://example.com/pr/7".into(),
        });
        let (program, args) = command_for(&link, None, Path::new("/c")).unwrap();
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(args, ["-u", "https://example.com/pr/7"]);
        assert_eq!(describe(&link), "opening a link");
        assert_eq!(workspace_of(&link), None);
    }

    #[test]
    fn a_message_goes_to_cmux_agent_message_with_the_words_after_the_flags() {
        let message = Outgoing::AgentMessage(AgentMessage {
            workspace: "W1".into(),
            text: "--help is not a flag here".into(),
        });
        let (program, args) = command_for(&message, None, Path::new("/c")).unwrap();
        assert_eq!(program, "cmux");
        assert_eq!(
            args,
            [
                "agent",
                "message",
                "W1",
                "--from",
                "Cockpit",
                "--",
                "--help is not a flag here"
            ]
        );
        assert_eq!(describe(&message), "cmux agent message");
        assert_eq!(
            workspace_of(&message),
            None,
            "a failed message never unpins a card's move"
        );
    }

    #[test]
    fn a_pr_save_runs_the_repos_script_with_the_answers_as_json() {
        let mut prs = std::collections::BTreeMap::new();
        prs.insert("W2".to_string(), None);
        let save = Outgoing::SavePrs(PrSave { prs });
        let (program, args) =
            command_for(&save, None, Path::new("/u/.config/cmux/config")).unwrap();
        assert_eq!(program, "/bin/sh");
        assert_eq!(
            args,
            ["/u/.config/cmux/scripts/pr-save.sh", r#"{"W2":null}"#]
        );
        assert_eq!(describe(&save), "pr save of 1");
        assert_eq!(workspace_of(&save), None);
    }

    #[test]
    fn a_state_write_opens_its_url_with_the_token_in_the_background() {
        let (program, args) = command_for(&dismissal(), Some("t0k"), Path::new("/c")).unwrap();
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(
            args,
            [
                "-g",
                "cmux-cockpit://set?key=dismissed.c&value=%7B%22s1%22%3A900%7D&token=t0k"
            ]
        );
    }

    #[test]
    fn a_state_write_without_a_token_is_not_sent_and_says_why_without_a_url() {
        for token in [None, Some("")] {
            let why = command_for(&dismissal(), token, Path::new("/c")).unwrap_err();
            assert!(why.contains("\"dismissed.c\"") && why.contains("url-token"));
            assert!(!why.contains("cmux-cockpit://"));
        }
    }

    #[test]
    fn performs_each_request_in_the_order_asked_and_reports_the_failures() {
        let dir = std::env::temp_dir().join(format!("cockpit-outbox-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("url-token"), "t0k\n").unwrap();
        let (tx, rx) = mpsc::channel();
        tx.send(reorder()).unwrap();
        tx.send(dismissal()).unwrap();
        let select = CmuxCall {
            method: "workspace.select".into(),
            params: vec![("workspace_id".into(), Param::Str("b".into()))],
        };
        tx.send(Outgoing::Cmux(select)).unwrap();
        drop(tx);
        let ran = RefCell::new(Vec::new());
        let logged = RefCell::new(Vec::new());
        let failed = RefCell::new(Vec::new());
        let reports = Reports {
            log: |line| logged.borrow_mut().push(line),
            failed: |id| failed.borrow_mut().push(id),
        };
        let exec = |program: &str, args: &[String]| {
            ran.borrow_mut()
                .push(format!("{program} {}", args.join(" ")));
            program == "cmux" && args[1] != "workspace.select"
        };
        perform(&rx, &dir, exec, &reports);
        fs::remove_dir_all(&dir).unwrap();
        let ran = ran.into_inner();
        assert_eq!(ran.len(), 3);
        assert!(ran[0].starts_with("cmux rpc workspace.reorder"));
        assert!(
            ran[1].ends_with("&token=t0k"),
            "the token is trimmed: {}",
            ran[1]
        );
        assert_eq!(
            logged.into_inner(),
            [
                r#"state write "dismissed.c" failed or timed out"#,
                "cmux rpc workspace.select failed or timed out"
            ]
        );
        assert_eq!(
            failed.into_inner(),
            ["b"],
            "a failed cmux call names its workspace"
        );
    }
}
