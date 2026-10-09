import Foundation

/// What a card and its neighbours say, decided here so the views only lay
/// it out. The order is the pane's (native/pane/src/views/lanes.rs): the
/// title and status, the chips, where you left off, then the detail.
enum CardText {
    /// A chip's words: its pieces, a space apart.
    static func chip(_ chip: Chip) -> String {
        chip.pieces.map(\.text).joined(separator: " ")
    }

    /// Every run of words a card draws, top to bottom, none empty: a
    /// row's PR title and number after its title, then the title row's
    /// age after the status, where the pane draws them.
    static func runs(_ card: Card) -> [String] {
        var out = [card.title, rowPrTitle(card) ?? "", card.rowPr?.tag ?? "", card.status, titleAge(card)]
        out += ChipFit.glued(card.chips).map(chip)
        out += [card.leftOff, card.detail]
        return out.filter { !$0.isEmpty }
    }

    /// The words a lane row draws.
    static func runs(_ row: Row) -> [String] {
        switch row {
        case .card(let card): runs(card)
        }
    }

    /// The words a Projects row draws, for the rows that are cards; nil
    /// for the rest (headers, the editor, Quiet), which R2.8 draws.
    static func runs(_ row: ProjectRow) -> [String]? {
        switch row {
        case .card(let card): runs(card)
        default: nil
        }
    }

    /// A row's identity in a ForEach: its workspace.
    static func id(_ row: Row) -> String {
        switch row {
        case .card(let card): card.wsId
        }
    }

    /// How many lines the detail may take: at least one.
    static func detailLines(_ card: Card) -> Int {
        max(1, Int(clamping: card.detailLines))
    }
}

/// The Next line's words: where the next press goes and its place, or
/// nothing waiting.
enum NextText {
    static func target(_ next: NextLine) -> (title: String, place: String) {
        switch next {
        case .nothing: (Words.nextNothing, "")
        case .step(_, let title, let place): (title, place)
        }
    }

    static func isNothing(_ next: NextLine) -> Bool {
        targetId(next) == nil
    }

    /// The workspace the next press selects, or nil when nothing waits.
    static func targetId(_ next: NextLine) -> String? {
        if case .step(let wsId, _, _) = next { return wsId }
        return nil
    }
}

/// Needs you as the All tab carries it (issue #314): the waiting count
/// on a clay badge, whose click reveals the next waiting session.
enum NeedsText {
    /// Whether the All tab carries the count: whenever something waits.
    static func shows(_ needs: Needs) -> Bool {
        needs.count > 0
    }

    /// The count on the All tab's badge.
    static func count(_ needs: Needs) -> String {
        String(needs.count)
    }

    /// What a click on the count sends: back to All when Projects is on,
    /// then reveal the session the core names, the oldest waiting or the
    /// one after the waiting session Jon is on. Nothing while it names
    /// none, as on the only waiting session.
    static func tap(_ needs: Needs, from view: PanelView) -> [SidebarAction] {
        guard let target = needs.target else { return [] }
        let back: [SidebarAction] = view == .all ? [] : [.flipView]
        return back + [.reveal(id: target.wsId)]
    }
}

/// Whether the Next line shows: only while nothing waits, as the All
/// tab's count leads to what waits (issue #314), and Next has somewhere
/// to go, a Ready session.
enum TopText {
    static func showsNext(_ panel: Panel) -> Bool {
        !NeedsText.shows(panel.needs) && !NextText.isNothing(panel.next)
    }
}

/// A lane header's marks.
enum LaneText {
    /// The fold mark: none on an empty lane, which has nothing to fold.
    static func chevron(_ lane: Lane) -> String {
        if lane.empty { return "" }
        return lane.collapsed ? Words.folded : Words.open
    }

    /// An empty lane's pill is quiet whatever its tint says.
    static func pill(_ lane: Lane) -> PillColors {
        lane.empty ? PillColors(bg: .countBg, fg: .faint) : lane.pill
    }

