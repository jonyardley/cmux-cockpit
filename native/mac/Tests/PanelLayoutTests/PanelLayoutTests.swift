import XCTest
@testable import PanelLayout

// A 1512 by 982 primary screen, as a 14 inch MacBook Pro reports it, and
// a 1920 by 1080 screen to its left with its top aligned.
private let primary = Rect(x: 0, y: 0, width: 1512, height: 982)
private let leftScreen = Rect(x: -1920, y: -98, width: 1920, height: 1080)
private let oneScreen = Screens(primaryHeight: 982, frames: [primary])
private let twoScreens = Screens(primaryHeight: 982, frames: [primary, leftScreen])

private func window(
    _ frame: Rect,
    minimised: Bool = false,
    fullScreen: Bool = false,
    onSpace: Bool = true,
    active: Bool = false
) -> CmuxState {
    .window(CmuxWindow(
        frame: frame,
        isMinimised: minimised,
        isFullScreen: fullScreen,
        isOnCurrentSpace: onSpace,
        isActive: active
    ))
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

final class SpaceTests: XCTestCase {
    func testOnTheCurrentSpaceWhenTheWindowListShowsTheSameFrame() {
        let frame = Rect(x: 400, y: 100, width: 800, height: 600)
        XCTAssertTrue(isOnCurrentSpace(frame, onScreen: [Rect(x: 401, y: 99, width: 800, height: 601)]))
        XCTAssertFalse(isOnCurrentSpace(frame, onScreen: [Rect(x: 0, y: 0, width: 300, height: 200)]))
        XCTAssertFalse(isOnCurrentSpace(frame, onScreen: []))
    }

    func testStaysOnTheSpaceWhenTheTwoReadsDisagreeMidDrag() {
        // The window list a frame behind Accessibility during a drag.
        let frame = Rect(x: 400, y: 100, width: 800, height: 600)
        XCTAssertTrue(isOnCurrentSpace(frame, onScreen: [Rect(x: 440, y: 120, width: 800, height: 600)]))
        // Another of cmux's windows on this Space covering only part of it.
        XCTAssertFalse(isOnCurrentSpace(frame, onScreen: [Rect(x: 600, y: 100, width: 800, height: 600)]))
    }
}

final class PlaceTests: XCTestCase {
    private let cmuxFrame = Rect(x: 400, y: 100, width: 800, height: 600)

    func testDocksOutsideTheLeftEdgeWithTheSameTopAndHeight() {
        let placement = place(permission: .granted, cmux: window(cmuxFrame), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 120, y: 282, width: 280, height: 600), side: .outside, raised: false))
    }

    func testFollowsAMoveAndAResize() {
        let moved = Rect(x: 600, y: 50, width: 700, height: 900)
        let placement = place(permission: .granted, cmux: window(moved), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 320, y: 32, width: 280, height: 900), side: .outside, raised: false))
    }

    func testTakesTheWidthItIsGiven() {
        let placement = place(permission: .granted, cmux: window(cmuxFrame), screens: oneScreen, width: 200)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 200, y: 282, width: 200, height: 600), side: .outside, raised: false))
    }

    func testDocksInsideWhenTheScreenHasNoRoomOnTheLeft() {
        let atEdge = Rect(x: 100, y: 100, width: 800, height: 600)
        let placement = place(permission: .granted, cmux: window(atEdge), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 100, y: 282, width: 280, height: 600), side: .inside, raised: false))
    }

    func testInsideIsRaisedOnlyWhileCmuxIsFrontmost() {
        // cmux at the screen's left edge: the panel overlaps its left strip,
        // so while cmux takes clicks it must stay above cmux's window.
        let atEdge = Rect(x: 0, y: 100, width: 800, height: 600)
        let inside = Rect(x: 0, y: 282, width: 280, height: 600)
        let active = place(permission: .granted, cmux: window(atEdge, active: true), screens: oneScreen)
        XCTAssertEqual(active, .docked(frame: inside, side: .inside, raised: true))
        // Another app in front: back to the normal level, so it never
        // covers that app's windows.
        let behind = place(permission: .granted, cmux: window(atEdge, active: false), screens: oneScreen)
        XCTAssertEqual(behind, .docked(frame: inside, side: .inside, raised: false))
    }

    func testOutsideIsNeverRaisedEvenWhileCmuxIsFrontmost() {
        let placement = place(permission: .granted, cmux: window(cmuxFrame, active: true), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 120, y: 282, width: 280, height: 600), side: .outside, raised: false))
    }

    func testUsesTheScreenTheWindowIsOnForRoom() {
        // On the left screen, near its left edge: no room there, although
        // the primary screen's left edge is far to the right.
        let onLeft = Rect(x: -1800, y: 50, width: 1000, height: 700)
        let placement = place(permission: .granted, cmux: window(onLeft), screens: twoScreens)
        XCTAssertEqual(placement, .docked(frame: Rect(x: -1800, y: 232, width: 280, height: 700), side: .inside, raised: false))
        // Further right on the left screen there is room.
        let roomy = Rect(x: -1400, y: 50, width: 1000, height: 700)
        let docked = place(permission: .granted, cmux: window(roomy), screens: twoScreens)
        XCTAssertEqual(docked, .docked(frame: Rect(x: -1680, y: 232, width: 280, height: 700), side: .outside, raised: false))
    }

    func testDocksInsideWhenTheDockTakesTheRoomOnTheLeft() {
        // The Dock on the left: the visible frame starts 70 points in.
        let withDock = Screens(primaryHeight: 982, frames: [Rect(x: 70, y: 0, width: 1442, height: 957)])
        let nearEdge = Rect(x: 300, y: 100, width: 800, height: 600)
        let placement = place(permission: .granted, cmux: window(nearEdge), screens: withDock)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 300, y: 282, width: 280, height: 600), side: .inside, raised: false))
    }

    func testDocksOutsideWhenTheWindowIsOnNoKnownScreen() {
        let offScreen = Rect(x: 5000, y: 100, width: 800, height: 600)
        let placement = place(permission: .granted, cmux: window(offScreen), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 4720, y: 282, width: 280, height: 600), side: .outside, raised: false))
    }

    func testFullScreenDocksInsideAndRaised() {
        let full = Rect(x: 0, y: 0, width: 1512, height: 982)
        let placement = place(permission: .granted, cmux: window(full, fullScreen: true), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 0, y: 0, width: 280, height: 982), side: .inside, raised: true))
    }

    func testFullScreenStaysInsideEvenWithRoomOnAnotherScreen() {
        let fullOnPrimary = Rect(x: 0, y: 0, width: 1512, height: 982)
        let placement = place(permission: .granted, cmux: window(fullOnPrimary, fullScreen: true), screens: twoScreens)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 0, y: 0, width: 280, height: 982), side: .inside, raised: true))
    }

    func testNeverWiderThanANarrowWindowWhenInside() {
        let narrow = Rect(x: 0, y: 100, width: 200, height: 600)
        let placement = place(permission: .granted, cmux: window(narrow), screens: oneScreen)
        XCTAssertEqual(placement, .docked(frame: Rect(x: 0, y: 282, width: 200, height: 600), side: .inside, raised: false))
    }

    func testHidesWithCmux() {
        XCTAssertEqual(place(permission: .granted, cmux: .notRunning, screens: oneScreen), .hidden(.notRunning))
        XCTAssertEqual(place(permission: .granted, cmux: .hidden, screens: oneScreen), .hidden(.appHidden))
        XCTAssertEqual(place(permission: .granted, cmux: .noWindow, screens: oneScreen), .hidden(.noWindow))
    }

    func testHidesWhenTheWindowIsMinimisedOrOnAnotherSpace() {
        XCTAssertEqual(place(permission: .granted, cmux: window(cmuxFrame, minimised: true), screens: oneScreen), .hidden(.minimised))
        XCTAssertEqual(place(permission: .granted, cmux: window(cmuxFrame, onSpace: false), screens: oneScreen), .hidden(.otherSpace))
    }

    func testComesBackWhenCmuxDoes() {
        let states: [CmuxState] = [.notRunning, .noWindow, window(cmuxFrame)]
        let placements = states.map { place(permission: .granted, cmux: $0, screens: oneScreen) }
        XCTAssertEqual(placements.last, .docked(frame: Rect(x: 120, y: 282, width: 280, height: 600), side: .outside, raised: false))
    }

    func testAsksForPermissionAtThePrimaryScreensLeftEdgeWhateverCmuxIsDoing() {
        let expected = Placement.askingPermission(frame: Rect(x: 0, y: 0, width: 280, height: 982))
        XCTAssertEqual(place(permission: .missing, cmux: window(cmuxFrame), screens: twoScreens), expected)
        XCTAssertEqual(place(permission: .missing, cmux: .notRunning, screens: oneScreen), expected)
    }

    func testAsksForPermissionWithNoScreensReported() {
        let none = Screens(primaryHeight: 900, frames: [])
        XCTAssertEqual(place(permission: .missing, cmux: .notRunning, screens: none), .askingPermission(frame: Rect(x: 0, y: 0, width: 280, height: 900)))
    }
}
