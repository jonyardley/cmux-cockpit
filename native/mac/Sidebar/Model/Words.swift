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
    /// Where the Projects view goes until R2.8 draws it.
    static let projectsSoon = "Projects arrive in a later release."
    static let notRunning = "Cockpit isn't running"
    static let startIt = "Open Cockpit.app to start it."
    static let waiting = "Waiting for the panel"
    static let waitingWhy = "Cockpit is running; the first panel arrives within ten seconds."
}
