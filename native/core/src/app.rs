//! The Crux app the shells drive: it takes cmux's data, the saved state and
//! the project table as events, and hands back the All view's model: Next,
//! Needs you and the lanes. Jon's actions come in as events too: a card
//! moved, a workspace switched to, a Needs you card dismissed, the view
//! flipped. Whatever the session asks of the world on any event (a cmux
//! call, a state.json write) leaves as an effect, oldest first, ahead of the
//! render.

use std::collections::BTreeMap;

use crux_core::{
    App, Command,
    capability::Operation,
    macros::effect,
    render::{RenderOperation, render},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::data::{Data, Workspace};
use crate::edit::EditEvent;
use crate::js::json_num;
use crate::lane_entries::LaneEntry;
use crate::lanes::{LaneKey, lane_by_key};
use crate::menu::MenuEvent;
use crate::panel::Panel;
use crate::persist::{SavedState, ViewMode, persist_url};
use crate::pr_poll::{PrPolled, shown_in};
use crate::projects::Project;
use crate::session::{Outbound, Param, Session};

/// What the shell can tell the core. native/typegen writes it in Swift for
/// the sidebar to send; the core's own inputs (a frame, the state file, the
/// project table, a PR answer) are skipped there, and opaque so their types
/// need no Facet, until a shell sends them (#270).
#[derive(Debug, Deserialize, facet::Facet)]
#[repr(u8)]
pub enum Event {
    /// A new frame of cmux data.
    #[facet(skip)]
    Data(#[facet(opaque)] Data),
    /// A new config/state.json. What the file holds is seeded from it
    /// again, as a reload seeds the sidebar, with the pane's own writes not
    /// in it yet made over it; everything held only in memory stays
    /// (Session::reseed).
    #[facet(skip)]
    State(#[facet(opaque)] Box<SavedState>),
    /// A new project table. Only the table changes: the view, folds,
    /// dismissals and overrides Jon set since the state file was read stay.
    #[facet(skip)]
    Projects(#[facet(opaque)] Vec<Project>),
    /// Jon's home folder, which the runner reads from its environment and
    /// a sandboxed shell cannot: it expands a "~" root in the editor, sorts
    /// the home folder out of Projects and offers a folder as a project.
    /// The sidebar's core takes it from data.json (#270).
    Home { home: Option<String> },
    /// Asks the shell to draw the current view again.
    Refresh,
    /// Moves the card `id` into `lane`, just above the card `before`, or
    /// at the end of the lane when None, as a drop in the sidebar does.
    MoveCard {
        id: String,
        lane: LaneKey,
        before: Option<String>,
    },
    /// Switches cmux to the workspace, as a tap on its card does.
    SwitchTo { id: String },
    /// The shell selected the workspace itself (the sidebar's SDK select):
    /// it draws selected at once, with no cmux call from the core.
    Selected { id: String },
    /// Dismisses the workspace's asks from Needs you, as its cross does.
    Dismiss { id: String },
    /// Flips the view between All and Projects.
    FlipView,
    /// The shell could not carry out a cmux call about this workspace
    /// (refused, or past its time limit): the pane stops holding the card
    /// where Jon moved it, and shows it where cmux has it.
    CmuxFailed { id: String },
    /// The shell can run `git` and `gh`: from now on the core asks it for
    /// each directory's PR (`Effect::PrPoll`), as scripts/pr-poll.ts would.
    PrPollOn,
    /// What the shell found for one directory's PR. It redraws only when
    /// what a card shows of a PR changed (pr_poll::Shown).
    #[facet(skip)]
    PrPolled(#[facet(opaque)] Box<PrPolled>),
    /// Something done in the project editor (edit.rs). A save goes out as
    /// a `projects.<key>` state write, which the next build reads.
    Edit(EditEvent),
    /// A project's "+": a new session in its folder.
    OpenProject { key: String },
    /// A card's "To review →": files it into For review, when it offers it.
    FileForReview { id: String },
    /// A merged card's Park: files it into Parked, when it offers it.
    ParkMerged { id: String },
    /// A merged card's Close: closes its workspace, when it offers it.
    CloseMerged { id: String },
    /// Keep on a merged card: hides its Park and Close for this PR, as the
    /// card menu's Keep does.
    KeepMerged { id: String },
    /// Something done with the card menu or a project's menu (menu.rs).
    Menu(MenuEvent),
    /// The Next button: switches to the next workspace in its queue.
    Next,
    /// "Message agent…": Jon's words to the agent in the workspace
    /// (message.rs).
    MessageAgent { id: String, text: String },
    /// A click on a lane's heading: folds or unfolds it.
    ToggleLane { lane: LaneKey },
    /// A click on a busy project's heading: folds or unfolds it.
    ToggleProject { key: String },
    /// A click on the Quiet heading: folds or unfolds it.
    ToggleQuiet,
    /// An event with the shell's clock, in epoch seconds: the core's now
    /// for it when that is later than the last frame's, so an action
    /// between frames (up to 30 seconds apart) is stamped when it happened
    /// (#268).
    At { now: f64, event: Box<Event> },
    /// The shell draws the whole panel from the view (the Swift sidebar,
    /// #268): from now on the view carries it. The pane and the helper
    /// never send it, so they never pay for a build they do not read.
    PanelOn,
}

impl Event {
    /// Whether this is one of Jon's actions (a card moved, switched to or
    /// dismissed, the view flipped, the editor, a project's "+", To
    /// review, a menu) rather than one of the shell's own inputs (a frame,
    /// a state file, the project table, a redraw, the PR poll, or its
    /// report that a cmux call failed). No arm is a catch-all, so a new
    /// event has to be sorted here before the core builds.
    pub fn is_action(&self) -> bool {
        match self {
            Event::Data(_)
            | Event::State(_)
            | Event::Projects(_)
            | Event::Home { .. }
            | Event::Refresh
            | Event::PrPollOn
            | Event::PanelOn
            | Event::PrPolled(_)
            | Event::CmuxFailed { .. } => false,
            Event::MoveCard { .. }
            | Event::SwitchTo { .. }
            | Event::Selected { .. }
            | Event::Dismiss { .. }
            | Event::FlipView
            | Event::Edit(_)
            | Event::OpenProject { .. }
            | Event::FileForReview { .. }
            | Event::ParkMerged { .. }
            | Event::CloseMerged { .. }
            | Event::KeepMerged { .. }
            | Event::Menu(_)
            | Event::Next
            | Event::MessageAgent { .. }
            | Event::ToggleLane { .. }
            | Event::ToggleProject { .. }
            | Event::ToggleQuiet => true,
            Event::At { event, .. } => event.is_action(),
        }
    }
}

/// Everything the core knows: the session, the latest frame, and the view
/// built from them. The view is built in `update`, since reading the
/// session tidies it and `view` only borrows the model.
#[derive(Debug, Default)]
pub struct Model {
    pub session: Session,
    pub data: Option<Data>,
    pub view: ViewModel,
    /// Whether the view carries the panel (`Event::PanelOn`).
    pub panel_on: bool,
}

/// The Needs you strip as the shell draws it, workspaces by id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsView {
    pub list: Vec<String>,
    pub shown: Vec<String>,
    pub in_strip: Vec<String>,
    pub more: usize,
    pub wait_text: String,
    pub late: bool,
}

/// Where the next press of Next goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepView {
    pub target: String,
    pub position: usize,
    pub total: usize,
}

/// The Next button: its queue and where the next press goes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct NextView {
    pub queue: Vec<String>,
    pub step: Option<StepView>,
}

/// A lane header: folded or not, the cards it counts, its merge line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneHeaderView {
    pub collapsed: bool,
    pub workspaces: Vec<String>,
    pub merge_ready: String,
}

/// What the shell draws: the All view.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewModel {
    pub mode: String,
    pub needs: NeedsView,
    pub next: NextView,
    pub lane_entries: Vec<LaneEntry>,
    pub lane_headers: BTreeMap<LaneKey, LaneHeaderView>,
    /// The whole panel, once the shell asks for it (`Event::PanelOn`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<Panel>,
}

