import AppKit
import PanelLayout

/// The docked panel: a borderless window that never takes focus from
/// cmux, follows every Space (so it can join cmux's full screen Space),
/// and shows placeholder words until the real panel content lands.
final class PanelWindow: NSPanel {
    private let label = NSTextField(wrappingLabelWithString: "")
    private let settingsButton = NSButton(title: "Open Accessibility settings", target: nil, action: nil)
    private var shown = false

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: defaultPanelWidth, height: 400),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        backgroundColor = .windowBackgroundColor
        hasShadow = false
        level = .normal

        settingsButton.target = self
        settingsButton.action = #selector(openSettings)
        let stack = NSStackView(views: [label, settingsButton])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        contentView = stack
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func apply(_ placement: Placement) {
        switch placement {
        case .hidden:
            if shown { orderOut(nil) }
            shown = false
        case let .docked(frame, _, raised):
            show(frame: frame, text: "Cockpit panel\n\nPlaceholder: docked to cmux.", level: raised ? .floating : .normal)
            settingsButton.isHidden = true
        case let .askingPermission(frame):
            let text = "Cockpit panel needs the Accessibility permission to find cmux's window.\n\n"
                + "Turn on CmuxPanel under Privacy & Security, Accessibility. The panel docks once it is on."
            show(frame: frame, text: text, level: .normal)
            settingsButton.isHidden = false
        }
    }

    /// Brings the panel up beside cmux when cmux comes to the front, so
    /// it sits with cmux's window rather than under another app's.
    func raiseWithCmux() {
        if shown { orderFrontRegardless() }
    }

    private func show(frame: Rect, text: String, level: NSWindow.Level) {
        label.stringValue = text
        self.level = level
        let target = NSRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        if self.frame != target { setFrame(target, display: true) }
        if !shown { orderFrontRegardless() }
        shown = true
    }

    @objc private func openSettings() {
        let link = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }
}
