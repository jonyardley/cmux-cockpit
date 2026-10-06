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
//! {"ToggleLane": {"lane": "main"}}
//! {"ToggleProject": {"key": "/dev/cockpit"}}
//! "ToggleQuiet"
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
    ToggleLane {
        lane: LaneKey,
    },
    ToggleProject {
        key: String,
    },
    ToggleQuiet,
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
            Action::ToggleLane { .. } => "ToggleLane",
            Action::ToggleProject { .. } => "ToggleProject",
            Action::ToggleQuiet => "ToggleQuiet",
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
            Action::ToggleLane { lane } => Event::ToggleLane { lane },
            Action::ToggleProject { key } => Event::ToggleProject { key },
            Action::ToggleQuiet => Event::ToggleQuiet,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::menu::MenuAction;

    /// One file per variant, as the module's head documents them.
    const EVERY: [&str; 16] = [
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
        r#"{"ToggleLane": {"lane": "main"}}"#,
        r#"{"ToggleProject": {"key": "/dev/cockpit"}}"#,
        r#""ToggleQuiet""#,
    ];

    #[test]
    fn every_action_file_is_one_of_the_cores_actions() {
        for text in EVERY {
            let action = Action::parse(text).unwrap();
            let event: Event = action.into();
            assert!(event.is_action(), "{text} is not an action");
        }
    }

    /// Every variant a file names, down through the nested events, as
    /// (group, its number, how many the group has). Each match lists every
    /// variant with no catch all, so a new one in Rust fails to compile
    /// here until it has a number, then fails the test below until
    /// actions.json has it, and so the Swift outbox check, which encodes
    /// one action per entry of that file.
    fn variants(a: &Action) -> Vec<(&'static str, usize, usize)> {
        let top = match a {
            Action::MoveCard { .. } => 0,
            Action::SwitchTo { .. } => 1,
            Action::Dismiss { .. } => 2,
            Action::FlipView => 3,
            Action::Edit(_) => 4,
            Action::OpenProject { .. } => 5,
            Action::FileForReview { .. } => 6,
            Action::ParkMerged { .. } => 7,
            Action::CloseMerged { .. } => 8,
            Action::KeepMerged { .. } => 9,
            Action::Menu(_) => 10,
            Action::Next => 11,
            Action::MessageAgent { .. } => 12,
            Action::ToggleLane { .. } => 13,
            Action::ToggleProject { .. } => 14,
            Action::ToggleQuiet => 15,
        };
        let mut out = vec![("Action", top, 16)];
        if let Action::Edit(e) = a {
            let n = match e {
                EditEvent::OpenNew => 0,
                EditEvent::Open { .. } => 1,
                EditEvent::Close => 2,
                EditEvent::Name(_) => 3,
                EditEvent::Color(_) => 4,
                EditEvent::Icon(_) => 5,
                EditEvent::Folder(_) => 6,
                EditEvent::Search(_) => 7,
                EditEvent::CancelSearch => 8,
                EditEvent::Save => 9,
                EditEvent::AddSuggested { .. } => 10,
                EditEvent::Remove => 11,
            };
            out.push(("Edit", n, 12));
        }
        if let Action::Menu(m) = a {
            let n = match m {
                MenuEvent::OpenCard { .. } => 0,
                MenuEvent::OpenProject { .. } => 1,
                MenuEvent::Close => 2,
                MenuEvent::Pick(_) => 3,
            };
            out.push(("Menu", n, 4));
        }
        if let Action::Menu(MenuEvent::Pick(p)) = a {
            let n = match p {
                MenuAction::NewSession => 0,
                MenuAction::Lane(_) => 1,
                MenuAction::Project(_) => 2,
                MenuAction::ClearProjectOverride => 3,
                MenuAction::NewProjectFromFolder => 4,
                MenuAction::TogglePin => 5,
                MenuAction::MarkRead => 6,
                MenuAction::OpenPr => 7,
                MenuAction::KeepMerged => 8,
                MenuAction::ToggleNeeds => 9,
                MenuAction::OpenProject => 10,
                MenuAction::EditProject => 11,
            };
            out.push(("Pick", n, 12));
        }
        out
    }

    /// The actions the Swift sidebar's outbox check encodes: each must
    /// parse here, and together they name every variant of the action and
    /// of each nested event.
    #[test]
    fn every_file_the_swift_sidebar_sends_parses() {
        let files: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/actions.json")).unwrap();
        let mut seen = std::collections::BTreeSet::new();
        let mut sizes = std::collections::BTreeMap::new();
        for v in &files {
            let action = Action::parse(&v.to_string()).unwrap_or_else(|e| panic!("{v}: {e}"));
            for (group, n, of) in variants(&action) {
                assert!(n < of, "{group} numbers {n} of {of}");
                seen.insert((group, n));
                sizes.insert(group, of);
            }
            assert!(Event::from(action).is_action(), "{v} is not an action");
        }
        assert_eq!(sizes.len(), 4, "actions.json misses a nested event");
        for (group, of) in sizes {
            for n in 0..of {
                assert!(
                    seen.contains(&(group, n)),
                    "actions.json misses {group} variant {n}"
                );
            }
        }
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