/// A cmux socket command for the shell to send: `cmux rpc <method>
/// <params>`, as the sidebar's `cmux(method, params)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CmuxCall {
    pub method: String,
    /// In the order the TypeScript writes them.
    /// Crosses the bridge as the object cmux reads (`params_json`).
    #[serde(serialize_with = "params_out", deserialize_with = "params_in")]
    pub params: Vec<(String, Param)>,
}

impl CmuxCall {
    /// The params as the JSON object cmux reads, in order.
    pub fn params_json(&self) -> Value {
        params_value(&self.params)
    }
}

fn params_value(params: &[(String, Param)]) -> Value {
    let map: Map<String, Value> = params
        .iter()
        .map(|(k, v)| {
            let v = match v {
                Param::Str(s) => Value::from(s.as_str()),
                Param::Num(n) => json_num(*n),
                Param::Bool(b) => Value::from(*b),
            };
            (k.clone(), v)
        })
        .collect();
    Value::Object(map)
}

fn params_out<S: serde::Serializer>(params: &[(String, Param)], s: S) -> Result<S::Ok, S::Error> {
    params_value(params).serialize(s)
}

fn params_in<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<(String, Param)>, D::Error> {
    let map = Map::<String, Value>::deserialize(d)?;
    map.into_iter()
        .map(|(k, v)| {
            let p = match v {
                Value::String(s) => Param::Str(s),
                Value::Bool(b) => Param::Bool(b),
                Value::Number(n) => n
                    .as_f64()
                    .map(Param::Num)
                    .ok_or_else(|| serde::de::Error::custom("a cmux param number out of range"))?,
                _ => {
                    return Err(serde::de::Error::custom(
                        "a cmux param is a string, number or bool",
                    ));
                }
            };
            Ok((k, p))
        })
        .collect()
}

