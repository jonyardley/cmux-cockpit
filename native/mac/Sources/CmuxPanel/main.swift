import AppKit
import QuartzCore
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
/// primary screen's full height; the permission strip uses the first
/// visible frame.
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
    private var screens = currentScreens()
    /// cmux's window as the last full read found it, the base that fast
    /// tracking moves.
    private var lastWindow: CmuxWindow?
    private var tracker = FrameTracker()
    /// Ticks at the display's refresh rate while cmux moves; paused
    /// otherwise.
    private var displayLink: CADisplayLink?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A cmux that stops answering would otherwise hold each read for
        // the default six seconds and freeze the panel with it. This sets
        // the timeout for this process's reads only.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)
        permission = accessibilityPermission()
        let watcher = CmuxWatcher(
            onChange: { [weak self] in self?.refresh() },
            onMove: { [weak self] in self?.startTracking() }
        )
        self.watcher = watcher
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            // cmux coming forward brings its windows over the panel: refresh
            // now rather than on the next poll, which orders it back on top.
            if app?.bundleIdentifier == cmuxBundleID { self?.refresh() }
        }
        watcher.start()
    }

    private func refresh() {
        // Granted or revoked while running: picked up on the next poll, no
        // relaunch, so turning the switch off brings the strip back.
        permission = AXIsProcessTrusted() ? .granted : .missing
        screens = currentScreens()
        let cmux = permission == .granted ? (watcher?.read() ?? .notRunning) : .notRunning
        var cmuxNumber: Int?
        lastWindow = nil
        if case let .window(window) = cmux {
            cmuxNumber = window.windowNumber
            lastWindow = window
        }
        // The poll seeing a change (a divider drag sends no notification)
        // starts fast tracking as well.
        let now = ProcessInfo.processInfo.systemUptime
        if tracker.observe(frame: lastWindow?.frame, sidebar: lastWindow?.sidebar, now: now) {
            startTracking()
        }
        panel.apply(
            place(permission: permission, cmux: cmux, screens: screens),
            frontToBack: watcher?.frontToBack ?? [],
            cmuxNumber: cmuxNumber
        )
    }

    /// A move or resize under way: follow cmux on every display refresh.
    private func startTracking() {
        tracker.kick(now: ProcessInfo.processInfo.systemUptime)
        if displayLink == nil {
            let link = panel.displayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
        displayLink?.isPaused = false
    }

    /// One display refresh while tracking: cmux's frame from the window
    /// list (that one window only) and the sidebar's frame from its cached
    /// element, then the panel moved to match. Once the tracker settles,
    /// the link pauses and a full refresh puts everything else right.
    @objc private func tick() {
        guard let base = lastWindow, let number = base.windowNumber else { return settle() }
        let frame = windowBounds(number)
        let sidebar = watcher?.sidebarElement.flatMap { try? AX.frame($0).get() }
        let now = ProcessInfo.processInfo.systemUptime
        guard tracker.observe(frame: frame, sidebar: sidebar, now: now), let frame else { return settle() }
        let moved = base.following(frame: frame, sidebar: sidebar)
        panel.follow(place(permission: permission, cmux: .window(moved), screens: screens))
    }

    private func settle() {
        displayLink?.isPaused = true
        refresh()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
