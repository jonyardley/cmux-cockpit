import Foundation

/// What the helper app and the sidebar extension agree on. Both targets
/// compile this one file, so the names cannot drift apart.
enum Shared {
    /// The App Group both sides are entitled to. Its folder is the only
    /// place the sandboxed extension can read from the helper app.
    static let group = "9S5FG4LQAF.dev.jonyardley.cockpit"

    /// A bare "something changed" signal. It carries nothing: the reader
    /// looks in the group folder for the news.
    static let changed = Notification.Name("dev.jonyardley.cockpit.changed")

    /// The group folder, or nil when this process is not entitled to it
    /// (an unsigned build, say).
    static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }
}

/// The helper app's heartbeat: a file in the group folder holding the time
/// of the latest beat, in seconds since 1970. The helper rewrites it every
/// second and deletes it on quit; the extension calls the helper up while
/// the latest beat is recent.
enum Heartbeat {
    static let fileName = "heartbeat"
    static let interval: TimeInterval = 1
    /// A few missed beats before the extension says the helper is down, so
    /// a busy second never flickers the panel.
    static let staleAfter: TimeInterval = 5

    /// Whether a beat at `beat` still counts as alive at `now`. No beat, or
    /// one from the future by more than the stale window (a clock change),
    /// counts as down.
    static func isAlive(beat: Date?, now: Date) -> Bool {
        guard let beat else { return false }
        let age = now.timeIntervalSince(beat)
        return age < staleAfter && age > -staleAfter
    }

    static func encode(_ date: Date) -> String {
        String(date.timeIntervalSince1970)
    }

    static func decode(_ text: String) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return TimeInterval(trimmed).map(Date.init(timeIntervalSince1970:))
    }
}
