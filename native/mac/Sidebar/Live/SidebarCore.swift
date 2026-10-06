import Foundation
import os

/// The cockpit core inside the sidebar (issue #270): native/ffi's calls
/// over crux's JSON bridge, one core per process. The helper's data.json
/// goes in whenever its bytes change, each of Jon's clicks goes in with
/// the sidebar's clock, and each answer from inbox/ goes in as it is.
/// Whatever the core asks of the world goes out through outbox/ for the
/// helper to carry out; when it asks to be drawn, `changed` gets the
/// panel.
@MainActor
enum SidebarCore {
    /// Gets the core's panel whenever it changed.
    static var changed: ((Panel) -> Void)?
    /// Where the outbox is: the App Group folder, or a check's own.
    static var folder: () -> URL? = { Shared.folder }

    private static let log = Logger(subsystem: "dev.jonyardley.cockpit.sidebar", category: "core")

    /// What one call asked for (native/ffi `Out`).
    private struct Out: Decodable {
        let redraw: Bool
        /// Each the text of one outbox/ effect file.
        let effects: [String]
    }

    /// The core's view: only the panel is read.
    private struct View: Decodable {
        let panel: Panel?
    }

    /// Sends one of Jon's actions, stamped now. False when it is not one
    /// (`isAction`) or the core refused it; nothing is drawn then.
    @discardableResult
    static func send(_ action: SidebarAction, now: Date = Date()) -> Bool {
        guard action.isAction,
              let event = try? JSONEncoder().encode(Event.at(now: now.timeIntervalSince1970, event: action))
        else { return false }
        return call(event, cockpit_update)
    }

    /// Loads one data.json. False when the core refused it, so the caller
    /// tries the same bytes again.
    static func load(_ file: Data) -> Bool {
        call(file, cockpit_load)
    }

    /// One answer from inbox/, as the helper wrote it.
    static func answer(_ event: Data) {
        _ = call(event, cockpit_update)
    }

    /// Moves the core's clock on without new data, so a guess it holds
    /// lapses and a PR ask comes due between data.json writes.
    static func tick(now: Date = Date()) {
        if let event = try? JSONEncoder().encode(Event.at(now: now.timeIntervalSince1970, event: .refresh)) {
            _ = call(event, cockpit_update)
        }
    }

    /// The panel as the core has it now; nil before the first load.
    static func panel() -> Panel? {
        var out = CockpitBytes(ptr: nil, len: 0, cap: 0)
        guard cockpit_view(&out) == 0, let ptr = out.ptr else { return nil }
        defer { cockpit_free(out) }
        return try? JSONDecoder().decode(View.self, from: Data(bytes: ptr, count: Int(out.len))).panel
    }

    private typealias Call = (UnsafePointer<UInt8>?, Int, UnsafeMutablePointer<CockpitBytes>?) -> Int32

    /// Runs one call on `input`, writes the effects it asks for to the
    /// outbox and hands on the panel when it asks to be drawn.
    private static func call(_ input: Data, _ run: Call) -> Bool {
        var bytes = CockpitBytes(ptr: nil, len: 0, cap: 0)
        let code = input.withUnsafeBytes { raw in
            run(raw.bindMemory(to: UInt8.self).baseAddress, raw.count, &bytes)
        }
        defer { cockpit_free(bytes) }
        guard code == 0, let ptr = bytes.ptr,
              let out = try? JSONDecoder().decode(Out.self, from: Data(bytes: ptr, count: Int(bytes.len)))
        else {
            log.error("core refused an event: code \(code)")
            return false
        }
        let now = Date()
        for effect in out.effects {
            let written = folder().flatMap { try? Outbox.write(Data(effect.utf8), into: $0, now: now) }
            if written == nil { log.error("an effect was not written to the outbox") }
        }
        if out.redraw, let panel = panel() { changed?(panel) }
        return true
    }
}
