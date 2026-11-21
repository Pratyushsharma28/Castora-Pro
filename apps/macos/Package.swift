// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CastoraPro",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "CastoraPro",
            targets: ["CastoraPro"]
        )
    ],
    targets: [
        .executableTarget(
            name: "CastoraPro",
            path: "CastoraPro",
            exclude: [
                "Resources"
            ],
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit")
            ]
        ),
        .testTarget(
            name: "CastoraProTests",
            dependencies: ["CastoraPro"],
            path: "Tests/CastoraProTests"
        )
    ]
)
