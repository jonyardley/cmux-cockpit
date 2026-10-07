import Foundation

/// When the helper starts cockpit-publish again after it stops: at once
/// after a long run, later after each quick death in a row, so a publisher
/// that cannot start never spins.
struct Restart: Equatable {
    /// A run at least this long counts as healthy and clears the backoff.
    static let healthy: TimeInterval = 30
    static let first: TimeInterval = 1
    static let longest: TimeInterval = 60

    /// Quick deaths in a row.
    private(set) var quick = 0

    /// How long to wait before the next start, given how long the run that
    /// just ended lasted.
    mutating func delay(after ran: TimeInterval) -> TimeInterval {
        if ran >= Self.healthy {
            quick = 0
            return Self.first
        }
        quick += 1
        return min(Self.longest, Self.first * pow(2, Double(quick - 1)))
    }
}

/// How the helper starts cockpit-publish: directly, never through a
/// shell, naming itself as the parent to stop with, and with a PATH that
/// reaches cmux, claude, gh and git, which a launchd-started app's
/// minimal PATH does not.
enum PublishLaunch {
    static let binary = "cockpit-publish"
    /// Started by hand, the helper writes the heartbeat but leaves
    /// data.json alone, so a fixture from dev-fixture.sh stays on screen.
    static let noPublish = "--no-publish"

    static func arguments(parent: Int32) -> [String] {
        ["--parent", String(parent)]
    }

    /// The child's environment: the helper's own, with the fixed folders
    /// first on PATH and whatever PATH the helper had after them, so a
    /// tool only on the user's own PATH is still found.
    static func environment(_ base: [String: String]) -> [String: String] {
        var env = base
        let home = base["HOME"].map { [$0 + "/.local/bin", $0 + "/.cargo/bin"] } ?? []
        let fixed = ["/opt/homebrew/bin", "/usr/local/bin"] + home + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let inherited = (base["PATH"] ?? "").split(separator: ":").map(String.init).filter { !fixed.contains($0) }
        var seen = Set<String>()
        env["PATH"] = (fixed + inherited).filter { seen.insert($0).inserted }.joined(separator: ":")
        return env
    }
}
