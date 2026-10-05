//! A workspace's status (src/cockpit/status.ts): from its most active
//! agent, with idle nudges and "needs you" dismissals applied (needs.rs),
//! and what the card says about it. Colours are tokens (theme.rs).

use crate::activity::most_active;
use crate::data::{Agent, AgentStatus, Data, Workspace};
use crate::js::{non_empty, positive, truthy};
use crate::moves::{quiet_move, waiting_move};
use crate::needs::ask_reason;
use crate::persist::{SavedMove, is_move_description};
use crate::session::Session;
use crate::shells::live_shell_count;
use crate::text::{card_message, clip, one_line, readable};
use crate::theme::Token;
use crate::time::{age_since, finished_at};
use crate::ui::{PillColors, URGENCY_RANK, Urgency, count_tint};
use crate::words::{
    ASKING_WORD, NO_AGENT_WORD, WAITING_WORD, YOU_WORD, shell_text, status_word, with_age,
};

/// A workspace's status: its agent's, or none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    NeedsInput,
    Working,
    Idle,
    Ended,
    /// A status cmux sent that this port does not know, in cmux's word.
    Other(String),
    /// No agent.
    None,
}

impl Status {
    fn of(a: Option<&Agent>) -> Status {
        match a.and_then(|a| a.status.clone()) {
            Some(AgentStatus::NeedsInput) => Status::NeedsInput,
            Some(AgentStatus::Working) => Status::Working,
            Some(AgentStatus::Idle) => Status::Idle,
            Some(AgentStatus::Ended) => Status::Ended,
            Some(AgentStatus::Other(s)) => Status::Other(s),
            None => Status::None,
        }
    }

    /// The status as the TypeScript names it.
    pub fn as_str(&self) -> &str {
        match self {
            Status::NeedsInput => "needs_input",
            Status::Working => "working",
            Status::Idle => "idle",
            Status::Ended => "ended",
            Status::Other(s) => s,
            Status::None => "none",
        }
    }

    /// Idle or ended: the agent finished.
    fn finished(&self) -> bool {
        matches!(self, Status::Idle | Status::Ended)
    }
}

/// Which of the card's status looks applies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusKind {
    /// Finished and not yet looked at (issue #53).
    Ready,
    /// needs_input on a permission or a question (issue #81).
    Asking,
    /// Still working, but silent a while.
    Quiet,
    /// Idle on a background shell its own chat still runs.
    Waiting,
    /// The agent's own status, or none.
    Plain(Status),
}

/// How a status draws: its word, dot, halo, text colour and urgency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusStyle {
    pub label: &'static str,
    pub dot: Option<Token>,
    /// The soft halo round a live dot: working and needs only.
    pub halo: Token,
    pub text: Token,
    /// The ring round a hollow dot.
    pub ring: Option<Token>,
    /// What the style means for a header's count pill.
    pub urgency: Urgency,
}

/// The halo token for a status: working and needs only, else clear.
pub fn halo_color(status: &Status) -> Token {
    match status {
        Status::Working => Token::BlueHalo,
        Status::NeedsInput => Token::ClayHalo,
        _ => Token::Clear,
    }
}

fn plain_style(s: &Status) -> StatusStyle {
    let (dot, text, urgency) = match s {
        Status::Working => (Some(Token::Blue), Token::BlueText, Urgency::Working),
        Status::NeedsInput => (Some(Token::Clay), Token::ClayText, Urgency::Needs),
        Status::Idle => (None, Token::MetaText, Urgency::Quiet),
        Status::Ended => (Some(Token::Green), Token::GreenText, Urgency::Quiet),
        Status::Other(_) | Status::None => (None, Token::Faint, Urgency::Quiet),
    };
    let label = match s {
        Status::Working => status_word(&AgentStatus::Working),
        Status::NeedsInput => status_word(&AgentStatus::NeedsInput),
        Status::Idle => status_word(&AgentStatus::Idle),
        Status::Ended => status_word(&AgentStatus::Ended),
        Status::Other(_) | Status::None => None,
    };
    StatusStyle {
        label: label.unwrap_or(NO_AGENT_WORD),
        dot,
        halo: halo_color(s),
        text,
        ring: None,
        urgency,
    }
}

