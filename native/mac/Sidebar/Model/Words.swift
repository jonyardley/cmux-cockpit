import Foundation

/// The panel's own words and marks, as the core's panel module words them
/// (native/core/src/panel/mod.rs). The panel model carries the words that
/// change; these are the ones that never do. The card words test reads
/// them against the pane's snapshots, so a drift fails there.
enum Words {
    static let all = "All"
    static let projects = "Projects"
    static let next = "Next"
    static let nextNothing = "nothing waiting"
    static let needs = "Needs you"
    /// Between a placeholder's title and why its card went.
    static let ghostGap = "·"
    static let ghost = "◌"
    static let laneMark = "■"
    static let folded = "▸"
    static let open = "▾"
    static let ellipsis = "…"
    /// The Projects view's rows, as the core's panel module words them.
    static let newProject = "+ New project"
    static let quiet = "Quiet"
    static let plus = "+"
    /// The editor's labels, as the pane's editor words them
    /// (native/pane/src/editor.rs); the views check reads them there.
    static let folder = "Folder"
    static let name = "Name"
    static let colour = "Colour"
    static let icon = "Icon"
    static let use = "Use"
    /// The editor sheet's own words: the pane says "Enter saves · Esc
    /// cancels" where the sheet has buttons.
    static let newProjectTitle = "New project"
    static let editProjectTitle = "Edit project"
    static let save = "Save"
    static let cancel = "Cancel"
    static let searchIcons = "Search icons"
    static let notRunning = "Cockpit isn't running"
    static let startIt = "Open Cockpit.app to start it."
    static let waiting = "Waiting for the panel"
    static let waitingWhy = "Cockpit is running; the first panel arrives within ten seconds."
}
