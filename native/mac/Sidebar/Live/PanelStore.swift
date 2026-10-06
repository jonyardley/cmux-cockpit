import Foundation
import Observation

/// What the sidebar reads from the App Group folder: the helper's
/// heartbeat and the latest panel.json. The "changed" signal reads both at
/// once, so a status change shows as soon as the publisher writes it; a
/// slow poll catches a dropped signal and a helper that stopped without
/// saying so (a crash).
@Observable
@MainActor
final class PanelStore {
    private(set) var running = false
    private(set) var panel: Panel?

    var showing: Showing { Showing.of(panel: panel, running: running) }

    @ObservationIgnored private var observer: NSObjectProtocol?
    @ObservationIgnored private var timer: Timer?
    /// panel.json's last modification seen, so an unchanged file is not
    /// decoded again on every poll.
    @ObservationIgnored private var seen: Date?

    func start() {
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Shared.changed, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: Heartbeat.pollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
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
        guard let file = folder?.appendingPathComponent(PanelFile.fileName) else { return }
        let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        guard modified != seen else { return }
        // A file that will not read or decode keeps the last panel on
        // screen, and is tried again at the next poll rather than marked
        // seen, so a read that fails once is not lost until the next write.
        guard let data = try? Data(contentsOf: file), let next = PanelFile.decode(data)?.panel else { return }
        seen = modified
        // Every fresh file, so a click is let go as soon as it shows.
        SelectState.shared.reconcile(next)
        if next != panel { panel = next }
    }
}
