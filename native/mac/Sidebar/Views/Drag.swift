import AppKit
import Observation
import os
import SwiftUI
import UniformTypeIdentifiers

/// The drag's timeline for Console or `log stream`: lift, the button
/// coming up, each change of landing slot, the drop and the move drawn,
/// each with the milliseconds since the lift.
enum DragLog {
    static let log = Logger(subsystem: "dev.jonyardley.cockpit.sidebar", category: "drag")
    @MainActor private static var start = Date()

    @MainActor static func lifted() {
        start = Date()
        log.info("lift")
    }

    @MainActor static func note(_ what: String) {
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        log.info("\(what, privacy: .public) +\(ms)ms")
    }
}

/// The drag in flight and the drops waiting for panel.json, shared by
/// every lane: a card leaves one lane's view and lands in another's.
@Observable
@MainActor
final class DragState {
    static let shared = DragState()

    /// The card lifted, drawn as a gap in its slot while the drag lasts.
    private(set) var lifted: Card?
    private(set) var from: LaneKey?
    /// The lane under the drag and the card it would land above (nil for
    /// the end), for the landing line.
    private(set) var over: (lane: LaneKey, before: String?)?
    private(set) var pending: [PendingMove] = []
    /// Watches for the mouse button coming up while a card is lifted.
    @ObservationIgnored private var watch: Task<Void, Never>?
    /// The card the release watch let go of, and when: cmux can hand the
    /// drop over after the watch has given up on it, and the drop still
    /// lands for `late` after that.
    @ObservationIgnored private var released: (card: Card, from: LaneKey, at: Date)?
    private static let late: TimeInterval = 2

    func lift(_ card: Card, from lane: LaneKey) {
        lifted = card
        from = lane
        over = nil
        released = nil
        DragLog.lifted()
        watch?.cancel()
        watch = Task { [weak self] in await self?.settleOnRelease() }
    }

    /// The card a drop carries: the one lifted, else the one the release
    /// watch let go of moments ago.
    var carried: Card? {
        if let lifted { return lifted }
        guard let released, Date().timeIntervalSince(released.at) < Self.late else { return nil }
        return released.card
    }

    /// SwiftUI says nothing when a drag ends without a drop on a lane
    /// (Escape, or let go over another app or a gap), so this settles the
    /// drag once the button has been up for three looks in a row, about
    /// 300 to 450 ms. A drop on a lane usually runs as the button comes up,
    /// but cmux can pass it on later than that, so the card stays
    /// `carried` for a moment after.
    private func settleOnRelease() async {
        var up = 0
        while lifted != nil {
            try? await Task.sleep(for: .milliseconds(150))
            if Task.isCancelled { return }
            up = NSEvent.pressedMouseButtons & 1 == 0 ? up + 1 : 0
            if up == 1 { DragLog.note("button up seen") }
            if up >= 3 {
                if let lifted, let from { released = (lifted, from, Date()) }
                settle("release watch, no drop yet")
                return
            }
        }
    }

    func hover(_ lane: LaneKey, before: String?) {
        if over?.lane != lane || over?.before != before {
            over = (lane, before)
            DragLog.note("over \(lane) before \(before ?? "end")")
        }
    }

    func leave(_ lane: LaneKey) {
        if over?.lane == lane { over = nil }
    }

    /// The drag is over without a drop (Escape, or let go outside a lane):
    /// the gap closes and the card is drawn where it was.
    func settle(_ why: String) {
        watch?.cancel()
        watch = nil
        guard lifted != nil else { return }
        DragLog.note("settled: \(why)")
        lifted = nil
        from = nil
        over = nil
    }

    /// Lets go of `id` in `lane` above `before`, among the lane's rows as
    /// drawn: sends the move to cockpit-publish and draws the card there
    /// until panel.json shows it.
    func drop(_ id: String, in lane: LaneKey, before: String?, rows: [Row]) {
        defer {
            released = nil
            settle("drop")
        }
        guard let card = carried, card.wsId == id, let from = from ?? released?.from else { return }
        if PendingMove.staysPut(rows, from: from, card: card, lane: lane, before: before) { return }
        let move = PendingMove(card: card, from: from, lane: lane, before: before, until: Date().addingTimeInterval(PendingMove.lasts))
        guard Outbox.send(move.action) else { return }
        pending.removeAll { $0.card.wsId == id }
        pending.append(move)
        DragLog.note("move sent to \(lane)")
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(PendingMove.lasts))
            self?.lapse()
        }
    }

    /// Drops the moves a fresh panel.json's `lanes` show done, and draws
    /// the rest with the panel's copy of their cards.
    func reconcile(_ lanes: [Lane]) {
        let next = PendingMove.unconfirmed(pending, lanes: lanes)
        if next != pending { pending = next }
    }

    private func lapse() {
        let live = PendingMove.live(pending, now: Date())
        if live != pending { pending = live }
    }
}