impl StatusKind {
    /// The look this kind draws with.
    pub fn style(&self) -> StatusStyle {
        match self {
            // The finished green and word: Ready adds no hue of its own.
            StatusKind::Ready => StatusStyle {
                halo: Token::Clear,
                ..plain_style(&Status::Ended)
            },
            StatusKind::Asking => StatusStyle {
                label: ASKING_WORD,
                dot: Some(Token::Amber),
                halo: Token::AmberHalo,
                text: Token::AmberText,
                ring: None,
                urgency: Urgency::Asking,
            },
            // Blue keeps its one meaning, so the dot goes hollow in blue.
            StatusKind::Quiet => StatusStyle {
                dot: None,
                halo: Token::Clear,
                ring: Some(Token::Blue),
                ..plain_style(&Status::Working)
            },
            StatusKind::Waiting => StatusStyle {
                label: WAITING_WORD,
                ..plain_style(&Status::Working)
            },
            StatusKind::Plain(s) => plain_style(s),
        }
    }
}

/// What a lane or project header shows beside its count.
#[derive(Debug, Clone, PartialEq)]
pub struct HeaderStatus<'w> {
    pub tint: PillColors,
    /// Whose dot shows while folded: none while open or all quiet.
    pub dot: Option<&'w Workspace>,
}

/// A PR as the card menu names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrRef<'a> {
    pub tag: &'a str,
    pub url: Option<&'a str>,
}

/// An outline: its colour and width in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Outline {
    pub color: Token,
    pub width: f64,
}

/// The widest an outline gets, which every ring that draws it holds steady.
pub const OUTLINE_MAX: f64 = 2.0;

/// About two lines of card text at the full card's width.
pub const DETAIL_MAX: usize = 140;

/// About one line of a compact card's text.
pub const LEFT_OFF_MAX: usize = 90;

/// About one line of a Needs you row's detail.
pub const NEEDS_DETAIL_MAX: usize = 80;

/// The outline of a card, row or needs-you row: ink at the widest on the
/// selected workspace, ink just under it while dragged, the row's own
/// resting edge at 1pt otherwise.
pub fn outline(selected: bool, dragged: bool, rest: Token) -> Outline {
    if dragged {
        return Outline {
            color: Token::Select,
            width: 1.5,
        };
    }
    if selected {
        Outline {
            color: Token::Select,
            width: OUTLINE_MAX,
        }
    } else {
        Outline {
            color: rest,
            width: 1.0,
        }
    }
}

/// The PR as text in a compact card's status line ("· #45 · 1 failing"), else "".
pub fn compact_pr_text(text: Option<&str>) -> String {
    non_empty(text).map_or_else(String::new, |t| format!("· {t}"))
}

/// The card menu's PR item; with no PR, or one with no link, it says so.
pub fn open_pr_label(pr: Option<PrRef<'_>>) -> String {
    match pr {
        None => "No PR to open".to_string(),
        Some(pr) if non_empty(pr.url).is_some() => format!("Open PR {}", pr.tag),
        Some(pr) => format!("PR {} has no link", pr.tag),
    }
}

/// The progress bar's fraction, held to 0 to 1; None when no value is sent.
pub fn progress_fraction(w: Option<&Workspace>) -> Option<f64> {
    let v = w?.progress.as_ref()?.value?;
    v.is_finite().then(|| v.clamp(0.0, 1.0))
}

/// The description as Jon wrote it: a move's description is never shown as plain words.
fn own_description(w: Option<&Workspace>) -> String {
    let d = w.and_then(|w| w.description.as_deref());
    if is_move_description(d) {
        String::new()
    } else {
        readable(d)
    }
}

