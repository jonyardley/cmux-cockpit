//! Builds the panel model from the core's session and the frame's data.

use crate::app::{LaneHeaderView, ViewModel};
use crate::by_project::ProjectEntry;
use crate::card_chips::Chip as CoreChip;
use crate::data::{Data, Workspace};
use crate::lane_entries::{LaneEntry, shows_left_off};
use crate::lanes::{Density, LANES, LaneKey};
use crate::model::card_density;
use crate::moves::MoveSize;
use crate::persist::ViewMode;
use crate::placement::is_foreign_anchor;
use crate::pr_colors::{pr_ink, pr_text_color};
use crate::prs::pr_summary;
use crate::session::Session;
use crate::status::{DETAIL_MAX, LEFT_OFF_MAX, NEEDS_DETAIL_MAX, StatusStyle};
use crate::text::whole_words;
use crate::theme::{Token, parse_hex};

use super::{
    Anchor, CLOSE, Card, Chip, ChipsFor, DIRTY_MARK, DOT, EditorView, HOLLOW, Icon, Lane, Needs,
    NeedsRow, NextLine, OLDEST_WORD, PARK, PROJECT_ROW, Panel, PanelView, ProjectHead, ProjectRow,
    QUIET_ROW, Row, TO_REVIEW, piece,
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

/// A core chip as the pane draws it: the PR's number in the quiet chip's
/// ink, its state in its health's and its diff size faint; the branch with
/// its dirty dot, and the ports, in the quiet chip's ink.
pub fn chip_view(c: &CoreChip) -> Chip {
    let quiet = Token::Secondary;
    let pieces = match c {
        CoreChip::Size { text, size } => vec![piece(text, size_ink(*size))],
        CoreChip::Pr {
            tag,
            state,
            health,
            diff,
            ..
        } => {
            let mut out = vec![piece(tag, quiet)];
            if !state.is_empty() {
                out.push(piece(state, pr_ink(*health)));
            }
            if !diff.is_empty() {
                out.push(piece(diff, Token::Faint));
            }
            out
        }
        CoreChip::Branch { text, dirty } => {
            let mut out = vec![piece(text, quiet)];
            if *dirty {
                out.push(piece(DIRTY_MARK, quiet));
            }
            out
        }
        CoreChip::Port { text, .. } => vec![piece(text, quiet)],
    };
    Chip {
        pieces,
        gives_way: matches!(c, CoreChip::Branch { .. }),
    }
}

/// The To review action: green while its PR is ready to merge.
pub fn review_chip(green: bool) -> Chip {
    let ink = if green {
        Token::GreenDeep
    } else {
        Token::Secondary
    };
    Chip::of(vec![piece(TO_REVIEW, ink)])
}

/// A merged card's Park, in the second ink, and Close, in the first, so
/// the one that acts reads first (parts.ts mergedChips). Keep lives in
/// the card menu.
fn merged_chips(session: &mut Session, data: &Data, w: Option<&Workspace>) -> Vec<Chip> {
    let mut out = Vec::new();
    if session.offers_park(data, w) {
        out.push(Chip::of(vec![piece(PARK, Token::Secondary)]));
    }
    if session.offers_close(data, w) {
        out.push(Chip::of(vec![piece(CLOSE, Token::Text)]));
    }
    out
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
    }
}

/// A card's chips row, for the kind of card it is.
fn chips_row(
    session: &mut Session,
    data: &Data,
    w: Option<&Workspace>,
    kind: ChipsFor,
) -> Vec<Chip> {
    let mut out: Vec<Chip> = match kind {
        // A row has no chips row; its Park and Close are in `merged`.
        ChipsFor::Row => return Vec::new(),
        // card_chips, so a merged card drops its clean branch as the sidebar does.
        ChipsFor::Full | ChipsFor::Project => session
            .card_chips(data, w, true)
            .iter()
            .map(chip_view)
            .collect(),
        ChipsFor::Compact => compact_pr(session, w).into_iter().collect(),
    };
    if session.can_file_for_review(data, w) {
        out.push(review_chip(session.review_is_green(w)));
    }
    // Only once the shell has said where home is: until then the home
    // folder itself would be offered as a project.
    if kind == ChipsFor::Project && session.home.is_some() && session.can_create_project(w) {
        out.push(Chip::of(vec![piece(
            session.make_project_label(w),
            Token::Secondary,
        )]));
    }
    out
}

