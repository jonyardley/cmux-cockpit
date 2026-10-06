import Foundation

// Checks the sidebar's pure logic (Sidebar/Model/), compiled with the
// generated panel types by test.sh and run with the fixtures' folder and
// the pane's snapshots' folder as its arguments.
//
// The card words check: for each fixture, the words on each card are the
// words the terminal pane draws for that card in its 80 column snapshot of
// the same scene, card for card and in order.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

let args = CommandLine.arguments
guard args.count == 3 else {
    print("usage: views-check <fixtures folder> <pane snapshots folder>")
    exit(2)
}
let fixtures = URL(fileURLWithPath: args[1], isDirectory: true)
let snapshots = URL(fileURLWithPath: args[2], isDirectory: true)

// MARK: Card words against the pane's snapshots

/// Which of the pane's snapshots draws each fixture's scene. card-menu is
/// the lanes scene with a menu open over it (its lanes, Needs you and Next
/// equal lanes.json's, checked below); editor and new-project are the
/// projects scene with the editor open (their card rows equal
/// projects.json's, checked below). A new fixture fails until it is named.
let sceneOf: [String: String] = [
    "lanes": "lanes",
    "card-menu": "lanes",
    "needs-and-next": "needs-and-next",
    "review-verdicts": "review-verdicts",
    "projects": "projects",
    "editor": "projects",
    "new-project": "projects",
]

/// The words of each card and placeholder a snapshot draws, in order: a
/// row that starts at the card indent with a dot, hollow dot or
/// placeholder mark, then the rows indented under it. The strip and the
/// tabs above the first lane or project header are left out, as are
/// headers. Each card's words are its whitespace runs, its mark dropped.
func snapshotCards(_ text: String) -> [[String]] {
    let marks: Set<String> = ["●", "○", "◌"]
    var cards: [[String]] = []
    var inLanes = false
    var current: [String]?
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let tokens = line.split(whereSeparator: \.isWhitespace).map(String.init)
        let isCard = line.hasPrefix("   ") && !line.hasPrefix("    ") && tokens.first.map(marks.contains) == true
        let isMore = line.hasPrefix("     ") && current != nil
        if let c = current, !isMore {
            cards.append(c)
            current = nil
        }
        if !inLanes {
            inLanes = tokens.contains(Words.laneMark) && !isCard
            continue
        }
        if isCard {
            current = Array(tokens.dropFirst())
        } else if isMore {
            current?.append(contentsOf: tokens)
        }
    }
    if let c = current { cards.append(c) }
    return cards
}

/// The words the sidebar draws on each card and placeholder of a panel,
/// in order: the lanes in All, the card rows in Projects.
func panelCards(_ panel: Panel) -> [(title: String, words: [String])] {
    let split = { (runs: [String]) in runs.flatMap { $0.split(whereSeparator: \.isWhitespace).map(String.init) } }
    switch panel.view {
    case .all:
        return panel.lanes.flatMap(\.rows).map { row in
            let runs = CardText.runs(row)
            return (runs.first ?? "", split(runs))
        }
    case .projects:
        return panel.projects.compactMap(CardText.runs).map { ($0.first ?? "", split($0)) }
    }
}

func load(_ name: String) -> Panel? {
    guard let data = try? Data(contentsOf: fixtures.appendingPathComponent(name + ".json")) else { return nil }
    return try? JSONDecoder().decode(Panel.self, from: data)
}

let names = ((try? FileManager.default.contentsOfDirectory(atPath: fixtures.path)) ?? [])
    .filter { $0.hasSuffix(".json") }
    .map { String($0.dropLast(5)) }
    .sorted()
check(!names.isEmpty, "found the fixtures")
for name in names {
    guard let scene = sceneOf[name] else {
        check(false, "\(name): name the pane snapshot of its scene in sceneOf")
        continue
    }
    guard let panel = load(name) else {
        check(false, "\(name) decodes")
        continue
    }
    let path = snapshots.appendingPathComponent("\(scene)-80.txt")
    guard let text = try? String(contentsOf: path, encoding: .utf8) else {
        check(false, "\(name): read \(path.path)")
        continue
    }
    let drawn = snapshotCards(text)
    let ours = panelCards(panel)
    check(!ours.isEmpty, "\(name): has cards to compare")
    check(drawn.count == ours.count, "\(name): \(ours.count) cards, the pane draws \(drawn.count)")
    for (i, card) in ours.enumerated() where i < drawn.count {
        check(card.words == drawn[i], "\(name): card \"\(card.title)\" says \(card.words.joined(separator: " ")) | pane: \(drawn[i].joined(separator: " "))")
    }
}

