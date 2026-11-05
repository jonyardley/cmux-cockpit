import Foundation

/// What the All view's add button shows and sends (docs/design.md#add-button),
/// decided here so its view only lays it out. The core says which projects
/// the menu holds and whether the home folder is known; the words are the
/// sidebar's own (Words.swift).
enum AddText {
    /// The add button's menu, while the core offers one: in All only, as
    /// Projects has a "+" on each project instead.
    static func menu(_ panel: Panel) -> AddMenu? {
        panel.view == .all ? panel.add : nil
    }

    /// A project's item: its name, or with no folder its name and why it
    /// opens nothing.
    static func label(_ project: AddProject) -> String {
        project.canOpen ? project.name : project.name + " " + Words.noFolder
    }

    /// What picking a project sends: a new session in its folder, or
    /// nothing for one with no folder, which the menu shows disabled.
    static func pick(_ project: AddProject) -> SidebarAction? {
        project.canOpen ? .addSession(project: project.key) : nil
    }

    /// What picking "No project" sends: a new session in the home folder,
    /// or nothing while the core knows no home, when it shows disabled.
    static func pickHome(_ menu: AddMenu) -> SidebarAction? {
        menu.home ? .addSession(project: nil) : nil
    }
}
