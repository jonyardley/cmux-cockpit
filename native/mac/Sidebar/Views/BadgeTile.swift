import SwiftUI

/// A project's badge: its icon in semibold on a rounded square of its
/// colour, the glyph inked light or dark for contrast (BadgeInk), so every
/// badge in the panel (a card, a project header, the editor) is the one
/// view (docs/design.md#badge-tile). A project with no colour takes the
/// grey. A card waiting on Jon carries the
/// needs dot on its top corner (issue #314), in `mark`, ringed in the
/// face it sits on (the card's, from the environment), so it reads apart
/// from the tile.
struct BadgeTile: View {
    let icon: String
    let color: UInt32?
    let size: CGFloat
    let font: CGFloat
    var mark: Token?
    @Environment(\.cardFace) private var ring

    var body: some View {
        let face = color ?? BadgeInk.fallback
        ZStack {
            RoundedRectangle(cornerRadius: Self.radius(size))
                .fill(Color(project: face))
            Image(systemName: icon)
                .font(.system(size: font, weight: .semibold))
                .foregroundStyle(Color(project: BadgeInk.glyph(on: face)))
        }
        .frame(width: size, height: size)
        .overlay(alignment: .topTrailing) {
            if let mark { NeedsDot(ink: mark, size: (size * Metrics.needsDotShare).rounded(), ring: ring) }
        }
    }

    /// A badge's corner: 0.3 of its side, rounded, so 26 takes 8, 22 takes
    /// 7, 18 and 16 take 5 and 14 takes 4 (docs/design.md#badge-tile).
    nonisolated static func radius(_ size: CGFloat) -> CGFloat {
        (size * Metrics.Radius.badgeShare).rounded()
    }
}

/// The needs dot: a disc in the wait's colour. On a badge's corner it
/// sits inside a ring of the face under it, set out over the corner by a
/// third of its size; with `onCorner` off it is the bare disc, as where it
/// leads a title.
struct NeedsDot: View {
    let ink: Token
    let size: CGFloat
    var ring: Color = .clear
    var onCorner = true

    var body: some View {
        mark.allowsHitTesting(false)
    }

    /// The disc, ringed and set out on the corner or bare.
    @ViewBuilder private var mark: some View {
        let disc = Circle()
            .fill(Color(ink))
            .frame(width: size, height: size)
        if onCorner {
            // The panel's ground under the ring, as under every card, so
            // a quiet row's see-through hover wash reads as it does there
            // and not tinted by the tile under the corner.
            disc
                .padding(Metrics.needsDotRing)
                .background(ring, in: .circle)
                .background(Color(Palette.Own.panelGround), in: .circle)
                .offset(x: size / 3, y: -size / 3)
        } else {
            disc
        }
    }
}
