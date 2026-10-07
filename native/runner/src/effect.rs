//! One effect of the core in the sidebar as a file: the sidebar runs the
//! core itself and drops what it asks of the world into
//! the shared folder's outbox/, for cockpit-publish to carry out
//! (publish.rs). The format is the core's own effect as crux's JSON bridge
//! hands it to the shell, the `effect` of one request, so the sidebar
//! writes it as it came:
//!
//! ```json
//! {"Cmux": {"method": "workspace.reorder", "params": {"workspace_id": "W1", "index": 4}}}
//! {"Persist": {"key": "dismissed.W1", "value": {"s1": 900}}}
//! {"PrPoll": {"directory": "/dev/cockpit", "asked": 1791229864.5}}
//! {"OpenUrl": {"url": "https://github.com/o/r/pull/1"}}
//! {"AgentMessage": {"workspace": "W1", "text": "Rebase when free."}}
//! ```
//!
//! `Render` is the shell's own business and never comes this way. An
//! unknown field is refused rather than ignored, so a typo shows in the
//! log instead of doing something else. The answers
//! some of these bring back (a cmux call that failed, a PR) go to inbox/
//! (inbox.rs).

use cockpit_core::{AgentMessage, CmuxCall, OpenUrl, PrAsk, StateSet};
use serde::{Deserialize, Serialize};

/// An effect file's contents: every effect of the core but `Render`, with
/// the names and fields the bridge writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum EffectFile {
    Cmux(CmuxCall),
    Persist(StateSet),
    PrPoll(PrAsk),
    OpenUrl(OpenUrl),
    AgentMessage(AgentMessage),
}

impl EffectFile {
    /// Reads one effect file's text.
    pub fn parse(text: &str) -> Result<EffectFile, String> {
        serde_json::from_str(text).map_err(|e| e.to_string())
    }

    /// Its name, for a log line: never its fields, which can hold a URL,
    /// a folder or Jon's words.
    pub fn name(&self) -> &'static str {
        match self {
            EffectFile::Cmux(_) => "Cmux",
            EffectFile::Persist(_) => "Persist",
            EffectFile::PrPoll(_) => "PrPoll",
            EffectFile::OpenUrl(_) => "OpenUrl",
            EffectFile::AgentMessage(_) => "AgentMessage",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::session::Param;
    use cockpit_core::{Cockpit, Effect, Event};
    use crux_core::bridge::{Bridge, JsonFfiFormat};
    use crux_core::{Command, Core, EffectFFI};
    use serde_json::{Value, json};

    fn samples() -> Vec<Value> {
        serde_json::from_str(include_str!("../tests/effects.json")).unwrap()
    }

    /// Each effect's number, with no catch all: a new effect fails to
    /// compile here until it has one, then fails the test below until
    /// effects.json has it, which the Swift effects check reads too.
    fn number(e: &EffectFile) -> usize {
        match e {
            EffectFile::Cmux(_) => 0,
            EffectFile::Persist(_) => 1,
            EffectFile::PrPoll(_) => 2,
            EffectFile::OpenUrl(_) => 3,
            EffectFile::AgentMessage(_) => 4,
        }
    }
    const EFFECTS: usize = 5;

    /// The core's own effect for a file, as the core's update makes it.
    fn as_core(file: EffectFile) -> Effect {
        let mut cmd: Command<Effect, Event> = match file {
            EffectFile::Cmux(op) => Command::notify_shell(op).into(),
            EffectFile::Persist(op) => Command::notify_shell(op).into(),
            EffectFile::PrPoll(op) => Command::notify_shell(op).into(),
            EffectFile::OpenUrl(op) => Command::notify_shell(op).into(),
            EffectFile::AgentMessage(op) => Command::notify_shell(op).into(),
        };
        cmd.effects().next().unwrap()
    }

    #[test]
    fn effects_json_holds_every_effect_as_the_bridge_writes_it() {
        let mut seen = std::collections::BTreeSet::new();
        for want in samples() {
            let file =
                EffectFile::parse(&want.to_string()).unwrap_or_else(|e| panic!("{want}: {e}"));
            seen.insert(number(&file));
            assert_eq!(serde_json::to_value(&file).unwrap(), want, "written back");
            let (ffi, _) = as_core(file).serialize::<JsonFfiFormat>();
            assert_eq!(serde_json::to_value(ffi).unwrap(), want, "the bridge's");
        }
        for n in 0..EFFECTS {
            assert!(seen.contains(&n), "effects.json misses effect {n}");
        }
    }

    /// The effects a golden scene's clicks ask for, as the sidebar's bridge
    /// hands them out, each read as a file.
    #[test]
    fn what_the_bridge_hands_the_sidebar_reads_as_effect_files() {
        let bridge: Bridge<Cockpit, JsonFfiFormat> = Bridge::new(Core::new());
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/golden/review-verdicts.input.json"
        );
        let input: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut names = Vec::new();
        for event in [
            json!("PrPollOn"),
            json!({ "Projects": input["projects"] }),
            json!({ "State": input["state"] }),
            json!({ "Data": input["data"] }),
            json!({ "MoveCard": { "id": "ready", "lane": "review", "before": null } }),
            json!({ "MessageAgent": { "id": "ready", "text": "hi" } }),
            json!({ "Menu": { "OpenCard": { "id": "ready" } } }),
            json!({ "Menu": { "Pick": "OpenPr" } }),
            json!({ "Data": { "epoch": 1_000_100.0, "workspaces": [{ "id": "a", "directory": "/a" }] } }),
        ] {
            let mut out = Vec::new();
            bridge
                .update(event.to_string().as_bytes(), &mut out)
                .unwrap();
            let requests: Vec<Value> = serde_json::from_slice(&out).unwrap();
            for r in requests {
                if r["effect"].get("Render").is_some() {
                    continue;
                }
                let file = EffectFile::parse(&r["effect"].to_string()).unwrap();
                names.push(file.name());
            }
        }
        assert_eq!(names, ["Cmux", "AgentMessage", "OpenUrl", "PrPoll"]);
    }