impl Operation for CmuxCall {
    type Output = ();
}

/// One entry for the state handler to set (or, with no value, delete) in
/// config/state.json, as the sidebar's `persistSet`. The shell opens its
/// URL, as the sidebar does, and the handler does the locked write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateSet {
    /// `<map>.<id>`.
    pub key: String,
    pub value: Option<Value>,
}

impl StateSet {
    /// The `cmux-cockpit://set` URL the handler reads, with the install's token.
    pub fn url(&self, token: &str) -> String {
        persist_url(&self.key, self.value.as_ref(), token)
    }
}

impl Operation for StateSet {
    type Output = ();
}

/// Asks the shell for the PR of the branch `directory` is on: it runs
/// `git` and `gh` there off the frame thread, as scripts/pr-poll.ts does
/// (pr_poll::git_args, pr_poll::gh_args), reads them with
/// pr_poll::answer, and sends the result back as `Event::PrPolled`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrAsk {
    pub directory: String,
    /// When it was asked, in epoch seconds: the answer carries it back.
    pub asked: f64,
}

impl Operation for PrAsk {
    type Output = ();
}

/// A link for the shell to open in the browser, as the sidebar's
/// `openURL`: the card menu's Open PR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenUrl {
    pub url: String,
}

impl Operation for OpenUrl {
    type Output = ();
}

/// Jon's words for the agent in a workspace, for the shell to send as
/// `cmux agent message <workspace> -- <text>` (message.rs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentMessage {
    pub workspace: String,
    pub text: String,
}

impl Operation for AgentMessage {
    type Output = ();
}

/// What the core can ask the shell to do.
#[effect(typegen)]
pub enum Effect {
    Render(RenderOperation),
    Cmux(CmuxCall),
    Persist(StateSet),
    PrPoll(PrAsk),
    OpenUrl(OpenUrl),
    AgentMessage(AgentMessage),
}

/// A request from the session's outbox as the command that hands it to the shell.
fn send_out(o: Outbound) -> Command<Effect, Event> {
    match o {
        Outbound::Cmux { method, params } => {
            Command::notify_shell(CmuxCall { method, params }).into()
        }
        Outbound::Persist { key, value } => Command::notify_shell(StateSet { key, value }).into(),
        Outbound::OpenUrl { url } => Command::notify_shell(OpenUrl { url }).into(),
        Outbound::AgentMessage { workspace, text } => {
            Command::notify_shell(AgentMessage { workspace, text }).into()
        }
    }
}

/// The cockpit app.
#[derive(Debug, Default)]
pub struct Cockpit;

fn ids(list: &[&Workspace]) -> Vec<String> {
    list.iter().map(|w| w.id.clone()).collect()
}

