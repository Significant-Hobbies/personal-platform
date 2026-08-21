// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PersonalSyncKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .watchOS(.v10),
    ],
    products: [
        .library(name: "PersonalSyncKit", targets: ["PersonalSyncKit"]),
    ],
    targets: [
        .target(name: "PersonalSyncKit"),
        .testTarget(name: "PersonalSyncKitTests", dependencies: ["PersonalSyncKit"]),
    ]
)
