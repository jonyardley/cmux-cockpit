import Foundation

/// Where a dropped card lands, by the rule the TypeScript sidebar's
/// src/cockpit/drop.ts uses: cards sort by state inside a lane, and the
/// drag order holds only among cards in the same state, so a drop anchors
/// to the nearest card in the dragged card's own state. A placeholder
/// (a ghost row) stands for its card, so it anchors a drop as a card does.
enum DropRule {
    /// The workspace a row stands for, card or placeholder.
    static func wsId(_ row: Row) -> String {
        switch row {
        case .card(let card): card.wsId
        case .ghost(let wsId, _, _, _): wsId
        }
    }

    static func rank(_ row: Row) -> UInt8 {
        switch row {
        case .card(let card): card.rank
        case .ghost(_, _, _, let rank): rank
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
        if case .card(let card) = row { return card.wsId == id }
        return false
    }
}