/// The All view for a frame.
pub fn build_view(s: &mut Session, data: &Data) -> ViewModel {
    let strip = s.needs(data);
    let needs = NeedsView {
        list: ids(&strip.list),
        shown: ids(&strip.shown),
        in_strip: strip.in_strip.iter().cloned().collect(),
        more: strip.more,
        wait_text: strip.wait_text,
        late: strip.late,
    };
    let queue = s.next_queue_after(data, strip.list);
    let step = s.next_step_in(data, &queue).map(|st| StepView {
        target: st.target.id.clone(),
        position: st.position,
        total: st.total,
    });
    let cards = s.lane_cards(data);
    let lane_entries = s.lane_entries_from(data, &cards, &strip.in_strip);
    let mut lane_headers = BTreeMap::new();
    for (lane, lane_cards) in &cards {
        let header = LaneHeaderView {
            collapsed: s.is_collapsed(data, lane),
            workspaces: ids(lane_cards),
            merge_ready: s.merge_ready_of(data, lane.key, lane_cards),
        };
        lane_headers.insert(lane.key, header);
    }
    ViewModel {
        mode: s.mode().as_str().to_string(),
        needs,
        next: NextView {
            queue: ids(&queue),
            step,
        },
        lane_entries,
        lane_headers,
        panel: None,
    }
}

impl Model {
    /// One of Jon's actions, against the latest frame; none before the first.
    fn act(&mut self, event: Event) {
        if let Event::CmuxFailed { id } = &event {
            self.session.request_failed(id);
            return;
        }
        if let Event::FlipView = event {
            let other = if self.session.projects_mode() {
                ViewMode::All
            } else {
                ViewMode::Projects
            };
            self.session.choose_mode(other);
            return;
        }
        let Some(data) = &self.data else { return };
        let s = &mut self.session;
        match event {
            Event::MoveCard { id, lane, before } => s.move_card(data, &id, lane, before.as_deref()),
            Event::SwitchTo { id } => s.select_workspace(data, Some(&id)),
            Event::Selected { id } => s.mark_selected(data, &id),
            Event::Dismiss { id } => s.dismiss_waiting(data, data.ws_by_id(&id)),
            Event::Edit(e) => s.edit(data, e),
            Event::Menu(e) => s.menu(data, e),
            Event::OpenProject { key } => s.open_project_workspace(data, &key, None),
            // Only a card that offers it: the pane's key reaches every card.
            Event::FileForReview { id } => {
                let w = data.ws_by_id(&id);
                if s.can_file_for_review(data, w) {
                    s.file_for_review(data, w);
                }
            }
            // Each refuses a card that does not offer it, for the same reason.
            Event::ParkMerged { id } => s.park_merged(data, data.ws_by_id(&id)),
            Event::CloseMerged { id } => s.close_merged(data, data.ws_by_id(&id)),
            Event::KeepMerged { id } => s.keep_merged(data, data.ws_by_id(&id)),
            Event::Next => s.jump_next(data),
            Event::MessageAgent { id, text } => s.message_agent(data, &id, &text),
            Event::ToggleLane { lane } => s.toggle_lane(data, &lane_by_key(lane)),
            Event::ToggleProject { key } => s.toggle_project(data, &key),
            Event::ToggleQuiet => s.toggle_quiet(data),
            _ => {}
        }
    }

    /// Makes the poll's answers over the saved PRs, so a new frame or
    /// state file never hides a fresher answer.
    fn overlay(&mut self) {
        if let Some(data) = &self.data {
            let s = &mut self.session;
            s.pr_poll.overlay(&mut s.saved.prs, data);
        }
    }

    /// The PR asks now due, at epoch `now`.
    fn asks(&mut self, now: Option<f64>) -> Vec<Command<Effect, Event>> {
        let (Some(data), Some(now)) = (&self.data, now) else {
            return Vec::new();
        };
        let due = self.session.pr_poll.due(data, now);
        due.into_iter()
            .map(|directory| {
                let ask = PrAsk {
                    directory,
                    asked: now,
                };
                Command::notify_shell(ask).into()
            })
            .collect()
    }

    /// An answer: held, then a redraw only when what a card shows of a
    /// PR in that directory changed, then any asks it makes room for.
    fn polled(&mut self, polled: PrPolled) -> Command<Effect, Event> {
        let directory = polled.directory.clone();
        let now = polled.epoch;
        let shown = |m: &Model| {
            m.data
                .as_ref()
                .map(|d| shown_in(&m.session.saved.prs, d, &directory))
        };
        let before = shown(self);
        self.session.pr_poll.record(polled);
        self.overlay();
        let moved = before != shown(self);
        let mut out = self.asks(Some(now));
        if moved {
            self.rebuild();
            // A rebuild can file a card whose lane group has appeared.
            out.extend(self.session.take_outbox().into_iter().map(send_out));
            out.push(render());
        }
        Command::all(out)
    }