/// When the status of `a`, the workspace's agent as shown, began.
fn since_from(a: Option<&Agent>, w: Option<&Workspace>) -> f64 {
    a.and_then(|a| truthy(a.since_epoch).or(truthy(a.last_activity_at)))
        .or(truthy(w.and_then(|w| w.latest_at)))
        .unwrap_or(0.0)
}

impl Session {
    /// The workspace's most active agent, as the sidebars show it.
    pub fn agent_of(&mut self, w: Option<&Workspace>) -> Option<Agent> {
        most_active(&self.agents_of(w)).cloned()
    }

    /// The workspace's status.
    pub fn status_of(&mut self, w: Option<&Workspace>) -> Status {
        Status::of(self.agent_of(w).as_ref())
    }

    /// When the current status began: agent start, else its activity, else the workspace's.
    pub fn since_of(&mut self, w: Option<&Workspace>) -> f64 {
        let a = self.agent_of(w);
        since_from(a.as_ref(), w)
    }

    /// The status and when it began, from one read of the agents, for a
    /// caller that needs both for every workspace each frame.
    pub fn status_and_since(&mut self, w: Option<&Workspace>) -> (Status, f64) {
        let a = self.agent_of(w);
        (Status::of(a.as_ref()), since_from(a.as_ref(), w))
    }

    /// How long the status has held, "12m".
    pub fn age_of(&mut self, data: &Data, w: Option<&Workspace>) -> String {
        let since = self.since_of(w);
        age_since(data, Some(since))
    }

    /// The agent whose finish a Ready card reports: of the agents that
    /// settled on idle or ended after working, the latest active.
    fn finished_agent(&mut self, w: &Workspace) -> Option<Agent> {
        let mut best: Option<Agent> = None;
        for a in self.agents_of(Some(w)) {
            let last = a.last_activity_at.unwrap_or(0.0);
            if !Status::of(Some(&a)).finished() || !positive(last) {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|b| last > b.last_activity_at.unwrap_or(0.0))
            {
                best = Some(a);
            }
        }
        best
    }

    /// The agent a Ready card reports, or None when the workspace is not
    /// Ready: finished while Jon was elsewhere, with output he has not
    /// read, not selected, never a real ask, and not a "Nothing for you"
    /// turn whose shell still runs.
    pub fn ready_agent(&mut self, data: &Data, w: Option<&Workspace>) -> Option<Agent> {
        let w = w?;
        if !positive(w.unread.unwrap_or(0.0))
            || self.is_selected(data, Some(w))
            || self.has_real_ask(Some(w))
        {
            return None;
        }
        if !self.status_of(Some(w)).finished() {
            return None;
        }
        let a = self.finished_agent(w)?;
        let waits_on_its_shell = quiet_move(&self.saved, &a, Some(w)).is_some()
            && live_shell_count(&self.saved, Some(w), Some(&a)) > 0;
        (!waits_on_its_shell).then_some(a)
    }

    /// Whether the workspace is Ready.
    pub fn is_ready(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        self.ready_agent(data, w).is_some()
    }

    /// Why the workspace's agent is asking ("allow git push?"), or None.
    pub fn ask_of(&mut self, w: Option<&Workspace>) -> Option<String> {
        let a = self.agent_of(w);
        ask_reason(&self.saved, a.as_ref(), w)
    }

    /// True when the agent is idle on a background shell its own chat still runs.
    pub fn is_waiting(&self, a: Option<&Agent>, w: Option<&Workspace>) -> bool {
        a.is_some_and(|a| a.status == Some(AgentStatus::Idle))
            && live_shell_count(&self.saved, w, a) > 0
    }

    /// Which status look the card takes.
    pub fn status_kind(&mut self, data: &Data, w: Option<&Workspace>) -> StatusKind {
        if self.is_ready(data, w) {
            return StatusKind::Ready;
        }
        let a = self.agent_of(w);
        if ask_reason(&self.saved, a.as_ref(), w).is_some() {
            return StatusKind::Asking;
        }
        if self.quiet_since(data, a.as_ref(), w) > 0.0 {
            return StatusKind::Quiet;
        }
        if self.is_waiting(a.as_ref(), w) {
            return StatusKind::Waiting;
        }
        StatusKind::Plain(Status::of(a.as_ref()))
    }

