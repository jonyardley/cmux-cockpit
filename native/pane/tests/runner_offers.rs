//! The runner's feed seen through the panel model the pane draws: the
//! Projects view offers a folder as a project only once the shell says
//! where home is. It lives here, not in cockpit_runner or the core,
//! because it needs both the runner's feed and the panel, and neither of
//! those crates depends on the other.

use cockpit_core::panel::ProjectRow;
use cockpit_core::{Event, Panel, SavedState, Workspace};
use cockpit_runner::{Feed, Input};

fn ws(id: &str) -> Workspace {
    Workspace {
        id: id.to_string(),
        title: Some(id.to_string()),
        ..Workspace::default()
    }
}

/// The Projects view's cards, each with its `Make "X" a project` offer
/// if it has one, for a feed with `home` and two workspaces: one in a
/// folder under home, one in home itself. Sorted by workspace id.
fn project_offers(home: Option<&str>) -> Vec<(String, Option<String>)> {
    let mut feed = Feed::with_home(home.map(str::to_string));
    feed.state(SavedState::default());
    let in_dir = |id: &str, dir: &str| Workspace {
        directory: Some(dir.to_string()),
        ..ws(id)
    };
    feed.input(Input::Workspaces(
        vec![in_dir("A", "/Users/me/dev/app"), in_dir("H", "/Users/me")],
        0.0,
    ));
    feed.act(Event::FlipView);
    feed.frame(1_791_127_100.0);
    let pane = Panel::from_core(&mut feed.model);
    let mut cards: Vec<(String, Option<String>)> = pane
        .projects
        .iter()
        .filter_map(|row| match row {
            ProjectRow::Card(c) => Some(c),
            _ => None,
        })
        .map(|c| {
            let offer = c
                .chips
                .iter()
                .flat_map(|chip| chip.pieces.iter())
                .map(|p| p.text.clone())
                .find(|t| t.starts_with("Make "));
            (c.ws_id.clone(), offer)
        })
        .collect();
    cards.sort();
    cards
}

#[test]
fn the_projects_view_offers_a_folder_once_home_is_set() {
    let card = |id: &str, offer: Option<&str>| (id.to_string(), offer.map(str::to_string));
    assert_eq!(
        project_offers(Some("/Users/me")),
        [card("A", Some("Make \"App\" a project")), card("H", None)],
        "the folder under home, never home itself"
    );
    assert_eq!(
        project_offers(None),
        [card("A", None), card("H", None)],
        "no offer until the shell says where home is"
    );
}
