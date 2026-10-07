import Foundation

/// Which chips show on a line, each whole: the pane's fit_ranked
/// (native/pane/src/text.rs) in points rather than cells. Every chip when
/// all fit; else the ones that give way (a long branch) go first, then
/// chips drop from the end, and an ellipsis takes the place of the rest.
/// A chip is never cut. The view lets ViewThatFits pick from
/// `candidates`; the test holds the same rule by width (ChipFit.fit).
enum ChipFit {
    /// The lines a card may draw its chips as, widest first, as indices
    /// into `givesWay`: every chip; then, with an ellipsis after, the
    /// chips that do not give way, dropping from the end down to none. A
    /// view draws the first that fits. When no chip gives way, every chip
    /// with an ellipsis could never fit where every chip did not, so that
    /// line is left out.
    static func candidates(givesWay: [Bool]) -> [[Int]] {
        let keep = givesWay.indices.filter { !givesWay[$0] }
        let longest = keep.count == givesWay.count ? keep.count - 1 : keep.count
        guard longest >= 0 else { return [[]] }
        return [Array(givesWay.indices)] + (0...longest).reversed().map { Array(keep.prefix($0)) }
    }

    /// A card's chips as the panel lays them out today: a diff size joins
    /// the PR before it, a space apart, so the two fit or go together and
    /// read as one chip, as before the core sent the diff on its own. The
    /// pane's glued (native/pane/src/views/lanes.rs). A diff after
    /// anything else stays a chip of its own.
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
}
