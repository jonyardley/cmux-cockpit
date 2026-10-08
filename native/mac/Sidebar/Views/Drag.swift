import AppKit
import Observation
import os
import SwiftUI
import UniformTypeIdentifiers

/// The drag in flight, shared by every lane: a card leaves one lane's
/// view and lands in another's.
@Observable
@MainActor
final class DragState {
    static let shared = DragState()

    /// The card lifted, drawn as the gap where it will land while the drag
    /// lasts.
    private(set) var lifted: Card?
    private(set) var from: LaneKey?
    /// Where the lifted card sat in its lane's own space as it was lifted:
    /// its height sizes the gap's moves and its middle fixes the hold.
    private(set) var held: CGRect?
    /// The lane under the drag and the card it would land above (nil for
    /// the end), where that lane opens the gap.
    private(set) var over: (lane: LaneKey, before: String?)?
    /// Where the pointer is, down the All view, while it is over a lane:
    /// the floating copy of the lifted card is drawn there. The drag
    /// picture itself is see-through, so nothing of macOS's lingers while
    /// it hands the drop over.
    private(set) var pointer: CGFloat?
    /// How far below the lifted card's middle it was grabbed, so the
    /// floating copy keeps that hold rather than centring on the pointer.
    private(set) var grab: CGFloat?
    /// Watches for the mouse button coming up while a card is lifted.
    @ObservationIgnored private var watch: Task<Void, Never>?
    /// The card the release watch let go of, and when: cmux can hand the
    /// drop over after the watch has given up on it, and the drop still
    /// lands for `late` after that.
    @ObservationIgnored private var released: (card: Card, from: LaneKey, at: Date)?
    private static let late: TimeInterval = 2

    func lift(_ card: Card, from lane: LaneKey, frame: CGRect?) {
        lifted = card
        from = lane
        held = frame
        over = nil
        pointer = nil
        grab = nil
        released = nil
        Timeline.drag.begin("lift")
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
            if up == 1 { Timeline.drag.note("button up seen") }
            if up >= 3 {
                letGo("release watch, no drop yet")
                return
            }
        }
    }

    /// A hover over a lane. Hover fires mid-drag too (a lift was settled
    /// 14ms in, before any drop, so no card could move), so only one with
    /// the button up ends the drag, and it lets go as the release watch
    /// does, so a drop cmux hands over late still lands.
    func hovered() {
        guard lifted != nil || over != nil else { return }
        guard NSEvent.pressedMouseButtons & 1 == 0 else { return }
        letGo("hover after the drag")
    }

    /// The button is up with no drop yet: the card stays `carried` for
    /// `late` in case cmux hands the drop over after this.
    private func letGo(_ why: String) {
        if let lifted, let from { released = (lifted, from, Date()) }
        settle(why)
    }

    func hover(_ lane: LaneKey, before: String?) {
        if over?.lane != lane || over?.before != before {
            over = (lane, before)
            Timeline.drag.note("over \(lane) before \(before ?? "end")")
        }
    }

    /// The pointer is at `y` down the All view; `mid` is the lifted card's
    /// middle there as it was lifted, which fixes the hold once.
    func point(_ y: CGFloat, mid: CGFloat?) {
        if grab == nil, let mid { grab = y - mid }
        if pointer != y { pointer = y }
    }

    /// The pointer left a lane. Lanes meet with no gap between them, so
    /// this is the pointer leaving the lanes altogether, and the floating
    /// copy goes until it is back.
    func leave(_ lane: LaneKey) {
        guard over?.lane == lane else { return }
        over = nil
        pointer = nil
    }

    /// The drag is over without a drop (Escape, or let go outside a lane):
    /// the gap closes and the card is drawn where it was. The lane under
    /// the drag lets go too even with nothing lifted: a late drop hovers
    /// after the release watch has settled, and must not outlive it.
    func settle(_ why: String) {
        watch?.cancel()
        watch = nil
        if over != nil { over = nil }
        if pointer != nil { pointer = nil }
        guard lifted != nil else { return }
        Timeline.drag.note("settled: \(why)")
        lifted = nil
        from = nil
        held = nil
    }

    /// Lets go of `id` in `lane` above `before`, among the lane's rows as
    /// drawn: sends the move to the sidebar's core, whose move hold draws
    /// the card there on the drop.
    func drop(_ id: String, in lane: LaneKey, before: String?, rows: [Row]) {
        defer {
            released = nil
            settle("drop")
        }
        guard let card = carried, card.wsId == id, let from = from ?? released?.from else { return }
        if DropRule.staysPut(rows, from: from, card: card, lane: lane, before: before) { return }
        guard SidebarCore.send(.moveCard(id: id, lane: lane, before: before)) else { return }
        Timeline.drag.note("move sent to \(lane)")
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

    /// A row of a lane: a movable card lifts from where `frame` has it,
    /// and while lifted its row is drawn as a gap the card's size, folded
    /// to nothing when the gap is in another lane.
    func liftable(_ row: Row, in lane: LaneKey, state: DragState, frame: CGRect?, folded: Bool) -> some View {
        modifier(Liftable(row: row, lane: lane, state: state, frame: frame, folded: folded))
    }
}

