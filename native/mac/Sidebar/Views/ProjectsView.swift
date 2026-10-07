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
                    for a in ProjectMenu.pick(action, key: key, quiet: quiet) { SidebarCore.send(a) }
                }
            }
        }
    }
}

/// The Projects view's sizes, the cockpit's (src/cockpit/views/headers.ts).
enum ProjectMetrics {
    /// A busy project's badge on its header, and its glyph.
    static let headerBadge: CGFloat = 18
    static let headerBadgeFont: CGFloat = 10
    /// A quiet project's badge, and its glyph; "+ New project"'s plus sits
    /// in the same slot.
    static let quietBadge: CGFloat = 16
    static let quietBadgeFont: CGFloat = 9
    /// The header's "+": a round button and its glyph.
    static let plusButton: CGFloat = 20
    static let plusFont: CGFloat = 11
    /// A quiet row's "+" and "+ New project"'s plus.
    static let rowPlusFont: CGFloat = 10
    /// A quiet or "+ New project" row: its padding and corner.
    static let rowPadV: CGFloat = 3
    static let rowRadius: CGFloat = 7
    /// The Quiet heading's padding, and the gap above it and above
    /// "+ New project".
    static let quietPadV: CGFloat = 4
    static let quietGap: CGFloat = 10
    static let newGap: CGFloat = 6
}

extension View {
    /// The row's hover shade in its shape, as headers.ts hoverBackground
    /// draws it; off when the row takes no click.
    func hoverShade(in shape: some Shape, enabled: Bool = true) -> some View {
        modifier(HoverShade(shape: shape, enabled: enabled))
    }
}

private struct HoverShade<S: Shape>: ViewModifier {
    let shape: S
    let enabled: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(enabled && hovering ? Color(Palette.Own.hover) : .clear, in: shape)
            .onHover { hovering = $0 }
    }
}

/// "+" at the right of a busy project's header, when it has a folder: a
/// round button shaded on hover, whose click opens a new session in it
/// (parts.ts glyphButton).
struct PlusButton: View {
    let key: String

