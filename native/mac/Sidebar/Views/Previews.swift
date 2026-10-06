import SwiftUI

/// A fixture from native/fixtures/, read from beside this file, for the
/// previews only: the extension itself reads panel.json.
private func fixture(_ name: String, file: String = #filePath) -> Showing {
    let url = URL(fileURLWithPath: file)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../fixtures/\(name).json")
        .standardizedFileURL
    let panel = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Panel.self, from: $0) }
    return Showing.of(panel: panel, running: true)
}

/// The sidebar's width in cmux by default, about.
private let width: CGFloat = 280

#Preview("lanes") { SidebarView(showing: fixture("lanes")).frame(width: width, height: 900) }
#Preview("lanes, dark") {
    SidebarView(showing: fixture("lanes")).frame(width: width, height: 900).preferredColorScheme(.dark)
}
#Preview("lanes, narrow") { SidebarView(showing: fixture("lanes")).frame(width: 200, height: 900) }
#Preview("needs-and-next") { SidebarView(showing: fixture("needs-and-next")).frame(width: width, height: 900) }
#Preview("review-verdicts") { SidebarView(showing: fixture("review-verdicts")).frame(width: width, height: 900) }
#Preview("card-menu") { SidebarView(showing: fixture("card-menu")).frame(width: width, height: 900) }
#Preview("projects") { SidebarView(showing: fixture("projects")).frame(width: width, height: 400) }
#Preview("editor") { SidebarView(showing: fixture("editor")).frame(width: width, height: 400) }
#Preview("new-project") { SidebarView(showing: fixture("new-project")).frame(width: width, height: 400) }
#Preview("not running") { SidebarView(showing: .notRunning).frame(width: width, height: 200) }
#Preview("waiting") { SidebarView(showing: .waiting).frame(width: width, height: 200) }