    /// Moves the frame's clock on to `now`, never back.
    fn advance_clock(&mut self, now: f64) {
        if let Some(data) = &mut self.data {
            data.epoch = Some(data.epoch.map_or(now, |e| e.max(now)));
        }
    }

    fn rebuild(&mut self) {
        if let Some(data) = &self.data {
            self.session.close_stale_menu(data);
        }
        self.view = match &self.data {
            Some(data) => build_view(&mut self.session, data),
            None => ViewModel {
                mode: self.session.mode().as_str().to_string(),
                ..ViewModel::default()
            },
        };
        if self.panel_on {
            let panel = Panel::from_core(self);
            self.view.panel = Some(panel);
        }
    }
}

impl App for Cockpit {
    type Event = Event;
    type Model = Model;
    type ViewModel = ViewModel;
    type Effect = Effect;

    fn update(&self, event: Event, model: &mut Model) -> Command<Effect, Event> {
        if let Event::At { now, event } = event {
            model.advance_clock(now);
            return self.update(*event, model);
        }
        match event {
            Event::Data(mut data) => {
                // A frame's clock never takes the core's back past a
                // click's or a tick's (#279): the sidebar moves it to its
                // own now between frames.
                let last = model.data.as_ref().and_then(|d| d.epoch);
                if let (Some(last), Some(now)) = (last, data.epoch) {
                    data.epoch = Some(now.max(last));
                }
                model.data = Some(data);
            }
            Event::State(saved) => {
                let s = &mut model.session;
                s.pr_poll.file_read(&saved.prs, model.data.as_ref());
                s.reseed(*saved);
            }
            Event::Projects(projects) => model.session.set_projects(projects),
            Event::Home { home } => model.session.home = home,
            Event::Refresh => {}
            Event::PrPollOn => model.session.pr_poll.turn_on(),
            Event::PanelOn => model.panel_on = true,
            Event::PrPolled(polled) => return model.polled(*polled),
            action => model.act(action),
        }
        model.overlay();
        model.rebuild();
        let now = model.data.as_ref().and_then(|d| d.epoch);
        let asks = model.asks(now);
        let out = model.session.take_outbox().into_iter().map(send_out);
        Command::all(out.chain(asks).chain(std::iter::once(render())))
    }

