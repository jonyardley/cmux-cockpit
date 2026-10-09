//! Builds the panel model from the core's session and the frame's data.

use crate::app::{LaneHeaderView, ViewModel};
use crate::by_project::ProjectEntry;
use crate::card_chips::Chip as CoreChip;
use crate::data::{Data, Workspace};
use crate::lane_entries::{LaneEntry, shows_left_off};
use crate::lanes::{self, Density, LaneKey};
use crate::model::card_density;
use crate::moves::MoveSize;
use crate::persist::ViewMode;
use crate::placement::is_foreign_anchor;
use crate::pr_colors::{pr_ink, pr_text_color};
use crate::projects::Project;
use crate::prs::pr_summary;
use crate::session::Session;
use crate::status::{
    DETAIL_MAX, LEFT_OFF_MAX, NEEDS_DETAIL_MAX, StatusKind, StatusStyle, progress_fraction,
    waiting_tokens,
};
use crate::text::whole_words;
use crate::theme::{Token, parse_hex};

use super::{
    Anchor, Badge, Card, Chip, ChipKind, ChipsFor, DIRTY_MARK, DOT, EditorView, HOLLOW, Icon, Lane,
    Needs, NeedsTarget, NextLine, PROJECT_ROW, Panel, PanelView, ProjectHead, ProjectRow,
    QUIET_ROW, Row, RowPr, Waiting, piece,
};

/// Before the left-off prompt (words.rs `YOU_WORD` and its colon).
const LEFT_OFF_LEAD: &str = "You: ";

/// The size chip's ink: the state ink that fits what answering takes.
pub fn size_ink(size: MoveSize) -> Token {
    match size {
        MoveSize::Quick => Token::GreenText,
        MoveSize::Decide => Token::ClayText,
        MoveSize::Review => Token::BlueText,
    }
}

