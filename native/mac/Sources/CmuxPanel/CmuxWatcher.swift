import AppKit
import ApplicationServices
import PanelLayout

/// cmux's bundle identifier.
let cmuxBundleID = "com.cmuxterm.app"

/// Watches cmux and calls `onChange` whenever its window may have moved,
/// resized, changed Space, hidden or gone. Accessibility notifications give
/// the quick path; a short poll catches what they miss (full screen
/// animations and Space changes do not always notify).
final class CmuxWatcher {
    private let onChange: () -> Void
    private var observer: AXObserver?
    private var observedPID: pid_t?
    private var tokens: [NSObjectProtocol] = []
    private var timer: Timer?
    /// The main window the last read found, for the push to move.
    private(set) var mainWindow: AXUIElement?

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    deinit {
        stop()
    }

    func start() {
        let centre = NSWorkspace.shared.notificationCenter
        let names: [Notification.Name] = [
            NSWorkspace.didLaunchApplicationNotification,
            NSWorkspace.didTerminateApplicationNotification,
            NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didUnhideApplicationNotification,
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.activeSpaceDidChangeNotification,
        ]
        tokens = names.map { name in
            centre.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.changed()
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.changed()
        }
        changed()
    }

    func stop() {
        tokens.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        tokens = []
        timer?.invalidate()
        timer = nil
        detach()
    }

    /// cmux's running instance, if any.
    static func runningCmux() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: cmuxBundleID)
            .first { !$0.isTerminated }
    }

    /// Reads cmux's state as the pure layout module wants it.
    func read() -> CmuxState {
        mainWindow = nil
        guard let app = Self.runningCmux() else { return .notRunning }
        if app.isHidden { return .hidden }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        let windows = (try? AX.elements(element, kAXWindowsAttribute).get()) ?? []
        // Also the quick way out when cmux stops answering: one timed out
        // read per poll, not one for every attribute below.
        guard !windows.isEmpty else { return .noWindow }
        let main = try? AX.element(element, kAXMainWindowAttribute).get()
        let focused = try? AX.element(element, kAXFocusedWindowAttribute).get()
        let read = windows.compactMap { window -> (AXUIElement, WindowCandidate)? in
            guard let frame = try? AX.frame(window).get() else { return nil }
            let subrole = try? AX.string(window, kAXSubroleAttribute).get()
            let candidate = WindowCandidate(
                frame: frame,
                isStandard: subrole == kAXStandardWindowSubrole,
                isMain: main.map { CFEqual($0, window) } ?? false,
                isFocused: focused.map { CFEqual($0, window) } ?? false
            )
            return (window, candidate)
        }
        guard let index = pickMainWindow(read.map(\.1)) else { return .noWindow }
        let (window, candidate) = read[index]
        mainWindow = window
        return .window(CmuxWindow(
            frame: candidate.frame,
            isMinimised: (try? AX.bool(window, kAXMinimizedAttribute).get()) ?? false,
            isFullScreen: (try? AX.bool(window, "AXFullScreen").get()) ?? false,
            isOnCurrentSpace: isOnCurrentSpace(candidate.frame, onScreen: onScreenFrames(pid: app.processIdentifier)),
            isActive: app.isActive
        ))
    }

    private func changed() {
        attachIfNeeded()
        onChange()
    }

    /// Keeps one Accessibility observer on the cmux that is running now,
    /// and drops it when cmux quits or restarts with a new process.
    private func attachIfNeeded() {
        let pid = Self.runningCmux()?.processIdentifier
        guard pid != observedPID else { return }
        detach()
        guard let pid, AXIsProcessTrusted() else { return }
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            Unmanaged<CmuxWatcher>.fromOpaque(refcon).takeUnretainedValue().onChange()
        }
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return }
        let app = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let notifications = [
            kAXWindowMovedNotification,
            kAXWindowResizedNotification,
            kAXWindowMiniaturizedNotification,
            kAXWindowDeminiaturizedNotification,
            kAXWindowCreatedNotification,
            kAXMainWindowChangedNotification,
            kAXFocusedWindowChangedNotification,
            kAXApplicationHiddenNotification,
            kAXApplicationShownNotification,
        ]
        // A notification cmux does not support fails on its own; the poll
        // covers it, so the failure is not fatal.
        notifications.forEach { _ = AXObserverAddNotification(created, app, $0 as CFString, refcon) }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
        observedPID = pid
    }

    private func detach() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        observedPID = nil
    }
}

/// cmux's windows that are on screen on the current Space, top-left and
/// y down. The window list gives bounds and owners without the Screen
/// Recording permission.
private func onScreenFrames(pid: pid_t) -> [Rect] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { info in
        guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds)
        else { return nil }
        return Rect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
    }
}
