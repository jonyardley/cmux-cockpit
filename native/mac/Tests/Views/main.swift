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

/// The pane's bar down the lead of a card waiting on Jon (native/pane/
/// src/views/lanes.rs WAITING_BAR): a mark, read as the blank it stands in.
let waitingBar: Character = "▎"

/// The words of each card a snapshot draws, in order: a row that starts
/// at the card indent with a dot or hollow dot, then the rows indented
/// under it. The Needs you line and the tabs above the first lane or
/// project header are left out, as are headers. Each card's words are its
/// whitespace runs, its mark dropped.
func snapshotCards(_ text: String) -> [[String]] {
    let marks: Set<String> = ["●", "○"]
    var cards: [[String]] = []
    var inLanes = false
    var current: [String]?
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(raw.map { $0 == waitingBar ? " " : $0 })
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

/// The words the sidebar draws on each card of a panel,
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
    check(NextText.targetId(panel.next) == "n1", "a Next click outlines the card it goes to")
    check(lines.contains("\(panel.needs.label) \(panel.needs.wait)"), "Needs you reads as the pane's line")
    check(NeedsText.count(panel.needs) == "5", "the All tab counts 5")
    check(panel.needs.fill == .clay && panel.needs.ink == .clayText, "the count is clay while one waits late")
    check(Palette.rgba(Palette.Own.onFill, dark: false) == RGBA(0xFFFFFF), "the count's number is white on the core's fill")
    check(NeedsText.tap(panel.needs, from: .all) == [.reveal(id: "n1")], "a click on the count reveals the oldest waiting session")
    check(NeedsText.tap(panel.needs, from: .projects) == [.flipView, .reveal(id: "n1")],
          "from Projects, a click on the count goes back to All first")
    check(!TopText.showsNext(panel), "Next's line stays off while something waits: the All tab's count leads there")
    // A waiting row (Unsorted's one-line rows) keeps its age as its status
    // and says its reason on its detail line, in the waiting ink. The
    // scene's n1 ended on no label, so its row quotes the reply's last line
    // bare, with no "Your turn:", in grey.
    let rows = panel.lanes.flatMap(\.rows).map { r -> Card in
        switch r { case .card(let c): c }
    }
    let waitingRows = rows.filter { $0.density == .row && $0.waiting != nil }
    check(!waitingRows.isEmpty, "needs-and-next has waiting rows")
    for c in waitingRows {
        let quoted = c.wsId == "n1"
        check(c.status == c.age && c.detail.contains(": ") != quoted, "\(c.title): its age as status, its reason as detail")
        check(c.detailInk == (quoted ? .secondary : c.waiting?.ink), "\(c.title): the reason in the waiting ink, or grey quoted")
        check(lines.contains { $0.hasSuffix(c.detail) }, "\(c.title): the reason reads as the pane's line")
    }
    for c in rows where c.waiting == nil {
        check(c.detailInk == .secondary, "\(c.title): a detail not waiting is secondary")
    }
    var quiet = panel
    quiet.needs.count = 0
    quiet.needs.target = nil
    check(TopText.showsNext(quiet), "with nothing waiting, Next's line shows while it has somewhere to go")
    // On the only waiting session, the count still shows and taps to nothing.
    var alone = panel.needs
    alone.count = 1
    alone.target = nil
    check(NeedsText.shows(alone) && NeedsText.tap(alone, from: .all).isEmpty,
          "the count on the only waiting session shows and taps to nothing")
    check(NeedsText.tap(alone, from: .projects) == [.flipView],
          "from Projects, the count on the only waiting session still flips back to All")
}
if let text = try? String(contentsOf: snapshots.appendingPathComponent("review-verdicts-80.txt"), encoding: .utf8) {
    check(text.contains("\(Words.next)  \(Words.nextNothing)"), "Next with nowhere to go reads as the pane's")
}