/// A core chip as the panel draws it: the PR's number in the quiet chip's
/// ink and its state in its health's, then its diff size as a chip of its
/// own, faint, as the sidebar sets it beside the PR; the branch with its
/// dirty dot, and the ports, in the quiet chip's ink. The PR and the port
/// carry where a tap opens.
pub fn chip_views(c: &CoreChip) -> Vec<Chip> {
    let quiet = Token::Secondary;
    match c {
        CoreChip::Size { text, size } => {
            vec![Chip::new(
                ChipKind::Size,
                vec![piece(text, size_ink(*size))],
            )]
        }
        CoreChip::Pr {
            tag,
            state,
            health,
            diff,
            url,
        } => {
            let mut pieces = vec![piece(tag, quiet)];
            if !state.is_empty() {
                pieces.push(piece(state, pr_ink(*health)));
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
    w.is_some_and(|w| w.pinned == Some(true))
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
        helpers: session.helper_text(w),
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
    let projects = match shown {
        PanelView::Projects => projects(session, data, view),
        PanelView::All => Vec::new(),
    };
    Panel {
        view: shown,
        next: next_line(data, view),
        needs: needs(session, data, view),
        lanes: lanes(session, data, view),
        projects,
        menu: session.menu_view(data),
        lane_picks: lane_picks(session),
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

/// A card's chips row, for the kind of card it is.
fn chips_row(session: &mut Session, w: Option<&Workspace>, kind: ChipsFor) -> Vec<Chip> {
    let mut out: Vec<Chip> = match kind {
        // A row has no chips row.
        ChipsFor::Row => return Vec::new(),
        ChipsFor::Full | ChipsFor::Project => session
            .chips_for(w, true)
            .iter()
            .flat_map(chip_views)
            .collect(),
        ChipsFor::Compact => compact_pr(session, w),
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
/// the status says Ready to merge), in its health's ink, then its diff
/// size, faint, as a chip of its own. The sidebar runs them on from the
/// status line after a "·"; here they have a line of their own, so they
/// have none.
fn compact_pr(session: &mut Session, w: Option<&Workspace>) -> Vec<Chip> {
    let Some(pr) = pr_summary(&session.saved, w) else {
        return Vec::new();
    };
    let words = piece(
        session.card_pr_words(w, &pr),
        pr_text_color(Some(&pr), Token::Secondary),
    );
    let chip = Chip {
        url: pr.url.clone(),
        ..Chip::new(ChipKind::Pr, vec![words])
    };
    let mut out = vec![chip];
    out.extend(diff_chip(&pr.diff));
    out
}

/// A row's PR: its number in its health's ink (metaText while quiet) and
/// its title. Only a row has one; a card's chips carry its PR.
fn row_pr(session: &Session, w: Option<&Workspace>, density: Density) -> Option<RowPr> {
    if density != Density::Row {
        return None;
    }
    let pr = pr_summary(&session.saved, w)?;
    Some(RowPr {
        ink: pr_text_color(Some(&pr), Token::MetaText),
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

fn next_line(data: &Data, view: &ViewModel) -> NextLine {
    match &view.next.step {
        Some(step) => NextLine::Step {
            ws_id: step.target.clone(),
            title: title_of(data.ws_by_id(&step.target), &step.target),
            place: format!("{} of {}", step.position, step.total),
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

/// A waiting card's mark and status ink, None while it waits on nobody.
/// Whether its agent asks is worked out once, and both come from that.
fn waiting_of(session: &mut Session, view: &ViewModel, w: Option<&Workspace>) -> Option<Waiting> {
    let id = w?.id.as_str();
    if !view.needs.list.iter().any(|n| n == id) {
        return None;
    }
    let (mark, ink) = waiting_tokens(session.ask_of(w).is_some());
    Some(Waiting { mark, ink })
}

/// A waiting card's status line, "Asking: allow git push?", with a detail
/// the core cut taken back to a whole word.
fn needs_line(session: &mut Session, data: &Data, w: Option<&Workspace>) -> String {
    let label = session.status_info(data, w).label;
    let detail = whole_words(&session.needs_detail(w), NEEDS_DETAIL_MAX);
    format!("{label}: {detail}")
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
    match (density, waiting) {
        (Density::Row, Some(wt)) => (needs_line(session, data, w), wt.ink),
        _ => (
            unless_waiting(waiting, whole_words(&session.card_detail(w), DETAIL_MAX)),
            Token::Secondary,
        ),
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

fn card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let kind = session.status_kind(data, w);
    let style = kind.style();
    let density = card_density(&session.lanes, data, w);
    let waiting = waiting_of(session, view, w);
    // A row carries its age alone, as the sidebar's row does, in the
    // waiting ink while it waits (its detail says why); a card says its
    // status with the age, or while it waits on Jon, why.
    let (status, status_ink) = match (density, waiting) {
        (Density::Row, Some(wt)) => (session.age_of(data, w), wt.ink),
        (Density::Row, None) => (session.age_of(data, w), Token::MetaText),
        (_, Some(wt)) => (needs_line(session, data, w), wt.ink),
        (_, None) => (session.status_line(data, w), style.text),
    };
    let left_off = if shows_left_off(&session.lanes, data, w) {
        left_off(&session.left_off_text(w))
    } else {
        String::new()
    };
    let chips = chips_row(session, w, chips_for_density(density));
    let looks = looks(session, data, w, density, &status, &kind);
    let (detail, detail_ink) = detail_of(session, data, w, density, waiting);
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        density,
        badge: looks.badge,
        unread: looks.unread,
        ready: looks.ready,
        pinned: looks.pinned,
        progress: looks.progress,
        helpers: looks.helpers,
        status,
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
    })
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
        pill: status.tint,
        dot,
        collapsed,
        merge_ready: header.map(|h| h.merge_ready.clone()).unwrap_or_default(),
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
    let (status, status_ink) = match waiting {
        Some(wt) => (needs_line(session, data, w), wt.ink),
        None => (session.status_line(data, w), style.text),
    };
    let looks = looks(session, data, w, Density::Full, &status, &kind);
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        density: Density::Full,
        badge: looks.badge,
        unread: looks.unread,
        ready: looks.ready,
        pinned: looks.pinned,
        progress: looks.progress,
        helpers: looks.helpers,
        status,
        status_ink,
        age: looks.age,
        status_has_age: status_carries_age(Density::Full, waiting, looks.status_has_age),
        left_off: String::new(),
        chips: chips_row(session, w, ChipsFor::Project),
        row_pr: None,
        detail: unless_waiting(waiting, whole_words(&wanted, 0)),
        detail_ink: Token::Secondary,
        detail_lines: 2,
        waiting,
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
    use crate::persist::SavedState;
    use crate::ui::Urgency;

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
    fn inks_a_prs_number_quietly_its_state_by_health_and_its_diff_faint_on_its_own() {
        use crate::prs::PrHealth;
        let chips = chip_views(&CoreChip::Pr {
            tag: "#3".into(),
            state: "1 failing".into(),
            health: PrHealth::Failing,
            diff: "+1 \u{2212}2".into(),
            url: Some("https://github.com/o/r/pull/3".into()),
        });
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
        let bare = chip_views(&CoreChip::Pr {
            tag: "#6".into(),
            state: String::new(),
            health: PrHealth::Quiet,
            diff: String::new(),
            url: None,
        });
        assert_eq!(bare.len(), 1, "no diff, no diff chip");
        assert_eq!(bare[0].pieces.len(), 1, "no state, no state words");
        assert_eq!(bare[0].url, None, "a PR with no link opens nothing");
    }

    #[test]
    fn marks_a_dirty_branch_and_inks_a_size_by_what_answering_takes() {
        let br = chip_views(&CoreChip::Branch {
            text: "feat".into(),
            dirty: true,
        });
        let words: Vec<&str> = br[0].pieces.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(words, ["feat", DIRTY_MARK]);
        assert_eq!(br[0].kind, ChipKind::Branch);
        assert!(br[0].gives_way, "the branch goes first on a narrow line");
        assert_eq!(br[0].url, None);
        let size = chip_views(&CoreChip::Size {
            text: "Decide".into(),
            size: MoveSize::Decide,
        });
        assert_eq!(size[0].kind, ChipKind::Size);
        assert_eq!(size[0].pieces[0].ink, Token::ClayText);
        assert_eq!(size_ink(MoveSize::Quick), Token::GreenText);
        assert_eq!(size_ink(MoveSize::Review), Token::BlueText);
        let port = chip_views(&CoreChip::Port {
            text: ":5173 \u{2197}".into(),
            url: "http://localhost:5173".into(),
        });
        assert_eq!(port[0].kind, ChipKind::Port);
        assert_eq!(port[0].pieces[0].ink, Token::Secondary);
        assert_eq!(port[0].url.as_deref(), Some("http://localhost:5173"));
        assert!(!port[0].is_action, "a port opens a page, it does not act");
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
        let wt = Some(Waiting {
            mark: Token::Clay,
            ink: Token::ClayText,
        });
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
    fn moves_a_waiting_cards_age_to_its_title_row_and_drops_its_detail() {
        let wt = Some(Waiting {
            mark: Token::Clay,
            ink: Token::ClayText,
        });
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
    fn gives_a_row_its_prs_number_in_its_health_and_its_title() {
        let mut core = Model::default();
        let s = &mut core.session;
        s.saved = crate::persist::SavedState::from_json(
            r#"{"prs": {"r": {"number": 171, "url": "u", "status": "open", "branch": "feat",
                "title": "  Row cards show their PR", "mergeable": true,
                "checks": [{"name": "build", "state": "pass"}]},
              "q": {"number": 9, "url": "u", "status": "open", "branch": "feat", "checks": []}}}"#,
        )
        .unwrap();
        let ws = |id: &str| Workspace {
            id: id.into(),
            ..Workspace::default()
        };
        let (r, q, none) = (ws("r"), ws("q"), ws("n"));
        assert_eq!(
            row_pr(s, Some(&r), Density::Row),
            Some(RowPr {
                tag: "#171".into(),
                title: "Row cards show their PR".into(),
                ink: Token::GreenDeep,
            }),
            "a ready PR's number in ready's green, its title cleaned"
        );
        assert_eq!(
            row_pr(s, Some(&q), Density::Row),
            Some(RowPr {
                tag: "#9".into(),
                title: String::new(),
                ink: Token::MetaText,
            }),
            "a quiet PR's number in the row's meta ink, and no title"
        );
        assert_eq!(row_pr(s, Some(&none), Density::Row), None, "no PR");
        for d in [Density::Full, Density::Compact] {
            assert_eq!(row_pr(s, Some(&r), d), None, "{d:?}: its chips carry it");
        }
    }
}
