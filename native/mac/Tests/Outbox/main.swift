import Foundation

// Checks the outbox (Sidebar/Live/Outbox.swift and
// Sidebar/Model/SidebarAction.swift): every action encodes to the JSON in
// native/runner/tests/actions.json, the file the runner's own test parses
// as its Action, and a send lands as a file the runner picks up in order.
// test.sh builds and runs it with that file's path as its argument.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: outbox-check <actions.json>")
    exit(2)
}

/// One per entry of actions.json, in its order.
let every: [SidebarAction] = [
    .moveCard(id: "W1", lane: .review, before: nil),
    .moveCard(id: "W1", lane: .bg, before: "W2"),
    .switchTo(id: "W1"),
    .dismiss(id: "W1"),
    .flipView,
    .edit(.openNew),
    .edit(.open(key: "/dev/cockpit")),
    .edit(.close),
    .edit(.name("Cockpit")),
    .edit(.color("blue")),
    .edit(.icon("terminal")),
    .edit(.folder("~/dev/cockpit")),
    .edit(.search("term")),
    .edit(.cancelSearch),
    .edit(.save),
    .edit(.addSuggested(dir: "/dev/cockpit")),
    .edit(.remove),
    .openProject(key: "/dev/cockpit"),
    .fileForReview(id: "W1"),
    .parkMerged(id: "W1"),
    .closeMerged(id: "W1"),
    .keepMerged(id: "W1"),
    .menu(.openCard(id: "W1")),
    .menu(.openProject(key: "/dev/cockpit", quiet: true)),
    .menu(.close),
    .menu(.pick(.newSession)),
    .menu(.pick(.lane(.main))),
    .menu(.pick(.lane(.review))),
    .menu(.pick(.lane(.bg))),
    .menu(.pick(.lane(.parked))),
    .menu(.pick(.lane(.unsorted))),
    .menu(.pick(.project("/dev/cockpit"))),
    .menu(.pick(.clearProjectOverride)),
    .menu(.pick(.newProjectFromFolder)),
    .menu(.pick(.togglePin)),
    .menu(.pick(.markRead)),
    .menu(.pick(.openPr)),
    .menu(.pick(.keepMerged)),
    .menu(.pick(.toggleNeeds)),
    .menu(.pick(.openProject)),
    .menu(.pick(.editProject)),
    .next,
    .messageAgent(id: "W1", text: "Rebase when free."),
]

func json(_ data: Data) -> Any? {
    try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
}

// MARK: Each action's JSON

let fixture = URL(fileURLWithPath: args[1])
let expected = (try? Data(contentsOf: fixture)).flatMap(json) as? [Any] ?? []
check(expected.count == every.count, "actions.json has \(expected.count) entries, Swift lists \(every.count)")
for (action, want) in zip(every, expected) {
    let data = try? JSONEncoder().encode(action)
    let got = data.flatMap(json)
    let text = data.map { String(decoding: $0, as: UTF8.self) } ?? "nothing"
    check(got.map { ($0 as AnyObject).isEqual(want) } ?? false, "\(action) encodes as \(text)")
}

// MARK: Sending

let folder = FileManager.default.temporaryDirectory
    .appendingPathComponent("outbox-check-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
let now = Date(timeIntervalSince1970: 1_791_229_864.123)
let first = try? Outbox.write(.flipView, into: folder, now: now)
let second = try? Outbox.write(.menu(.close), into: folder, now: now)
let outbox = folder.appendingPathComponent(Outbox.dirName)
let names = ((try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? []).sorted()
let pattern = try! NSRegularExpression(pattern: "^[0-9]{13}-[0-9]{6}\\.json$")
let shaped = names.allSatisfy {
    pattern.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil
}
check(names.count == 2 && shaped, "two sends leave two named files and no temp file: \(names)")
check(names.first?.hasPrefix("1791229864123-") ?? false, "the name starts with the epoch ms")
check(names == [first, second].compactMap { $0?.lastPathComponent }, "they sort in the order sent")
let sent = first.flatMap { try? Data(contentsOf: $0) }.flatMap(json)
check((sent as AnyObject?)?.isEqual("FlipView") ?? false, "the file holds the action's JSON")

// Another sidebar process, counting from 1 as well, sent in the same
// millisecond: the next name is taken, so this send takes the one after.
let taken = second.map { name in
    let n = Int(name.deletingPathExtension().lastPathComponent.suffix(6))! + 1
    return outbox.appendingPathComponent(String(format: "1791229864123-%06d.json", n))
}
if let taken { try? Data("\"FlipView\"".utf8).write(to: taken) }
let third = try? Outbox.write(.menu(.close), into: folder, now: now)
check(third != nil && third != taken, "a send whose name another process holds takes the next one")
let kept = taken.flatMap { try? Data(contentsOf: $0) }.flatMap(json)
check((kept as AnyObject?)?.isEqual("FlipView") ?? false, "and leaves the other process's file as it was")
let left = ((try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? [])
check(left.count == 4 && !left.contains { $0.hasPrefix(".") }, "no temp file is left: \(left.sorted())")
try? FileManager.default.removeItem(at: folder)

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all passed")