/// What a card's drag carries: its workspace as text. A drop reads the
/// lifted card from DragState, not this, so text dragged in from another
/// app (with nothing lifted) is turned away by validateDrop.
enum DragItem {
    static func provider(_ card: Card) -> NSItemProvider {
        NSItemProvider(object: ("cockpit-card:" + card.wsId) as NSString)
    }
}

/// Where each row of a lane sits in the lane's own space, by row id, with
/// the header under "header".
struct RowFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

extension View {
    /// Reports this view's frame in `space` under `id`.
    func reportsFrame(_ id: String, in space: String) -> some View {
        background(GeometryReader { geo in
            Color.clear.preference(key: RowFrames.self, value: [id: geo.frame(in: .named(space))])
        })
    }

    /// A row of a lane: a movable card lifts, and while lifted its slot is
    /// drawn as a gap the card's size.
    func liftable(_ row: Row, in lane: LaneKey, state: DragState) -> some View {
        modifier(Liftable(row: row, lane: lane, state: state))
    }
}

private struct Liftable: ViewModifier {
    let row: Row
    let lane: LaneKey
    let state: DragState

    func body(content: Content) -> some View {
        if case .card(let card) = row, card.movable {
            let gap = state.lifted?.wsId == card.wsId
            content
                .opacity(gap ? 0 : 1)
                .overlay {
                    if gap {
                        RoundedRectangle(cornerRadius: Metrics.corner)
                            .strokeBorder(Color(Token.cardEdge), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    }
                }
                .onDrag {
                    state.lift(card, from: lane)
                    return DragItem.provider(card)
                }
        } else {
            content
        }
    }
}

/// The line across a lane where the card will land.
struct LandingLine: View {
    var body: some View {
        Capsule().fill(Color(Token.blue)).frame(height: 2)
    }
}

/// A lane as a drop target. The landing slot comes from the drop's height
/// against the middles of the rows drawn; a folded or empty lane takes
/// the card at its end.
struct LaneDrop: DropDelegate {
    let lane: Lane
    let rows: [Row]
    let frames: [String: CGRect]
    let state: DragState

    func validateDrop(info: DropInfo) -> Bool {
        state.carried != nil && info.hasItemsConforming(to: [.plainText])
    }

    func dropEntered(info: DropInfo) {
        if let before = before(info) { state.hover(lane.key, before: before) }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard let before = before(info) else { return DropProposal(operation: .forbidden) }
        state.hover(lane.key, before: before)
        // Copy, to match the provider: a plain string, which the drag
        // source has no way to give up as a move would ask.
        return DropProposal(operation: .copy)
    }

    func dropExited(info: DropInfo) {
        state.leave(lane.key)
    }

    func performDrop(info: DropInfo) -> Bool {
        DragLog.note("performDrop on \(lane.key)")
        guard let before = before(info), let card = state.carried else {
            state.settle("drop refused")
            return false
        }
        state.drop(card.wsId, in: lane.key, before: before, rows: rows)
        return true
    }

    /// The card the drop goes above, or .some(nil) for the lane's end;
    /// nil when nothing of ours is lifted.
    private func before(_ info: DropInfo) -> String?? {
        guard let card = state.carried else { return nil }
        if lane.collapsed || rows.isEmpty { return .some(nil) }
        // A row not laid out yet counts as below the pointer, never above.
        let mids = rows.map { frames[$0.id].map { Double($0.midY) } ?? .infinity }
        let slot = DropRule.slot(y: Double(info.location.y), mids: mids)
        return .some(DropRule.before(rows: rows, dragged: card, slot: slot))
    }
}

/// Where the landing line sits in a lane, from the frames the lane
/// reported: above the row the card goes before, else under the last row,
/// else under the header.
enum LandingSpot {
    static func y(before: String?, rows: [Row], frames: [String: CGRect]) -> CGFloat? {
        if let before, let row = rows.first(where: { DropRule.wsId($0) == before }), let frame = frames[row.id] {
            return frame.minY - 2
        }
        if let last = rows.last, let frame = frames[last.id] { return frame.maxY + 2 }
        return frames[LaneView.header].map { $0.maxY + 2 }
    }
}