/// A compact card's PR in words, "#45 · ready", in its health's ink,
/// then its diff size, faint. The sidebar runs it on from the status
/// line after a "·"; here it has a line of its own, so it has none.
fn compact_pr(session: &Session, w: Option<&Workspace>) -> Option<Chip> {
    let pr = pr_summary(&session.saved, w)?;
    let mut pieces = vec![piece(
        pr.text.clone(),
        pr_text_color(Some(&pr), Token::Secondary),
    )];
    if !pr.diff.is_empty() {
        pieces.push(piece(pr.diff.clone(), Token::Faint));
    }
    Some(Chip::of(pieces))
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
                lane: w.map(|w| session.lane_of(data, w)),
                movable: !is_foreign_anchor(session, data, id),
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
    let chips = chips_row(session, data, w, chips_for_density(density));
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status,
        status_ink,
        left_off,
        chips,
        merged: merged_chips(session, data, w),
        detail: whole_words(&session.card_detail(w), DETAIL_MAX),
        detail_lines: detail_lines(density),
        waiting: view.needs.list.iter().any(|w| w == id),
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
                    rank: session.state_rank(data, w),
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
        id: id.to_string(),
        selected: session.is_selected(data, w),
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

/// A card in the Projects view, as the sidebar's project card: its title
/// and status, what a waiting chat wants, and its chips with the branch.
fn project_card(session: &mut Session, data: &Data, view: &ViewModel, id: &str) -> Card {
    let w = data.ws_by_id(id);
    let style = session.status_info(data, w);
    let wanted = session.move_of(w).map(|m| m.text).unwrap_or_default();
    Card {
        ws_id: id.to_string(),
        icon: icon_of(&style),
        title: title_of(w, id),
        status: session.status_line(data, w),
        status_ink: style.text,
        left_off: String::new(),
        chips: chips_row(session, data, w, ChipsFor::Project),
        merged: merged_chips(session, data, w),
        detail: whole_words(&wanted, 0),
        detail_lines: 2,
        waiting: view.needs.list.iter().any(|w| w == id),
        rank: session.state_rank(data, w),
        movable: !is_foreign_anchor(session, data, id),
        dimmed: is_dimmed(session, data, w),
        selected: session.is_selected(data, w),
        menu: session.card_menu(data, w),
    }
}

/// A project's header: its look from the table, and the cards it counts.
fn project_head(session: &mut Session, data: &Data, k: &str) -> ProjectHead {
    let p = session.project_by_key(k);
    let collapsed = session.is_project_collapsed(k);
    let ws = session.project_workspaces(data, k);
    let status = session.header_status(data, &ws, collapsed);
    let dot = status
        .dot
        .map(|w| icon_of(&session.status_info(data, Some(w))));
    ProjectHead {
        key: k.to_string(),
        id: format!("{PROJECT_ROW}{k}"),
        name: p.name.clone(),
        color: parse_hex(&p.color),
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
                ProjectRow::Header(project_head(session, data, project))
            }
            ProjectEntry::Ws { ws_id, .. } => {
                ProjectRow::Card(project_card(session, data, view, ws_id))
            }
            ProjectEntry::Ghost { ws_id, .. } => {
                let w = data.ws_by_id(ws_id);
                ProjectRow::Ghost {
                    ws_id: ws_id.clone(),
                    title: title_of(w, ws_id),
                    text: session.placeholder_text(w),
                }
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
        assert_eq!(Panel::from_core(&mut core), Panel::default());
    }

    #[test]
    fn inks_a_prs_number_quietly_its_state_by_health_and_its_diff_faint() {
        use crate::prs::PrHealth;
        let c = chip_view(&CoreChip::Pr {
            tag: "#3".into(),
            state: "1 failing".into(),
            health: PrHealth::Failing,
            diff: "+1 \u{2212}2".into(),
            url: None,
        });
        let inks: Vec<(&str, Token)> = c.pieces.iter().map(|p| (p.text.as_str(), p.ink)).collect();
        assert_eq!(
            inks,
            [
                ("#3", Token::Secondary),
                ("1 failing", Token::RedText),
                ("+1 \u{2212}2", Token::Faint)
            ]
        );
        let bare = chip_view(&CoreChip::Pr {
            tag: "#6".into(),
            state: String::new(),
            health: PrHealth::Quiet,
            diff: String::new(),
            url: None,
        });
        assert_eq!(bare.pieces.len(), 1, "no state, no diff");
    }

    #[test]
    fn marks_a_dirty_branch_and_inks_a_size_by_what_answering_takes() {
        let br = chip_view(&CoreChip::Branch {
            text: "feat".into(),
            dirty: true,
        });
        let words: Vec<&str> = br.pieces.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(words, ["feat", DIRTY_MARK]);
        assert!(br.gives_way, "the branch goes first on a narrow line");
        let size = chip_view(&CoreChip::Size {
            text: "Decide".into(),
            size: MoveSize::Decide,
        });
        assert_eq!(size.pieces[0].ink, Token::ClayText);
        assert_eq!(size_ink(MoveSize::Quick), Token::GreenText);
        assert_eq!(size_ink(MoveSize::Review), Token::BlueText);
        let port = chip_view(&CoreChip::Port {
            text: ":5173 \u{2197}".into(),
            url: "http://localhost:5173".into(),
        });
        assert_eq!(port.pieces[0].ink, Token::Secondary);
    }

    #[test]
    fn greens_to_review_only_while_its_pr_is_ready() {
        assert_eq!(review_chip(true).pieces[0].ink, Token::GreenDeep);
        assert_eq!(review_chip(false).pieces[0].ink, Token::Secondary);
        assert_eq!(review_chip(false).pieces[0].text, TO_REVIEW);
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
        let mut lanes = Vec::new();
        let row = Row::Ghost {
            ws_id: "a".into(),
            title: "a".into(),
            text: "your turn".into(),
            rank: 0,
        };
        push_row(&mut lanes, row);
        assert!(lanes.is_empty(), "a row before any header is dropped");
    }
}
