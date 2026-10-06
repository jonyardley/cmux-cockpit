import Foundation

// Decodes every fixture in native/fixtures/ with the generated panel types
// (Generated/PanelTypes.swift, from native/typegen) and a plain
// JSONDecoder, then checks each against the same file read as plain JSON,
// so a decode that quietly drops rows fails too. The counts come from the
// JSON, so a fixture the Rust re-records needs no edit here. test.sh
// builds and runs it with the fixtures' folder as its argument.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

/// The JSON name of each view; a new case fails to compile here.
func jsonName(_ view: PanelView) -> String {
    switch view {
    case .all: "All"
    case .projects: "Projects"
    }
}

func hasEditor(_ rows: [ProjectRow]) -> Bool {
    rows.contains { if case .editor = $0 { return true } else { return false } }
}

/// What a fixture holds, read as plain JSON rather than the panel types.
struct Raw {
    let view: String?
    let laneRows: Int
    let projectRows: Int
    let needs: UInt64?
    let menuItems: Int?
    let editor: Bool

    init(_ json: [String: Any]) {
        view = json["view"] as? String
        let lanes = json["lanes"] as? [[String: Any]] ?? []
        laneRows = lanes.reduce(0) { $0 + (($1["rows"] as? [Any])?.count ?? 0) }
        let projects = json["projects"] as? [Any] ?? []
        projectRows = projects.count
        needs = ((json["needs"] as? [String: Any])?["count"] as? NSNumber)?.uint64Value
        menuItems = ((json["menu"] as? [String: Any])?["items"] as? [Any])?.count
        editor = projects.contains { ($0 as? [String: Any])?["Editor"] != nil }
    }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: decode-check <fixtures folder>")
    exit(2)
}
let folder = URL(fileURLWithPath: args[1], isDirectory: true)
let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
    .filter { $0.hasSuffix(".json") }
    .sorted()
check(!names.isEmpty, "found the fixtures: \(names)")

var sawMenu = false
var sawEditor = false
for name in names {
    do {
        let data = try Data(contentsOf: folder.appendingPathComponent(name))
        let raw = Raw(try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:])
        let panel = try JSONDecoder().decode(Panel.self, from: data)
        check(jsonName(panel.view) == raw.view, "\(name): view \(raw.view ?? "missing")")
        check(panel.lanes.map(\.key) == [.main, .review, .bg, .parked, .unsorted], "\(name): the five lanes in order")
        check(panel.lanes.reduce(0) { $0 + $1.rows.count } == raw.laneRows, "\(name): \(raw.laneRows) lane rows")
        check(panel.projects.count == raw.projectRows, "\(name): \(raw.projectRows) project rows")
        check(panel.needs.count == raw.needs, "\(name): needs \(raw.needs.map(String.init) ?? "missing")")
        check(panel.menu?.items.count == raw.menuItems, "\(name): menu items")
        check(hasEditor(panel.projects) == raw.editor, "\(name): editor open")
        sawMenu = sawMenu || raw.menuItems != nil
        sawEditor = sawEditor || raw.editor
    } catch {
        check(false, "\(name) decodes: \(error)")
    }
}
// So the menu and editor shapes stay covered if a fixture goes.
check(sawMenu, "some fixture has a menu open")
check(sawEditor, "some fixture has an editor open")

// A key the Rust always writes, missing, fails rather than defaulting.
do {
    let data = try Data(contentsOf: folder.appendingPathComponent("lanes.json"))
    var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    object.removeValue(forKey: "needs")
    let cut = try JSONSerialization.data(withJSONObject: object)
    check((try? JSONDecoder().decode(Panel.self, from: cut)) == nil, "a missing required key fails")
} catch {
    check(false, "lanes.json reads as an object: \(error)")
}

// An unknown variant fails rather than picking one.
check((try? JSONDecoder().decode(PanelView.self, from: Data("\"Neither\"".utf8))) == nil, "an unknown unit variant fails")
check((try? JSONDecoder().decode(PanelView.self, from: Data("\"Projects\"".utf8))) == .projects, "a unit variant reads its name")

exit(failures == 0 ? 0 : 1)
