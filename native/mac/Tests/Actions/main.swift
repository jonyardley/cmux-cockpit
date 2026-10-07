import Foundation

// Checks what the panel's clicks and menus send (Sidebar/Model/
// SidebarAction.swift): every merged chip in every fixture is Park or
// Close, every card carries the core's menu, a pick goes as the menu
// opened on the card then the item, and blank words message no one.
// test.sh builds and runs it with native/fixtures/ as its argument.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: actions-check <fixtures dir>")
    exit(2)
}

let dir = URL(fileURLWithPath: args[1], isDirectory: true)
let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
    .filter { $0.hasSuffix(".json") }
    .sorted()
check(!names.isEmpty, "fixtures found in \(dir.path)")

func cards(_ panel: Panel) -> [Card] {
    let inLanes = panel.lanes.flatMap(\.rows).compactMap { row -> Card? in
        if case let .card(card) = row { return card }
        return nil
    }
    let inProjects = panel.projects.compactMap { row -> Card? in
        if case let .card(card) = row { return card }
        return nil
    }
    return inLanes + inProjects
}

var mergedSeen = 0
for name in names {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
          let panel = try? JSONDecoder().decode(Panel.self, from: data)
    else {
        check(false, "\(name) decodes")
        continue
    }
    let all = cards(panel)
    check(all.allSatisfy { !$0.menu.isEmpty }, "\(name): every card carries its menu")
    for card in all {
        for chip in card.merged {
            mergedSeen += 1
            let action = SidebarAction.merged(chip, id: card.wsId)
            check(
                action == .parkMerged(id: card.wsId) || action == .closeMerged(id: card.wsId),
                "\(name): \(card.title)'s merged chip sends Park or Close"
            )
        }
    }
}
check(mergedSeen > 0, "the fixtures hold merged chips to check (\(mergedSeen))")

let park = Chip(kind: .action, pieces: [Piece(text: "Park", ink: .secondary)], givesWay: false, url: nil, isAction: true)
let close = Chip(kind: .action, pieces: [Piece(text: "Close", ink: .text)], givesWay: false, url: nil, isAction: true)
let other = Chip(kind: .pr, pieces: [Piece(text: "#7", ink: .text)], givesWay: false, url: nil, isAction: false)
check(SidebarAction.merged(park, id: "W1") == .parkMerged(id: "W1"), "Park parks")
check(SidebarAction.merged(close, id: "W1") == .closeMerged(id: "W1"), "Close closes")
check(SidebarAction.merged(other, id: "W1") == nil, "any other chip sends nothing")

check(
    SidebarAction.pick(.lane(.parked), on: "W1") == [.menu(.openCard(id: "W1")), .menu(.pick(.lane(.parked)))],
    "a pick opens the card's menu, then picks"
)

check(SidebarAction.message(" \n\t", to: "W1") == nil, "blank words send nothing")
check(
    SidebarAction.message("  Rebase when free.\n", to: "W1") == .messageAgent(id: "W1", text: "Rebase when free."),
    "words go trimmed"
)

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all passed")
