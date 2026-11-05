import Foundation

// Checks what the panel's clicks and menus send (Sidebar/Model/
// SidebarAction.swift): every action chip in every fixture is Make
// project, every card carries the core's menu, a pick goes as the menu
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

var actionsSeen = 0
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
        for chip in card.chips where chip.isAction {
            actionsSeen += 1
            check(
                ChipTap.of(chip, id: card.wsId) == .send(SidebarAction.pick(.newProjectFromFolder, on: card.wsId)),
                "\(name): \(card.title)'s action chip is Make project"
            )
        }
    }
}

check(actionsSeen > 0, "the fixtures hold a Make project chip to check (\(actionsSeen))")

let park = Chip(kind: .action, pieces: [Piece(text: "Park", ink: .secondary)], givesWay: false, url: nil, isAction: true)
check(ChipTap.of(park, id: "W1") == ChipTap.none, "a Park chip from an older core sends nothing")

check(
    SidebarAction.pick(.lane("parked"), on: "W1") == [.menu(.openCard(id: "W1")), .menu(.pick(.lane("parked")))],
    "a pick opens the card's menu, then picks"
)

// The add button: a project with a folder opens a session in it, one with
// none sends nothing; "No project" opens the home folder only once the
// core knows it. Every pick is one of Jon's actions.
var addSeen = 0
for name in names {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
          let panel = try? JSONDecoder().decode(Panel.self, from: data),
          let menu = AddText.menu(panel)
    else { continue }
    for project in menu.projects {
        addSeen += 1
        let sent = AddText.pick(project)
        check(sent == (project.canOpen ? .addSession(project: project.key) : nil), "\(name): \(project.name) picks as it can open")
        check(sent?.isAction != false, "\(name): \(project.name)'s pick is an action")
    }
    check(AddText.pickHome(menu) == (menu.home ? .addSession(project: nil) : nil), "\(name): No project picks once home is known")
}
check(addSeen > 0, "the fixtures hold an add menu to check (\(addSeen))")
let homeless = AddMenu(projects: [], home: false, homeChosen: false)
check(AddText.pickHome(homeless) == nil, "No project sends nothing with no home known")
check(AddText.pickHome(AddMenu(projects: [], home: true, homeChosen: false)) == .addSession(project: nil), "No project opens the home folder")

// The filter: a project's pick filters to it, No project to the key the
// core gave, Everything clears; every pick is one of Jon's actions.
var filterSeen = 0
for name in names {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
          let panel = try? JSONDecoder().decode(Panel.self, from: data),
          let menu = FilterText.menu(panel)
    else { continue }
    for project in menu.projects {
        filterSeen += 1
        check(FilterText.pick(project) == .filterProject(key: project.key), "\(name): \(project.name) filters to it")
    }
    check(FilterText.pickNoProject(menu) == .filterProject(key: menu.noProject), "\(name): No project filters by the core's key")
}
check(filterSeen > 0, "the fixtures hold a filter menu to check (\(filterSeen))")
check(FilterText.clear == .filterProject(key: nil), "Everything and the chip's x clear the filter")
check(FilterText.clear.isAction, "a filter pick is an action")

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
