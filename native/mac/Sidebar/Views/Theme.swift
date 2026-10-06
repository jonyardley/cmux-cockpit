import AppKit
import SwiftUI

/// The palette's colours for SwiftUI, light or dark as the sidebar's
/// appearance is, so no view passes the scheme around.
extension Color {
    init(_ token: Token) {
        self.init(nsColor: Self.dynamic(light: Palette.rgba(token, dark: false), dark: Palette.rgba(token, dark: true)))
    }

    init(_ own: Palette.Own) {
        self.init(nsColor: Self.dynamic(light: Palette.rgba(own, dark: false), dark: Palette.rgba(own, dark: true)))
    }

    /// A dot's colour: its token, or the grey outline with none.
    init(dot ink: Token?) {
        if let ink { self.init(ink) } else { self.init(Palette.Own.grey) }
    }

    /// Both sides are looked up first: the provider runs whenever the
    /// appearance changes, on any thread, so it captures plain values.
    private static func dynamic(light: RGBA, dark: RGBA) -> NSColor {
        NSColor(name: nil) { appearance in
            let c = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: c.red, green: c.green, blue: c.blue, alpha: c.opacity)
        }
    }
}

/// The panel's type sizes and spacing, in one place.
enum Metrics {
    static let body: CGFloat = 12
    static let small: CGFloat = 11
    static let gutter: CGFloat = 10
    static let cardIndent: CGFloat = 16
    static let chipGap: CGFloat = 4
    static let corner: CGFloat = 6
}
