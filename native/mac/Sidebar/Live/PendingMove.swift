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

    static func isCard(_ row: Row, _ id: String) -> Bool {
        if case .card(let card) = row { return card.wsId == id }
        return false
    }
}

/// A card Jon dropped whose move the next panel.json has not shown yet.
/// Until it does, the lanes draw the card where he let it go, so it does
/// not jump back while cockpit-publish takes the move from the outbox. A
/// move the core turns down (an anchor of another cmux group) or never
/// shows lapses at `until`, and the card goes back to where the panel has
/// it, as the TypeScript sidebar's four second override does.
struct PendingMove: Equatable {
    /// How long a drop is drawn before the panel must show it.
    static let lasts: TimeInterval = 4

    let card: Card
    let from: LaneKey
    let lane: LaneKey
    let before: String?
    let until: Date

    var action: SidebarAction { .moveCard(id: card.wsId, lane: lane, before: before) }

    /// Whether letting go here leaves the card where it already is.
    static func staysPut(_ rows: [Row], from: LaneKey, card: Card, lane: LaneKey, before: String?) -> Bool {
        guard from == lane, let own = rows.firstIndex(where: { DropRule.isCard($0, card.wsId) }) else { return false }
        let next = own + 1 < rows.count ? DropRule.wsId(rows[own + 1]) : nil
        return next == before
    }

    /// The moves `lanes`, the whole of a fresh panel.json, has not shown
    /// done yet, each drawing the panel's own copy of its card when the
    /// panel still has it, so a status that changed since the drag shows.
    static func unconfirmed(_ moves: [PendingMove], lanes: [Lane]) -> [PendingMove] {
        moves.compactMap { move in
            if lanes.contains(where: move.confirmed(by:)) { return nil }
            let fresh = lanes.lazy.flatMap(\.rows).compactMap { row -> Card? in
                if case .card(let card) = row, card.wsId == move.card.wsId { return card }
                return nil
            }.first
            guard let fresh, fresh != move.card else { return move }
            return PendingMove(card: fresh, from: move.from, lane: move.lane, before: move.before, until: move.until)
        }
    }

    /// The moves still drawn at `now`.
    static func live(_ moves: [PendingMove], now: Date) -> [PendingMove] {
        moves.filter { $0.until > now }
    }

    /// The lane as drawn with `moves` applied in order: each moved card
    /// leaves every lane but its new one and goes above its `before` there
    /// (at the end when that row is gone), unless the lane is folded. The
    /// count follows, so a drop on a folded lane shows in its pill.
    static func show(_ lane: Lane, _ moves: [PendingMove]) -> Lane {
        guard !moves.isEmpty else { return lane }
        var shown = lane
        var count = Int(lane.count)
        for move in moves {
            let had = lane.rows.contains { DropRule.isCard($0, move.card.wsId) }
            shown.rows.removeAll { DropRule.isCard($0, move.card.wsId) }
            if lane.key == move.lane {
                if !had { count += 1 }
                if !lane.collapsed {
                    let at = move.before.flatMap { b in shown.rows.firstIndex { DropRule.wsId($0) == b } }
                    shown.rows.insert(.card(move.card), at: at ?? shown.rows.endIndex)
                    shown.empty = false
                }
            } else if had {
                count -= 1
            }
        }
        shown.count = UInt64(max(count, 0))
        return shown
    }

    /// Whether `lane`, as panel.json now has it, shows this move done:
    /// the card sits in its new lane (above `before` when it stayed in
    /// its own lane), or it has left the lane it came from.
    func confirmed(by lane: Lane) -> Bool {
        let own = lane.rows.firstIndex { DropRule.isCard($0, card.wsId) }
        if lane.key == self.lane, let own {
            if from != self.lane { return true }
            let next = own + 1 < lane.rows.count ? DropRule.wsId(lane.rows[own + 1]) : nil
            return next == before
        }
        return lane.key == from && from != self.lane && own == nil
    }
}
