import Foundation

/// Keeps cockpit-publish running beside the helper: starts it, starts it
/// again after the backoff when it stops, and stops it when the helper
/// quits. It stops by itself too if the helper dies without a word: it
/// watches the parent it was given.
@MainActor
final class Publisher {
    private let binary: URL
    private var process: Process?
    private var started = Date()
    private var restart = Restart()
    private var stopping = false
    private let log: FileHandle?

    /// Nil when the app has no cockpit-publish inside it.
    init?() {
        guard let url = Bundle.main.url(forAuxiliaryExecutable: PublishLaunch.binary) else { return nil }
        binary = url
        log = Publisher.openLog()
    }

    func start() {
        guard !stopping, process == nil else { return }
        let p = Process()
        p.executableURL = binary
        p.arguments = PublishLaunch.arguments(parent: getpid())
        p.environment = PublishLaunch.environment(ProcessInfo.processInfo.environment)
        p.standardInput = FileHandle.nullDevice
        if let log {
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.ended() }
        }
        do {
            try p.run()
            process = p
            started = Date()
        } catch {
            note("could not start \(binary.path): \(error)")
            schedule(after: restart.delay(after: 0))
        }
    }

    /// Stops the publisher for good: on quit.
    func stop() {
        stopping = true
        process?.terminate()
        process = nil
    }

    private func ended() {
        let status = process?.terminationStatus ?? 0
        process = nil
        guard !stopping else { return }
        let wait = restart.delay(after: Date().timeIntervalSince(started))
        note("cockpit-publish stopped (status \(status)); starting it again in \(Int(wait))s")
        schedule(after: wait)
    }

    private func schedule(after wait: TimeInterval) {
        Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.start() }
        }
    }

    private func note(_ line: String) {
        log?.write(Data("Cockpit: \(line)\n".utf8))
    }

    /// ~/Library/Logs/Cockpit/cockpit-publish.log, appended to: the
    /// publisher's own lines and the helper's notes on restarts.
    private static func openLog() -> FileHandle? {
        let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cockpit")
        let file = folder.appendingPathComponent("cockpit-publish.log")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: file)
        _ = try? handle?.seekToEnd()
        return handle
    }
}