private struct Liftable: ViewModifier {
    let row: Row
    let lane: LaneKey
    let state: DragState
    let frame: CGRect?
    let folded: Bool

    func body(content: Content) -> some View {
        if case .card(let card) = row, card.movable {
            let gap = state.lifted?.wsId == card.wsId
            let gone = gap && folded
            content
                .opacity(gap ? 0 : 1)
                .overlay {
                    if gap, !gone {
                        RoundedRectangle(cornerRadius: Metrics.corner)
                            .strokeBorder(Color(Token.cardEdge), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    }
                }
                // Folded, not removed: the drag began here, and the row
                // stays in the lane while it lasts. It is see-through, so
                // nothing spills; the pull up cancels the lane's spacing.
                .frame(height: gone ? 0 : nil, alignment: .top)
                .padding(.top, gone ? -Metrics.cardGap : 0)
                .onDrag {
                    state.lift(card, from: lane, frame: frame)
                    return DragItem.provider(card)
                } preview: {
                    // See-through: the floating card (FloatingCard) is drawn
                    // by the panel instead, so macOS has no picture to leave
                    // on screen while it hands the drop over.
                    Color.clear.frame(width: 1, height: 1)
                }
        } else {
            content
        }
    }
}

/// The lifted card, drawn over the lanes at the pointer's height while it
/// is over them, in place of macOS's drag picture. An overlay, so the
/// lanes under it never move.
struct FloatingCard: View {
    /// The lanes' coordinate space, which they measure their tops in.
    nonisolated static let space = "lanes"

    let state: DragState
    /// The lanes as the panel has them, for the card's latest words.
    let lanes: [Lane]

    var body: some View {
        if let lifted = state.lifted, let y = state.pointer {
            let card = Self.fresh(lifted, in: lanes)
            GeometryReader { geo in
                RowView(row: .card(card))
                    .background(Color(Palette.Own.panelGround), in: .rect(cornerRadius: Metrics.corner))
                    .frame(width: geo.size.width)
                    .fixedSize(horizontal: false, vertical: true)
                    .opacity(0.9)
                    .shadow(color: Color(Palette.Own.lift), radius: 6, y: 2)
                    .position(x: geo.size.width / 2, y: y - (state.grab ?? 0))
            }
            .allowsHitTesting(false)
        }
    }

    /// The panel's own copy of the card when it still has it, so a status
    /// that changed mid-drag shows on the copy too.
    private static func fresh(_ card: Card, in lanes: [Lane]) -> Card {
        for lane in lanes {
            for row in lane.rows {
                if case .card(let now) = row, now.wsId == card.wsId { return now }
            }
        }
        return card
    }
}

/// Each lane's top in the lanes' space, by lane key written out (the
/// generated LaneKey is not Sendable, which a preference default must be).
struct LaneTops: PreferenceKey {
    static let defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue()) { $1 }
    }
}

