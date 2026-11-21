import Foundation

public enum AppNavigationSection: String, CaseIterable, Identifiable, Sendable {
    case dashboard = "Dashboard"
    case castScreen = "Cast Screen"
    case receiveScreen = "Receive Screen"
    case nearbyDevices = "Nearby Devices"
    case connectionStatus = "Connection Status"
    case settings = "Settings"

    public var id: String { rawValue }

    public var systemImage: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .castScreen: return "display.and.arrow.down"
        case .receiveScreen: return "tv"
        case .nearbyDevices: return "bonjour"
        case .connectionStatus: return "waveform.path.ecg"
        case .settings: return "gearshape"
        }
    }

    public var subtitle: String {
        switch self {
        case .dashboard: return "System readiness, permissions, and Phase 3 scope"
        case .castScreen: return "ScreenCaptureKit display enumeration and local capture test"
        case .receiveScreen: return "Receiver layout foundation (streaming arrives in Phase 10)"
        case .nearbyDevices: return "Bonjour _castora._tcp discovery foundation (arrives in Phase 5)"
        case .connectionStatus: return "Signaling and WebRTC pipeline state"
        case .settings: return "Local device identity and capture preferences"
        }
    }
}

public enum TransportPipelineStatus: String, Sendable, Equatable {
    case notImplementedInPhase3 = "Not Connected (Phase 3 Foundation)"

    public var detail: String {
        "Bonjour discovery (Phase 5), WebSocket signaling (Phase 6), and WebRTC DTLS-SRTP media (Phase 10) are not implemented yet."
    }
}
