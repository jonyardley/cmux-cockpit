import AppKit

// The helper app: unsandboxed, no Dock icon, no window. For now it only
// beats, so the Cockpit extension in cmux can tell it is running. Later it
// starts the runner and publishes the panel model into the same folder.

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

/// Deletes the heartbeat and tells the extension, so a clean quit shows
/// "Cockpit isn't running" at once rather than after the stale window.
func farewell() {
    if let heartbeatFile { try? FileManager.default.removeItem(at: heartbeatFile) }
    announce()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        farewell()
    }
}

// `pkill -x Cockpit` (SIGTERM) and Control C (SIGINT) skip the delegate,
// so catch them and say goodbye the same way.
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler {
        farewell()
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}

if Shared.folder == nil {
    print("No App Group folder: this build is not signed with the group entitlement.")
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
beat()
announce()
Timer.scheduledTimer(withTimeInterval: Heartbeat.interval, repeats: true) { _ in beat() }
NSApplication.shared.run()
