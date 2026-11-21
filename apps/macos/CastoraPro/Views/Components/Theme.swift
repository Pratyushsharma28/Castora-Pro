import SwiftUI

public enum CastoraTheme {
    public static let canvas = Color(red: 0.055, green: 0.070, blue: 0.102)
    public static let surface = Color(red: 0.090, green: 0.114, blue: 0.161)
    public static let surfaceElevated = Color(red: 0.125, green: 0.157, blue: 0.216)
    public static let hairline = Color.white.opacity(0.10)
    public static let accent = Color(red: 0.231, green: 0.510, blue: 0.961)
    public static let success = Color(red: 0.133, green: 0.773, blue: 0.369)
    public static let warning = Color(red: 0.961, green: 0.620, blue: 0.043)
    public static let danger = Color(red: 0.937, green: 0.267, blue: 0.267)
    public static let textPrimary = Color.white
    public static let textSecondary = Color.white.opacity(0.68)
}

public struct SurfaceCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CastoraTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(CastoraTheme.hairline, lineWidth: 1)
            )
    }
}

public struct SectionHeader: View {
    public let title: String
    public let subtitle: String

    public init(title: String, subtitle: String) {
        self.title = title
        self.subtitle = subtitle
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(CastoraTheme.textPrimary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(CastoraTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

public struct PermissionBannerView: View {
    public let permissionState: PermissionDiagnosticState
    public let onRequestPermission: () -> Void
    public let onOpenSettings: () -> Void
    public let onRefresh: () -> Void

    public init(
        permissionState: PermissionDiagnosticState,
        onRequestPermission: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onRefresh: @escaping () -> Void
    ) {
        self.permissionState = permissionState
        self.onRequestPermission = onRequestPermission
        self.onOpenSettings = onOpenSettings
        self.onRefresh = onRefresh
    }

    public var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    statusIcon

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Screen Recording Permission: \(permissionState.screenRecording.title)")
                            .font(.headline)
                            .foregroundStyle(CastoraTheme.textPrimary)
                        Text(permissionState.screenRecording.explanation)
                            .font(.callout)
                            .foregroundStyle(CastoraTheme.textSecondary)
                    }
                }

                diagnosticDetailsView

                if let actionMessage = permissionState.lastActionMessage {
                    Text(actionMessage)
                        .font(.caption)
                        .foregroundStyle(CastoraTheme.textSecondary)
                }

                HStack(spacing: 10) {
                    if !permissionState.screenRecording.isGranted {
                        Button("Request Permission", action: onRequestPermission)
                            .buttonStyle(.borderedProminent)
                            .tint(CastoraTheme.accent)
                            .disabled(permissionState.screenRecording.isChecking)

                        Button("Open Privacy Settings", action: onOpenSettings)
                            .buttonStyle(.bordered)
                    }

                    Button("Refresh Status", action: onRefresh)
                        .buttonStyle(.bordered)
                        .disabled(permissionState.screenRecording.isChecking)
                }
            }
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch permissionState.screenRecording {
        case .checking:
            ProgressView()
                .controlSize(.small)
        case .granted:
            Image(systemName: "checkmark.shield.fill")
                .font(.title3)
                .foregroundStyle(CastoraTheme.success)
        case .deniedOrNotGranted:
            Image(systemName: "exclamationmark.shield.fill")
                .font(.title3)
                .foregroundStyle(CastoraTheme.warning)
        case .diagnosticError:
            Image(systemName: "xmark.shield.fill")
                .font(.title3)
                .foregroundStyle(CastoraTheme.danger)
        }
    }

    @ViewBuilder
    private var diagnosticDetailsView: some View {
        let preflightText = permissionState.preflightGranted.map { $0 ? "true" : "false" } ?? "unknown"
        let sckText: String = {
            switch permissionState.shareableContentAuthorized {
            case .some(true):
                return "authorized"
            case .some(false):
                return "failed"
            case .none:
                return "pending"
            }
        }()

        VStack(alignment: .leading, spacing: 4) {
            Text("Diagnostics · CGPreflight: \(preflightText) · ScreenCaptureKit Query: \(sckText)")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(CastoraTheme.textSecondary)

            if let domain = permissionState.errorDomain, let code = permissionState.errorCode {
                let detail = permissionState.errorDescription ?? ""
                Text("NSError: \(domain) (code \(code)) \(detail)")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(CastoraTheme.warning)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CastoraTheme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
