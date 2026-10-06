import SwiftUI

/// A count in its pill.
struct CountPill: View {
    let count: UInt64
    let colors: PillColors

    var body: some View {
        Text(String(count))
            .font(.system(size: Metrics.small, weight: .semibold).monospacedDigit())
            .foregroundStyle(Color(colors.fg))
            .padding(.horizontal, 6)
            .background(Color(colors.bg), in: .capsule)
    }
}

/// The fold mark on a heading: pointing right while folded, down while
/// open, at the heading's own size and weight so it reads at a glance.
struct FoldMark: View {
    let folded: Bool

    var body: some View {
        Image(systemName: folded ? "chevron.right" : "chevron.down")
            .font(.system(size: Metrics.small, weight: .semibold))
            .foregroundStyle(Color(Token.secondary))
            .frame(width: 12)
    }
}

extension View {
    /// Makes the whole heading row the click that folds it, leaving its
    /// buttons (a project's "+", a lane's anchor badge) their own clicks.
    /// Nil for a heading with nothing to fold, which takes no click at all.
    @ViewBuilder
    func foldsOnClick(_ action: SidebarAction?) -> some View {
        if let action {
            contentShape(.rect).onTapGesture { Outbox.send(action) }
        } else {
            self
        }
    }
}

/// A lane's generated anchor on its header: its dot and unread count, the
/// click that opens it since it has no card, shaded while it is cmux's
/// selected workspace (headers.ts anchorStatus).
struct AnchorBadge: View {
    let anchor: Anchor

    var body: some View {
        Button {
            Outbox.send(.switchTo(id: anchor.id))
        } label: {
            HStack(spacing: 5) {
                Text(anchor.icon.glyph).foregroundStyle(Color(dot: anchor.icon.ink))
                if !anchor.unread.isEmpty {
                    Text(anchor.unread)
                        .font(.system(size: Metrics.small, weight: .bold))
                        .foregroundStyle(Color(Palette.Own.onBadge))
                        .padding(.horizontal, 4)
                        .background(Color(Palette.Own.badge), in: .capsule)
                }
            }
            .padding(.horizontal, 4)
            .background(Color(Token.select).opacity(anchor.selected ? 0.12 : 0), in: .rect(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

/// A lane's header: fold mark, marker, name, anchor and unread badge, the
/// count, the folded lane's dot, and the merge line on the right.
struct LaneHeader: View {
    let lane: Lane

    var body: some View {
        HStack(spacing: 5) {
            if lane.empty {
                Color.clear.frame(width: 12, height: 1)
            } else {
                FoldMark(folded: lane.collapsed)
            }
            Text(Words.laneMark).foregroundStyle(Color(lane.marker))
            Text(lane.name)
                .font(.system(size: Metrics.small, weight: .semibold))
                .foregroundStyle(Color(lane.faint ? Token.faint : Token.heading))
                .lineLimit(1)
                .truncationMode(.tail)
            if let anchor = lane.anchor { AnchorBadge(anchor: anchor) }
            CountPill(count: lane.count, colors: LaneText.pill(lane))
            if let dot = lane.dot {
                Text(dot.glyph).foregroundStyle(Color(dot: dot.ink))
            }
            Spacer(minLength: 4)
            if !lane.mergeReady.isEmpty {
                Text(lane.mergeReady)
                    .foregroundStyle(Color(Token.greenDeep))
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
        .font(.system(size: Metrics.small))
    }
}

/// A lane: its header, then its rows (none while folded). Its cards drag
/// within it and to other lanes, and the whole lane takes a drop
/// (Drag.swift); a drop waiting for panel.json is drawn where it landed.
struct LaneView: View {
    /// The header's key among the lane's frames.
    nonisolated static let header = "header"

    let lane: Lane
    /// The drops waiting for panel.json, already checked against it.
    var moves: [PendingMove] = []
    private let drag = DragState.shared
    @State private var frames: [String: CGRect] = [:]

    var body: some View {
        let shown = PendingMove.show(lane, moves)
        let space = "lane:" + String(describing: lane.key)
        VStack(alignment: .leading, spacing: 4) {
            LaneHeader(lane: shown)
                .foldsOnClick(shown.empty ? nil : .toggleLane(lane.key))
                .reportsFrame(Self.header, in: space)
            ForEach(shown.rows) { row in
                RowView(row: row)
                    .liftable(row, in: lane.key, state: drag)
                    .reportsFrame(row.id, in: space)
            }
        }
        .coordinateSpace(name: space)
        .overlay(alignment: .topLeading) { landing(shown) }
        .onPreferenceChange(RowFrames.self) { next in
            MainActor.assumeIsolated { if next != frames { frames = next } }
        }
        .onDrop(of: [.plainText], delegate: LaneDrop(lane: lane, rows: shown.rows, frames: frames, state: drag))
        // Hover never fires while a drag is in flight, so a hover with a
        // card still lifted means the drag ended without a drop: Escape,
        // or let go outside every lane.
        .onContinuousHover { phase in
            if case .active = phase { drag.settle("hover after the drag") }
        }
    }

    @ViewBuilder
    private func landing(_ shown: Lane) -> some View {
        if let over = drag.over, over.lane == lane.key,
           let y = LandingSpot.y(before: shown.collapsed ? nil : over.before, rows: shown.collapsed ? [] : shown.rows, frames: frames) {
            LandingLine().offset(y: y - 1).allowsHitTesting(false)
        }
    }
}
