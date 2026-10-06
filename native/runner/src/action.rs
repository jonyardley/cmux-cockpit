//! One of Jon's actions as a file: the Swift sidebar drops one into the
//! shared folder's outbox/ for cockpit-publish to hand the core
//! (publish.rs). The format is the core's own action events, in serde's
//! default JSON for an enum (externally tagged, as panel.json writes its
//! enums), so a file reads as the event it carries:
//!
//! ```json
//! {"MoveCard": {"id": "W1", "lane": "review", "before": null}}
//! {"SwitchTo": {"id": "W1"}}
//! "FlipView"
//! {"Menu": {"OpenCard": {"id": "W1"}}}
//! {"Menu": {"Pick": {"Lane": "parked"}}}
//! {"Menu": "Close"}
//! {"Edit": {"Name": "Cockpit"}}
//! "Next"
//! {"MessageAgent": {"id": "W1", "text": "Rebase when free."}}
//! ```
//!
//! Only actions parse: a frame, a state file or a PR answer cannot come
//! in this way, so a stray file can never stand in for cmux's data. An
//! unknown field is refused rather than ignored, so a typo shows in the
//! log instead of doing something else.

use cockpit_core::{EditEvent, Event, MenuEvent, lanes::LaneKey};
use serde::Deserialize;

/// An action file's contents: the subset of `Event` that `is_action`
/// accepts, with the same names and fields.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum Action {
    MoveCard {
        id: String,
        lane: LaneKey,
        before: Option<String>,
    },
    SwitchTo {
        id: String,
    },
    Dismiss {
        id: String,
    },
    FlipView,
    Edit(EditEvent),
    OpenProject {
        key: String,
    },
    FileForReview {
        id: String,
    },
    ParkMerged {
        id: String,
    },
    CloseMerged {
        id: String,
    },
    KeepMerged {
        id: String,
    },
    Menu(MenuEvent),
    Next,
    MessageAgent {
        id: String,
        text: String,
    },
}

impl Action {
    /// Reads one action file's text.
    pub fn parse(text: &str) -> Result<Action, String> {
        serde_json::from_str(text).map_err(|e| e.to_string())
    }

    /// Its name, for a log line: never its fields, which can hold a
    /// project's folder or a prompt.
    pub fn name(&self) -> &'static str {
        match self {
            Action::MoveCard { .. } => "MoveCard",
            Action::SwitchTo { .. } => "SwitchTo",
            Action::Dismiss { .. } => "Dismiss",
            Action::FlipView => "FlipView",
            Action::Edit(_) => "Edit",
            Action::OpenProject { .. } => "OpenProject",
            Action::FileForReview { .. } => "FileForReview",
            Action::ParkMerged { .. } => "ParkMerged",
            Action::CloseMerged { .. } => "CloseMerged",
            Action::KeepMerged { .. } => "KeepMerged",
            Action::Menu(_) => "Menu",
            Action::Next => "Next",
            Action::MessageAgent { .. } => "MessageAgent",
        }
    }
}

impl From<Action> for Event {
    fn from(a: Action) -> Event {
        match a {
            Action::MoveCard { id, lane, before } => Event::MoveCard { id, lane, before },
            Action::SwitchTo { id } => Event::SwitchTo { id },
            Action::Dismiss { id } => Event::Dismiss { id },
            Action::FlipView => Event::FlipView,
            Action::Edit(e) => Event::Edit(e),
            Action::OpenProject { key } => Event::OpenProject { key },
            Action::FileForReview { id } => Event::FileForReview { id },
            Action::ParkMerged { id } => Event::ParkMerged { id },
            Action::CloseMerged { id } => Event::CloseMerged { id },
            Action::KeepMerged { id } => Event::KeepMerged { id },
            Action::Menu(m) => Event::Menu(m),
            Action::Next => Event::Next,
            Action::MessageAgent { id, text } => Event::MessageAgent { id, text },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::menu::MenuAction;

    /// One file per variant, as the module's head documents them.
    const EVERY: [&str; 13] = [
        r#"{"MoveCard": {"id": "W1", "lane": "review", "before": null}}"#,
        r#"{"SwitchTo": {"id": "W1"}}"#,
        r#"{"Dismiss": {"id": "W1"}}"#,
        r#""FlipView""#,
        r#"{"Edit": {"Name": "Cockpit"}}"#,
        r#"{"OpenProject": {"key": "/dev/cockpit"}}"#,
        r#"{"FileForReview": {"id": "W1"}}"#,
        r#"{"ParkMerged": {"id": "W1"}}"#,
        r#"{"CloseMerged": {"id": "W1"}}"#,
        r#"{"KeepMerged": {"id": "W1"}}"#,
        r#"{"Menu": {"Pick": {"Lane": "parked"}}}"#,
        r#""Next""#,
        r#"{"MessageAgent": {"id": "W1", "text": "Rebase when free."}}"#,
    ];

    #[test]
    fn every_action_file_is_one_of_the_cores_actions() {
        for text in EVERY {
            let action = Action::parse(text).unwrap();
            let event: Event = action.into();
            assert!(event.is_action(), "{text} is not an action");
        }
    }

    /// The actions the Swift sidebar's outbox check encodes, one per
    /// variant of every nested event too: each must parse here.
    #[test]
    fn every_file_the_swift_sidebar_sends_parses() {
        let files: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/actions.json")).unwrap();
        let mut names: Vec<&str> = files
            .iter()
            .map(|v| {
                let action = Action::parse(&v.to_string()).unwrap_or_else(|e| panic!("{v}: {e}"));
                let name = action.name();
                assert!(Event::from(action).is_action(), "{v} is not an action");
                name
            })
            .collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), EVERY.len(), "actions.json misses a variant");
    }

    #[test]
    fn reads_a_move_and_the_nested_menu_and_editor_events() {
        assert_eq!(
            Action::parse(r#"{"MoveCard": {"id": "W1", "lane": "bg", "before": "W2"}}"#),
            Ok(Action::MoveCard {
                id: "W1".into(),
                lane: LaneKey::Bg,
                before: Some("W2".into()),
            })
        );
        assert_eq!(
            Action::parse(r#"{"Menu": {"Pick": {"Lane": "parked"}}}"#),
            Ok(Action::Menu(MenuEvent::Pick(MenuAction::Lane(
                LaneKey::Parked
            ))))
        );
        assert_eq!(
            Action::parse(r#"{"Menu": "Close"}"#),
            Ok(Action::Menu(MenuEvent::Close))
        );
        assert_eq!(
            Action::parse(r#"{"Edit": "Save"}"#),
            Ok(Action::Edit(EditEvent::Save))
        );
        assert_eq!(
            Action::parse(r#""FlipView""#).map(|a| a.name()),
            Ok("FlipView")
        );
    }

    #[test]
    fn refuses_input_events_unknown_fields_and_torn_files() {
        for bad in [
            r#"{"Data": {}}"#,
            r#"{"PrPollOn": null}"#,
            r#""Refresh""#,
            r#"{"MoveCard": {"id": "W1", "lane": "nowhere", "before": null}}"#,
            r#"{"SwitchTo": {"id": "W1", "extra": 1}}"#,
            r#"{"Menu": {"OpenCard": {"id": "W1", "typo": 1}}}"#,
            r#"{"Edit": {"AddSuggested": {"dir": "/a", "typo": 1}}}"#,
            r#"{"MessageAgent": {"id": "W1"}}"#,
            r#"{"MoveCard": {"id": "W1", "#,
            "",
        ] {
            assert!(Action::parse(bad).is_err(), "{bad} parsed");
        }
    }
}
