import CmuxExtensionKit
import SwiftUI

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

    private let store = PanelStore()
    private let link = HostLink()

    required init() {}

    var body: some View {
        LiveSidebar(store: store, link: link)
    }

    func update(context: CmuxSidebarContext) {
        link.host = context.host
        store.start()
    }
}

/// cmux's command channel, as the latest context brings it, so a click
/// switches workspace straight through the SDK rather than the runner.
@MainActor
final class HostLink {
    var host: CmuxSidebarHost?

    /// Selects the workspace in cmux. Without a host yet, or an id that is
    /// not a UUID, or when cmux refuses, the core's SwitchTo goes through
    /// the outbox instead, so a click is never lost.
    var switchWorkspace: SwitchWorkspace {
        SwitchWorkspace { [weak self] id in
            guard let host = self?.host, let uuid = UUID(uuidString: id) else {
                SwitchWorkspace.outbox.run(id)
                return
            }
            Task { @MainActor in
                do { try await host.selectWorkspace(uuid) } catch { SwitchWorkspace.outbox.run(id) }
            }
        }
    }
}

/// The sidebar over the live store: whatever the App Group folder holds.
struct LiveSidebar: View {
    let store: PanelStore
    let link: HostLink

    var body: some View {
        SidebarView(showing: store.showing)
            .environment(\.switchWorkspace, link.switchWorkspace)
            .onAppear { store.start() }
    }
}
