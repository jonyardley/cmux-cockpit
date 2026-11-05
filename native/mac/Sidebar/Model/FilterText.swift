import Foundation

/// What the All view's project filter shows and sends
/// (docs/design.md#filter-button, docs/design.md#filter-chip), decided
/// here so its views only lay it out. The core says what the menu holds and
/// what is chosen; the words are the sidebar's own (Words.swift).
enum FilterText {
    /// The filter's menu, while the core offers one: in All only, as the
    /// Projects view is never filtered.
    static func menu(_ panel: Panel) -> FilterMenu? {
        panel.view == .all ? panel.filter : nil
    }

    /// Whether the filter is on: a project, or the cards with no project.
    static func isOn(_ menu: FilterMenu) -> Bool {
        menu.noProjectChosen || menu.projects.contains { $0.chosen }
    }

    /// The chip above the lanes while the filter is on: "App only" with
    /// the project's colour, or "No project only" with the grey of no
    /// colour; nil while every card shows.
    static func chip(_ menu: FilterMenu) -> (label: String, color: UInt32?)? {
        if let project = menu.projects.first(where: { $0.chosen }) {
            return (project.name + " " + Words.only, project.color)
        }
        return menu.noProjectChosen ? (Words.filterNoProject + " " + Words.only, nil) : nil
    }

    /// What picking a project sends: All filtered to it.
    static func pick(_ project: FilterProject) -> SidebarAction {
        .filterProject(key: project.key)
    }

    /// What picking "No project" sends: All filtered to the cards with no
    /// project, by the key the core gave.
    static func pickNoProject(_ menu: FilterMenu) -> SidebarAction {
        .filterProject(key: menu.noProject)
    }

    /// What "Everything" and the chip's x send: every card again.
    static var clear: SidebarAction { .filterProject(key: nil) }

    /// A lane's count as its header shows it: "1 of 4" while the filter
    /// hides some of what it holds (the core's `total`), else the count.
    static func count(_ lane: Lane) -> String {
        guard let total = lane.total else { return String(lane.count) }
        return "\(lane.count) \(Words.of) \(total)"
    }
}
