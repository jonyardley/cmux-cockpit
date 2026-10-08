import Foundation
import UniformTypeIdentifiers

// Checks the drop rule (Sidebar/Model/DropRule.swift): where a dropped
// card lands and when letting go leaves it put; and what a card's drag
// carries (Sidebar/Views/DragItem.swift). The core draws the move itself,
// which native/core and test.sh's core check cover.
// test.sh builds and runs it.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

func card(_ id: String, rank: UInt8 = 1) -> Card {
    Card(wsId: id, icon: Icon(glyph: "o", ink: nil), title: id, density: .full, badge: Badge(icon: "terminal", color: nil),
         unread: "", ready: false, pinned: false, progress: nil, helpers: "", status: "", statusInk: .clear, age: "", statusHasAge: false, leftOff: "",
         chips: [], detail: "", detailInk: .secondary, detailLines: 1, waiting: nil, rank: rank, movable: true, dimmed: false, selected: false, menu: [])
}

func row(_ id: String, rank: UInt8 = 1) -> Row { .card(card(id, rank: rank)) }

// MARK: The slot under the pointer

check(DropRule.slot(y: 5, mids: [10, 30, 50]) == 0, "above the first row's middle is slot 0")
check(DropRule.slot(y: 31, mids: [10, 30, 50]) == 2, "past the second row's middle is slot 2")
check(DropRule.slot(y: 99, mids: [10, 30, 50]) == 3, "under every row is the end")

// MARK: Where the card lands

let abc = [row("A"), row("B"), row("C")]
check(DropRule.before(rows: abc, dragged: card("X"), slot: 0) == "A", "a card from another lane at the top goes above the first")
check(DropRule.before(rows: abc, dragged: card("X"), slot: 2) == "C", "between B and C goes above C")
check(DropRule.before(rows: abc, dragged: card("X"), slot: 3) == nil, "at the bottom goes to the end")
check(DropRule.before(rows: abc, dragged: card("A"), slot: 3) == nil, "A dragged to the bottom of its own lane goes to the end")
check(DropRule.before(rows: abc, dragged: card("C"), slot: 1) == "B", "C dragged above B goes above B")
check(DropRule.before(rows: abc, dragged: card("A"), slot: 2) == "C", "A's own slot is not counted: under B is above C")
check(DropRule.before(rows: abc, dragged: card("B"), slot: 1) == "C", "B let go in its own slot stays above C")
check(DropRule.before(rows: abc, dragged: card("X"), slot: -4) == "A", "a slot above the lane clamps to the top")
check(DropRule.before(rows: abc, dragged: card("X"), slot: 9) == nil, "a slot past the lane clamps to the end")
check(DropRule.before(rows: [], dragged: card("X"), slot: 0) == nil, "an empty lane takes the card at its end")

// Cards sort by state in a lane, so a drop anchors among its own state.
let ranked = [row("W1", rank: 0), row("W2", rank: 0), row("R1", rank: 2), row("R2", rank: 2)]
check(DropRule.before(rows: ranked, dragged: card("X", rank: 2), slot: 0) == "R1",
      "a card dropped above cards of another state goes above the first of its own")
check(DropRule.before(rows: ranked, dragged: card("X", rank: 0), slot: 4) == "R1",
      "a card dropped under cards of another state goes after the last of its own")
check(DropRule.before(rows: ranked, dragged: card("X", rank: 5), slot: 3) == "R2",
      "with none of its state in the lane it goes above the row under the slot")
var asking = card("G")
asking.waiting = Waiting(edge: .amber, ink: .amberText)
let waited: [Row] = [row("A"), .card(asking), row("C")]
check(DropRule.before(rows: waited, dragged: card("X"), slot: 1) == "G", "a waiting card anchors a drop as any card does")

// MARK: Letting go in its own place sends nothing

check(DropRule.staysPut(abc, from: .main, card: card("B"), lane: .main, before: "C"), "B above C in its own lane stays put")
check(!DropRule.staysPut(abc, from: .main, card: card("B"), lane: .main, before: "A"), "B above A is a move")
check(DropRule.staysPut(abc, from: .main, card: card("C"), lane: .main, before: nil), "the last card at the end stays put")
check(!DropRule.staysPut(abc, from: .main, card: card("C"), lane: .review, before: nil), "to another lane is a move")

// MARK: What a drag carries

let carried = DragItem.provider(card("A"))
check(carried.registeredTypeIdentifiers == ["dev.jonyardley.cockpit.card"], "a drag carries our own type and nothing else")
check(!carried.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), "a drag carries no text, so a terminal types nothing")
check(!carried.hasItemConformingToTypeIdentifier(UTType.url.identifier), "a drag carries no link or file")
check(!DragItem.type.conforms(to: .text), "our type is not text")

// The shipped declaration, which the code's own fallback above cannot see:
// the identifier the code asks for, conforming to data and nothing textual.
let plist = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Sidebar/Info.plist"
let declared = (NSDictionary(contentsOfFile: plist)?["UTExportedTypeDeclarations"] as? [[String: Any]])?
    .first { $0["UTTypeIdentifier"] as? String == DragItem.type.identifier }
check(declared != nil, "Info.plist declares the type the drag carries")
let conforms = declared?["UTTypeConformsTo"] as? [String] ?? []
check(conforms == [UTType.data.identifier], "Info.plist declares it as plain data")
check(conforms.allSatisfy { UTType($0)?.conforms(to: .text) != true }, "Info.plist declares nothing textual")
check(await DragItem.read(carried) == DragItem.text(card("A")), "a drop on a lane reads the card back")
check(await DragItem.read(NSItemProvider(object: DragItem.text(card("A")) as NSString)) == nil,
      "text that spells a card, dragged in from elsewhere, carries no card")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
