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
                onRequestPermission: viewModel.requestScreenRecordingPermission,
                onOpenSettings: viewModel.openPrivacySettings,
                onRefresh: viewModel.refreshPermissionStatus
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
                            : "Grant Screen Recording permission above before enumerating displays."
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
                            .disabled(!viewModel.permissionState.screenRecording.isGranted)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(viewModel.captureState.statusLabel)
                                .font(.callout.weight(.medium))
                                .foregroundStyle(CastoraTheme.textPrimary)
                            Text("Delivered ScreenCaptureKit callbacks (local only, no streaming): \(viewModel.deliveredFrameCount)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(CastoraTheme.textSecondary)
                        }
                    }

                    if let errorMessage = viewModel.lastCaptureError {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(CastoraTheme.danger)
                    }
                }
            }
        }
        .task {
            if viewModel.permissionState.screenRecording.isGranted && viewModel.displays.isEmpty {
                await viewModel.refreshDisplays()
            }
        }
    }
}
