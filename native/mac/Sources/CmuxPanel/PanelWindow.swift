import AppKit
import PanelLayout

/// The docked panel: a borderless, shadowless window over cmux's sidebar,
/// inside cmux's window frame, that never takes focus from cmux. It
/// follows every Space, full screen ones included, and shows placeholder
/// words until the real panel content lands.
final class PanelWindow: NSPanel {
    private let label = NSTextField(wrappingLabelWithString: "")
    private let settingsButton = NSButton(title: "Open Accessibility settings", target: nil, action: nil)
    private let background = NSVisualEffectView()
    private var shown = false

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: fallbackSidebarWidth, height: 400),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        // All Spaces, and full screen ones as an auxiliary window, so it
        // can sit on cmux's full screen Space.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        // Clear and non opaque so the rounded corner shows what is behind.
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .normal

        // A neutral system sidebar material for now, as close to cmux's
        // sidebar as a stock material gets. Always active: the panel never
        // becomes key, so following the window's state would draw it as
        // inactive for good.
        background.material = .sidebar
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.masksToBounds = true
        // AppKit layers put y up, so the minimum y corner is the bottom.
        background.layer?.maskedCorners = [.layerMinXMinYCorner]

        settingsButton.target = self
        settingsButton.action = #selector(openSettings)
        let stack = NSStackView(views: [label, settingsButton])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            stack.topAnchor.constraint(equalTo: background.topAnchor),
        ])
        contentView = background
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Places the panel and keeps it just above cmux's window, from the
    /// window list's on-screen windows front to back.
    func apply(_ placement: Placement, frontToBack: [Int], cmuxNumber: Int?) {
        switch placement {
        case .hidden:
            if shown { orderOut(nil) }
        case let .docked(frame, raised, cornerRadius):
            label.stringValue = "Cockpit panel\n\nPlaceholder: docked to cmux."
            settingsButton.isHidden = true
            background.layer?.cornerRadius = cornerRadius
            level = raised ? .floating : .normal
            move(to: frame)
            reorder(ordering(raised: raised, frontToBack: frontToBack, panel: windowNumber, cmux: cmuxNumber))
        case let .askingPermission(frame):
            label.stringValue = "Cockpit panel needs the Accessibility permission to find cmux's window.\n\n"
                + "Turn on CmuxPanel under Privacy & Security, Accessibility. The panel docks once it is on."
            settingsButton.isHidden = false
            background.layer?.cornerRadius = 0
            level = .normal
            move(to: frame)
            // Once only: brought forward on every poll it would cover
            // whatever app Jon is using.
            if !shown { orderFrontRegardless() }
        }
        shown = placement.isShown
    }

    private func move(to frame: Rect) {
        let target = NSRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        if self.frame != target { setFrame(target, display: true) }
    }

    /// Run on every refresh, not only when the panel first shows: a panel
    /// already on screen still needs ordering onto a Space it has just
    /// joined, such as cmux's new full screen Space, and back above cmux
    /// after cmux comes forward.
    private func reorder(_ ordering: Ordering) {
        switch ordering {
        case .keep:
            break
        case let .above(cmux):
            order(.above, relativeTo: cmux)
        case .front:
            orderFrontRegardless()
        }
    }

    @objc private func openSettings() {
        let link = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }
}

private extension Placement {
    var isShown: Bool {
        if case .hidden = self { return false }
        return true
    }
}