    fn view(&self, model: &Model) -> ViewModel {
        model.view.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_jons_actions_from_the_shells_inputs() {
        assert!(Event::FlipView.is_action());
        assert!(Event::Menu(MenuEvent::Close).is_action());
        assert!(Event::Edit(EditEvent::Close).is_action());
        assert!(Event::ParkMerged { id: "a".into() }.is_action());
        assert!(Event::CloseMerged { id: "a".into() }.is_action());
        assert!(Event::KeepMerged { id: "a".into() }.is_action());
        assert!(Event::Next.is_action());
        assert!(Event::Selected { id: "a".into() }.is_action());
        assert!(Event::ToggleQuiet.is_action());
        assert!(Event::ToggleProject { key: "a".into() }.is_action());
        assert!(
            Event::ToggleLane {
                lane: LaneKey::Main
            }
            .is_action()
        );
        let text = "hi".to_string();
        assert!(
            Event::MessageAgent {
                id: "a".into(),
                text
            }
            .is_action()
        );
        assert!(!Event::Refresh.is_action());
        assert!(!Event::CmuxFailed { id: "a".into() }.is_action());
        assert!(!Event::Projects(Vec::new()).is_action());
        assert!(!Event::Home { home: None }.is_action());
    }

    #[test]
    fn refresh_asks_the_shell_to_render() {
        let app = Cockpit;
        let mut model = Model::default();
        let mut cmd = app.update(Event::Refresh, &mut model);

        let effects: Vec<Effect> = cmd.effects().collect();
        assert!(matches!(effects.as_slice(), [Effect::Render(_)]));
        assert_eq!(app.view(&model).mode, ViewMode::All.as_str());
    }

    /// The state writes among a command's effects, as (key, value).
    fn writes(effects: &[Effect]) -> Vec<(String, Option<Value>)> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::Persist(r) => Some((r.operation.key.clone(), r.operation.value.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn keeps_what_jon_set_when_the_project_table_changes() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::State(Box::default()), &mut model);
        model.session.choose_mode(ViewMode::Projects);
        let mut cmd = app.update(Event::Projects(Vec::new()), &mut model);
        assert_eq!(app.view(&model).mode, "projects");
        let effects: Vec<Effect> = cmd.effects().collect();
        assert_eq!(
            writes(&effects),
            [("ui.mode".to_string(), Some(Value::from("projects")))],
            "the mode's save goes out"
        );
    }

    #[test]
    fn keeps_a_write_a_new_state_file_does_not_show_yet_until_one_does() {
        let app = Cockpit;
        let mut model = Model::default();
        model.session.choose_mode(ViewMode::Projects);
        let mut cmd = app.update(Event::State(Box::default()), &mut model);
        assert_eq!(app.view(&model).mode, "projects", "the write is on its way");
        let effects: Vec<Effect> = cmd.effects().collect();
        assert_eq!(writes(&effects).len(), 1, "the mode's save still goes out");
        assert!(
            matches!(effects.last(), Some(Effect::Render(_))),
            "the render comes after the requests"
        );
        assert!(model.session.outbox().is_empty(), "nothing is left waiting");

        let shown = SavedState::from_json(r#"{"ui":{"mode":"projects"}}"#).unwrap();
        let _ = app.update(Event::State(Box::new(shown)), &mut model);
        // Once a file has shown it, a later file's own word wins.
        let _ = app.update(Event::State(Box::default()), &mut model);
        assert_eq!(app.view(&model).mode, "all");
    }

    #[test]
    fn a_new_project_saved_in_the_editor_goes_out_as_a_state_write_then_its_workspace() {
        let app = Cockpit;
        let mut model = Model::default();
        // Home as the sidebar's core has it, by event (#270).
        let home = Some("/Users/jon".to_string());
        let _ = app.update(Event::Home { home }, &mut model);
        let _ = app.update(frame(100.0), &mut model);
        let _ = app.update(Event::Edit(EditEvent::OpenNew), &mut model);
        let typed = EditEvent::Folder("~/dev/pianola".into());
        let _ = app.update(Event::Edit(typed), &mut model);
        let mut cmd = app.update(Event::Edit(EditEvent::Save), &mut model);
        let effects: Vec<Effect> = cmd.effects().collect();
        let key = "projects./users/jon/dev/pianola/".to_string();
        let saved = writes(&effects);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].0, key);
        assert!(
            matches!(&effects[1], Effect::Cmux(c) if c.operation.method == "workspace.create"),
            "then a workspace opens there"
        );
        assert!(matches!(effects.last(), Some(Effect::Render(_))));

        // Once a state file shows the write, it is no longer made over the next one.
        let shown = serde_json::json!({ "projects": { "/users/jon/dev/pianola/": saved[0].1 } });
        let file = SavedState::from_json(&shown.to_string()).unwrap();
        let _ = app.update(Event::State(Box::new(file)), &mut model);
        let _ = app.update(Event::State(Box::default()), &mut model);
        assert!(
            model.session.saved.projects.is_empty(),
            "the write was seen"
        );
    }

    /// The effects of one event, in words: `render` or `pr <directory>`.
    fn asked(app: &Cockpit, model: &mut Model, event: Event) -> Vec<String> {
        let mut cmd = app.update(event, model);
        cmd.effects()
            .map(|e| match e {
                Effect::Render(_) => "render".to_string(),
                Effect::PrPoll(r) => format!("pr {}", r.operation.directory),
                Effect::Cmux(_)
                | Effect::Persist(_)
                | Effect::OpenUrl(_)
                | Effect::AgentMessage(_) => "other".to_string(),
            })
            .collect()
    }

