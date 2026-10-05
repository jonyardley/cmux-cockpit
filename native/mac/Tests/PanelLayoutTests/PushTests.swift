import XCTest
@testable import PanelLayout

// The 1512 by 982 primary screen, with the menu bar (33 points) taken off
// the top of its visible frame, and the same with a 64 point Dock on the
// left. AppKit space, so the menu bar comes off the height only.
private let visible = Rect(x: 0, y: 0, width: 1512, height: 949)
private let dockLeft = Rect(x: 64, y: 0, width: 1448, height: 949)
private let screen = Screens(primaryHeight: 982, frames: [visible])
private let dockScreen = Screens(primaryHeight: 982, frames: [dockLeft])
private let leftScreen = Rect(x: -1920, y: -98, width: 1920, height: 1080)
private let twoScreens = Screens(primaryHeight: 982, frames: [visible, leftScreen])

/// cmux filling the screen below the menu bar, as a maximised window does.
private let filling = Rect(x: 0, y: 33, width: 1512, height: 949)

private func cmux(
    _ frame: Rect,
    fullScreen: Bool = false,
    minimised: Bool = false,
    onSpace: Bool = true
) -> CmuxWindow {
    CmuxWindow(frame: frame, isMinimised: minimised, isFullScreen: fullScreen, isOnCurrentSpace: onSpace, isActive: true)
}

final class MakeRoomTests: XCTestCase {
    func testNoPushWhenThereIsRoomAlready() {
        XCTAssertNil(makeRoom(window: cmux(Rect(x: 280, y: 33, width: 1232, height: 949)), screens: screen))
        XCTAssertNil(makeRoom(window: cmux(Rect(x: 400, y: 100, width: 800, height: 600)), screens: screen))
    }

    func testPushesAWindowAtTheLeftEdgeRightAndNarrowsItByThePanelWidth() {
        let push = makeRoom(window: cmux(filling), screens: screen)
        XCTAssertEqual(push?.cmuxFrame, Rect(x: 280, y: 33, width: 1232, height: 949))
        XCTAssertEqual(push?.panelFrame, Rect(x: 0, y: 0, width: 280, height: 949))
    }

    func testMakesRoomBesideALeftDock() {
        let push = makeRoom(window: cmux(Rect(x: 64, y: 33, width: 1448, height: 949)), screens: dockScreen)
        XCTAssertEqual(push?.cmuxFrame, Rect(x: 344, y: 33, width: 1168, height: 949))
        XCTAssertEqual(push?.panelFrame, Rect(x: 64, y: 0, width: 280, height: 949))
    }

    func testPushesOnlyByTheShortfallAndKeepsTheRightEdge() {
        let push = makeRoom(window: cmux(Rect(x: 100, y: 200, width: 1000, height: 500)), screens: screen)
        XCTAssertEqual(push?.cmuxFrame, Rect(x: 280, y: 200, width: 820, height: 500))
        XCTAssertEqual(push?.panelFrame, Rect(x: 0, y: 282, width: 280, height: 500))
    }

    func testPullsARightEdgePastTheScreenBackOnScreen() {
        let push = makeRoom(window: cmux(Rect(x: 0, y: 33, width: 1600, height: 949)), screens: screen)
        XCTAssertEqual(push?.cmuxFrame, Rect(x: 280, y: 33, width: 1232, height: 949))
    }

    func testPushesDownToTheMinimumWidthButNotPastIt() {
        let atMinimum = makeRoom(window: cmux(Rect(x: 0, y: 33, width: 920, height: 949)), screens: screen)
        XCTAssertEqual(atMinimum?.cmuxFrame.width, minimumCmuxWidth)
        XCTAssertNil(makeRoom(window: cmux(Rect(x: 0, y: 33, width: 919, height: 949)), screens: screen))
        // A window that ends before the panel would even clear it.
        XCTAssertNil(makeRoom(window: cmux(Rect(x: 0, y: 33, width: 200, height: 949)), screens: screen))
    }

    func testNeverPushesFullScreenMinimisedOrOtherSpaceWindows() {
        XCTAssertNil(makeRoom(window: cmux(filling, fullScreen: true), screens: screen))
        XCTAssertNil(makeRoom(window: cmux(filling, minimised: true), screens: screen))
        XCTAssertNil(makeRoom(window: cmux(filling, onSpace: false), screens: screen))
    }

    func testNeverPushesAWindowOnNoScreen() {
        XCTAssertNil(makeRoom(window: cmux(Rect(x: 5000, y: 33, width: 1000, height: 600)), screens: screen))
    }

    func testPushesWithinTheScreenCmuxIsOn() {
        // cmux filling the left screen: AX y -98 + 982 - 1080 flips back to -98.
        let push = makeRoom(window: cmux(Rect(x: -1920, y: 0, width: 1920, height: 1080)), screens: twoScreens)
        XCTAssertEqual(push?.cmuxFrame, Rect(x: -1640, y: 0, width: 1640, height: 1080))
        XCTAssertEqual(push?.panelFrame, Rect(x: -1920, y: -98, width: 280, height: 1080))
    }

    func testThePanelFrameIsWhereTheDockRuleThenPutsIt() {
        guard let push = makeRoom(window: cmux(filling), screens: screen) else { return XCTFail("no push") }
        let after = place(permission: .granted, cmux: .window(cmux(push.cmuxFrame)), screens: screen)
        XCTAssertEqual(after, .docked(frame: push.panelFrame, side: .outside, raised: false))
    }
}

final class PushLandedTests: XCTestCase {
    private let target = Rect(x: 280, y: 33, width: 1232, height: 949)

