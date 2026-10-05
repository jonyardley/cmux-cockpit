//! What the pane draws, worked out once per frame from the core: every
//! word and colour token the views need, so the views only lay them out.
//!
//! The core's view model names workspaces by id; a card's title, status
//! and detail come from the core's session reads, which take the frame's
//! data and tidy the session as they go. So the pane builds its model from
//! the core's whole `Model`, not the view model alone.

use cockpit_core::Model;
use cockpit_core::app::{LaneHeaderView, ViewModel};
use cockpit_core::data::{Data, Workspace};
use cockpit_core::lane_entries::{LaneEntry, shows_left_off};
use cockpit_core::lanes::{Density, LANES, LaneKey};
use cockpit_core::model::card_density;
use cockpit_core::session::Session;
use cockpit_core::status::StatusStyle;
use cockpit_core::theme::Token;
use cockpit_core::ui::PillColors;

use cockpit_core::status::DETAIL_MAX;

use crate::text::whole_words;

/// The core's caps on a Needs you row's detail and the left-off prompt
/// (status.rs `needs_detail` and `LEFT_OFF_MAX`, private there), so a cut
/// at the cap can be taken back to a whole word.
const NEEDS_DETAIL_MAX: usize = 80;
const LEFT_OFF_MAX: usize = 90;
/// Before the left-off prompt (words.rs `YOU_WORD` and its colon).
const LEFT_OFF_LEAD: &str = "You: ";

/// The view switch's one live view for now.
pub const ALL_LABEL: &str = "All";
/// Shown faint until the Projects view is drawn.
pub const PROJECTS_LABEL: &str = "Projects";
/// The hint at the top right.
pub const KEYS_HINT: &str = "? keys";
/// Before Next's target.
pub const NEXT_LABEL: &str = "Next";
/// Next with nowhere to go.
pub const NEXT_NOTHING: &str = "nothing waiting";
/// The Needs you strip's heading.
pub const NEEDS_LABEL: &str = "Needs you";
/// Before the oldest ask's wait.
pub const OLDEST_WORD: &str = "oldest";
/// Between a placeholder's title and why its card went.
pub const GHOST_GAP: &str = "·";
/// A folded lane's chevron, and an open one's.
pub const FOLDED_MARK: &str = "▸";
pub const OPEN_MARK: &str = "▾";
/// A lane's square marker in its colour.
pub const LANE_MARK: &str = "■";
/// A status dot, a hollow one, and a placeholder's.
pub const DOT: &str = "●";
pub const HOLLOW: &str = "○";
pub const GHOST: &str = "◌";

/// The keys the `?` overlay lists: the key, then what it does.
pub const KEYS: [(&str, &str); 10] = [
    ("↑ ↓", "move between cards"),
    ("shift ↑ ↓", "reorder in its lane"),
    ("m 1-5", "move to a lane"),
    ("drag", "move to a lane or spot"),
    ("Enter", "switch to it"),
    ("d", "dismiss from Needs you"),
    ("Tab", "All or Projects"),
    ("?", "show or hide the keys"),
    ("q", "quit"),
    ("Esc", "close this"),
];
/// The overlay's title.
pub const KEYS_TITLE: &str = "Keys";
/// The lane picker's title, after `m`.
pub const PICK_TITLE: &str = "Move to lane";
/// The lane picker's last line: how to leave it.
pub const PICK_CANCEL: (&str, &str) = ("Esc", "cancel");
/// Where the Projects view will be, until it is drawn.
pub const PROJECTS_SOON: &str = "Projects arrives in R1.4. Tab goes back to All.";
/// On the header of the lane a drag would drop into: above a card in it,
/// or at its end.
pub const DROP_HERE: &str = "drop here";
pub const DROP_AT_END: &str = "drop at the end";
/// In the margin of the card a drag would land above.
pub const DROP_MARK: &str = "▔";

/// Which view the pane draws; Tab flips between them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PaneView {
    #[default]
    All,
    Projects,
}

impl PaneView {
    /// The other view.
    pub fn flipped(self) -> PaneView {
        match self {
            PaneView::All => PaneView::Projects,
            PaneView::Projects => PaneView::All,
        }
    }
}

