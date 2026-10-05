//! The card menu and the project menu (src/cockpit/views/parts.ts
//! `cardMenu`, src/cockpit/views/headers.ts `projectMenu`): what each item
//! says and what picking it does. The sidebar builds them as context menus;
//! here one menu is open at a time, held in the session, so a shell draws
//! the open one with its items' words live each frame and sends back the
//! item picked. cmux drops submenus, so every item sits at the top level,
//! grouped by dividers and prefixed by what it moves.

use crate::data::{Data, Workspace};
use crate::edit::edit_label;
use crate::lanes::{LANES, LaneKey};
use crate::projects::is_project_key;
use crate::prs::pr_summary;
use crate::session::{Outbound, Param, Session};
use crate::status::{PrRef, open_pr_label};

/// What a menu is open on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuTarget {
    /// A card's menu, by workspace id.
    Card { id: String },
    /// A project's menu, by project key: on its header, or on its row
    /// among the quiet projects, whose first item words it differently.
    Project { key: String, quiet: bool },
}

/// What picking an item does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuAction {
    /// A new session in the card's project folder.
    NewSession,
    /// Moves the card into the lane.
    Lane(LaneKey),
    /// Moves the card into the project, kept until cleared.
    Project(String),
    ClearProjectOverride,
    /// Makes a project from the card's folder.
    NewProjectFromFolder,
    /// Pin, or Unpin when the card is pinned.
    TogglePin,
    MarkRead,
    /// Opens the card's PR in the browser, when it has a link.
    OpenPr,
    /// Hides a merged card's buttons.
    KeepMerged,
    /// Dismiss needs you, or Restore needs you when dismissed.
    ToggleNeeds,
    /// The project menu's new session in the project's folder.
    OpenProject,
    /// The project menu's Edit project.
    EditProject,
}

/// One line of a menu: an item, or a divider between groups.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuItem {
    Item { label: String, action: MenuAction },
    Divider,
}

impl MenuItem {
    fn item(label: impl Into<String>, action: MenuAction) -> MenuItem {
        MenuItem::Item {
            label: label.into(),
            action,
        }
    }

    /// The item's words, "" for a divider.
    pub fn label(&self) -> &str {
        match self {
            MenuItem::Item { label, .. } => label,
            MenuItem::Divider => "",
        }
    }
}

/// The open menu: what it is on and its items, top to bottom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuView {
    pub target: MenuTarget,
    pub items: Vec<MenuItem>,
}

/// What Jon does with a menu, as the core's events carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEvent {
    /// Opens the card's menu; nothing for a workspace not in the frame.
    OpenCard { id: String },
    /// Opens the project's menu, on its header or (`quiet`) its quiet row.
    OpenProject { key: String, quiet: bool },
    /// Closes the menu with nothing picked.
    Close,
    /// Picks an item of the open menu, which then closes.
    Pick(MenuAction),
}

/// "✓ " before the current choice.
fn ticked(on: bool, label: String) -> String {
    if on { format!("✓ {label}") } else { label }
}

impl Session {
    /// The card's menu, as the sidebar's context menu on a card lists it.
    pub fn card_menu(&mut self, data: &Data, w: Option<&Workspace>) -> Vec<MenuItem> {
        let mut items = vec![
            MenuItem::item(self.new_session_label(w), MenuAction::NewSession),
            MenuItem::Divider,
        ];
        let lane = w.map(|w| self.lane_of(data, w));
        items.extend(LANES.iter().map(|l| {
            let label = ticked(lane == Some(l.key), format!("Lane: {}", l.name));
            MenuItem::item(label, MenuAction::Lane(l.key))
        }));
        items.push(MenuItem::Divider);
        let project = w.map(|w| self.project_key(w));
        items.extend(self.projects.iter().map(|p| {
            let on = project.as_deref() == Some(p.id());
            let label = ticked(on, format!("Project: {}", p.name));
            MenuItem::item(label, MenuAction::Project(p.id().to_string()))
        }));
        let clear = if self.has_project_override(w) {
            "Clear project override"
        } else {
            "No project override set"
        };
        items.push(MenuItem::item(clear, MenuAction::ClearProjectOverride));
        items.push(MenuItem::Divider);
        // Only making a project lives on the card; editing one is on its header.
        let make = if self.can_create_project(w) {
            "New project from this folder"
        } else {
            "New project (folder has one, or none)"
        };
        items.push(MenuItem::item(make, MenuAction::NewProjectFromFolder));
        items.push(MenuItem::Divider);
        let pinned = w.is_some_and(|w| w.pinned == Some(true));
        items.push(MenuItem::item(
            if pinned { "Unpin" } else { "Pin" },
            MenuAction::TogglePin,
        ));
        items.push(MenuItem::item("Mark read", MenuAction::MarkRead));
        let pr = pr_summary(&self.saved, w);
        let pr_ref = pr.as_ref().map(|p| PrRef {
            tag: &p.tag,
            url: p.url.as_deref(),
        });
        items.push(MenuItem::item(open_pr_label(pr_ref), MenuAction::OpenPr));
        items.push(MenuItem::item(
            self.keep_label(data, w),
            MenuAction::KeepMerged,
        ));
        let needs = if self.is_needs_dismissed(w) {
            "Restore needs you"
        } else {
            "Dismiss needs you"
        };
        items.push(MenuItem::item(needs, MenuAction::ToggleNeeds));
        items
    }