    var body: some View {
        Button {
            SidebarCore.send(.openProject(key: key))
        } label: {
            Image(systemName: "plus")
                .font(.system(size: ProjectMetrics.plusFont, weight: .semibold))
                .foregroundStyle(Color(Token.secondary))
                .frame(width: ProjectMetrics.plusButton, height: ProjectMetrics.plusButton)
                .hoverShade(in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
    }
}

/// A busy project's header: fold chevron, its badge, name, the count, the
/// folded project's dot, and "+" when it has a folder (headers.ts
/// projectHeader). The section gap sits above the face, so the hover shade
/// hugs the row, but inside the fold click, so a click in the gap folds it
/// as headers.ts headerGap does.
struct ProjectHeader: View {
    let head: ProjectHead

    var body: some View {
        HStack(spacing: Metrics.headerSpacing) {
            FoldMark(folded: head.collapsed)
            BadgeTile(icon: head.icon, color: head.color, size: ProjectMetrics.headerBadge, font: ProjectMetrics.headerBadgeFont)
            Text(head.name)
                .font(.system(size: Metrics.Font.title, weight: .semibold))
                .foregroundStyle(Color(Token.heading))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            CountPill(count: head.count, colors: head.pill)
            if let dot = head.dot {
                Text(dot.glyph).foregroundStyle(Color(dot: dot.ink))
            }
            Spacer(minLength: 4)
            if head.canOpen { PlusButton(key: head.key) }
        }
        .font(.system(size: Metrics.small))
        .padding(.horizontal, Metrics.headerPadH)
        .padding(.vertical, Metrics.headerPadV)
        .hoverShade(in: .rect(cornerRadius: Metrics.Radius.header))
        .padding(.top, Metrics.sectionGap - Metrics.headerPadV)
        .foldsOnClick(.toggleProject(key: head.key))
        .contextMenu { ProjectMenuItems(items: head.menu, key: head.key, quiet: false) }
    }
}

/// The Quiet heading: fold chevron, QUIET in faint tracked capitals and
/// the count, the whole row the click that folds it (headers.ts
/// quietHeader).
struct QuietHeader: View {
    let count: UInt64
    let collapsed: Bool

    var body: some View {
        HStack(spacing: Metrics.headerSpacing) {
            FoldMark(folded: collapsed)
            Text(Words.quiet)
                .font(.system(size: Metrics.Font.section, weight: .semibold))
                .textCase(.uppercase)
                .tracking(Metrics.sectionTracking)
                .foregroundStyle(Color(Token.faint))
                .lineLimit(1)
            CountPill(count: count, colors: ProjectText.quietPill)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.headerPadH)
        .padding(.vertical, ProjectMetrics.quietPadV)
        .hoverShade(in: .rect(cornerRadius: Metrics.Radius.header))
        .foldsOnClick(.toggleQuiet)
        .padding(.top, ProjectMetrics.quietGap)
    }
}

/// A project with no sessions: its badge and name, and a faint "+" with a
/// folder, when the whole row is a button that opens a session in it, so
/// the keyboard and VoiceOver reach it too. With no folder it takes no
/// click and fades, so it does not read as a button (headers.ts quietRow).
struct QuietRow: View {
    let key: String
    let name: String
    let color: UInt32?
    let icon: String
    let canOpen: Bool
    let menu: [MenuItem]

    var body: some View {
        Group {
            if canOpen {
                Button {
                    SidebarCore.send(.openProject(key: key))
                } label: {
                    face
                }
                .buttonStyle(.plain)
            } else {
                face
            }
        }
        .contextMenu { ProjectMenuItems(items: menu, key: key, quiet: true) }
    }

    private var face: some View {
        HStack(spacing: Metrics.headerSpacing) {
            BadgeTile(icon: icon, color: color, size: ProjectMetrics.quietBadge, font: ProjectMetrics.quietBadgeFont)
            Text(name)
                .font(.system(size: Metrics.Font.title))
                .foregroundStyle(Color(Token.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            Spacer(minLength: 4)
            if canOpen {
                Image(systemName: "plus")
                    .font(.system(size: ProjectMetrics.rowPlusFont, weight: .semibold))
                    .foregroundStyle(Color(Token.faint))
            }
        }
        .padding(.horizontal, Metrics.headerPadH)
        .padding(.vertical, ProjectMetrics.rowPadV)
        .hoverShade(in: .rect(cornerRadius: ProjectMetrics.rowRadius), enabled: canOpen)
        .opacity(ProjectText.quietOpacity(canOpen: canOpen))
        .contentShape(.rect)
    }
}

/// "+ New project" at the foot of the busy projects: a plus in the badge's
/// slot and the label, styled as a quiet row so it reads as part of the
/// list; a click opens the editor (headers.ts newProjectRow).
struct NewProjectRow: View {

    var body: some View {
        Button {
            SidebarCore.send(.edit(.openNew))
        } label: {
            HStack(spacing: Metrics.headerSpacing) {
                Image(systemName: "plus")
                    .font(.system(size: ProjectMetrics.rowPlusFont, weight: .semibold))
                    .foregroundStyle(Color(Token.secondary))
                    .frame(width: ProjectMetrics.quietBadge, height: ProjectMetrics.quietBadge)
                Text(ProjectText.newProjectLabel)
                    .font(.system(size: Metrics.Font.title))
                    .foregroundStyle(Color(Token.secondary))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Metrics.headerPadH)
            .padding(.vertical, ProjectMetrics.rowPadV)
            .hoverShade(in: .rect(cornerRadius: ProjectMetrics.rowRadius))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.top, ProjectMetrics.newGap)
    }
}

/// One row of the Projects view. The editor is not among them: the
/// sidebar shows it as a sheet (EditorSheet.swift).
struct ProjectRowView: View {
    let row: ProjectRow

    var body: some View {
        switch row {
        case .header(let head):
            ProjectHeader(head: head)
        case .card(let card):
            CardView(card: card)
        case .ghost(_, let title, let text):
            GhostRow(title: title, text: text)
        case .newProject:
            NewProjectRow()
        case .quietHeader(let count, let collapsed):
            QuietHeader(count: count, collapsed: collapsed)
        case .quiet(let key, _, let name, let color, let icon, let canOpen, let menu):
            QuietRow(key: key, name: name, color: color, icon: icon, canOpen: canOpen, menu: menu)
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