    /// The helper's own requests write out as the same files, so one
    /// format serves both.
    #[test]
    fn the_workers_requests_write_out_as_effect_files() {
        use crate::outbox::Outgoing;
        for want in samples() {
            let out = match EffectFile::parse(&want.to_string()).unwrap() {
                EffectFile::PrPoll(_) => continue,
                EffectFile::Cmux(c) => Outgoing::Cmux(c),
                EffectFile::Persist(p) => Outgoing::Persist(p),
                EffectFile::OpenUrl(u) => Outgoing::OpenUrl(u),
                EffectFile::AgentMessage(m) => Outgoing::AgentMessage(m),
            };
            assert_eq!(serde_json::to_value(&out).unwrap(), want);
        }
    }

    #[test]
    fn reads_an_effect_and_refuses_an_action() {
        let call = EffectFile::parse(
            r#"{"Cmux": {"method": "workspace.select", "params": {"workspace_id": "W1"}}}"#,
        );
        assert_eq!(
            call,
            Ok(EffectFile::Cmux(CmuxCall {
                method: "workspace.select".into(),
                params: vec![("workspace_id".into(), Param::Str("W1".into()))],
            }))
        );
        assert!(EffectFile::parse(r#""FlipView""#).is_err());
    }

    #[test]
    fn refuses_render_unknown_fields_and_torn_files() {
        for bad in [
            r#"{"Render": null}"#,
            r#"{"Cmux": {"method": "m", "params": {}, "typo": 1}}"#,
            r#"{"Cmux": {"method": "m", "params": {"a": [1]}}}"#,
            r#"{"PrPoll": {"directory": "/a"}}"#,
            r#"{"OpenUrl": {"url": "u", "typo": 1}}"#,
            r#"{"AgentMessage": {"workspace": "W1", "text": "t", "from": "x"}}"#,
            r#"{"OpenUrl": "#,
            "",
        ] {
            assert!(EffectFile::parse(bad).is_err(), "{bad} parsed");
        }
    }
}
