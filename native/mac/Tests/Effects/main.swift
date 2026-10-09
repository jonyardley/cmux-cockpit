import Foundation

// Checks the effect files (native/runner/src/effect.rs): the
// sidebar's core runs in the sidebar, and each effect it asks for goes into
// outbox/ as the bridge hands it out. native/runner/tests/effects.json holds
// one file per effect, the same the runner's own test parses and matches
// against the bridge. The sidebar has no Swift effect types yet (they come
// with the bridge's typegen, R3.4), so this checks the file itself: one entry
// per effect the runner takes, none it refuses, and each unchanged by the
// round trip through JSONSerialization the sidebar relays it with.
// test.sh builds and runs it with that file's path as its argument.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: effects-check <effects.json>")
    exit(2)
}

/// Every effect the runner takes from outbox/, in effects.json's order.
let every = ["Cmux", "Persist", "PrPoll", "OpenUrl", "AgentMessage", "SavePrs"]

let fixture = URL(fileURLWithPath: args[1])
let data = (try? Data(contentsOf: fixture)) ?? Data()
let entries = (try? JSONSerialization.jsonObject(with: data)) as? [Any] ?? []
check(entries.count == every.count, "effects.json has \(entries.count) entries, the runner takes \(every.count)")

for (entry, name) in zip(entries, every) {
    let object = entry as? [String: Any]
    check(object.map { Array($0.keys) } == [name], "the entry is one \(name) effect")
    check(object?[name] is [String: Any], "\(name) carries its fields as an object")
    let relayed = (try? JSONSerialization.data(withJSONObject: entry))
        .flatMap { try? JSONSerialization.jsonObject(with: $0) }
    check(relayed.map { ($0 as AnyObject).isEqual(entry) } ?? false, "\(name) relays unchanged")
}

let names = Set(entries.compactMap { ($0 as? [String: Any])?.keys.first })
check(!names.contains("Render"), "Render never goes to outbox/")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all passed")
