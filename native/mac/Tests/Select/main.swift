import Foundation

// Checks the click waiting for panel.json (Sidebar/Live/PendingSelect.swift):
// what draws selected while it waits, and which panel shows it done or
// overtaken. test.sh builds and runs it with native/fixtures/ as its
// argument, for a panel to build the scenes on.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

guard CommandLine.arguments.count == 2 else {
    print("usage: select-check <fixtures dir>")
    exit(2)
}
let file = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("lanes.json")
guard let data = try? Data(contentsOf: file), let base = try? JSONDecoder().decode(Panel.self, from: data) else {
    print("FAIL: lanes.json decodes")
    exit(1)
}

func card(_ id: String, selected: Bool = false) -> Card {
    Card(wsId: id, icon: Icon(glyph: "o", ink: nil), title: id, status: "", statusInk: .clear, leftOff: "",
         chips: [], merged: [], detail: "", detailLines: 1, waiting: false, rank: 1, movable: true, dimmed: false,
         selected: selected, menu: [])
}

func lane(_ rows: [Row], anchor: Anchor? = nil) -> Lane {
    Lane(key: .main, empty: rows.isEmpty, name: "Main", faint: false, marker: .blue, anchor: anchor,
         count: UInt64(rows.count), pill: PillColors(bg: .countBg, fg: .faint), dot: nil, collapsed: false,
         mergeReady: "", rows: rows)
}

/// A panel whose lanes hold A and B, `selected` the one cmux has.
func panel(selected: String?, projects: [ProjectRow] = []) -> Panel {
    var next = base
    next.lanes = [lane(["A", "B"].map { .card(card($0, selected: $0 == selected)) })]
    next.projects = projects
    return next
}

let clickB = PendingSelect(id: "B", was: ["A"])

// MARK: The click

check(PendingSelect.clicked("B", selected: ["A"]) == clickB, "a click on B while A is selected waits for B")
check(PendingSelect.clicked("A", selected: ["A"]) == nil, "a click on the card already selected waits for nothing")
check(PendingSelect.clicked("B", selected: []) == PendingSelect(id: "B", was: []),
      "a click with nothing drawn selected still waits")

// MARK: What draws selected

check(PendingSelect.shows("A", selected: true, pending: nil), "with no click waiting, the panel's selected card draws selected")
check(!PendingSelect.shows("B", selected: false, pending: nil), "with no click waiting, the others draw plain")
check(PendingSelect.shows("B", selected: false, pending: clickB), "the clicked card draws selected before the panel shows it")
check(!PendingSelect.shows("A", selected: true, pending: clickB), "the card the panel still has selected loses its outline on the click")

// MARK: What the panel drew

check(PendingSelect.selected(in: panel(selected: "A")) == ["A"], "the panel's selected set is the one card cmux has")
check(PendingSelect.selected(in: panel(selected: nil, projects: [.card(card("B", selected: true))])) == ["B"],
      "a card selected in the Projects view counts")
let anchored = { () -> Panel in
    var next = panel(selected: nil)
    next.lanes = [lane([], anchor: Anchor(id: "B", selected: true, icon: Icon(glyph: "o", ink: nil), unread: ""))]
    return next
}()
check(PendingSelect.selected(in: anchored) == ["B"], "a lane anchor selected counts")

// MARK: What a fresh panel makes of the click

check(clickB.outcome(["A"]) == .waiting, "a panel still on A keeps the click waiting")
check(clickB.outcome(["B"]) == .shown, "a panel with B selected shows the click done")
check(clickB.outcome([]) == .waiting, "a panel with nothing drawn selected keeps the click waiting")
check(clickB.outcome(["C"]) == .movedOn, "a panel that moved on to C (Next, or a switch in cmux) ends the click")
check(PendingSelect(id: "B", was: []).outcome(["A"]) == .movedOn,
      "a click made with nothing drawn selected ends when the panel shows another")
check(PendingSelect.lasts == 4, "a click holds four seconds, as the TypeScript sidebar's tap does")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("all select checks passed")
