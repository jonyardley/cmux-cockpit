import SwiftUI

extension View {
    /// The one count pill's shape (docs/design.md#count-pill): its padding
    /// and corner on `face`, and the same corner for its tap area. Every
    /// count takes it: a lane's or project's, the unread badge and the
    /// waiting count; their colours follow what they count.
    func countPillShape(_ face: Color) -> some View {
        padding(.horizontal, Metrics.pillPadH)
            .padding(.vertical, Metrics.pillPadV)
            .background(face, in: .rect(cornerRadius: Metrics.Radius.pill))
            .contentShape(.rect(cornerRadius: Metrics.Radius.pill))
    }
}

/// A lane's or project's count in its pill: 11pt medium, in the core's
/// colours (docs/design.md#count-pill).
struct CountPill: View {
    let count: UInt64
    let colors: PillColors

    var body: some View {
        Text(String(count))
            .font(.system(size: Metrics.Font.meta, weight: .medium).monospacedDigit())
            .foregroundStyle(Color(colors.fg))
            .lineLimit(1)
            .countPillShape(Color(colors.bg))
    }
}

/// The fold mark on a heading: one chevron in the second ink, as it is a
/// control, pointing right while folded and turned down while open, in a
/// fixed slot so the names line up (docs/design.md#fold-chevron).
struct FoldMark: View {
    let folded: Bool

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: Metrics.Font.tiny, weight: .semibold))
            .foregroundStyle(Color(Token.secondary))
            .rotationEffect(.degrees(folded ? 0 : 90))
            .frame(width: Metrics.chevronWidth, height: Metrics.chevronHeight)
    }
}

/// A lane's square marker: a rounded square in the lane's colour, its
/// corner by the badge rule (3 at 9).
struct LaneMarker: View {
    let color: Color
    var size: CGFloat = Metrics.laneMarker

    var body: some View {
        RoundedRectangle(cornerRadius: BadgeTile.radius(size))
            .fill(color)
            .frame(width: size, height: size)
    }
}

extension View {
    /// Makes the whole heading row the click that folds it, leaving its
    /// buttons (a project's "+", a lane's anchor badge) their own clicks.
    /// Nil for a heading with nothing to fold, which takes no click at all.
    @ViewBuilder
    func foldsOnClick(_ action: SidebarAction?) -> some View {
        if let action {
            contentShape(.rect).onTapGesture { SidebarCore.send(action) }
        } else {
            self
        }
    }
}

/// A lane's generated anchor on its header: its dot and unread count, the
/// click that opens it since it has no card, outlined in the select ink
/// while it is cmux's selected workspace, as a selected card is
/// (docs/design.md#anchor-badge).
struct AnchorBadge: View {
    let anchor: Anchor
    @State private var hovering = false

