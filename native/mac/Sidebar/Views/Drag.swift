import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

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

    func lift(_ card: Card, from lane: LaneKey) {
        lifted = card
        from = lane
        over = nil
    }

    func hover(_ lane: LaneKey, before: String?) {
        if over?.lane != lane || over?.before != before { over = (lane, before) }
    }

    func leave(_ lane: LaneKey) {
        if over?.lane == lane { over = nil }
    }

    /// The drag is over without a drop (Escape, or let go outside a lane):
    /// the gap closes and the card is drawn where it was.
    func settle() {
        guard lifted != nil else { return }
        lifted = nil
        from = nil
        over = nil
    }

    /// Lets go of `id` in `lane` above `before`, among the lane's rows as
    /// drawn: sends the move to cockpit-publish and draws the card there
    /// until panel.json shows it.
    func drop(_ id: String, in lane: LaneKey, before: String?, rows: [Row]) {
        defer { settle() }
        guard let card = lifted, card.wsId == id, let from else { return }
        if PendingMove.staysPut(rows, from: from, card: card, lane: lane, before: before) { return }
        let move = PendingMove(card: card, from: from, lane: lane, before: before, until: Date().addingTimeInterval(PendingMove.lasts))
        guard Outbox.send(move.action) else { return }
        pending.removeAll { $0.card.wsId == id }
        pending.append(move)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(PendingMove.lasts))
            self?.lapse()
        }
    }

    /// Drops the moves `lane`, fresh from panel.json, shows done.
    func confirm(_ lane: Lane) {
        if pending.contains(where: { $0.confirmed(by: lane) }) {
            pending.removeAll { $0.confirmed(by: lane) }
        }
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
        state.lifted != nil && info.hasItemsConforming(to: [.plainText])
    }

    func dropEntered(info: DropInfo) {
        if let before = before(info) { state.hover(lane.key, before: before) }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard let before = before(info) else { return DropProposal(operation: .forbidden) }
        state.hover(lane.key, before: before)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        state.leave(lane.key)
    }

    func performDrop(info: DropInfo) -> Bool {
        guard let before = before(info), let card = state.lifted else {
            state.settle()
            return false
        }
        state.drop(card.wsId, in: lane.key, before: before, rows: rows)
        return true
    }

    /// The card the drop goes above, or .some(nil) for the lane's end;
    /// nil when nothing of ours is lifted.
    private func before(_ info: DropInfo) -> String?? {
        guard let card = state.lifted else { return nil }
        if lane.collapsed || rows.isEmpty { return .some(nil) }
        let mids = rows.map { Double(frames[$0.id]?.midY ?? 0) }
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