if let panel = load("lanes") {
    let rows = panel.lanes.flatMap(\.rows)
    check(Set(rows.map(\.id)).count == rows.count, "each lane row has its own id")
    // A waiting card stays in its lane (issue #314): it draws the needs dot
    // on its badge in its waiting colour, its reason on its status line and
    // its age on the title row in the same ink, and shows its x.
    let cards = rows.map { r -> Card in
        switch r { case .card(let c): c }
    }
    let waiting = cards.filter { $0.waiting != nil }
    check(waiting.count == Int(panel.needs.count), "lanes: every waiting card is in its lane, \(waiting.count) of \(panel.needs.count)")
    if let chip = waiting.first(where: { $0.title == "Chip colours" }) {
        check(CardText.mark(chip) == .clay && chip.status.hasPrefix("Your turn: "), "Your turn draws a clay dot and its reason")
        check(CardText.dismissable(chip), "a waiting card shows its x under the pointer")
        check(CardText.ageInk(chip) == .clayText && CardText.titleAge(chip) == chip.age && !chip.age.isEmpty, "its age on the title row, in clay")
        check(chip.chips.allSatisfy { $0.kind != .size || $0.pieces.allSatisfy { $0.ink == .secondary } }, "its size chip is neutral, not a state ink")
    } else {
        check(false, "lanes: Chip colours waits")
    }
    if let ask = waiting.first(where: { $0.title == "Release notes" }) {
        check(CardText.mark(ask) == .amber && ask.status == "Asking: allow git push?", "Asking draws an amber dot and its reason")
    } else {
        check(false, "lanes: Release notes asks")
    }
    for c in cards where c.waiting == nil {
        check(CardText.mark(c) == nil && CardText.ageInk(c) == .metaText && !CardText.dismissable(c),
              "\(c.title): no dot, no x and its age in the meta ink while it waits on nobody")
    }
}

// MARK: What the sidebar shows

let sample = load("lanes")
check(Showing.of(panel: nil, running: false) == .notRunning, "no panel, helper down: not running")
check(Showing.of(panel: nil, running: true) == .waiting, "no panel, helper up: waiting")
if let sample {
    check(Showing.of(panel: sample, running: true) == .panel(sample, stale: false), "a panel with the helper up is fresh")
    check(Showing.of(panel: sample, running: false) == .panel(sample, stale: true), "a panel with the helper down still shows, stale")
}

// MARK: Lane headers, Next and Needs you

