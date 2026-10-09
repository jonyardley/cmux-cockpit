import SwiftUI

/// A project's badge: its icon in semibold on a rounded square of its
/// colour, the glyph inked light or dark for contrast (BadgeInk). The port
/// of `projectBadge` in src/shared/ui.ts, so every badge in the panel (a
/// card, a project header, the editor) is the one view. A project with no
/// colour takes the cockpit's grey. A card waiting on Jon carries the
/// needs dot on its top corner (issue #314), in `mark`, ringed in the
/// face it sits on (the card's, from the environment), so it reads apart
/// from the tile.
struct BadgeTile: View {
    let icon: String
    let color: UInt32?
    let size: CGFloat
    let font: CGFloat
    var radius: CGFloat = 5
    var mark: Token?
    @Environment(\.cardFace) private var ring

    var body: some View {
        let face = color ?? BadgeInk.fallback
        ZStack {
            RoundedRectangle(cornerRadius: radius)
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
