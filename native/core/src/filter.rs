//! The All view's project filter: the lanes show one project's cards, or
//! the cards with no project, and each header counts what it shows of
//! what it holds ("1 of 4"). It is applied where the lanes collect their
//! cards (lane_entries.rs `lane_cards`), so the Projects view, Needs you
//! and Next still see every card. Saved as `ui.filter` beside the view
//! mode, and dropped once its project leaves the table.

use serde_json::Value;

use crate::data::Workspace;
use crate::lanes::Lane;
use crate::projects::{OTHER_KEY, is_project_key};
use crate::session::Session;

/// The filter's key for the cards with no project: the ones the Projects
/// view files under Other.
pub const NO_PROJECT: &str = OTHER_KEY;

impl Session {
    /// Whether `k` can be filtered on: a project in the table and not
    /// removed here, or the cards with no project.
    fn is_filter_key(&self, k: &str) -> bool {
        k == NO_PROJECT || (is_project_key(&self.projects, k) && !self.is_removed_project(k))
    }

    /// The filter's key while it applies: only in a core whose shell
    /// draws the picker (`Event::PanelOn`), and only for a key the table
    /// holds. None while every card shows.
    pub fn filter(&self) -> Option<&str> {
        if !self.filters {
            return None;
        }
        self.filter.as_deref().filter(|k| self.is_filter_key(k))
    }

    /// Whether the filter leaves `w`'s card in its lane. With no project
    /// chosen, the cards the Projects view files under Other: no project,
    /// or one removed here before the rebuild drops it.
    pub fn filter_shows(&self, w: &Workspace) -> bool {
        self.shows_under(self.filter(), w)
    }

    /// Whether filter `k`, as `filter()` gave it, leaves `w`'s card in its
    /// lane; a loop over cards works the key out once and passes it here.
    pub fn shows_under(&self, k: Option<&str>, w: &Workspace) -> bool {
        let Some(k) = k else {
            return true;
        };
        let key = self.project_key(w);
        if k == NO_PROJECT {
            key == NO_PROJECT || self.is_removed_project(&key)
        } else {
            key == k
        }
    }

    /// Keeps in each lane only the cards the filter shows.
    pub fn keep_shown(&self, lanes: &mut [(Lane, Vec<&Workspace>)]) {
        let k = self.filter();
        for (_, cards) in lanes {
            cards.retain(|w| self.shows_under(k, w));
        }
    }

    /// Filters All to a project, to the cards with no project
    /// (`NO_PROJECT`), or with None to every card again; kept across a
    /// reload. A key the table does not hold changes nothing.
    pub fn choose_filter(&mut self, key: Option<&str>) {
        if key.is_some_and(|k| !self.is_filter_key(k)) {
            return;
        }
        let key = key.map(str::to_string);
        if self.filter == key {
            return;
        }
        self.filter.clone_from(&key);
        self.persist_set("ui.filter".to_string(), key.map(Value::from));
    }

