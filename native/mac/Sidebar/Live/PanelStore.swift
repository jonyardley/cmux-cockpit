import Foundation
import Observation

/// What the sidebar reads from the App Group folder: the helper's
/// heartbeat, the latest data.json and the answers in inbox/, all into the
/// sidebar's own core (SidebarCore.swift), whose panel it draws. The
/// "changed" signal reads them at once, so a status change shows as soon
/// as the publisher writes it; a slow poll catches a dropped signal and a
/// helper that stopped without saying so (a crash), and moves the core's
/// clock on.
@Observable
@MainActor
final class PanelStore {
    private(set) var running = false
    private(set) var panel: Panel?

    var showing: Showing { Showing.of(panel: panel, running: running) }

    @ObservationIgnored private var observer: NSObjectProtocol?
    @ObservationIgnored private var timer: Timer?
    /// data.json's bytes last loaded, so an unchanged file is not sent
    /// to the core again on every poll.
    @ObservationIgnored private var loaded: Data?

    func start() {
        guard observer == nil else { return }
        SidebarCore.changed = { [weak self] in self?.show($0) }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Shared.changed, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: Heartbeat.pollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.read()
                SidebarCore.tick()
            }
        }
        read()
    }

    func read() {
        let folder = Shared.folder
        let beat = folder
            .flatMap { try? String(contentsOf: $0.appendingPathComponent(Heartbeat.fileName), encoding: .utf8) }
            .flatMap(Heartbeat.decode)
        let alive = Heartbeat.isAlive(beat: beat, now: Date())
        if alive != running { running = alive }
        guard let folder else { return }
        // A file that will not read, or that the core refuses, keeps the
        // last panel on screen and is tried again at the next poll.
        let file = folder.appendingPathComponent(DataFile.fileName)
        if let bytes = try? Data(contentsOf: file), bytes != loaded, SidebarCore.load(bytes) {
            loaded = bytes
        }
        for answer in Inbox.take(from: folder) {
            SidebarCore.answer(answer)
        }
    }

    /// Draws the core's panel.
    private func show(_ next: Panel) {
        // Every fresh panel, so a click is let go as soon as it shows.
        SelectState.shared.reconcile(next)
        if next != panel { panel = next }
    }
}
