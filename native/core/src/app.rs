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
use crate::lanes::{LaneConfig, LaneKey};
use crate::menu::MenuEvent;
use crate::panel::Panel;
use crate::persist::{SavedPr, SavedRunning, SavedState, ViewMode, persist_url};
use crate::pr_poll::{PrPolled, shown_in};
use crate::projects::Project;
use crate::running_save::{RunningSaves, verdicts};
use crate::session::{Outbound, Param, Session};
use crate::sleep::SleepAnswer;

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
    /// A new lane table, as config/lanes.json lists it (lanes.rs); an
    /// empty one is today's four. A table the core cannot draw leaves the
    /// last one in place.
    #[facet(skip)]
    Lanes(#[facet(opaque)] Vec<LaneConfig>),
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
    /// Dismisses the workspace's asks from Needs you, as the card menu's
    /// Dismiss needs you and the pane's 'd' do.
    Dismiss { id: String },
    /// A tap on Next's Needs you pill: switches to the workspace it names,
    /// first unfolding whatever hides its card, as Next does.
    Reveal { id: String },
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
    /// A pick from the All view's add button: a new session in the
    /// project's folder, or with none in the home folder, in the first
    /// lane (by_project.rs `add_session`).
    AddSession { project: Option<String> },
    /// A pick from the All view's filter: only a project's cards in the
    /// lanes, the cards with no project (`filter::NO_PROJECT`), or with
    /// None every card again (filter.rs).
    FilterProject { key: Option<String> },
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
    /// cmux's answer to putting an agent to sleep or waking it (sleep.rs),
    /// which the shell carries out off the frame thread.
    #[facet(skip)]
    Slept(#[facet(opaque)] Box<SleepAnswer>),
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
            | Event::Lanes(_)
            | Event::Home { .. }
            | Event::Refresh
            | Event::PrPollOn
            | Event::PanelOn
            | Event::PrPolled(_)
            | Event::Slept(_)
            | Event::CmuxFailed { .. } => false,
            Event::MoveCard { .. }
            | Event::SwitchTo { .. }
            | Event::Selected { .. }
            | Event::Dismiss { .. }
            | Event::Reveal { .. }
            | Event::FlipView
            | Event::Edit(_)
            | Event::OpenProject { .. }
            | Event::AddSession { .. }
            | Event::FilterProject { .. }
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
    /// The background verdicts sent for the state file (running_save.rs).
    pub running_saves: RunningSaves,
}

/// Needs you as the shell draws it, workspaces by id, longest waiting
/// first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsView {
    pub list: Vec<String>,
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
    /// While the project filter is on, every card the lane holds, shown
    /// or not, so its header reads "1 of 4"; None while every card shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

/// What the shell draws: the All view.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
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

/// The PR poll's answers for config/state.json's `prs` map (#300), by
/// workspace id: a PR to set, or null to delete. The shell hands them to
/// scripts/pr-save.ts, which writes them under the state file's lock and
/// rebuilds the sidebars, so the agents panel reads the card's verdict.
/// Only what changed comes this way (pr_poll's `writes`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrSave {
    pub prs: BTreeMap<String, Option<SavedPr>>,
}

impl Operation for PrSave {
    type Output = ();
}

/// The core's background verdicts for config/state.json's `running` map
/// (#360), by workspace id: a verdict to set, or null to delete. The
/// shell hands them to scripts/running-save.ts, which writes them under
/// the state file's lock and rebuilds the sidebars, so the agents panel
/// says Running when the card does. Only what changed comes this way
/// (running_save.rs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunningSave {
    pub running: BTreeMap<String, Option<SavedRunning>>,
}

impl Operation for RunningSave {
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

/// Words for the shell to put on the clipboard: the card menu's Copy PR
/// link and Copy branch. The sidebar writes them to its own pasteboard on
/// the click; the runner hands them to `pbcopy`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyText {
    pub text: String,
}

impl Operation for CopyText {
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
    Copy(CopyText),
    AgentMessage(AgentMessage),
    SavePrs(PrSave),
    SaveRunning(RunningSave),
}

