import AppKit

// The unsandboxed host. In the real thing it runs the Rust runner and
// publishes the panel model; in the spike it publishes a counter once a
// second, three ways, so the sidebar can show which ones cross the sandbox.
let group = "9S5FG4LQAF.dev.jonyardley.cockpit"
let tickName = Notification.Name("dev.jonyardley.cockpit.tick")

let defaults = UserDefaults(suiteName: group)
let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
let modelFile = container?.appendingPathComponent("model.json")
var count = 0

func publish() {
    count += 1
    defaults?.set(count, forKey: "count")
    if let modelFile {
        let json = "{\"count\":\(count),\"at\":\"\(Date())\"}"
        try? json.write(to: modelFile, atomically: true, encoding: .utf8)
    }
    DistributedNotificationCenter.default().postNotificationName(
        tickName, object: nil, userInfo: nil, deliverImmediately: true
    )
}

print("container:", container?.path ?? "none")
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in publish() }
NSApplication.shared.run()
