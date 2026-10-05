import Foundation

// A plain executable rather than an XCTest target: compiled with
// Shared/Heartbeat.swift by test.sh, it runs every check and exits non-zero if any missed.

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

exit(failures == 0 ? 0 : 1)
