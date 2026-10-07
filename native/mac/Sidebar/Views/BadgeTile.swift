import SwiftUI

/// A project's badge: its icon in semibold on a rounded square of its
/// colour, the glyph inked light or dark for contrast. The port of
/// `projectBadge` in src/shared/ui.ts, so every badge in the panel (a card,
/// a project header, the editor) is the one view. A project with no colour
/// takes the cockpit's grey, as NO_PROJECT does in src/shared/projects.ts.
struct BadgeTile: View {
    let icon: String
    let color: UInt32?
    let size: CGFloat
    let font: CGFloat
    var radius: CGFloat = 5

    var body: some View {
        let face = color ?? Self.fallback
        ZStack {
            RoundedRectangle(cornerRadius: radius)
                .fill(Self.color(face))
            Image(systemName: icon)
                .font(.system(size: font, weight: .semibold))
                .foregroundStyle(Self.color(Self.glyph(on: face)))
        }
        .frame(width: size, height: size)
    }

    /// The face of a badge with no colour: the light palette's grey, the
    /// same on both sides, as a project's own colour is.
    static let fallback: UInt32 = Palette.rgba(Palette.Own.grey, dark: false).hex
    /// The dark glyph: the light palette's text. The face does not change
    /// with the appearance, so neither does the ink that reads on it.
    static let darkGlyph: UInt32 = Palette.rgba(Token.text, dark: false).hex
    static let lightGlyph: UInt32 = 0xFFFFFF

    /// White or the dark text, whichever has the higher WCAG contrast
    /// against `face`: `glyphColor` in src/shared/contrast.ts. A tie goes
    /// to white, as there.
    static func glyph(on face: UInt32) -> UInt32 {
        let bg = luminance(face)
        let light = ratio(bg, luminance(lightGlyph))
        let dark = ratio(bg, luminance(darkGlyph))
        return dark > light ? darkGlyph : lightGlyph
    }

    /// WCAG relative luminance of six hex digits.
    static func luminance(_ hex: UInt32) -> Double {
        let c = RGBA(hex)
        return 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue)
    }

    private static func channel(_ c: Double) -> Double {
        c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    private static func ratio(_ a: Double, _ b: Double) -> Double {
        (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private static func color(_ hex: UInt32) -> Color {
        let c = RGBA(hex)
        return Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: 1)
    }
}
