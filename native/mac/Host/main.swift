import AppKit

// The helper app: unsandboxed, no Dock icon, no window. It beats, so the
// Cockpit extension in cmux can tell it is running, and keeps
// cockpit-publish running (Publisher.swift), which writes the panel model
// into the same folder. Started with --no-publish it only beats.

let heartbeatFile = Shared.folder?.appendingPathComponent(Heartbeat.fileName)

func beat() {
    guard let heartbeatFile else { return }
    try? Heartbeat.encode(Date()).write(to: heartbeatFile, atomically: true, encoding: .utf8)
}

func announce() {
    DistributedNotificationCenter.default().postNotificationName(
        Shared.changed, object: nil, userInfo: nil, deliverImmediately: true
    )
}

let publisher = CommandLine.arguments.contains(PublishLaunch.noPublish) ? nil : MainActor.assumeIsolated { Publisher() }

/// Stops the publisher, deletes the heartbeat and tells the extension, so
/// a clean quit shows "Cockpit isn't running" at once rather than after
/// the stale window.
@MainActor
func farewell() {
    publisher?.stop()
    if let heartbeatFile { try? FileManager.default.removeItem(at: heartbeatFile) }
    announce()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { farewell() }
    }
}

// `pkill -x Cockpit` (SIGTERM) and Control C (SIGINT) skip the delegate,
// so catch them and say goodbye the same way.
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler {
        MainActor.assumeIsolated { farewell() }
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
beat()
announce()
MainActor.assumeIsolated { publisher?.start() }
Timer.scheduledTimer(withTimeInterval: Heartbeat.interval, repeats: true) { _ in beat() }
NSApplication.shared.run()
