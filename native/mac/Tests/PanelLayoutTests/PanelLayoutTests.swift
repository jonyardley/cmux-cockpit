import XCTest
@testable import PanelLayout

// A 1728 by 1117 primary screen, as a 16 inch MacBook Pro reports it, and
// cmux's window as Accessibility read it there: the sidebar list 315
// points wide, the panes beside it starting 28 points below the top.
private let primary = Rect(x: 0, y: 0, width: 1728, height: 1117)
private let screens = Screens(primaryHeight: 1117, frames: [primary])
private let cmuxFrame = Rect(x: 370, y: 56, width: 1309, height: 1012)
private let sidebar = Rect(x: 370, y: 78, width: 315, height: 940)
private let content = Rect(x: 685, y: 84, width: 643, height: 984)
/// Where the panel goes for that window, in AppKit space: cmux's left
/// edge and bottom, 1117 - 56 - 1012 = 49 up, below the 28 point row.
private let overSidebar = Rect(x: 370, y: 49, width: 315, height: 984)

private func window(
    _ frame: Rect = cmuxFrame,
    minimised: Bool = false,
    fullScreen: Bool = false,
    number: Int? = 42,
    sidebar: Rect? = sidebar,
    content: Rect? = content
) -> CmuxWindow {
    CmuxWindow(
        frame: frame,
        isMinimised: minimised,
        isFullScreen: fullScreen,
        windowNumber: number,
        sidebar: sidebar,
        content: content
    )
}

private func placed(_ window: CmuxWindow) -> Placement {
    place(permission: .granted, cmux: .window(window), screens: screens)
}


final class CoordinateTests: XCTestCase {
    func testFlipsTopLeftToBottomLeftOnThePrimaryScreen() {
        let ax = Rect(x: 400, y: 100, width: 800, height: 600)
        XCTAssertEqual(toAppKit(ax, primaryScreenHeight: 982), Rect(x: 400, y: 282, width: 800, height: 600))
    }

    func testFlipsAgainstThePrimaryHeightOnASecondScreen() {
        // A window whose top sits 48 points above the primary screen's top,
        // as on a taller screen beside it.
        let ax = Rect(x: -1800, y: -48, width: 1000, height: 700)
        XCTAssertEqual(toAppKit(ax, primaryScreenHeight: 982), Rect(x: -1800, y: 330, width: 1000, height: 700))
    }

    func testOverlapAreaIsZeroWhenApartOrTouching() {
        let a = Rect(x: 0, y: 0, width: 10, height: 10)
        XCTAssertEqual(a.overlapArea(Rect(x: 10, y: 0, width: 10, height: 10)), 0)
        XCTAssertEqual(a.overlapArea(Rect(x: 50, y: 50, width: 10, height: 10)), 0)
        XCTAssertEqual(a.overlapArea(Rect(x: 5, y: 5, width: 10, height: 10)), 25)
    }
}

final class PickMainWindowTests: XCTestCase {
    private let frame = Rect(x: 0, y: 0, width: 100, height: 100)

    func testPrefersTheMainStandardWindow() {
        let windows = [
            WindowCandidate(frame: frame, isStandard: true, isMain: false, isFocused: true),
            WindowCandidate(frame: frame, isStandard: true, isMain: true, isFocused: false),
        ]
        XCTAssertEqual(pickMainWindow(windows), 1)
    }

    func testFallsBackToFocusedThenFirstStandard() {
        let focused = [
            WindowCandidate(frame: frame, isStandard: true, isMain: false, isFocused: false),
            WindowCandidate(frame: frame, isStandard: true, isMain: false, isFocused: true),
        ]
        XCTAssertEqual(pickMainWindow(focused), 1)
        let neither = [
            WindowCandidate(frame: frame, isStandard: false, isMain: false, isFocused: false),
            WindowCandidate(frame: frame, isStandard: true, isMain: false, isFocused: false),
        ]
        XCTAssertEqual(pickMainWindow(neither), 1)
    }

    func testNeverPicksADialogEvenWhenItIsMain() {
        let windows = [WindowCandidate(frame: frame, isStandard: false, isMain: true, isFocused: true)]
        XCTAssertNil(pickMainWindow(windows))
        XCTAssertNil(pickMainWindow([]))
    }
}


final class MatchWindowTests: XCTestCase {
    private let frame = Rect(x: 400, y: 100, width: 800, height: 600)

    func testFindsTheListedWindowWithTheSameFrame() {
        let listed = [ListedWindow(number: 7, frame: Rect(x: 401, y: 99, width: 800, height: 601))]
        XCTAssertEqual(matchWindow(frame, onScreen: listed), 7)
    }

    func testNoneWhenNotOnTheSpaceBeingShown() {
        XCTAssertNil(matchWindow(frame, onScreen: []))
        XCTAssertNil(matchWindow(frame, onScreen: [ListedWindow(number: 7, frame: Rect(x: 0, y: 0, width: 300, height: 200))]))
    }