    var body: some View {
        Button {
            SidebarCore.send(.switchTo(id: anchor.id))
        } label: {
            HStack(spacing: Metrics.anchorGap) {
                Text(anchor.icon.glyph).foregroundStyle(Color(dot: anchor.icon.ink))
                if !anchor.unread.isEmpty { UnreadBadge(count: anchor.unread) }
            }
            .padding(.horizontal, Metrics.anchorPad)
            .frame(height: Metrics.chevronHeight)
            .background(hovering ? Color(Palette.Own.hover) : .clear, in: .rect(cornerRadius: Metrics.Radius.anchor))
            .overlay {
                if anchor.selected {
                    RoundedRectangle(cornerRadius: Metrics.Radius.anchor)
                        .strokeBorder(Color(Token.select), lineWidth: Metrics.hairline)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// A lane's header: fold chevron, marker, name in tracked capitals, anchor
/// badge, the count, the folded lane's dot, and on the right how many PRs
/// are ready to merge, or "Drop here" while a card is dragged over the lane
/// (docs/design.md#lane-header), both words and ink as the core gives them.
/// An empty lane draws as a drop zone: no chevron, its marker and count
/// faded (in the core's tint, never faint as well), and a lit face and
/// edge while a card is over it. The section gap sits above the
/// face, so the hover and drop shading hug the row.
struct LaneHeader: View {
    let lane: Lane
    /// A card is being dragged over this lane.
    var target = false
    @State private var hovering = false

    var body: some View {
        row
            .padding(.horizontal, Metrics.headerPadH)
            .padding(.vertical, Metrics.headerPadV)
            .background(face, in: .rect(cornerRadius: Metrics.Radius.header))
            .overlay {
                if lane.empty, target {
                    RoundedRectangle(cornerRadius: Metrics.Radius.header)
                        .strokeBorder(Color(Token.heading), lineWidth: Metrics.hairline)
                }
            }
            .onHover { hovering = $0 }
            .padding(.top, Metrics.sectionGap - Metrics.headerPadV)
    }

    private var row: some View {
        HStack(spacing: Metrics.headerSpacing) {
            if lane.empty {
                Color.clear.frame(width: Metrics.chevronWidth, height: Metrics.chevronHeight)
            } else {
                FoldMark(folded: lane.collapsed)
            }
            LaneMarker(color: Color(lane.marker)).opacity(fade)
            Text(lane.name)
                .font(.system(size: Metrics.Font.section, weight: .semibold))
                .textCase(.uppercase)
                .tracking(Metrics.sectionTracking)
                .foregroundStyle(Color(lane.faint ? Token.faint : Token.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            if let anchor = lane.anchor { AnchorBadge(anchor: anchor) }
            CountPill(count: lane.count, colors: lane.pill).opacity(fade)
            if let dot = lane.dot {
                Text(dot.glyph).foregroundStyle(Color(dot: dot.ink))
            }
            Spacer(minLength: Metrics.minGap)
            hint
        }
        .font(.system(size: Metrics.Font.meta))
    }

    /// "Drop here" under a drag, else the merge line; one Text, so an
    /// empty one leaves no gap.
    @ViewBuilder
    private var hint: some View {
        if target {
            Text(lane.dropHint.text)
                .fontWeight(.medium)
                .foregroundStyle(Color(lane.dropHint.ink))
                .lineLimit(1)
        } else if !lane.mergeReady.isEmpty {
            Text(lane.mergeReady)
                .foregroundStyle(Color(lane.mergeInk))
                .lineLimit(1)
                .layoutPriority(-1)
        }
    }

    private var fade: Double { lane.empty ? Metrics.emptyFade : 1 }

    private var face: Color {
        if lane.empty { return target ? Color(Palette.Own.zoneLit) : .clear }
        if target { return Color(Palette.Own.dropTarget) }
        return hovering ? Color(Palette.Own.hover) : .clear
    }
}

/// A lane: its header, then its rows (none while folded). Its cards drag
/// within it and to other lanes, and the whole lane takes a drop
/// (Drag.swift); the core draws a drop where it landed. While a card is
/// dragged over it, its other cards slide apart to open a gap the card's
/// size where it will land.
struct LaneView: View {
    /// The header's key among the lane's frames.
    nonisolated static let header = "header"
    /// How long the cards take to slide apart for the gap, in seconds.
    private static let slide = 0.15

    let lane: Lane
    /// The lane's top in the lanes' space, for the floating card.
    var top: CGFloat = 0
    private let drag = DragState.shared
    @State private var frames: [String: CGRect] = [:]

    var body: some View {
        let space = "lane:" + String(describing: lane.key)
        let room = room
        VStack(alignment: .leading, spacing: Metrics.cardGap) {
            LaneHeader(lane: lane, target: drag.over?.lane == lane.key)
                .foldsOnClick(lane.empty ? nil : .toggleLane(lane.key))
                .reportsFrame(Self.header, in: space)
            ForEach(DropRule.shown(lane.rows, lifted: drag.lifted, gap: room.gap)) { row in
                RowView(row: row)
                    .liftable(row, in: lane.key, state: drag, frame: frames[row.id], folded: room.folded)
                    .reportsFrame(row.id, in: space)
            }
        }
        .animation(.easeOut(duration: Self.slide), value: room)
        .coordinateSpace(name: space)
        .onPreferenceChange(RowFrames.self) { next in
            MainActor.assumeIsolated { if next != frames { frames = next } }
        }
        .contentShape(.rect)
        .background(GeometryReader { geo in
            Color.clear.preference(key: LaneTops.self, value: [String(describing: lane.key): geo.frame(in: .named(FloatingCard.space)).minY])
        })
        .onDrop(of: [DragItem.type], delegate: LaneDrop(lane: lane, rows: lane.rows, frames: frames, top: top, state: drag))
        // Hover fires mid-drag as well as after it, so DragState decides.
        .onContinuousHover { phase in
            if case .active = phase { drag.hovered() }
        }
    }

    /// Where this lane draws the gap, and whether the lifted card's own
    /// row folds away because the gap is in another lane.
    private var room: Room {
        let gap = DropRule.gap(
            in: lane.key, rows: lane.rows, collapsed: lane.collapsed, lifted: drag.held == nil ? nil : drag.lifted, from: drag.from, over: drag.over
        )
        // With no height from the lift there is no gap to move: the lifted
        // row stays in its slot and the drop takes the pointer rule.
        let own = drag.held != nil && (drag.lifted.map { card in lane.rows.contains { DropRule.isCard($0, card.wsId) } } ?? false)
        return Room(gap: gap, folded: own && gap == nil)
    }

    private struct Room: Equatable {
        let gap: Int?
        let folded: Bool
    }
}