/// A request from the session's outbox as the command that hands it to the shell.
fn send_out(o: Outbound) -> Command<Effect, Event> {
    match o {
        Outbound::Cmux { method, params } => {
            Command::notify_shell(CmuxCall { method, params }).into()
        }
        Outbound::Persist { key, value } => Command::notify_shell(StateSet { key, value }).into(),
        Outbound::OpenUrl { url } => Command::notify_shell(OpenUrl { url }).into(),
        Outbound::Copy { text } => Command::notify_shell(CopyText { text }).into(),
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
        wait_text: strip.wait_text,
        late: strip.late,
    };
    let queue = s.next_queue_after(data, strip.list);
    let step = s.next_step_in(data, &queue).map(|st| StepView {
        target: st.target.id.clone(),
        position: st.position,
        total: st.total,
    });
    let mut cards = s.lane_cards_all(data);
    let totals: Vec<usize> = cards.iter().map(|(_, ws)| ws.len()).collect();
    let filtered = s.filter().is_some();
    s.keep_shown(&mut cards);
    let lane_entries = s.lane_entries_from(data, &cards);
    let mut lane_headers = BTreeMap::new();
    for ((lane, lane_cards), total) in cards.iter().zip(totals) {
        let header = LaneHeaderView {
            collapsed: s.is_collapsed(data, lane),
            workspaces: ids(lane_cards),
            merge_ready: s.merge_ready_of(data, &lane.key, lane_cards),
            total: filtered.then_some(total),
        };
        lane_headers.insert(lane.key.clone(), header);
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
            Event::Dismiss { id } => s.dismiss_needs(data.ws_by_id(&id)),
            Event::Reveal { id } => s.reveal_workspace(data, data.ws_by_id(&id)),
            Event::Edit(e) => s.edit(data, e),
            Event::Menu(e) => s.menu(data, e),
            Event::OpenProject { key } => s.open_project_workspace(data, &key, None),
            Event::AddSession { project } => s.add_session(data, project.as_deref()),
            Event::FilterProject { key } => s.choose_filter(key.as_deref()),
            Event::Next => s.jump_next(data),
            Event::MessageAgent { id, text } => s.message_agent(data, &id, &text),
            Event::ToggleLane { lane } => s.toggle_lane(data, &lane),
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

    /// An answer: held, then written to the state file where it differs
    /// from it, then a redraw only when what a card shows of a PR in that
    /// directory changed, then any asks it makes room for.
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
        let prs = self
            .data
            .as_ref()
            .map(|d| self.session.pr_poll.writes(d, &directory))
            .unwrap_or_default();
        let mut out = Vec::new();
        if !prs.is_empty() {
            out.push(Command::notify_shell(PrSave { prs }).into());
        }
        out.extend(self.asks(Some(now)));
        if moved {
            self.rebuild();
            // A rebuild can file a card whose lane group has appeared.
            out.extend(self.session.take_outbox().into_iter().map(send_out));
            out.push(render());
        }
        Command::all(out)
    }

    /// The background verdicts the state file lacks, as one save. Only the
    /// core that draws the sidebar writes them, so the pane's never
    /// doubles a write, and never before a frame lists its workspaces.
    fn running_writes(&mut self) -> Option<Command<Effect, Event>> {
        if !self.panel_on {
            return None;
        }
        let data = self.data.as_ref()?;
        let now = verdicts(&mut self.session, data)?;
        let running = self
            .running_saves
            .writes(&self.session.saved.running, &now, data.epoch);
        (!running.is_empty()).then(|| Command::notify_shell(RunningSave { running }).into())
    }

    /// Moves the frame's clock on to `now`, never back.
    fn advance_clock(&mut self, now: f64) {
        if let Some(data) = &mut self.data {
            data.epoch = Some(data.epoch.map_or(now, |e| e.max(now)));
        }
    }

    /// Builds the frame's view, reading each card's work once.
    fn rebuild(&mut self) {
        self.framed(Model::build);
    }

    /// Runs `f` inside a frame (`Session::framed`), with the whole model.
    fn framed<R>(&mut self, f: impl FnOnce(&mut Model) -> R) -> R {
        let opened = self.session.begin_frame();
        let out = f(self);
        if opened {
            self.session.end_frame();
        }
        out
    }

    fn build(&mut self) {
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
                model.running_saves.file_read();
            }
            Event::Projects(projects) => model.session.set_projects(projects),
            Event::Lanes(lanes) => model.session.set_lanes(&lanes),
            Event::Home { home } => model.session.home = home,
            Event::Refresh => {}
            Event::PrPollOn => model.session.pr_poll.turn_on(),
            Event::PanelOn => {
                model.panel_on = true;
                model.session.filters = true;
            }
            Event::PrPolled(polled) => return model.polled(*polled),
            Event::Slept(answer) => {
                if let Some(data) = &model.data {
                    model.session.sleep_answered(data, *answer);
                }
            }
            action => model.act(action),
        }
        if let Some(data) = &model.data {
            // Only the core that draws the sidebar acts on the shared
            // record, so the pane's never doubles a wake.
            model.session.tend_sleep(data, model.panel_on);
        }
        model.session.tend_filter();
        model.overlay();
        // The verdicts read the same cards as the view, in the same frame.
        let saves = model.framed(|m| {
            m.build();
            m.running_writes()
        });
        let now = model.data.as_ref().and_then(|d| d.epoch);
        let asks = model.asks(now);
        let out = model.session.take_outbox().into_iter().map(send_out);
        Command::all(
            out.chain(asks)
                .chain(saves)
                .chain(std::iter::once(render())),
        )
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
        assert!(Event::Next.is_action());
        assert!(Event::Selected { id: "a".into() }.is_action());
        assert!(Event::ToggleQuiet.is_action());
        assert!(Event::ToggleProject { key: "a".into() }.is_action());
        assert!(
            Event::ToggleLane {
                lane: LaneKey::from("main")
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
        let answer: Event = serde_json::from_value(serde_json::json!({
            "Slept": {"workspace": "a", "surface": "S1", "wake": false, "refused": "visible"}
        }))
        .unwrap();
        assert!(!answer.is_action());
        assert!(!Event::Projects(Vec::new()).is_action());
        assert!(!Event::Lanes(Vec::new()).is_action());
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

    /// The effects of one event, in words: `render`, `pr <directory>` or
    /// `save <workspace ids>`.
    fn asked(app: &Cockpit, model: &mut Model, event: Event) -> Vec<String> {
        let mut cmd = app.update(event, model);
        cmd.effects()
            .map(|e| match e {
                Effect::Render(_) => "render".to_string(),
                Effect::PrPoll(r) => format!("pr {}", r.operation.directory),
                Effect::SavePrs(r) => {
                    let ids: Vec<&str> = r.operation.prs.keys().map(String::as_str).collect();
                    format!("save {}", ids.join(" "))
                }
                Effect::SaveRunning(r) => {
                    let ids: Vec<&str> = r.operation.running.keys().map(String::as_str).collect();
                    format!("running {}", ids.join(" "))
                }
                Effect::Cmux(_)
                | Effect::Persist(_)
                | Effect::OpenUrl(_)
                | Effect::Copy(_)
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
        let stamp = model.session.select_override.map(|o| (o.id, o.at));
        assert_eq!(stamp, Some(("b".to_string(), 1005.0)));
    }

    #[test]
    fn a_click_timed_before_the_frame_never_turns_the_clock_back() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(1000.0), &mut model);
        let _ = app.update(switch_at(990.0), &mut model);
        let stamp = model.session.select_override.map(|o| (o.id, o.at));
        assert_eq!(stamp, Some(("b".to_string(), 1000.0)));
    }

    #[test]
    fn taps_back_and_forth_keep_one_entry_per_workspace() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(frame(1000.0), &mut model);
        for id in ["a", "b", "a", "b"] {
            let event = Box::new(Event::SwitchTo { id: id.into() });
            let _ = app.update(Event::At { now: 1001.0, event }, &mut model);
        }
        let stale = model.session.select_override.map(|o| o.stale);
        assert_eq!(stale, Some(vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn a_select_cmux_refused_stops_showing_the_clicked_card() {
        let app = Cockpit;
        let mut model = Model::default();
        let data = serde_json::json!({ "epoch": 1000.0, "selectedId": "a", "workspaces": [
            { "id": "a", "directory": "/a", "selected": true },
            { "id": "b", "directory": "/a" },
        ]});
        let _ = app.update(
            Event::Data(serde_json::from_value(data).unwrap()),
            &mut model,
        );
        let _ = app.update(switch_at(1001.0), &mut model);
        let refused = Event::CmuxFailed { id: "b".into() };
        let _ = app.update(refused, &mut model);
        let Some(data) = &model.data else {
            panic!("the frame is held")
        };
        let (a, b) = (data.ws_by_id("a"), data.ws_by_id("b"));
        assert!(!model.session.is_selected(data, b));
        assert!(model.session.is_selected(data, a));
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

    /// A frame where `a`'s chat `c` sits idle, and a state file where it
    /// runs one shell.
    fn idle_chat() -> Event {
        let data = serde_json::json!({ "epoch": 1000, "workspaces": [
            { "id": "a", "agents": [{ "id": "c", "status": "idle" }] }, { "id": "b" },
        ]});
        Event::Data(serde_json::from_value(data).unwrap())
    }

    fn running_shell(extra: &str) -> Event {
        let json = format!(
            r#"{{"background": {{"a": [{{"id": "b1", "type": "shell", "status": "running",
                "description": "d", "session": "c", "startedEpoch": 900, "seenEpoch": 950}}]}}{extra}}}"#
        );
        Event::State(Box::new(SavedState::from_json(&json).unwrap()))
    }

    #[test]
    fn the_sidebars_core_saves_a_background_verdict_once_until_the_file_shows_it() {
        let app = Cockpit;
        let mut model = Model::default();
        let mut pane = Model::default();
        let _ = app.update(running_shell(""), &mut pane);
        assert_eq!(
            asked(&app, &mut pane, idle_chat()),
            ["render"],
            "the pane never saves"
        );

        let _ = app.update(Event::PanelOn, &mut model);
        let _ = app.update(running_shell(""), &mut model);
        let mut cmd = app.update(idle_chat(), &mut model);
        let saved: Vec<RunningSave> = cmd
            .effects()
            .filter_map(|e| match e {
                Effect::SaveRunning(r) => Some(r.operation),
                _ => None,
            })
            .collect();
        let [save] = saved.as_slice() else {
            panic!("one save, got {saved:?}")
        };
        let v = save.running.get("a").cloned().flatten();
        assert_eq!(
            v.as_ref().map(|v| (v.agent.as_str(), v.since)),
            Some(("c", 900.0))
        );
        assert_eq!(save.running.len(), 1, "b runs nothing");
        assert_eq!(
            asked(&app, &mut model, idle_chat()),
            ["render"],
            "sent already"
        );

        // The file shows it: nothing more. The work ends: a delete.
        let shown = r#", "running": {"a": {"agent": "c", "since": 900, "counts": [{"type": "shell", "n": 1}]}}"#;
        assert_eq!(asked(&app, &mut model, running_shell(shown)), ["render"]);
        let ended = r#"{"running": {"a": {"agent": "c", "since": 900, "counts": [{"type": "shell", "n": 1}]}}}"#;
        let ended = Event::State(Box::new(SavedState::from_json(ended).unwrap()));
        assert_eq!(asked(&app, &mut model, ended), ["running a", "render"]);
    }

    /// The sidebar's two-second tick moves the clock with no new frame or
    /// file, and that alone takes back a verdict whose last task has gone
    /// unlisted past its age (#371).
    #[test]
    fn a_tick_alone_clears_the_verdict_once_its_task_goes_stale() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::PanelOn, &mut model);
        let shown = r#", "running": {"a": {"agent": "c", "since": 900, "counts": [{"type": "shell", "n": 1}]}}"#;
        let _ = app.update(running_shell(shown), &mut model);
        assert_eq!(asked(&app, &mut model, idle_chat()), ["render"]);
        let tick = |now: f64| Event::At {
            now,
            event: Box::new(Event::Refresh),
        };
        let limit = 950.0 + crate::running::MAX_AGE_S;
        assert_eq!(asked(&app, &mut model, tick(limit)), ["render"]);
        assert_eq!(
            asked(&app, &mut model, tick(limit + 1.0)),
            ["running a", "render"]
        );
    }

    /// Card `id` as the sidebar's panel shows it.
    fn card_in(model: &Model, id: &str) -> Option<crate::panel::Card> {
        let panel = model.view.panel.as_ref();
        let rows = panel
            .into_iter()
            .flat_map(|p| &p.lanes)
            .flat_map(|l| &l.rows);
        rows.map(crate::panel::Row::card)
            .find(|c| c.ws_id == id)
            .cloned()
    }

    /// The frame `update` built, its cards' work read once and shared by
    /// lane order, the panel and the verdicts, against lane order built
    /// with no memo and a panel built on a memo of its own: lane order,
    /// headers and every card's words agree. Then card `a`'s status line,
    /// read inside a frame (a memo hit) and outside one: the same.
    fn agreed_status(model: &mut Model) -> String {
        assert!(model.session.card_memo.is_none(), "no memo between frames");
        let Some(data) = model.data.clone() else {
            panic!("the frame is held")
        };
        let mut lanes = build_view(&mut model.session, &data);
        lanes.panel = model.view.panel.clone();
        assert_eq!(lanes, model.view, "lane order and headers");
        let fresh = Panel::from_core(model);
        assert_eq!(Some(fresh), model.view.panel, "every card's words");
        assert!(
            model.session.card_memo.is_none(),
            "the panel closed its own"
        );

        let w = data.ws_by_id("a");
        assert!(model.session.begin_frame());
        let _ = build_view(&mut model.session, &data);
        let memo = model.session.card_memo.as_ref();
        assert!(memo.is_some_and(|m| m.contains_key("a")), "a was read");
        assert!(!model.session.begin_frame(), "a nested open leaves it be");
        let _ = Panel::from_core(model);
        assert!(model.session.card_memo.is_some(), "and so does the panel");
        let inside = model.session.status_line(&data, w);
        model.session.end_frame();
        let outside = model.session.status_line(&data, w);
        assert_eq!(inside, outside);
        outside
    }

    #[test]
    fn a_frame_reads_each_cards_work_once_and_the_next_frame_reads_it_afresh() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::PanelOn, &mut model);
        let _ = app.update(running_shell(""), &mut model);
        let _ = app.update(idle_chat(), &mut model);
        assert_eq!(agreed_status(&mut model), "Running 1m · 1 shell");
        let running = card_in(&model, "a");
        assert!(running.is_some(), "the card is drawn");

        // The work ends between frames: every reader moves with it.
        let shown = r#"{"running": {"a": {"agent": "c", "since": 900, "counts": [{"type": "shell", "n": 1}]}}}"#;
        let ended = Event::State(Box::new(SavedState::from_json(shown).unwrap()));
        assert_eq!(asked(&app, &mut model, ended), ["running a", "render"]);
        assert!(agreed_status(&mut model).starts_with("Idle"));
        assert_ne!(card_in(&model, "a"), running, "the card moved too");
        let _ = app.update(running_shell(""), &mut model);
        assert_eq!(agreed_status(&mut model), "Running 1m · 1 shell");
        assert_eq!(card_in(&model, "a"), running);
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
        assert_eq!(
            asked(&app, &mut model, first),
            ["save a b", "render"],
            "a PR appeared"
        );
        assert_eq!(
            model.session.saved.prs.len(),
            2,
            "both workspaces in /a have it"
        );

        let _ = app.update(frame(131.0), &mut model);
        let same_chip = found(&[("build", "pending"), ("lint2", "pending")], 132.0);
        assert_eq!(
            asked(&app, &mut model, same_chip),
            ["save a b"],
            "a check renamed and another running: the chip still says running, \
             but the agents panel lists the checks, so the file hears of it"
        );
        let checks = |m: &Model| m.session.saved.prs.get("a").and_then(|p| p.checks.clone());
        assert_eq!(
            checks(&model).map(|c| c.len()),
            Some(2),
            "held all the same"
        );

        let _ = app.update(frame(162.0), &mut model);
        let failing = found(&[("build", "fail")], 163.0);
        assert_eq!(asked(&app, &mut model, failing), ["save a b", "render"]);
    }

    #[test]
    fn an_answer_is_written_to_the_state_file_only_while_the_file_says_otherwise() {
        let app = Cockpit;
        let mut model = Model::default();
        let _ = app.update(Event::PrPollOn, &mut model);
        let _ = app.update(frame(100.0), &mut model);
        let mut cmd = app.update(found(&[("build", "pass")], 101.0), &mut model);
        let saved: Vec<PrSave> = cmd
            .effects()
            .filter_map(|e| match e {
                Effect::SavePrs(r) => Some(r.operation),
                _ => None,
            })
            .collect();
        let [save] = saved.as_slice() else {
            panic!("one save, got {saved:?}")
        };
        let pr = save.prs.get("a").cloned().flatten();
        assert_eq!(pr.as_ref().map(|p| p.number), Some(4.0));
        assert_eq!(save.prs.get("b").cloned().flatten(), pr, "b shares /a");

        // The file comes back holding the answer: the same answer again
        // writes nothing, and the next ask is still due.
        let back = serde_json::json!({ "prs": { "a": pr, "b": pr } });
        let file = SavedState::from_json(&back.to_string()).unwrap();
        let _ = app.update(Event::State(Box::new(file)), &mut model);
        let _ = app.update(frame(400.0), &mut model);
        assert_eq!(
            asked(&app, &mut model, found(&[("build", "pass")], 401.0)),
            Vec::<String>::new(),
            "nothing changed, so nothing is written or drawn"
        );
        assert_eq!(
            asked(&app, &mut model, found(&[("build", "fail")], 402.0)),
            Vec::<String>::new(),
            "an answer to an ask already answered is dropped"
        );
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
}
