import SwiftUI

extension Color {
    /// A project's own colour from the table, the same light and dark; the
    /// grey of a dot with no colour when it has none.
    init(project hex: UInt32?) {
        if let hex {
            let c = RGBA(hex)
            self.init(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: 1)
        } else {
            self.init(Palette.Own.grey)
        }
    }
}

/// A project's right-click menu, the core's items in its words and order.
struct ProjectMenuItems: View {
    let items: [MenuItem]
    let key: String
    let quiet: Bool

    var body: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            switch item {
            case .divider:
                Divider()
            case .item(let label, let action):
                Button(label) {
                    for a in ProjectMenu.pick(action, key: key, quiet: quiet) { Outbox.send(a) }
                }
            }
        }
    }
}

/// "+" at the right, when the project has a folder: a click opens a new
/// session in it.
struct PlusButton: View {
    let key: String

    var body: some View {
        Button {
            Outbox.send(.openProject(key: key))
        } label: {
            Text(Words.plus).foregroundStyle(Color(Token.faint)).padding(.horizontal, 4)
        }
        .buttonStyle(.plain)
    }
}

/// A busy project's header: fold mark, its mark in its colour, name, the
/// count, the folded project's dot, and "+" when it has a folder.
struct ProjectHeader: View {
    let head: ProjectHead

    var body: some View {
        HStack(spacing: 5) {
            Text(head.collapsed ? Words.folded : Words.open)
                .foregroundStyle(Color(Token.faint))
                .frame(width: 10)
            Text(Words.laneMark).foregroundStyle(Color(project: head.color))
            Text(head.name)
                .font(.system(size: Metrics.small, weight: .semibold))
                .foregroundStyle(Color(Token.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
            CountPill(count: head.count, colors: head.pill)
            if let dot = head.dot {
                Text(dot.glyph).foregroundStyle(Color(dot: dot.ink))
            }
            Spacer(minLength: 4)
            if head.canOpen { PlusButton(key: head.key) }
        }
        .font(.system(size: Metrics.small))
        .contentShape(Rectangle())
        .contextMenu { ProjectMenuItems(items: head.menu, key: head.key, quiet: false) }
    }
}

/// A project with no sessions: its mark and name, dimmed with no folder to
/// open, and "+" with one.
struct QuietRow: View {
    let key: String
    let name: String
    let color: UInt32?
    let canOpen: Bool
    let menu: [MenuItem]

    var body: some View {
        HStack(spacing: 6) {
            Text(Words.laneMark).foregroundStyle(Color(project: color))
            Text(name)
                .foregroundStyle(Color(canOpen ? Token.secondary : Token.faint))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if canOpen { PlusButton(key: key) }
        }
        .font(.system(size: Metrics.body))
        .padding(.leading, 8)
        .contentShape(Rectangle())
        .contextMenu { ProjectMenuItems(items: menu, key: key, quiet: true) }
    }
}

/// One row of the Projects view. The editor is not among them: the
/// sidebar shows it as a sheet (EditorSheet.swift).
struct ProjectRowView: View {
    let row: ProjectRow

    var body: some View {
        switch row {
        case .header(let head):
            ProjectHeader(head: head).padding(.top, 6)
        case .card(let card):
            CardView(card: card)
        case .ghost(_, let title, let text):
            GhostRow(title: title, text: text)
        case .newProject:
            Button {
                Outbox.send(.edit(.openNew))
            } label: {
                Text(Words.newProject)
                    .font(.system(size: Metrics.body))
                    .foregroundStyle(Color(Token.faint))
                    .padding(.leading, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 6)
        case .quietHeader(let count, let collapsed):
            HStack(spacing: 5) {
                Text(collapsed ? Words.folded : Words.open)
                    .foregroundStyle(Color(Token.faint))
                    .frame(width: 10)
                Text(Words.quiet).fontWeight(.semibold).foregroundStyle(Color(Token.faint))
                CountPill(count: count, colors: ProjectText.quietPill)
                Spacer(minLength: 4)
            }
            .font(.system(size: Metrics.small))
            .padding(.top, 6)
        case .quiet(let key, _, let name, let color, let canOpen, let menu):
            QuietRow(key: key, name: name, color: color, canOpen: canOpen, menu: menu)
        case .editor:
            EmptyView()
        }
    }
}

/// The Projects view: Needs you while something waits, then each busy
/// project with its cards, "+ New project", and the quiet projects.
struct ProjectsView: View {
    let panel: Panel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if NeedsText.shows(panel.needs) {
                NeedsView(needs: panel.needs).padding(.bottom, 8)
            }
            ForEach(ProjectText.listed(panel)) { ProjectRowView(row: $0) }
        }
    }
}
