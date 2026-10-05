import AppKit
import ApplicationServices
import PanelLayout

/// cmux's bundle identifier.
let cmuxBundleID = "com.cmuxterm.app"

/// Watches cmux and calls `onChange` whenever its window may have moved,
/// resized, changed Space, hidden or gone. Accessibility notifications give
/// the quick path; a short poll catches what they miss (full screen
/// animations and Space changes do not always notify). A moved or resized
/// notification calls `onMove` instead, which starts fast tracking.
final class CmuxWatcher {
    private let onChange: () -> Void
    private let onMove: () -> Void
    private var observer: AXObserver?
    private var observedPID: pid_t?
    private var tokens: [NSObjectProtocol] = []
    private var timer: Timer?
    /// Every on-screen window's number, front to back, as of the last
    /// read, for keeping the panel just above cmux.
    private(set) var frontToBack: [Int] = []
    /// cmux's sidebar list as the last read found it, so fast tracking can
    /// read its frame alone while the divider is dragged.
    private(set) var sidebarElement: AXUIElement?

    init(onChange: @escaping () -> Void, onMove: @escaping () -> Void) {
        self.onChange = onChange
        self.onMove = onMove
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
        let list = readWindowList()
        frontToBack = list.map(\.number)
        sidebarElement = nil
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
        let cmuxWindows = list.filter { $0.pid == app.processIdentifier }.map(\.listed)
        let layout = sidebarLayout(window)
        sidebarElement = layout.element
        return .window(CmuxWindow(
            frame: candidate.frame,
            isMinimised: (try? AX.bool(window, kAXMinimizedAttribute).get()) ?? false,
            isFullScreen: (try? AX.bool(window, "AXFullScreen").get()) ?? false,
            windowNumber: matchWindow(candidate.frame, onScreen: cmuxWindows),
            sidebar: layout.sidebar,
            content: layout.content
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
        let callback: AXObserverCallback = { _, _, notification, refcon in
            guard let refcon else { return }
            let watcher = Unmanaged<CmuxWatcher>.fromOpaque(refcon).takeUnretainedValue()
            let name = notification as String
            if name == kAXWindowMovedNotification || name == kAXWindowResizedNotification {
                watcher.onMove()
            } else {
                watcher.onChange()
            }
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

/// One window's bounds from the window list, top-left and y down, or nil
/// when it is gone. Asking for that window alone keeps the read cheap
/// enough for every display refresh.
func windowBounds(_ number: Int) -> Rect? {
    guard let id = CGWindowID(exactly: number),
          let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
          let bounds = list.first?[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds)
    else { return nil }
    return Rect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
}

/// One on-screen window from the window list, with its owner.
private struct OnScreenWindow {
    var pid: pid_t
    var listed: ListedWindow
    var number: Int { listed.number }
}

/// Every window on screen on the current Space, front to back, top-left
/// and y down. Read once per refresh: it gives cmux's Space check, its
/// window number and the stacking order. The window list gives numbers,
/// bounds and owners without the Screen Recording permission.
private func readWindowList() -> [OnScreenWindow] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { info in
        guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
              let number = info[kCGWindowNumber as String] as? Int,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds)
        else { return nil }
        let frame = Rect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
        return OnScreenWindow(pid: pid, listed: ListedWindow(number: number, frame: frame))
    }
}

/// Where cmux's sidebar list and the content beside it sit, found by
/// Accessibility: within the window's top views, the scroll area cmux
/// tags `Sidebar` and the split view of panes. Either is nil when cmux's
/// layout no longer has it (the sidebar closed, or a cmux update moved
/// things), and the pure rules fall back.
private func sidebarLayout(_ window: AXUIElement) -> (sidebar: Rect?, content: Rect?, element: AXUIElement?) {
    let top = (try? AX.elements(window, kAXChildrenAttribute).get()) ?? []
    let views = top + top.flatMap { (try? AX.elements($0, kAXChildrenAttribute).get()) ?? [] }
    var sidebar: Rect?
    var content: Rect?
    var element: AXUIElement?
    for view in views where sidebar == nil || content == nil {
        let role = try? AX.string(view, kAXRoleAttribute).get()
        if content == nil, role == kAXSplitGroupRole {
            content = try? AX.frame(view).get()
        } else if sidebar == nil, role == kAXScrollAreaRole,
                  (try? AX.string(view, kAXIdentifierAttribute).get()) == "Sidebar" {
            sidebar = try? AX.frame(view).get()
            element = view
        }
    }
    return (sidebar, content, element)
}
