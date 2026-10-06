import Foundation

/// One of Jon's actions, as the sidebar sends it to cockpit-publish through
/// the outbox (Live/Outbox.swift). It mirrors the runner's `Action`
/// (native/runner/src/action.rs) and encodes to the JSON that parses: serde's
/// externally tagged enums, so `.flipView` is `"FlipView"`, `.switchTo(id:)`
/// is `{"SwitchTo": {"id": "W1"}}` and `.menu(.close)` is
/// `{"Menu": "Close"}`. typegen writes only the panel's Decodable types, so
/// this is written by hand; native/runner/tests/actions.json holds one file
/// per case, which both the Rust and the Swift checks read.
enum SidebarAction: Encodable, Equatable {
    case moveCard(id: String, lane: LaneKey, before: String?)
    case switchTo(id: String)
    case dismiss(id: String)
    case flipView
    case edit(Edit)
    case openProject(key: String)
    case fileForReview(id: String)
    case parkMerged(id: String)
    case closeMerged(id: String)
    case keepMerged(id: String)
    case menu(Menu)
    /// The Next button: the next workspace in its queue.
    case next
    /// "Message agent…": Jon's words for the agent in the workspace.
    case messageAgent(id: String, text: String)
    /// A click on a lane's heading: folds or unfolds it.
    case toggleLane(LaneKey)
    /// A click on a busy project's heading: folds or unfolds it.
    case toggleProject(key: String)
    /// A click on the Quiet heading: folds or unfolds it.
    case toggleQuiet

    /// The core's `MenuEvent`.
    enum Menu: Encodable, Equatable {
        case openCard(id: String)
        case openProject(key: String, quiet: Bool)
        case close
        case pick(MenuAction)

        func encode(to encoder: Encoder) throws {
            switch self {
            case let .openCard(id): try tagged(encoder, "OpenCard", ["id": id])
            case let .openProject(key, quiet):
                var c = encoder.container(keyedBy: Key.self)
                var f = c.nestedContainer(keyedBy: Key.self, forKey: Key("OpenProject"))
                try f.encode(key, forKey: Key("key"))
                try f.encode(quiet, forKey: Key("quiet"))
            case .close: try unit(encoder, "Close")
            case let .pick(action): try newtype(encoder, "Pick", action)
            }
        }
    }

    /// The core's `EditEvent`.
    enum Edit: Encodable, Equatable {
        case openNew
        case open(key: String)
        case close
        case name(String)
        case color(String)
        case icon(String)
        case folder(String)
        case search(String)
        case cancelSearch
        case save
        case addSuggested(dir: String)
        case remove

        func encode(to encoder: Encoder) throws {
            switch self {
            case .openNew: try unit(encoder, "OpenNew")
            case let .open(key): try tagged(encoder, "Open", ["key": key])
            case .close: try unit(encoder, "Close")
            case let .name(s): try newtype(encoder, "Name", s)
            case let .color(s): try newtype(encoder, "Color", s)
            case let .icon(s): try newtype(encoder, "Icon", s)
            case let .folder(s): try newtype(encoder, "Folder", s)
            case let .search(s): try newtype(encoder, "Search", s)
            case .cancelSearch: try unit(encoder, "CancelSearch")
            case .save: try unit(encoder, "Save")
            case let .addSuggested(dir): try tagged(encoder, "AddSuggested", ["dir": dir])
            case .remove: try unit(encoder, "Remove")
            }
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case let .moveCard(id, lane, before):
            var c = encoder.container(keyedBy: Key.self)
            var f = c.nestedContainer(keyedBy: Key.self, forKey: Key("MoveCard"))
            try f.encode(id, forKey: Key("id"))
            try f.encode(lane, forKey: Key("lane"))
            // null, never left out: the documented shape.
            try f.encode(before, forKey: Key("before"))
        case let .switchTo(id): try tagged(encoder, "SwitchTo", ["id": id])
        case let .dismiss(id): try tagged(encoder, "Dismiss", ["id": id])
        case .flipView: try unit(encoder, "FlipView")
        case let .edit(e): try newtype(encoder, "Edit", e)
        case let .openProject(key): try tagged(encoder, "OpenProject", ["key": key])
        case let .fileForReview(id): try tagged(encoder, "FileForReview", ["id": id])
        case let .parkMerged(id): try tagged(encoder, "ParkMerged", ["id": id])
        case let .closeMerged(id): try tagged(encoder, "CloseMerged", ["id": id])
        case let .keepMerged(id): try tagged(encoder, "KeepMerged", ["id": id])
        case let .menu(m): try newtype(encoder, "Menu", m)
        case .next: try unit(encoder, "Next")
        case let .messageAgent(id, text): try tagged(encoder, "MessageAgent", ["id": id, "text": text])
        case let .toggleLane(lane):
            var c = encoder.container(keyedBy: Key.self)
            var f = c.nestedContainer(keyedBy: Key.self, forKey: Key("ToggleLane"))
            try f.encode(lane, forKey: Key("lane"))
        case let .toggleProject(key): try tagged(encoder, "ToggleProject", ["key": key])
        case .toggleQuiet: try unit(encoder, "ToggleQuiet")
        }
    }
}

