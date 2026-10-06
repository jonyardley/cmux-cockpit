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

    required init() {}

    var body: some View {
        LiveSidebar(store: store)
    }

    func update(context: CmuxSidebarContext) {
        store.start()
    }
}

/// The sidebar over the live store: whatever the App Group folder holds.
struct LiveSidebar: View {
    let store: PanelStore

    var body: some View {
        SidebarView(showing: store.showing)
            .onAppear { store.start() }
    }
}
