import SwiftUI

// What Jon does to the panel by click and right-click (R2.7), kept apart
// from the drag (R2.6). A click on a card switches cmux straight through
// its SDK; everything else goes to cockpit-publish through the outbox, and
// the menus are the core's own, in its words and order.

/// Switches cmux to a workspace by its id. The live sidebar sets it to
/// cmux's SDK (CockpitSidebar.swift); previews and anything without a
/// host send the core's SwitchTo through the outbox instead.
struct SwitchWorkspace: Sendable {
    let run: @MainActor @Sendable (String) -> Void

    static let outbox = SwitchWorkspace { _ = Outbox.send(.switchTo(id: $0)) }
}

extension EnvironmentValues {
    @Entry var switchWorkspace: SwitchWorkspace = .outbox
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
                    for sent in SidebarAction.pick(action, on: card.wsId) where !Outbox.send(sent) { break }
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
        // Kept open with the words in it when the outbox cannot take them.
        failed = !Outbox.send(action)
        guard !failed else { return }
        text = ""
        shown = false
    }
}

/// A card's chips, then Park and Close as buttons: on the same line while
/// every chip fits whole, else on a line of their own, so neither is ever
/// cut.
struct ActionChips: View {
    let id: String
    let chips: [Chip]
    let merged: [Chip]

    var body: some View {
        if merged.isEmpty {
            ChipsLine(chips: chips)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.chipGap) {
                    ForEach(Array(chips.enumerated()), id: \.offset) { ChipView(chip: $0.element) }
                    mergedButtons
                }
                .fixedSize()
                VStack(alignment: .leading, spacing: 3) {
                    if !chips.isEmpty { ChipsLine(chips: chips) }
                    HStack(spacing: Metrics.chipGap) { mergedButtons }.fixedSize()
                }
            }
        }
    }

    private var mergedButtons: some View {
        ForEach(Array(merged.enumerated()), id: \.offset) { _, chip in
            Button {
                if let action = SidebarAction.merged(chip, id: id) { Outbox.send(action) }
            } label: {
                ChipView(chip: chip)
            }
            .buttonStyle(.plain)
        }
    }
}

/// The view switch's tab: tapping the one that is off flips the view.
struct SwitchTab: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .onTapGesture { if !on { Outbox.send(.flipView) } }
    }
}

/// Next: a tap steps to the next workspace in its queue.
struct NextTap: ViewModifier {
    let next: NextLine

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .onTapGesture { if !NextText.isNothing(next) { Outbox.send(.next) } }
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
            Outbox.send(.dismiss(id: id))
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
