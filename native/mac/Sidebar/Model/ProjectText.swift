import Foundation

/// What the Projects view says and sends, decided here so the views only
/// lay it out. words() is the terminal pane's words for each row (native/
/// pane/src/views/projects.rs): a busy project's fold mark, mark, name,
/// count, folded dot and "+"; "+ New project"; the Quiet heading and its
/// count; a quiet project's mark, name and "+". The sidebar draws the
/// marks and pluses as a badge and icons instead (ProjectsView.swift), so
/// its own labels are newProjectLabel and the views. Cards are
/// CardText's.
enum ProjectText {
    /// The pane's words for a Projects row that is not a card, in its
    /// order; nil for a card and the editor, which the
    /// sidebar draws as a sheet.
    static func words(_ row: ProjectRow) -> [String]? {
        switch row {
        case .header(let h):
            var out = [h.collapsed ? Words.folded : Words.open, Words.laneMark, h.name, String(h.count)]
            if let dot = h.dot { out.append(dot.glyph) }
            if h.canOpen { out.append(Words.plus) }
            return out
        case .newProject:
            return [Words.newProject]
        case .quietHeader(let count, let collapsed):
            return [collapsed ? Words.folded : Words.open, Words.quiet, String(count)]
        case .quiet(_, _, let name, _, _, let canOpen, _):
            return [Words.laneMark, name] + (canOpen ? [Words.plus] : [])
        case .card, .editor:
            return nil
        }
    }

    /// "+ New project" as the sidebar draws it: a plus icon, then the
    /// label without the pane's "+ " (headers.ts newProjectRow).
    static var newProjectLabel: String {
        let mark = Words.plus + " "
        return Words.newProject.hasPrefix(mark) ? String(Words.newProject.dropFirst(mark.count)) : Words.newProject
    }

    /// A quiet project's row: whole while a click opens it, faded while it
    /// has no folder, so it does not read as a button (headers.ts quietRow).
    static func quietOpacity(canOpen: Bool) -> Double {
        canOpen ? 1 : quietFade
    }

    /// A quiet project with no folder, faded as the cockpit fades it.
    static let quietFade = 0.55

    /// The Quiet heading's pill, the core's QUIET_PILL (native/core/src/
    /// ui.rs), which the panel model does not carry.
    static var quietPill: PillColors { PillColors(bg: .countBg, fg: .metaText) }

    /// A row's identity in a ForEach.
    static func id(_ row: ProjectRow) -> String {
        switch row {
        case .header(let h): h.id
        case .card(let card): card.wsId
        case .newProject: "new"
        case .editor: "editor"
        case .quietHeader: "quiet"
        case .quiet(_, let id, _, _, _, _, _): id
        }
    }

    /// The open editor, while the core has one open.
    static func editor(_ panel: Panel) -> EditorView? {
        for row in panel.projects {
            if case .editor(let e) = row { return e }
        }
        return nil
    }

    /// The rows the sidebar lays out in the list: all but the editor,
    /// which it shows as a sheet.
    static func listed(_ panel: Panel) -> [ProjectRow] {
        panel.projects.filter {
            if case .editor = $0 { return false }
            return true
        }
    }

    /// A colour as the table spells it, as six hex digits: "#D97757", a
    /// hand-typed "#D75" doubled to "#DD7755", or "#D9775780" with its
    /// alpha dropped, as the core's parse_hex reads it for the badges.
    static func hex(_ s: String) -> UInt32? {
        colour(s)?.rgb
    }

    /// A colour as a hand-written config spells it, "#RGB", "#RRGGBB" or
    /// "#RRGGBBAA" in either case, with its alpha (the core's
    /// theme::parse_colour). Nil for anything else.
    static func colour(_ s: String) -> Rgba? {
        guard s.hasPrefix("#") else { return nil }
        let digits = Array(s.dropFirst())
        guard digits.allSatisfy(\.isHexDigit) else { return nil }
        let full: [Character]
        switch digits.count {
        case 3: full = digits.flatMap { [$0, $0] }
        case 6, 8: full = digits
        default: return nil
        }
        guard let rgb = UInt32(String(full[0..<6]), radix: 16) else { return nil }
        let alpha = full.count == 8 ? UInt8(String(full[6..<8]), radix: 16) : 0xFF
        guard let alpha else { return nil }
        return Rgba(rgb: rgb, alpha: alpha)
    }
}

/// A project's right-click menu, from the core's items: what to send when
/// one is picked. The core takes a pick only on the menu it has open, so
/// the pick opens it first; the outbox applies the two in the order sent.
/// Opening it on the right-click instead would leave it open in the core
/// whenever Jon clicks away, as SwiftUI says nothing when a context menu
/// closes unpicked.
enum ProjectMenu {
    static func pick(_ action: MenuAction, key: String, quiet: Bool) -> [SidebarAction] {
        [.menu(.openProject(key: key, quiet: quiet)), .menu(.pick(action))]
    }
}

/// The editor sheet's text as Jon types it. The sheet keeps its own copy
/// and sends each change to the core, rather than drawing what the panel
/// says, so a redraw never loses keys typed mid-edit. Every change is an
/// edit, so typing in the sheet can only ever reach the editor, never a
/// card.
struct EditorDraft: Equatable {
    var name: String
    var folder: String
    var search: String

    init(_ e: EditorView) {
        name = e.name
        folder = e.root
        search = e.search
    }

    /// What to send for the draft now that it reads `next`: one edit per
    /// field that changed.
    func changes(to next: EditorDraft) -> [SidebarAction.Edit] {
        var out: [SidebarAction.Edit] = []
        if next.name != name { out.append(.name(next.name)) }
        if next.folder != folder { out.append(.folder(next.folder)) }
        if next.search != search { out.append(.search(next.search)) }
        return out
    }

    /// The name the core gave a new project from its folder, for the Name
    /// field to show, or nil to keep the field as it is. The core names a
    /// new project after each folder edit, so the sheet takes that name
    /// once the core has caught up with the folder as typed, unless a name
    /// typed since is still on its way (the core applies it after).
    static func derivedName(_ e: EditorView, draft: EditorDraft, namedSinceFolder: Bool) -> String? {
        guard e.isNew, !namedSinceFolder, e.root == draft.folder, e.name != draft.name else { return nil }
        return e.name
    }
}

/// A Projects row's identity is its project or workspace, so a card keeps
/// its view as its status changes.
extension ProjectRow: Identifiable {
    public var id: String { ProjectText.id(self) }
}
