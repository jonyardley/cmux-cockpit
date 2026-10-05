import AppKit
import ApplicationServices
import PanelLayout

/// Asks for the Accessibility permission the first time only. Later
/// launches without it show the panel's own message and a button to the
/// setting, rather than raising the system prompt again.
func accessibilityPermission() -> Permission {
    if AXIsProcessTrusted() { return .granted }
    let key = "askedForAccessibility"
    if !UserDefaults.standard.bool(forKey: key) {
        UserDefaults.standard.set(true, forKey: key)
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options) ? .granted : .missing
    }
    return .missing
}

/// The primary screen first, as AppKit lists it. Coordinates flip on the
/// primary screen's full height; room is judged on each visible frame.
func currentScreens() -> Screens {
    let visible = NSScreen.screens.map { screen in
        let area = screen.visibleFrame
        return Rect(x: area.minX, y: area.minY, width: area.width, height: area.height)
    }
    return Screens(primaryHeight: Double(NSScreen.screens.first?.frame.height ?? 0), frames: visible)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let panel = PanelWindow()
    private var watcher: CmuxWatcher?
    private var permission: Permission = .missing
    private var activation: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A cmux that stops answering would otherwise hold each read for
        // the default six seconds and freeze the panel with it. This sets
        // the timeout for this process's reads only.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)
        permission = accessibilityPermission()
        let watcher = CmuxWatcher { [weak self] in self?.refresh() }
        self.watcher = watcher
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.bundleIdentifier == cmuxBundleID { self?.panel.raiseWithCmux() }
        }
        watcher.start()
    }

    private func refresh() {
        // Granted or revoked while running: picked up on the next poll, no
        // relaunch, so turning the switch off brings the strip back.
        permission = AXIsProcessTrusted() ? .granted : .missing
        let cmux = permission == .granted ? (watcher?.read() ?? .notRunning) : .notRunning
        panel.apply(place(permission: permission, cmux: cmux, screens: currentScreens()))
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
