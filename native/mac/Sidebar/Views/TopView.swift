import AppKit
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

/// The add button: a round "+" after the view switch in All, ringed like
/// the track (docs/design.md#add-button). Its menu, headed "New session
/// in", lists every project with its colour dot, one with no folder
/// disabled and saying so, then "No project (home folder)", disabled while
/// the core knows no home. A pick opens a session there, focused, in the
/// first lane; AddText decides what each item says and sends.
struct AddButton: View {
    let menu: AddMenu

    var body: some View {
        Menu {
            Section(Words.newSessionIn) {
                ForEach(menu.projects, id: \.key) { project in
                    Button {
                        if let action = AddText.pick(project) { SidebarCore.send(action) }
                    } label: {
                        Label {
                            Text(AddText.label(project))
                        } icon: {
                            Image(nsImage: MenuDot.image(project.color))
                        }
                    }
                    .disabled(!project.canOpen)
                }
            }
            Divider()
            Button(Words.noProject) {
                if let action = AddText.pickHome(menu) { SidebarCore.send(action) }
            }
            .disabled(!menu.home)
        } label: {
            Image(systemName: "plus")
                .font(.system(size: Metrics.addGlyph, weight: .semibold))
                .foregroundStyle(Color(Token.secondary))
                .frame(width: Metrics.addButton, height: Metrics.addButton)
                .hoverShade(in: .circle)
                .background(Color(Token.countBg), in: .circle)
                .overlay {
                    Circle().strokeBorder(Color(Token.chipEdge), lineWidth: Metrics.hairline)
                }
                .contentShape(.circle)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(Words.newSession)
        .accessibilityLabel(Words.newSession)
    }
}

/// A project's colour dot for a menu item. A menu draws its items' icons
/// as AppKit images and tints a template one, so the dot is drawn as an
/// image that is not a template, which keeps its colour.
enum MenuDot {
    static func image(_ hex: UInt32?) -> NSImage {
        let color = Color(project: hex)
        let side = Metrics.menuDot
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor(color).setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
        image.isTemplate = false
        return image
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
