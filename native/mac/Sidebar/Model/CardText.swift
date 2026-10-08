import Foundation

/// What a card and its neighbours say, decided here so the views only lay
/// it out. The order is the pane's (native/pane/src/views/lanes.rs): the
/// title and status, the chips, where you left off, then the detail.
enum CardText {
    /// A chip's words: its pieces, a space apart.
    static func chip(_ chip: Chip) -> String {
        chip.pieces.map(\.text).joined(separator: " ")
    }

    /// Every run of words a card draws, top to bottom, none empty: the
    /// title row's age after the status, where the pane draws it.
    static func runs(_ card: Card) -> [String] {
        var out = [card.title, card.status, titleAge(card)]
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

/// Needs you as the Next pill draws it (issue #281): the count on its
/// fill, the next target's title, then the oldest wait and a down arrow.
enum NeedsText {
    /// Whether Next draws as the pill: whenever something waits, with or
    /// without a next step.
    static func shows(_ needs: Needs) -> Bool {
        needs.count > 0
    }

    /// The title the pill names: the oldest waiting session Jon is not
    /// on, or none while the only one waiting is the one he is on.
    static func title(_ needs: Needs) -> String {
        needs.target?.title ?? ""
    }

    /// What a tap on the pill sends: reveal the session it names, or
    /// nothing when it names none.
    static func tap(_ needs: Needs) -> SidebarAction? {
        needs.target.map { .reveal(id: $0.wsId) }
    }

    /// The count on the pill's badge.
    static func count(_ needs: Needs) -> String {
        String(needs.count)
    }

    /// The pill's right end: the oldest wait, then the arrow down to it.
    static func trail(_ needs: Needs) -> String {
        needs.wait.isEmpty ? Words.down : needs.wait + " " + Words.down
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

    /// The soft halo round a status dot: working, needs and asking, the
    /// three filled dots in blue, clay and amber, each in its own hue's
    /// halo. Everything else, a hollow dot or finished green, is clear, so
    /// dots with and without one still line up (ui.ts haloDot).
    static func halo(_ icon: Icon) -> Token {
        guard icon.glyph == filledDot else { return .clear }
        switch icon.ink {
        case .blue: return .blueHalo
        case .clay: return .clayHalo
        case .amber: return .amberHalo
        default: return .clear
        }
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

    /// The leading edge's colour on a card waiting on Jon, clay for Your
    /// turn and amber for Asking; nil while it waits on nobody.
    static func edge(_ card: Card) -> Token? {
        card.waiting?.edge
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
