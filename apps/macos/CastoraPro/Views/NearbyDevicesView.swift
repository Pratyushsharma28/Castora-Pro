import SwiftUI

public struct NearbyDevicesView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionHeader(
                title: "Nearby Devices",
                subtitle: AppNavigationSection.nearbyDevices.subtitle
            )

            SurfaceCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("0 Nearby Devices Discovered", systemImage: "bonjour")
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)

                    Text("Bonjour service browsing (\(viewModel.networkingConfig.serviceType)) via Apple's Network.framework will be implemented in Phase 5. Castora Pro never shows fake or hardcoded devices.")
                        .font(.callout)
                        .foregroundStyle(CastoraTheme.textSecondary)
                }
            }
        }
    }
}
