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

/// A lane's header: fold mark, marker, name, anchor and unread badge, the
/// count, the folded lane's dot, and the merge line on the right.
struct LaneHeader: View {
    let lane: Lane

    var body: some View {
        HStack(spacing: 5) {
            Text(LaneText.chevron(lane))
                .foregroundStyle(Color(Token.faint))
                .frame(width: 10)
            Text(Words.laneMark).foregroundStyle(Color(lane.marker))
            Text(lane.name)
                .font(.system(size: Metrics.small, weight: .semibold))
                .foregroundStyle(Color(lane.faint ? Token.faint : Token.heading))
                .lineLimit(1)
                .truncationMode(.tail)
            if let anchor = lane.anchor {
                Text(anchor.icon.glyph).foregroundStyle(Color(dot: anchor.icon.ink))
                if !anchor.unread.isEmpty {
                    Text(anchor.unread)
                        .font(.system(size: Metrics.small, weight: .bold))
                        .foregroundStyle(Color(Palette.Own.onBadge))
                        .padding(.horizontal, 4)
                        .background(Color(Palette.Own.badge), in: .capsule)
                }
            }
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

/// A lane: its header, then its rows (none while folded).
struct LaneView: View {
    let lane: Lane

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            LaneHeader(lane: lane)
            ForEach(lane.rows) { RowView(row: $0) }
        }
    }
}