extension SidebarAction {
    /// The core's words on a merged card's two buttons (panel/mod.rs
    /// PARK and CLOSE): the chip says which one it is.
    static let parkWord = "Park"
    static let closeWord = "Close"

    /// What tapping one of a card's merged chips sends: Park or Close, by
    /// its words. The core puts Close there only where it offers it, and
    /// checks again when the action lands.
    static func merged(_ chip: Chip, id: String) -> SidebarAction? {
        switch chip.pieces.first?.text {
        case parkWord: .parkMerged(id: id)
        case closeWord: .closeMerged(id: id)
        default: nil
        }
    }

    /// What picking an item of a card's menu sends: the menu opened on
    /// that card, then the item, in that order, as the pane's Space then
    /// Enter would.
    static func pick(_ action: MenuAction, on id: String) -> [SidebarAction] {
        [.menu(.openCard(id: id)), .menu(.pick(action))]
    }

    /// "Message agent…" sends only words: blank text sends nothing.
    static func message(_ text: String, to id: String) -> SidebarAction? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? nil : .messageAgent(id: id, text: words)
    }
}

// The generated panel types only decode; the outbox sends a lane and a
// menu pick back. A switch with no default, so a new Rust variant fails
// to compile here until it is spelt.
extension LaneKey: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .main: try c.encode("main")
        case .review: try c.encode("review")
        case .bg: try c.encode("bg")
        case .parked: try c.encode("parked")
        case .unsorted: try c.encode("unsorted")
        }
    }
}

extension MenuAction: Encodable {
    public func encode(to encoder: Encoder) throws {
        switch self {
        case .newSession: try unit(encoder, "NewSession")
        case let .lane(lane): try newtype(encoder, "Lane", lane)
        case let .project(key): try newtype(encoder, "Project", key)
        case .clearProjectOverride: try unit(encoder, "ClearProjectOverride")
        case .newProjectFromFolder: try unit(encoder, "NewProjectFromFolder")
        case .togglePin: try unit(encoder, "TogglePin")
        case .markRead: try unit(encoder, "MarkRead")
        case .openPr: try unit(encoder, "OpenPr")
        case .keepMerged: try unit(encoder, "KeepMerged")
        case .toggleNeeds: try unit(encoder, "ToggleNeeds")
        case .openProject: try unit(encoder, "OpenProject")
        case .editProject: try unit(encoder, "EditProject")
        }
    }
}

/// Any JSON key, for serde's variant names and field names.
private struct Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// A unit variant: its bare name.
private func unit(_ encoder: Encoder, _ name: String) throws {
    var c = encoder.singleValueContainer()
    try c.encode(name)
}

/// A newtype variant: `{"Name": payload}`.
private func newtype(_ encoder: Encoder, _ name: String, _ payload: some Encodable) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(payload, forKey: Key(name))
}

/// A struct variant of string fields: `{"Name": {"field": "value"}}`.
private func tagged(_ encoder: Encoder, _ name: String, _ fields: [String: String]) throws {
    var c = encoder.container(keyedBy: Key.self)
    var f = c.nestedContainer(keyedBy: Key.self, forKey: Key(name))
    for (k, v) in fields { try f.encode(v, forKey: Key(k)) }
}
