// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MailServerApp",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "MailServerApp", targets: ["MailServerApp"])
    ],
    targets: [
        .executableTarget(
            name: "MailServerApp",
            path: "Sources/MailServerApp"
        )
    ]
)
