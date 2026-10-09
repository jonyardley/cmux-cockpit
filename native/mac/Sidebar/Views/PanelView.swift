import SwiftUI

/// The All view: the five lanes. A card waiting on Jon stays in its lane
/// with its leading edge (issue #281); Next's pill counts them.
/// Each lane header carries its own section gap above it, so the lanes
/// sit flush and their drop areas meet.
struct AllView: View {
    let panel: Panel
    @State private var tops: [String: CGFloat] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(panel.lanes, id: \.key) { lane in
                    LaneView(
                        lane: lane, top: tops[String(describing: lane.key)] ?? 0,
                        own: LaneText.ownColor(lane.key, in: panel))
                }
            }
            .coordinateSpace(name: FloatingCard.space)
            .overlay(alignment: .topLeading) { FloatingCard(state: DragState.shared, lanes: panel.lanes) }
            .onPreferenceChange(LaneTops.self) { next in
                MainActor.assumeIsolated { if next != tops { tops = next } }
            }
        }
    }
}

/// The whole panel: the view switch and Next (only while there is a next
/// step), then the view the core has on, spaced as the cockpit's top
/// (headers.ts segmented, needs.ts nextButton), and the project editor
/// as a sheet over it while the core has one open. Closing the sheet asks
/// the core to close the editor; the sheet goes when the panel says it has.
struct PanelBody: View {
    let panel: Panel

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                ViewSwitch(view: panel.view)
                    .padding(.horizontal, Self.switchMargin)
                    .padding(.bottom, 8)
                if NeedsText.shows(panel.needs) || !NextText.isNothing(panel.next) {
                    NextView(next: panel.next, needs: panel.needs).padding(.top, 6)
                }
                Group {
                    switch panel.view {
                    case .all: AllView(panel: panel)
                    case .projects: ProjectsView(panel: panel)
                    }
                }
                .padding(.top, 6)
            }
            .padding(Metrics.gutter)
        }
        .sheet(item: editorKey) { _ in
            if let editor = ProjectText.editor(panel) {
                EditorSheet(editor: editor) { SidebarCore.send(.edit($0)) }
            }
        }
    }

    /// The switch's outer margin: 14 in from the sidebar's edge, past the
    /// gutter. Metrics.switchInset is the track's inner padding.
    private static let switchMargin: CGFloat = 14 - Metrics.gutter

    private var editorKey: Binding<EditorKey?> {
        Binding(
            get: { ProjectText.editor(panel).map { EditorKey(id: $0.key) } },
            // Only while the core still has it open: a sheet going because
            // the core closed it (Save, Remove) sends nothing.
            set: { if $0 == nil, ProjectText.editor(panel) != nil { SidebarCore.send(.edit(.close)) } }
        )
    }
}

/// Two lines of words: a heading and why.
struct Notice: View {
    let title: String
    let why: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: Metrics.body, weight: .semibold)).foregroundStyle(Color(Token.text))
            Text(why).font(.system(size: Metrics.body)).foregroundStyle(Color(Token.secondary))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What the sidebar shows: the panel whenever there is one, with a line
/// on top while the helper is down; else why there is none.
struct SidebarView: View {
    let showing: Showing

    var body: some View {
        Group {
            switch showing {
            case .notRunning:
                Notice(title: Words.notRunning, why: Words.startIt).padding(Metrics.gutter)
            case .waiting:
                Notice(title: Words.waiting, why: Words.waitingWhy).padding(Metrics.gutter)
            case .panel(let panel, let stale):
                VStack(alignment: .leading, spacing: 0) {
                    if stale {
                        Notice(title: Words.notRunning, why: Words.startIt)
                            .padding(Metrics.gutter)
                            .background(Color(Token.amberHalo))
                    }
                    PanelBody(panel: panel)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(Palette.Own.panelGround))
    }
}