    func testLandsExactlyOrWithinAPoint() {
        XCTAssertTrue(pushLanded(target, for: target))
        XCTAssertTrue(pushLanded(Rect(x: 280.5, y: 33, width: 1232, height: 949), for: target))
    }

    func testANarrowerResultStillLands() {
        XCTAssertTrue(pushLanded(Rect(x: 280, y: 33, width: 1220, height: 949), for: target))
    }

    func testALeftEdgeElsewhereOrAWindowThatWouldNotNarrowDoesNotLand() {
        XCTAssertFalse(pushLanded(Rect(x: 0, y: 33, width: 1232, height: 949), for: target))
        XCTAssertFalse(pushLanded(Rect(x: 280, y: 33, width: 1512, height: 949), for: target))
    }
}

final class PushTrackerTests: XCTestCase {
    private let pushed = Rect(x: 280, y: 33, width: 1232, height: 949)

    func testWaitsForTheFrameToSettleBeforePushing() {
        var tracker = PushTracker()
        XCTAssertNil(tracker.next(window: cmux(filling), screens: screen, now: 10, mouseDown: false))
        XCTAssertNil(tracker.next(window: cmux(filling), screens: screen, now: 10.25, mouseDown: false))
        XCTAssertEqual(tracker.next(window: cmux(filling), screens: screen, now: 10.5, mouseDown: false)?.cmuxFrame, pushed)
    }

    func testAMovingFrameRestartsTheSettle() {
        var tracker = PushTracker()
        let moving = Rect(x: 10, y: 33, width: 1400, height: 949)
        _ = tracker.next(window: cmux(moving), screens: screen, now: 0, mouseDown: false)
        XCTAssertNil(tracker.next(window: cmux(filling), screens: screen, now: 0.4, mouseDown: false))
        XCTAssertNil(tracker.next(window: cmux(filling), screens: screen, now: 0.8, mouseDown: false))
        XCTAssertNotNil(tracker.next(window: cmux(filling), screens: screen, now: 0.9, mouseDown: false))
    }

    func testNeverPushesWhileAMouseButtonIsHeld() {
        var tracker = PushTracker()
        _ = tracker.next(window: cmux(filling), screens: screen, now: 0, mouseDown: true)
        XCTAssertNil(tracker.next(window: cmux(filling), screens: screen, now: 5, mouseDown: true))
        XCTAssertNotNil(tracker.next(window: cmux(filling), screens: screen, now: 5.1, mouseDown: false))
    }

    func testDoesNotRetryARefusedFrameUntilItMoves() {
        var tracker = PushTracker()
        _ = tracker.next(window: cmux(filling), screens: screen, now: 0, mouseDown: false)
        tracker.recordRefusal(at: filling)
        XCTAssertNil(tracker.next(window: cmux(filling), screens: screen, now: 1, mouseDown: false))
        let other = Rect(x: 0, y: 33, width: 1400, height: 949)
        _ = tracker.next(window: cmux(other), screens: screen, now: 2, mouseDown: false)
        XCTAssertNotNil(tracker.next(window: cmux(other), screens: screen, now: 3, mouseDown: false))
    }

    func testNoPushOnceTheRoomIsMade() {
        var tracker = PushTracker()
        tracker.recordPush(before: filling, after: pushed)
        XCTAssertNil(tracker.next(window: cmux(pushed), screens: screen, now: 1, mouseDown: false))
        XCTAssertEqual(tracker.pushed?.before, filling)
    }

    func testRestoresOnlyWhileCmuxHasTheFrameThePushSet() {
        var tracker = PushTracker()
        XCTAssertNil(tracker.restoreTarget(current: pushed))
        tracker.recordPush(before: filling, after: pushed)
        XCTAssertEqual(tracker.restoreTarget(current: pushed), filling)
        XCTAssertEqual(tracker.restoreTarget(current: Rect(x: 280.5, y: 33, width: 1232, height: 949)), filling)
        XCTAssertNil(tracker.restoreTarget(current: Rect(x: 300, y: 33, width: 1212, height: 949)))
    }

    func testForgetsThePushOnceCmuxIsMovedAndHasSettled() {
        var tracker = PushTracker()
        tracker.recordPush(before: filling, after: pushed)
        let moved = Rect(x: 400, y: 100, width: 800, height: 600)
        _ = tracker.next(window: cmux(moved), screens: screen, now: 0, mouseDown: false)
        XCTAssertNotNil(tracker.pushed, "kept until the move settles")
        _ = tracker.next(window: cmux(moved), screens: screen, now: 1, mouseDown: false)
        XCTAssertNil(tracker.pushed)
        // Moving it back to the exact pushed frame later does not bring the
        // old push back.
        XCTAssertNil(tracker.restoreTarget(current: pushed))
    }

    func testPushesAgainWhenDraggedBackToTheEdgeAndRestoresTheLatestFrame() {
        var tracker = PushTracker()
        tracker.recordPush(before: filling, after: pushed)
        let draggedBack = Rect(x: 0, y: 60, width: 1300, height: 800)
        _ = tracker.next(window: cmux(draggedBack), screens: screen, now: 0, mouseDown: false)
        let again = tracker.next(window: cmux(draggedBack), screens: screen, now: 0.5, mouseDown: false)
        XCTAssertEqual(again?.cmuxFrame, Rect(x: 280, y: 60, width: 1020, height: 800))
        guard let again else { return }
        tracker.recordPush(before: draggedBack, after: again.cmuxFrame)
        XCTAssertEqual(tracker.restoreTarget(current: again.cmuxFrame), draggedBack)
    }
}
