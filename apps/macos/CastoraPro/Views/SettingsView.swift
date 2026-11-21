import SwiftUI

public struct SettingsView: View {
    @ObservedObject public var viewModel: CastoraAppViewModel
    @State private var savedNotice: String?

    public init(viewModel: CastoraAppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionHeader(
                title: "Settings",
                subtitle: AppNavigationSection.settings.subtitle
            )

            SurfaceCard {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Device Identity")
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)

                    HStack(spacing: 12) {
                        TextField("Device Display Name", text: $viewModel.deviceDisplayName)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 340)

                        Button("Save Name") {
                            viewModel.saveDeviceDisplayName()
                            savedNotice = "Saved display name."
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(CastoraTheme.accent)
                    }

                    if let savedNotice {
                        Text(savedNotice)
                            .font(.caption)
                            .foregroundStyle(CastoraTheme.success)
                    }

                    Text("Ephemeral Device ID: \(viewModel.localDeviceId)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(CastoraTheme.textSecondary)
                }
            }

            SurfaceCard {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Default Capture Preferences")
                        .font(.headline)
                        .foregroundStyle(CastoraTheme.textPrimary)

                    Picker("Default Resolution", selection: $viewModel.captureConfiguration.resolutionPreset) {
                        ForEach(CaptureResolutionPreset.allCases) { preset in
                            Text(preset.rawValue).tag(preset)
                        }
                    }
                    .frame(maxWidth: 340)

                    Picker("Default Frame Rate", selection: $viewModel.captureConfiguration.frameRatePreset) {
                        ForEach(CaptureFrameRatePreset.allCases) { preset in
                            Text(preset.label).tag(preset)
                        }
                    }
                    .frame(maxWidth: 340)

                    Picker("Preferred Video Codec", selection: $viewModel.captureConfiguration.preferredCodec) {
                        ForEach([CastoraVideoCodec.h264, CastoraVideoCodec.hevc]) { codec in
                            Text(codec.rawValue).tag(codec)
                        }
                    }
                    .frame(maxWidth: 340)

                    Toggle("Show Mouse Cursor", isOn: $viewModel.captureConfiguration.showsCursor)
                }
            }
        }
    }
}
