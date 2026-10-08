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
         chips: [], rowPr: nil, detail: "", detailInk: .secondary, detailLines: 1, waiting: nil, rank: rank, movable: true, dimmed: false, selected: false, menu: [])
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

check(DropRule.staysPut(abc, from: "main", card: card("B"), lane: "main", before: "C"), "B above C in its own lane stays put")
check(!DropRule.staysPut(abc, from: "main", card: card("B"), lane: "main", before: "A"), "B above A is a move")
check(DropRule.staysPut(abc, from: "main", card: card("C"), lane: "main", before: nil), "the last card at the end stays put")
check(!DropRule.staysPut(abc, from: "main", card: card("C"), lane: "review", before: nil), "to another lane is a move")

// MARK: Make room

// A lane of 50pt cards 6pt apart, the lifted one (50pt) out of it: the
// others' middles as drawn with the gap at place 1 (its 50pt and a 6pt
// gap pushing the second card down by 56).
let tall = 50.0, step = 56.0
let flat = [25.0, 25 + step, 25 + 2 * step]
func drawn(gap: Int) -> [Double] { flat.enumerated().map { $0.offset >= gap ? $0.element + step : $0.element } }
func edges(_ mid: Double) -> (top: Double, bottom: Double) { (mid - tall / 2, mid + tall / 2) }
let all3 = 0...3

// The gap at 1 sits from 56 to 106, so a copy resting on it has its middle at 81.
var at = edges(81)
check(DropRule.place(current: 1, mids: drawn(gap: 1), top: at.top, bottom: at.bottom, within: all3) == 1,
      "a copy resting on the gap leaves it where it is")
// One place is the 6pt gap, half the next card and the 4pt slack: 35pt
// here, about 55pt for the cockpit's taller full cards.
at = edges(81 + 30)
check(DropRule.place(current: 1, mids: drawn(gap: 1), top: at.top, bottom: at.bottom, within: all3) == 1,
      "30pt down, its bottom edge short of the next card's middle, the gap holds")
at = edges(81 + 40)
check(DropRule.place(current: 1, mids: drawn(gap: 1), top: at.top, bottom: at.bottom, within: all3) == 2,
      "40pt down, past the next card's middle, the gap moves one place")
at = edges(81 - 40)
check(DropRule.place(current: 1, mids: drawn(gap: 1), top: at.top, bottom: at.bottom, within: all3) == 0,
      "40pt up, past the card above's middle, the gap moves up one place")
at = edges(81 + 40)
check(DropRule.place(current: 2, mids: drawn(gap: 2), top: at.top, bottom: at.bottom, within: all3) == 2,
      "once moved, the same copy holds the gap in its new place, so it never flickers back")
at = edges(81 + 3 * step)
check(DropRule.place(current: 1, mids: drawn(gap: 1), top: at.top, bottom: at.bottom, within: all3) == 3,
      "a fast drag past several cards moves the gap all the way in one look")
at = edges(90)
check(DropRule.place(current: nil, mids: flat, top: at.top, bottom: at.bottom, within: all3) == 2,
      "entering a lane with no gap yet, the copy's middle picks the place")
at = edges(81 + 40)
check(DropRule.place(current: 1, mids: [25, .infinity, .infinity], top: at.top, bottom: at.bottom, within: all3) == 1,
      "a card not laid out yet never lets the gap past it")
at = edges(25)
check(DropRule.place(current: 1, mids: [.infinity, 137, 193], top: at.top, bottom: at.bottom, within: all3) == 1,
      "nor does one above the gap: the gap never moves up past it")