// The scenes sceneOf shares really are the same cards.
if let lanes = load("lanes"), let menu = load("card-menu") {
    check(lanes.lanes == menu.lanes && lanes.needs == menu.needs && lanes.next == menu.next, "card-menu is lanes with a menu open")
}
if let projects = load("projects") {
    let cards = { (p: Panel) in p.projects.compactMap(CardText.runs) }
    for name in ["editor", "new-project"] {
        if let other = load(name) {
            check(cards(other) == cards(projects), "\(name) has the projects scene's cards")
        }
    }
}

// The fixed words the sidebar draws read as the pane draws them.
if let text = try? String(contentsOf: snapshots.appendingPathComponent("needs-and-next-80.txt"), encoding: .utf8),
    let panel = load("needs-and-next") {
    let lines = text.split(separator: "\n").map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
    let next = NextText.target(panel.next)
    check(lines.contains("\(Words.next) \(next.title) \(next.place)"), "Next reads as the pane's")
    check(lines.contains("\(Words.needs) \(panel.needs.count) \(panel.needs.wait)"), "Needs you reads as the pane's")
    check(lines.contains(panel.needs.more), "the strip's more line reads as the pane's")
    for row in panel.needs.rows {
        check(lines.contains("● \(row.title)") && lines.contains(row.line), "Needs you row \(row.title)")
    }
}
if let text = try? String(contentsOf: snapshots.appendingPathComponent("review-verdicts-80.txt"), encoding: .utf8) {
    check(text.contains("\(Words.next)  \(Words.nextNothing)"), "Next with nowhere to go reads as the pane's")
}

// MARK: Chips that fit

let none = [false, false, false]
check(ChipFit.fit([10, 10, 10], givesWay: none, gap: 2, room: 34, tail: 4) == .init(shown: [true, true, true], cut: false), "all chips fit")
check(ChipFit.fit([10, 10, 10], givesWay: none, gap: 2, room: 30, tail: 4) == .init(shown: [true, true, false], cut: true), "the last chip goes, an ellipsis after")
check(ChipFit.fit([10, 30, 10], givesWay: [false, true, false], gap: 2, room: 40, tail: 4) == .init(shown: [true, false, true], cut: true), "the branch gives way first")
check(ChipFit.fit([50], givesWay: [false], gap: 2, room: 10, tail: 4) == .init(shown: [false], cut: true), "a chip too wide for the line goes whole")
check(ChipFit.fit([], givesWay: [], gap: 2, room: 0, tail: 4) == .init(shown: [], cut: false), "no chips fit nothing")
check(ChipFit.width([10, 10], gap: 2) == 22 && ChipFit.width([], gap: 2) == 0, "a line's width counts the gaps between")

check(ChipFit.candidates(givesWay: [false, true, false]) == [[0, 1, 2], [0, 2], [0], []], "the lines to try: all, then the branch gone, then from the end")
check(ChipFit.candidates(givesWay: []) == [[], []], "no chips, nothing to try but nothing")

/// The first candidate that fits by width, as ViewThatFits picks it.
func firstFitting(_ widths: [Double], givesWay: [Bool], gap: Double, room: Double, tail: Double) -> ChipFit.Fit? {
    for (n, shown) in ChipFit.candidates(givesWay: givesWay).enumerated() {
        let cut = n > 0
        let w = ChipFit.width(shown.map { widths[$0] } + (cut ? [tail] : []), gap: gap)
        if w <= room {
            return .init(shown: widths.indices.map(shown.contains), cut: cut)
        }
    }
    return nil
}
for (widths, ways, room) in [([10.0, 10, 10], none, 34.0), ([10, 10, 10], none, 30), ([10, 30, 10], [false, true, false], 40), ([50], [false], 10)] {
    check(firstFitting(widths, givesWay: ways, gap: 2, room: room, tail: 4) == ChipFit.fit(widths, givesWay: ways, gap: 2, room: room, tail: 4), "the first line that fits is the pane's at \(room)")
}

