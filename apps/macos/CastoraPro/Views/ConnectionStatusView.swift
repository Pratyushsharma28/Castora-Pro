import SwiftUI

public struct ConnectionStatusView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionHeader(
                title: "Connection Status",
                subtitle: AppNavigationSection.connectionStatus.subtitle
            )

            SurfaceCard {
                VStack(alignment: .leading, spacing: 14) {
                    Text(viewModel.transportStatus.rawValue)
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)

                    Text(viewModel.transportStatus.detail)
                        .font(.callout)
                        .foregroundStyle(CastoraTheme.textSecondary)

                    Divider().overlay(CastoraTheme.hairline)

                    VStack(alignment: .leading, spacing: 8) {
                        statusRow(label: "Protocol Contract", value: "\(CastoraProtocolConstants.version) (Codable Models Ready)")
                        statusRow(label: "ScreenCaptureKit", value: viewModel.captureState.statusLabel)
                        statusRow(label: "Bonjour Discovery", value: "Planned (Phase 5)")
                        statusRow(label: "WebSocket Signaling", value: "Planned (Phase 6)")
                        statusRow(label: "WebRTC DTLS-SRTP Media", value: "Planned (Phase 10)")
                        statusRow(label: "Live RTCStatsReport Telemetry", value: "Planned (Phase 11 — no synthetic metrics)")
                    }
                }
            }
        }
    }

    private func statusRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.callout)
                .foregroundStyle(CastoraTheme.textSecondary)
            Spacer()
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(CastoraTheme.textPrimary)
        }
    }
}
