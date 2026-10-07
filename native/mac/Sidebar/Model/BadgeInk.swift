import Foundation

/// A project badge's glyph ink: white or the dark text, whichever has the
/// higher WCAG contrast against the badge's face. `glyphColor` in
/// src/shared/contrast.ts; a tie goes to white, as there. The face does not
/// change with the appearance, so neither does the ink that reads on it.
enum BadgeInk {
    /// The face of a badge with no colour: the light palette's grey, the
    /// same on both sides, as NO_PROJECT in src/shared/projects.ts.
    static let fallback: UInt32 = Palette.rgba(Palette.Own.grey, dark: false).hex
    /// The dark glyph: the light palette's text.
    static let dark: UInt32 = Palette.rgba(Token.text, dark: false).hex
    static let light: UInt32 = 0xFFFFFF

    // Fixed, so worked out once (contrast.ts LIGHT_LUMINANCE).
    private static let lightLuminance = luminance(light)
    private static let darkLuminance = luminance(dark)

    static func glyph(on face: UInt32) -> UInt32 {
        let bg = luminance(face)
        return ratio(bg, darkLuminance) > ratio(bg, lightLuminance) ? dark : light
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
}
