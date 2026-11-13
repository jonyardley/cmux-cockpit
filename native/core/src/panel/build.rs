//! Builds the panel model from the core's session and the frame's data.

use crate::app::{LaneHeaderView, ViewModel};
use crate::by_project::ProjectEntry;
use crate::card_chips::Chip as CoreChip;
use crate::data::{Data, Workspace};
use crate::filter::NO_PROJECT;
use crate::lane_entries::{LaneEntry, drop_hint, merge_ink, shows_left_off};
use crate::lanes::{self, Density, LaneKey};
use crate::model::card_density;
use crate::persist::ViewMode;
use crate::placement::is_foreign_anchor;
use crate::pr_colors::{draft_of, pr_ink, pr_text_color};
use crate::projects::Project;
use crate::prs::pr_summary;
use crate::session::Session;
use crate::status::{
    DETAIL_MAX, LEFT_OFF_MAX, NEEDS_DETAIL_MAX, StatusKind, StatusStyle, progress_fraction,
    waiting_halo, waiting_tokens,
};
use crate::strip::{is_late, wait_secs};
use crate::text::whole_words;
use crate::theme::{Token, parse_hex};
use crate::ui::QUIET_PILL;
use crate::words::{RUNNING_WORD, WAITING_WORD, with_detail};

use super::{
    AddMenu, AddProject, Anchor, Badge, Card, Chip, ChipKind, ChipsFor, DIRTY_MARK, DOT,
    EditorView, FilterMenu, FilterProject, HOLLOW, Icon, Lane, LateWait, Needs, NeedsTarget,
    NextLine, PROJECT_ROW, Panel, PanelView, ProjectHead, ProjectRow, QUIET_ROW, Row, RowPr,
    Waiting, WaitingTab, piece,
};

/// Before the left-off prompt (words.rs `YOU_WORD` and its colon).
const LEFT_OFF_LEAD: &str = "You: ";

/// A core chip as the panel draws it, on a card that waits on Jon when
/// `waiting` says how. The size takes the wait's colour, face, edge and
/// words, so a waiting card says
/// what answering takes in the colour that says it waits (D10 reversed,
/// 13 November 2026); on a card waiting on nobody it is dropped, never
/// drawn quiet (the core gives none there either, `chips_for`). The
/// PR's number in the quiet chip's ink and its state in its tone's, then
/// its diff size as a chip of its own, faint, as the sidebar sets it
/// beside the PR; the branch with its dirty dot, and the ports, in the
/// quiet chip's ink. The PR and the port carry where a tap opens.
pub fn chip_views(c: &CoreChip, waiting: Option<Waiting>) -> Vec<Chip> {
    let quiet = Token::Secondary;
    match c {
        CoreChip::Size { text, .. } => waiting.map(|wt| size_chip(text, wt)).into_iter().collect(),
        CoreChip::Pr {
            tag,
            state,
            tone,
            diff,
            url,
        } => {
            let mut pieces = vec![piece(tag, quiet)];
            if !state.is_empty() {
                pieces.push(piece(state, pr_ink(*tone)));
            }
            let pr = Chip {
                url: url.clone(),
                ..Chip::new(ChipKind::Pr, pieces)
            };
            let mut out = vec![pr];
            out.extend(diff_chip(diff));
            out
        }
        CoreChip::Branch { text, dirty } => {
            let mut pieces = vec![piece(text, quiet)];
            if *dirty {
                pieces.push(piece(DIRTY_MARK, quiet));
            }
            vec![Chip {
                gives_way: true,
                ..Chip::new(ChipKind::Branch, pieces)
            }]
        }
        CoreChip::Port { text, url } => vec![Chip {
            url: Some(url.clone()),
            ..Chip::new(ChipKind::Port, vec![piece(text, quiet)])
        }],
    }
}

/// The move size chip, in the wait's colour, clay for Your turn and
/// amber for Asking (`Waiting::chip`), its words in the wait's ink. Only a
/// card that waits on Jon draws one (`Session::waits_on_you`), so a size
/// chip is never quiet: `chip_views` drops one with no wait.
fn size_chip(text: &str, wt: Waiting) -> Chip {
    let (face, edge) = wt.chip();
    let ink = wt.ink;
    Chip {
        face,
        edge,
        ..Chip::new(ChipKind::Size, vec![piece(text, ink)])
    }
}

/// A PR's diff size as its own chip, faint; None when it has none.
fn diff_chip(diff: &str) -> Option<Chip> {
    (!diff.is_empty()).then(|| Chip::new(ChipKind::Diff, vec![piece(diff, Token::Faint)]))
}

