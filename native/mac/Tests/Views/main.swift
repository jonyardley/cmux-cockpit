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
    // The panel's off-white, the cream the selected tab keeps and a
    // card's face where it is solid, each once: in dark mode the first two
    // are the same colour and the card face is see-through.
    var grounds = [("panel ground", Palette.rgba(.panelGround, dark: dark))]
    if Palette.rgba(.ground, dark: dark) != grounds[0].1 {
        grounds.append(("ground", Palette.rgba(.ground, dark: dark)))
    }
    if Palette.rgba(.cardFace, dark: dark).alpha == 0xFF {
        grounds.append(("card face", Palette.rgba(.cardFace, dark: dark)))
    }
    for (where_, ground) in grounds {
        // Body ink at WCAG's 4.5; the state inks at 3, as the light palette
        // (palette.ts) holds them, the finished green the lowest.
        for (token, name) in [(Token.text, "text"), (.secondary, "secondary"), (.heading, "heading")] {
            check(contrast(Palette.rgba(token, dark: dark), ground) >= 4.5, "\(scheme): \(name) reads on the \(where_)")
        }
        for (token, name) in [(Token.blueText, "blueText"), (.clayText, "clayText"), (.greenText, "greenText"), (.amberText, "amberText"), (.redText, "redText"), (.metaText, "metaText")] {
            check(contrast(Palette.rgba(token, dark: dark), ground) >= 3, "\(scheme): \(name) reads on the \(where_)")
        }
    }
    // The third ink sits on the panel and on cards; on the pane's cream it
    // is short of 4.5 already, as it was before the panel changed colour.
    for (where_, ground) in grounds where where_ != "ground" {
        check(contrast(Palette.rgba(.tertiary, dark: dark), ground) >= 4.5, "\(scheme): tertiary reads on the \(where_)")
    }
    // A card's face differs from the panel; the card's hairline edge does
    // the rest of the work of reading as a tile.
    check(Palette.rgba(.cardFace, dark: dark) != Palette.rgba(.panelGround, dark: dark), "\(scheme): a card's face is not the panel ground")
    let hues = [Token.blue, .clay, .green, .amber].map { Palette.rgba($0, dark: dark) }
    check(Set(hues.map(\.hex)).count == hues.count, "\(scheme): each state hue is its own")
    check(Palette.rgba(.clear, dark: dark).alpha == 0, "\(scheme): clear is no colour")
}
check(Palette.rgba(.ground, dark: false) != Palette.rgba(.ground, dark: true), "light and dark grounds differ")
check(Palette.rgba(.panelGround, dark: false) != Palette.rgba(.panelGround, dark: true), "light and dark panel grounds differ")

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
// The light side of the panel's own cockpit colours is the JS sidebar's,
// read from src/cockpit/theme.ts.
let themeTs = source("../src/cockpit/theme.ts").lowercased()
for (own, name) in [(Palette.Own.card, "card"), (.needsEdge, "needsEdge"), (.needsHover, "needsHover"), (.cardHover, "cardHover"),
                    (.hover, "hover"), (.dropTarget, "dropTarget"), (.zoneLit, "zoneLit"), (.anchorSelected, "anchorSelected")] {
    let c = Palette.rgba(own, dark: false)
    let hex = "#" + String(format: "%06x", c.hex) + (c.alpha == 0xFF ? "" : String(format: "%02x", c.alpha))
    check(themeTs.contains("\n  \(name.lowercased()): \"\(hex)\","), "light \(own) is the cockpit's \(name)")
}
check(Palette.rgba(.readyBg, dark: false) == RGBA(Palette.rgba(Token.green, dark: false).hex, 0x1F), "readyBg is the finished green, faint")
check(source("core/src/ui.rs").contains("QUIET_PILL: PillColors = PillColors {\n    bg: Token::CountBg,\n    fg: Token::MetaText,"), "the Quiet pill is the core's")

// "+ New project" draws its plus as an icon, so its label is the words
// alone; a quiet project with no folder fades, one with a folder does not.
check(ProjectText.newProjectLabel == "New project", "+ New project's label drops the plus it draws as an icon")
check(ProjectText.quietOpacity(canOpen: true) == 1, "a quiet project with a folder is whole")
check(ProjectText.quietOpacity(canOpen: false) == 0.55, "a quiet project with no folder fades as the cockpit's")
check(source("../src/cockpit/views/headers.ts").contains("if (!open) return row.opacity(\(ProjectText.quietFade));"), "the quiet fade is headers.ts quietRow's")
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

