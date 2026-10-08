//! native/core/tests/actions.json lists one of each of Jon's actions as
//! the Swift sidebar sends it to its core: the Swift outbox check encodes
//! one action per entry, and typegen's check_events decodes what Swift
//! wrote against it (native/mac/test.sh). This checks the list itself:
//! every entry is an action the core reads, and together they name every
//! variant of the action events and of each nested event.

#![cfg(test)]

use std::collections::{BTreeMap, BTreeSet};

use cockpit_core::menu::MenuAction;
use cockpit_core::{EditEvent, Event, MenuEvent};
use serde_json::Value;

/// Every variant an action names, down through the nested events, as
/// (group, its number, how many the group has); None for one of the
/// shell's own inputs. Each match lists every variant with no catch all,
/// so a new one fails to compile here until it has a number, then fails
/// the test below until actions.json has it.
fn variants(e: &Event) -> Option<Vec<(&'static str, usize, usize)>> {
    let top = match e {
        Event::Data(_)
        | Event::State(_)
        | Event::Projects(_)
        | Event::Home { .. }
        | Event::Refresh
        | Event::PrPollOn
        | Event::PanelOn
        | Event::PrPolled(_)
        | Event::CmuxFailed { .. }
        | Event::At { .. } => return None,
        Event::MoveCard { .. } => 0,
        Event::SwitchTo { .. } => 1,
        Event::Selected { .. } => 2,
        Event::Dismiss { .. } => 3,
        Event::FlipView => 4,
        Event::Edit(_) => 5,
        Event::OpenProject { .. } => 6,
        Event::FileForReview { .. } => 7,
        Event::ParkMerged { .. } => 8,
        Event::CloseMerged { .. } => 9,
        Event::KeepMerged { .. } => 10,
        Event::Menu(_) => 11,
        Event::Next => 12,
        Event::MessageAgent { .. } => 13,
        Event::ToggleLane { .. } => 14,
        Event::ToggleProject { .. } => 15,
        Event::ToggleQuiet => 16,
        Event::Reveal { .. } => 17,
    };
    let mut out = vec![("Action", top, 18)];
    if let Event::Edit(e) = e {
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
    if let Event::Menu(m) = e {
        let n = match m {
            MenuEvent::OpenCard { .. } => 0,
            MenuEvent::OpenProject { .. } => 1,
            MenuEvent::Close => 2,
            MenuEvent::Pick(_) => 3,
        };
        out.push(("Menu", n, 4));
    }
    if let Event::Menu(MenuEvent::Pick(p)) = e {
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
    Some(out)
}

#[test]
fn actions_json_names_every_action_the_sidebar_can_send() {
    let files: Vec<Value> = serde_json::from_str(include_str!("actions.json")).unwrap();
    let mut seen = BTreeSet::new();
    let mut sizes = BTreeMap::new();
    for v in &files {
        let event: Event = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"));
        assert!(event.is_action(), "{v} is not an action");
        let named = variants(&event).unwrap_or_else(|| panic!("{v} is the shell's own"));
        for (group, n, of) in named {
            assert!(n < of, "{group} numbers {n} of {of}");
            seen.insert((group, n));
            sizes.insert(group, of);
        }
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