    func testStillMatchesWhenTheTwoReadsDisagreeMidDrag() {
        // The window list a frame behind Accessibility during a drag.
        let behind = [ListedWindow(number: 7, frame: Rect(x: 440, y: 120, width: 800, height: 600))]
        XCTAssertEqual(matchWindow(frame, onScreen: behind), 7)
        // Another of cmux's windows covering only part of it does not count.
        let partly = [ListedWindow(number: 8, frame: Rect(x: 600, y: 100, width: 800, height: 600))]
        XCTAssertNil(matchWindow(frame, onScreen: partly))
    }

    func testPicksTheBestOverlapWhenTwoQualify() {
        let listed = [
            ListedWindow(number: 8, frame: Rect(x: 440, y: 120, width: 800, height: 600)),
            ListedWindow(number: 7, frame: frame),
        ]
        XCTAssertEqual(matchWindow(frame, onScreen: listed), 7)
    }

    func testAnEmptyFrameNeedsACloseMatch() {
        let empty = Rect(x: 10, y: 10, width: 0, height: 0)
        XCTAssertEqual(matchWindow(empty, onScreen: [ListedWindow(number: 3, frame: Rect(x: 11, y: 10, width: 0, height: 1))]), 3)
        XCTAssertNil(matchWindow(empty, onScreen: [ListedWindow(number: 3, frame: Rect(x: 50, y: 10, width: 0, height: 0))]))
    }
}

final class SidebarWidthTests: XCTestCase {
    func testTakesTheSidebarsRightEdgeWhenFound() {
        XCTAssertEqual(sidebarWidth(window()), 315)
    }

    func testFollowsTheDividerWhenItIsDragged() {
        let wider = Rect(x: 370, y: 78, width: 400, height: 940)
        XCTAssertEqual(sidebarWidth(window(sidebar: wider)), 400)
    }

    func testFallsBackToWhereTheContentStarts() {
        XCTAssertEqual(sidebarWidth(window(sidebar: nil)), 315)
    }

    func testFallsBackToAFixedWidthWhenNeitherIsFound() {
        XCTAssertEqual(sidebarWidth(window(sidebar: nil, content: nil)), fallbackSidebarWidth)
    }

    func testNilWhenTheSidebarIsClosed() {
        // The sidebar list gone and the panes starting at the window's edge.
        let fullWidth = Rect(x: 370, y: 84, width: 1309, height: 984)
        XCTAssertNil(sidebarWidth(window(sidebar: nil, content: fullWidth)))
    }

    func testNeverWiderThanTheWindow() {
        let narrow = Rect(x: 370, y: 56, width: 200, height: 1012)
        XCTAssertEqual(sidebarWidth(window(narrow, sidebar: nil, content: nil)), 200)
    }
}

final class TitleBarTests: XCTestCase {
    func testStartsWhereTheContentStarts() {
        XCTAssertEqual(titleBarHeight(window()), 28)
        let lower = Rect(x: 685, y: 96, width: 643, height: 972)
        XCTAssertEqual(titleBarHeight(window(content: lower)), 40)
    }

    func testFallsBackWhenTheContentIsNotFound() {
        XCTAssertEqual(titleBarHeight(window(content: nil)), fallbackTitleBarHeight)
    }

    func testStaysWithinTheWindow() {
        let above = Rect(x: 685, y: 40, width: 643, height: 984)
        XCTAssertEqual(titleBarHeight(window(content: above)), 0)
        let below = Rect(x: 685, y: 2000, width: 643, height: 10)
        XCTAssertEqual(titleBarHeight(window(content: below)), 1012)
    }
}

final class PlaceTests: XCTestCase {
    func testCoversTheSidebarBelowTheTitleBarWithARoundedCorner() {
        XCTAssertEqual(placed(window()), .docked(frame: overSidebar, raised: false, cornerRadius: windowCornerRadius))
    }

    func testFollowsAMoveAndAResize() {
        let moved = Rect(x: 100, y: 200, width: 900, height: 700)
        let movedSidebar = Rect(x: 100, y: 222, width: 250, height: 640)
        let movedContent = Rect(x: 350, y: 228, width: 650, height: 672)
        let placement = placed(window(moved, sidebar: movedSidebar, content: movedContent))
        // 1117 - 200 - 700 = 217 up; 700 - 28 tall.
        XCTAssertEqual(placement, .docked(frame: Rect(x: 100, y: 217, width: 250, height: 672), raised: false, cornerRadius: windowCornerRadius))
    }

    func testUsesTheFallbacksWhenAccessibilityFindsNeither() {
        let placement = placed(window(sidebar: nil, content: nil))
        XCTAssertEqual(placement, .docked(frame: Rect(x: 370, y: 49, width: 280, height: 984), raised: false, cornerRadius: windowCornerRadius))
    }

