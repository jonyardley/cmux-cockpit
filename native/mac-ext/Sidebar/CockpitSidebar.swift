import CmuxExtensionKit
import Observation
import SwiftUI

let group = "9S5FG4LQAF.dev.jonyardley.cockpit"
let tickName = Notification.Name("dev.jonyardley.cockpit.tick")

// What reached the sandboxed side, one field per route, so the spike shows
// which routes work: shared defaults, a file in the group container, and a
// distributed notification as the "something changed" signal.
@Observable
@MainActor
final class SpikeModel {
    var workspaces = 0
    var defaultsCount: Int?
    var fileText = "no file"
    var notifications = 0
    var polls = 0

    private var observer: NSObjectProtocol?
    private var timer: Timer?

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
        defaultsCount = UserDefaults(suiteName: group)?.object(forKey: "count") as? Int
        guard
            let url = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: group)?
                .appendingPathComponent("model.json")
        else {
            fileText = "no container"
            return
        }
        do {
            fileText = try String(contentsOf: url, encoding: .utf8)
        } catch {
            fileText = "read failed: \(error.localizedDescription)"
        }
    }
}

@main
final class CockpitSidebar: @MainActor CmuxSidebarExtension {
    static let manifest = CmuxExtensionManifest(
        id: "dev.jonyardley.cockpit.sidebar",
        displayName: "Cockpit",
        readScopes: [.workspaceList],
        actionScopes: []
    )

    private let model = SpikeModel()

    required init() {}

    var body: some View {
        SpikeView(model: model)
    }

    func update(context: CmuxSidebarContext) {
        model.workspaces = context.snapshot.workspaces.count
        model.start()
    }
}

struct SpikeView: View {
    let model: SpikeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("hello").font(.title)
            Text("workspaces from cmux: \(model.workspaces)")
            Text("shared defaults: \(model.defaultsCount.map(String.init) ?? "nothing")")
            Text("group file: \(model.fileText)").lineLimit(3)
            Text("notifications: \(model.notifications)  polls: \(model.polls)")
            Spacer()
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { model.start() }
    }
}
