import Foundation

/// Thread-safe, lock-protected capture telemetry collector designed to run directly on
/// ScreenCaptureKit's `captureQueue` without spawning per-frame `@MainActor` tasks.
public final class CaptureMetricsTracker: @unchecked Sendable {
    public let rollingWindowSeconds: TimeInterval

    private let lock = NSLock()
    private var sessionStartTimestamp: TimeInterval?
    private var receivedCallbacks: Int = 0
    private var completeFrames: Int = 0
    private var idleFrames: Int = 0
    private var droppedFrames: Int = 0
    private var lifecycleCallbacks: Int = 0

    private var lastCallbackTimestamp: TimeInterval?
    private var lastCompleteFrameTimestamp: TimeInterval?
    private var lastPresentationTimestampSeconds: Double?
    private var lastInterFrameIntervalMs: Double?

    private var callbackTimestamps: [TimeInterval] = []
    private var completeFrameTimestamps: [TimeInterval] = []

    public init(rollingWindowSeconds: TimeInterval = 2.0) {
        self.rollingWindowSeconds = max(0.5, rollingWindowSeconds)
    }

    public func reset(at timestamp: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        lock.lock()
        defer { lock.unlock() }

        sessionStartTimestamp = timestamp
        receivedCallbacks = 0
        completeFrames = 0
        idleFrames = 0
        droppedFrames = 0
        lifecycleCallbacks = 0
        lastCallbackTimestamp = nil
        lastCompleteFrameTimestamp = nil
        lastPresentationTimestampSeconds = nil
        lastInterFrameIntervalMs = nil
        callbackTimestamps.removeAll(keepingCapacity: true)
        completeFrameTimestamps.removeAll(keepingCapacity: true)
    }

    public func recordCallback(
        outcome: CaptureFrameOutcome,
        presentationTimestampSeconds: Double? = nil,
        at timestamp: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        lock.lock()
        defer { lock.unlock() }

        if sessionStartTimestamp == nil {
            sessionStartTimestamp = timestamp
        }

        receivedCallbacks += 1
        lastCallbackTimestamp = timestamp
        callbackTimestamps.append(timestamp)

        switch outcome {
        case .complete:
            if let previousComplete = lastCompleteFrameTimestamp, timestamp >= previousComplete {
                lastInterFrameIntervalMs = (timestamp - previousComplete) * 1000.0
            }
            completeFrames += 1
            lastCompleteFrameTimestamp = timestamp
            if let pts = presentationTimestampSeconds, pts.isFinite {
                lastPresentationTimestampSeconds = pts
            }
            completeFrameTimestamps.append(timestamp)
        case .idle:
            idleFrames += 1
        case .dropped:
            droppedFrames += 1
        case .lifecycle:
            lifecycleCallbacks += 1
        }

        pruneLocked(olderThan: timestamp - rollingWindowSeconds)
    }

    public func snapshot(at timestamp: TimeInterval = ProcessInfo.processInfo.systemUptime) -> CaptureMetricsSnapshot {
        lock.lock()
        defer { lock.unlock() }

        pruneLocked(olderThan: timestamp - rollingWindowSeconds)

        let elapsed = max(0, sessionStartTimestamp.map { timestamp - $0 } ?? 0)
        let effectiveWindow = min(rollingWindowSeconds, elapsed)

        let rollingCompleteFps: Double
        let rollingCallbackRate: Double
        if effectiveWindow >= 0.25 {
            rollingCompleteFps = Double(completeFrameTimestamps.count) / effectiveWindow
            rollingCallbackRate = Double(callbackTimestamps.count) / effectiveWindow
        } else {
            rollingCompleteFps = 0
            rollingCallbackRate = 0
        }

        let sessionAvgFps = elapsed >= 0.25 ? Double(completeFrames) / elapsed : 0

        return CaptureMetricsSnapshot(
            receivedCallbacks: receivedCallbacks,
            completeFrames: completeFrames,
            idleFrames: idleFrames,
            droppedFrames: droppedFrames,
            lifecycleCallbacks: lifecycleCallbacks,
            rollingCompleteFps: rollingCompleteFps,
            rollingCallbackRate: rollingCallbackRate,
            sessionAverageCompleteFps: sessionAvgFps,
            elapsedSeconds: elapsed,
            lastCallbackTimestamp: lastCallbackTimestamp,
            lastCompleteFrameTimestamp: lastCompleteFrameTimestamp,
            lastPresentationTimestampSeconds: lastPresentationTimestampSeconds,
            lastInterFrameIntervalMs: lastInterFrameIntervalMs
        )
    }

    private func pruneLocked(olderThan cutoff: TimeInterval) {
        if let firstValidIdx = callbackTimestamps.firstIndex(where: { $0 > cutoff }) {
            if firstValidIdx > 0 {
                callbackTimestamps.removeFirst(firstValidIdx)
            }
        } else {
            callbackTimestamps.removeAll(keepingCapacity: true)
        }

        if let firstValidCompleteIdx = completeFrameTimestamps.firstIndex(where: { $0 > cutoff }) {
            if firstValidCompleteIdx > 0 {
                completeFrameTimestamps.removeFirst(firstValidCompleteIdx)
            }
        } else {
            completeFrameTimestamps.removeAll(keepingCapacity: true)
        }
    }
}