/// The lane a digit picks after `m`: 1 is the first lane, in display order.
pub fn lane_for_digit(c: char) -> Option<LaneKey> {
    let n = c.to_digit(10)?;
    let i = usize::try_from(n).ok()?.checked_sub(1)?;
    LANES.get(i).map(|l| l.key)
}

/// The lane picker's rows: each digit and the lane it picks, then Esc.
pub fn pick_rows() -> Vec<(String, &'static str)> {
    let mut rows: Vec<(String, &'static str)> = LANES
        .iter()
        .enumerate()
        .map(|(i, l)| ((i + 1).to_string(), l.name))
        .collect();
    rows.push((PICK_CANCEL.0.to_string(), PICK_CANCEL.1));
    rows
}

/// The glyph before a title and its colour; None is the grey outline the
/// sidebar draws round a dot with no colour of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Icon {
    pub glyph: &'static str,
    pub ink: Option<Token>,
}

/// Next: where the next press goes, "1 of 5", or nowhere.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum NextLine {
    #[default]
    Nothing,
    Step {
        title: String,
        place: String,
    },
}

/// One session in the Needs you strip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsRow {
    pub ws_id: String,
    pub icon: Icon,
    pub title: String,
    /// "Asking: allow git push?"
    pub line: String,
    pub ink: Token,
}

/// The Needs you strip; empty when nothing waits.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Needs {
    pub count: usize,
    /// "oldest 12m", or "" with nothing timed.
    pub wait: String,
    pub late: bool,
    pub rows: Vec<NeedsRow>,
    /// "+2 more", or "".
    pub more: String,
}

/// A workspace's card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub ws_id: String,
    pub icon: Icon,
    pub title: String,
    /// The status and its age, "Working 14m"; a row's age alone.
    pub status: String,
    pub status_ink: Token,
    /// "You: " and the last prompt, in lanes you come back to; else "".
    pub left_off: String,
    /// The latest message, or what the waiting chat wants.
    pub detail: String,
    /// How many detail lines it draws: two on a full card, else one.
    pub detail_lines: usize,
    /// Its session waits in Needs you, past the strip's cap.
    pub waiting: bool,
}

/// A row under a lane header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Card(Card),
    /// A card whose session sits in Needs you: its title and why.
    Ghost {
        ws_id: String,
        title: String,
        text: String,
    },
}

impl Row {
    /// The workspace the row stands for.
    pub fn ws_id(&self) -> &str {
        match self {
            Row::Card(c) => &c.ws_id,
            Row::Ghost { ws_id, .. } => ws_id,
        }
    }
}

/// A lane's generated anchor on its header: its dot and unread count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub icon: Icon,
    /// "3", or "" with nothing unread.
    pub unread: String,
}

/// A lane: its header, then its rows (none while folded). An empty lane
/// draws as its header alone, faint and with nothing to fold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    pub key: LaneKey,
    pub empty: bool,
    /// Upper case, as the sidebar's heading.
    pub name: String,
    /// Parked's name and an empty lane's are faint.
    pub faint: bool,
    pub marker: Token,
    pub anchor: Option<Anchor>,
    pub count: usize,
    pub pill: PillColors,
    /// While folded: the dot of its most urgent session.
    pub dot: Option<Icon>,
    pub collapsed: bool,
    /// "2 ready to merge", or "".
    pub merge_ready: String,
    pub rows: Vec<Row>,
}

/// Everything the pane draws.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneModel {
    pub next: NextLine,
    pub needs: Needs,
    pub lanes: Vec<Lane>,
}

impl PaneModel {
    /// The pane's model for the core's current frame. With no frame yet,
    /// only the lanes' frame of headers is unknown, so the pane is empty.
    pub fn from_core(core: &mut Model) -> PaneModel {
        let Model {
            session,
            data,
            view,
        } = core;
        match data {
            Some(data) => build(session, data, view),
            None => PaneModel::default(),
        }
    }

    /// The cards the cursor moves between, top to bottom, by workspace id:
    /// the Needs you rows, then the lanes' cards.
    pub fn card_ids(&self) -> Vec<&str> {
        let needs = self.needs.rows.iter().map(|r| r.ws_id.as_str());
        let cards = self
            .lanes
            .iter()
            .flat_map(|l| &l.rows)
            .filter_map(|r| match r {
                Row::Card(c) => Some(c.ws_id.as_str()),
                Row::Ghost { .. } => None,
            });
        needs.chain(cards).collect()
    }

