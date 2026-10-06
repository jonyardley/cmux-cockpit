import Foundation
import os

/// The core inside the sidebar (spike, issue #268): native/ffi's calls over
/// crux's JSON bridge. On only while the App Group folder holds
/// core-input.json (native/mac/dev-core.sh), a golden scene's input; the
/// sidebar reads panel.json as before otherwise. Effects are logged, not
/// run: nothing reaches cmux or the state file from here yet.
@MainActor
enum InProcessCore {
    static let inputName = "core-input.json"

    /// Whether the panel comes from this core.
    private(set) static var on = false
    /// core-input.json's last modification seen, so it is sent once.
    private static var seen: Date?
    /// The scene's clock less the wall clock, so a click lands at the
    /// scene's time and the cards' ages read as the scene has them.
    private static var offset: TimeInterval = 0
    /// Called after a click changes the panel, to draw it.
    static var changed: (() -> Void)?

    private static let log = Logger(subsystem: "dev.jonyardley.cockpit.sidebar", category: "core")

    /// Reads core-input.json from `folder` when it changed; false when there
    /// is none, so the caller reads panel.json.
    static func load(from folder: URL?) -> Bool {
        guard let file = folder?.appendingPathComponent(inputName),
              FileManager.default.fileExists(atPath: file.path)
        else {
            on = false
            seen = nil
            return false
        }
        let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        if on, modified == seen { return true }
        guard let data = try? Data(contentsOf: file),
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return on }
        let scene = input["data"] as? [String: Any] ?? [:]
        let epoch = (scene["epoch"] as? Double) ?? Date().timeIntervalSince1970
        offset = epoch - Date().timeIntervalSince1970
        let started = Date()
        let sent = send("PanelOn")
            && send(["Projects": input["projects"] ?? []])
            && send(["State": input["state"] ?? [:]])
            && send(["Data": scene])
        log.notice("core loaded \(inputName, privacy: .public): \(sent ? "ok" : "refused", privacy: .public) in \(Int(Date().timeIntervalSince(started) * 1000)) ms, pid \(ProcessInfo.processInfo.processIdentifier)")
        seen = modified
        on = sent
        return sent
    }

    /// One of Jon's actions, at the scene's clock; false when the core
    /// refused it.
    static func act(_ action: SidebarAction) -> Bool {
        guard let encoded = try? JSONEncoder().encode(action),
              let event = try? JSONSerialization.jsonObject(with: encoded, options: .fragmentsAllowed)
        else { return false }
        let now = Date().timeIntervalSince1970 + offset
        let started = Date()
        guard send(["At": ["now": now, "event": event]]) else { return false }
        changed?()
        log.notice("click to panel in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
        return true
    }

    /// The panel as the core has it now.
    static func panel() -> Panel? {
        var out = CockpitBytes(ptr: nil, len: 0, cap: 0)
        guard cockpit_view(&out) == 0, let ptr = out.ptr else { return nil }
        defer { cockpit_free(out) }
        let bytes = Data(bytes: ptr, count: Int(out.len))
        return try? JSONDecoder().decode(View.self, from: bytes).panel
    }

    /// The core's view: only the panel is read.
    private struct View: Decodable {
        let panel: Panel?
    }

    /// Sends one event as JSON; logs the effects it asks for by kind.
    private static func send(_ event: Any) -> Bool {
        guard let json = try? JSONSerialization.data(withJSONObject: event, options: .fragmentsAllowed) else {
            return false
        }
        var out = CockpitBytes(ptr: nil, len: 0, cap: 0)
        let code = json.withUnsafeBytes { raw in
            cockpit_update(raw.bindMemory(to: UInt8.self).baseAddress, raw.count, &out)
        }
        defer { cockpit_free(out) }
        guard code == 0 else {
            log.error("core refused an event: code \(code)")
            return false
        }
        if let ptr = out.ptr,
           let requests = try? JSONSerialization.jsonObject(with: Data(bytes: ptr, count: Int(out.len))) as? [[String: Any]] {
            let kinds = requests.compactMap { ($0["effect"] as? [String: Any])?.keys.first }
            log.notice("effects not run: \(kinds.joined(separator: ", "), privacy: .public)")
        }
        return true
    }
}
