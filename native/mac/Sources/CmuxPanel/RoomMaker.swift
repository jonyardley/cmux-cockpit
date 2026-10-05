import AppKit
import ApplicationServices
import PanelLayout

/// Applies the push the pure tracker asks for: moves cmux's main window
/// right and narrows it so the panel fits to its left, and gives the room
/// back on quit. Every failure leaves the overlap behaviour in place.
final class RoomMaker {
    private var tracker = PushTracker()
    /// The window the last push moved, for the restore on quit.
    private var pushedWindow: AXUIElement?

    /// Pushes cmux when the tracker says to. True when cmux's frame was
    /// changed, so the caller reads it again before placing the panel.
    func update(cmux: CmuxState, window element: AXUIElement?, screens: Screens) -> Bool {
        guard case let .window(window) = cmux, let element else { return false }
        let push = tracker.next(
            window: window,
            screens: screens,
            now: ProcessInfo.processInfo.systemUptime,
            mouseDown: NSEvent.pressedMouseButtons != 0
        )
        guard let push else { return false }
        switch AX.setFrame(element, to: push.cmuxFrame, from: window.frame) {
        case let .success(landed) where pushLanded(landed, for: push.cmuxFrame):
            tracker.recordPush(before: window.frame, after: landed)
            pushedWindow = element
        case .success, .failure:
            // Refused or landed wrong: put cmux back as it was, as far as
            // it lets us, and stop asking until it moves.
            let now = (try? AX.frame(element).get()) ?? push.cmuxFrame
            let reverted = (try? AX.setFrame(element, to: window.frame, from: now).get()) ?? window.frame
            tracker.recordRefusal(at: reverted)
        }
        return true
    }

    /// Gives cmux back the frame it had before the push, if it still has
    /// the frame the push left it at.
    func restore() {
        guard let element = pushedWindow,
              let current = try? AX.frame(element).get(),
              let target = tracker.restoreTarget(current: current)
        else { return }
        _ = AX.setFrame(element, to: target, from: current)
    }
}
