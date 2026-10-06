import SwiftUI

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

    private let iconColumns = [GridItem(.adaptive(minimum: 26), spacing: 4)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(editor.isNew ? Words.newProjectTitle : Words.editProjectTitle)
                .font(.system(size: Metrics.body, weight: .semibold))
                .foregroundStyle(Color(Token.text))
            if editor.isNew { folder }
            field(Words.name) {
                TextField(Words.projectName, text: $draft.name).textFieldStyle(.roundedBorder)
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
                .font(.system(size: Metrics.small))
                .foregroundStyle(Color(Token.redText))
            HStack {
                Spacer()
                // Esc has its own key, out of sight: in the icon search with
                // words typed it keeps the editor open, as the pane's does.
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
        .font(.system(size: Metrics.body))
        .padding(14)
        .frame(width: 260)
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
            VStack(alignment: .leading, spacing: 4) {
                TextField(Words.folder, text: $draft.folder).textFieldStyle(.roundedBorder)
                if !editor.matches.isEmpty {
                    Text(editor.matches).font(.system(size: Metrics.small)).foregroundStyle(Color(Token.faint))
                }
                if !editor.suggestions.isEmpty {
                    Text(Words.openFolders).font(.system(size: Metrics.small)).foregroundStyle(Color(Palette.Own.tertiary))
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
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 16), spacing: 4)], spacing: 4) {
            ForEach(editor.colors, id: \.self) { c in
                let chosen = c.caseInsensitiveCompare(editor.color) == .orderedSame
                Button {
                    send(.color(c))
                } label: {
                    Circle()
                        .fill(Color(project: ProjectText.hex(c)))
                        .frame(width: 14, height: 14)
                        .overlay(Circle().strokeBorder(Color(Token.text), lineWidth: chosen ? 2 : 0))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// The icon search, the icons on offer with the chosen one lit, and
    /// the note under them.
    private var icons: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(Words.searchIcons, text: $draft.search)
                .textFieldStyle(.roundedBorder)
                .focused($searching)
            LazyVGrid(columns: iconColumns, spacing: 4) {
                ForEach(editor.icons, id: \.self) { name in
                    Button {
                        send(.icon(name))
                    } label: {
                        Image(systemName: name)
                            .frame(width: 24, height: 22)
                            .foregroundStyle(Color(name == editor.icon ? Token.text : Token.secondary))
                            .background(
                                name == editor.icon ? Color(Token.countBg) : .clear,
                                in: .rect(cornerRadius: 4)
                            )
                    }
                    .buttonStyle(.plain)
                    .help(name)
                }
            }
            if !editor.note.isEmpty {
                Text(editor.note).font(.system(size: Metrics.small)).foregroundStyle(Color(Token.faint))
            }
        }
    }

    private func field(_ label: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: Metrics.small)).foregroundStyle(Color(Token.faint))
            content()
        }
    }
}

/// The open editor's key, so the sheet is one per project: opening the
/// editor on another project starts a new sheet with that project's words.
struct EditorKey: Identifiable, Equatable {
    let id: String
}
