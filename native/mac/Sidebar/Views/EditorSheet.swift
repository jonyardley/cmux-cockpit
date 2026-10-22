import SwiftUI

/// The editor sheet's measures (docs/design.md#editor-sheet).
private enum EditorLook {
    static let width: CGFloat = 260
    static let pad: CGFloat = 14
    /// Between the sheet's sections, between the lines inside one, and
    /// from a label to what it labels.
    static let sectionGap: CGFloat = 10
    static let lineGap: CGFloat = 4
    static let labelGap: CGFloat = 3
    /// A colour swatch, the narrowest cell it takes, and the ring round
    /// the chosen one.
    static let swatch: CGFloat = 14
    static let swatchCell: CGFloat = 16
    static let swatchRing: CGFloat = 2
    /// An icon's cell, and the narrowest column it takes.
    static let iconWidth: CGFloat = 24
    static let iconHeight: CGFloat = 22
    static let iconColumn: CGFloat = 26
    /// Between swatches and icons, across and down.
    static let gridGap: CGFloat = 4
}

/// The project editor as a sheet, over the panel while the core has an
/// editor open. What it shows (the colours, the icons on offer, why Save
/// would not save, the folders on offer, Remove's words) is the core's
/// editor state in the panel; the text Jon types is the sheet's own
/// (EditorDraft). It sends only edits: `send` takes nothing else, so no key
/// typed here can reach a card.
struct EditorSheet: View {
    /// The core's editor as the panel has it now.
    let editor: EditorView
    let send: (SidebarAction.Edit) -> Void

    @State private var draft: EditorDraft
    @State private var sent: EditorDraft
    /// A name typed since the folder last changed, which the core applies
    /// after the folder's own name, so the sheet keeps it.
    @State private var namedSinceFolder = false
    @FocusState private var searching: Bool

    init(editor: EditorView, send: @escaping (SidebarAction.Edit) -> Void) {
        self.editor = editor
        self.send = send
        _draft = State(initialValue: EditorDraft(editor))
        _sent = State(initialValue: EditorDraft(editor))
    }

    private let iconColumns = [GridItem(.adaptive(minimum: EditorLook.iconColumn), spacing: EditorLook.gridGap)]

    var body: some View {
        VStack(alignment: .leading, spacing: EditorLook.sectionGap) {
            Text(editor.isNew ? Words.newProjectTitle : Words.editProjectTitle)
                .font(.system(size: Metrics.Font.control, weight: .semibold))
                .foregroundStyle(Color(Token.text))
            if editor.isNew { folder }
            field(Words.name) {
                // The badge as the header draws it, beside the name, so a
                // colour or icon picked shows at once.
                HStack(spacing: Metrics.inlineGap) {
                    BadgeTile(
                        icon: editor.icon,
                        color: ProjectText.hex(editor.color),
                        size: ProjectMetrics.headerBadge,
                        font: ProjectMetrics.headerBadgeFont
                    )
                    TextField(Words.projectName, text: $draft.name).textFieldStyle(.roundedBorder)
                }
            }
            field(Words.colour) { colours }
            field(Words.icon) { icons }
            if !editor.isNew {
                folder
                Button(editor.remove, role: .destructive) { send(.remove) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(Token.redText))
            }
            Text(editor.problem ?? " ")
                .font(.system(size: Metrics.Font.meta))
                .foregroundStyle(Color(Token.redText))
            HStack {
                Spacer()
                // Esc has its own key, out of sight: in the icon search with
                // words typed it keeps the editor open.
                Button(Words.cancel) { escape() }
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
                Button(Words.cancel) { send(.close) }
                // Not disabled on the problem: that is the core's, a
                // step behind the keys, and the core saves only a draft
                // with no problem anyway.
                Button(editor.isNew ? Words.add : Words.done) { send(.save) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .font(.system(size: Metrics.Font.control))
        .padding(EditorLook.pad)
        .frame(width: EditorLook.width)
        .onChange(of: draft) { _, next in
            for edit in sent.changes(to: next) {
                switch edit {
                case .name: namedSinceFolder = true
                case .folder: namedSinceFolder = false
                default: break
                }
                send(edit)
            }
            sent = next
        }
        .onChange(of: [editor.root, editor.name]) {
            if let name = EditorDraft.derivedName(editor, draft: draft, namedSinceFolder: namedSinceFolder) {
                sent.name = name
                draft.name = name
            }
        }
    }

    /// Esc: closes, except in the icon search with words typed.
    private func escape() {
        if searching && !draft.search.trimmingCharacters(in: .whitespaces).isEmpty { return }
        send(.close)
    }

    /// The folder, the line of sessions it matches, and the folders on
    /// offer for a new project.
    private var folder: some View {
        field(Words.folder) {
            VStack(alignment: .leading, spacing: EditorLook.lineGap) {
                TextField(Words.folder, text: $draft.folder).textFieldStyle(.roundedBorder)
                if !editor.matches.isEmpty {
                    Text(editor.matches).font(.system(size: Metrics.Font.meta)).foregroundStyle(Color(Token.faint))
                }
                if !editor.suggestions.isEmpty {
                    Text(Words.openFolders).font(.system(size: Metrics.Font.meta)).foregroundStyle(Color(Palette.Own.tertiary))
                }
                ForEach(editor.suggestions, id: \.self) { dir in
                    Button {
                        send(.addSuggested(dir: dir))
                    } label: {
                        Label(dir, systemImage: "plus")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(Token.secondary))
                }
            }
        }
    }

    /// The colours on offer, the chosen one ringed.
    private var colours: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: EditorLook.swatchCell), spacing: EditorLook.gridGap)], spacing: EditorLook.gridGap) {
            ForEach(editor.colors, id: \.self) { c in
                let chosen = c.caseInsensitiveCompare(editor.color) == .orderedSame
                Button {
                    send(.color(c))
                } label: {
                    Circle()
                        .fill(Color(project: ProjectText.hex(c)))
                        .frame(width: EditorLook.swatch, height: EditorLook.swatch)
                        .overlay(Circle().strokeBorder(Color(Token.text), lineWidth: chosen ? EditorLook.swatchRing : 0))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// The icon search, the icons on offer with the chosen one lit, and
    /// the note under them.
    private var icons: some View {
        VStack(alignment: .leading, spacing: EditorLook.lineGap) {
            TextField(Words.searchIcons, text: $draft.search)
                .textFieldStyle(.roundedBorder)
                .focused($searching)
            LazyVGrid(columns: iconColumns, spacing: EditorLook.gridGap) {
                ForEach(editor.icons, id: \.self) { name in
                    Button {
                        send(.icon(name))
                    } label: {
                        Image(systemName: name)
                            .frame(width: EditorLook.iconWidth, height: EditorLook.iconHeight)
                            .foregroundStyle(Color(name == editor.icon ? Token.text : Token.secondary))
                            .background(
                                name == editor.icon ? Color(Token.countBg) : .clear,
                                in: .rect(cornerRadius: Metrics.Radius.iconCell)
                            )
                    }
                    .buttonStyle(.plain)
                    .help(name)
                }
            }
            if !editor.note.isEmpty {
                Text(editor.note).font(.system(size: Metrics.Font.meta)).foregroundStyle(Color(Token.faint))
            }
        }
    }

    private func field(_ label: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: EditorLook.labelGap) {
            Text(label).font(.system(size: Metrics.Font.meta)).foregroundStyle(Color(Token.faint))
            content()
        }
    }
}

/// The open editor's key, so the sheet is one per project: opening the
/// editor on another project starts a new sheet with that project's words.
struct EditorKey: Identifiable, Equatable {
    let id: String
}
