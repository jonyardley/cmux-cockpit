import Observation
import os
import SwiftUI

/// A click's timeline for Console or `log stream`, as DragLog has the
/// drag's: the click, cmux taking the select or not, and the panel
/// showing it (or the click lapsing), each with the milliseconds since
/// the click.
enum SelectLog {
    static let log = Logger(subsystem: "dev.jonyardley.cockpit.sidebar", category: "select")
    @MainActor private static var start = Date()

    @MainActor static func clicked(_ id: String) {
        start = Date()
        log.info("select \(id, privacy: .public)")
    }

    @MainActor static func note(_ what: String) {
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        log.info("\(what, privacy: .public) +\(ms)ms")
    }
}

/// The click waiting for panel.json to show its selection, shared by
/// every card, Needs you row and lane anchor.
@Observable
@MainActor
final class SelectState {
    static let shared = SelectState()

    private(set) var pending: PendingSelect?
    /// The panel last drawn, so a click on what it already has selected
    /// draws nothing new and waits for nothing.
    @ObservationIgnored private var latest: Panel?

    /// Jon clicked `id`: it draws selected from now until the panel shows
    /// it so or the click lapses.
    func select(_ id: String) {
        SelectLog.clicked(id)
        if let latest, PendingSelect.selected(in: latest).contains(id) {
            pending = nil
            SelectLog.note("already selected")
            return
        }
        let click = PendingSelect(id: id, until: Date().addingTimeInterval(PendingSelect.lasts))
        pending = click
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(PendingSelect.lasts))
            self?.lapse(click)
        }
    }

    /// Whether `id`, selected or not in panel.json, draws selected.
    func shows(_ id: String, selected: Bool) -> Bool {
        PendingSelect.shows(id, selected: selected, pending: pending)
    }

    /// A fresh panel: the click it shows done stops being drawn over it.
    func reconcile(_ panel: Panel) {
        latest = panel
        guard let pending, pending.confirmed(by: panel) else { return }
        SelectLog.note("panel shows it selected")
        self.pending = nil
    }

    /// `click` has had its time; a later click keeps its own.
    private func lapse(_ click: PendingSelect) {
        guard pending == click, !click.live(at: Date()) else { return }
        SelectLog.note("lapsed: the panel never showed it")
        pending = nil
    }
}
