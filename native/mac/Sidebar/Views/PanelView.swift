import SwiftUI

/// The All view: Needs you while something waits, then the five lanes.
struct AllView: View {
    let panel: Panel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if NeedsText.shows(panel.needs) {
                NeedsView(needs: panel.needs)
            }
            ForEach(panel.lanes, id: \.key) { LaneView(lane: $0) }
        }
    }
}

/// Where the Projects view goes until R2.8 (#246) draws it.
struct ProjectsPlaceholder: View {
    var body: some View {
        Text(Words.projectsSoon)
            .font(.system(size: Metrics.body))
            .foregroundStyle(Color(Token.secondary))
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The whole panel: the view switch and Next, then the view the core has on.
struct PanelBody: View {
    let panel: Panel

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                ViewSwitch(view: panel.view)
                NextView(next: panel.next)
                switch panel.view {
                case .all: AllView(panel: panel)
                case .projects: ProjectsPlaceholder()
                }
            }
            .padding(Metrics.gutter)
        }
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
