//! The open card or project menu's keys: Up and Down move between its
//! items, past the dividers, Enter picks the one lit and Esc closes it.
//! The core holds which menu is open and its items (cockpit_core::menu);
//! the pane holds only which item is lit, as it holds the editor's field.

use std::ops::Range;

use cockpit_core::menu::{MenuAction, MenuEvent, MenuItem, MenuTarget, MenuView};
use ratatui::crossterm::event::KeyCode;

/// A card menu's title.
pub const CARD_MENU_TITLE: &str = "Card";
/// A project menu's title.
pub const PROJECT_MENU_TITLE: &str = "Project";
/// Under the items.
pub const MENU_HINT: &str = "Enter picks · Esc closes";

/// The menu's title for what it is open on.
pub fn title(target: &MenuTarget) -> &'static str {
    match target {
        MenuTarget::Card { .. } => CARD_MENU_TITLE,
        MenuTarget::Project { .. } => PROJECT_MENU_TITLE,
    }
}

/// What a key does to an open menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuKey {
    /// Send this to the core.
    Send(MenuEvent),
    /// Light the item at this index.
    Move(usize),
    Nothing,
}

fn is_item(items: &[MenuItem], at: usize) -> bool {
    matches!(items.get(at), Some(MenuItem::Item { .. }))
}

/// The first item, past any divider; 0 when there is none.
pub fn first(items: &[MenuItem]) -> usize {
    (0..items.len()).find(|&i| is_item(items, i)).unwrap_or(0)
}

/// The item `by` steps from `at` (only the sign counts), past dividers;
/// `at` itself at either end.
pub fn step(items: &[MenuItem], at: usize, by: isize) -> usize {
    let found = if by < 0 {
        (0..at).rev().find(|&i| is_item(items, i))
    } else {
        (at + 1..items.len()).find(|&i| is_item(items, i))
    };
    found.unwrap_or(at)
}

/// What the item at `at` does, when it is an item.
pub fn action_at(items: &[MenuItem], at: usize) -> Option<MenuAction> {
    match items.get(at) {
        Some(MenuItem::Item { action, .. }) => Some(action.clone()),
        _ => None,
    }
}

/// Where the lit item is after the items changed: on the item that does
/// what the lit one did (`lit`), so a project added above it never moves
/// the light onto another action. When that has gone, `at` held to the
/// last item, and off a divider onto the item above it, or the first.
pub fn settle(items: &[MenuItem], at: usize, lit: Option<&MenuAction>) -> usize {
    let same = lit.and_then(|lit| {
        items
            .iter()
            .position(|i| matches!(i, MenuItem::Item { action, .. } if action == lit))
    });
    if let Some(i) = same {
        return i;
    }
    let at = at.min(items.len().saturating_sub(1));
    if is_item(items, at) {
        return at;
    }
    match (0..at).rev().find(|&i| is_item(items, i)) {
        Some(i) => i,
        None => first(items),
    }
}

/// What `code` does to the open menu with the item at `at` lit.
pub fn key(view: &MenuView, at: usize, code: KeyCode) -> MenuKey {
    let moved = |to: usize| {
        if to == at {
            MenuKey::Nothing
        } else {
            MenuKey::Move(to)
        }
    };
    match code {
        KeyCode::Esc => MenuKey::Send(MenuEvent::Close),
        KeyCode::Up => moved(step(&view.items, at, -1)),
        KeyCode::Down => moved(step(&view.items, at, 1)),
        KeyCode::Enter => match view.items.get(at) {
            Some(MenuItem::Item { action, .. }) => MenuKey::Send(MenuEvent::Pick(action.clone())),
            _ => MenuKey::Nothing,
        },
        _ => MenuKey::Nothing,
    }
}