if let panel = load("lanes") {
    for lane in panel.lanes {
        let mark = LaneText.chevron(lane)
        let want = lane.empty ? "" : (lane.collapsed ? Words.folded : Words.open)
        check(mark == want, "\(lane.name): fold mark")
        check(lane.collapsed ? lane.rows.isEmpty : true, "\(lane.name): a folded lane has no rows")
        check(lane.dropHint.text == "Drop here" && lane.dropHint.ink == .heading, "\(lane.name): Drop here in the heading ink, from the core")
        check(lane.mergeInk == (lane.faint ? .faint : .mergeText), "\(lane.name): its merge line in the merge green, or faint")
    }
    check(NeedsText.shows(panel.needs), "Needs you shows while something waits")
    // Every lane with a waiting card dots its heading, folded or open, in
    // clay while any of them is Your turn (issue #314).
    for lane in panel.lanes {
        let marks = lane.rows.compactMap { r -> Token? in
            switch r { case .card(let c): CardText.mark(c) }
        }
        if !marks.isEmpty {
            let want: Token = marks.contains(.clay) ? .clay : .amber
            check(lane.dot?.ink == want, "\(lane.name): its heading's dot is the needs dot")
        }
    }
}
if let panel = load("review-verdicts") {
    check(!NeedsText.shows(panel.needs), "Needs you hides with nothing waiting")
    check(!TopText.showsNext(panel), "Next's line hides with nowhere to go")
    check(NextText.isNothing(panel.next), "Next has nowhere to go")
    check(NextText.targetId(panel.next) == nil, "a Next click with nowhere to go outlines nothing")
    for lane in panel.lanes where !lane.mergeReady.isEmpty {
        check(lane.mergeInk == .mergeText || lane.faint, "\(lane.name): ready to merge in the merge green")
    }
    let empty = panel.lanes.filter(\.empty)
    check(!empty.isEmpty, "review-verdicts has an empty lane")
    for lane in empty {
        check(lane.pill.fg != .faint, "\(lane.name): an empty lane's pill takes the core's tint, faded but never faint")
        check(lane.mergeInk == (lane.faint ? .faint : .mergeText), "\(lane.name): its merge ink follows its faint heading")
    }
}
if let panel = load("needs-and-next") {
    check(NextText.ink(panel.next) == .greenText, "Next is in Ready's green, as the core picks it")
    let cards = panel.lanes.flatMap(\.rows).compactMap { r -> Card? in
        if case .card(let c) = r { return c }
        return nil
    }
    check(!cards.isEmpty && cards.allSatisfy { $0.readyInk == .greenText }, "the Ready pill's ink is the core's finished green")
}
check(NextText.ink(.nothing) == .metaText, "Next with nowhere to go is in the meta ink")

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
    // The two grounds words sit on: the panel's off-white and a card's
    // solid face.
    let grounds = [("panel ground", Palette.rgba(.panelGround, dark: dark)), ("card face", Palette.rgba(.card, dark: dark))]
    for (where_, ground) in grounds {
        // Body ink at WCAG's 4.5; the state inks at 3, the finished green
        // the lowest.
        for (token, name) in [(Token.text, "text"), (.secondary, "secondary"), (.heading, "heading")] {
            check(contrast(Palette.rgba(token, dark: dark), ground) >= 4.5, "\(scheme): \(name) reads on the \(where_)")
        }
        for (token, name) in [(Token.blueText, "blueText"), (.clayText, "clayText"), (.greenText, "greenText"), (.amberText, "amberText"), (.redText, "redText"), (.metaText, "metaText")] {
            check(contrast(Palette.rgba(token, dark: dark), ground) >= 3, "\(scheme): \(name) reads on the \(where_)")
        }
    }
    // The helper-down notice sits on a countBg band: its title in text and
    // its why in secondary.
    for (token, name) in [(Token.text, "text"), (.secondary, "secondary")] {
        check(contrast(Palette.rgba(token, dark: dark), Palette.rgba(.countBg, dark: dark)) >= 4.5, "\(scheme): \(name) reads on the notice's countBg band")
    }
    // The third ink sits on the panel and on cards.
    for (where_, ground) in grounds {
        check(contrast(Palette.rgba(.tertiary, dark: dark), ground) >= 4.5, "\(scheme): tertiary reads on the \(where_)")
    }
    // A card's face differs from the panel; the card's hairline edge does
    // the rest of the work of reading as a tile.
    check(Palette.rgba(.card, dark: dark) != Palette.rgba(.panelGround, dark: dark), "\(scheme): a card's face is not the panel ground")
    let hues = [Token.blue, .clay, .green, .amber].map { Palette.rgba($0, dark: dark) }
    check(Set(hues.map(\.hex)).count == hues.count, "\(scheme): each state hue is its own")
    check(Palette.rgba(.clear, dark: dark).alpha == 0, "\(scheme): clear is no colour")
}
check(Palette.rgba(.panelGround, dark: false) != Palette.rgba(.panelGround, dark: true), "light and dark panel grounds differ")

// The light side of the extension's own colours, pinned here; see
// docs/design.md "Colour".
for (own, hex) in [(Palette.Own.tertiary, 0x73726C), (.grey, 0xA09E95)] as [(Palette.Own, UInt32)] {
    check(Palette.rgba(own, dark: false) == RGBA(hex), "light \(own) is \(String(format: "%06X", hex))")
}
check(Palette.rgba(Token.clayHalo, dark: false).hex == Palette.rgba(Token.clay, dark: false).hex, "a halo is its hue at an alpha")

// MARK: Projects

