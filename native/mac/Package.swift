// swift-tools-version:5.9
// Tools 5.9 and the Swift 5 language mode on purpose: the Accessibility
// callbacks are C function pointers, and Swift 6's strict concurrency
// checking fights them for no gain in a single threaded panel.
import PackageDescription

let package = Package(
    name: "CmuxPanel",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CmuxPanel", targets: ["CmuxPanel"]),
    ],
    targets: [
        // Pure geometry and visibility rules: no AppKit, no Accessibility.
        .target(name: "PanelLayout"),
        // The thin glue: finds cmux by Accessibility and moves the window.
        .executableTarget(name: "CmuxPanel", dependencies: ["PanelLayout"]),
        .testTarget(name: "PanelLayoutTests", dependencies: ["PanelLayout"]),
    ]
)
