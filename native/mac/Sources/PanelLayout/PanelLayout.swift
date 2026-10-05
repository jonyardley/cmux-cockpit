// Where the panel goes and whether it shows, decided from plain values.
// No AppKit and no Accessibility here, so every rule has a test; the glue
// in CmuxPanel only gathers these inputs and applies the answer.

/// A rectangle in points. Which way y points depends on where it came
/// from: Accessibility and the window list measure from the top left of
/// the primary screen, y down; AppKit measures from its bottom left, y up.
public struct Rect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var minX: Double { x }
    public var maxX: Double { x + width }
    public var minY: Double { y }
    public var maxY: Double { y + height }

    /// The area this rectangle shares with another, zero when apart.
    public func overlapArea(_ other: Rect) -> Double {
        let w = min(maxX, other.maxX) - max(minX, other.minX)
        let h = min(maxY, other.maxY) - max(minY, other.minY)
        return w > 0 && h > 0 ? w * h : 0
    }

    /// Equal to within `tolerance` points on every edge.
    public func isClose(to other: Rect, tolerance: Double = 2) -> Bool {
        abs(x - other.x) <= tolerance && abs(y - other.y) <= tolerance
            && abs(width - other.width) <= tolerance && abs(height - other.height) <= tolerance
    }
}

/// Converts a top-left, y-down rectangle (Accessibility, the window list)
/// to AppKit's bottom-left, y-up space. Both are anchored on the primary
/// screen, so it takes that screen's height, whichever screen the
/// rectangle is on.
public func toAppKit(_ topLeft: Rect, primaryScreenHeight: Double) -> Rect {
    Rect(
        x: topLeft.x,
        y: primaryScreenHeight - topLeft.y - topLeft.height,
        width: topLeft.width,
        height: topLeft.height
    )
}

/// One of cmux's windows as Accessibility describes it.
public struct WindowCandidate: Equatable, Sendable {
    /// Top-left, y-down frame.
    public var frame: Rect
    public var isStandard: Bool
    public var isMain: Bool
    public var isFocused: Bool

    public init(frame: Rect, isStandard: Bool, isMain: Bool, isFocused: Bool) {
        self.frame = frame
        self.isStandard = isStandard
        self.isMain = isMain
        self.isFocused = isFocused
    }
}

/// Which window counts as cmux's main window: the main standard window,
/// else the focused one, else the first standard one. Dialogs, sheets and
/// palettes never count, so the panel never jumps to a settings window.
public func pickMainWindow(_ candidates: [WindowCandidate]) -> Int? {
    let standard = candidates.indices.filter { candidates[$0].isStandard }
    return standard.first { candidates[$0].isMain }
        ?? standard.first { candidates[$0].isFocused }
        ?? standard.first
}

/// Whether the window is on the Space being shown: the window list's
/// on-screen windows for cmux include one with this frame. Both are
/// top-left, y-down, so they compare directly.
public func isOnCurrentSpace(_ frame: Rect, onScreen: [Rect]) -> Bool {
    onScreen.contains { $0.isClose(to: frame) }
}

/// cmux's main window, as the glue read it.
public struct CmuxWindow: Equatable, Sendable {
    /// Top-left, y-down frame.
    public var frame: Rect
    public var isMinimised: Bool
    public var isFullScreen: Bool
    public var isOnCurrentSpace: Bool

    public init(frame: Rect, isMinimised: Bool, isFullScreen: Bool, isOnCurrentSpace: Bool) {
        self.frame = frame
        self.isMinimised = isMinimised
        self.isFullScreen = isFullScreen
        self.isOnCurrentSpace = isOnCurrentSpace
    }
}

public enum CmuxState: Equatable, Sendable {
    case notRunning
    /// Running but hidden (Hide cmux, or Command H).
    case hidden
    /// Running with no standard window, or one Accessibility cannot read.
    case noWindow
    case window(CmuxWindow)
}

public enum Permission: Equatable, Sendable {
    case granted
    case missing
}

/// The screens, in AppKit space.
public struct Screens: Equatable, Sendable {
    /// The primary screen's full height, for converting coordinates.
    public var primaryHeight: Double
    /// Each screen's full frame (menu bar and Dock included), primary first.
    public var frames: [Rect]

    public init(primaryHeight: Double, frames: [Rect]) {
        self.primaryHeight = primaryHeight
        self.frames = frames
    }
}

public enum HiddenReason: Equatable, Sendable {
    case notRunning
    case appHidden
    case noWindow
    case minimised
    case otherSpace
}

/// Which side of cmux's left edge the panel sits.
public enum Side: Equatable, Sendable {
    /// Beside the window, its right edge on cmux's left edge.
    case outside
    /// Over the window's left strip: full screen, or no room on the screen.
    case inside
}

public enum Placement: Equatable, Sendable {
    case hidden(HiddenReason)
    /// Docked to cmux. `frame` is in AppKit space. `raised` asks for a
    /// level above cmux's own window, needed only when the panel overlaps
    /// it in full screen, where no other app's window can be covered.
    case docked(frame: Rect, side: Side, raised: Bool)
    /// No Accessibility permission yet: a strip at the primary screen's
    /// left edge that says how to grant it.
    case askingPermission(frame: Rect)
}

/// The panel's width when nothing else says otherwise.
public let defaultPanelWidth: Double = 280

/// The whole decision: given permission, cmux's state and the screens,
/// where the panel goes, or why it hides.
public func place(
    permission: Permission,
    cmux: CmuxState,
    screens: Screens,
    width: Double = defaultPanelWidth
) -> Placement {
    if permission == .missing {
        let primary = screens.frames.first ?? Rect(x: 0, y: 0, width: width, height: screens.primaryHeight)
        return .askingPermission(frame: Rect(x: primary.x, y: primary.y, width: width, height: primary.height))
    }
    switch cmux {
    case .notRunning:
        return .hidden(.notRunning)
    case .hidden:
        return .hidden(.appHidden)
    case .noWindow:
        return .hidden(.noWindow)
    case let .window(window):
        if window.isMinimised { return .hidden(.minimised) }
        if !window.isOnCurrentSpace { return .hidden(.otherSpace) }
        return dock(window, screens: screens, width: width)
    }
}

/// Flush with the window's left edge, the same height and top: outside
/// when the window's screen has room for it, inside otherwise.
func dock(_ window: CmuxWindow, screens: Screens, width: Double) -> Placement {
    let frame = toAppKit(window.frame, primaryScreenHeight: screens.primaryHeight)
    let outside = Rect(x: frame.minX - width, y: frame.minY, width: width, height: frame.height)
    let screen = screens.frames
        .filter { frame.overlapArea($0) > 0 }
        .max { frame.overlapArea($0) < frame.overlapArea($1) }
    let roomOutside = screen.map { outside.minX >= $0.minX } ?? true
    if !window.isFullScreen && roomOutside {
        return .docked(frame: outside, side: .outside, raised: false)
    }
    let inside = Rect(x: frame.minX, y: frame.minY, width: min(width, frame.width), height: frame.height)
    return .docked(frame: inside, side: .inside, raised: window.isFullScreen)
}
