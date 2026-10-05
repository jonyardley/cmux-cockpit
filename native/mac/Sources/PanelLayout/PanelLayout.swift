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

/// One window from the window list: its window number and its bounds,
/// top-left and y down.
public struct ListedWindow: Equatable, Sendable {
    public var number: Int
    public var frame: Rect

    public init(number: Int, frame: Rect) {
        self.number = number
        self.frame = frame
    }
}

/// Which of cmux's on-screen windows in the window list is the one
/// Accessibility read, by the window number the panel orders against, or
/// nil when none is on the Space being shown. A match covers nine tenths
/// of the frame: mid drag or resize, Accessibility and the window list can
/// be read a frame apart, so an exact match would lose the window while
/// the panel should follow; nine tenths, not half, so another cmux window
/// that only partly covers it does not count. The best overlap wins.
public func matchWindow(_ frame: Rect, onScreen: [ListedWindow]) -> Int? {
    let area = frame.width * frame.height
    guard area > 0 else { return onScreen.first { $0.frame.isClose(to: frame) }?.number }
    return onScreen
        .filter { $0.frame.overlapArea(frame) >= area * 0.9 }
        .max { $0.frame.overlapArea(frame) < $1.frame.overlapArea(frame) }?
        .number
}

/// cmux's main window, as the glue read it.
public struct CmuxWindow: Equatable, Sendable {
    /// Top-left, y-down frame.
    public var frame: Rect
    public var isMinimised: Bool
    public var isFullScreen: Bool
    /// The window list's number for this window when it is on the Space
    /// being shown, else nil.
    public var windowNumber: Int?
    /// cmux's left sidebar list, top-left and y down, when Accessibility
    /// found it.
    public var sidebar: Rect?
    /// cmux's main content beside the sidebar (its split view), top-left
    /// and y down, when Accessibility found it. Its top is where the title
    /// bar row ends.
    public var content: Rect?

    public init(
        frame: Rect,
        isMinimised: Bool,
        isFullScreen: Bool,
        windowNumber: Int?,
        sidebar: Rect? = nil,
        content: Rect? = nil
    ) {
        self.frame = frame
        self.isMinimised = isMinimised
        self.isFullScreen = isFullScreen
        self.windowNumber = windowNumber
        self.sidebar = sidebar
        self.content = content
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
    /// Each screen's visible frame (the menu bar and Dock left out),
    /// primary first.
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
    /// cmux's own sidebar is closed, so there is nothing to cover.
    case sidebarCollapsed
}

public enum Placement: Equatable, Sendable {
    case hidden(HiddenReason)
    /// Over cmux's sidebar, inside its window. `frame` is in AppKit space.
    /// `raised` asks for a level above normal windows: only in full screen,
    /// where nothing but cmux shares the Space. Otherwise the panel stays
    /// at the normal level, ordered just above cmux's window, so other
    /// apps' windows still cover it. `cornerRadius` rounds the bottom left
    /// corner to match cmux's window, zero in full screen.
    case docked(frame: Rect, raised: Bool, cornerRadius: Double)
    /// No Accessibility permission yet: a strip at the primary screen's
    /// left edge that says how to grant it.
    case askingPermission(frame: Rect)
}

/// The panel's width when Accessibility cannot find cmux's sidebar or its
/// content beside it, and the permission strip's width.
public let fallbackSidebarWidth: Double = 280

/// The title bar row's height when Accessibility cannot find cmux's
/// content to say where it ends. cmux's content starts 28 points below
/// the window's top, under its traffic lights and title bar buttons.
public let fallbackTitleBarHeight: Double = 28

/// Narrower than this counts as cmux's sidebar being closed.
public let minimumSidebarWidth: Double = 40

/// The radius of cmux's window corners, for the panel's bottom left.
/// Judged by eye; tune it if the corners do not line up.
public let windowCornerRadius: Double = 16

/// How wide cmux's sidebar is, or nil when it is closed. Its right edge,
/// when found; else where the content beside it starts; else the fallback.
/// Never wider than the window.
public func sidebarWidth(_ window: CmuxWindow) -> Double? {
    let left = window.frame.minX
    let measured = window.sidebar.map { $0.maxX - left }
        ?? window.content.map { $0.minX - left }
        ?? fallbackSidebarWidth
    guard measured >= minimumSidebarWidth else { return nil }
    return min(measured, window.frame.width)
}

/// How far below the window's top the panel starts: where cmux's content
/// starts, clear of the title bar row, else the fallback. Kept within the
/// window.
public func titleBarHeight(_ window: CmuxWindow) -> Double {
    let measured = window.content.map { $0.minY - window.frame.minY } ?? fallbackTitleBarHeight
    return min(max(measured, 0), window.frame.height)
}

/// The whole decision: given permission, cmux's state and the screens,
/// where the panel goes, or why it hides.
public func place(permission: Permission, cmux: CmuxState, screens: Screens) -> Placement {
    if permission == .missing {
        let width = fallbackSidebarWidth
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
        if window.windowNumber == nil { return .hidden(.otherSpace) }
        guard let width = sidebarWidth(window) else { return .hidden(.sidebarCollapsed) }
        return dock(window, width: width, screens: screens)
    }
}

/// Over the sidebar: cmux's left edge, from below the title bar row down
/// to cmux's bottom edge.
func dock(_ window: CmuxWindow, width: Double, screens: Screens) -> Placement {
    let frame = toAppKit(window.frame, primaryScreenHeight: screens.primaryHeight)
    let height = frame.height - titleBarHeight(window)
    return .docked(
        frame: Rect(x: frame.minX, y: frame.minY, width: width, height: height),
        raised: window.isFullScreen,
        cornerRadius: window.isFullScreen ? 0 : windowCornerRadius
    )
}

/// What the panel must do to keep its place in the stack of windows.
public enum Ordering: Equatable, Sendable {
    /// Already where it belongs.
    case keep
    /// Order it directly above this window number (cmux's main window).
    case above(Int)
    /// Bring it to the front of its level: full screen, where it floats.
    case front
}

/// Whether the panel needs ordering, from the window list's on-screen
/// windows front to back. At the normal level it belongs directly above
/// cmux's window: anything between them would sit under the panel, and
/// cmux in front of it would cover it (as after a click in cmux brings
/// cmux's windows forward). Raised, it only needs to be on screen.
public func ordering(raised: Bool, frontToBack: [Int], panel: Int, cmux: Int?) -> Ordering {
    let panelIndex = frontToBack.firstIndex(of: panel)
    guard !raised, let cmux else { return panelIndex == nil ? .front : .keep }
    guard let panelIndex, let cmuxIndex = frontToBack.firstIndex(of: cmux), panelIndex + 1 == cmuxIndex else {
        return .above(cmux)
    }
    return .keep
}