/// Whether a card sits dimmed: merged, not cmux's selected workspace, and
/// nothing in it wants Jon (merged.rs card_opacity).
fn is_dimmed(session: &mut Session, data: &Data, w: Option<&Workspace>) -> bool {
    let lit = session.is_selected(data, w);
    session.card_opacity(w, lit) < 1.0
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

/// A status's dot: filled with its halo, or hollow in its ring's colour
/// or a grey outline, which have none.
pub fn icon_of(style: &StatusStyle) -> Icon {
    match (style.dot, style.ring) {
        (Some(ink), _) => Icon {
            glyph: DOT,
            ink: Some(ink),
            halo: style.halo,
        },
        (None, ring) => Icon {
            glyph: HOLLOW,
            ink: ring,
            halo: Token::Clear,
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

/// A faint lane's heading is faint (Parked's by default), as is every
/// empty lane's (headers.ts).
pub fn faint_heading(lane: &lanes::Lane, empty: bool) -> bool {
    empty || lane.faint
}

/// An unread count as words: "" with none.
pub fn unread_text(n: Option<f64>) -> String {
    match n {
        Some(n) if n.is_finite() && n >= 1.0 => format!("{}", n.trunc()),
        _ => String::new(),
    }
}

/// A project's badge: its symbol and its colour.
pub fn badge_of(p: &Project) -> Badge {
    Badge {
        icon: p.icon.clone(),
        color: parse_hex(&p.color),
    }
}

/// The unread count a card of `density` shows: a row the plain count, as
/// it has no Ready pill (cards.ts denseRow); a card its badge count, none
/// while Ready stands in (parts.ts titleRow).
pub fn card_unread(density: Density, unread: Option<f64>, badge: f64) -> String {
    match density {
        Density::Row => unread_text(unread),
        Density::Full | Density::Compact => unread_text(Some(badge)),
    }
}

/// Whether the workspace is pinned.
fn is_pinned(w: Option<&Workspace>) -> bool {
    w.is_some_and(Workspace::is_pinned)
}

/// The looks a card shares whatever its shape: its badge, unread count,
/// Ready, pin, progress, helpers and age.
struct Looks {
    badge: Badge,
    unread: String,
    ready: bool,
    pinned: bool,
    progress: Option<f64>,
    helpers: String,
    age: String,
    status_has_age: bool,
}

/// A card's looks beside its `status` and the status `kind` it draws. A
/// row has no Ready pill (cards.ts denseRow), so it is never Ready, and its
/// status is its age, so its age is that same string and the status
/// carries it. The pill reads the kind the card already worked out
/// (shows_ready), not a second pass over the same rule.
fn looks(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    density: Density,
    status: &str,
    kind: &StatusKind,
) -> Looks {
    let row = density == Density::Row;
    let badge = session.badge_count(data, w);
    let (age, status_has_age) = if row {
        (status.to_string(), !status.is_empty())
    } else {
        (session.age_of(data, w), session.status_has_age(data, w))
    };
    Looks {
        badge: badge_of(&session.project_of_workspace(w)),
        unread: card_unread(density, w.and_then(|w| w.unread), badge),
        ready: !row && *kind == StatusKind::Ready,
        pinned: is_pinned(w),
        progress: progress_fraction(w),
        // A Running status line that counts the chat's agents already says
        // them; one counting shells alone, a waiting card's and a row's
        // status do not, so those keep the words.
        helpers: if *kind == StatusKind::Running
            && status.starts_with(RUNNING_WORD)
            && session.running_counts_agents(data, w)
        {
            String::new()
        } else {
            session.helper_text(w)
        },
        age,
        status_has_age,
    }
}

/// The core's view mode as the pane's view; anything but Projects is All.
pub fn view_of(view: &ViewModel) -> PanelView {
    if view.mode == ViewMode::Projects.as_str() {
        PanelView::Projects
    } else {
        PanelView::All
    }
}

pub(super) fn build(session: &mut Session, data: &Data, view: &ViewModel) -> Panel {
    let shown = view_of(view);
    let (projects, add, filter) = match shown {
        PanelView::Projects => (projects(session, data, view), None, None),
        PanelView::All => {
            let order = session.projects_in_view_order(data);
            let add = add_menu(session, &order);
            (Vec::new(), Some(add), Some(filter_menu(session, &order)))
        }
    };
    Panel {
        view: shown,
        next: next_line(data, view),
        needs: needs(session, data, view),
        lanes: lanes(session, data, view),
        projects,
        menu: session.menu_view(data),
        add,
        filter,
        lane_picks: lane_picks(session),
    }
}

/// The add button's menu: every project in the Projects view's order,
/// the busy ones in table order then the quiet ones, whether or not
/// Quiet is folded, less one removed here; and whether the home folder
/// is known. While All is filtered, the filter's choice is ticked, and a
/// project listed first.
fn add_menu(session: &Session, order: &[String]) -> AddMenu {
    let chosen = session.filter();
    let mut projects: Vec<AddProject> = order
        .iter()
        .map(|k| {
            let p = menu_project(session, k, chosen);
            // What a pick opens, so a folder just set in the editor counts
            // before the rebuild carries it.
            let can_open = session.root_to_open(k).is_some();
            AddProject {
                key: p.key,
                name: p.name,
                color: p.color,
                icon: p.icon,
                can_open,
                chosen: p.chosen,
            }
        })
        .collect();
    // A stable sort: the chosen one first, the rest as they were.
    projects.sort_by_key(|p| !p.chosen);
    AddMenu {
        projects,
        home: session.home_folder().is_some(),
        home_chosen: chosen == Some(NO_PROJECT),
    }
}

/// A project as both menus list it: its name, its badge (colour and
/// icon, as `badge_of` gives the Projects view), and whether the filter
/// has chosen it (`chosen` is `Session::filter`).
fn menu_project(session: &Session, k: &str, chosen: Option<&str>) -> FilterProject {
    let p = session.project_by_key(k);
    let badge = badge_of(&p);
    FilterProject {
        key: k.to_string(),
        name: p.name,
        color: badge.color,
        icon: badge.icon,
        chosen: chosen == Some(k),
    }
}

/// The filter's menu: every project in the add menu's order, then the
/// cards with no project, with the filter's choice ticked.
fn filter_menu(session: &Session, order: &[String]) -> FilterMenu {
    let chosen = session.filter();
    let projects = order
        .iter()
        .map(|k| menu_project(session, k, chosen))
        .collect();
    FilterMenu {
        projects,
        no_project: NO_PROJECT.to_string(),
        no_project_chosen: chosen == Some(NO_PROJECT),
    }
}

/// Every lane's key and name, in display order (Panel::lane_picks).
fn lane_picks(session: &Session) -> Vec<(LaneKey, String)> {
    session
        .lanes
        .iter()
        .map(|l| (l.key.clone(), l.name.clone()))
        .collect()
}

/// A card's chips row, for the kind of card it is, on a card that waits
/// on Jon as `waiting` says.
fn chips_row(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    kind: ChipsFor,
    waiting: Option<Waiting>,
) -> Vec<Chip> {
    let mut out: Vec<Chip> = match kind {
        // A row has no chips row.
        ChipsFor::Row => return Vec::new(),
        ChipsFor::Full | ChipsFor::Project => session
            .chips_for(data, w, true)
            .iter()
            .flat_map(|c| chip_views(c, waiting))
            .collect(),
        ChipsFor::Compact => compact_pr(session, data, w),
    };
    // Only once the shell has said where home is: until then the home
    // folder itself would be offered as a project.
    if kind == ChipsFor::Project && session.home.is_some() && session.can_create_project(w) {
        out.push(Chip::action(vec![piece(
            session.make_project_label(w),
            Token::Secondary,
        )]));
    }
    out
}

/// A compact card's PR in words, "#45 · 1 failing" (its number alone once
/// the status says Ready to merge), in its tone's ink (grey draft and
/// closed, green open, purple merged, as on a chip and a row), then its diff
/// size, faint, as a chip of its own. The sidebar runs them on from the
/// status line after a "·"; here they have a line of their own, so they
/// have none.
fn compact_pr(session: &mut Session, data: &Data, w: Option<&Workspace>) -> Vec<Chip> {
    let Some(pr) = pr_summary(&session.saved, w) else {
        return Vec::new();
    };
    let words = piece(
        session.card_pr_words(data, w, &pr),
        pr_text_color(&pr, draft_of(&session.saved, w)),
    );
    let chip = Chip {
        url: pr.web_link(),
        ..Chip::new(ChipKind::Pr, vec![words])
    };
    let mut out = vec![chip];
    out.extend(diff_chip(&pr.diff));
    out
}

/// A row's PR: its number in its tone's ink (grey draft and closed, green
/// open, purple merged) and its title. Only a row has one; a card's chips carry its PR.
fn row_pr(session: &Session, w: Option<&Workspace>, density: Density) -> Option<RowPr> {
    if density != Density::Row {
        return None;
    }
    let pr = pr_summary(&session.saved, w)?;
    Some(RowPr {
        ink: pr_text_color(&pr, draft_of(&session.saved, w)),
        tag: pr.tag,
        title: pr.title,
    })
}

/// Which chips a card in All carries, by its density.
pub fn chips_for_density(d: Density) -> ChipsFor {
    match d {
        Density::Full => ChipsFor::Full,
        Density::Compact => ChipsFor::Compact,
        Density::Row => ChipsFor::Row,
    }
}

/// Ready's words: the finished green, as a Ready card's status says it.
/// The Ready pill and Next, which only leads to a Ready card, take it.
pub fn ready_ink() -> Token {
    StatusKind::Ready.style().text
}

fn next_line(data: &Data, view: &ViewModel) -> NextLine {
    match &view.next.step {
        Some(step) => NextLine::Step {
            ws_id: step.target.clone(),
            title: title_of(data.ws_by_id(&step.target), &step.target),
            place: format!("{} of {}", step.position, step.total),
            ink: ready_ink(),
        },
        None => NextLine::Nothing,
    }
}

/// Needs you for the All tab's count: how many wait, the oldest wait
/// and its colour, and the session a click on the count reveals.
fn needs(session: &mut Session, data: &Data, view: &ViewModel) -> Needs {
    let n = &view.needs;
    let asking = n
        .list
        .iter()
        .all(|id| session.ask_of(data.ws_by_id(id)).is_some());
    let (fill, ink) = needs_tone(n.list.len(), asking, n.late);
    Needs {
        count: n.list.len(),
        label: needs_label(n.list.len()),
        wait: n.wait_text.clone(),
        late: n.late,
        fill,
        ink,
        target: needs_target(session, data, &n.list),
    }
}

/// Where a click on the count goes, from the list longest waiting first:
/// the first one after the waiting session Jon is on that no window has
/// selected (cmux keeps one selected per window), round to the oldest
/// again, so each click steps on; the oldest while he is on none of
/// them. None while every one waiting is selected.
fn needs_target(session: &mut Session, data: &Data, list: &[String]) -> Option<NeedsTarget> {
    let mut on = |id: &String| session.is_selected(data, data.ws_by_id(id));
    let id = match list.iter().position(&mut on) {
        Some(i) => list
            .iter()
            .cycle()
            .skip(i + 1)
            .take(list.len())
            .find(|id| !on(id))?,
        None => list.first()?,
    };
    Some(NeedsTarget {
        ws_id: id.clone(),
        title: title_of(data.ws_by_id(id), id),
    })
}

/// The count in words: "3 need you", "1 needs you", "" for none.
pub fn needs_label(count: usize) -> String {
    match count {
        0 => String::new(),
        1 => "1 needs you".to_string(),
        n => format!("{n} need you"),
    }
}

/// The count's fill and words: nothing with nothing waiting, amber while
/// only asks wait and none is late, else clay.
pub fn needs_tone(count: usize, all_asking: bool, late: bool) -> (Token, Token) {
    match count {
        0 => (Token::Clear, Token::Clear),
        _ if all_asking && !late => (Token::Amber, Token::AmberText),
        _ => (Token::Clay, Token::ClayText),
    }
}

/// How a card waits on Jon, None while it waits on nobody. Whether its
/// agent asks is worked out once; its mark, inks, edge, wash and size
/// chip all come from that.
fn waiting_of(session: &mut Session, view: &ViewModel, w: Option<&Workspace>) -> Option<Waiting> {
    let id = w?.id.as_str();
    if !view.needs.list.iter().any(|n| n == id) {
        return None;
    }
    Some(Waiting::of(session.ask_of(w).is_some()))
}

/// A waiting card's `age`, the one the card already shows, as the late
/// chip, "waiting 45m", once its wait has lasted NEEDS_LATE_SECS
/// (strip.rs) or more; None before that, with no age, or while it waits
/// on nobody.
fn late_of(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    waiting: Option<Waiting>,
    age: &str,
) -> Option<LateWait> {
    waiting?;
    let secs = wait_secs(data, session.since_of(w))?;
    late_wait(age, secs)
}

/// The late chip for an age of `age` after `secs` of waiting: clay
/// whether it is Your turn or Asking, as the late count is.
fn late_wait(age: &str, secs: f64) -> Option<LateWait> {
    (is_late(secs) && !age.is_empty()).then(|| LateWait {
        text: format!("{WAITING_WORD} {age}"),
        ink: Token::ClayText,
        face: Token::ClayChipFace,
        edge: Token::ClayChipEdge,
    })
}

/// The tab a waiting card names, from its workspace's agents.
fn waiting_tab_of(
    session: &mut Session,
    w: Option<&Workspace>,
    waiting: Option<Waiting>,
) -> Option<WaitingTab> {
    waiting?;
    let (title, surface_id) = session.agent_tab_of(w)?;
    Some(WaitingTab { title, surface_id })
}

/// A waiting card's status line, "Asking: allow git push?", with a detail
/// the core cut taken back to a whole word, and its ink: the waiting ink,
/// or grey and with no status in front for a reply's last line quoted for
/// want of a label.
fn needs_status(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    wt: Waiting,
) -> (String, Token) {
    let detail = whole_words(&session.needs_detail(w), NEEDS_DETAIL_MAX);
    if let Some(words) = session.stop_words_of(data, w) {
        return (with_detail(&words, &detail), wt.ink);
    }
    if session.unlabelled(w) {
        return (detail, Token::Secondary);
    }
    let label = session.status_info(data, w).label;
    (format!("{label}: {detail}"), wt.ink)
}

/// Whether a card's status line carries its age: a waiting card's says
/// the reason instead, so its title row shows the age. A row's status is
/// its age, waiting or not.
fn status_carries_age(density: Density, waiting: Option<Waiting>, has_age: bool) -> bool {
    match (density, waiting) {
        (Density::Row, _) | (_, None) => has_age,
        (_, Some(_)) => false,
    }
}

/// A full, compact or Projects card's detail, none while it waits: the
/// reason on its status line already says what the chat wants. A row is
/// not blanked; `row_detail` gives it the reason instead.
fn unless_waiting(waiting: Option<Waiting>, detail: String) -> String {
    if waiting.is_some() {
        String::new()
    } else {
        detail
    }
}

/// A card's detail and its ink. A waiting row's status is its age, so its
/// detail says the reason, in the waiting ink; any other waiting card's
/// status line says it, so it has none.
fn detail_of(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    density: Density,
    waiting: Option<Waiting>,
) -> (String, Token) {
    // Why its agent did not sleep or wake comes first, on every shape.
    if let Some(note) = w.and_then(|w| session.sleep_note(&w.id)) {
        return (note.to_string(), Token::Secondary);
    }
    match (density, waiting) {
        (Density::Row, Some(wt)) => needs_status(session, data, w, wt),
        (Density::Row, None) => (row_detail(session, w), Token::Secondary),
        _ => (
            unless_waiting(waiting, whole_words(&session.card_detail(w), DETAIL_MAX)),
            Token::Secondary,
        ),
    }
}

/// A row's detail. A row's status is its age, so a sleeping or waking
/// row says so ahead of its detail: "Asleep · Tests pass".
fn row_detail(session: &mut Session, w: Option<&Workspace>) -> String {
    let detail = whole_words(&session.card_detail(w), DETAIL_MAX);
    let Some(kind) = w.and_then(|w| session.sleep_kind(&w.id)) else {
        return detail;
    };
    let word = kind.style().label;
    if detail.is_empty() {
        word.to_string()
    } else {
        format!("{word} · {detail}")
    }
}

/// "You: " and the last prompt, with a prompt the core cut taken back to
/// a whole word.
fn left_off(text: &str) -> String {
    match text.strip_prefix(LEFT_OFF_LEAD) {
        Some(prompt) => format!("{LEFT_OFF_LEAD}{}", whole_words(prompt, LEFT_OFF_MAX)),
        None => whole_words(text, 0),
    }
}

/// A waiting card's status is its question: nothing to drop on a narrow card.
fn with_no_short((status, ink): (String, Token)) -> (String, String, Token) {
    (status, String::new(), ink)
}

fn card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let kind = session.status_kind(data, w);
    let style = kind.style();
    let density = card_density(&session.lanes, data, w);
    let waiting = waiting_of(session, view, w);
    // A row carries its age alone, as the sidebar's row does, in the
    // waiting ink while it waits (its detail says why); a card says its
    // status with the age, or while it waits on Jon, why.
    let (status, status_short, status_ink) = match (density, waiting) {
        (Density::Row, Some(wt)) => (session.age_of(data, w), String::new(), wt.ink),
        // A Running row counts from the earliest work, as its card does.
        (Density::Row, None) if kind == StatusKind::Running => {
            (session.status_age(data, w), String::new(), Token::MetaText)
        }
        (Density::Row, None) => (session.age_of(data, w), String::new(), Token::MetaText),
        (_, Some(wt)) => with_no_short(needs_status(session, data, w, wt)),
        (_, None) => {
            let (status, short) = session.status_forms(data, w);
            (status, short, style.text)
        }
    };
    let left_off = if shows_left_off(&session.lanes, data, w) {
        left_off(&session.left_off_text(w))
    } else {
        String::new()
    };
    let chips = chips_row(session, data, w, chips_for_density(density), waiting);
    let looks = looks(session, data, w, density, &status, &kind);
    let (detail, detail_ink) = detail_of(session, data, w, density, waiting);
    let late = late_of(session, data, w, waiting, &looks.age);
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        density,
        badge: looks.badge,
        unread: looks.unread,
        ready: looks.ready,
        ready_ink: ready_ink(),
        pinned: looks.pinned,
        progress: looks.progress,
        helpers: looks.helpers,
        status,
        status_short,
        status_ink,
        age: looks.age,
        status_has_age: status_carries_age(density, waiting, looks.status_has_age),
        left_off,
        chips,
        row_pr: row_pr(session, w, density),
        detail,
        detail_ink,
        detail_lines: detail_lines(density),
        waiting,
        late,
        waiting_tab: waiting_tab_of(session, w, waiting),
        rank: session.state_rank(data, w),
        movable: !is_foreign_anchor(session, data, id),
        dimmed: is_dimmed(session, data, w),
        selected: session.is_selected(data, w),
        menu: session.card_menu(data, w),
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
                let mut head = lane_head(session, data, view, lane, header, false);
                head.anchor = anchor_id.as_deref().map(|id| anchor(session, data, id));
                out.push(head);
            }
            LaneEntry::Zone { lane, .. } => {
                let header = view.lane_headers.get(lane);
                out.push(lane_head(session, data, view, lane, header, true));
            }
            LaneEntry::Ws { ws_id, .. } => {
                let c = card(session, data, view, ws_id);
                push_row(&mut out, Row::Card(Box::new(c)));
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
        id: id.to_string(),
        selected: session.is_selected(data, w),
        icon: icon_of(&session.status_info(data, w)),
        unread: unread_text(w.and_then(|w| w.unread)),
    }
}

/// A lane's or project's heading dot (issue #314): the needs dot while
/// a card under it waits on Jon, folded or open, clay while any of them
/// is Your turn and amber while every one asks, as its cards' marks are;
/// else `folded`'s dot, the most urgent session while folded.
fn header_dot(
    session: &mut Session,
    data: &Data,
    view: &ViewModel,
    ws: &[&Workspace],
    folded: Option<&Workspace>,
) -> Option<Icon> {
    let mut waiting = ws
        .iter()
        .copied()
        .filter(|w| view.needs.list.contains(&w.id));
    if waiting.clone().next().is_none() {
        return folded.map(|w| icon_of(&session.status_info(data, Some(w))));
    }
    let asking = waiting.all(|w| session.ask_of(Some(w)).is_some());
    Some(Icon {
        glyph: DOT,
        ink: Some(waiting_tokens(asking).0),
        halo: waiting_halo(asking),
    })
}

/// "Drop here" as a piece, for a lane header to say under a drag.
fn drop_piece() -> super::Piece {
    let hint = drop_hint();
    piece(hint.text, hint.color)
}

fn lane_head(
    session: &mut Session,
    data: &Data,
    view: &ViewModel,
    key: &LaneKey,
    header: Option<&LaneHeaderView>,
    empty: bool,
) -> Lane {
    let lane = session.lanes.get(key).clone();
    let ids: &[String] = header.map_or(&[], |h| h.workspaces.as_slice());
    let collapsed = header.is_some_and(|h| h.collapsed);
    let ws: Vec<&Workspace> = ids.iter().filter_map(|id| data.ws_by_id(id)).collect();
    let status = session.header_status(data, &ws, collapsed);
    let dot = header_dot(session, data, view, &ws, status.dot);
    Lane {
        key: lane.key.clone(),
        empty,
        name: lane_name(&lane.name),
        faint: faint_heading(&lane, empty),
        marker: lane.color,
        anchor: None,
        count: ids.len(),
        total: header.and_then(|h| h.total),
        pill: status.tint,
        dot,
        collapsed,
        merge_ready: header.map(|h| h.merge_ready.clone()).unwrap_or_default(),
        merge_ink: merge_ink(faint_heading(&lane, empty)),
        drop_hint: drop_piece(),
        rows: Vec::new(),
    }
}

/// A card in the Projects view, as the sidebar's project card: its title
/// and status, what a waiting chat wants, and its chips with the branch.
fn project_card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let kind = session.status_kind(data, w);
    let style = kind.style();
    let wanted = session.move_of(w).map(|m| m.text).unwrap_or_default();
    let waiting = waiting_of(session, view, w);
    let (status, status_short, status_ink) = match waiting {
        Some(wt) => with_no_short(needs_status(session, data, w, wt)),
        None => {
            let (status, short) = session.status_forms(data, w);
            (status, short, style.text)
        }
    };
    let looks = looks(session, data, w, Density::Full, &status, &kind);
    let late = late_of(session, data, w, waiting, &looks.age);
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        density: Density::Full,
        badge: looks.badge,
        unread: looks.unread,
        ready: looks.ready,
        ready_ink: ready_ink(),
        pinned: looks.pinned,
        progress: looks.progress,
        helpers: looks.helpers,
        status,
        status_short,
        status_ink,
        age: looks.age,
        status_has_age: status_carries_age(Density::Full, waiting, looks.status_has_age),
        left_off: String::new(),
        chips: chips_row(session, data, w, ChipsFor::Project, waiting),
        row_pr: None,
        detail: unless_waiting(waiting, whole_words(&wanted, 0)),
        detail_ink: Token::Secondary,
        detail_lines: 2,
        waiting,
        late,
        waiting_tab: waiting_tab_of(session, w, waiting),
        rank: session.state_rank(data, w),
        movable: !is_foreign_anchor(session, data, id),
        dimmed: is_dimmed(session, data, w),
        selected: session.is_selected(data, w),
        menu: session.card_menu(data, w),
    }
}

