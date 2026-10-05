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
use serde::Serialize;
use serde_json::{Map, Value};

use crate::data::{Data, Workspace};
use crate::js::json_num;
use crate::lane_entries::LaneEntry;
use crate::lanes::LaneKey;
use crate::persist::{SavedState, ViewMode, persist_url};
use crate::pr_poll::{PrPolled, shown_in};
use crate::projects::Project;
use crate::session::{Outbound, Param, Session};

/// What the shell can tell the core.
#[derive(Debug)]
pub enum Event {
    /// A new frame of cmux data.
    Data(Data),
    /// A new config/state.json. What the file holds is seeded from it
    /// again, as a reload seeds the sidebar, with the pane's own writes not
    /// in it yet made over it; everything held only in memory stays
    /// (Session::reseed).
    State(Box<SavedState>),
    /// A new project table. Only the table changes: the view, folds,
    /// dismissals and overrides Jon set since the state file was read stay.
    Projects(Vec<Project>),
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
    PrPolled(Box<PrPolled>),
}

/// Everything the core knows: the session, the latest frame, and the view
/// built from them. The view is built in `update`, since reading the
/// session tidies it and `view` only borrows the model.
#[derive(Debug, Default)]
pub struct Model {
    pub session: Session,
    pub data: Option<Data>,
    pub view: ViewModel,
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
}

/// A cmux socket command for the shell to send: `cmux rpc <method>
/// <params>`, as the sidebar's `cmux(method, params)`.
#[derive(Debug, Clone, PartialEq)]
pub struct CmuxCall {
    pub method: String,
    /// In the order the TypeScript writes them.
    pub params: Vec<(String, Param)>,
}

impl CmuxCall {
    /// The params as the JSON object cmux reads, in order.
    pub fn params_json(&self) -> Value {
        let map: Map<String, Value> = self
            .params
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
}

impl Operation for CmuxCall {
    type Output = ();
}

/// One entry for the state handler to set (or, with no value, delete) in
/// config/state.json, as the sidebar's `persistSet`. The shell opens its
/// URL, as the sidebar does, and the handler does the locked write.
#[derive(Debug, Clone, PartialEq)]
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrAsk {
    pub directory: String,
}

impl Operation for PrAsk {
    type Output = ();
}

/// What the core can ask the shell to do.
#[effect]
pub enum Effect {
    Render(RenderOperation),
    Cmux(CmuxCall),
    Persist(StateSet),
    PrPoll(PrAsk),
}

/// A request from the session's outbox as the command that hands it to the shell.
fn send_out(o: Outbound) -> Command<Effect, Event> {
    match o {
        Outbound::Cmux { method, params } => {
            Command::notify_shell(CmuxCall { method, params }).into()
        }
        Outbound::Persist { key, value } => Command::notify_shell(StateSet { key, value }).into(),
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
            Event::Dismiss { id } => s.dismiss_waiting(data, data.ws_by_id(&id)),
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
            .map(|directory| Command::notify_shell(PrAsk { directory }).into())
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
            out.push(render());
        }
        Command::all(out)
    }

    fn rebuild(&mut self) {
        self.view = match &self.data {
            Some(data) => build_view(&mut self.session, data),
            None => ViewModel {
                mode: self.session.mode().as_str().to_string(),
                ..ViewModel::default()
            },
        };
    }
}

impl App for Cockpit {
    type Event = Event;
    type Model = Model;
    type ViewModel = ViewModel;
    type Effect = Effect;

    fn update(&self, event: Event, model: &mut Model) -> Command<Effect, Event> {
        match event {
            Event::Data(data) => model.data = Some(data),
            Event::State(saved) => model.session.reseed(*saved),
            Event::Projects(projects) => model.session.set_projects(projects),
            Event::Refresh => {}
            Event::PrPollOn => model.session.pr_poll.turn_on(),
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

    /// The effects of one event, in words: `render` or `pr <directory>`.
    fn asked(app: &Cockpit, model: &mut Model, event: Event) -> Vec<String> {
        let mut cmd = app.update(event, model);
        cmd.effects()
            .map(|e| match e {
                Effect::Render(_) => "render".to_string(),
                Effect::PrPoll(r) => format!("pr {}", r.operation.directory),
                Effect::Cmux(_) | Effect::Persist(_) => "other".to_string(),
            })
            .collect()
    }

    fn frame(epoch: f64) -> Event {
        let data = serde_json::json!({ "epoch": epoch, "workspaces": [
            { "id": "a", "directory": "/a" }, { "id": "b", "directory": "/a" },
        ]});
        Event::Data(serde_json::from_value(data).unwrap())
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
    }
}
