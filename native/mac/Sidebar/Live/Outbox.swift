import Foundation

/// Sends Jon's actions to cockpit-publish: each one a file in the App Group
/// folder's outbox/, in the format and naming native/runner/src/publish.rs
/// sets out. The file is written under a name starting with "." (which the
/// runner skips), then renamed to `<13 digit epoch ms>-<6 digit
/// counter>.json`, so the runner never reads half a file and takes them in
/// the order sent. The runner polls the outbox every 100 ms, so no signal
/// is posted.
@MainActor
enum Outbox {
    static let dirName = "outbox"

    /// Counts this process's sends, so two in the same millisecond keep
    /// their order.
    private static var counter: UInt32 = 0

    /// Takes each action instead of the outbox while set: the core inside
    /// the sidebar (InProcessCore, issue #268). Returns whether it took it.
    static var divert: ((SidebarAction) -> Bool)?

    /// Sends one action. False when it could not be written (no group
    /// folder, or the disk refused); the action is then dropped.
    @discardableResult
    static func send(_ action: SidebarAction) -> Bool {
        if let divert, divert(action) { return true }
        guard let folder = Shared.folder else { return false }
        return (try? write(action, into: folder, now: Date())) != nil
    }

    /// Writes one action file into `folder`'s outbox/, making it when
    /// missing, and returns the file's URL.
    static func write(_ action: SidebarAction, into folder: URL, now: Date) throws -> URL {
        let outbox = folder.appendingPathComponent(dirName, isDirectory: true)
        try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(action)
        let ms = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        let tmp = outbox.appendingPathComponent(".\(ProcessInfo.processInfo.processIdentifier)-\(ms).tmp")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try data.write(to: tmp)
        // Another sidebar process counts from 1 too, so its send in the
        // same millisecond can hold this name: take the next number.
        var tries = 0
        while true {
            counter = (counter + 1) % 1_000_000
            let file = outbox.appendingPathComponent(String(format: "%013llu-%06u.json", ms, counter))
            do {
                try FileManager.default.moveItem(at: tmp, to: file)
                return file
            } catch CocoaError.fileWriteFileExists where tries < 100 {
                tries += 1
            }
        }
    }
}
