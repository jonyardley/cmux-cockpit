import Foundation

// Checks the drop rule and the drops waiting for panel.json
// (Sidebar/Live/PendingMove.swift): where a dropped card lands, how the
// lanes draw it before the panel shows it, and which panel shows it done.
// test.sh builds and runs it.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

func card(_ id: String, rank: UInt8 = 1) -> Card {
    Card(wsId: id, icon: Icon(glyph: "o", ink: nil), title: id, status: "", statusInk: .clear, leftOff: "",
         chips: [], merged: [], detail: "", detailLines: 1, waiting: false, rank: rank, movable: true, dimmed: false, menu: [])
}

func row(_ id: String, rank: UInt8 = 1) -> Row { .card(card(id, rank: rank)) }

func lane(_ key: LaneKey, _ rows: [Row], collapsed: Bool = false) -> Lane {
    Lane(key: key, empty: rows.isEmpty && !collapsed, name: "\(key)", faint: false, marker: .blue, anchor: nil,
         count: UInt64(rows.count), pill: PillColors(bg: .countBg, fg: .faint), dot: nil, collapsed: collapsed,
         mergeReady: "", rows: rows)
}

func ids(_ lane: Lane) -> [String] { lane.rows.map(DropRule.wsId) }

func move(_ id: String, from: LaneKey, to: LaneKey, before: String?, rank: UInt8 = 1, until: Date = .distantFuture) -> PendingMove {
    PendingMove(card: card(id, rank: rank), from: from, lane: to, before: before, until: until)
}

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
let ghosted: [Row] = [row("A"), .ghost(wsId: "G", title: "g", text: "t", rank: 1), row("C")]
check(DropRule.before(rows: ghosted, dragged: card("X"), slot: 1) == "G", "a placeholder anchors a drop as its card does")

// MARK: Letting go in its own place sends nothing

check(PendingMove.staysPut(abc, from: .main, card: card("B"), lane: .main, before: "C"), "B above C in its own lane stays put")
check(!PendingMove.staysPut(abc, from: .main, card: card("B"), lane: .main, before: "A"), "B above A is a move")
check(PendingMove.staysPut(abc, from: .main, card: card("C"), lane: .main, before: nil), "the last card at the end stays put")
check(!PendingMove.staysPut(abc, from: .main, card: card("C"), lane: .review, before: nil), "to another lane is a move")
check(move("W1", from: .main, to: .review, before: "W2").action == .moveCard(id: "W1", lane: .review, before: "W2"),
      "a drop sends the core's MoveCard")

// MARK: Drawn where it landed until the panel shows it

let main = lane(.main, [row("A"), row("B")])
let review = lane(.review, [row("R1"), row("R2")])
let toReview = move("A", from: .main, to: .review, before: "R2")
check(ids(PendingMove.show(main, [toReview])) == ["B"], "the source lane drops the moved card")
check(PendingMove.show(main, [toReview]).count == 1, "the source lane's count falls by one")
check(ids(PendingMove.show(review, [toReview])) == ["R1", "A", "R2"], "the target lane draws it above its before")
check(PendingMove.show(review, [toReview]).count == 3, "the target lane's count rises by one")
check(ids(PendingMove.show(review, [move("A", from: .main, to: .review, before: "gone")])) == ["R1", "R2", "A"],
      "a before that has gone puts it at the end")
let parked = lane(.parked, [], collapsed: true)
let toParked = move("A", from: .main, to: .parked, before: nil)
check(PendingMove.show(parked, [toParked]).rows.isEmpty, "a folded lane draws no rows")
check(PendingMove.show(parked, [toParked]).count == 1, "a folded lane's count shows the drop")
check(ids(PendingMove.show(main, [move("B", from: .main, to: .main, before: "A")])) == ["B", "A"], "a move within a lane reorders it")
let empty = lane(.bg, [])
check(!PendingMove.show(empty, [move("A", from: .main, to: .bg, before: nil)]).empty, "a card dropped on an empty lane is no longer empty")
let twice = [move("A", from: .main, to: .review, before: nil), move("B", from: .main, to: .review, before: "A")]
check(ids(PendingMove.show(review, twice)) == ["R1", "R2", "B", "A"], "two drops in a row both draw")
check(ids(PendingMove.show(main, twice)).isEmpty, "two drops in a row both leave the source")
// Already where the panel has it: drawing the move changes nothing, so a
// panel that shows it before the confirm lands does not flicker.
let done = lane(.review, [row("R1"), row("A"), row("R2")])
check(PendingMove.show(done, [toReview]) == done, "a move the panel already shows draws the same")

// MARK: Which panel shows the move done

check(!toReview.confirmed(by: review), "the target lane without the card is not done")
check(toReview.confirmed(by: done), "the target lane with the card is done")
check(!toReview.confirmed(by: main), "the source lane still holding it is not done")
check(toReview.confirmed(by: lane(.main, [row("B")])), "the source lane without it is done")
check(!toReview.confirmed(by: lane(.bg, [])), "another lane says nothing")
check(toParked.confirmed(by: lane(.main, [row("B")])), "a drop on a folded lane is done once the source lets go")
let reorder = move("B", from: .main, to: .main, before: "A")
check(!reorder.confirmed(by: main), "a reorder is not done while the old order shows")
check(reorder.confirmed(by: lane(.main, [row("B"), row("A")])), "a reorder is done once the new order shows")
check(move("A", from: .main, to: .main, before: nil).confirmed(by: lane(.main, [row("B"), row("A")])),
      "a move to the end is done once the card is last")

// MARK: A drop the panel never shows lapses

let now = Date()
let lapsing = [move("A", from: .main, to: .review, before: nil, until: now), move("B", from: .main, to: .review, before: nil, until: now.addingTimeInterval(1))]
// MARK: A whole panel.json against the drops waiting

let panelMain = lane(.main, [row("B")])
let panelReview = lane(.review, [row("R1"), row("A"), row("R2")])
check(PendingMove.unconfirmed([toReview], lanes: [panelMain, panelReview]).isEmpty,
      "a panel that shows the move done clears it")
let lagging = lane(.main, [.card(card("A", rank: 2)), row("B")])
let kept = PendingMove.unconfirmed([toReview], lanes: [lagging, review])
check(kept.count == 1 && kept.first?.card.rank == 2, "a panel that lags keeps the move, drawn with its fresh card")
check(PendingMove.unconfirmed([toParked], lanes: [lane(.main, [row("B")]), lane(.parked, [], collapsed: true)]).isEmpty,
      "a drop on a folded lane clears once the panel has it gone from its source")

check(PendingMove.live(lapsing, now: now).map(\.card.wsId) == ["B"], "a drop past its time is no longer drawn")
check(PendingMove.lasts == 4, "a drop is drawn for four seconds, as the TypeScript sidebar's override")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
