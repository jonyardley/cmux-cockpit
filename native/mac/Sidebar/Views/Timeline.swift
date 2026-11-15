import os
import Foundation

/// A timeline for Console or `log stream`: a line that starts it, then
/// notes with the milliseconds since, as the drag and a click log them.
@MainActor
final class Timeline {
    /// The drag: lift, the button coming up, each change of landing slot,
    /// the drop and the move sent.
    static let drag = Timeline(category: "drag")
    /// A click's select through cmux's SDK: cmux taking it, or refusing
    /// it and the core sending it instead.
    static let select = Timeline(category: "select")

    private let log: Logger
    private var start = Date()

    init(category: String) {
        log = Logger(subsystem: "dev.jonyardley.cockpit.sidebar", category: category)
    }

    /// Starts the clock with `what`, and returns when, for a note that
    /// must be timed from this start even after a later one.
    @discardableResult
    func begin(_ what: String) -> Date {
        start = Date()
        log.info("\(what, privacy: .public)")
        return start
    }

    /// `what`, timed from `since`, else from the last start.
    func note(_ what: String, since: Date? = nil) {
        let ms = Int(Date().timeIntervalSince(since ?? start) * 1000)
        log.info("\(what, privacy: .public) +\(ms)ms")
    }
}
