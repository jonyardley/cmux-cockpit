//! Carries out what the core asks of the world besides drawing, the way
//! the sidebar's own requests reach it:
//!
//! - a cmux call, as `cmux rpc <method> <params>`, the socket command the
//!   sidebar's `cmux(method, params)` sends;
//! - a state write, by opening its `cmux-cockpit://set` URL with the
//!   install's token (config/url-token), as the sidebar's `persistSet`
//!   does. The installed handler (scripts/state-set.ts) does the locked
//!   read-modify-write on config/state.json; the pane sees the result on
//!   its next check of the file.
//!
//! One worker thread takes them in the order asked, so a reorder always
//! reaches cmux before the group join that follows it, and a slow cmux
//! never holds up a frame.

use std::fs;
use std::path::Path;
use std::sync::mpsc::Receiver;

use cockpit_core::app::{CmuxCall, StateSet};

/// A request the core made of the shell.
#[derive(Debug, Clone, PartialEq)]
pub enum Outgoing {
    Cmux(CmuxCall),
    Persist(StateSet),
}

/// The program and arguments that carry out a request, or why it cannot
/// go: a state write with no token would only be refused by the handler.
pub fn command_for(o: &Outgoing, token: Option<&str>) -> Result<(String, Vec<String>), String> {
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
    }
}

/// What a request is, for a log line: never a URL, so never the token.
fn describe(o: &Outgoing) -> String {
    match o {
        Outgoing::Cmux(call) => format!("cmux rpc {}", call.method),
        Outgoing::Persist(set) => format!("state write {:?}", set.key),
    }
}

/// The install's token, read afresh for each write so a first build that
/// makes it is picked up without a restart.
pub fn read_token(config: &Path) -> Option<String> {
    fs::read_to_string(config.join("url-token"))
        .ok()
        .map(|t| t.trim().to_string())
}

/// Carries out each request as it arrives, in order, until the sending
/// side goes. `exec` runs a program and says whether it succeeded; `log`
/// takes a line for each one that could not go or failed.
pub fn perform(
    rx: &Receiver<Outgoing>,
    config: &Path,
    exec: impl Fn(&str, &[String]) -> bool,
    log: impl Fn(String),
) {
    while let Ok(o) = rx.recv() {
        let token = match o {
            Outgoing::Persist(_) => read_token(config),
            Outgoing::Cmux(_) => None,
        };
        match command_for(&o, token.as_deref()) {
            Ok((program, args)) => {
                if !exec(&program, &args) {
                    log(format!("{} failed or timed out", describe(&o)));
                }
            }
            Err(why) => log(why),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::session::Param;
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
        let (program, args) = command_for(&reorder(), None).unwrap();
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
    fn a_state_write_opens_its_url_with_the_token_in_the_background() {
        let (program, args) = command_for(&dismissal(), Some("t0k")).unwrap();
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
            let why = command_for(&dismissal(), token).unwrap_err();
            assert!(why.contains("\"dismissed.c\"") && why.contains("url-token"));
            assert!(!why.contains("cmux-cockpit://"));
        }
    }

    #[test]
    fn performs_each_request_in_the_order_asked_and_logs_the_failures() {
        let dir = std::env::temp_dir().join(format!("cockpit-outbox-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("url-token"), "t0k\n").unwrap();
        let (tx, rx) = mpsc::channel();
        tx.send(reorder()).unwrap();
        tx.send(dismissal()).unwrap();
        drop(tx);
        let ran = RefCell::new(Vec::new());
        let logged = RefCell::new(Vec::new());
        perform(
            &rx,
            &dir,
            |program, args| {
                ran.borrow_mut()
                    .push(format!("{program} {}", args.join(" ")));
                program == "cmux"
            },
            |line| logged.borrow_mut().push(line),
        );
        fs::remove_dir_all(&dir).unwrap();
        let ran = ran.into_inner();
        assert_eq!(ran.len(), 2);
        assert!(ran[0].starts_with("cmux rpc workspace.reorder"));
        assert!(
            ran[1].ends_with("&token=t0k"),
            "the token is trimmed: {}",
            ran[1]
        );
        assert_eq!(
            logged.into_inner(),
            [r#"state write "dismissed.c" failed or timed out"#]
        );
    }
}