// The chips row's two lines: the size, PR and diff; then the branch, ports
// and actions, each line in the core's order.
let row = [chipOf(.size, "Quick"), chipOf(.pr, "#3"), chipOf(.diff, "+1"), chipOf(.branch, "feat"),
           chipOf(.port, ":5173 ↗"), chipOf(.action, "To review →", action: true)]
let split = ChipLines(row)
check(split.pr.map(CardText.chip) == ["Quick", "#3", "+1"], "the PR's line holds the size, the PR and its diff")
check(split.branch.map(CardText.chip) == ["feat", ":5173 ↗", "To review →"], "the branch's line holds the branch, the ports and the actions")
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
check(ChipTap.of(chipOf(.action, ChipTap.toReview, action: true), id: "W1") == .send([.fileForReview(id: "W1")]), "To review files the card for review")
check(ChipTap.of(chipOf(.action, SidebarAction.parkWord, action: true), id: "W1") == .send([.parkMerged(id: "W1")]), "Park parks")
check(ChipTap.of(chipOf(.action, SidebarAction.closeWord, action: true), id: "W1") == .send([.closeMerged(id: "W1")]), "Close closes")
check(ChipTap.of(chipOf(.action, "Make a project", action: true), id: "W1") == .send(SidebarAction.pick(.newProjectFromFolder, on: "W1")),
      "Make a project, with no name, picks it too")
check(ChipTap.of(chipOf(.action, "Keep", action: true), id: "W1") == .none, "an action it does not know does nothing")
check(ChipTap.of(chipOf(.action, "Make \"x\" a project", action: true), id: "W1") == .send(SidebarAction.pick(.newProjectFromFolder, on: "W1")),
      "Make project picks the card menu's own item")

// A badge's glyph reads on its face (contrast.ts glyphColor, issue #2).
check(BadgeInk.glyph(on: 0xB0AEA5) == BadgeInk.dark, "a light face (#B0AEA5) takes the dark glyph")
// Clay reads better in dark, as contrast.ts's own glyphColor has it.
check(BadgeInk.glyph(on: 0xD97757) == BadgeInk.dark, "clay (#D97757) takes the dark glyph, as the cockpit's does")
check(BadgeInk.glyph(on: 0x3B6FB6) == BadgeInk.light, "blue (#3B6FB6) takes the white glyph")
check(BadgeInk.glyph(on: 0x000000) == BadgeInk.light && BadgeInk.glyph(on: 0xFFFFFF) == BadgeInk.dark, "black takes white, white takes dark")
check(BadgeInk.fallback == Palette.rgba(Palette.Own.grey, dark: false).hex, "no colour is the cockpit's grey")

// The halo round a status dot: the three filled hues that ask for a look.
check(CardText.halo(Icon(glyph: CardText.filledDot, ink: .blue)) == .blueHalo, "working's blue dot has its halo")
check(CardText.halo(Icon(glyph: CardText.filledDot, ink: .clay)) == .clayHalo, "needs' clay dot has its halo")
check(CardText.halo(Icon(glyph: CardText.filledDot, ink: .amber)) == .amberHalo, "asking's amber dot has its halo")
check(CardText.halo(Icon(glyph: CardText.filledDot, ink: .green)) == .clear, "finished green has none")
check(CardText.halo(Icon(glyph: "○", ink: .blue)) == .clear, "a hollow dot has none")
check(CardText.halo(Icon(glyph: "○", ink: nil)) == .clear, "a grey outline has none")

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
        for chip in card.chips + card.merged where chip.isAction {
            check(ChipTap.of(chip, id: card.wsId) != .none, "\(name): \(card.title)'s \(CardText.chip(chip)) acts")
        }
    }
    if name == "lanes" {
        check(cards.contains { !CardText.titleAge($0).isEmpty }, "lanes: an untimed status puts the age on the title row")
        check(Set(cards.map(\.density)) == [.full, .compact, .row], "lanes: has every density")
    }
}
var bar = Card(wsId: "W", icon: Icon(glyph: "○", ink: nil), title: "t", density: .full, badge: Badge(icon: "terminal", color: nil),
               unread: "", ready: false, pinned: false, progress: 1.5, helpers: "", status: "", statusInk: .faint, age: "",
               statusHasAge: false, leftOff: "", chips: [], merged: [], detail: "", detailLines: 2, waiting: false, rank: 0,
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

// The core's words the panel matches on.
let marks = source("core/src/panel/mod.rs")
for (name, word) in [("TO_REVIEW", ChipTap.toReview), ("DIRTY_MARK", ChipFit.dirtyMark), ("DOT", CardText.filledDot)] {
    check(marks.contains("pub const \(name): &str = \"\(word)\";"), "\(name) is \"\(word)\"")
}

exit(failures == 0 ? 0 : 1)
