import Foundation

/// Which chips show on a line, each whole: the pane's fit_ranked
/// (native/pane/src/text.rs) in points rather than cells. Every chip when
/// all fit; else the ones that give way (a long branch) go first, then
/// chips drop from the end, and an ellipsis takes the place of the rest.
/// A chip is never cut.
enum ChipFit {
    struct Fit: Equatable {
        /// One per chip: whether it shows.
        let shown: [Bool]
        /// Whether some were left off, so the ellipsis shows.
        let cut: Bool
    }

    /// The width of `widths` on one line, `gap` apart.
    static func width(_ widths: [Double], gap: Double) -> Double {
        widths.reduce(0, +) + gap * Double(max(0, widths.count - 1))
    }

    /// How many of `widths` fit whole in `room`, `gap` apart, leaving room
    /// for an ellipsis of `tail` after them when some are left off.
    static func count(_ widths: [Double], gap: Double, room: Double, tail: Double) -> (Int, Bool) {
        if width(widths, gap: gap) <= room { return (widths.count, false) }
        var used = 0.0
        for (i, w) in widths.enumerated() {
            let lead = i == 0 ? 0 : gap
            if used + lead + w + gap + tail > room { return (i, true) }
            used += lead + w
        }
        return (widths.count, false)
    }

    static func fit(_ widths: [Double], givesWay: [Bool], gap: Double, room: Double, tail: Double) -> Fit {
        let (all, cut) = count(widths, gap: gap, room: room, tail: tail)
        if !cut { return Fit(shown: Array(repeating: true, count: all), cut: false) }
        let keep = widths.indices.filter { !(givesWay.indices.contains($0) && givesWay[$0]) }
        let (n, _) = count(keep.map { widths[$0] } + [tail], gap: gap, room: room, tail: tail)
        var shown = Array(repeating: false, count: widths.count)
        for i in keep.prefix(min(n, keep.count)) { shown[i] = true }
        return Fit(shown: shown, cut: true)
    }
}
