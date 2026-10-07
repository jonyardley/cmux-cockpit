import SwiftUI

/// The view switch, as the core has it on: two tabs on a ringed track, the
/// chosen one a white face with an edge (headers.ts segmented). Tapping
/// the other view asks the sidebar's core to flip to it.
struct ViewSwitch: View {
    let view: PanelView

    var body: some View {
        HStack(spacing: 0) {
            SwitchSegment(label: Words.all, on: view == .all)
            SwitchSegment(label: Words.projects, on: view == .projects)
        }
        .padding(Metrics.switchInset)
        .background(Color(Token.countBg), in: .rect(cornerRadius: Metrics.Radius.track))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.Radius.track)
                .strokeBorder(Color(Token.chipEdge), lineWidth: Metrics.hairline)
        }
    }
}

/// One tab of the view switch. Only the tab not chosen lights under the
/// pointer.
private struct SwitchSegment: View {
    let label: String
    let on: Bool
    @State private var hovering = false

    var body: some View {
        Text(label)
            .font(.system(size: Metrics.Font.control, weight: .medium))
            .foregroundStyle(Color(on ? Token.text : Token.secondary))
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .frame(height: Metrics.switchHeight)
            .background(face, in: .rect(cornerRadius: Metrics.Radius.tab))
            .overlay {
                RoundedRectangle(cornerRadius: Metrics.Radius.tab)
                    .strokeBorder(Color(on ? Token.cardEdge : Token.clear), lineWidth: Metrics.hairline)
            }
            .onHover { hovering = $0 }
            .modifier(SwitchTab(on: on))
    }

    private var face: Color {
        if on { return Color(Palette.Own.card) }
        return hovering ? Color(Palette.Own.hover) : .clear
    }
}

/// Next: a white pill with a clay edge, "Next: <title>" in clay, cut in
/// the middle so both ends show, and its place in the queue on the right
/// (needs.ts nextButton). The panel leaves it out with no next step. A
/// tap steps there.
struct NextView: View {
    let next: NextLine
    @State private var hovering = false

    var body: some View {
        let target = NextText.target(next)
        HStack(spacing: 6) {
            Text(Words.next + ": " + target.title)
                .font(.system(size: Metrics.Font.next, weight: .semibold))
                .foregroundStyle(Color(Token.clayText))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
            Text(target.place)
                .font(.system(size: Metrics.Font.meta).monospaced())
                .foregroundStyle(Color(Token.metaText))
                .lineLimit(1)
                .layoutPriority(2)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(hovering ? Palette.Own.needsHover : Palette.Own.card), in: .rect(cornerRadius: Metrics.Radius.tab))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.Radius.tab)
                .strokeBorder(Color(Palette.Own.needsEdge), lineWidth: Metrics.hairline)
        }
        .onHover { hovering = $0 }
        .modifier(NextTap(next: next))
    }
}

/// The Needs you strip: its count and oldest wait, each waiting session
/// and why, and how many more past the cap. A click on a session switches
/// to it; its cross dismisses its asks.
struct NeedsView: View {
    let needs: Needs

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(Words.needs).fontWeight(.semibold).foregroundStyle(Color(Token.clayText))
                CountPill(count: needs.count, colors: PillColors(bg: .clayCount, fg: .clayText))
                Spacer(minLength: 4)
                Text(needs.wait).foregroundStyle(Color(needs.late ? Token.clayText : Token.metaText))
            }
            ForEach(needs.rows, id: \.wsId) { row in
                HStack(alignment: .top, spacing: 4) {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(row.icon.glyph).foregroundStyle(Color(dot: row.icon.ink))
                            Text(row.title).foregroundStyle(Color(Token.text)).lineLimit(1)
                        }
                        Text(row.line)
                            .foregroundStyle(Color(row.ink))
                            .lineLimit(2)
                            .padding(.leading, Metrics.cardIndent)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(NeedsRowTap(id: row.wsId))
                    DismissCross(id: row.wsId)
                }
            }
            if !needs.more.isEmpty {
                Text(needs.more).foregroundStyle(Color(Token.metaText)).padding(.leading, Metrics.cardIndent)
            }
        }
        .font(.system(size: Metrics.body))
        .padding(8)
        .background(Color(Palette.Own.needsFace), in: .rect(cornerRadius: Metrics.corner))
    }
}
