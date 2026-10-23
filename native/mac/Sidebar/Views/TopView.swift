import SwiftUI

/// The view switch, as the core has it on: two tabs on a ringed track, the
/// chosen one a white face with an edge (docs/design.md#view-switch). Tapping
/// the other view asks the sidebar's core to flip to it. While something
/// waits on Jon, the All tab carries the count on the core's fill (issue
/// #314), whose click goes to the next waiting card.
struct ViewSwitch: View {
    let view: PanelView
    let needs: Needs

    var body: some View {
        HStack(spacing: 0) {
            SwitchSegment(label: Words.all, on: view == .all) {
                if NeedsText.shows(needs) { NeedsCount(needs: needs, view: view) }
            }
            SwitchSegment(label: Words.projects, on: view == .projects) { EmptyView() }
        }
        .padding(Metrics.switchInset)
        .background(Color(Token.countBg), in: .rect(cornerRadius: Metrics.Radius.track))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.Radius.track)
                .strokeBorder(Color(Token.chipEdge), lineWidth: Metrics.hairline)
        }
    }
}

/// One tab of the view switch, with anything it carries after its label.
/// Only the tab not chosen lights under the pointer.
private struct SwitchSegment<Extra: View>: View {
    let label: String
    let on: Bool
    @ViewBuilder let extra: () -> Extra
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Metrics.inlineGap) {
            Text(label)
                .font(.system(size: Metrics.Font.control, weight: .medium))
                .foregroundStyle(Color(on ? Token.text : Token.secondary))
                .lineLimit(1)
            extra()
        }
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

/// The waiting count on the All tab: white on the core's fill, clay, or
/// amber while every waiting card is an agent asking, in the count pill's
/// shape (docs/design.md#needs-count). A click reveals the
/// session the core names, back in All first, and steps on with each
/// click; it does not flip the view itself, so it sits over the tab's
/// own tap.
private struct NeedsCount: View {
    let needs: Needs
    let view: PanelView

    var body: some View {
        Button {
            for action in NeedsText.tap(needs, from: view) { SidebarCore.send(action) }
        } label: {
            Text(NeedsText.count(needs))
                .font(.system(size: Metrics.Font.tiny, weight: .bold).monospaced())
                .foregroundStyle(Color(Palette.Own.onFill))
                .fixedSize()
                .countPillShape(Color(needs.fill))
        }
        .buttonStyle(.plain)
    }
}

/// Next: a white pill with a green edge, "Next: <title>" in the core's
/// ink (Ready's green), cut in the middle so both ends show, and its place
/// in the queue on the right (docs/design.md#next). The panel shows it
/// only while nothing waits (TopText), so it steps to a Ready session; a
/// tap steps to Next's target.
struct NextView: View {
    let next: NextLine
    @State private var hovering = false

    var body: some View {
        let target = NextText.target(next)
        HStack(spacing: Metrics.inlineGap) {
            Text(Words.next + ": " + target.title)
                .font(.system(size: Metrics.Font.next, weight: .semibold))
                .foregroundStyle(Color(NextText.ink(next)))
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
        .padding(.horizontal, Metrics.nextPadH)
        .padding(.vertical, Metrics.nextPadV)
        .background(Color(hovering ? Palette.Own.cardHover : Palette.Own.card), in: .rect(cornerRadius: Metrics.Radius.tab))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.Radius.tab)
                .strokeBorder(Color(Palette.Own.readyEdge), lineWidth: Metrics.hairline)
        }
        .onHover { hovering = $0 }
        .modifier(NextTap(next: next))
    }
}