/// A project's header: its look from the table, and the cards it counts.
fn project_head(session: &mut Session, data: &Data, view: &ViewModel, k: &str) -> ProjectHead {
    let p = session.project_by_key(k);
    let collapsed = session.is_project_collapsed(k);
    let ws = session.project_workspaces(data, k);
    let status = session.header_status(data, &ws, collapsed);
    let dot = header_dot(session, data, view, &ws, status.dot);
    ProjectHead {
        key: k.to_string(),
        id: format!("{PROJECT_ROW}{k}"),
        name: p.name.clone(),
        color: parse_hex(&p.color),
        icon: p.icon.clone(),
        count: ws.len(),
        pill: status.tint,
        dot,
        collapsed,
        can_open: session.can_open_project(k),
        menu: session.project_menu(k),
    }
}

fn projects(session: &mut Session, data: &Data, view: &ViewModel) -> Vec<ProjectRow> {
    let entries = session.project_entries(data);
    let quiet = session.quiet_projects(data).len();
    let mut out = Vec::new();
    for entry in &entries {
        let row = match entry {
            ProjectEntry::Header { project, .. } => {
                ProjectRow::Header(project_head(session, data, view, project))
            }
            ProjectEntry::Ws { ws_id, .. } => {
                ProjectRow::Card(project_card(session, data, view, ws_id))
            }
            ProjectEntry::NewRow { .. } => ProjectRow::NewProject,
            ProjectEntry::QuietHeader { .. } => ProjectRow::QuietHeader {
                count: quiet,
                collapsed: session.quiet_collapsed(),
                pill: QUIET_PILL,
            },
            ProjectEntry::QuietRow { project, .. } => {
                let p = session.project_by_key(project);
                ProjectRow::Quiet {
                    key: project.clone(),
                    id: format!("{QUIET_ROW}{project}"),
                    name: p.name.clone(),
                    color: parse_hex(&p.color),
                    icon: p.icon.clone(),
                    can_open: session.can_open_project(project),
                    menu: session.quiet_menu(project),
                }
            }
            ProjectEntry::Editor { project, .. } => {
                ProjectRow::Editor(EditorView::from_session(session, data, project))
            }
        };
        out.push(row);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Model;
    use crate::data::{Agent, AgentStatus};
    use crate::moves::MoveSize;
    use crate::persist::SavedState;
    use crate::ui::Urgency;

    fn style(dot: Option<Token>, ring: Option<Token>) -> StatusStyle {
        StatusStyle {
            label: "Working",
            dot,
            halo: Token::BlueHalo,
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
                ink: Some(Token::Blue),
                halo: Token::BlueHalo,
            }
        );
        assert_eq!(
            icon_of(&style(None, Some(Token::Blue))),
            Icon {
                glyph: HOLLOW,
                ink: Some(Token::Blue),
                halo: Token::Clear,
            },
            "a hollow dot has no halo"
        );
        assert_eq!(
            icon_of(&style(None, None)),
            Icon {
                glyph: HOLLOW,
                ink: None,
                halo: Token::Clear,
            }
        );
    }

    #[test]
    fn haloes_each_live_dot_in_its_own_hue_and_leaves_the_quiet_ones_clear() {
        use crate::status::Status;
        let halo = |k: StatusKind| icon_of(&k.style()).halo;
        assert_eq!(halo(StatusKind::Plain(Status::Working)), Token::BlueHalo);
        assert_eq!(halo(StatusKind::Plain(Status::NeedsInput)), Token::ClayHalo);
        assert_eq!(halo(StatusKind::Asking), Token::AmberHalo);
        assert_eq!(halo(StatusKind::MergeReady), Token::MergeHalo);
        assert_eq!(halo(StatusKind::Running), Token::BlueHalo);
        assert_eq!(halo(StatusKind::Ready), Token::Clear, "finished green");
        assert_eq!(halo(StatusKind::Quiet), Token::Clear, "hollow blue");
        assert_eq!(halo(StatusKind::Plain(Status::Idle)), Token::Clear);
        assert_eq!(halo(StatusKind::Plain(Status::None)), Token::Clear);
    }

    #[test]
    fn inks_ready_and_next_in_the_finished_green() {
        assert_eq!(ready_ink(), Token::GreenText);
    }

    #[test]
    fn inks_a_merge_line_and_says_drop_here_as_the_cores_header_hint() {
        let lanes = lanes::Lanes::default();
        let lane = |id: &str| lanes.get(&LaneKey::from(id));
        assert_eq!(merge_ink(lane("review").faint), Token::MergeText);
        assert_eq!(merge_ink(lane("parked").faint), Token::Faint);
        let drop = drop_piece();
        assert_eq!(
            (drop.text.as_str(), drop.ink),
            ("Drop here", Token::Heading)
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
        let lanes = lanes::Lanes::default();
        let lane = |id: &str| lanes.get(&LaneKey::from(id));
        assert!(faint_heading(lane("parked"), false));
        assert!(faint_heading(lane("main"), true));
        assert!(!faint_heading(lane("main"), false));
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

    /// The panel over one workspace "W" running `agents`, each its status
    /// and its tab's title and surface ("" for none).
    fn one_workspace(agents: &[(&str, Option<&str>, &str)]) -> Panel {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let agents: Vec<serde_json::Value> = agents
            .iter()
            .enumerate()
            .map(|(i, (status, title, surface))| {
                serde_json::json!({"id": format!("a{i}"), "status": status,
                    "tabTitle": title, "surfaceId": (!surface.is_empty()).then_some(surface),
                    "sinceEpoch": 100 + i})
            })
            .collect();
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": 200,
            "workspaces": [{"id": "W", "title": "fix login", "agents": agents}]}))
        .unwrap();
        let mut core = Model::default();
        let _effects = Cockpit.update(Event::Data(data), &mut core);
        Panel::from_core(&mut core)
    }

    fn tab_of(panel: &Panel) -> Option<WaitingTab> {
        panel
            .lane_cards()
            .find(|c| c.ws_id == "W")?
            .waiting_tab
            .clone()
    }

    #[test]
    fn a_waiting_card_with_several_agents_names_the_waiting_ones_tab() {
        let panel = one_workspace(&[
            ("working", Some("Review #327"), "S1"),
            ("needs_input", Some("Fix CI lint"), "S2"),
        ]);
        assert!(panel.is_waiting("W"));
        assert_eq!(
            tab_of(&panel),
            Some(WaitingTab {
                title: "Fix CI lint".into(),
                surface_id: "S2".into()
            })
        );
    }

    #[test]
    fn names_no_tab_with_one_agent_nothing_waiting_or_no_title() {
        let one = one_workspace(&[("needs_input", Some("Fix CI lint"), "S2")]);
        assert!(one.is_waiting("W"));
        assert_eq!(tab_of(&one), None, "one agent: the card is that tab");
        let busy = one_workspace(&[
            ("working", Some("Review #327"), "S1"),
            ("working", Some("Fix CI lint"), "S2"),
        ]);
        assert_eq!(tab_of(&busy), None, "nothing waits");
        let untitled = one_workspace(&[("working", None, "S1"), ("needs_input", Some(" "), "S2")]);
        assert!(untitled.is_waiting("W"));
        assert_eq!(
            tab_of(&untitled),
            Some(WaitingTab {
                title: String::new(),
                surface_id: "S2".into()
            }),
            "an untitled tab draws no line but a click still selects it"
        );
        let nowhere = one_workspace(&[
            ("working", Some("Review #327"), "S1"),
            ("needs_input", None, ""),
        ]);
        assert!(nowhere.is_waiting("W"));
        assert_eq!(tab_of(&nowhere), None, "no tab, nothing to name or select");
    }

    #[test]
    fn an_ended_agent_does_not_count_towards_several() {
        let panel = one_workspace(&[
            ("ended", Some("Review #327"), "S1"),
            ("needs_input", Some("Fix CI lint"), "S2"),
        ]);
        assert!(panel.is_waiting("W"));
        assert_eq!(
            tab_of(&panel),
            None,
            "one agent still running: the card is that tab"
        );
    }

    #[test]
    fn is_empty_before_the_first_frame() {
        let mut core = Model::default();
        assert_eq!(Panel::from_core(&mut core), Panel::default());
    }

    /// Each piece's words and ink.
    fn inks(c: &Chip) -> Vec<(&str, Token)> {
        c.pieces.iter().map(|p| (p.text.as_str(), p.ink)).collect()
    }

    #[test]
    fn inks_a_prs_number_quietly_its_state_by_tone_and_its_diff_faint_on_its_own() {
        use crate::pr_colors::PrTone;
        // On a card waiting on Jon: only the size takes the wait's colour.
        let chips = chip_views(
            &CoreChip::Pr {
                tag: "#3".into(),
                state: "1 failing".into(),
                tone: PrTone::Failing,
                diff: "+1 \u{2212}2".into(),
                url: Some("https://github.com/o/r/pull/3".into()),
            },
            Some(Waiting::of(false)),
        );
        assert!(
            chips
                .iter()
                .all(|c| (c.face, c.edge) == (Token::ChipFace, Token::ChipEdge)),
            "a PR keeps the quiet chip's face and edge on a waiting card"
        );
        assert_eq!(chips.len(), 2, "the PR, then its diff size");
        assert_eq!(chips[0].kind, ChipKind::Pr);
        assert_eq!(
            inks(&chips[0]),
            [("#3", Token::Secondary), ("1 failing", Token::RedText)]
        );
        assert_eq!(
            chips[0].url.as_deref(),
            Some("https://github.com/o/r/pull/3")
        );
        assert_eq!(chips[1].kind, ChipKind::Diff);
        assert_eq!(inks(&chips[1]), [("+1 \u{2212}2", Token::Faint)]);
        assert_eq!(chips[1].url, None);
        assert!(chips.iter().all(|c| !c.is_action && !c.gives_way));
        let bare = chip_views(
            &CoreChip::Pr {
                tag: "#6".into(),
                state: String::new(),
                tone: PrTone::Open,
                diff: String::new(),
                url: None,
            },
            None,
        );
        assert_eq!(bare.len(), 1, "no diff, no diff chip");
        assert_eq!(bare[0].pieces.len(), 1, "no state, no state words");
        assert_eq!(bare[0].url, None, "a PR with no link opens nothing");
    }

    #[test]
    fn marks_a_dirty_branch_and_keeps_a_port_quiet() {
        let br = chip_views(
            &CoreChip::Branch {
                text: "feat".into(),
                dirty: true,
            },
            Some(Waiting::of(true)),
        );
        let words: Vec<&str> = br[0].pieces.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(words, ["feat", DIRTY_MARK]);
        assert_eq!(br[0].kind, ChipKind::Branch);
        assert!(br[0].gives_way, "the branch goes first on a narrow line");
        assert_eq!(br[0].url, None);
        assert_eq!(
            (br[0].face, br[0].edge),
            (Token::ChipFace, Token::ChipEdge),
            "a branch stays quiet on a waiting card"
        );
        let port = chip_views(
            &CoreChip::Port {
                text: ":5173 \u{2197}".into(),
                url: "http://localhost:5173".into(),
            },
            None,
        );
        assert_eq!(port[0].kind, ChipKind::Port);
        assert_eq!(port[0].pieces[0].ink, Token::Secondary);
        assert_eq!(port[0].url.as_deref(), Some("http://localhost:5173"));
        assert!(!port[0].is_action, "a port opens a page, it does not act");
    }

    /// The size chip's ink, face and edge for each size, on a card that
    /// waits as `asks` says.
    fn size_tokens(asks: bool) -> Vec<(Token, Token, Token)> {
        [
            ("Quick", MoveSize::Quick),
            ("Decide \u{b7} 2", MoveSize::Decide),
            ("Review", MoveSize::Review),
        ]
        .into_iter()
        .map(|(text, size)| {
            let chip = chip_views(
                &CoreChip::Size {
                    text: text.into(),
                    size,
                },
                Some(Waiting::of(asks)),
            );
            assert_eq!(chip.len(), 1);
            assert_eq!(chip[0].kind, ChipKind::Size);
            assert_eq!(chip[0].pieces[0].text, text);
            (chip[0].pieces[0].ink, chip[0].face, chip[0].edge)
        })
        .collect()
    }

    #[test]
    fn colours_the_size_chip_as_its_card_waits() {
        let turn = (Token::ClayText, Token::ClayChipFace, Token::ClayChipEdge);
        assert_eq!(size_tokens(false), [turn; 3], "Your turn: clay");
        let asking = (Token::AmberText, Token::AmberChipFace, Token::AmberChipEdge);
        assert_eq!(size_tokens(true), [asking; 3], "Asking: amber");
        let quick = CoreChip::Size {
            text: "Quick".into(),
            size: MoveSize::Quick,
        };
        assert!(
            chip_views(&quick, None).is_empty(),
            "waiting on nobody: no size chip, never a quiet one"
        );
        // Its words take the same ink as the card's reason.
        assert_eq!(turn.0, Waiting::of(false).ink);
        assert_eq!(asking.0, Waiting::of(true).ink);
    }

    #[test]
    fn edges_strips_and_washes_a_waiting_card_in_its_waits_colour() {
        assert_eq!(
            Waiting::of(false),
            Waiting {
                mark: Token::Clay,
                ink: Token::ClayText,
                edge: Token::ClayCardEdge,
                wash: Token::ClayWash,
            },
            "Your turn"
        );
        assert_eq!(
            Waiting::of(true),
            Waiting {
                mark: Token::Amber,
                ink: Token::AmberText,
                edge: Token::AmberCardEdge,
                wash: Token::AmberWash,
            },
            "Asking"
        );
        // Its chip's face and edge come from the same wait, and it knows
        // which wait it is.
        assert!(Waiting::of(true).asks() && !Waiting::of(false).asks());
        assert_eq!(
            Waiting::of(true).chip(),
            (Token::AmberChipFace, Token::AmberChipEdge)
        );
        assert_eq!(
            Waiting::of(false).chip(),
            (Token::ClayChipFace, Token::ClayChipEdge)
        );
    }

    #[test]
    fn turns_a_wait_of_half_an_hour_into_a_clay_chip() {
        assert_eq!(late_wait("29m", 29.0 * 60.0 + 59.0), None, "29m59s");
        let late = LateWait {
            text: "waiting 30m".into(),
            ink: Token::ClayText,
            face: Token::ClayChipFace,
            edge: Token::ClayChipEdge,
        };
        assert_eq!(late_wait("30m", 30.0 * 60.0), Some(late), "30m");
        assert_eq!(late_wait("", 3600.0), None, "no age to say");
    }

    /// One workspace "W" whose agent has waited `secs` (needs_input, or
    /// asking on a permission when `asks`), and the panel's card for it.
    fn waited(secs: f64, asks: bool) -> Card {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let mut core = Model::default();
        if asks {
            core.session.saved = crate::persist::SavedState::from_json(
                r#"{"asking": {"W": {"reason": "allow git push?", "epoch": 1000}}}"#,
            )
            .unwrap();
        }
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": 1000.0 + secs,
            "workspaces": [{"id": "W", "title": "fix login",
                "agents": [{"id": "a0", "status": "needs_input", "sinceEpoch": 1000}]}]}))
        .unwrap();
        let _effects = Cockpit.update(Event::Data(data), &mut core);
        let panel = Panel::from_core(&mut core);
        panel.lane_cards().find(|c| c.ws_id == "W").unwrap().clone()
    }

    /// A chat whose turn ended at 1000 on `move_json`, its agent as
    /// `agent_json` says, while a shell it started at 100 still runs: the
    /// core after that frame, `dismiss` dismissing its wait first.
    fn after_turn(move_json: &str, agent_json: &str, dismiss: bool) -> Model {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let mut core = Model::default();
        core.session.saved = crate::persist::SavedState::from_json(&format!(
            r#"{{"moves": {{"W": {move_json}}},
                "background": {{"W": [{{"id": "b1", "type": "shell", "status": "running",
                    "description": "dev server", "session": "c", "startedEpoch": 100,
                    "seenEpoch": 1000}}]}}}}"#
        ))
        .unwrap();
        let _effects = Cockpit.update(Event::Data(turn_data(agent_json)), &mut core);
        if dismiss {
            let _effects = Cockpit.update(Event::Dismiss { id: "W".into() }, &mut core);
        }
        core
    }

    fn turn_data(agent_json: &str) -> Data {
        serde_json::from_str(&format!(
            r#"{{"epoch": 1100, "workspaces": [{{"id": "W", "title": "fix login",
                "latestAt": 900, "agents": [{agent_json}]}}]}}"#
        ))
        .unwrap()
    }

    /// The card for W, and the size chips the core gives it.
    fn card_and_sizes(core: &mut Model) -> (Card, Vec<CoreChip>) {
        let panel = Panel::from_core(core);
        let card = panel.lane_cards().find(|c| c.ws_id == "W").unwrap().clone();
        let data = core.data.clone().unwrap_or_default();
        let sizes = core
            .session
            .chips_for(&data, data.ws_by_id("W"), false)
            .into_iter()
            .filter(|c| matches!(c, CoreChip::Size { .. }))
            .collect();
        (card, sizes)
    }

    fn running_kind(core: &mut Model) -> StatusKind {
        let data = core.data.clone().unwrap_or_default();
        core.session.status_kind(&data, data.ws_by_id("W"))
    }

    const STOPPED: &str = r#"{"id": "c", "kind": "claude", "status": "idle",
        "sinceEpoch": 1000, "lastActivityAt": 1000}"#;
    const NUDGED: &str = r#"{"id": "c", "kind": "claude", "status": "needs_input",
        "sinceEpoch": 1060, "lastActivityAt": 1000}"#;
    const QUICK_MOVE: &str =
        r#"{"text": "Your move: go once the left panel redraws.", "epoch": 1000, "session": "c"}"#;

    #[test]
    fn a_turn_that_asks_jon_waits_in_clay_with_its_size_chip_while_a_shell_runs() {
        for agent in [STOPPED, NUDGED] {
            let mut core = after_turn(QUICK_MOVE, agent, false);
            let (card, sizes) = card_and_sizes(&mut core);
            assert_eq!(card.waiting, Some(Waiting::of(false)), "{agent}");
            assert_eq!(card.status_ink, Token::ClayText);
            assert_eq!(card.age, "1m", "from the turn end, not the shell's start");
            assert_eq!(sizes.len(), 1);
            let drawn = chip_views(&sizes[0], card.waiting);
            assert_eq!(drawn[0].pieces[0].text, "Quick");
            assert_eq!(drawn[0].pieces[0].ink, Token::ClayText);
        }
    }

    #[test]
    fn a_dismissed_wait_says_running_with_no_size_chip_and_stays_dismissed_past_the_nudge() {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let mut core = after_turn(QUICK_MOVE, STOPPED, true);
        let (card, sizes) = card_and_sizes(&mut core);
        assert_eq!(card.waiting, None);
        assert_eq!(running_kind(&mut core), StatusKind::Running);
        assert!(sizes.is_empty(), "no chip on a card that does not wait");
        // The nudge lands a minute on: the dismissal holds.
        let _effects = Cockpit.update(Event::Data(turn_data(NUDGED)), &mut core);
        let (card, _) = card_and_sizes(&mut core);
        assert_eq!(card.waiting, None);
        assert_eq!(running_kind(&mut core), StatusKind::Running);
    }

    #[test]
    fn a_nothing_for_you_turn_says_running_and_draws_no_size_chip() {
        let quiet = r#"{"text": "Nothing for you: go on.", "idle": true, "epoch": 1000,
            "session": "c"}"#;
        let mut core = after_turn(quiet, STOPPED, false);
        let (card, sizes) = card_and_sizes(&mut core);
        assert_eq!(card.waiting, None);
        assert_eq!(running_kind(&mut core), StatusKind::Running);
        assert!(sizes.is_empty());
    }

    /// The core after a frame at epoch `now` with one workspace "W"
    /// whose agent "c" is `status` and stopped as `stop` says (cause and
    /// start), its last words "Please run /login", Jon on another
    /// workspace; dismissing W's wait first when `dismiss`.
    fn stopped_core(now: f64, status: &str, stop: (&str, f64), dismiss: bool) -> Model {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let mut core = Model::default();
        let data = stopped_data(now, status, stop);
        let _effects = Cockpit.update(Event::Data(data), &mut core);
        if dismiss {
            let _effects = Cockpit.update(Event::Dismiss { id: "W".into() }, &mut core);
        }
        core
    }

    fn stopped_data(now: f64, status: &str, (cause, since): (&str, f64)) -> Data {
        serde_json::from_value(serde_json::json!({"epoch": now,
            "workspaces": [
                {"id": "W", "title": "fix login", "latestMessage": "Please run /login",
                 "agents": [{"id": "c", "kind": "claude", "status": status,
                     "sinceEpoch": 900, "lastActivityAt": 900,
                     "stopped": {"cause": cause, "since": since}}]},
                {"id": "X", "title": "other", "selected": true}]}))
        .unwrap()
    }

    fn w_card(core: &mut Model) -> (Card, Needs) {
        let panel = Panel::from_core(core);
        let card = panel.lane_cards().find(|c| c.ws_id == "W").unwrap().clone();
        (card, panel.needs)
    }

    /// W's waiting line as any card shape says it: a row's in its detail.
    fn w_line(core: &mut Model) -> String {
        let (card, _) = w_card(core);
        if card.density == Density::Row {
            card.detail
        } else {
            card.status
        }
    }

    /// W's status line, as a full card would say it.
    fn w_status(core: &mut Model) -> String {
        let data = core.data.clone().unwrap_or_default();
        core.session.status_line(&data, data.ws_by_id("W"))
    }

    #[test]
    fn a_stopped_session_waits_in_clay_with_its_cause_and_last_words() {
        let mut core = stopped_core(1000.0 + 120.0, "working", ("error", 1000.0), false);
        let (card, needs) = w_card(&mut core);
        assert_eq!(card.waiting, Some(Waiting::of(false)), "clay, never amber");
        assert_eq!(w_line(&mut core), "Stopped on an error: Please run /login");
        assert_eq!(card.status_ink, Token::ClayText);
        assert_eq!(card.icon.ink, Some(Token::Clay));
        assert_eq!(card.age, "2m", "from the stop");
        assert_eq!((needs.count, needs.fill), (1, Token::Clay));
        let data = core.data.clone().unwrap_or_default();
        assert_eq!(
            core.session.status_kind(&data, data.ws_by_id("W")),
            StatusKind::Stopped
        );
        let gone = w_line(&mut stopped_core(1060.0, "idle", ("gone", 1000.0), false));
        assert_eq!(gone, "Stopped mid-turn: Please run /login");
        let silent = w_line(&mut stopped_core(
            2400.0,
            "working",
            ("silent", 900.0),
            false,
        ));
        assert_eq!(silent, "Stopped, silent 25m: Please run /login");
        let late = w_card(&mut stopped_core(
            1000.0 + 1800.0,
            "idle",
            ("gone", 1000.0),
            false,
        ))
        .0;
        assert_eq!(late.late.map(|l| l.text), Some("waiting 30m".to_string()));
    }

    #[test]
    fn a_dismissed_stop_stays_dismissed_until_a_new_one() {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let mut core = stopped_core(1060.0, "working", ("error", 1000.0), true);
        let (card, needs) = w_card(&mut core);
        assert_eq!((card.waiting, needs.count), (None, 0));
        assert_eq!(w_status(&mut core), "Idle 1m", "the turn is over");
        // Frames go on (prune runs on each): the dismissal holds.
        for now in [1090.0, 1500.0] {
            let data = stopped_data(now, "working", ("error", 1000.0));
            let _effects = Cockpit.update(Event::Data(data), &mut core);
            assert_eq!(w_card(&mut core).1.count, 0, "at {now}");
        }
        // A new stop, a later start: it waits again.
        let data = stopped_data(1600.0, "working", ("error", 1550.0));
        let _effects = Cockpit.update(Event::Data(data), &mut core);
        assert_eq!(w_card(&mut core).1.count, 1);
        // A dismissed silence is still working, quietly.
        let mut silent = stopped_core(2400.0, "working", ("silent", 900.0), true);
        let data = silent.data.clone().unwrap_or_default();
        assert_eq!(
            silent.session.status_kind(&data, data.ws_by_id("W")),
            StatusKind::Quiet
        );
        assert_eq!(w_card(&mut silent).1.count, 0);
    }

    #[test]
    fn the_card_menu_dismisses_a_stop_and_an_older_move_draws_no_size_chip() {
        use crate::menu::{MenuAction, MenuEvent};
        use crate::{Cockpit, Event};
        use crux_core::App;
        let mut core = Model::default();
        core.session.saved = crate::persist::SavedState::from_json(
            r#"{"moves": {"W": {"text": "Your move: say go.", "epoch": 800, "session": "c"}}}"#,
        )
        .unwrap();
        let data = stopped_data(1060.0, "working", ("error", 1000.0));
        let _effects = Cockpit.update(Event::Data(data.clone()), &mut core);
        let (card, _) = w_card(&mut core);
        assert!(card.waiting.is_some());
        let sizes = core.session.chips_for(&data, data.ws_by_id("W"), false);
        assert!(
            !sizes.iter().any(|c| matches!(c, CoreChip::Size { .. })),
            "the move before the stop is no ask"
        );
        let has = |core: &mut Model, label: &str| {
            let data = core.data.clone().unwrap_or_default();
            core.session
                .card_menu(&data, data.ws_by_id("W"))
                .iter()
                .any(|i| matches!(i, crate::menu::MenuItem::Item { label: l, .. } if l == label))
        };
        assert!(has(&mut core, "Dismiss needs you"));
        let open = Event::Menu(MenuEvent::OpenCard { id: "W".into() });
        let _effects = Cockpit.update(open, &mut core);
        let pick = Event::Menu(MenuEvent::Pick(MenuAction::ToggleNeeds));
        let _effects = Cockpit.update(pick, &mut core);
        assert_eq!(w_card(&mut core).1.count, 0);
        assert!(has(&mut core, "Restore needs you"));
    }

    #[test]
    fn an_asleep_workspace_never_waits_on_a_stop() {
        let mut core = Model::default();
        core.session.saved = crate::persist::SavedState::from_json(
            r#"{"asleep": {"W": {"surfaces": ["S"], "since": 1000}}}"#,
        )
        .unwrap();
        let data = stopped_data(1060.0, "idle", ("gone", 1000.0));
        let _effects = {
            use crate::{Cockpit, Event};
            use crux_core::App;
            Cockpit.update(Event::Data(data), &mut core)
        };
        assert_eq!(w_card(&mut core).1.count, 0);
    }

    #[test]
    fn a_card_waiting_half_an_hour_or_more_says_so_in_clay() {
        let just = waited(29.0 * 60.0 + 59.0, false);
        assert!(just.waiting.is_some());
        assert_eq!(just.late, None, "29m59s: the plain age");
        assert_eq!(just.age, "29m");
        let late = waited(30.0 * 60.0, false);
        assert_eq!(
            late.late.as_ref().map(|l| l.text.as_str()),
            Some("waiting 30m")
        );
        assert_eq!(late.age, "30m", "the plain age stays");
        assert_eq!(late.waiting, Some(Waiting::of(false)));
        let asking = waited(45.0 * 60.0, true);
        assert_eq!(asking.waiting, Some(Waiting::of(true)), "it asks");
        let chip = asking.late.unwrap();
        assert_eq!(chip.text, "waiting 45m");
        assert_eq!(
            (chip.ink, chip.face, chip.edge),
            (Token::ClayText, Token::ClayChipFace, Token::ClayChipEdge),
            "late is clay on an Asking card too"
        );
    }

    #[test]
    fn makes_the_actions_action_chips() {
        let make = Chip::action(vec![piece("Make a project", Token::Secondary)]);
        assert_eq!(make.kind, ChipKind::Action);
        assert!(make.is_action);
        assert_eq!(make.url, None);
        assert!(!make.gives_way);
    }

    #[test]
    fn badges_a_card_with_its_projects_symbol_and_colour() {
        let other = crate::projects::other();
        let b = badge_of(&other);
        assert_eq!(b.icon, "terminal");
        assert_eq!(b.color, Some(0xA0_9E_95));
        let odd = Project {
            color: "not a colour".into(),
            ..other
        };
        assert_eq!(badge_of(&odd).color, None);
    }

    #[test]
    fn counts_unread_on_a_row_plainly_and_on_a_card_as_its_badge() {
        // Ready: the badge count is 0 while the pill stands in for it.
        assert_eq!(card_unread(Density::Full, Some(3.0), 0.0), "");
        assert_eq!(card_unread(Density::Compact, Some(3.0), 3.0), "3");
        assert_eq!(card_unread(Density::Row, Some(3.0), 0.0), "3");
        assert_eq!(card_unread(Density::Row, None, 0.0), "");
    }

    #[test]
    fn pins_only_a_workspace_marked_pinned() {
        assert!(!is_pinned(None));
        assert!(!is_pinned(Some(&Workspace::default())));
        let w = Workspace {
            pinned: Some(true),
            ..Workspace::default()
        };
        assert!(is_pinned(Some(&w)));
    }

    #[test]
    fn gives_a_full_card_its_chips_a_compact_one_its_pr_and_a_row_none() {
        assert_eq!(chips_for_density(Density::Full), ChipsFor::Full);
        assert_eq!(chips_for_density(Density::Compact), ChipsFor::Compact);
        assert_eq!(chips_for_density(Density::Row), ChipsFor::Row);
    }

    #[test]
    fn takes_the_view_from_the_cores_mode() {
        let mut view = ViewModel::default();
        assert_eq!(view_of(&view), PanelView::All, "before any mode");
        view.mode = ViewMode::Projects.as_str().into();
        assert_eq!(view_of(&view), PanelView::Projects);
        view.mode = ViewMode::All.as_str().into();
        assert_eq!(view_of(&view), PanelView::All);
    }

    #[test]
    fn files_rows_under_the_lane_headed_last() {
        let mut core = Model::default();
        let data = Data {
            epoch: Some(1000.0),
            workspaces: Some(vec![Workspace {
                id: "a".into(),
                ..Workspace::default()
            }]),
            ..Data::default()
        };
        let row = Row::Card(Box::new(card(
            &mut core.session,
            &data,
            &ViewModel::default(),
            "a",
        )));
        let mut lanes = Vec::new();
        push_row(&mut lanes, row);
        assert!(lanes.is_empty(), "a row before any header is dropped");
    }

    #[test]
    fn counts_who_needs_you_in_words() {
        assert_eq!(needs_label(0), "");
        assert_eq!(needs_label(1), "1 needs you");
        assert_eq!(needs_label(3), "3 need you");
    }

    #[test]
    fn tones_the_pill_amber_only_while_asks_alone_wait_and_none_is_late() {
        assert_eq!(needs_tone(0, true, false), (Token::Clear, Token::Clear));
        assert_eq!(needs_tone(2, true, false), (Token::Amber, Token::AmberText));
        assert_eq!(needs_tone(2, false, false), (Token::Clay, Token::ClayText));
        assert_eq!(needs_tone(1, true, true), (Token::Clay, Token::ClayText));
    }

    /// Workspaces "a", "b" and "c", with `on` the one Jon is on.
    fn three_on(on: &str) -> Data {
        three_on_all(&[on])
    }

    /// Workspaces "a", "b" and "c", with each of `on` selected, as when
    /// two windows each have one selected.
    fn three_on_all(on: &[&str]) -> Data {
        let ws = |id: &str| Workspace {
            id: id.into(),
            title: Some(format!("Title {id}")),
            selected: Some(on.contains(&id)),
            ..Workspace::default()
        };
        Data {
            workspaces: Some(vec![ws("a"), ws("b"), ws("c")]),
            ..Data::default()
        }
    }

    #[test]
    fn steps_the_count_on_from_the_waiting_session_jon_is_on() {
        let mut core = Model::default();
        let s = &mut core.session;
        let list = ["a".to_string(), "b".to_string(), "c".to_string()];
        let target = |s: &mut Session, on: &str, list: &[String]| {
            needs_target(s, &three_on(on), list).map(|t| (t.ws_id, t.title))
        };
        assert_eq!(
            target(s, "x", &list),
            Some(("a".into(), "Title a".into())),
            "the oldest while Jon is on none of them"
        );
        let mut walk = vec!["a".to_string()];
        for _ in 0..3 {
            let on = walk.last().cloned().unwrap_or_default();
            walk.extend(target(s, &on, &list).map(|t| t.0));
        }
        assert_eq!(
            walk,
            ["a", "b", "c", "a"],
            "each click steps on, then round"
        );
        assert_eq!(target(s, "a", &list[..1]), None, "only the one he is on");
        assert_eq!(
            target(s, "a", &["a".to_string(), "a".to_string()]),
            None,
            "the one he is on, listed twice"
        );
        assert_eq!(target(s, "c", &[]), None, "nothing waiting");
    }

    #[test]
    fn steps_the_count_past_every_selected_waiting_session() {
        let mut core = Model::default();
        let s = &mut core.session;
        let list = ["a".to_string(), "b".to_string(), "c".to_string()];
        let target = |s: &mut Session, on: &[&str], list: &[String]| {
            needs_target(s, &three_on_all(on), list).map(|t| t.ws_id)
        };
        assert_eq!(
            target(s, &["a", "b"], &list),
            Some("c".into()),
            "skips b, selected in another window"
        );
        assert_eq!(
            target(s, &["b", "c"], &list),
            Some("a".into()),
            "round past c to the oldest"
        );
        assert_eq!(
            target(s, &["a", "b"], &list[..2]),
            None,
            "every one waiting is selected"
        );
    }

    /// "a" asks, "b" waits on its turn, "c" works; asks dated as their
    /// agents' waits began.
    fn heading_dot(list: &[&str], ws: &[&str], folded: bool) -> Option<Icon> {
        let saved = SavedState::from_json(
            r#"{"asking": {"a": {"reason": "allow git push?", "epoch": 1000}}}"#,
        )
        .unwrap_or_default();
        let agent = |id: &str, status: AgentStatus| Workspace {
            id: id.into(),
            agents: Some(vec![Some(Agent {
                id: format!("{id}-agent"),
                status: Some(status),
                since_epoch: Some(1000.0),
                ..Agent::default()
            })]),
            ..Workspace::default()
        };
        let data = Data {
            epoch: Some(1100.0),
            workspaces: Some(vec![
                agent("a", AgentStatus::NeedsInput),
                agent("b", AgentStatus::NeedsInput),
                agent("c", AgentStatus::Working),
            ]),
            ..Data::default()
        };
        let mut s = Session::new(Vec::new(), saved);
        let mut view = ViewModel::default();
        view.needs.list = list.iter().map(|id| id.to_string()).collect();
        let under: Vec<&Workspace> = ws.iter().filter_map(|id| data.ws_by_id(id)).collect();
        let lead = folded.then(|| under.last().copied()).flatten();
        header_dot(&mut s, &data, &view, &under, lead)
    }

    #[test]
    fn dots_a_heading_with_a_waiting_card_clay_for_a_turn_amber_for_asks_alone() {
        let dot = |ink| {
            Some(Icon {
                glyph: DOT,
                ink: Some(ink),
                halo: if ink == Token::Amber {
                    Token::AmberHalo
                } else {
                    Token::ClayHalo
                },
            })
        };
        assert_eq!(
            heading_dot(&["a"], &["a", "c"], false),
            dot(Token::Amber),
            "open, every waiting card asks"
        );
        assert_eq!(
            heading_dot(&["b", "a"], &["a", "b", "c"], false),
            dot(Token::Clay),
            "a turn among the asks: clay, as the mock-up's Main lane"
        );
        assert_eq!(
            heading_dot(&["b"], &["b", "c"], true),
            dot(Token::Clay),
            "folded, the needs dot over the lead's own"
        );
        assert_eq!(
            heading_dot(&["b"], &["c"], false),
            None,
            "nothing under it waits"
        );
        assert_eq!(
            heading_dot(&[], &["c"], true).map(|i| i.ink),
            Some(Some(Token::Blue)),
            "folded with nothing waiting: its lead's status dot"
        );
    }

    #[test]
    fn counts_every_waiting_session_and_names_none_to_reveal_when_only_jon_s_waits() {
        let mut core = Model::default();
        let s = &mut core.session;
        let mut view = ViewModel::default();
        view.needs.list = vec!["a".to_string()];
        let alone = needs(s, &three_on("a"), &view);
        assert_eq!((alone.count, alone.target), (1, None));

        view.needs.list = vec!["a".to_string(), "b".to_string()];
        let two = needs(s, &three_on("a"), &view);
        assert_eq!(two.count, 2);
        assert_eq!(two.target.map(|t| t.ws_id), Some("b".to_string()));

        view.needs.list = Vec::new();
        let none = needs(s, &three_on("a"), &view);
        assert_eq!(
            (none.count, none.label.as_str(), none.target),
            (0, "", None)
        );
    }

    #[test]
    fn says_a_waiting_rows_reason_as_its_detail_in_the_waiting_ink() {
        let mut core = Model::default();
        let s = &mut core.session;
        let data = three_on("c");
        let w = data.ws_by_id("a");
        let wt = Some(Waiting::of(false));
        let (detail, ink) = detail_of(s, &data, w, Density::Row, wt);
        assert!(
            detail.contains(": "),
            "the reason with its status: {detail}"
        );
        assert_eq!(ink, Token::ClayText);
        for d in [Density::Full, Density::Compact] {
            assert_eq!(
                detail_of(s, &data, w, d, wt),
                (String::new(), Token::Secondary),
                "{d:?}: the status line says it"
            );
        }
        let (_, ink) = detail_of(s, &data, w, Density::Row, None);
        assert_eq!(ink, Token::Secondary, "a row not waiting");
    }

    #[test]
    fn says_the_agent_count_once_on_a_running_card() {
        let mut core = Model::default();
        let s = &mut core.session;
        s.saved = crate::persist::SavedState::from_json(
            r#"{"subagents": {"W": [{"id": "t1", "session": "a0", "label": "Checks", "startedEpoch": 100}]},
                "background": {"W": [{"id": "t1", "type": "subagent", "status": "running",
                    "description": "Checks", "session": "a0", "startedEpoch": 160, "seenEpoch": 300}]}}"#,
        )
        .unwrap();
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": 400,
            "workspaces": [{"id": "W", "title": "qualify",
                "agents": [{"id": "a0", "status": "idle", "sinceEpoch": 100}]}]}))
        .unwrap();
        let w = data.ws_by_id("W");
        let kind = s.status_kind(&data, w);
        assert_eq!(kind, StatusKind::Running);
        let status = s.status_line(&data, w);
        assert_eq!(status, "Running 4m · 1 agent");
        let full = looks(s, &data, w, Density::Full, &status, &kind);
        assert_eq!(full.helpers, "", "the status line already says it");
        let row = looks(s, &data, w, Density::Row, "4m", &kind);
        assert_eq!(row.helpers, "· 1 helper", "a row's status is its age alone");
        assert_eq!(s.age_of(&data, w), "5m", "the agent went idle 5m ago");
        assert_eq!(
            s.status_age(&data, w),
            "4m",
            "a Running row counts from its work"
        );
    }

    #[test]
    fn keeps_the_helper_words_on_a_running_card_that_counts_shells_alone() {
        let mut core = Model::default();
        let s = &mut core.session;
        s.saved = crate::persist::SavedState::from_json(
            r#"{"subagents": {"W": [{"id": "t1", "session": "a0", "label": "Checks", "startedEpoch": 100}]},
                "background": {"W": [{"id": "b1", "type": "shell", "status": "running",
                    "description": "tests", "session": "a0", "startedEpoch": 160, "seenEpoch": 300}]}}"#,
        )
        .unwrap();
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": 400,
            "workspaces": [{"id": "W", "title": "qualify",
                "agents": [{"id": "a0", "status": "idle", "sinceEpoch": 100}]}]}))
        .unwrap();
        let w = data.ws_by_id("W");
        let kind = s.status_kind(&data, w);
        let status = s.status_line(&data, w);
        assert_eq!(status, "Running 4m · 1 shell");
        let full = looks(s, &data, w, Density::Full, &status, &kind);
        assert_eq!(
            full.helpers, "· 1 helper",
            "the status line counts no agent"
        );
    }

    #[test]
    fn says_asleep_ahead_of_a_rows_detail_and_a_refusal_on_every_shape() {
        let mut core = Model::default();
        let s = &mut core.session;
        s.saved = crate::persist::SavedState::from_json(
            r#"{"asleep": {"a": {"surfaces": ["S1"], "since": 100}}}"#,
        )
        .unwrap();
        let mut data = three_on("c");
        if let Some(a) = data.workspaces.as_mut().and_then(|w| w.first_mut()) {
            a.latest_message = Some("Tests pass".into());
        }
        let w = data.ws_by_id("a");
        assert_eq!(
            detail_of(s, &data, w, Density::Row, None),
            ("Asleep · Tests pass".to_string(), Token::Secondary)
        );
        assert_eq!(
            detail_of(s, &data, w, Density::Full, None).0,
            "Tests pass",
            "a full card's status line says Asleep"
        );
        assert_eq!(s.status_line(&data, w), "Asleep");
        assert_eq!(
            icon_of(&s.status_info(&data, w)),
            Icon {
                glyph: HOLLOW,
                ink: Some(Token::MetaText),
                halo: Token::Clear,
            }
        );

        // Parking the open card is refused, and every shape says why.
        let c = data.ws_by_id("c");
        s.move_to_lane(&data, c, LaneKey::from("parked"));
        for d in [Density::Row, Density::Compact, Density::Full] {
            assert_eq!(
                detail_of(s, &data, c, d, None),
                ("Didn't sleep: it's on screen".to_string(), Token::Secondary),
                "{d:?}"
            );
        }
    }

    #[test]
    fn moves_a_waiting_cards_age_to_its_title_row_and_drops_its_detail() {
        let wt = Some(Waiting::of(false));
        assert!(!status_carries_age(Density::Full, wt, true));
        assert!(!status_carries_age(Density::Compact, wt, true));
        assert!(
            status_carries_age(Density::Row, wt, true),
            "a row's status is its age"
        );
        assert!(status_carries_age(Density::Full, None, true));
        assert_eq!(unless_waiting(wt, "Pushed it.".into()), "");
        assert_eq!(unless_waiting(None, "Pushed it.".into()), "Pushed it.");
    }

    #[test]
    fn gives_a_row_its_prs_number_in_its_tone_and_its_title() {
        let mut core = Model::default();
        let s = &mut core.session;
        s.saved = crate::persist::SavedState::from_json(
            r#"{"prs": {"r": {"number": 171, "url": "u", "status": "open", "branch": "feat",
                "title": "  Row cards show their PR", "mergeable": true,
                "checks": [{"name": "build", "state": "pass"}]},
              "q": {"number": 9, "url": "u", "status": "open", "branch": "feat", "checks": []},
              "d": {"number": 4, "url": "u", "status": "open", "branch": "feat", "draft": true, "checks": []},
              "m": {"number": 3, "url": "u", "status": "merged", "branch": "feat", "checks": []}}}"#,
        )
        .unwrap();
        let ws = |id: &str| Workspace {
            id: id.into(),
            ..Workspace::default()
        };
        let (r, q, none) = (ws("r"), ws("q"), ws("n"));
        let data = Data::default();
        assert_eq!(
            row_pr(s, Some(&r), Density::Row),
            Some(RowPr {
                tag: "#171".into(),
                title: "Row cards show their PR".into(),
                ink: Token::MergeText,
            }),
            "a ready PR's number in the merge green, its title cleaned"
        );
        assert_eq!(
            row_pr(s, Some(&q), Density::Row),
            Some(RowPr {
                tag: "#9".into(),
                title: String::new(),
                ink: Token::OpenText,
            }),
            "a quiet open PR's number in the open green, and no title"
        );
        let ink = |id: &str| row_pr(s, Some(&ws(id)), Density::Row).map(|p| p.ink);
        assert_eq!(ink("d"), Some(Token::MetaText), "a draft's number grey");
        assert_eq!(ink("m"), Some(Token::MergedText), "a merged one's purple");
        assert_eq!(row_pr(s, Some(&none), Density::Row), None, "no PR");
        let compact = compact_pr(s, &data, Some(&q));
        assert_eq!(
            compact[0].pieces[0].ink,
            Token::OpenText,
            "a compact card's quiet open PR words in the open green, as on a chip and a row"
        );
        let draft = compact_pr(s, &data, Some(&ws("d")));
        assert_eq!(draft[0].pieces[0].ink, Token::MetaText, "a draft's grey");
        let compact = compact_pr(s, &data, Some(&r));
        assert_eq!(compact[0].pieces[0].ink, Token::MergeText, "a ready one");
        for d in [Density::Full, Density::Compact] {
            assert_eq!(row_pr(s, Some(&r), d), None, "{d:?}: its chips carry it");
        }
    }

    #[test]
    fn offers_every_project_and_the_home_folder_on_the_add_button_in_all_only() {
        use crate::{Cockpit, Event};
        use crux_core::App;
        let table: Vec<Project> = serde_json::from_str(
            r##"[{"match": "/dev/app", "name": "App", "color": "#D97757", "icon": "star.fill", "root": "/r/app"},
                {"match": "/dev/gone", "name": "Gone", "color": "#000000", "icon": "trash", "root": "/r/gone"},
                {"match": "/dev/notes", "name": "Notes", "color": "blue", "icon": "leaf.fill"}]"##,
        )
        .unwrap();
        // A session in Notes makes it busy, so it lists before App, which
        // is quiet, as the Projects view lists them.
        let data: Data = serde_json::from_value(serde_json::json!({"epoch": 1,
            "workspaces": [{"id": "n", "directory": "/dev/notes"}]}))
        .unwrap();
        let mut core = Model::default();
        let _effects = Cockpit.update(Event::Projects(table), &mut core);
        let _effects = Cockpit.update(Event::Data(data), &mut core);
        let add = Panel::from_core(&mut core).add.unwrap();
        assert!(!add.home, "no home known yet");
        core.session.remove_project("/dev/gone");
        let home = Event::Home {
            home: Some("/Users/jon".into()),
        };
        let _effects = Cockpit.update(home, &mut core);
        let add = Panel::from_core(&mut core).add.unwrap();
        assert_eq!(
            add,
            AddMenu {
                projects: vec![
                    AddProject {
                        key: "/dev/notes".into(),
                        name: "Notes".into(),
                        color: None,
                        icon: "leaf.fill".into(),
                        can_open: false,
                        chosen: false,
                    },
                    AddProject {
                        key: "/dev/app".into(),
                        name: "App".into(),
                        color: Some(0xD9_77_57),
                        icon: "star.fill".into(),
                        can_open: true,
                        chosen: false,
                    },
                ],
                home: true,
                home_chosen: false,
            },
            "busy then quiet, less the removed one; a project with no folder stays, disabled"
        );
        let filter = Panel::from_core(&mut core).filter.unwrap();
        let badges: Vec<_> = filter
            .projects
            .iter()
            .map(|p| (p.name.as_str(), p.color, p.icon.as_str()))
            .collect();
        assert_eq!(
            badges,
            [
                ("Notes", None, "leaf.fill"),
                ("App", Some(0xD9_77_57), "star.fill")
            ],
            "the filter menu has each project's own badge, in the add menu's order"
        );
        let _effects = Cockpit.update(Event::FlipView, &mut core);
        assert_eq!(
            Panel::from_core(&mut core).add,
            None,
            "Projects has its own pluses"
        );
    }

    #[test]
    fn the_add_menu_offers_a_folder_just_set_in_the_editor() {
        use crate::persist::ProjectSpec;
        use crate::{Cockpit, Event};
        use crux_core::App;
        let table: Vec<Project> = serde_json::from_str(
            r##"[{"match": "/dev/notes", "name": "Notes", "color": "blue", "icon": "x"}]"##,
        )
        .unwrap();
        let mut core = Model::default();
        let _effects = Cockpit.update(Event::Projects(table), &mut core);
        let _effects = Cockpit.update(Event::Data(Data::default()), &mut core);
        let can_open = |core: &mut Model| {
            let add = Panel::from_core(core).add.unwrap();
            add.projects.iter().map(|p| p.can_open).collect::<Vec<_>>()
        };
        assert_eq!(can_open(&mut core), [false], "no folder yet");
        let spec = ProjectSpec {
            name: "Notes".into(),
            color: "blue".into(),
            icon: "x".into(),
            root: Some("/r/notes".into()),
        };
        core.session.save_project("/dev/notes", spec);
        assert_eq!(
            can_open(&mut core),
            [true],
            "a pick opens the folder just sent, so the menu offers it before the rebuild"
        );
    }
}
