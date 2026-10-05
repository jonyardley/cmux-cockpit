import CmuxExtensionKit
import Observation
import SwiftUI

let group = "9S5FG4LQAF.dev.jonyardley.cockpit"
let tickName = Notification.Name("dev.jonyardley.cockpit.tick")
let actionName = Notification.Name("dev.jonyardley.cockpit.action")

// What reached the sandboxed side, one field per route, so the spike shows
// which routes work: shared defaults, a file in the group container, and a
// distributed notification as the "something changed" signal. The probes
// below check what SwiftUI can do inside an extension cmux hosts.
@Observable
@MainActor
final class SpikeModel {
    var workspaces: [CmuxSidebarWorkspace] = []
    var defaultsCount: Int?
    var fileText = "no file"
    var notifications = 0
    var polls = 0
    var actionsSent = 0
    var actionsSeen = 0
    var actionNotifications = 0
    var lastResult = "nothing yet"
    var rows = ["Alpha", "Bravo", "Charlie"]
    var typed = ""

    private var host: CmuxSidebarHost?
    private var observer: NSObjectProtocol?
    private var timer: Timer?

    func update(context: CmuxSidebarContext) {
        workspaces = context.snapshot.workspaces
        host = context.host
        start()
    }

    func start() {
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: tickName, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.notifications += 1
                self?.read()
            }
        }
        // A slow poll as well, so a missing notification shows as a stuck
        // counter rather than a blank.
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.polls += 1
                self?.read()
            }
        }
        read()
    }

    func read() {
        let defaults = UserDefaults(suiteName: group)
        defaultsCount = defaults?.object(forKey: "count") as? Int
        actionsSeen = defaults?.integer(forKey: "actionsSeen") ?? 0
        actionNotifications = defaults?.integer(forKey: "actionNotifications") ?? 0
        guard let url = containerURL?.appendingPathComponent("model.json") else {
            fileText = "no container"
            return
        }
        do {
            fileText = try String(contentsOf: url, encoding: .utf8)
        } catch {
            fileText = "read failed: \(error.localizedDescription)"
        }
    }

    var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    func sendAction() {
        guard let dir = containerURL?.appendingPathComponent("actions") else {
            lastResult = "no container"
            return
        }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("\(UUID().uuidString).json")
            try Data("{\"action\":\"probe\"}".utf8).write(to: file)
            actionsSent += 1
            DistributedNotificationCenter.default().postNotificationName(
                actionName, object: nil, userInfo: nil, deliverImmediately: true
            )
            lastResult = "action written"
        } catch {
            lastResult = "write failed: \(error.localizedDescription)"
        }
    }

    func select(_ workspace: CmuxSidebarWorkspace) async {
        do {
            try await host?.selectWorkspace(workspace.id)
            lastResult = "selected \(workspace.title)"
        } catch {
            lastResult = "select failed: \(error.localizedDescription)"
        }
    }

    func move(_ name: String, before target: String) {
        guard name != target, let from = rows.firstIndex(of: name) else { return }
        rows.remove(at: from)
        let to = rows.firstIndex(of: target) ?? rows.endIndex
        rows.insert(name, at: to)
        lastResult = "dropped \(name) before \(target)"
    }
}

@main
final class CockpitSidebar: @MainActor CmuxSidebarExtension {
    static let manifest = CmuxExtensionManifest(
        id: "dev.jonyardley.cockpit.sidebar",
        displayName: "Cockpit",
        readScopes: [.workspaceList, .workspaceMetadata],
        actionScopes: [.selectWorkspace]
    )

    private let model = SpikeModel()

    required init() {}

    var body: some View {
        SpikeView(model: model)
    }

    func update(context: CmuxSidebarContext) {
        model.update(context: context)
    }
}

struct SpikeView: View {
    @Bindable var model: SpikeModel
    @State private var sheet = false
    @State private var popover = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("hello").font(.title)
                Text("1 defaults: \(model.defaultsCount.map(String.init) ?? "nothing")")
                Text("2 file: \(model.fileText)").lineLimit(2)
                Text("3 ticks: \(model.notifications)  polls: \(model.polls)")
                Divider()
                Button("4 Send action") { model.sendAction() }
                Text("   sent \(model.actionsSent), host saw \(model.actionsSeen), host notified \(model.actionNotifications)")
                Divider()
                Text("5 drag a row onto another:")
                ForEach(model.rows, id: \.self) { row in
                    Text(row)
                        .padding(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                        .draggable(row)
                        .dropDestination(for: String.self) { items, _ in
                            items.first.map { model.move($0, before: row) }
                            return true
                        }
                        .contextMenu {
                            Button("Menu item on \(row)") { model.lastResult = "menu: \(row)" }
                        }
                }
                Text("6 right-click a row for its menu")
                Divider()
                HStack {
                    Button("7 Sheet") { sheet = true }
                    Button("8 Popover") { popover = true }
                        .popover(isPresented: $popover) {
                            Text("popover works").padding()
                        }
                }
                TextField("9 type here", text: $model.typed)
                Divider()
                Text("10 click a workspace (\(model.workspaces.count)):")
                ForEach(model.workspaces.prefix(4)) { workspace in
                    Button(workspace.title) { Task { await model.select(workspace) } }
                }
                Divider()
                Text("result: \(model.lastResult)")
            }
            .font(.system(size: 12, design: .monospaced))
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $sheet) {
            VStack {
                Text("sheet works")
                Button("Close") { sheet = false }
            }
            .padding()
        }
        .onAppear { model.start() }
    }
}