/// A lane as a drop target. The landing place is the gap the lane draws
/// for the lifted card, moved as the floating copy's edges pass the
/// middles of the cards around it (DropRule.place); a folded or empty lane
/// takes the card at its end.
struct LaneDrop: DropDelegate {
    let lane: Lane
    let rows: [Row]
    let frames: [String: CGRect]
    /// The lane's top, down the All view, to place the floating card.
    let top: CGFloat
    let state: DragState

    func validateDrop(info: DropInfo) -> Bool {
        state.carried != nil && info.hasItemsConforming(to: [DragItem.type])
    }

    func dropEntered(info: DropInfo) {
        track(info)
        if let before = before(info) { state.hover(lane.key, before: before) }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        track(info)
        guard let before = before(info) else { return DropProposal(operation: .forbidden) }
        state.hover(lane.key, before: before)
        // Copy, to match the provider: data of our own type, which the
        // drag source has no way to give up as a move would ask.
        return DropProposal(operation: .copy)
    }

    func dropExited(info: DropInfo) {
        state.leave(lane.key)
    }

    func performDrop(info: DropInfo) -> Bool {
        Timeline.drag.note("performDrop on \(lane.key)")
        guard let before = before(info), let card = state.carried else {
            state.settle("drop refused")
            return false
        }
        if state.lifted != nil {
            state.drop(card.wsId, in: lane.key, before: before, rows: rows)
            return true
        }
        // A late drop: the release watch has let go, so this could be a
        // drag from another app during the grace. It lands only if it
        // carries the card let go of.
        guard let provider = info.itemProviders(for: [DragItem.type]).first else {
            Timeline.drag.note("late drop refused: nothing carried")
            state.settle("late drop refused")
            return false
        }
        let (key, rows, state) = (lane.key, rows, state)
        Task { @MainActor in
            guard await DragItem.read(provider) == DragItem.text(card) else {
                Timeline.drag.note("late drop refused: not the card let go of")
                state.settle("late drop refused")
                return
            }
            state.drop(card.wsId, in: key, before: before, rows: rows)
        }
        return true
    }

    /// Moves the floating copy to the pointer, with the lifted card's
    /// middle as it was lifted when this is its own lane.
    private func track(_ info: DropInfo) {
        let mid = state.from == lane.key ? state.held.map { top + $0.midY } : nil
        state.point(top + info.location.y, mid: mid)
    }

    /// The card the drop goes above, or .some(nil) for the lane's end;
    /// nil when nothing of ours is lifted.
    private func before(_ info: DropInfo) -> String?? {
        guard let card = state.carried else { return nil }
        if lane.collapsed || rows.isEmpty { return .some(nil) }
        if state.lifted != nil, let held = state.held {
            return .some(roomy(info, card: card, height: Double(held.height)))
        }
        // A late drop, with no gap drawn: the pointer against the rows'
        // middles. A row not laid out yet counts as below the pointer.
        let mids = rows.map { frames[$0.id].map { Double($0.midY) } ?? .infinity }
        let slot = DropRule.slot(y: Double(info.location.y), mids: mids)
        return .some(DropRule.before(rows: rows, dragged: card, slot: slot))
    }

    /// The card the gap is above, moved for the floating copy's edges in
    /// this lane's space. The gap as drawn comes from the frames, not from
    /// `state.over`, so a frame that lags a move is never read against it.
    private func roomy(_ info: DropInfo, card: Card, height: Double) -> String? {
        let others = rows.filter { !DropRule.isCard($0, card.wsId) }
        // A row not laid out yet counts as below the copy, never above.
        let mids = others.map { frames[$0.id].map { Double($0.midY) } ?? .infinity }
        let tops = others.map { frames[$0.id].map { Double($0.minY) } ?? .infinity }
        let own = frames[Row.card(card).id]
        let current = DropRule.drawnGap(tops: tops, gapTop: own.map { Double($0.minY) }, gapHeight: own.map { Double($0.height) } ?? 0)
        let mid = Double(info.location.y - (state.grab ?? 0))
        let at = DropRule.place(
            current: current, mids: mids, top: mid - height / 2, bottom: mid + height / 2,
            within: DropRule.places(others, dragged: card)
        )
        return DropRule.before(others, at: at)
    }
}
