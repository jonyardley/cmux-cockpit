import SwiftUI

/// The All view: Needs you while something waits, then the five lanes.
struct AllView: View {
    let panel: Panel
    @State private var tops: [String: CGFloat] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if NeedsText.shows(panel.needs) {
                NeedsView(needs: panel.needs)
            }
            // Checked against this panel as it draws, so a drop the panel
            // already shows is not drawn twice for a frame.
            let moves = PendingMove.unconfirmed(DragState.shared.pending, lanes: panel.lanes)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(panel.lanes, id: \.key) { lane in
                    let gap: CGFloat = lane.key == panel.lanes.last?.key ? 0 : 12
                    LaneView(lane: lane, moves: moves, top: tops[String(describing: lane.key)] ?? 0, gap: gap)
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

/// The whole panel: the view switch and Next, then the view the core has
/// on, and the project editor as a sheet over it while the core has one
/// open. Closing the sheet asks the core to close the editor; the sheet
/// goes when panel.json says it has.
struct PanelBody: View {
    let panel: Panel

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                ViewSwitch(view: panel.view)
                NextView(next: panel.next)
                switch panel.view {
                case .all: AllView(panel: panel)
                case .projects: ProjectsView(panel: panel)
                }
            }
            .padding(Metrics.gutter)
        }
        // Here, not in a lane, so a drop is confirmed in the Projects
        // view too, when no lane is drawn.
        .onChange(of: panel.lanes) { _, now in DragState.shared.reconcile(now) }
        .onChange(of: DragState.shared.pending.count) { was, now in
            if now > was { Timeline.drag.note("move drawn") }
        }
        .sheet(item: editorKey) { _ in
            if let editor = ProjectText.editor(panel) {
                EditorSheet(editor: editor) { Outbox.send(.edit($0)) }
            }
        }
    }

    private var editorKey: Binding<EditorKey?> {
        Binding(
            get: { ProjectText.editor(panel).map { EditorKey(id: $0.key) } },
            // Only while the core still has it open: a sheet going because
            // the core closed it (Save, Remove) sends nothing.
            set: { if $0 == nil, ProjectText.editor(panel) != nil { Outbox.send(.edit(.close)) } }
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
        .background(Color(Palette.Own.ground))
    }
}
