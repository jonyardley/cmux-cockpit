import Foundation

/// Every fixed word and mark the sidebar draws itself, in one place
/// (docs/design.md#where-words-come-from). Where one mirrors the core's
/// panel module (native/core/src/panel/mod.rs) the views test checks it
/// there. The panel model carries the words that change; these are the
/// ones that never do. The views test reads those the terminal pane also
/// draws (Next, the lane mark, the folds) against its snapshots, and pins
/// the editor's, Ready, Drop here and the Message agent popover's.
enum Words {
    static let all = "All"
    static let projects = "Projects"
    static let next = "Next"
    static let nextNothing = "nothing waiting"
    /// The help on a waiting card's x.
    static let dismiss = "Dismiss"
    static let laneMark = "■"
    static let folded = "▸"
    static let open = "▾"
    /// The Projects view's rows, as the core's panel module words them.
    static let newProject = "+ New project"
    static let quiet = "Quiet"
    static let plus = "+"
    /// The editor's labels (docs/design.md#editor-sheet); the views test
    /// pins them.
    static let folder = "Folder"
    static let name = "Name"
    static let colour = "Colour"
    static let icon = "Icon"
    /// The editor sheet's title and buttons (docs/design.md#editor-sheet);
    /// the views test pins them.
    static let newProjectTitle = "New project"
    static let editProjectTitle = "Edit project"
    static let add = "Add"
    static let done = "Done"
    static let cancel = "Cancel"
    static let projectName = "Project name"
    static let searchIcons = "Search icons"
    static let openFolders = "Or one you have open"
    static let notRunning = "Cockpit isn't running"
    static let startIt = "Open Cockpit.app to start it."
    static let waiting = "Waiting for the panel"
    static let waitingWhy = "Cockpit is running; the first panel arrives within ten seconds."
    /// The green pill on a card whose agent finished while Jon was
    /// elsewhere (docs/design.md#ready-pill).
    static let ready = "Ready"
    /// The card menu's last item and the popover it opens
    /// (docs/design.md#message-agent-popover). Its Cancel is `cancel`.
    static let messageAgent = "Message agent…"
    static let messagePrompt = "Message for the agent in"
    static let send = "Send"
    static let notSent = "Not sent: the cockpit could not take it. Try again."
}
