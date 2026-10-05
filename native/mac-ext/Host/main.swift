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

// The way back: the sidebar drops an action file into the group container
// and posts a bare notification. The host counts the files it finds, which
// the sidebar shows, so one tap proves the round trip.
let actionName = Notification.Name("dev.jonyardley.cockpit.action")
var actionsSeen = 0

func collectActions() {
    guard let dir = container?.appendingPathComponent("actions") else { return }
    let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    for file in files {
        actionsSeen += 1
        try? FileManager.default.removeItem(at: file)
    }
    defaults?.set(actionsSeen, forKey: "actionsSeen")
}

var notifiedActions = 0
DistributedNotificationCenter.default().addObserver(forName: actionName, object: nil, queue: .main) { _ in
    notifiedActions += 1
    defaults?.set(notifiedActions, forKey: "actionNotifications")
    collectActions()
}

print("container:", container?.path ?? "none")
// Also sweep each second, in case the sandbox drops the notification.
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in collectActions() }
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in publish() }
NSApplication.shared.run()
