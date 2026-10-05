// When the panel follows cmux at the display's refresh rate, and when it
// settles back to notifications and the poll. Pure, so every rule has a
// test; the glue runs the display link and reads the frames.

/// How long cmux's window and sidebar must stay still before fast
/// tracking stops.
public let trackingSettleSeconds: Double = 0.3

/// Moves smaller than this, in points, are not a change: Accessibility
/// and the window list can disagree by a fraction of a point, and the
/// tracker sees both.
public let trackingTolerance: Double = 1

/// Starts fast tracking on a move or resize and stops it once nothing has
/// changed for `trackingSettleSeconds`.
public struct FrameTracker: Equatable, Sendable {
    public private(set) var isTracking = false
    private var lastFrame: Rect?
    private var lastSidebar: Rect?
    private var lastChange: Double = 0

    public init() {}

    /// An Accessibility moved or resized notification: start now, before
    /// any frame has been read.
    public mutating func kick(now: Double) {
        isTracking = true
        lastChange = now
    }

    /// A read of cmux's frame and sidebar, from a display link tick or the
    /// poll; nil when the window is gone. Starts tracking on a change
    /// against the last read (but not on the very first one), and stops it
    /// once things have been still long enough. Returns whether tracking
    /// is on afterwards.
    @discardableResult
    public mutating func observe(frame: Rect?, sidebar: Rect?, now: Double) -> Bool {
        guard let frame else {
            isTracking = false
            lastFrame = nil
            lastSidebar = nil
            return false
        }
        let changed = lastFrame.map { !$0.isClose(to: frame, tolerance: trackingTolerance) || !same(lastSidebar, sidebar) } ?? false
        lastFrame = frame
        lastSidebar = sidebar
        if changed {
            isTracking = true
            lastChange = now
        } else if isTracking && now - lastChange >= trackingSettleSeconds {
            isTracking = false
        }
        return isTracking
    }

    private func same(_ a: Rect?, _ b: Rect?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a?, b?): return a.isClose(to: b, tolerance: trackingTolerance)
        default: return false
        }
    }
}

extension CmuxWindow {
    /// This window read in full, moved to a frame read quickly mid drag:
    /// the content shifts with the window's top left corner, and the
    /// sidebar takes the fresh read when there is one, else shifts too.
    public func following(frame newFrame: Rect, sidebar newSidebar: Rect?) -> CmuxWindow {
        let dx = newFrame.x - frame.x
        let dy = newFrame.y - frame.y
        func shifted(_ rect: Rect) -> Rect {
            Rect(x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height)
        }
        var moved = self
        moved.frame = newFrame
        moved.sidebar = newSidebar ?? sidebar.map(shifted)
        moved.content = content.map(shifted)
        return moved
    }
}
