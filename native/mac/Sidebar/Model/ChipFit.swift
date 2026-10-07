import Foundation

/// How a card's chips read and break. The panel draws them as the cockpit
/// sidebar does (ChipLines below): whole, splitting onto a second line
/// rather than dropping any, where the pane drops chips behind an ellipsis.
enum ChipFit {
    /// A card's chips as the pane reads them, for checking the card's words
    /// against its snapshots: a diff size joins the PR before it, a space
    /// apart, as one chip. The pane's glued (native/pane/src/views/lanes.rs).
    /// A diff after anything else stays a chip of its own. The panel draws
    /// the diff apart, faint and unframed, as the cockpit does.
    static func glued(_ chips: [Chip]) -> [Chip] {
        var out: [Chip] = []
        for chip in chips {
            if chip.kind == .diff, let last = out.indices.last, out[last].kind == .pr {
                out[last].pieces += chip.pieces
            } else {
                out.append(chip)
            }
        }
        return out
    }

    /// The core's mark for a branch with uncommitted changes (panel/mod.rs
    /// DIRTY_MARK), which the view draws as a 5pt dot after the name.
    static let dirtyMark = "●"

    /// A branch chip's words without the dirty mark, and whether it had one.
    static func branch(_ chip: Chip) -> (pieces: [Piece], dirty: Bool) {
        let words = chip.pieces.filter { $0.text != dirtyMark }
        return (words, words.count != chip.pieces.count)
    }
}

/// A card's chips as the cockpit's chips row lays them out (parts.ts
/// chipsRow): the size, the PR and its diff on one line; the branch, the
/// ports and the actions on the next. A view draws both side by side when
/// they fit and the second under the first when they do not, so a narrow
/// card shows both whole.
struct ChipLines: Equatable {
    var pr: [Chip]
    var branch: [Chip]

    init(_ chips: [Chip]) {
        pr = chips.filter(Self.onPrLine)
        branch = chips.filter { !Self.onPrLine($0) }
    }

    private static func onPrLine(_ chip: Chip) -> Bool {
        switch chip.kind {
        case .size, .pr, .diff: true
        case .branch, .port, .action: false
        }
    }

    var isEmpty: Bool { pr.isEmpty && branch.isEmpty }
}
