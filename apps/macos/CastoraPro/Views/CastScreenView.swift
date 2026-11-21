import SwiftUI

public struct CastScreenView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionHeader(
                title: "Cast Screen",
                subtitle: AppNavigationSection.castScreen.subtitle
            )

            PermissionBannerView(
                permissionState: viewModel.permissionState,
                onRequestPermission: {
                    Task {
                        await viewModel.requestScreenRecordingPermission()
                    }
                },
                onOpenSettings: viewModel.openPrivacySettings,
                onRefresh: {
                    Task {
                        await viewModel.refreshPermissionStatus()
                    }
                }
            )

            SurfaceCard {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Available Displays (ScreenCaptureKit)")
                                .font(.headline)
                                .foregroundStyle(CastoraTheme.textPrimary)
                            Text("Enumerated directly from SCShareableContent.")
                                .font(.caption)
                                .foregroundStyle(CastoraTheme.textSecondary)
                        }

                        Spacer()

                        Button("Refresh Displays") {
                            Task {
                                await viewModel.refreshDisplays()
                            }
                        }
                        .buttonStyle(.bordered)
                    }

                    if viewModel.displays.isEmpty {
                        Text(
                            viewModel.permissionState.screenRecording.isGranted
                            ? "Click Refresh Displays to enumerate connected screens via ScreenCaptureKit."
                            : "Click Refresh Displays to verify ScreenCaptureKit display access or grant permission above."
                        )
                        .font(.callout)
                        .foregroundStyle(CastoraTheme.textSecondary)
                    } else {
                        Picker("Display", selection: $viewModel.selectedDisplayID) {
                            ForEach(viewModel.displays) { display in
                                Text("\(display.name) — \(display.resolutionText)")
                                    .tag(Optional(display.id))
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(viewModel.captureState.isCapturing)
                    }
                }
            }

            SurfaceCard {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Local Capture Configuration")
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)

                    HStack(spacing: 16) {
                        Picker("Resolution Target", selection: $viewModel.captureConfiguration.resolutionPreset) {
                            ForEach(CaptureResolutionPreset.allCases) { preset in
                                Text(preset.rawValue).tag(preset)
                            }
                        }
                        .disabled(viewModel.captureState.isCapturing)

                        Picker("Frame Rate Target", selection: $viewModel.captureConfiguration.frameRatePreset) {
                            ForEach(CaptureFrameRatePreset.allCases) { preset in
                                Text(preset.label).tag(preset)
                            }
                        }
                        .disabled(viewModel.captureState.isCapturing)
                    }

                    Toggle("Include Cursor in Capture", isOn: $viewModel.captureConfiguration.showsCursor)
                        .disabled(viewModel.captureState.isCapturing)

                    if let display = viewModel.selectedDisplay {
                        let resolved = viewModel.captureConfiguration.resolutionPreset.targetSize(for: display)
                        Text("Prepared SCStreamConfiguration: \(resolved.width)×\(resolved.height) @ \(viewModel.captureConfiguration.frameRatePreset.rawValue) FPS target · BGRA pixel buffer")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(CastoraTheme.textSecondary)
                    }

                    Divider().overlay(CastoraTheme.hairline)

                    HStack(spacing: 12) {
                        if viewModel.captureState.isCapturing {
                            Button("Stop Local Capture") {
                                Task {
                                    await viewModel.stopLocalCaptureTest()
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(CastoraTheme.danger)
                        } else {
                            Button("Start Local Capture Test") {
                                Task {
                                    await viewModel.startLocalCaptureTest()
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(CastoraTheme.accent)
                            .disabled(viewModel.captureState.isBusy)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(viewModel.captureState.statusLabel)
                                .font(.callout.weight(.medium))
                                .foregroundStyle(CastoraTheme.textPrimary)
                            Text(
                                String(
                                    format: "Measured Rolling FPS: %.1f FPS · Session Avg: %.2f FPS · All Callbacks: %.1f/s",
                                    viewModel.captureMetrics.rollingCompleteFps,
                                    viewModel.captureMetrics.sessionAverageCompleteFps,
                                    viewModel.captureMetrics.rollingCallbackRate
                                )
                            )
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(CastoraTheme.textSecondary)
                        }
                    }

                    let metrics = viewModel.captureMetrics
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 165), spacing: 10)],
                        spacing: 10
                    ) {
                        captureMetricCell(
                            label: "Complete Frames",
                            value: "\(metrics.completeFrames)"
                        )
                        captureMetricCell(
                            label: "Received Callbacks",
                            value: "\(metrics.receivedCallbacks)"
                        )
                        captureMetricCell(
                            label: "Idle (Static Screen)",
                            value: "\(metrics.idleFrames)"
                        )
                        captureMetricCell(
                            label: "Dropped / Blank",
                            value: "\(metrics.droppedFrames)"
                        )
                        captureMetricCell(
                            label: "Frame Interval",
                            value: metrics.lastInterFrameIntervalMs.map { String(format: "%.2f ms", $0) } ?? "—"
                        )
                        captureMetricCell(
                            label: "Last PTS / Elapsed",
                            value: formatTimestampSummary(metrics: metrics)
                        )
                    }

                    Text("ScreenCaptureKit delivers .complete frames only when display pixels change; static content produces .idle callbacks.")
                        .font(.caption)
                        .foregroundStyle(CastoraTheme.textSecondary)

                    if let errorMessage = viewModel.lastCaptureError {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(CastoraTheme.danger)
                    }
                }
            }
        }
        .task {
            if viewModel.displays.isEmpty {
                await viewModel.refreshDisplays()
            }
        }
    }

    private func captureMetricCell(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(CastoraTheme.textSecondary)
            Text(value)
                .font(.system(.callout, design: .monospaced).weight(.semibold))
                .foregroundStyle(CastoraTheme.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(CastoraTheme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CastoraTheme.hairline, lineWidth: 1)
        )
    }

    private func formatTimestampSummary(metrics: CaptureMetricsSnapshot) -> String {
        let ptsText = metrics.lastPresentationTimestampSeconds.map { String(format: "%.2fs", $0) } ?? "—"
        let elapsedText = metrics.elapsedSeconds > 0 ? String(format: "%.1fs", metrics.elapsedSeconds) : "0.0s"
        return "\(ptsText) / \(elapsedText)"
    }
}