    /// A project's menu: open a session in it, or edit it. Other has no edit.
    pub fn project_menu(&self, k: &str) -> Vec<MenuItem> {
        let mut items = vec![MenuItem::item(
            self.project_new_label(k),
            MenuAction::OpenProject,
        )];
        if is_project_key(&self.projects, k) {
            items.push(MenuItem::Divider);
            items.push(MenuItem::item(edit_label(k), MenuAction::EditProject));
        }
        items
    }

    /// A quiet project's menu: open a session in it (or say why not), or
    /// edit it. A quiet row is always a project's, so Edit is always there.
    pub fn quiet_menu(&self, k: &str) -> Vec<MenuItem> {
        vec![
            MenuItem::item(self.quiet_label(k), MenuAction::OpenProject),
            MenuItem::Divider,
            MenuItem::item(edit_label(k), MenuAction::EditProject),
        ]
    }

    /// What the open menu is on, if one is open.
    pub fn menu_target(&self) -> Option<&MenuTarget> {
        self.menu.as_ref()
    }

    /// The open menu with its items for this frame. A card's menu whose
    /// workspace left the frame closes.
    pub fn menu_view(&mut self, data: &Data) -> Option<MenuView> {
        let target = self.menu.clone()?;
        let items = match &target {
            MenuTarget::Card { id } => match data.ws_by_id(id) {
                Some(w) => self.card_menu(data, Some(w)),
                None => {
                    self.menu = None;
                    return None;
                }
            },
            MenuTarget::Project { key, quiet: false } => self.project_menu(key),
            MenuTarget::Project { key, quiet: true } => self.quiet_menu(key),
        };
        Some(MenuView { target, items })
    }

    /// Takes a menu event against the frame.
    pub fn menu(&mut self, data: &Data, e: MenuEvent) {
        match e {
            MenuEvent::OpenCard { id } => {
                if data.ws_by_id(&id).is_some() {
                    self.menu = Some(MenuTarget::Card { id });
                }
            }
            MenuEvent::OpenProject { key, quiet } => {
                self.menu = Some(MenuTarget::Project { key, quiet });
            }
            MenuEvent::Close => self.menu = None,
            MenuEvent::Pick(action) => {
                if let Some(target) = self.menu.take() {
                    self.pick(data, &target, action);
                }
            }
        }
    }

    /// Carries out an item picked on `target`. An item of the other kind
    /// of menu does nothing.
    fn pick(&mut self, data: &Data, target: &MenuTarget, action: MenuAction) {
        match target {
            MenuTarget::Card { id } => self.pick_card(data, data.ws_by_id(id), action),
            MenuTarget::Project { key, .. } => match action {
                MenuAction::OpenProject => self.open_project_workspace(data, key, None),
                MenuAction::EditProject => self.open_editor(key),
                _ => {}
            },
        }
    }

    fn pick_card(&mut self, data: &Data, w: Option<&Workspace>, action: MenuAction) {
        match action {
            MenuAction::NewSession => self.new_session_for(data, w),
            MenuAction::Lane(lane) => self.move_to_lane(data, w, lane),
            MenuAction::Project(key) => self.move_to_project(w, &key),
            MenuAction::ClearProjectOverride => self.clear_project_override(w),
            MenuAction::NewProjectFromFolder => self.create_project_from(w),
            MenuAction::TogglePin => {
                let pinned = w.is_some_and(|w| w.pinned == Some(true));
                self.workspace_action(w, if pinned { "unpin" } else { "pin" });
            }
            MenuAction::MarkRead => self.workspace_action(w, "mark_read"),
            MenuAction::OpenPr => {
                let url = pr_summary(&self.saved, w)
                    .and_then(|p| p.url)
                    .filter(|u| !u.is_empty());
                if let Some(url) = url {
                    self.outbox.push(Outbound::OpenUrl { url });
                }
            }
            MenuAction::KeepMerged => self.keep_merged(data, w),
            MenuAction::ToggleNeeds => {
                if self.is_needs_dismissed(w) {
                    self.restore_needs(w);
                } else {
                    self.dismiss_waiting(data, w);
                }
            }
            MenuAction::OpenProject | MenuAction::EditProject => {}
        }
    }

