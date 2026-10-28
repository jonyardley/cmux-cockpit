import Foundation

// Checks the sidebar's own core (Sidebar/Live/SidebarCore.swift and
// Inbox.swift) linked to native/ffi as the extension links it: a golden
// scene's data.json loads and draws, a click redraws on the click, the
// effects it asks for land in outbox/ as files the runner takes, an answer
// in inbox/ is taken once and goes in, a move cmux refuses snaps back,
// and a card clicked draws selected on the click.
// test.sh builds native/ffi, then builds and runs this with the scene's
// input (test/golden/lanes.input.json) as its argument.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: core-check <scene.input.json>")
    exit(2)
}

let folder = FileManager.default.temporaryDirectory
    .appendingPathComponent("core-check-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
SidebarCore.folder = { folder }
var drawn: Panel?
SidebarCore.changed = { drawn = $0 }

@MainActor func lane(_ key: LaneKey) -> Lane? { drawn?.lanes.first { $0.key == key } }

@MainActor func ids(_ key: LaneKey) -> [String] {
    (lane(key)?.rows ?? []).compactMap {
        if case .card(let card) = $0 { card.wsId } else { nil }
    }
}

let outbox = folder.appendingPathComponent(Outbox.dirName)

/// Takes every effect file in the outbox, oldest first, as JSON.
@MainActor func sent() -> [[String: Any]] {
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? []).sorted()
    return names.compactMap { name in
        let file = outbox.appendingPathComponent(name)
        defer { try? FileManager.default.removeItem(at: file) }
        let data = try? Data(contentsOf: file)
        return data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    }
}

/// The names native/runner/src/effect.rs takes from outbox/.
let taken: Set = ["Cmux", "Persist", "PrPoll", "OpenUrl", "AgentMessage", "SavePrs"]

// MARK: Loading data.json

let input = (try? Data(contentsOf: URL(fileURLWithPath: args[1])))
    .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
var file = input
file["seq"] = 1
file["written_at_ms"] = 1
file["home"] = "/Users/coder"
let bytes = (try? JSONSerialization.data(withJSONObject: file)) ?? Data()
check(SidebarCore.load(bytes), "the scene's data.json loads")
check(drawn != nil, "and draws a panel")
check(SidebarCore.panel() == drawn, "the panel drawn is the core's")
let first = sent()
check(!first.isEmpty, "the first load asks for something: \(first.count) effects")
check(first.allSatisfy { $0.count == 1 && taken.contains($0.keys.first ?? "") }, "each effect is one the runner takes")
check(first.contains { $0["PrPoll"] != nil }, "the PR poll is on from the start")

drawn = nil
check(SidebarCore.load(bytes) && drawn == nil, "the same file again draws nothing")
check(!SidebarCore.load(Data("[1]".utf8)), "a file that is not data.json is refused")

// MARK: A click

check(lane("main")?.collapsed == nil, "nothing drawn yet")
check(SidebarCore.send(.toggleLane("main")), "a fold goes in")
check(lane("main")?.collapsed == true, "and draws folded on the click")
check(!SidebarCore.send(.refresh), "the shell's own input is not a click")
check(!SidebarCore.send(.at(now: 1, event: .flipView)), "nor is a stamped one")
SidebarCore.send(.toggleLane("main"))

// MARK: A move cmux refuses

let card = ids("main").first ?? ""
check(!card.isEmpty, "Main has a card to move")
_ = sent()
SidebarCore.send(.moveCard(id: card, lane: "review", before: nil))
check(ids("review").contains(card) && !ids("main").contains(card), "a drop draws the card in For review on the drop")
let move = sent()
check(move.contains { $0["Cmux"] != nil }, "and asks cmux to move it: \(move.map { $0.keys.sorted() })")

let inbox = folder.appendingPathComponent(Inbox.dirName)
try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
let refused = "{\"CmuxFailed\":{\"id\":\"\(card)\"}}"
try? Data(refused.utf8).write(to: inbox.appendingPathComponent("0000000000002-000001.json"))
try? Data("half".utf8).write(to: inbox.appendingPathComponent(".answer-1-2.tmp"))
let answers = Inbox.take(from: inbox.deletingLastPathComponent())
check(answers == [Data(refused.utf8)], "the inbox gives the whole answer and skips the one being written")
let left = (try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? []
check(left == [".answer-1-2.tmp"], "and deletes what it gave: \(left)")
answers.forEach(SidebarCore.answer)
check(ids("main").contains(card) && !ids("review").contains(card), "the refused move snaps back")

// MARK: A click's selection

/// The cards the lanes draw selected.
@MainActor func selected() -> [String] {
    (drawn?.lanes ?? []).flatMap(\.rows).compactMap {
        if case .card(let card) = $0, card.selected { card.wsId } else { nil }
    }
}

let clicked = (drawn?.lanes ?? []).filter { !$0.collapsed }.map(\.key).flatMap(ids).first { !selected().contains($0) } ?? ""
check(!clicked.isEmpty, "a lane has a card not selected to click")
_ = sent()
check(SidebarCore.send(.selected(id: clicked)), "the click cmux was asked for goes in")
check(selected() == [clicked], "and draws that card alone selected on the click: \(selected())")
check(sent().isEmpty, "with no cmux call of its own, since the SDK made it")

// MARK: Copy from the card menu

/// The first card whose menu offers `action`.
@MainActor func cardOffering(_ action: MenuAction) -> String? {
    (drawn?.lanes ?? []).flatMap(\.rows).compactMap { row -> String? in
        guard case .card(let card) = row else { return nil }
        let offers = card.menu.contains { if case .item(_, action) = $0 { true } else { false } }
        return offers ? card.wsId : nil
    }.first
}

var copied: [String] = []
SidebarCore.copy = { copied.append($0); return true }
for (action, looks) in [(MenuAction.copyPrLink, "https://"), (.copyBranch, "")] {
    guard let id = cardOffering(action) else {
        check(false, "a card offers \(action)")
        continue
    }
    copied = []
    _ = sent()
    for pick in SidebarAction.pick(action, on: id) { SidebarCore.send(pick) }
    let words = copied.first ?? ""
    check(copied.count == 1 && !words.isEmpty && words.hasPrefix(looks), "\(action) puts words on the clipboard on the click: \(copied)")
    check(sent().isEmpty, "and nothing goes to the outbox")
}
SidebarCore.copy = { _ in false }
if let id = cardOffering(.copyBranch) {
    let picks = SidebarAction.pick(.copyBranch, on: id)
    check(picks.map { SidebarCore.send($0) } == [true, false], "a copy the pasteboard refuses reports so")
}
SidebarCore.copy = { copied.append($0); return true }

// MARK: The clock

drawn = nil
SidebarCore.tick(now: Date(timeIntervalSince1970: 1_000_010))
check(drawn != nil, "a tick redraws, so a guess can lapse without new data")

try? FileManager.default.removeItem(at: folder)

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all passed")
