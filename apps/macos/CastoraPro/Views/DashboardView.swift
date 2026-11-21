import SwiftUI

public struct DashboardView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionHeader(
                title: "Dashboard",
                subtitle: AppNavigationSection.dashboard.subtitle
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

            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 260), spacing: 16)
                ],
                spacing: 16
            ) {
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Local Device Identity")
                            .font(.headline)
                            .foregroundStyle(CastoraTheme.textPrimary)
                        Text(viewModel.deviceDisplayName)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(CastoraTheme.accent)
                        Text("Device ID: \(viewModel.localDeviceId)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(CastoraTheme.textSecondary)
                    }
                }

                SurfaceCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("VideoToolbox Hardware")
                            .font(.headline)
                            .foregroundStyle(CastoraTheme.textPrimary)
                        Text(viewModel.encoderCapability.summary)
                            .font(.callout)
                            .foregroundStyle(CastoraTheme.textSecondary)
                        Text("Queried via VTCopyVideoEncoderList")
                            .font(.caption)
                            .foregroundStyle(CastoraTheme.textSecondary)
                    }
                }

                SurfaceCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Shared Protocol")
                            .font(.headline)
                            .foregroundStyle(CastoraTheme.textPrimary)
                        Text(CastoraProtocolConstants.version)
                            .font(.system(.title3, design: .monospaced).weight(.semibold))
                            .foregroundStyle(CastoraTheme.textPrimary)
                        Text("Bonjour: \(viewModel.networkingConfig.serviceType) · Path: \(viewModel.networkingConfig.webSocketPath)")
                            .font(.caption)
                            .foregroundStyle(CastoraTheme.textSecondary)
                    }
                }
            }

            SurfaceCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Phase 3 Scope & Honest Status")
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)
                    Text("Phase 3 implements the native SwiftUI shell, Screen Recording permission handling, ScreenCaptureKit display discovery/local capture test, and castora.v1 Codable models. Network discovery, pairing, WebRTC media transport, and live streaming metrics are intentionally deferred to Phases 5–11.")
                        .font(.callout)
                        .foregroundStyle(CastoraTheme.textSecondary)

                    HStack(spacing: 12) {
                        Button("Go to Cast Screen") {
                            viewModel.selectedSection = .castScreen
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(CastoraTheme.accent)

                        Button("Open Settings") {
                            viewModel.selectedSection = .settings
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.top, 4)
                }
            }
        }
    }
}