/// A line's words, one space apart.
func squeezed(_ line: Substring) -> String {
    line.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

// Each Projects row that is not a card reads as the pane draws it, in the
// pane's order: the headers, "+ New project", Quiet and the quiet rows.
if let panel = load("projects"),
    let text = try? String(contentsOf: snapshots.appendingPathComponent("projects-80.txt"), encoding: .utf8) {
    let lines = text.split(separator: "\n").map(squeezed)
    let rows = panel.projects.compactMap(ProjectText.words).map { $0.joined(separator: " ") }
    check(rows.count >= 4, "projects: has headers, + New project, Quiet and a quiet row")
    var at = 0
    for row in rows {
        let found = lines[at...].firstIndex(of: row)
        check(found != nil, "projects: \"\(row)\" reads as the pane's, in its order")
        if let found { at = found + 1 }
    }
    let heads = panel.projects.compactMap { r -> ProjectHead? in
        if case .header(let h) = r { return h }
        return nil
    }
    check(heads.allSatisfy { !$0.menu.isEmpty }, "projects: every header has its menu")
    check(Set(panel.projects.map(\.id)).count == panel.projects.count, "projects: each row has its own id")
    check(ProjectText.editor(panel) == nil, "projects: no editor open")
}
if let projects = load("projects") {
    let words = { (p: Panel) in p.projects.compactMap(ProjectText.words) }
    for name in ["editor", "new-project"] {
        if let other = load(name) {
            check(words(other) == words(projects), "\(name) lists the projects scene's rows")
            check(ProjectText.listed(other).count == other.projects.count - 1, "\(name): the editor is the sheet, not a row")
            let e = ProjectText.editor(other)
            check(e != nil, "\(name): the editor is open")
            check(e.map { $0.colors.count == 16 && $0.colors.allSatisfy { ProjectText.hex($0) != nil } } == true, "\(name): sixteen colours, each a hex")
        }
    }
    check(load("new-project").flatMap(ProjectText.editor)?.isNew == true, "new-project's editor is new")
}

// The words the sidebar keeps for itself are the core's. The core is found
// from this file, not from the snapshots folder, so it needs no pane.
let native = URL(fileURLWithPath: #filePath).appendingPathComponent("../../../..").standardizedFileURL
func source(_ path: String) -> String {
    (try? String(contentsOf: native.appendingPathComponent(path), encoding: .utf8)) ?? ""
}
let panelRs = source("core/src/panel/mod.rs")
for (name, word) in [("NEW_PROJECT_LABEL", Words.newProject), ("QUIET_LABEL", Words.quiet), ("PLUS_MARK", Words.plus)] {
    check(panelRs.contains("pub const \(name): &str = \"\(word)\";"), "\(name) is \"\(word)\"")
}
// The editor's words, pinned here.
let editorWords = [
    (Words.folder, "Folder"), (Words.name, "Name"), (Words.colour, "Colour"), (Words.icon, "Icon"),
    (Words.newProjectTitle, "New project"), (Words.editProjectTitle, "Edit project"), (Words.add, "Add"), (Words.done, "Done"), (Words.cancel, "Cancel"),
    (Words.projectName, "Project name"), (Words.searchIcons, "Search icons"), (Words.openFolders, "Or one you have open"),
]
for (word, pinned) in editorWords {
    check(word == pinned, "the editor's \"\(pinned)\"")
}
// The sidebar's own words outside the editor, pinned here. "Drop here"
// is the core's, carried on each lane.
let ownWords = [
    (Words.ready, "Ready"), (Words.messageAgent, "Message agent…"),
    (Words.messagePrompt, "Message for the agent in"), (Words.send, "Send"),
    (Words.notSent, "Not sent: the cockpit could not take it. Try again."),
]
for (word, pinned) in ownWords {
    check(word == pinned, "the sidebar's \"\(pinned)\"")
}
// A badge's corner is 0.3 of its side, rounded (docs/design.md#badge-tile).
for (side, corner) in [(26.0, 8.0), (22, 7), (18, 5), (16, 5), (14, 4), (9, 3)] {
    check(BadgeCorner.radius(side) == corner, "a \(Int(side)) badge's corner is \(Int(corner))")
}
// The light side of the panel's own colours, pinned here.
let ownLight: [(Palette.Own, RGBA)] = [
    (.card, RGBA(0xFFFFFF)), (.readyEdge, RGBA(0x788C5D, 0x47)), (.cardHover, RGBA(0xF7F6F2)),
    (.hover, RGBA(0x7F7F7F, 0x14)), (.dropTarget, RGBA(0x141413, 0x1F)), (.zoneLit, RGBA(0xE7E4D9)),
]
for (own, pinned) in ownLight {
    check(Palette.rgba(own, dark: false) == pinned, "light \(own) is pinned")
}
// The lane hues' light side, pinned here.
for (token, hex) in [(Token.laneViolet, 0x7A5BA6), (.laneTeal, 0x2E8A86), (.laneRose, 0xB04A75)] as [(Token, UInt32)] {
    check(Palette.rgba(token, dark: false) == RGBA(hex), "light \(token) is \(String(format: "%06X", hex))")
}
check(Palette.rgba(.readyBg, dark: false) == RGBA(Palette.rgba(Token.green, dark: false).hex, 0x1F), "readyBg is the finished green, faint")
check(Palette.rgba(.readyEdge, dark: false).hex == Palette.rgba(Token.green, dark: false).hex, "Next's edge is the Ready pill's green")
if let panel = load("projects") {
    let pills = panel.projects.compactMap { r -> PillColors? in
        if case .quietHeader(_, _, let pill) = r { return pill }
        return nil
    }
    check(pills == [PillColors(bg: .countBg, fg: .metaText)], "the Quiet pill is the core's QUIET_PILL, carried on its row")
}

// "+ New project" draws its plus as an icon, so its label is the words
// alone; a quiet project with no folder fades, one with a folder does not.
check(ProjectText.newProjectLabel == "New project", "+ New project's label drops the plus it draws as an icon")
check(ProjectText.quietOpacity(canOpen: true) == 1, "a quiet project with a folder is whole")
check(ProjectText.quietOpacity(canOpen: false) == 0.55, "a quiet project with no folder fades to 0.55")
if let panel = load("projects") {
    let icons = panel.projects.compactMap { r -> String? in
        switch r {
        case .header(let h): h.icon
        case .quiet(_, _, _, _, let icon, _, _): icon
        default: nil
        }
    }
    check(!icons.isEmpty && icons.allSatisfy { !$0.isEmpty }, "projects: every header and quiet row has an icon for its badge")
}

// Copy PR link and Copy branch sit straight after Open PR, on a card that
// has a PR link or a branch, and on no other.
if let panel = load("lanes") {
    let menus = panel.lanes.flatMap(\.rows).compactMap { row -> [MenuItem]? in
        guard case .card(let card) = row else { return nil }
        return card.menu
    }
    let words = { (menu: [MenuItem]) in menu.map { if case .item(let label, _) = $0 { label } else { "" } } }
    check(menus.contains { words($0).contains("Copy PR link") && words($0).contains("Copy branch") }, "lanes: a card offers both copies")
    check(menus.contains { !words($0).contains("Copy PR link") }, "lanes: a card with no PR link offers no Copy PR link")
    for menu in menus {
        let copies = words(menu).filter { $0.hasPrefix("Copy ") }
        let at = menu.firstIndex { if case .item(_, .openPr) = $0 { true } else { false } }
        let after = at.map { Array(words(menu).dropFirst($0 + 1).prefix(copies.count)) }
        check(after == copies, "lanes: \(copies) follow Open PR")
    }
}
check(SidebarAction.pick(.copyBranch, on: "W1") == [.menu(.openCard(id: "W1")), .menu(.pick(.copyBranch))], "Copy branch opens its card's menu first")

// A pick opens the menu it was made from, then picks, in that order.
check(ProjectMenu.pick(.editProject, key: "k", quiet: true) == [.menu(.openProject(key: "k", quiet: true)), .menu(.pick(.editProject))], "a project menu pick opens its menu first")

// Typing in the sheet only ever edits: each change is one edit, and the
// sheet's source sends through nothing but its edit-only `send`.
if let e = load("editor").flatMap(ProjectText.editor) {
    let before = EditorDraft(e)
    var after = before
    after.name += "x"
    check(before.changes(to: after) == [.name(e.name + "x")], "typing a name sends the name")
    after = before
    after.folder = "/tmp/a"
    after.search = "star"
    check(before.changes(to: after) == [.folder("/tmp/a"), .search("star")], "the folder and the search send themselves")
    check(before.changes(to: before).isEmpty, "nothing typed sends nothing")
}
// A new project's Name follows the name the core gives it from the folder,
// once the core has the folder as typed and no name typed since is pending.
if let e = load("new-project").flatMap(ProjectText.editor) {
    var core = e
    core.root = "~/dev/app-one"
    core.name = "App One"
    var draft = EditorDraft(e)
    draft.folder = "~/dev/app-one"
    check(EditorDraft.derivedName(core, draft: draft, namedSinceFolder: false) == "App One", "the folder's name shows in Name")
    check(EditorDraft.derivedName(core, draft: draft, namedSinceFolder: true) == nil, "a name typed after the folder stays")
    draft.folder = "~/dev/app-one/x"
    check(EditorDraft.derivedName(core, draft: draft, namedSinceFolder: false) == nil, "a stale folder names nothing")
    core.isNew = false
    draft.folder = core.root
    check(EditorDraft.derivedName(core, draft: draft, namedSinceFolder: false) == nil, "an edited project keeps its typed name")
} else {
    check(false, "the new-project fixture has an editor")
}
let sheet = URL(fileURLWithPath: #filePath).appendingPathComponent("../../../Sidebar/Views/EditorSheet.swift").standardizedFileURL
if let code = try? String(contentsOf: sheet, encoding: .utf8) {
    let named = code.components(separatedBy: "SidebarAction.").dropFirst()
    check(!code.contains("Outbox") && named.allSatisfy { $0.hasPrefix("Edit") }, "the sheet sends nothing but edits")
    check(!code.contains("onKeyPress") && !code.contains(".menu(") && !code.contains("switchTo"), "the sheet has no card action")
} else {
    check(false, "read \(sheet.path)")
}

// MARK: Chips and the card's parts

func chipOf(_ kind: ChipKind, _ text: String, url: String? = nil, action: Bool = false) -> Chip {
    Chip(kind: kind, pieces: [Piece(text: text, ink: .secondary)], givesWay: kind == .branch, url: url, isAction: action)
}
let glued = ChipFit.glued([chipOf(.pr, "#3"), chipOf(.diff, "+1"), chipOf(.branch, "feat"), chipOf(.diff, "+2")])
check(glued.map(CardText.chip) == ["#3 +1", "feat", "+2"], "a diff size joins only the PR before it")
check(glued.first?.kind == .pr, "the PR keeps its kind")

// A narrow card falls back to the core's short status, its tail dropped
// whole; a status with no short form, such as a question, has one form.
if let panel = load("lanes") {
    let cards = panel.lanes.flatMap(\.rows).compactMap { r -> Card? in
        if case .card(let c) = r { return c }
        return nil
    }
    let shell = cards.first { $0.status.hasPrefix("Shell running") }
    check(shell.map(CardText.statusForms) == ["Shell running 4m · 1 shell", "Shell running 4m…"],
          "a shell count gives way whole, marked with an ellipsis")
    let asking = cards.first { $0.status.hasPrefix("Asking") || $0.status.hasPrefix("Your turn") }
    check(asking.map { CardText.statusForms($0).count } == 1, "a waiting card's question has one form")
}

// The chips row's two lines: the size, PR and diff; then the branch, ports
// and actions, each line in the core's order.
let row = [chipOf(.size, "Quick"), chipOf(.pr, "#3"), chipOf(.diff, "+1"), chipOf(.branch, "feat"),
           chipOf(.port, ":5173 ↗"), chipOf(.action, "Make a project", action: true)]
let split = ChipLines(row)
check(split.pr.map(CardText.chip) == ["Quick", "#3", "+1"], "the PR's line holds the size, the PR and its diff")
check(split.branch.map(CardText.chip) == ["feat", ":5173 ↗", "Make a project"], "the branch's line holds the branch, the ports and the actions")
check(ChipLines([]).isEmpty && !split.isEmpty, "no chips, no lines")

// A dirty branch's mark is drawn as a dot, not words.
let dirty = Chip(kind: .branch, pieces: [Piece(text: "feat", ink: .secondary), Piece(text: ChipFit.dirtyMark, ink: .secondary)],
                 givesWay: true, url: nil, isAction: false)
check(ChipFit.branch(dirty).dirty && ChipFit.branch(dirty).pieces.map(\.text) == ["feat"], "a dirty branch: its name, and a dot")
check(!ChipFit.branch(chipOf(.branch, "feat")).dirty, "a clean branch has no dot")

// What a tap on each chip does.
let pr = URL(string: "https://github.com/o/r/pull/3")
check(ChipTap.of(chipOf(.pr, "#3", url: pr?.absoluteString), id: "W1") == pr.map(ChipTap.open), "a PR opens its page")
check(ChipTap.of(chipOf(.port, ":5173", url: "http://localhost:5173"), id: "W1") == URL(string: "http://localhost:5173").map(ChipTap.open), "a port opens on localhost")
check(ChipTap.of(chipOf(.pr, "#3", url: pr?.absoluteString), id: "W1", prOpens: false) == .none,
      "a full card's PR leaves the tap to the card (issue #72)")
check(ChipTap.of(chipOf(.port, ":5173", url: "http://localhost:5173"), id: "W1", prOpens: false) != .none, "a full card's port still opens")
check(ChipTap.of(chipOf(.pr, "#3"), id: "W1") == .none, "a PR with no link leaves the tap to the card")
check(ChipTap.of(chipOf(.branch, "feat"), id: "W1") == .none, "the branch leaves the tap to the card")
check(ChipTap.of(chipOf(.action, "Make a project", action: true), id: "W1") == .send(SidebarAction.pick(.newProjectFromFolder, on: "W1")),
      "Make a project, with no name, picks it too")
for word in ["To review →", "Park", "Close", "Keep"] {
    check(ChipTap.of(chipOf(.action, word, action: true), id: "W1") == .none, "\(word), an action it does not know, does nothing")
}
check(ChipTap.of(chipOf(.action, "Make \"x\" a project", action: true), id: "W1") == .send(SidebarAction.pick(.newProjectFromFolder, on: "W1")),
      "Make project picks the card menu's own item")

// A badge's glyph reads on its face (issue #2).
check(BadgeInk.glyph(on: 0xB0AEA5) == BadgeInk.dark, "a light face (#B0AEA5) takes the dark glyph")
// Clay reads better in dark.
check(BadgeInk.glyph(on: 0xD97757) == BadgeInk.dark, "clay (#D97757) takes the dark glyph")
check(BadgeInk.glyph(on: 0x3B6FB6) == BadgeInk.light, "blue (#3B6FB6) takes the white glyph")
check(BadgeInk.glyph(on: 0x000000) == BadgeInk.light && BadgeInk.glyph(on: 0xFFFFFF) == BadgeInk.dark, "black takes white, white takes dark")
check(BadgeInk.fallback == Palette.rgba(Palette.Own.grey, dark: false).hex, "no colour is the extension's grey")

// The halo round a status dot comes from the core with its icon: over
// the lanes scene, a live filled dot has its own hue's halo, a hollow dot
// and finished green none.
if let panel = load("lanes") {
    let halos: [Token: Token] = [.blue: .blueHalo, .clay: .clayHalo, .amber: .amberHalo, .mergeGreen: .mergeHalo]
    for case .card(let c) in panel.lanes.flatMap(\.rows) {
        let want = c.icon.glyph == CardText.filledDot ? c.icon.ink.flatMap { halos[$0] } ?? .clear : .clear
        check(c.icon.halo == want, "\(c.title): its dot's halo is its hue's, as the core picks it")
    }
}
check(Palette.rgba(Token.mergeHalo, dark: false).hex == Palette.rgba(Token.mergeGreen, dark: false).hex, "ready to merge's halo is its green at an alpha")
check(Palette.rgba(Token.mergeGreen, dark: false) != Palette.rgba(Token.green, dark: false), "ready to merge is not the finished green")

// Over the fixtures: the age on the title row only while the status line
// has none, so no card reads two; the bar held to 0 to 1.
for name in ["lanes", "projects"] {
    guard let panel = load(name) else { continue }
    let cards = panel.lanes.flatMap(\.rows).compactMap { r -> Card? in
        if case .card(let c) = r { return c }
        return nil
    } + panel.projects.compactMap { r -> Card? in
        if case .card(let c) = r { return c }
        return nil
    }
    for card in cards {
        for chip in card.chips where chip.isAction {
            check(ChipTap.of(chip, id: card.wsId) != .none, "\(name): \(card.title)'s \(CardText.chip(chip)) acts")
        }
    }
    if name == "lanes" {
        check(cards.contains { !CardText.titleAge($0).isEmpty }, "lanes: an untimed status puts the age on the title row")
        check(Set(cards.map(\.density)) == [.full, .compact, .row], "lanes: has every density")
    }
}
var bar = Card(wsId: "W", icon: Icon(glyph: "○", ink: nil, halo: .clear), title: "t", density: .full, badge: Badge(icon: "terminal", color: nil),
               unread: "", ready: false, readyInk: .greenText, pinned: false, progress: 1.5, helpers: "", status: "", statusShort: "", statusInk: .faint, age: "",
               statusHasAge: false, leftOff: "", chips: [], rowPr: nil, detail: "", detailInk: .secondary, detailLines: 2, waiting: nil, waitingTab: nil, rank: 0,
               movable: true, dimmed: false, selected: false, menu: [])
check(CardText.progress(bar) == 1, "a bar past the end stops full")
bar.progress = -0.5
check(CardText.progress(bar) == 0, "a bar before the start stays empty")
bar.progress = .nan
check(CardText.progress(bar) == 0, "a bar with no number stays empty")
bar.age = "3m"
check(CardText.titleAge(bar) == "3m", "an untimed status puts the age on the title row")
bar.statusHasAge = true
check(CardText.titleAge(bar).isEmpty, "a timed status keeps the title row free of a second time")
bar.progress = nil
check(CardText.progress(bar) == nil, "no value, no bar")
check(CardText.rowPrTitle(bar) == nil, "a card with no PR says no PR title")
bar.rowPr = RowPr(tag: "#171", title: "", ink: .metaText)
check(CardText.rowPrTitle(bar) == nil, "a PR with no title adds none")
bar.rowPr = RowPr(tag: "#171", title: "Row cards show their PR", ink: .mergeText)
check(CardText.rowPrTitle(bar) == "· Row cards show their PR", "a row's PR title follows the session's after a dot")
check(CardText.waitingTab(bar) == nil && CardText.tabTarget(bar) == nil, "no waiting tab, no tab line and no tab to select")
bar.waitingTab = WaitingTab(title: "", surfaceId: "9A8CD62C-CD0B-4C88-8063-C0633918D83B")
check(CardText.waitingTab(bar) == nil, "a tab with no title draws no line")
check(CardText.tabTarget(bar) == "9A8CD62C-CD0B-4C88-8063-C0633918D83B", "but a click still selects that tab")
bar.waitingTab = WaitingTab(title: "Fix CI lint", surfaceId: "9A8CD62C-CD0B-4C88-8063-C0633918D83B")
check(CardText.waitingTab(bar) == "Fix CI lint", "a waiting tab names its title")
check(CardText.tabTarget(bar) == "9A8CD62C-CD0B-4C88-8063-C0633918D83B", "and a click selects that tab")

// The core's words the panel matches on.
let marks = source("core/src/panel/mod.rs")
for (name, word) in [("DIRTY_MARK", ChipFit.dirtyMark), ("DOT", CardText.filledDot)] {
    check(marks.contains("pub const \(name): &str = \"\(word)\";"), "\(name) is \"\(word)\"")
}

// MARK: Colours from a hand-written config

// A hand-typed project colour previews in its own colour, not grey, as
// the core reads it (theme::parse_hex).
check(ProjectText.hex("#D97757") == 0xD97757, "six digits read")
check(ProjectText.hex("#d75") == 0xDD7755, "three digits read doubled, not grey")
check(ProjectText.hex("#D9775780") == 0xD97757, "eight digits read, their alpha dropped, not grey")
for bad in ["D97757", "#D975", "#D9775", "#D97757A", "#D9775G", "#+97757", "#", ""] {
    check(ProjectText.hex(bad) == nil, "\(bad.debugDescription) is no colour")
}

exit(failures == 0 ? 0 : 1)
