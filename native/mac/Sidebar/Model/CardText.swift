import Foundation

/// What a card and its neighbours say, decided here so the views only lay
/// it out. The order is the pane's (native/pane/src/views/lanes.rs): the
/// title and status, the chips with Park and Close after them, where you
/// left off, then the detail.
enum CardText {
    /// A chip's words: its pieces, a space apart.
    static func chip(_ chip: Chip) -> String {
        chip.pieces.map(\.text).joined(separator: " ")
    }

    /// Every run of words a card draws, top to bottom, none empty.
    static func runs(_ card: Card) -> [String] {
        var out = [card.title, card.status]
        out += ChipFit.glued(card.chips).map(chip)
        out += card.merged.map(chip)
        out += [card.leftOff, card.detail]
        return out.filter { !$0.isEmpty }
    }

    /// A placeholder's one line: its title and why its card went.
    static func ghost(title: String, text: String) -> String {
        "\(title) \(Words.ghostGap) \(text)"
    }

    /// The words a lane row draws, whatever its kind.
    static func runs(_ row: Row) -> [String] {
        switch row {
        case .card(let card): runs(card)
        case .ghost(_, let title, let text, _): [ghost(title: title, text: text)]
        }
    }

    /// The words a Projects row draws, for the rows that are cards; nil
    /// for the rest (headers, the editor, Quiet), which R2.8 draws.
    static func runs(_ row: ProjectRow) -> [String]? {
        switch row {
        case .card(let card): runs(card)
        case .ghost(_, let title, let text): [ghost(title: title, text: text)]
        default: nil
        }
    }

    /// A row's identity in a ForEach: its workspace.
    static func id(_ row: Row) -> String {
        switch row {
        case .card(let card): card.wsId
        case .ghost(let wsId, _, _, _): "ghost:" + wsId
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

/// The Needs you strip's words.
enum NeedsText {
    /// Whether the strip shows at all: only while something waits.
    static func shows(_ needs: Needs) -> Bool {
        needs.count > 0
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