    #[test]
    fn a_message_for_an_agent_goes_out_as_its_own_request() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(100.0), &mut model);
        let text = "Rebase when free.".to_string();
        let mut cmd = app.update(
            Event::MessageAgent {
                id: "b".into(),
                text,
            },
            &mut model,
        );
        let effects: Vec<Effect> = cmd.effects().collect();
        let want = AgentMessage {
            workspace: "b".into(),
            text: "Rebase when free.".into(),
        };
        assert_eq!(effects.len(), 2);
        assert!(matches!(&effects[0], Effect::AgentMessage(m) if m.operation == want));
        assert!(matches!(&effects[1], Effect::Render(_)));
    }

    #[test]
    fn a_select_the_shell_made_itself_draws_selected_with_no_cmux_call() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(100.0), &mut model);
        let selected = Event::Selected { id: "b".into() };
        assert_eq!(asked(&app, &mut model, selected), ["render"]);
        let Some(data) = &model.data else {
            panic!("the frame is held")
        };
        let b = data.ws_by_id("b");
        assert!(model.session.is_selected(data, b));
    }

    #[test]
    fn next_with_nothing_waiting_asks_cmux_for_nothing() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(100.0), &mut model);
        assert_eq!(asked(&app, &mut model, Event::Next), ["render"]);
    }

    #[test]
    fn a_cmux_call_crosses_the_bridge_as_the_object_cmux_reads() {
        let call = CmuxCall {
            method: "workspace.reorder".into(),
            params: vec![
                ("workspace_id".into(), Param::Str("W1".into())),
                ("index".into(), Param::Num(3.0)),
                ("focus".into(), Param::Bool(false)),
            ],
        };
        let json = serde_json::to_value(&call).unwrap();
        let params = serde_json::json!({ "workspace_id": "W1", "index": 3, "focus": false });
        assert_eq!(json["params"], params);
        assert_eq!(json["params"], call.params_json());
        assert_eq!(serde_json::from_value::<CmuxCall>(json).unwrap(), call);
    }

    /// A switch at `now`, as the sidebar sends a click.
    fn switch_at(now: f64) -> Event {
        let event = Box::new(Event::SwitchTo { id: "b".into() });
        Event::At { now, event }
    }

    #[test]
    fn a_timed_event_is_whatever_it_carries() {
        assert!(switch_at(1.0).is_action());
        let event = Box::new(Event::Refresh);
        assert!(!Event::At { now: 1.0, event }.is_action());
    }

    #[test]
    fn a_click_between_frames_stamps_its_override_with_its_own_time() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(1000.0), &mut model);
        let _ = app.update(switch_at(1005.0), &mut model);
        let stamp = model.session.select_override.clone();
        assert_eq!(stamp, Some(("b".to_string(), 1005.0)));
    }

    #[test]
    fn a_click_timed_before_the_frame_never_turns_the_clock_back() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(1000.0), &mut model);
        let _ = app.update(switch_at(990.0), &mut model);
        let stamp = model.session.select_override.clone();
        assert_eq!(stamp, Some(("b".to_string(), 1000.0)));
    }

    fn frame(epoch: f64) -> Event {
        let data = serde_json::json!({ "epoch": epoch, "workspaces": [
            { "id": "a", "directory": "/a" }, { "id": "b", "directory": "/a" },
        ]});
        Event::Data(serde_json::from_value(data).unwrap())
    }

    #[test]
    fn a_frame_older_than_the_last_tick_leaves_the_clock_where_it_was() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(1000.0), &mut model);
        let tick = Event::At {
            now: 1010.0,
            event: Box::new(Event::Refresh),
        };
        let _ = app.update(tick, &mut model);
        let _ = app.update(frame(1005.0), &mut model);
        assert_eq!(model.data.as_ref().and_then(|d| d.epoch), Some(1010.0));
        let _ = app.update(frame(1020.0), &mut model);
        assert_eq!(model.data.as_ref().and_then(|d| d.epoch), Some(1020.0));
    }

    fn found(checks: &[(&str, &str)], epoch: f64) -> Event {
        let checks: Vec<Value> = checks
            .iter()
            .map(|(name, state)| serde_json::json!({ "name": name, "state": state }))
            .collect();
        let pr = serde_json::json!({ "number": 4, "url": "https://github.com/o/r/pull/4",
            "status": "open", "branch": "feat", "checks": checks });
        Event::PrPolled(Box::new(PrPolled {
            directory: "/a".into(),
            asked: epoch - 1.0,
            answer: crate::pr_poll::PollAnswer::Answered {
                branch: "feat".into(),
                pr: Some(serde_json::from_value(pr).unwrap()),
            },
            epoch,
        }))
    }

    #[test]
    fn asks_for_each_directorys_pr_once_the_shell_turns_the_poll_on() {
        let app = Cockpit;
        let mut model = Model::default();
        assert_eq!(asked(&app, &mut model, frame(100.0)), ["render"]);
        assert_eq!(
            asked(&app, &mut model, Event::PrPollOn),
            ["pr /a", "render"],
            "two workspaces, one directory, one ask"
        );
        assert_eq!(asked(&app, &mut model, frame(102.0)), ["render"]);
    }

    #[test]
    fn a_poll_result_redraws_only_when_a_chip_would_change() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::PrPollOn, &mut model);
        let _ = app.update(frame(100.0), &mut model);
        let first = found(&[("build", "pending"), ("lint", "pass")], 101.0);
        assert_eq!(asked(&app, &mut model, first), ["render"], "a PR appeared");
        assert_eq!(
            model.session.saved.prs.len(),
            2,
            "both workspaces in /a have it"
        );

        let _ = app.update(frame(131.0), &mut model);
        let same_chip = found(&[("build", "pending"), ("lint2", "pending")], 132.0);
        assert!(
            asked(&app, &mut model, same_chip).is_empty(),
            "a check renamed and another running: the chip still says running"
        );
        let checks = |m: &Model| m.session.saved.prs.get("a").and_then(|p| p.checks.clone());
        assert_eq!(
            checks(&model).map(|c| c.len()),
            Some(2),
            "held all the same"
        );

        let _ = app.update(frame(162.0), &mut model);
        let failing = found(&[("build", "fail")], 163.0);
        assert_eq!(asked(&app, &mut model, failing), ["render"]);
    }

    #[test]
    fn a_new_state_file_never_hides_a_fresher_answer() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::PrPollOn, &mut model);
        let _ = app.update(frame(100.0), &mut model);
        let _ = app.update(found(&[("build", "fail")], 101.0), &mut model);
        let _ = app.update(Event::State(Box::default()), &mut model);
        assert_eq!(model.session.saved.prs.len(), 2);

        // The TypeScript poll then writes something newer for one of them.
        let newer = r#"{"prs": {"a": {"number": 4, "url": "https://github.com/o/r/pull/4",
            "status": "merged", "branch": "feat"}}}"#;
        let file = SavedState::from_json(newer).unwrap();
        let _ = app.update(Event::State(Box::new(file)), &mut model);
        let status = model.session.saved.prs.get("a").map(|p| p.status);
        assert_eq!(
            status,
            Some(crate::data::PrStatus::Merged),
            "the file is fresher"
        );
        assert!(
            !model.session.saved.prs.contains_key("b"),
            "the file has none for b"
        );
    }

    /// A frame with a merged card `m` and an open one `a`.
    fn merged_frame() -> Event {
        let data = serde_json::json!({ "epoch": 100.0, "workspaces": [
            { "id": "a", "directory": "/a" },
            { "id": "m", "directory": "/m",
              "pr": { "number": 7, "status": "merged", "url": "https://github.com/o/r/pull/7" } },
        ]});
        Event::Data(serde_json::from_value(data).unwrap())
    }

    fn closes(effects: &[Effect]) -> usize {
        effects
            .iter()
            .filter(|e| matches!(e, Effect::Cmux(c) if c.operation.method == "workspace.close"))
            .count()
    }

    #[test]
    fn a_merged_cards_park_close_and_keep_act_only_on_a_card_that_offers_them() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(merged_frame(), &mut model);
        for id in ["a", "m"] {
            let mut cmd = app.update(Event::CloseMerged { id: id.into() }, &mut model);
            let effects: Vec<Effect> = cmd.effects().collect();
            assert_eq!(closes(&effects), usize::from(id == "m"), "close on {id}");
        }

        let mut cmd = app.update(Event::KeepMerged { id: "a".into() }, &mut model);
        let effects: Vec<Effect> = cmd.effects().collect();
        assert!(writes(&effects).is_empty(), "nothing to keep on an open PR");
        let mut cmd = app.update(Event::KeepMerged { id: "m".into() }, &mut model);
        let effects: Vec<Effect> = cmd.effects().collect();
        assert_eq!(writes(&effects)[0].0, "mergeKept.m");
        let mut cmd = app.update(Event::CloseMerged { id: "m".into() }, &mut model);
        let effects: Vec<Effect> = cmd.effects().collect();
        assert_eq!(closes(&effects), 0, "kept: Close is hidden");
    }

    #[test]
    fn park_files_a_merged_card_into_parked_and_leaves_an_open_one() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(merged_frame(), &mut model);
        let _ = app.update(Event::ParkMerged { id: "a".into() }, &mut model);
        let _ = app.update(Event::ParkMerged { id: "m".into() }, &mut model);
        let Some(data) = model.data.clone() else {
            panic!("no frame")
        };
        let lane = |model: &mut Model, id: &str| {
            let w = data.ws_by_id(id).unwrap();
            model.session.lane_of(&data, w)
        };
        assert_eq!(lane(&mut model, "m"), LaneKey::Parked);
        assert_ne!(lane(&mut model, "a"), LaneKey::Parked);
    }
}
