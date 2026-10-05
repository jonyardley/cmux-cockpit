import CmuxExtensionKit
import Observation
import SwiftUI

/// Whether the helper app is running, read from its heartbeat in the App
/// Group folder. The helper's "changed" signal refreshes it at once; a
/// slow poll catches a helper that stopped without saying so (a crash).
@Observable
@MainActor
final class HelperStatus {
    var running = false

    private var observer: NSObjectProtocol?
    private var timer: Timer?

    func start() {
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Shared.changed, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: Heartbeat.pollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
        read()
    }

    func read() {
        let file = Shared.folder?.appendingPathComponent(Heartbeat.fileName)
        let text = file.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        let beat = text.flatMap(Heartbeat.decode)
        running = Heartbeat.isAlive(beat: beat, now: Date())
    }
}

@main
@MainActor
final class CockpitSidebar: CmuxSidebarExtension {
    // The scopes the panel will need. Asking for them now is what makes
    // cmux show its "Limited extension access" banner on first use.
    static let manifest = CmuxExtensionManifest(
        id: "dev.jonyardley.cockpit.sidebar",
        displayName: "Cockpit",
        readScopes: [.workspaceList, .workspaceMetadata],
        actionScopes: [.selectWorkspace]
    )

    private let status = HelperStatus()

    required init() {}

    var body: some View {
        SidebarView(status: status)
    }

    func update(context: CmuxSidebarContext) {
        status.start()
    }
}

struct SidebarView: View {
    let status: HelperStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if status.running {
                Text("Cockpit").font(.headline)
                Text("Connected. The panel arrives here in a later release.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Cockpit isn't running").font(.headline)
                Text("Open Cockpit.app to start it.")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 12))
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { status.start() }
    }
}
