import Foundation

/// Phase 3 Networking Foundation Contracts.
/// Bonjour (`_castora._tcp`) discovery is scheduled for Phase 5, and local WebSocket signaling
/// (`ws://<ip>:<port>/castora`) is scheduled for Phase 6.
/// No fake peers or simulated connections are produced here.

public protocol BonjourDiscoveryServicing: Sendable {
    var serviceType: String { get }
}

public protocol SignalingTransportServicing: Sendable {
    var webSocketPath: String { get }
}

public struct Phase3NetworkingConfiguration: BonjourDiscoveryServicing, SignalingTransportServicing {
    public let serviceType = CastoraProtocolConstants.bonjourServiceType
    public let webSocketPath = CastoraProtocolConstants.webSocketPath
    public let protocolVersion = CastoraProtocolConstants.version

    public init() {}
}
