import Observation
import os
import SwiftUI

/// A timeline for Console or `log stream`: a line that starts it, then
/// notes with the milliseconds since, as the drag and a click log them.
@MainActor
final class Timeline {
    /// The drag: lift, the button coming up, each change of landing slot,
    /// the drop and the move drawn.
    static let drag = Timeline(category: "drag")
    /// A click's selection: the click, cmux taking it or not, and the
    /// panel showing it, moving on or the click lapsing.
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

/// The click waiting for panel.json to show its selection, shared by
/// every card, Needs you row and lane anchor. The rules are
/// PendingSelect's; this holds the one click and its clock.
@Observable
@MainActor
final class SelectState {
    static let shared = SelectState()

    private(set) var pending: PendingSelect?
    /// What the last panel drew as selected, so a click on it already
    /// draws nothing new and waits for nothing.
    @ObservationIgnored private var selected: Set<String> = []
    /// Counts clicks, so a click's lapse leaves a later one alone.
    @ObservationIgnored private var clicks = 0

    /// Jon clicked `id`: it draws selected from now until the panel shows
    /// it, shows another, or the click lapses. Returns when, for the log.
    @discardableResult
    func select(_ id: String) -> Date {
        let at = Timeline.select.begin("select \(id)")
        clicks += 1
        pending = PendingSelect.clicked(id, selected: selected)
        guard pending != nil else {
            Timeline.select.note("already selected: \(id)")
            return at
        }
        let click = clicks
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(PendingSelect.lasts))
            self?.lapse(click)
        }
        return at
    }

    /// The select of `id` could not be sent at all: stop drawing it.
    func drop(_ id: String) {
        guard pending?.id == id else { return }
        Timeline.select.note("not sent: \(id)")
        pending = nil
    }

    /// Whether `id`, selected or not in panel.json, draws selected.
    func shows(_ id: String, selected: Bool) -> Bool {
        PendingSelect.shows(id, selected: selected, pending: pending)
    }

    /// A fresh panel.json: the click it shows done, or shows overtaken,
    /// stops being drawn over it.
    func reconcile(_ panel: Panel) {
        selected = PendingSelect.selected(in: panel)
        guard let pending else { return }
        switch pending.outcome(selected) {
        case .waiting: return
        case .shown: Timeline.select.note("panel shows it selected: \(pending.id)")
        case .movedOn: Timeline.select.note("panel moved on from: \(pending.id)")
        }
        self.pending = nil
    }

    private func lapse(_ click: Int) {
        guard click == clicks, let pending else { return }
        Timeline.select.note("lapsed, no drawn card showed it: \(pending.id)")
        self.pending = nil
    }
}