// The gap stays in the dragged card's own state.
let states = [row("W1", rank: 0), row("R1", rank: 2), row("R2", rank: 2), row("D1", rank: 4)]
check(DropRule.places(states, dragged: card("X", rank: 2)) == 1...3, "a working card's gap runs from above the first working card to under the last")
check(DropRule.places(states, dragged: card("X", rank: 3)) == 3...3, "with none of its state, only the place its state sorts to")
check(DropRule.places(states, dragged: card("X", rank: 9)) == 4...4, "a state after every other sorts to the end")
check(DropRule.places([], dragged: card("X")) == 0...0, "an empty lane has one place")
at = edges(25)
check(DropRule.place(current: 1, mids: [25, 81 + step, 137 + step, 193 + step], top: at.top, bottom: at.bottom, within: 1...3) == 1,
      "dragged up over a waiting card, no gap opens among it: the gap stops at the first of its own state")
at = edges(400)
check(DropRule.place(current: nil, mids: [25, 81, 137, 193], top: at.top, bottom: at.bottom, within: 1...3) == 3,
      "dragged under a card of a later state, the gap stops after the last of its own")

// The gap as drawn, and the card a drop there goes above.
check(DropRule.drawnGap(tops: [0, 112, 168], gapTop: 56, gapHeight: 50) == 1, "the lifted row drawn at 56 is the gap at place 1")
check(DropRule.drawnGap(tops: [0, 56, 112], gapTop: 56, gapHeight: 0) == nil, "the lifted row folded to nothing is no gap")
check(DropRule.drawnGap(tops: [0, 56], gapTop: nil, gapHeight: 0) == nil, "a lane without the lifted row has no gap")
check(DropRule.before(abc, at: 1) == "B", "the gap at place 1 lands above the second card")
check(DropRule.before(abc, at: 3) == nil, "the gap after the last card lands at the end")
check(DropRule.place(of: "B", in: abc) == 1 && DropRule.place(of: nil, in: abc) == 3, "a drop above a card is the place before it")

// Which lane draws the gap, and where.
check(DropRule.gap(in: "main", rows: abc, collapsed: false, lifted: nil, from: nil, over: nil) == nil, "nothing lifted, no gap")
check(DropRule.gap(in: "main", rows: abc, collapsed: false, lifted: card("B"), from: "main", over: nil) == 1,
      "just lifted, before the drag is over a lane, the gap is the slot it left")
check(DropRule.gap(in: "main", rows: abc, collapsed: false, lifted: card("A"), from: "main", over: ("main", "C")) == 1,
      "A over its own lane above C: the gap is after B, the second place among B and C")
check(DropRule.gap(in: "main", rows: abc, collapsed: false, lifted: card("B"), from: "main", over: ("review", nil)) == nil,
      "over another lane, the slot it left closes")
check(DropRule.gap(in: "review", rows: abc, collapsed: false, lifted: card("X"), from: "main", over: ("review", nil)) == 3,
      "a card from another lane opens the gap at the end it would land")
check(DropRule.gap(in: "review", rows: abc, collapsed: true, lifted: card("X"), from: "main", over: ("review", nil)) == nil,
      "a folded lane opens no gap")
check(DropRule.gap(in: "review", rows: [], collapsed: false, lifted: card("X"), from: "main", over: ("review", nil)) == nil,
      "an empty lane opens no gap: its header lights instead")

// The rows a lane draws: the lifted row moves to the gap, never doubled.
let ids = { (rows: [Row]) in rows.map(DropRule.wsId) }
check(ids(DropRule.shown(abc, lifted: card("A"), gap: 2)) == ["B", "C", "A"], "A's row is drawn at the gap after C")
check(ids(DropRule.shown(abc, lifted: card("C"), gap: 0)) == ["C", "A", "B"], "C's row is drawn at the gap at the top")
check(ids(DropRule.shown(abc, lifted: card("B"), gap: nil)) == ["A", "B", "C"], "with no gap here, B's row stays in place to fold away")
check(ids(DropRule.shown(abc, lifted: card("X"), gap: 1)) == ["A", "X", "B", "C"], "a card from another lane is drawn at the gap")
check(ids(DropRule.shown(abc, lifted: nil, gap: 1)) == ["A", "B", "C"], "nothing lifted, the rows as they are")

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
