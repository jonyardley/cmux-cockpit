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
/// (needs.ts nextButton). While something waits it is the Needs you pill
/// instead (issue #281), next step or not: the count on a filled badge,
/// the core's words for it in their ink (the oldest waiting session Jon
/// is not on, or "needs you · this one" faint on the only one waiting),
/// and the oldest wait with an arrow down to it. A tap on the pill
/// reveals and selects the session it names, and a pill naming none
/// neither lights nor taps; a tap on the plain line steps to Next's
/// target. The panel leaves it out with neither.
struct NextView: View {
    let next: NextLine
    let needs: Needs
    @State private var hovering = false

    var body: some View {
        Group {
            if NeedsText.shows(needs) { waiting } else { plain }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(hovering ? Palette.Own.needsHover : Palette.Own.card), in: .rect(cornerRadius: Metrics.Radius.tab))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.Radius.tab)
                .strokeBorder(Color(Palette.Own.needsEdge), lineWidth: Metrics.hairline)
        }
        .onHover { hovering = $0 && lights }
        .modifier(NextTap(next: next, needs: needs))
    }

    /// Whether the pointer lights the pill: always on the plain line, and
    /// on the waiting one only while it names a session to reveal.
    private var lights: Bool {
        !NeedsText.shows(needs) || NeedsText.live(needs)
    }

    private var plain: some View {
        let target = NextText.target(next)
        return HStack(spacing: 6) {
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
    }

    private var waiting: some View {
        HStack(spacing: 6) {
            Text(NeedsText.count(needs))
                .font(.system(size: Metrics.Font.meta, weight: .bold).monospaced())
                .foregroundStyle(Color(Palette.Own.onFill))
                .fixedSize()
                .padding(.horizontal, Metrics.pillPadH)
                .padding(.vertical, Metrics.pillPadV)
                .background(Color(needs.fill), in: .capsule)
            Text(NeedsText.title(needs))
                .font(.system(size: Metrics.Font.next, weight: .semibold))
                .foregroundStyle(Color(needs.titleInk))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
            Text(NeedsText.trail(needs))
                .font(.system(size: Metrics.Font.meta).monospaced())
                .foregroundStyle(Color(needs.ink))
                .lineLimit(1)
                .fixedSize()
                .layoutPriority(2)
        }
    }
}