    /// Whether `id` is a row in the Needs you strip.
    pub fn in_strip(&self, id: &str) -> bool {
        self.needs.rows.iter().any(|r| r.ws_id == id)
    }

    /// Whether `id`'s session waits in Needs you: a row in the strip, or a
    /// card past its cap.
    pub fn is_waiting(&self, id: &str) -> bool {
        self.in_strip(id)
            || self
                .lanes
                .iter()
                .flat_map(|l| &l.rows)
                .any(|r| matches!(r, Row::Card(c) if c.ws_id == id && c.waiting))
    }

    /// The lane `id`'s card or placeholder sits in.
    pub fn lane_of(&self, id: &str) -> Option<LaneKey> {
        self.lanes
            .iter()
            .find(|l| l.rows.iter().any(|r| r.ws_id() == id))
            .map(|l| l.key)
    }

    /// A lane's rows top to bottom, cards and placeholders, by workspace
    /// id. A placeholder stands for a real tab in its lane (drop.ts), so a
    /// card can land above one.
    pub fn lane_rows(&self, key: LaneKey) -> Vec<&str> {
        self.lanes
            .iter()
            .filter(|l| l.key == key)
            .flat_map(|l| &l.rows)
            .map(Row::ws_id)
            .collect()
    }

    /// Every piece of text the pane can draw, for the test that checks no
    /// word is cut.
    pub fn words(&self) -> Vec<String> {
        let mut out: Vec<String> = [
            ALL_LABEL,
            PROJECTS_LABEL,
            KEYS_HINT,
            NEXT_LABEL,
            NEXT_NOTHING,
            NEEDS_LABEL,
            OLDEST_WORD,
            GHOST_GAP,
            KEYS_TITLE,
            PICK_TITLE,
            PICK_CANCEL.0,
            PICK_CANCEL.1,
            PROJECTS_SOON,
            DROP_HERE,
            DROP_AT_END,
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
        for (key, what) in KEYS {
            out.push(key.to_string());
            out.push(what.to_string());
        }
        for (key, what) in pick_rows() {
            out.push(key);
            out.push(what.to_string());
        }
        if let NextLine::Step { title, place } = &self.next {
            out.push(title.clone());
            out.push(place.clone());
        }
        out.push(self.needs.count.to_string());
        out.push(self.needs.wait.clone());
        out.push(self.needs.more.clone());
        for r in &self.needs.rows {
            out.push(r.title.clone());
            out.push(r.line.clone());
        }
        for lane in &self.lanes {
            out.push(lane.name.clone());
            out.push(lane.count.to_string());
            if let Some(a) = &lane.anchor {
                out.push(a.unread.clone());
            }
            out.push(lane.merge_ready.clone());
            for row in &lane.rows {
                match row {
                    Row::Card(c) => {
                        out.push(c.title.clone());
                        out.push(c.status.clone());
                        out.push(c.left_off.clone());
                        out.push(c.detail.clone());
                    }
                    Row::Ghost { title, text, .. } => {
                        out.push(title.clone());
                        out.push(text.clone());
                    }
                }
            }
        }
        out
    }
}

/// A workspace's title as the pane shows it: its own, else its id.
fn title_of(w: Option<&Workspace>, id: &str) -> String {
    let title = w.and_then(|w| w.title.as_deref()).unwrap_or_default();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        id.to_string()
    } else {
        title
    }
}

/// A status's dot: filled, hollow in its ring's colour, or a grey outline.
pub fn icon_of(style: &StatusStyle) -> Icon {
    match (style.dot, style.ring) {
        (Some(ink), _) => Icon {
            glyph: DOT,
            ink: Some(ink),
        },
        (None, ring) => Icon {
            glyph: HOLLOW,
            ink: ring,
        },
    }
}

/// How many detail lines a card of this density draws: two on a full
/// card, one on a compact card or a row (cards.ts detailLine).
pub fn detail_lines(d: Density) -> usize {
    match d {
        Density::Full => 2,
        Density::Compact | Density::Row => 1,
    }
}

/// A lane's heading words: its name in upper case.
pub fn lane_name(name: &str) -> String {
    name.to_uppercase()
}

