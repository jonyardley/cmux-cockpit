import SwiftUI

// What Jon does to the panel by click and right-click (R2.7), kept apart
// from the drag (R2.6). A click on a card switches cmux straight through
// its SDK; everything else goes to the sidebar's own core (SidebarCore), and
// the menus are the core's own, in its words and order.

/// Switches cmux to a workspace by its id. The live sidebar sets it to
/// cmux's SDK (CockpitSidebar.swift); previews and anything without a
/// host send the core's SwitchTo, which it hands cockpit-publish through
/// the outbox.
struct SwitchWorkspace: Sendable {
    let run: @MainActor @Sendable (String) -> Void

    static let core = SwitchWorkspace { id in
        SidebarCore.send(.switchTo(id: id))
    }
}

extension EnvironmentValues {
    @Entry var switchWorkspace: SwitchWorkspace = .core
}

/// The words the panel adds of its own.
enum ActionWords {
    static let messageAgent = "Message agent…"
    static let messagePrompt = "Message for the agent in"
    static let send = "Send"
    static let cancel = "Cancel"
    static let dismiss = "Dismiss"
    static let notSent = "Not sent: the cockpit could not take it. Try again."
}

extension View {
    /// A card's click, right-click menu and "Message agent…" popover.
    func cardActions(_ card: Card) -> some View {
        modifier(CardActions(card: card))
    }
}

/// Click switches to the card's workspace; right-click shows the core's
/// card menu, then "Message agent…".
struct CardActions: ViewModifier {
    let card: Card
    @Environment(\.switchWorkspace) private var switchWorkspace
    @State private var messaging = false

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .onTapGesture { switchWorkspace.run(card.wsId) }
            .contextMenu { CardMenu(card: card, messaging: $messaging) }
            .popover(isPresented: $messaging, arrowEdge: .trailing) {
                MessageAgent(id: card.wsId, title: card.title, shown: $messaging)
            }
    }
}

/// The card's menu: the core's items for this frame, top to bottom, then
/// "Message agent…", which the pane has no key for yet.
struct CardMenu: View {
    let card: Card
    @Binding var messaging: Bool

    var body: some View {
        ForEach(Array(card.menu.enumerated()), id: \.offset) { _, item in
            switch item {
            case .divider: Divider()
            case let .item(label, action):
                Button(label) {
                    // In order, stopping at the first that cannot be
                    // written, so a pick never lands without its card.
                    for sent in SidebarAction.pick(action, on: card.wsId) where !SidebarCore.send(sent) { break }
                }
            }
        }
        Divider()
        Button(ActionWords.messageAgent) { messaging = true }
    }
}

/// A line for Jon's words to the agent in a workspace. Return or Send
/// sends them; blank words send nothing.
struct MessageAgent: View {
    let id: String
    let title: String
    @Binding var shown: Bool
    @State private var text = ""
    @State private var failed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(ActionWords.messagePrompt) \(title)")
                .font(.system(size: Metrics.body, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            TextField(ActionWords.messageAgent, text: $text, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(send)
            if failed {
                Text(ActionWords.notSent)
                    .font(.system(size: Metrics.small))
                    .foregroundStyle(Color(Token.clayText))
            }
            HStack {
                Spacer()
                Button(ActionWords.cancel) { shown = false }
                    .keyboardShortcut(.cancelAction)
                Button(ActionWords.send, action: send)
                    .keyboardShortcut(.defaultAction)
                    .disabled(SidebarAction.message(text, to: id) == nil)
            }
        }
        .padding(12)
        .frame(width: 280)
        .onAppear { focused = true }
    }

    private func send() {
        guard let action = SidebarAction.message(text, to: id) else { return }
        // Kept open with the words in it when the core refuses them.
        failed = !SidebarCore.send(action)
        guard !failed else { return }
        text = ""
        shown = false
    }
}

/// One of a card's action chips (parts.ts actionChip): Make project, a
/// white button with the quiet chip's edge, its words in the ink the core
/// gives them. Its own tap, so a press never also selects the card; under
/// the pointer its face steps darker.
struct ActionChip: View {
    let chip: Chip
    let id: String
    @State private var hovering = false

    private static let padH: CGFloat = 7

    var body: some View {
        Button {
            guard case .send(let actions) = ChipTap.of(chip, id: id) else { return }
            // In order, stopping at the first that cannot be written.
            for action in actions where !SidebarCore.send(action) { break }
        } label: {
            label
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    private var label: some View {
        Text(chip.pieces.map(\.text).joined(separator: " "))
            .font(.system(size: Metrics.Font.meta, weight: .medium))
            .foregroundStyle(Color(chip.pieces.first?.ink ?? .secondary))
            .lineLimit(1)
            .fixedSize()
            .chipFrame(Color(hovering ? Palette.Own.cardHover : Palette.Own.card), padH: Self.padH)
            .contentShape(.rect)
    }
}

/// The view switch's tab: tapping the one that is off flips the view.
struct SwitchTab: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .onTapGesture { if !on { SidebarCore.send(.flipView) } }
    }
}

/// Next: a tap steps to the next workspace in its queue. The core makes
/// the jump and draws its target selected on the tap, remembers it and
/// unfolds whatever hides the card.
struct NextTap: ViewModifier {
    let next: NextLine

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .onTapGesture {
                guard NextText.targetId(next) != nil else { return }
                SidebarCore.send(.next)
            }
    }
}

/// A Needs you row: a click switches to its workspace.
struct NeedsRowTap: ViewModifier {
    let id: String
    @Environment(\.switchWorkspace) private var switchWorkspace

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .onTapGesture { switchWorkspace.run(id) }
    }
}

/// The cross on a Needs you row: takes its asks off the strip.
struct DismissCross: View {
    let id: String

    var body: some View {
        Button {
            SidebarCore.send(.dismiss(id: id))
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: Metrics.small, weight: .semibold))
                .foregroundStyle(Color(Palette.Own.tertiary))
                .frame(width: 16, height: 16)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(ActionWords.dismiss)
    }
}