    /// How the card's status draws.
    pub fn status_info(&mut self, data: &Data, w: Option<&Workspace>) -> StatusStyle {
        self.status_kind(data, w).style()
    }

    /// A workspace's urgency: the one its card's status carries.
    pub fn urgency_of(&mut self, data: &Data, w: Option<&Workspace>) -> Urgency {
        self.status_info(data, w).urgency
    }

    /// The first of the workspaces at the highest urgency above quiet, or
    /// None when all are quiet: whose dot a folded header shows.
    pub fn most_urgent_of<'w>(
        &mut self,
        data: &Data,
        ws: &[&'w Workspace],
    ) -> Option<&'w Workspace> {
        let rank = |u: Urgency| {
            URGENCY_RANK
                .iter()
                .position(|x| *x == u)
                .unwrap_or(URGENCY_RANK.len())
        };
        let mut best = URGENCY_RANK.len() - 1;
        let mut lead = None;
        for w in ws {
            let r = rank(self.urgency_of(data, Some(w)));
            if r >= best {
                continue;
            }
            best = r;
            lead = Some(*w);
            if best == 0 {
                break;
            }
        }
        lead
    }

    /// The most urgent of the workspaces' urgencies; quiet with none.
    pub fn most_urgent(&mut self, data: &Data, ws: &[&Workspace]) -> Urgency {
        let lead = self.most_urgent_of(data, ws);
        self.urgency_of(data, lead)
    }

    /// A count pill's colours for the workspaces it counts.
    pub fn count_colors(&mut self, data: &Data, ws: &[&Workspace]) -> PillColors {
        count_tint(self.most_urgent(data, ws))
    }

    /// A header's pill tint and, folded, its lead's dot, from one walk over its cards.
    pub fn header_status<'w>(
        &mut self,
        data: &Data,
        ws: &[&'w Workspace],
        folded: bool,
    ) -> HeaderStatus<'w> {
        let lead = self.most_urgent_of(data, ws);
        HeaderStatus {
            tint: count_tint(self.urgency_of(data, lead)),
            dot: if folded { lead } else { None },
        }
    }

    /// The "Your move" line the chat ended its turn on, while that turn still waits on Jon.
    pub fn move_of(&mut self, w: Option<&Workspace>) -> Option<SavedMove> {
        let a = self.agent_of(w);
        let asking = ask_reason(&self.saved, a.as_ref(), w).is_some();
        waiting_move(&self.saved, a.as_ref(), w, asking)
    }

    /// A Needs you row's second line: why the agent asks, else what it
    /// wants, else its latest message.
    pub fn needs_detail(&mut self, w: Option<&Workspace>) -> String {
        if let Some(ask) = self.ask_of(w) {
            return ask;
        }
        let wanted = clip(
            &self.move_of(w).map(|m| m.text).unwrap_or_default(),
            NEEDS_DETAIL_MAX,
        );
        if !wanted.is_empty() {
            return wanted;
        }
        let message = one_line(Some(&card_message(w)), NEEDS_DETAIL_MAX);
        if !message.is_empty() {
            return message;
        }
        "Waiting for your reply".to_string()
    }

    /// A Needs you row's detail with its status in front: "Asking: allow git push?".
    pub fn needs_line(&mut self, data: &Data, w: Option<&Workspace>) -> String {
        let label = self.status_info(data, w).label;
        format!("{label}: {}", self.needs_detail(w))
    }

    /// The ink of a Needs you row's detail: amber while asking, else clay.
    pub fn needs_ink(&mut self, w: Option<&Workspace>) -> Token {
        if self.ask_of(w).is_some() {
            Token::AmberText
        } else {
            Token::ClayText
        }
    }

    /// A placeholder's words after the title: why its card went.
    pub fn placeholder_text(&mut self, w: Option<&Workspace>) -> String {
        if self.ask_of(w).is_some() {
            format!("is {}", ASKING_WORD.to_lowercase())
        } else {
            status_word(&AgentStatus::NeedsInput)
                .unwrap_or_default()
                .to_lowercase()
        }
    }

    /// A Needs you row's edge: amber while its agent asks, else clay.
    pub fn needs_row_edge(&mut self, w: Option<&Workspace>) -> Token {
        if self.ask_of(w).is_some() {
            Token::AmberRowEdge
        } else {
            Token::NeedsRowEdge
        }
    }

    /// The unread count a card's badge shows: none while the Ready pill stands in for it.
    pub fn badge_count(&mut self, data: &Data, w: Option<&Workspace>) -> f64 {
        if self.is_ready(data, w) {
            0.0
        } else {
            w.and_then(|w| w.unread).unwrap_or(0.0)
        }
    }

    /// The status and how long it has held ("Working 14m", "Finished 6m"),
    /// with the shell count while Waiting and the quiet time while Quiet.
    pub fn status_line(&mut self, data: &Data, w: Option<&Workspace>) -> String {
        let kind = self.status_kind(data, w);
        let age = self.card_age(data, w);
        let line = with_age(kind.style().label, &age);
        match kind {
            StatusKind::Waiting => {
                let a = self.agent_of(w);
                let n = live_shell_count(&self.saved, w, a.as_ref());
                format!("{line} {}", shell_text(n))
            }
            StatusKind::Quiet => {
                let a = self.agent_of(w);
                let suffix = self.quiet_suffix(data, a.as_ref(), w);
                format!("{line}{suffix}")
            }
            _ => line,
        }
    }

    /// True when the status line carries a time, so a card leaves its top-right one off.
    pub fn status_has_age(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        !self.card_age(data, w).is_empty()
    }

    /// A Ready card counts from when its finished agent finished, an idle
    /// or ended one from when its agent finished; otherwise only the
    /// agent's sinceEpoch says when the status began.
    fn card_age(&mut self, data: &Data, w: Option<&Workspace>) -> String {
        if let Some(ready) = self.ready_agent(data, w) {
            return age_since(data, Some(finished_at(&ready)));
        }
        let Some(a) = self.agent_of(w) else {
            return String::new();
        };
        if Status::of(Some(&a)).finished() {
            age_since(data, Some(finished_at(&a)))
        } else {
            age_since(data, a.since_epoch)
        }
    }

    /// "· 3 helpers" while subagent runs are live, else "".
    pub fn helper_text(&mut self, w: Option<&Workspace>) -> String {
        match self.live_run_count(w) {
            0 => String::new(),
            1 => "· 1 helper".to_string(),
            n => format!("· {n} helpers"),
        }
    }

    /// "You: " and your last prompt, for a card that shows where you left off; "" with none.
    pub fn left_off_text(&mut self, w: Option<&Workspace>) -> String {
        let t = self.prompts.prompt_text(w);
        if t.is_empty() {
            String::new()
        } else {
            format!("{YOU_WORD}: {}", clip(&t, LEFT_OFF_MAX))
        }
    }

    /// What the waiting chat wants, else the agent's latest message (never
    /// a prompt echo), else the description.
    pub fn card_detail(&mut self, w: Option<&Workspace>) -> String {
        let wanted = self.move_of(w).map(|m| m.text).unwrap_or_default();
        let text = if !wanted.is_empty() {
            wanted
        } else {
            let message = card_message(w);
            if message.is_empty() {
                own_description(w)
            } else {
                message
            }
        };
        clip(&text, DETAIL_MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_cmuxs_word_for_a_status_it_does_not_know_and_draws_it_as_no_agent() {
        let a = Agent {
            id: "a".into(),
            status: Some(AgentStatus::Other("thinking".into())),
            ..Agent::default()
        };
        let s = Status::of(Some(&a));
        assert_eq!(s.as_str(), "thinking");
        assert_eq!(halo_color(&s), Token::Clear);
        assert_eq!(StatusKind::Plain(s).style().label, NO_AGENT_WORD);
    }
}
