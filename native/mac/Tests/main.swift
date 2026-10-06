import Foundation

// A plain executable rather than an XCTest target: compiled with
// Shared/Heartbeat.swift and Host/Restart.swift by test.sh, it runs every check and exits non-zero if any missed.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

let now = Date(timeIntervalSince1970: 1_000_000)
check(!Heartbeat.isAlive(beat: nil, now: now), "no beat is down")
check(Heartbeat.isAlive(beat: now, now: now), "a beat now is alive")
check(Heartbeat.isAlive(beat: now.addingTimeInterval(-4.9), now: now), "a beat under five seconds old is alive")
check(!Heartbeat.isAlive(beat: now.addingTimeInterval(-5), now: now), "a beat five seconds old is down")
check(Heartbeat.isAlive(beat: now.addingTimeInterval(2), now: now), "a beat slightly ahead is alive")
check(!Heartbeat.isAlive(beat: now.addingTimeInterval(60), now: now), "a beat far in the future is down")
check(Heartbeat.decode(Heartbeat.encode(now)) == now, "encode then decode keeps the time")
check(Heartbeat.decode(" 1000000.5\n") == Date(timeIntervalSince1970: 1_000_000.5), "decode trims whitespace")
check(Heartbeat.decode("") == nil, "an empty file decodes to nothing")
check(Heartbeat.decode("garbage") == nil, "garbage decodes to nothing")

// The helper's restarts of cockpit-publish.
var restart = Restart()
check(restart.delay(after: 0.5) == 1, "a first quick death waits a second")
check(restart.delay(after: 0.5) == 2 && restart.delay(after: 0.5) == 4, "each quick death in a row doubles the wait")
for _ in 0..<10 { _ = restart.delay(after: 0) }
check(restart.delay(after: 0) == Restart.longest, "the wait stops growing at a minute")
check(restart.delay(after: 120) == 1 && restart.quick == 0, "a healthy run clears the backoff")

check(PublishLaunch.arguments(parent: 42) == ["--parent", "42", "--no-core"], "the publisher is told its parent, and runs no core")
let env = PublishLaunch.environment(["HOME": "/Users/j", "PATH": "/usr/bin:/bin", "LANG": "en_GB.UTF-8"])
let path = env["PATH"]?.split(separator: ":").map(String.init) ?? []
check(path.contains("/opt/homebrew/bin") && path.contains("/usr/local/bin") && path.contains("/Users/j/.local/bin"), "the PATH reaches Homebrew and ~/.local/bin")
check((path.firstIndex(of: "/opt/homebrew/bin") ?? 99) < (path.firstIndex(of: "/usr/bin") ?? 0), "Homebrew comes before the system's tools")
check(env["LANG"] == "en_GB.UTF-8" && env["HOME"] == "/Users/j", "the rest of the environment is kept")
check(PublishLaunch.environment([:])["PATH"]?.hasPrefix("/opt/homebrew/bin:") == true, "no HOME still gives a PATH")
let own = PublishLaunch.environment(["HOME": "/Users/j", "PATH": "/Users/j/.bun/bin:/usr/bin"])["PATH"]?.split(separator: ":").map(String.init) ?? []
check(own.last == "/Users/j/.bun/bin" && own.filter { $0 == "/usr/bin" }.count == 1, "the helper's own PATH follows the fixed folders, each folder once")

exit(failures == 0 ? 0 : 1)
