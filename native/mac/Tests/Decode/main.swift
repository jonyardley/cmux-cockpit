import Foundation

// Decodes every fixture in native/fixtures/ with the generated panel types
// (Generated/PanelTypes.swift, from native/typegen) and a plain
// JSONDecoder, then checks what each one holds, so a decode that quietly
// drops rows fails too. test.sh builds and runs it with the fixtures'
// folder as its argument.

var failures = 0

@MainActor
func check(_ ok: Bool, _ what: String) {
    if ok { print("ok: \(what)") } else { print("FAIL: \(what)"); failures += 1 }
}

/// What a fixture holds: its view, its lane rows, its Projects rows, the
/// Needs you count, the open menu's items, and whether an editor is open.
struct Expect {
    let view: PanelView
    let laneRows: Int
    let projectRows: Int
    let needs: UInt64
    let menuItems: Int?
    let editor: Bool
}

let expected: [String: Expect] = [
    "card-menu.json": Expect(view: .all, laneRows: 14, projectRows: 0, needs: 2, menuItems: 20, editor: false),
    "editor.json": Expect(view: .projects, laneRows: 5, projectRows: 12, needs: 1, menuItems: nil, editor: true),
    "lanes.json": Expect(view: .all, laneRows: 14, projectRows: 0, needs: 2, menuItems: nil, editor: false),
    "needs-and-next.json": Expect(view: .all, laneRows: 7, projectRows: 0, needs: 5, menuItems: nil, editor: false),
    "new-project.json": Expect(view: .projects, laneRows: 5, projectRows: 12, needs: 1, menuItems: nil, editor: true),
    "projects.json": Expect(view: .projects, laneRows: 5, projectRows: 11, needs: 1, menuItems: nil, editor: false),
    "review-verdicts.json": Expect(view: .all, laneRows: 9, projectRows: 0, needs: 0, menuItems: nil, editor: false),
]

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: decode-check <fixtures folder>")
    exit(2)
}
let folder = URL(fileURLWithPath: args[1], isDirectory: true)
let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
    .filter { $0.hasSuffix(".json") }
    .sorted()
check(names == expected.keys.sorted(), "the fixtures are the seven this test expects: \(names)")

func hasEditor(_ rows: [ProjectRow]) -> Bool {
    rows.contains { if case .editor = $0 { return true } else { return false } }
}

for name in names {
    guard let want = expected[name] else { continue }
    do {
        let data = try Data(contentsOf: folder.appendingPathComponent(name))
        let panel = try JSONDecoder().decode(Panel.self, from: data)
        check(panel.view == want.view, "\(name): view")
        check(panel.lanes.map(\.key) == [.main, .review, .bg, .parked, .unsorted], "\(name): the five lanes in order")
        check(panel.lanes.reduce(0) { $0 + $1.rows.count } == want.laneRows, "\(name): \(want.laneRows) lane rows")
        check(panel.projects.count == want.projectRows, "\(name): \(want.projectRows) project rows")
        check(panel.needs.count == want.needs, "\(name): needs \(want.needs)")
        check(panel.menu?.items.count == want.menuItems, "\(name): menu items")
        check(hasEditor(panel.projects) == want.editor, "\(name): editor open")
    } catch {
        check(false, "\(name) decodes: \(error)")
    }
}

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
