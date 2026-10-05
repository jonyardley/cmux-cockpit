import XCTest
@testable import PanelLayout

private let frame = Rect(x: 370, y: 56, width: 1309, height: 1012)
private let sidebar = Rect(x: 370, y: 78, width: 315, height: 940)

private func shifted(_ rect: Rect, by dx: Double) -> Rect {
    Rect(x: rect.x + dx, y: rect.y, width: rect.width, height: rect.height)
}

final class FrameTrackerTests: XCTestCase {
    func testTheFirstReadOnlyRecords() {
        var tracker = FrameTracker()
        XCTAssertFalse(tracker.observe(frame: frame, sidebar: sidebar, now: 0))
    }

    func testAFrameChangeStartsTracking() {
        var tracker = FrameTracker()
        tracker.observe(frame: frame, sidebar: sidebar, now: 0)
        XCTAssertTrue(tracker.observe(frame: shifted(frame, by: 20), sidebar: sidebar, now: 0.25))
    }

    func testASidebarChangeStartsTracking() {
        // The divider dragged: the window stays put, the sidebar widens.
        var tracker = FrameTracker()
        tracker.observe(frame: frame, sidebar: sidebar, now: 0)
        let wider = Rect(x: 370, y: 78, width: 360, height: 940)
        XCTAssertTrue(tracker.observe(frame: frame, sidebar: wider, now: 0.25))
        var appeared = FrameTracker()
        appeared.observe(frame: frame, sidebar: nil, now: 0)
        XCTAssertTrue(appeared.observe(frame: frame, sidebar: sidebar, now: 0.25))
    }

    func testAFractionOfAPointIsNotAChange() {
        var tracker = FrameTracker()
        tracker.observe(frame: frame, sidebar: sidebar, now: 0)
        XCTAssertFalse(tracker.observe(frame: shifted(frame, by: 0.5), sidebar: shifted(sidebar, by: 0.5), now: 0.25))
    }

    func testAKickStartsTrackingBeforeAnyChangeIsSeen() {
        var tracker = FrameTracker()
        tracker.observe(frame: frame, sidebar: sidebar, now: 0)
        tracker.kick(now: 1)
        XCTAssertTrue(tracker.isTracking)
        XCTAssertTrue(tracker.observe(frame: frame, sidebar: sidebar, now: 1.1))
    }

    func testKeepsTrackingWhileMovingAndSettlesAfterStillness() {
        var tracker = FrameTracker()
        tracker.observe(frame: frame, sidebar: sidebar, now: 0)
        XCTAssertTrue(tracker.observe(frame: shifted(frame, by: 10), sidebar: sidebar, now: 1))
        // A pause shorter than the settle time keeps it on.
        XCTAssertTrue(tracker.observe(frame: shifted(frame, by: 10), sidebar: sidebar, now: 1.2))
        XCTAssertTrue(tracker.observe(frame: shifted(frame, by: 30), sidebar: sidebar, now: 1.25))
        XCTAssertTrue(tracker.observe(frame: shifted(frame, by: 30), sidebar: sidebar, now: 1.5))
        // Still for the settle time: off.
        XCTAssertFalse(tracker.observe(frame: shifted(frame, by: 30), sidebar: sidebar, now: 1.55))
        XCTAssertFalse(tracker.isTracking)
    }

    func testStopsWhenTheWindowIsGoneAndForgetsIt() {
        var tracker = FrameTracker()
        tracker.observe(frame: frame, sidebar: sidebar, now: 0)
        tracker.kick(now: 0.1)
        XCTAssertFalse(tracker.observe(frame: nil, sidebar: nil, now: 0.2))
        // The next read is a first read again, not a change.
        XCTAssertFalse(tracker.observe(frame: shifted(frame, by: 50), sidebar: sidebar, now: 0.3))
    }
}

final class FollowingTests: XCTestCase {
    private let window = CmuxWindow(
        frame: frame,
        isMinimised: false,
        isFullScreen: false,
        windowNumber: 42,
        sidebar: sidebar,
        content: Rect(x: 685, y: 84, width: 643, height: 984)
    )

    func testShiftsTheSidebarAndContentWithAMove() {
        let moved = Rect(x: 400, y: 66, width: 1309, height: 1012)
        let followed = window.following(frame: moved, sidebar: nil)
        XCTAssertEqual(followed.frame, moved)
        XCTAssertEqual(followed.sidebar, Rect(x: 400, y: 88, width: 315, height: 940))
        XCTAssertEqual(followed.content, Rect(x: 715, y: 94, width: 643, height: 984))
        XCTAssertEqual(followed.windowNumber, 42)
    }

    func testTakesAFreshSidebarReadWhenThereIsOne() {
        let wider = Rect(x: 370, y: 78, width: 360, height: 940)
        XCTAssertEqual(window.following(frame: frame, sidebar: wider).sidebar, wider)
    }

    func testLeavesMissingPartsMissing() {
        let bare = CmuxWindow(frame: frame, isMinimised: false, isFullScreen: false, windowNumber: 42)
        let followed = bare.following(frame: shifted(frame, by: 10), sidebar: nil)
        XCTAssertNil(followed.sidebar)
        XCTAssertNil(followed.content)
    }
}