/// The items a box `room` lines tall shows of `len`, keeping `at` in sight:
/// from `top`, the line the last draw started at, until `at` would leave
/// the window, then moved only as far as it takes. So Up from the bottom
/// moves the light, not the list.
pub fn window(len: usize, at: usize, room: usize, top: usize) -> Range<usize> {
    if len <= room {
        return 0..len;
    }
    let top = top.min(len - room);
    let start = if at < top {
        at
    } else if at >= top + room {
        at + 1 - room
    } else {
        top
    };
    start..start + room
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::menu::MenuAction;

    fn item(label: &str, action: MenuAction) -> MenuItem {
        MenuItem::Item {
            label: label.into(),
            action,
        }
    }

    /// Pin, a divider, Mark read, a divider, Open PR.
    fn view() -> MenuView {
        MenuView {
            target: MenuTarget::Card { id: "a".into() },
            items: vec![
                item("Pin", MenuAction::TogglePin),
                MenuItem::Divider,
                item("Mark read", MenuAction::MarkRead),
                MenuItem::Divider,
                item("Open PR #7", MenuAction::OpenPr),
            ],
        }
    }

    #[test]
    fn steps_past_dividers_and_stops_at_either_end() {
        let items = view().items;
        assert_eq!(step(&items, 0, 1), 2);
        assert_eq!(step(&items, 2, 1), 4);
        assert_eq!(step(&items, 4, 1), 4);
        assert_eq!(step(&items, 4, -1), 2);
        assert_eq!(step(&items, 0, -1), 0);
    }

    #[test]
    fn settles_onto_an_item_when_the_items_change() {
        let items = view().items;
        assert_eq!(settle(&items, 9, None), 4, "held to the last");
        assert_eq!(settle(&items, 3, None), 2, "off a divider, upwards");
        assert_eq!(
            first(&[MenuItem::Divider, item("x", MenuAction::MarkRead)]),
            1
        );
        assert_eq!(settle(&[], 3, None), 0);
    }

    #[test]
    fn keeps_the_light_on_the_same_action_when_items_move() {
        // Mark read lit at 2; an item arrives at the top and it moves to 3.
        let mut items = view().items;
        items.insert(0, item("New session", MenuAction::NewSession));
        assert_eq!(settle(&items, 2, Some(&MenuAction::MarkRead)), 3);
        assert_eq!(action_at(&items, 3), Some(MenuAction::MarkRead));
        assert_eq!(action_at(&items, 2), None, "a divider");
        // Gone: falls back to where it was.
        assert_eq!(settle(&items, 3, Some(&MenuAction::KeepMerged)), 3);
    }

    #[test]
    fn enter_picks_the_lit_item_esc_closes_and_other_keys_do_nothing() {
        let v = view();
        assert_eq!(
            key(&v, 2, KeyCode::Enter),
            MenuKey::Send(MenuEvent::Pick(MenuAction::MarkRead))
        );
        assert_eq!(key(&v, 1, KeyCode::Enter), MenuKey::Nothing);
        assert_eq!(key(&v, 2, KeyCode::Esc), MenuKey::Send(MenuEvent::Close));
        assert_eq!(key(&v, 0, KeyCode::Down), MenuKey::Move(2));
        assert_eq!(key(&v, 0, KeyCode::Up), MenuKey::Nothing);
        assert_eq!(key(&v, 0, KeyCode::Char('q')), MenuKey::Nothing);
    }

    #[test]
    fn a_window_keeps_the_lit_item_in_sight() {
        assert_eq!(window(5, 4, 9, 0), 0..5);
        assert_eq!(window(20, 3, 6, 0), 0..6);
        assert_eq!(window(20, 10, 6, 0), 5..11);
        assert_eq!(window(20, 19, 6, 0), 14..20);
        // Up from the bottom keeps the window until the light leaves it.
        assert_eq!(window(20, 18, 6, 14), 14..20);
        assert_eq!(window(20, 14, 6, 14), 14..20);
        assert_eq!(window(20, 13, 6, 14), 13..19);
        // A start past the end (the menu shrank) is held in range.
        assert_eq!(window(8, 2, 6, 14), 2..8);
    }

    #[test]
    fn titles_a_menu_by_what_it_is_open_on() {
        assert_eq!(title(&view().target), CARD_MENU_TITLE);
        let project = MenuTarget::Project {
            key: "/dev/app".into(),
            quiet: false,
        };
        assert_eq!(title(&project), PROJECT_MENU_TITLE);
    }
}
