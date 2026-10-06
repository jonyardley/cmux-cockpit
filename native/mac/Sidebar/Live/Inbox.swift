import Foundation

/// The answers to the sidebar core's effects, as cockpit-publish writes
/// them into the App Group folder's inbox/ (native/runner/src/inbox.rs):
/// one core event per file, named `<13 digit epoch ms>-<6 digit
/// counter>.json` so names sort in the order written, under a name
/// starting with "." until it is whole. The helper deletes one nobody took
/// within a minute.
enum Inbox {
    static let dirName = "inbox"

    /// Takes every whole answer in `folder`'s inbox/, oldest first: each
    /// file's bytes, the file deleted. One that will not read is deleted
    /// too, so it never blocks the ones after it.
    static func take(from folder: URL) -> [Data] {
        let inbox = folder.appendingPathComponent(dirName, isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? []
        return names
            .filter { !$0.hasPrefix(".") && $0.hasSuffix(".json") }
            .sorted()
            .compactMap { name in
                let file = inbox.appendingPathComponent(name)
                defer { try? FileManager.default.removeItem(at: file) }
                return try? Data(contentsOf: file)
            }
    }
}
