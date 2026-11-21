import Foundation

public struct DeviceIdentityService: @unchecked Sendable {
    private let userDefaults: UserDefaults
    private let deviceIdKey = "com.castorapro.macos.ephemeralDeviceId"
    private let deviceNameKey = "com.castorapro.macos.deviceDisplayName"

    public init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    public func loadOrCreateDeviceId() -> String {
        if let existing = userDefaults.string(forKey: deviceIdKey), existing.count >= 3 {
            return existing
        }
        let generated = "mac-\(UUID().uuidString.prefix(8).lowercased())"
        userDefaults.set(generated, forKey: deviceIdKey)
        return generated
    }

    public func loadDeviceName() -> String {
        if let saved = userDefaults.string(forKey: deviceNameKey), !saved.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return saved
        }
        return Host.current().localizedName ?? "Mac"
    }

    public func saveDeviceName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            userDefaults.set(trimmed, forKey: deviceNameKey)
        }
    }
}