    /// The hex config/lanes.json gives a lane of its own, drawn over its
    /// marker token; nil for a lane in a token's colour.
    static func ownColor(_ key: String, in panel: Panel) -> Rgba? {
        panel.laneColors?.first { $0.key == key }?.color
    }
}

/// A lane row's identity is its workspace, so a card keeps its view as its
/// status changes, and a drag can follow it.
extension Row: Identifiable {
    public var id: String { CardText.id(self) }
}

/// The parts of a card the cockpit's card draws round its words (parts.ts
/// statusDot, titleRow), decided here so the views only lay them out.
extension CardText {
    /// The core's filled dot (panel/mod.rs DOT); a hollow one has no halo.
    static let filledDot = "●"
    /// The green pill's word (parts.ts readyPill).
    static let ready = "Ready"

    /// The soft halo round a status dot: working, needs, asking and ready
    /// to merge, the four filled dots in blue, clay, amber and vivid green,
    /// each in its own hue's halo. Everything else, a hollow dot or
    /// finished green, is clear, so
    /// dots with and without one still line up (ui.ts haloDot).
    static func halo(_ icon: Icon) -> Token {
        guard icon.glyph == filledDot else { return .clear }
        switch icon.ink {
        case .blue: return .blueHalo
        case .clay: return .clayHalo
        case .amber: return .amberHalo
        case .mergeGreen: return .mergeHalo
        default: return .clear
        }
    }

    /// A row's PR title as it follows the session's, "· Row cards show
    /// their PR"; nil with no PR or a PR with no title (cards.ts denseRow).
    static func rowPrTitle(_ card: Card) -> String? {
        guard let title = card.rowPr?.title, !title.isEmpty else { return nil }
        return "· " + title
    }

    /// The age at the end of the title row: shown only while the status
    /// line under it has no time of its own, so a card never reads two.
    static func titleAge(_ card: Card) -> String {
        card.statusHasAge ? "" : card.age
    }

    /// The title row age's ink: the waiting ink while the card waits on
    /// Jon, so the age reads with its reason; nil for the usual one.
    static func ageInk(_ card: Card) -> Token? {
        card.waiting?.ink
    }

    /// The dot on the badge of a card waiting on Jon (issue #314), clay
    /// for Your turn and amber for Asking; nil while it waits on nobody.
    static func mark(_ card: Card) -> Token? {
        card.waiting?.mark
    }

    /// Whether the pointer shows the card's x, which dismisses its wait:
    /// only on a card waiting on Jon.
    static func dismissable(_ card: Card) -> Bool {
        card.waiting != nil
    }

    /// The progress bar's fraction, held to 0 to 1; nil draws no bar.
    static func progress(_ card: Card) -> Double? {
        card.progress.map { $0.isFinite ? min(1, max(0, $0)) : 0 }
    }
}

/// What a tap on a chip does: opens its link, sends Jon's action, or
/// nothing, so a tap on it selects the card as its free space does.
enum ChipTap: Equatable {
    case open(URL)
    case send([SidebarAction])
    case none

    /// The core's Make project chip (by_project.rs): "Make "x" a project",
    /// or "Make a project" with no name to offer.
    static func isMakeProject(_ chip: Chip) -> Bool {
        guard let words = chip.pieces.first?.text else { return false }
        return words.hasPrefix("Make ") && words.hasSuffix(" project")
    }

    /// A chip's tap: the PR's page or a port; an action by its words (Make
    /// project). An action it does not know does nothing, rather than
    /// guess at one. A full card's PR stays still (parts.ts prChip
    /// "still", issue #72): a tap on it selects the card, and the card
    /// menu's Open PR opens it.
    static func of(_ chip: Chip, id: String, prOpens: Bool = true) -> ChipTap {
        if chip.isAction {
            if isMakeProject(chip) { return .send(SidebarAction.pick(.newProjectFromFolder, on: id)) }
            return .none
        }
        if chip.kind == .pr && !prOpens { return .none }
        if let link = chip.url, let url = URL(string: link) { return .open(url) }
        return .none
    }
}
