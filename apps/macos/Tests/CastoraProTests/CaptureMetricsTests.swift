import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import XCTest
@testable import CastoraPro

final class CaptureMetricsTests: XCTestCase {
    @MainActor
    func testStreamConfigurationUsesExactMinimumFrameIntervalFor60And30Fps() {
        let service = ScreenCaptureService()
        let display = DisplayDescriptor(
            id: 1,
            name: "Built-in Retina Display",
            width: 1470,
            height: 956,
            isMainDisplay: true
        )

        var config60 = CaptureConfiguration()
        config60.resolutionPreset = .fullHD1080
        config60.frameRatePreset = .fps60
        config60.showsCursor = true

        let scConfig60 = service.buildStreamConfiguration(for: display, configuration: config60)
        XCTAssertEqual(scConfig60.width, 1470)
        XCTAssertEqual(scConfig60.height, 956)
        XCTAssertEqual(scConfig60.minimumFrameInterval, CMTime(value: 1, timescale: 60))
        XCTAssertEqual(scConfig60.pixelFormat, kCVPixelFormatType_32BGRA)
        XCTAssertEqual(scConfig60.queueDepth, 8)
        XCTAssertTrue(scConfig60.showsCursor)

        var config30 = config60
        config30.frameRatePreset = .fps30
        let scConfig30 = service.buildStreamConfiguration(for: display, configuration: config30)
        XCTAssertEqual(scConfig30.minimumFrameInterval, CMTime(value: 1, timescale: 30))
    }

    func testRollingWindowMeasuresReal60FpsWithoutFaking() {
        let tracker = CaptureMetricsTracker(rollingWindowSeconds: 2.0)
        tracker.reset(at: 100.0)

        let step = 1.0 / 60.0
        for index in 1...180 {
            let timestamp = 100.0 + Double(index) * step
            tracker.recordCallback(
                outcome: .complete,
                presentationTimestampSeconds: Double(index) * step,
                at: timestamp
            )
        }

        let snapshot = tracker.snapshot(at: 103.0)
        XCTAssertEqual(snapshot.receivedCallbacks, 180)
        XCTAssertEqual(snapshot.completeFrames, 180)
        XCTAssertEqual(snapshot.idleFrames, 0)
        XCTAssertEqual(snapshot.droppedFrames, 0)
        XCTAssertEqual(snapshot.rollingCompleteFps, 60.0, accuracy: 0.5)
        XCTAssertEqual(snapshot.sessionAverageCompleteFps, 60.0, accuracy: 0.5)
        XCTAssertEqual(snapshot.lastInterFrameIntervalMs ?? 0, 16.67, accuracy: 0.2)
        XCTAssertEqual(snapshot.lastPresentationTimestampSeconds ?? 0, 3.0, accuracy: 0.02)
    }

    func testTracksIdleAndDroppedCallbacksSeparatelyFromCompleteFrames() {
        let tracker = CaptureMetricsTracker(rollingWindowSeconds: 2.0)
        tracker.reset(at: 200.0)

        tracker.recordCallback(outcome: .lifecycle, at: 200.01)
        // Simulate 34 complete frames/s + 26 idle callbacks/s over 2 seconds on a partially static screen
        for sec in 0..<2 {
            for frame in 0..<34 {
                let ts = 200.0 + Double(sec) + (Double(frame) + 0.5) / 34.0
                tracker.recordCallback(outcome: .complete, presentationTimestampSeconds: ts, at: ts)
            }
            for idle in 0..<26 {
                let ts = 200.0 + Double(sec) + (Double(idle) + 0.5) / 26.0
                tracker.recordCallback(outcome: .idle, at: ts)
            }
        }
        tracker.recordCallback(outcome: .dropped, at: 201.95)

        let snapshot = tracker.snapshot(at: 202.0)
        XCTAssertEqual(snapshot.completeFrames, 68)
        XCTAssertEqual(snapshot.idleFrames, 52)
        XCTAssertEqual(snapshot.droppedFrames, 1)
        XCTAssertEqual(snapshot.lifecycleCallbacks, 1)
        XCTAssertEqual(snapshot.receivedCallbacks, 122)
        XCTAssertEqual(snapshot.rollingCompleteFps, 34.0, accuracy: 0.1)
        XCTAssertEqual(snapshot.rollingCallbackRate, 60.5, accuracy: 0.5)
    }

    func testRollingFpsDecaysToZeroWhenScreenBecomesCompletelyStatic() {
        let tracker = CaptureMetricsTracker(rollingWindowSeconds: 2.0)
        tracker.reset(at: 300.0)

        for index in 1...60 {
            let ts = 300.0 + Double(index) / 60.0
            tracker.recordCallback(outcome: .complete, presentationTimestampSeconds: ts, at: ts)
        }

        let activeSnapshot = tracker.snapshot(at: 301.0)
        XCTAssertEqual(activeSnapshot.rollingCompleteFps, 60.0, accuracy: 0.5)

        // Advance past the 2-second rolling window with no new complete frames
        let idleSnapshot = tracker.snapshot(at: 303.5)
        XCTAssertEqual(idleSnapshot.completeFrames, 60)
        XCTAssertEqual(idleSnapshot.rollingCompleteFps, 0.0, accuracy: 0.001)
    }
}
