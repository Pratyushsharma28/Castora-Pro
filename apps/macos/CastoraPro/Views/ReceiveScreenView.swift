import SwiftUI

public struct ReceiveScreenView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionHeader(
                title: "Receive Screen",
                subtitle: AppNavigationSection.receiveScreen.subtitle
            )

            SurfaceCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Receiver Stage Not Active in Phase 3", systemImage: "tv.slash")
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)

                    Text("Castora Pro's macOS Receiver will display a scannable QR code, temporary 6-character Room ID, explicit sender approval prompts, and an adaptive multi-screen grid with fullscreen switching once Phases 6, 7, 10, and 14 are implemented.")
                        .font(.callout)
                        .foregroundStyle(CastoraTheme.textSecondary)

                    Text("No fake streams or placeholder video tiles are shown here.")
                        .font(.caption)
                        .foregroundStyle(CastoraTheme.textSecondary)
                }
            }
        }
    }
}
