import Foundation

/// data.json as cockpit-publish writes it: the core's inputs, which the
/// sidebar hands its core as they are (SidebarCore.swift), so only the
/// name is needed here.
enum DataFile {
    static let fileName = "data.json"
}

/// What the sidebar shows, from what it found: the panel whenever one
/// decodes, with or without the helper, so a fixture can be judged with
/// the helper stopped and a restart never blanks it.
enum Showing: Equatable {
    /// No panel yet and the helper is down.
    case notRunning
    /// The helper is up and its first panel has not landed.
    case waiting
    /// A panel; `stale` while the helper is down.
    case panel(Panel, stale: Bool)

    static func of(panel: Panel?, running: Bool) -> Showing {
        if let panel { return .panel(panel, stale: !running) }
        return running ? .waiting : .notRunning
    }
}