    /// A cmux workspace action (pin, unpin, mark_read) on the card.
    fn workspace_action(&mut self, w: Option<&Workspace>, action: &str) {
        if let Some(w) = w {
            let id = Param::Str(w.id.clone());
            self.cmux(
                "workspace.action",
                vec![
                    ("action", Param::Str(action.to_string())),
                    ("workspace_id", id),
                ],
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::SavedState;
    use crate::projects::Project;

    fn table() -> Vec<Project> {
        serde_json::from_str(
            r##"[{"match": "/dev/app", "name": "App", "color": "#000000", "icon": "x", "root": "/r/app"},
                {"match": "applet", "name": "Applet", "color": "#111111", "icon": "x"}]"##,
        )
        .unwrap()
    }

    /// Main activity with its anchor and card `a` (in /x/dev/app, PR #7
    /// with a link), Parked with its anchor, and a pinned card `p` with no
    /// folder.
    fn data() -> Data {
        serde_json::from_value(serde_json::json!({
            "epoch": 1000.0,
            "groups": [
                { "id": "g-main", "name": "Main activity", "anchorId": "anchor-main" },
                { "id": "g-parked", "name": "Parked", "anchorId": "anchor-parked" },
            ],
            "workspaces": [
                { "id": "anchor-main", "title": "Main activity", "group": "g-main" },
                { "id": "a", "group": "g-main", "directory": "/x/dev/app",
                  "pr": { "number": 7, "status": "open", "url": "https://example.com/pr/7" } },
                { "id": "anchor-parked", "title": "Parked", "group": "g-parked" },
                { "id": "p", "group": "g-parked", "pinned": true },
            ],
        }))
        .unwrap()
    }

    fn session() -> Session {
        Session::new(table(), SavedState::default())
    }

    fn labels(items: &[MenuItem]) -> Vec<&str> {
        items.iter().map(MenuItem::label).collect()
    }

    fn open_card(s: &mut Session, d: &Data, id: &str) {
        s.menu(d, MenuEvent::OpenCard { id: id.into() });
    }

    #[test]
    fn the_card_menu_lists_every_group_in_the_sidebars_order() {
        let (mut s, d) = (session(), data());
        let items = s.card_menu(&d, d.ws_by_id("a"));
        assert_eq!(
            labels(&items),
            [
                "New session in App",
                "",
                "✓ Lane: Main activity",
                "Lane: For review",
                "Lane: Background",
                "Lane: Parked",
                "Lane: Unsorted",
                "",
                "✓ Project: App",
                "Project: Applet",
                "No project override set",
                "",
                "New project (folder has one, or none)",
                "",
                "Pin",
                "Mark read",
                "Open PR #7",
                "Keep: for a merged PR's buttons",
                "Dismiss needs you",
            ]
        );
    }

    #[test]
    fn a_pinned_card_with_no_folder_or_pr_says_so() {
        let (mut s, d) = (session(), data());
        let items = s.card_menu(&d, d.ws_by_id("p"));
        let words = labels(&items);
        assert!(words.contains(&"✓ Lane: Parked"));
        assert!(words.contains(&"Unpin"));
        assert!(words.contains(&"No PR to open"));
        assert!(words.contains(&"New session (project has no folder)"));
        assert!(!words.iter().any(|w| w.starts_with("✓ Project")));
    }

    #[test]
    fn the_project_menu_offers_edit_only_on_a_known_project() {
        let s = session();
        assert_eq!(
            labels(&s.project_menu("/dev/app")),
            ["New session in App", "", "Edit project"]
        );
        assert_eq!(
            labels(&s.project_menu("applet")),
            [
                "New session (project has no folder)",
                "",
                "Edit project (its first match is too short to save)"
            ]
        );
        assert_eq!(
            labels(&s.project_menu("other")),
            ["New session (project has no folder)"]
        );
    }

    #[test]
    fn a_quiet_rows_menu_words_its_first_item_as_the_row_does() {
        let (mut s, d) = (session(), data());
        assert_eq!(
            labels(&s.quiet_menu("applet")),
            [
                "Applet has no folder to open",
                "",
                "Edit project (its first match is too short to save)"
            ]
        );
        let open = MenuEvent::OpenProject {
            key: "/dev/app".into(),
            quiet: true,
        };
        s.menu(&d, open);
        let view = s.menu_view(&d).unwrap();
        assert_eq!(
            labels(&view.items),
            ["New session in App", "", "Edit project"]
        );
    }

    #[test]
    fn opens_a_card_menu_only_for_a_workspace_in_the_frame() {
        let (mut s, d) = (session(), data());
        open_card(&mut s, &d, "gone");
        assert_eq!(s.menu_target(), None);
        open_card(&mut s, &d, "a");
        let view = s.menu_view(&d).unwrap();
        assert_eq!(view.target, MenuTarget::Card { id: "a".into() });
        assert_eq!(
            view.items.first().map(MenuItem::label),
            Some("New session in App")
        );
    }

    #[test]
    fn closes_a_card_menu_whose_workspace_left_the_frame() {
        let (mut s, d) = (session(), data());
        open_card(&mut s, &d, "p");
        let mut later = data();
        if let Some(list) = later.workspaces.as_mut() {
            list.retain(|w| w.id != "p");
        }
        assert_eq!(s.menu_view(&later), None);
        assert_eq!(s.menu_target(), None);
    }

    #[test]
    fn a_pick_closes_the_menu_and_a_pick_with_none_open_does_nothing() {
        let (mut s, d) = (session(), data());
        s.menu(&d, MenuEvent::Pick(MenuAction::MarkRead));
        assert!(s.outbox().is_empty());
        open_card(&mut s, &d, "a");
        s.menu(&d, MenuEvent::Close);
        assert_eq!(s.menu_target(), None);
        assert!(s.outbox().is_empty());
        open_card(&mut s, &d, "a");
        s.menu(&d, MenuEvent::Pick(MenuAction::MarkRead));
        assert_eq!(s.menu_target(), None);
        let want = [
            ("action".to_string(), Param::Str("mark_read".into())),
            ("workspace_id".to_string(), Param::Str("a".into())),
        ];
        assert!(matches!(
            s.outbox(),
            [Outbound::Cmux { method, params }]
                if method == "workspace.action" && params.as_slice() == want
        ));
    }

    #[test]
    fn pin_unpins_a_pinned_card() {
        let (mut s, d) = (session(), data());
        for (id, want) in [("a", "pin"), ("p", "unpin")] {
            open_card(&mut s, &d, id);
            s.menu(&d, MenuEvent::Pick(MenuAction::TogglePin));
            let sent = s.take_outbox();
            let first = ("action".to_string(), Param::Str(want.into()));
            assert!(
                matches!(sent.as_slice(), [Outbound::Cmux { params, .. }]
                    if params.first() == Some(&first)),
                "{id}: {sent:?}"
            );
        }
    }

    #[test]
    fn open_pr_opens_the_link_and_nothing_without_one() {
        let (mut s, d) = (session(), data());
        open_card(&mut s, &d, "a");
        s.menu(&d, MenuEvent::Pick(MenuAction::OpenPr));
        assert_eq!(
            s.take_outbox(),
            [Outbound::OpenUrl {
                url: "https://example.com/pr/7".into()
            }]
        );
        open_card(&mut s, &d, "p");
        s.menu(&d, MenuEvent::Pick(MenuAction::OpenPr));
        assert!(s.outbox().is_empty());
    }

    #[test]
    fn moves_to_a_project_and_clears_the_override() {
        let (mut s, d) = (session(), data());
        open_card(&mut s, &d, "p");
        s.menu(&d, MenuEvent::Pick(MenuAction::Project("/dev/app".into())));
        let items = s.card_menu(&d, d.ws_by_id("p"));
        assert!(labels(&items).contains(&"✓ Project: App"));
        assert!(labels(&items).contains(&"Clear project override"));
        open_card(&mut s, &d, "p");
        s.menu(&d, MenuEvent::Pick(MenuAction::ClearProjectOverride));
        assert!(!s.has_project_override(d.ws_by_id("p")));
    }

    #[test]
    fn a_project_menu_opens_a_session_or_the_editor() {
        let (mut s, d) = (session(), data());
        let open = || MenuEvent::OpenProject {
            key: "/dev/app".into(),
            quiet: false,
        };
        s.menu(&d, open());
        s.menu(&d, MenuEvent::Pick(MenuAction::OpenProject));
        assert!(matches!(
            s.take_outbox().as_slice(),
            [Outbound::Cmux { method, .. }] if method == "workspace.create"
        ));
        s.menu(&d, open());
        s.menu(&d, MenuEvent::Pick(MenuAction::EditProject));
        assert_eq!(s.editing_project(), Some("/dev/app"));
    }

    #[test]
    fn an_item_of_the_other_menu_does_nothing() {
        let (mut s, d) = (session(), data());
        let open = MenuEvent::OpenProject {
            key: "/dev/app".into(),
            quiet: false,
        };
        s.menu(&d, open);
        s.menu(&d, MenuEvent::Pick(MenuAction::MarkRead));
        open_card(&mut s, &d, "a");
        s.menu(&d, MenuEvent::Pick(MenuAction::EditProject));
        assert!(s.outbox().is_empty());
        assert_eq!(s.editing_project(), None);
        assert_eq!(s.menu_target(), None);
    }
}
