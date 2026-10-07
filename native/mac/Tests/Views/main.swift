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
    let marks: Set<String> = ["●", "○", Words.ghost]
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
    check(NextText.targetId(panel.next) == "n1", "a Next click outlines the card it goes to")
    check(lines.contains("\(Words.needs) \(panel.needs.count) \(panel.needs.wait)"), "Needs you reads as the pane's")
    check(lines.contains(panel.needs.more), "the strip's more line reads as the pane's")
    for row in panel.needs.rows {
        check(lines.contains("● \(row.title)") && lines.contains(row.line), "Needs you row \(row.title)")
    }
}
if let text = try? String(contentsOf: snapshots.appendingPathComponent("review-verdicts-80.txt"), encoding: .utf8) {
    check(text.contains("\(Words.next)  \(Words.nextNothing)"), "Next with nowhere to go reads as the pane's")
}

if let panel = load("lanes") {
    let rows = panel.lanes.flatMap(\.rows)
    check(Set(rows.map(\.id)).count == rows.count, "each lane row has its own id, a card apart from its placeholder")
}

// MARK: Chips that fit

/// The pane's fit_ranked by width, for the test only: the view lets
/// ViewThatFits pick from ChipFit.candidates, and the checks below hold
/// that its first fitting line is this one.
extension ChipFit {
    struct Fit: Equatable {
        /// One per chip: whether it shows.
        let shown: [Bool]
        /// Whether some were left off, so the ellipsis shows.
        let cut: Bool
    }

    /// The width of `widths` on one line, `gap` apart.
    static func width(_ widths: [Double], gap: Double) -> Double {
        widths.reduce(0, +) + gap * Double(max(0, widths.count - 1))
    }

    /// How many of `widths` fit whole in `room`, `gap` apart, leaving room
    /// for an ellipsis of `tail` after them when some are left off.
    static func count(_ widths: [Double], gap: Double, room: Double, tail: Double) -> (Int, Bool) {
        if width(widths, gap: gap) <= room { return (widths.count, false) }
        var used = 0.0
        for (i, w) in widths.enumerated() {
            let lead = i == 0 ? 0 : gap
            if used + lead + w + gap + tail > room { return (i, true) }
            used += lead + w
        }
        return (widths.count, false)
    }

    static func fit(_ widths: [Double], givesWay: [Bool], gap: Double, room: Double, tail: Double) -> Fit {
        let (all, cut) = count(widths, gap: gap, room: room, tail: tail)
        if !cut { return Fit(shown: Array(repeating: true, count: all), cut: false) }
        let keep = widths.indices.filter { !(givesWay.indices.contains($0) && givesWay[$0]) }
        let (n, _) = count(keep.map { widths[$0] } + [tail], gap: gap, room: room, tail: tail)
        var shown = Array(repeating: false, count: widths.count)
        for i in keep.prefix(min(n, keep.count)) { shown[i] = true }
        return Fit(shown: shown, cut: true)
    }
}

let none = [false, false, false]
check(ChipFit.fit([10, 10, 10], givesWay: none, gap: 2, room: 34, tail: 4) == .init(shown: [true, true, true], cut: false), "all chips fit")
check(ChipFit.fit([10, 10, 10], givesWay: none, gap: 2, room: 30, tail: 4) == .init(shown: [true, true, false], cut: true), "the last chip goes, an ellipsis after")
check(ChipFit.fit([10, 30, 10], givesWay: [false, true, false], gap: 2, room: 40, tail: 4) == .init(shown: [true, false, true], cut: true), "the branch gives way first")
check(ChipFit.fit([50], givesWay: [false], gap: 2, room: 10, tail: 4) == .init(shown: [false], cut: true), "a chip too wide for the line goes whole")
check(ChipFit.fit([], givesWay: [], gap: 2, room: 0, tail: 4) == .init(shown: [], cut: false), "no chips fit nothing")
check(ChipFit.width([10, 10], gap: 2) == 22 && ChipFit.width([], gap: 2) == 0, "a line's width counts the gaps between")

check(ChipFit.candidates(givesWay: [false, true, false]) == [[0, 1, 2], [0, 2], [0], []], "the lines to try: all, then the branch gone, then from the end")
check(ChipFit.candidates(givesWay: [false, false]) == [[0, 1], [0], []], "with nothing to give way, every chip is tried once, not again with an ellipsis")
check(ChipFit.candidates(givesWay: []) == [[]], "no chips, nothing to try but nothing")

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
    check(NextText.targetId(panel.next) == nil, "a Next click with nowhere to go outlines nothing")
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

// The light side of the extension's own colours is the pane's, read from
// native/pane/src/theme.rs beside the snapshots.
let themeRs = snapshots.appendingPathComponent("../../src/theme.rs").standardizedFileURL
if let theme = try? String(contentsOf: themeRs, encoding: .utf8) {
    func paneHex(_ name: String) -> UInt32? {
        let line = theme.split(separator: "\n").first { $0.hasPrefix("pub const \(name): u32 = 0x") }
        return line.flatMap { UInt32($0.split(separator: "0x").last?.prefix(6) ?? "", radix: 16) }
    }
    for (own, name) in [(Palette.Own.ground, "GROUND"), (.needsFace, "NEEDS_BG"), (.tertiary, "TERTIARY"), (.grey, "GREY")] {
        check(paneHex(name) == Palette.rgba(own, dark: false).hex && Palette.rgba(own, dark: false).alpha == 0xFF, "light \(own) is the pane's \(name)")
    }
} else {
    check(false, "the pane's theme.rs is at \(themeRs.path)")
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

// The words the sidebar keeps for itself are the core's and the pane's.
let native = snapshots.appendingPathComponent("../../..").standardizedFileURL
func source(_ path: String) -> String {
    (try? String(contentsOf: native.appendingPathComponent(path), encoding: .utf8)) ?? ""
}
let panelRs = source("core/src/panel/mod.rs")
for (name, word) in [("NEW_PROJECT_LABEL", Words.newProject), ("QUIET_LABEL", Words.quiet), ("PLUS_MARK", Words.plus)] {
    check(panelRs.contains("pub const \(name): &str = \"\(word)\";"), "\(name) is \"\(word)\"")
}
let editorRs = source("pane/src/editor.rs")
for (name, word) in [("FOLDER_LABEL", Words.folder), ("NAME_LABEL", Words.name), ("COLOUR_LABEL", Words.colour), ("ICON_LABEL", Words.icon)] {
    check(editorRs.contains("pub const \(name): &str = \"\(word)\";"), "the editor's \(name) is \"\(word)\"")
}
let editorTs = source("../src/cockpit/views/editor.ts")
for word in [Words.newProjectTitle, Words.add, Words.done, Words.cancel, Words.projectName, Words.searchIcons, Words.openFolders] {
    check(editorTs.contains("\"\(word)\""), "the sheet's \"\(word)\" is the JS sidebar editor's")
}
check(source("core/src/ui.rs").contains("QUIET_PILL: PillColors = PillColors {\n    bg: Token::CountBg,\n    fg: Token::MetaText,"), "the Quiet pill is the core's")

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

exit(failures == 0 ? 0 : 1)
