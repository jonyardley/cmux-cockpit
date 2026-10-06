import Foundation

/// panel.json as cockpit-publish writes it (native/runner/src/publish.rs):
/// `{"seq": 4, "written_at_ms": 1791229864123, "panel": {...}}`. The panel
/// is the generated `Panel`; this envelope is the runner's transport, not
/// the core's model, so typegen does not write it.
struct PanelFile: Decodable, Equatable {
    /// Counts the publisher's writes from 1; it starts again when the
    /// publisher restarts, so it never orders two files.
    let seq: UInt64
    let writtenAtMs: UInt64
    let panel: Panel

    static let fileName = "panel.json"

    private enum CodingKeys: String, CodingKey {
        case seq
        case writtenAtMs = "written_at_ms"
        case panel
    }

    static func decode(_ data: Data) -> PanelFile? {
        try? JSONDecoder().decode(PanelFile.self, from: data)
    }
}

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
