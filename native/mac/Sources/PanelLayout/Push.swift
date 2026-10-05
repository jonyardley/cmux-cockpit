// Making room for the panel when cmux leaves none: cmux's main window is
// moved right and narrowed by the shortfall, and given its frame back
// when the panel quits. Plain values only, like the rest of this module;
// the glue sets the frame by Accessibility and reports what landed.

/// The narrowest cmux is ever pushed to. Narrower than this and the panel
/// overlaps cmux's left strip instead, as it does without the push.
public let minimumCmuxWidth: Double = 640

/// How long cmux's frame must stay still before the panel pushes it, so a
/// drag in progress is never fought.
public let pushSettleSeconds: Double = 0.5

/// How far, in points, a frame cmux reports may sit from the one asked for
/// and still count as it. The push trigger, the landed check, the restore
/// and the dock rule all use it, so a window a fraction of a point short
/// of the panel's edge is never pushed over and over.
public let pushTolerance: Double = 1

/// One push: cmux's new frame and the panel's frame beside it.
public struct Push: Equatable, Sendable {
    /// cmux's frame to set, top-left and y down, as Accessibility takes it.
    public var cmuxFrame: Rect
    /// The panel's frame, flush with cmux's new left edge, in AppKit space.
    public var panelFrame: Rect

    public init(cmuxFrame: Rect, panelFrame: Rect) {
        self.cmuxFrame = cmuxFrame
        self.panelFrame = panelFrame
    }
}

/// The push that gives the panel room to cmux's left, or nil when there is
/// room already or a push cannot help: full screen, minimised, on another
/// Space, on no screen, or the push would leave cmux narrower than
/// `minimumWidth`. Its right edge stays put, pulled in to the screen's
/// right edge when it ran past it, so cmux never goes off screen.
public func makeRoom(
    window: CmuxWindow,
    screens: Screens,
    width: Double = defaultPanelWidth,
    minimumWidth: Double = minimumCmuxWidth
) -> Push? {
    guard !window.isFullScreen, !window.isMinimised, window.isOnCurrentSpace else { return nil }
    let frame = toAppKit(window.frame, primaryScreenHeight: screens.primaryHeight)
    guard let screen = screenFor(frame, screens: screens) else { return nil }
    let left = screen.minX + width
    guard frame.minX < left - pushTolerance else { return nil }
    let newWidth = min(frame.maxX, screen.maxX) - left
    guard newWidth >= minimumWidth else { return nil }
    return Push(
        cmuxFrame: Rect(x: left, y: window.frame.y, width: newWidth, height: window.frame.height),
        panelFrame: Rect(x: screen.minX, y: frame.minY, width: width, height: frame.height)
    )
}

/// Whether the frame cmux reports after a push is one the panel can live
/// with: its left edge where the push put it, and its right edge no further
/// right than asked (a window that refused to narrow would otherwise hang
/// off the screen). A narrower result, such as one rounded to whole
/// terminal cells, still counts.
public func pushLanded(_ landed: Rect, for target: Rect, tolerance: Double = pushTolerance) -> Bool {
    abs(landed.minX - target.minX) <= tolerance && landed.maxX <= target.maxX + tolerance
}

/// Remembers the panel's push and decides when to push again or give the
/// room back. Times are seconds on any steady clock.
public struct PushTracker: Equatable, Sendable {
    /// cmux's frame before the push and the frame the push left it at.
    public struct Record: Equatable, Sendable {
        public var before: Rect
        public var after: Rect
    }

    public private(set) var pushed: Record?
    private var lastFrame: Rect?
    private var stillSince: Double = 0
    private var refused: Rect?
    /// A refusal was just recorded: the next frame seen is the refused one.
    private var refusalPending = false

    public init() {}

    /// Notes cmux's frame at `now` and returns the push to make, if any.
    /// Nothing until the frame has been still for `settle` seconds with no
    /// mouse button held, so a drag that pauses is not fought either; and
    /// nothing again for a frame cmux already refused. A still frame that
    /// is no longer the one the panel set means cmux was moved or resized
    /// since, so the push is forgotten and quitting leaves it alone.
    public mutating func next(
        window: CmuxWindow,
        screens: Screens,
        now: Double,
        mouseDown: Bool,
        width: Double = defaultPanelWidth,
        settle: Double = pushSettleSeconds
    ) -> Push? {
        noteRefusal(at: window.frame)
        if lastFrame != window.frame {
            lastFrame = window.frame
            stillSince = now
        }
        guard !mouseDown, now - stillSince >= settle else { return nil }
        if let record = pushed, !record.after.isClose(to: window.frame, tolerance: pushTolerance) {
            pushed = nil
        }
        if refused != nil { return nil }
        return makeRoom(window: window, screens: screens, width: width)
    }

    /// The push landed: cmux went from `before` to `after`.
    /// Pushing again from the frame the last push left (the Dock moved,
    /// say) keeps the first push's `before`, so quitting still gives cmux
    /// the frame it had before the panel touched it.
    public mutating func recordPush(before: Rect, after: Rect) {
        let original = pushed.flatMap { $0.after.isClose(to: before, tolerance: pushTolerance) ? $0.before : nil }
        pushed = Record(before: original ?? before, after: after)
        refusalPending = false
        refused = nil
        lastFrame = after
    }

    /// cmux refused the push. Whatever frame it is seen at next (back where
    /// it was, or part way if the undo was refused too) is not pushed again
    /// until cmux moves off it, so a half applied push never compounds.
    public mutating func recordRefusal() {
        refused = nil
        refusalPending = true
    }

    /// Takes the first frame seen after a refusal as the refused one, and
    /// forgets the refusal once cmux moves off it.
    private mutating func noteRefusal(at frame: Rect) {
        if refusalPending {
            refused = frame
            refusalPending = false
        } else if let refusedFrame = refused, refusedFrame != frame {
            refused = nil
        }
    }

    /// The frame to give cmux back on quit: its frame before the push, but
    /// only while it still has the frame the push left (to within a point,
    /// for rounding), so a move or resize since is never undone.
    public func restoreTarget(current: Rect) -> Rect? {
        guard let pushed, pushed.after.isClose(to: current, tolerance: pushTolerance) else { return nil }
        return pushed.before
    }
}
