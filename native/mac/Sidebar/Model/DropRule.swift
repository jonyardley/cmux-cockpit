import Foundation

/// Where a dropped card lands, by the rule the TypeScript sidebar's
/// src/cockpit/drop.ts uses: cards sort by state inside a lane, and the
/// drag order holds only among cards in the same state, so a drop anchors
/// to the nearest card in the dragged card's own state. A card waiting
/// on Jon stays in its lane (issue #281), so every row is a card.
enum DropRule {
    /// The workspace a row's card stands for.
    static func wsId(_ row: Row) -> String {
        switch row {
        case .card(let card): card.wsId
        }
    }

    static func rank(_ row: Row) -> UInt8 {
        switch row {
        case .card(let card): card.rank
        }
    }

    /// The slot a point at height `y` falls in, among rows whose middles
    /// sit at `mids` from the top: how many middles lie above it.
    static func slot(y: Double, mids: [Double]) -> Int {
        mids.filter { $0 < y }.count
    }

    /// The card the dropped one goes just above in a lane drawn as
    /// `rows`, when let go at `slot` (counted in `rows`, the dragged card's
    /// own row included when it is there); nil puts it at the lane's end.
    /// Just before the first card of its state below the slot, else just
    /// after the last one above it; with none in the lane, before the row
    /// below the slot.
    static func before(rows: [Row], dragged: Card, slot: Int) -> String? {
        let own = rows.firstIndex { isCard($0, dragged.wsId) }
        let others = rows.filter { !isCard($0, dragged.wsId) }
        var at = min(max(slot, 0), rows.count)
        if let own, own < at { at -= 1 }
        let peer = { (row: Row) in rank(row) == dragged.rank }
        if let below = others[at...].first(where: peer) { return wsId(below) }
        if let above = others[..<at].lastIndex(where: peer) {
            let next = above + 1
            return next < others.count ? wsId(others[next]) : nil
        }
        return at < others.count ? wsId(others[at]) : nil
    }

    /// Whether letting go of `card` from `from` in `lane` above `before`
    /// leaves it where it already is among `rows`, so nothing is sent.
    static func staysPut(_ rows: [Row], from: LaneKey, card: Card, lane: LaneKey, before: String?) -> Bool {
        guard from == lane, let own = rows.firstIndex(where: { isCard($0, card.wsId) }) else { return false }
        let next = own + 1 < rows.count ? wsId(rows[own + 1]) : nil
        return next == before
    }

    static func isCard(_ row: Row, _ id: String) -> Bool {
        wsId(row) == id
    }

    // MARK: Make room

    /// How far past a card's middle the lifted card's edge must go before
    /// they swap, so the gap holds still when the pointer rests near one.
    static let slack = 4.0

    /// The places among `others` (a lane's rows without the dragged card,
    /// in state order) the dragged card can land: its own state's run,
    /// from above the first card of that state to under the last. With
    /// none of its state there, the one place its state sorts to. A gap
    /// never opens among cards of another state.
    static func places(_ others: [Row], dragged: Card) -> ClosedRange<Int> {
        let first = others.firstIndex { rank($0) >= dragged.rank } ?? others.count
        let after = others.firstIndex { rank($0) > dragged.rank } ?? others.count
        return first...max(first, after)
    }

    /// Where the gap opens among `others`, whose middles sit at `mids` as
    /// drawn, for a lifted card whose edges are at `top` and `bottom`.
    /// `current` is the gap as drawn, nil when the lane has none yet: then
    /// the card's middle picks the place. Otherwise the gap moves down a
    /// place once the card's bottom edge passes the middle of the card
    /// under the gap, and up once its top edge passes the middle of the
    /// card above, about half a card for one place.
    static func place(current: Int?, mids: [Double], top: Double, bottom: Double, within: ClosedRange<Int>) -> Int {
        let clamp = { (at: Int) in min(max(at, within.lowerBound), within.upperBound) }
        guard let current else { return clamp(slot(y: (top + bottom) / 2, mids: mids)) }
        // One way per look: `mids` are drawn around the current gap, so a
        // card the gap has just moved past is not where it will be.
        let start = clamp(current)
        var at = start
        while at < within.upperBound, at < mids.count, bottom > mids[at] + slack { at += 1 }
        if at != start { return at }
        while at > within.lowerBound, at - 1 < mids.count, mids[at - 1].isFinite, top < mids[at - 1] - slack { at -= 1 }
        return at
    }

    /// The gap as a lane draws it: the place among `others` where the
    /// lifted card's row sits, from the tops of `others` and of that row as
    /// laid out. Nil when the lane has no gap (the row is not there, or is
    /// folded to nothing because the card is over another lane).
    static func drawnGap(tops: [Double], gapTop: Double?, gapHeight: Double) -> Int? {
        guard let gapTop, gapHeight > 0.5 else { return nil }
        return tops.filter { $0 < gapTop }.count
    }

    /// The card the dropped one goes above when let go at place `at` among
    /// `others`; nil for the lane's end.
    static func before(_ others: [Row], at: Int) -> String? {
        at >= 0 && at < others.count ? wsId(others[at]) : nil
    }

    /// The place among `others` a drop above `before` lands at.
    static func place(of before: String?, in others: [Row]) -> Int {
        before.flatMap { id in others.firstIndex { isCard($0, id) } } ?? others.count
    }

    /// Where `lane` opens the gap among its rows other than the lifted
    /// card's: where the drag is over it, else, with the pointer off the
    /// lanes, the slot the card left in its own lane. Nil while nothing is
    /// lifted, the drag is over another lane, or the lane is folded or
    /// empty (its header lights instead).
    static func gap(
        in lane: LaneKey, rows: [Row], collapsed: Bool, lifted: Card?, from: LaneKey?, over: (lane: LaneKey, before: String?)?
    ) -> Int? {
        guard let lifted, !collapsed, !rows.isEmpty else { return nil }
        if let over {
            guard over.lane == lane else { return nil }
            return place(of: over.before, in: rows.filter { !isCard($0, lifted.wsId) })
        }
        guard from == lane else { return nil }
        return rows.firstIndex { isCard($0, lifted.wsId) }
    }

    /// The rows a lane draws while a card is lifted: its own rows with the
    /// lifted card's row moved to the gap at `at` among the others, or
    /// left where it was when the lane has no gap (the view folds it to
    /// nothing then, so the slot it left closes). A card from another
    /// lane joins at the gap. With nothing lifted, the rows as they are.
    static func shown(_ rows: [Row], lifted: Card?, gap at: Int?) -> [Row] {
        guard let lifted, let at else { return rows }
        var others = rows.filter { !isCard($0, lifted.wsId) }
        let own = rows.first { isCard($0, lifted.wsId) } ?? .card(lifted)
        others.insert(own, at: min(max(at, 0), others.count))
        return others
    }
}
