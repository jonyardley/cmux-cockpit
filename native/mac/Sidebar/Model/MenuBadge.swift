import AppKit

/// A project's badge as a menu item's image, for the add and filter menus
/// (docs/design.md#add-button, docs/design.md#filter-button): the face and
/// glyph BadgeTile draws in the Projects view, at the quiet row's size.
///
/// A menu takes its items' images as AppKit images, and the sidebar's
/// menus are drawn by cmux across the extension's remote view, so the
/// badge is painted here into plain bitmaps (1x and 2x, crisp on Retina)
/// that travel as pixels, and marked not a template, so the menu keeps
/// its colour instead of tinting it. The face does not change with the
/// appearance (BadgeInk), so one image serves light and dark.
enum MenuBadge {
    /// The quiet row's badge and glyph (ProjectMetrics.quietBadge and
    /// quietBadgeFont), here so the model test can pin them.
    static let side: Double = 16
    static let font: Double = 9
    /// The pixel scales painted: a plain screen and Retina.
    static let scales = [1, 2]

    /// The badge's face: the project's colour, or the grey of no colour.
    static func face(_ color: UInt32?) -> UInt32 {
        color ?? BadgeInk.fallback
    }

    /// The badge for `icon` (an SF Symbol name) on `color`'s face, as a
    /// menu item's image that keeps its colour.
    static func image(icon: String, color: UInt32?) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side))
        for scale in scales {
            if let rep = bitmap(icon: icon, color: color, scale: scale) { image.addRepresentation(rep) }
        }
        image.isTemplate = false
        return image
    }

    /// One scale of the badge: the rounded face, then the glyph centred in
    /// the ink that reads on it. A name that is no symbol leaves the bare
    /// face, as Image(systemName:) draws nothing for it.
    static func bitmap(icon: String, color: UInt32?, scale: Int) -> NSBitmapImageRep? {
        let pixels = Int(side) * scale
        guard
            let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0
            )
        else { return nil }
        rep.size = NSSize(width: side, height: side)
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        let face = face(color)
        let rect = NSRect(x: 0, y: 0, width: side, height: side)
        let corner = BadgeCorner.radius(side)
        nsColor(face).setFill()
        NSBezierPath(roundedRect: rect, xRadius: corner, yRadius: corner).fill()
        if let glyph = glyph(icon, ink: BadgeInk.glyph(on: face)) {
            let size = glyph.size
            let at = NSRect(
                x: (side - size.width) / 2, y: (side - size.height) / 2,
                width: size.width, height: size.height
            )
            glyph.draw(in: at)
        }
        context.flushGraphics()
        return rep
    }

    /// The symbol in semibold at the badge's glyph size, painted in `ink`.
    private static func glyph(_ icon: String, ink: UInt32) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: font, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [nsColor(ink)]))
        return NSImage(systemSymbolName: icon, accessibilityDescription: nil)?
            .withSymbolConfiguration(config)
    }

    private static func nsColor(_ hex: UInt32) -> NSColor {
        let c = RGBA(hex)
        return NSColor(srgbRed: c.red, green: c.green, blue: c.blue, alpha: 1)
    }
}