/// Parked's heading is faint, as is every empty lane's (headers.ts).
pub fn faint_heading(key: LaneKey, empty: bool) -> bool {
    empty || key == LaneKey::Parked
}

/// An unread count as words: "" with none.
pub fn unread_text(n: Option<f64>) -> String {
    match n {
        Some(n) if n.is_finite() && n >= 1.0 => format!("{}", n.trunc()),
        _ => String::new(),
    }
}

fn build(session: &mut Session, data: &Data, view: &ViewModel) -> PaneModel {
    PaneModel {
        next: next_line(data, view),
        needs: needs(session, data, view),
        lanes: lanes(session, data, view),
    }
}

fn next_line(data: &Data, view: &ViewModel) -> NextLine {
    match &view.next.step {
        Some(step) => NextLine::Step {
            title: title_of(data.ws_by_id(&step.target), &step.target),
            place: format!("{} of {}", step.position, step.total),
        },
        None => NextLine::Nothing,
    }
}

fn needs(session: &mut Session, data: &Data, view: &ViewModel) -> Needs {
    let n = &view.needs;
    let rows = n
        .shown
        .iter()
        .map(|id| {
            let w = data.ws_by_id(id);
            let style = session.status_info(data, w);
            NeedsRow {
                ws_id: id.clone(),
                icon: icon_of(&style),
                title: title_of(w, id),
                line: needs_line(session, data, w),
                ink: session.needs_ink(w),
            }
        })
        .collect();
    Needs {
        count: n.list.len(),
        wait: if n.wait_text.is_empty() {
            String::new()
        } else {
            format!("{OLDEST_WORD} {}", n.wait_text)
        },
        late: n.late,
        rows,
        more: if n.more > 0 {
            format!("+{} more", n.more)
        } else {
            String::new()
        },
    }
}

/// A Needs you row's line, "Asking: allow git push?", with a detail the
/// core cut taken back to a whole word.
fn needs_line(session: &mut Session, data: &Data, w: Option<&Workspace>) -> String {
    let label = session.status_info(data, w).label;
    let detail = whole_words(&session.needs_detail(w), NEEDS_DETAIL_MAX);
    format!("{label}: {detail}")
}

/// "You: " and the last prompt, with a prompt the core cut taken back to
/// a whole word.
fn left_off(text: &str) -> String {
    match text.strip_prefix(LEFT_OFF_LEAD) {
        Some(prompt) => format!("{LEFT_OFF_LEAD}{}", whole_words(prompt, LEFT_OFF_MAX)),
        None => whole_words(text, 0),
    }
}

fn card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let style = session.status_info(data, w);
    let density = card_density(data, w);
    // A row carries its age alone, as the sidebar's row does; a card says
    // its status with the age.
    let (status, status_ink) = if density == Density::Row {
        (session.age_of(data, w), Token::MetaText)
    } else {
        (session.status_line(data, w), style.text)
    };
    let left_off = if shows_left_off(data, w) {
        left_off(&session.left_off_text(w))
    } else {
        String::new()
    };
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status,
        status_ink,
        left_off,
        detail: whole_words(&session.card_detail(w), DETAIL_MAX),
        detail_lines: detail_lines(density),
        waiting: view.needs.list.iter().any(|w| w == id),
    }
}

fn lanes(session: &mut Session, data: &Data, view: &ViewModel) -> Vec<Lane> {
    let mut out: Vec<Lane> = Vec::new();
    for entry in &view.lane_entries {
        match entry {
            LaneEntry::Header {
                lane, anchor_id, ..
            } => {
                let header = view.lane_headers.get(lane);
                let mut head = lane_head(session, data, *lane, header, false);
                head.anchor = anchor_id.as_deref().map(|id| anchor(session, data, id));
                out.push(head);
            }
            LaneEntry::Zone { lane, .. } => {
                let header = view.lane_headers.get(lane);
                out.push(lane_head(session, data, *lane, header, true));
            }
            LaneEntry::Ws { ws_id, .. } => {
                let c = card(session, data, view, ws_id);
                push_row(&mut out, Row::Card(c));
            }
            LaneEntry::Ghost { ws_id, .. } => {
                let w = data.ws_by_id(ws_id);
                let row = Row::Ghost {
                    ws_id: ws_id.clone(),
                    title: title_of(w, ws_id),
                    text: session.placeholder_text(w),
                };
                push_row(&mut out, row);
            }
        }
    }
    out
}