    /// Drops a filter whose project has left the table, or was removed
    /// here, so it never comes back with the project. Only the core that
    /// draws the picker (`filters`, set by `Event::PanelOn`) writes it, and
    /// only once the table is read, so a filter read before its table is
    /// kept.
    pub fn tend_filter(&mut self) {
        let stale = self
            .filter
            .as_deref()
            .is_some_and(|k| !self.is_filter_key(k));
        if self.filters && self.projects_read && stale {
            self.filter = None;
            self.persist_set("ui.filter".to_string(), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::NO_PROJECT;
    use crate::data::{Data, Workspace};
    use crate::persist::SavedState;
    use crate::projects::Project;
    use crate::session::{Outbound, Session};
    use serde_json::Value;

    fn table() -> Vec<Project> {
        serde_json::from_str(
            r##"[{"match": "/dev/app", "name": "App", "color": "#D97757", "icon": "x"},
                {"match": "/dev/web", "name": "Web", "color": "#3B6FB6", "icon": "x"}]"##,
        )
        .unwrap()
    }

    fn ws(id: &str, dir: &str) -> Workspace {
        Workspace {
            id: id.into(),
            directory: Some(dir.into()),
            ..Workspace::default()
        }
    }

    /// Two App cards, one Web card and one in the home folder, in Main.
    fn frame() -> Data {
        Data {
            epoch: Some(1000.0),
            workspaces: Some(vec![
                ws("a1", "/dev/app"),
                ws("w1", "/dev/web"),
                ws("a2", "/dev/app/sub"),
                ws("h", "/Users/jon"),
            ]),
            ..Data::default()
        }
    }

    fn filtering() -> Session {
        let mut s = Session::new(table(), SavedState::default());
        s.filters = true;
        s.projects_read = true;
        s
    }

    fn shown(s: &mut Session, data: &Data) -> Vec<String> {
        s.lane_cards(data)
            .into_iter()
            .flat_map(|(_, ws)| ws.into_iter().map(|w| w.id.clone()))
            .collect()
    }

    /// The `ui.filter` writes the session sent, in order.
    fn writes(s: &mut Session) -> Vec<(String, Option<Value>)> {
        s.take_outbox()
            .into_iter()
            .filter_map(|o| match o {
                Outbound::Persist { key, value } if key == "ui.filter" => Some((key, value)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn shows_only_the_chosen_projects_cards_in_the_lanes() {
        let mut s = filtering();
        let data = frame();
        assert_eq!(shown(&mut s, &data), ["a1", "w1", "a2", "h"]);
        s.choose_filter(Some("/dev/app"));
        assert_eq!(shown(&mut s, &data), ["a1", "a2"]);
        s.choose_filter(Some(NO_PROJECT));
        assert_eq!(shown(&mut s, &data), ["h"], "no project: the home folder's");
        s.choose_filter(None);
        assert_eq!(shown(&mut s, &data), ["a1", "w1", "a2", "h"]);
    }

    #[test]
    fn saves_each_choice_as_ui_filter_and_ignores_a_key_not_in_the_table() {
        let mut s = filtering();
        s.choose_filter(Some("/dev/app"));
        s.choose_filter(Some("/dev/app"));
        s.choose_filter(Some("/dev/gone"));
        s.choose_filter(None);
        assert_eq!(
            writes(&mut s),
            [
                ("ui.filter".to_string(), Some(Value::from("/dev/app"))),
                ("ui.filter".to_string(), None),
            ],
            "one write a change; a key not in the table changes nothing"
        );
    }

    #[test]
    fn a_project_removed_here_joins_no_project_and_drops_its_own_filter() {
        let mut s = filtering();
        let data = frame();
        s.choose_filter(Some("/dev/web"));
        let _ = writes(&mut s);
        s.remove_project("/dev/web");
        assert_eq!(
            shown(&mut s, &data),
            ["a1", "w1", "a2", "h"],
            "no longer applies"
        );
        s.tend_filter();
        assert_eq!(
            writes(&mut s),
            [("ui.filter".to_string(), None)],
            "dropped, and the drop saved"
        );
        s.choose_filter(Some(NO_PROJECT));
        assert_eq!(
            shown(&mut s, &data),
            ["w1", "h"],
            "its card files under no project"
        );
    }

    #[test]
    fn keeps_a_filter_read_before_its_table_and_drops_one_the_table_lost() {
        let saved = SavedState::from_json(r#"{"ui": {"filter": "/dev/app"}}"#).unwrap();
        let mut s = Session::new(Vec::new(), saved);
        s.filters = true;
        s.tend_filter();
        assert!(writes(&mut s).is_empty(), "no table yet: kept");
        s.set_projects(table());
        s.tend_filter();
        assert_eq!(s.filter(), Some("/dev/app"));
        assert!(writes(&mut s).is_empty());
        s.set_projects(table().into_iter().skip(1).collect());
        s.filters = false;
        s.tend_filter();
        assert!(
            writes(&mut s).is_empty(),
            "only the sidebar's core writes it"
        );
        s.filters = true;
        s.tend_filter();
        assert_eq!(writes(&mut s), [("ui.filter".to_string(), None)]);
        assert_eq!(s.filter, None);
    }

    #[test]
    fn a_new_session_the_filter_would_hide_clears_it() {
        let mut s = filtering();
        let data = frame();
        s.choose_filter(Some("/dev/app"));
        s.add_session(&data, Some("/dev/app"));
        assert_eq!(s.filter(), Some("/dev/app"), "its own project: kept");
        s.add_session(&data, Some("/dev/web"));
        assert_eq!(s.filter(), None, "another project: every card again");
        s.choose_filter(Some("/dev/app"));
        s.add_session(&data, None);
        assert_eq!(s.filter(), None, "the home folder: every card again");
        s.choose_filter(Some(NO_PROJECT));
        s.add_session(&data, None);
        assert_eq!(s.filter(), Some(NO_PROJECT), "no project: kept");
    }

    #[test]
    fn the_pane_shows_every_card_whatever_the_sidebar_chose() {
        let saved = SavedState::from_json(r#"{"ui": {"filter": "/dev/app"}}"#).unwrap();
        let mut s = Session::new(table(), saved);
        assert_eq!(s.filter(), None);
        assert_eq!(shown(&mut s, &frame()), ["a1", "w1", "a2", "h"]);
    }
}