// MARK: What the sidebar shows

let sample = load("lanes")
check(Showing.of(panel: nil, running: false) == .notRunning, "no panel, helper down: not running")
check(Showing.of(panel: nil, running: true) == .waiting, "no panel, helper up: waiting")
if let sample {
    check(Showing.of(panel: sample, running: true) == .panel(sample, stale: false), "a panel with the helper up is fresh")
    check(Showing.of(panel: sample, running: false) == .panel(sample, stale: true), "a panel with the helper down still shows, stale")
}

// panel.json is the panel inside the publisher's envelope.
if let data = try? Data(contentsOf: fixtures.appendingPathComponent("lanes.json")),
    let body = String(data: data, encoding: .utf8) {
    let wrapped = Data("{\"seq\": 3, \"written_at_ms\": 1791229864123, \"panel\": \(body)}".utf8)
    let file = PanelFile.decode(wrapped)
    check(file?.seq == 3 && file?.writtenAtMs == 1_791_229_864_123 && file?.panel == sample, "panel.json decodes as seq, time and panel")
    check(PanelFile.decode(data) == nil, "a bare panel is not panel.json")
    check(PanelFile.decode(Data("{\"seq\": 1".utf8)) == nil, "half a file decodes to nothing")
}

// MARK: Lane headers, Next and Needs you

if let panel = load("lanes") {
    for lane in panel.lanes {
        let mark = LaneText.chevron(lane)
        let want = lane.empty ? "" : (lane.collapsed ? Words.folded : Words.open)
        check(mark == want, "\(lane.name): fold mark")
        check(lane.collapsed ? lane.rows.isEmpty : true, "\(lane.name): a folded lane has no rows")
        if lane.empty { check(LaneText.pill(lane) == PillColors(bg: .countBg, fg: .faint), "\(lane.name): an empty lane's pill is quiet") }
    }
    check(NeedsText.shows(panel.needs), "Needs you shows while something waits")
}
if let panel = load("review-verdicts") {
    check(!NeedsText.shows(panel.needs), "Needs you hides with nothing waiting")
    check(NextText.isNothing(panel.next), "Next has nowhere to go")
}

// MARK: Colours

/// Relative luminance, as WCAG defines it, of a colour over `ground`.
func luminance(_ c: RGBA, over ground: RGBA) -> Double {
    let a = c.opacity
    let channel = { (top: Double, bottom: Double) -> Double in
        let v = top * a + bottom * (1 - a)
        return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(c.red, ground.red) + 0.7152 * channel(c.green, ground.green)
        + 0.0722 * channel(c.blue, ground.blue)
}

func contrast(_ a: RGBA, _ b: RGBA) -> Double {
    let la = luminance(a, over: b)
    let lb = luminance(b, over: b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}

for dark in [false, true] {
    let scheme = dark ? "dark" : "light"
    let ground = Palette.rgba(.ground, dark: dark)
    // Body ink at WCAG's 4.5; the state inks at 3, as the light palette
    // (palette.ts) holds them, the finished green the lowest.
    for (token, name) in [(Token.text, "text"), (.secondary, "secondary"), (.heading, "heading")] {
        check(contrast(Palette.rgba(token, dark: dark), ground) >= 4.5, "\(scheme): \(name) reads on the ground")
    }
    for (token, name) in [(Token.blueText, "blueText"), (.clayText, "clayText"), (.greenText, "greenText"), (.amberText, "amberText"), (.redText, "redText"), (.metaText, "metaText")] {
        check(contrast(Palette.rgba(token, dark: dark), ground) >= 3, "\(scheme): \(name) reads on the ground")
    }
    let hues = [Token.blue, .clay, .green, .amber].map { Palette.rgba($0, dark: dark) }
    check(Set(hues.map(\.hex)).count == hues.count, "\(scheme): each state hue is its own")
    check(Palette.rgba(.clear, dark: dark).alpha == 0, "\(scheme): clear is no colour")
}
check(Palette.rgba(.ground, dark: false) != Palette.rgba(.ground, dark: true), "light and dark grounds differ")
check(Palette.rgba(Token.clayHalo, dark: false).hex == Palette.rgba(Token.clay, dark: false).hex, "a halo is its hue at an alpha")

exit(failures == 0 ? 0 : 1)
