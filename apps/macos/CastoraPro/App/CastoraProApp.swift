import SwiftUI

@main
public struct CastoraProApp: App {
    @StateObject private var viewModel = CastoraAppViewModel()

    public init() {}

    public var body: some Scene {
        WindowGroup {
            RootNavigationView(viewModel: viewModel)
                .frame(minWidth: 860, minHeight: 580)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1140, height: 740)
    }
}