/// Adds a row to the lane last headed; the core always heads a lane first.
fn push_row(lanes: &mut [Lane], row: Row) {
    if let Some(lane) = lanes.last_mut() {
        lane.rows.push(row);
    }
}

/// A generated anchor's dot and unread count, for its lane's header.
fn anchor(session: &mut Session, data: &Data, id: &str) -> Anchor {
    let w = data.ws_by_id(id);
    Anchor {
        icon: icon_of(&session.status_info(data, w)),
        unread: unread_text(w.and_then(|w| w.unread)),
    }
}

fn lane_head(
    session: &mut Session,
    data: &Data,
    key: LaneKey,
    header: Option<&LaneHeaderView>,
    empty: bool,
) -> Lane {
    let lane = LANES.iter().find(|l| l.key == key);
    let ids: &[String] = header.map_or(&[], |h| h.workspaces.as_slice());
    let collapsed = header.is_some_and(|h| h.collapsed);
    let ws: Vec<&Workspace> = ids.iter().filter_map(|id| data.ws_by_id(id)).collect();
    let status = session.header_status(data, &ws, collapsed);
    let dot = status
        .dot
        .map(|w| icon_of(&session.status_info(data, Some(w))));
    Lane {
        key,
        empty,
        name: lane_name(lane.map_or("", |l| l.name)),
        faint: faint_heading(key, empty),
        marker: lane.map_or(Token::LaneUnsorted, |l| l.color),
        anchor: None,
        count: ids.len(),
        pill: status.tint,
        dot,
        collapsed,
        merge_ready: header.map(|h| h.merge_ready.clone()).unwrap_or_default(),
        rows: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::ui::Urgency;

    fn style(dot: Option<Token>, ring: Option<Token>) -> StatusStyle {
        StatusStyle {
            label: "Working",
            dot,
            halo: Token::Clear,
            text: Token::MetaText,
            ring,
            urgency: Urgency::Quiet,
        }
    }

    #[test]
    fn draws_a_filled_dot_a_ring_or_a_grey_outline() {
        assert_eq!(
            icon_of(&style(Some(Token::Blue), None)),
            Icon {
                glyph: DOT,
                ink: Some(Token::Blue)
            }
        );
        assert_eq!(
            icon_of(&style(None, Some(Token::Blue))),
            Icon {
                glyph: HOLLOW,
                ink: Some(Token::Blue)
            }
        );
        assert_eq!(
            icon_of(&style(None, None)),
            Icon {
                glyph: HOLLOW,
                ink: None
            }
        );
    }

    #[test]
    fn gives_full_cards_two_detail_lines_and_the_rest_one() {
        assert_eq!(detail_lines(Density::Full), 2);
        assert_eq!(detail_lines(Density::Compact), 1);
        assert_eq!(detail_lines(Density::Row), 1);
    }

    #[test]
    fn heads_a_lane_in_upper_case_and_fades_parked_and_empty_lanes() {
        assert_eq!(lane_name("Main activity"), "MAIN ACTIVITY");
        assert!(faint_heading(LaneKey::Parked, false));
        assert!(faint_heading(LaneKey::Main, true));
        assert!(!faint_heading(LaneKey::Main, false));
    }

    #[test]
    fn takes_a_cut_prompt_back_to_a_whole_word() {
        let prompt = format!("{} tail", "word ".repeat(17));
        let cut = format!("{LEFT_OFF_LEAD}{}…", &prompt[..LEFT_OFF_MAX - 1]);
        let got = left_off(&cut);
        assert!(got.ends_with("word…"), "{got}");
        assert_eq!(left_off("You: fix it…"), "You: fix it…");
    }

    #[test]
    fn says_an_unread_count_only_when_there_is_one() {
        assert_eq!(unread_text(None), "");
        assert_eq!(unread_text(Some(0.0)), "");
        assert_eq!(unread_text(Some(f64::NAN)), "");
        assert_eq!(unread_text(Some(3.0)), "3");
    }

    #[test]
    fn titles_a_workspace_by_its_id_when_it_has_no_title() {
        assert_eq!(title_of(None, "ws-1"), "ws-1");
        let w = Workspace {
            title: Some("  fix   login ".into()),
            ..Workspace::default()
        };
        assert_eq!(title_of(Some(&w), "ws-1"), "fix login");
    }

    #[test]
    fn is_empty_before_the_first_frame() {
        let mut core = Model::default();
        assert_eq!(PaneModel::from_core(&mut core), PaneModel::default());
    }

    #[test]
    fn picks_lanes_by_digit_in_display_order() {
        assert_eq!(lane_for_digit('1'), Some(LaneKey::Main));
        assert_eq!(lane_for_digit('4'), Some(LaneKey::Parked));
        assert_eq!(lane_for_digit('5'), Some(LaneKey::Unsorted));
        assert_eq!(lane_for_digit('0'), None);
        assert_eq!(lane_for_digit('6'), None);
        assert_eq!(lane_for_digit('m'), None);
        let rows = pick_rows();
        assert_eq!(rows.first(), Some(&("1".to_string(), "Main activity")));
        assert_eq!(rows.last(), Some(&("Esc".to_string(), "cancel")));
    }

    #[test]
    fn flips_between_all_and_projects() {
        assert_eq!(PaneView::All.flipped(), PaneView::Projects);
        assert_eq!(PaneView::Projects.flipped(), PaneView::All);
    }

    fn card_row(id: &str, waiting: bool) -> Row {
        Row::Card(Card {
            ws_id: id.into(),
            icon: Icon {
                glyph: DOT,
                ink: None,
            },
            title: id.into(),
            status: String::new(),
            status_ink: Token::MetaText,
            left_off: String::new(),
            detail: String::new(),
            detail_lines: 1,
            waiting,
        })
    }

    /// A strip row "n" whose placeholder sits in Main beside card "a", and
    /// card "w" past the strip's cap in Parked.
    fn walked() -> PaneModel {
        let lane = |key, rows: Vec<Row>| Lane {
            key,
            empty: rows.is_empty(),
            name: String::new(),
            faint: false,
            marker: Token::LaneMain,
            anchor: None,
            count: rows.len(),
            pill: PillColors {
                bg: Token::CountBg,
                fg: Token::MetaText,
            },
            dot: None,
            collapsed: false,
            merge_ready: String::new(),
            rows,
        };
        let ghost = Row::Ghost {
            ws_id: "n".into(),
            title: "n".into(),
            text: "your turn".into(),
        };
        PaneModel {
            needs: Needs {
                count: 2,
                rows: vec![NeedsRow {
                    ws_id: "n".into(),
                    icon: Icon {
                        glyph: DOT,
                        ink: None,
                    },
                    title: "n".into(),
                    line: String::new(),
                    ink: Token::ClayText,
                }],
                ..Needs::default()
            },
            lanes: vec![
                lane(LaneKey::Main, vec![ghost, card_row("a", false)]),
                lane(LaneKey::Parked, vec![card_row("w", true)]),
            ],
            ..PaneModel::default()
        }
    }

    #[test]
    fn walks_the_strip_then_the_lanes_cards() {
        assert_eq!(walked().card_ids(), ["n", "a", "w"]);
    }

    #[test]
    fn knows_who_waits_and_which_lane_holds_each_card() {
        let m = walked();
        assert!(m.in_strip("n"));
        assert!(!m.in_strip("w"));
        assert!(m.is_waiting("n"));
        assert!(m.is_waiting("w"), "past the cap");
        assert!(!m.is_waiting("a"));
        assert_eq!(m.lane_of("n"), Some(LaneKey::Main), "by its placeholder");
        assert_eq!(m.lane_of("w"), Some(LaneKey::Parked));
        assert_eq!(m.lane_of("z"), None);
        assert_eq!(m.lane_rows(LaneKey::Main), ["n", "a"]);
        assert!(m.lane_rows(LaneKey::Review).is_empty());
    }

    #[test]
    fn files_rows_under_the_lane_headed_last() {
        let mut lanes = Vec::new();
        let row = Row::Ghost {
            ws_id: "a".into(),
            title: "a".into(),
            text: "your turn".into(),
        };
        push_row(&mut lanes, row);
        assert!(lanes.is_empty(), "a row before any header is dropped");
    }
}