    func testFullScreenIsRaisedWithSquareCorners() {
        // On the full screen Space nothing but cmux shares the screen, so
        // floating covers no other app, and the window has no rounded corners.
        let full = Rect(x: 0, y: 0, width: 1728, height: 1117)
        let fullContent = Rect(x: 315, y: 28, width: 1413, height: 1089)
        let placement = placed(window(full, fullScreen: true, sidebar: nil, content: fullContent))
        XCTAssertEqual(placement, .docked(frame: Rect(x: 0, y: 0, width: 315, height: 1089), raised: true, cornerRadius: 0))
    }

    func testHidesWhenTheSidebarIsClosed() {
        let fullWidth = Rect(x: 370, y: 84, width: 1309, height: 984)
        XCTAssertEqual(placed(window(sidebar: nil, content: fullWidth)), .hidden(.sidebarCollapsed))
    }

    func testHidesWithCmux() {
        XCTAssertEqual(place(permission: .granted, cmux: .notRunning, screens: screens), .hidden(.notRunning))
        XCTAssertEqual(place(permission: .granted, cmux: .hidden, screens: screens), .hidden(.appHidden))
        XCTAssertEqual(place(permission: .granted, cmux: .noWindow, screens: screens), .hidden(.noWindow))
    }

    func testHidesWhenTheWindowIsMinimisedOrOnAnotherSpace() {
        XCTAssertEqual(placed(window(minimised: true)), .hidden(.minimised))
        XCTAssertEqual(placed(window(number: nil)), .hidden(.otherSpace))
        // Full screen on another Space hides as well.
        XCTAssertEqual(placed(window(fullScreen: true, number: nil)), .hidden(.otherSpace))
    }

    func testComesBackWhenCmuxDoes() {
        let states: [CmuxState] = [.notRunning, .noWindow, .window(window())]
        let placements = states.map { place(permission: .granted, cmux: $0, screens: screens) }
        XCTAssertEqual(placements.last, .docked(frame: overSidebar, raised: false, cornerRadius: windowCornerRadius))
    }

    func testAsksForPermissionAtThePrimaryScreensLeftEdgeWhateverCmuxIsDoing() {
        let expected = Placement.askingPermission(frame: Rect(x: 0, y: 0, width: 280, height: 1117))
        XCTAssertEqual(place(permission: .missing, cmux: .window(window()), screens: screens), expected)
        XCTAssertEqual(place(permission: .missing, cmux: .notRunning, screens: screens), expected)
    }

    func testAsksForPermissionWithNoScreensReported() {
        let none = Screens(primaryHeight: 900, frames: [])
        XCTAssertEqual(place(permission: .missing, cmux: .notRunning, screens: none), .askingPermission(frame: Rect(x: 0, y: 0, width: 280, height: 900)))
    }
}

final class OrderingTests: XCTestCase {
    private let panel = 10
    private let cmux = 42

    func testKeepsThePanelDirectlyAboveCmux() {
        XCTAssertEqual(ordering(raised: false, frontToBack: [5, panel, cmux, 6], panel: panel, cmux: cmux), .keep)
    }

    func testOrdersItBackAboveCmuxWhenCmuxComesForward() {
        XCTAssertEqual(ordering(raised: false, frontToBack: [cmux, panel], panel: panel, cmux: cmux), .above(cmux))
    }

    func testOrdersItDownWhenAnotherWindowSitsBetween() {
        // Another app's window between them would sit under the panel.
        XCTAssertEqual(ordering(raised: false, frontToBack: [panel, 5, cmux], panel: panel, cmux: cmux), .above(cmux))
    }

    func testOrdersItWhenNotYetOnScreen() {
        XCTAssertEqual(ordering(raised: false, frontToBack: [cmux], panel: panel, cmux: cmux), .above(cmux))
        // cmux missing from the list read: order against its number anyway.
        XCTAssertEqual(ordering(raised: false, frontToBack: [panel], panel: panel, cmux: cmux), .above(cmux))
    }

    func testWithoutCmuxsNumberItOnlyComesToTheFrontWhenOffScreen() {
        XCTAssertEqual(ordering(raised: false, frontToBack: [], panel: panel, cmux: nil), .front)
        XCTAssertEqual(ordering(raised: false, frontToBack: [panel], panel: panel, cmux: nil), .keep)
    }

    func testRaisedItOnlyNeedsToBeOnScreen() {
        // Full screen: brought forward when it has not yet joined cmux's
        // Space, left alone once it has.
        XCTAssertEqual(ordering(raised: true, frontToBack: [cmux], panel: panel, cmux: cmux), .front)
        XCTAssertEqual(ordering(raised: true, frontToBack: [panel, 5, cmux], panel: panel, cmux: cmux), .keep)
    }
}
