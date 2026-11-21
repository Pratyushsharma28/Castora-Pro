import SwiftUI

public struct RootNavigationView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Castora Pro")
                        .font(.system(size: 19, weight: .bold, design: .rounded))
                        .foregroundStyle(CastoraTheme.textPrimary)
                    Text("macOS Native Foundation · Phase 3")
                        .font(.caption)
                        .foregroundStyle(CastoraTheme.textSecondary)
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)

                List(AppNavigationSection.allCases, selection: $viewModel.selectedSection) { section in
                    Label(section.rawValue, systemImage: section.systemImage)
                        .tag(section)
                        .padding(.vertical, 4)
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            }
            .background(CastoraTheme.surface)
            .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 280)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch viewModel.selectedSection {
                    case .dashboard:
                        DashboardView(viewModel: viewModel)
                    case .castScreen:
                        CastScreenView(viewModel: viewModel)
                    case .receiveScreen:
                        ReceiveScreenView(viewModel: viewModel)
                    case .nearbyDevices:
                        NearbyDevicesView(viewModel: viewModel)
                    case .connectionStatus:
                        ConnectionStatusView(viewModel: viewModel)
                    case .settings:
                        SettingsView(viewModel: viewModel)
                    }
                }
                .padding(24)
                .frame(maxWidth: 1060, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(CastoraTheme.canvas)
            .navigationTitle(viewModel.selectedSection.rawValue)
        }
        .onAppear {
            viewModel.refreshPermissionStatus()
        }
    }
}
