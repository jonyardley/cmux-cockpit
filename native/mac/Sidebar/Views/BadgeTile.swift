import SwiftUI

/// A project's badge: its icon in semibold on a rounded square of its
/// colour, the glyph inked light or dark for contrast (BadgeInk). The port
/// of `projectBadge` in src/shared/ui.ts, so every badge in the panel (a
/// card, a project header, the editor) is the one view. A project with no
/// colour takes the cockpit's grey. A card waiting on Jon carries the
/// needs dot on its top corner (issue #314), in `mark`, ringed in `ring`,
/// the face it sits on, so it reads apart from the tile.
struct BadgeTile: View {
    let icon: String
    let color: UInt32?
    let size: CGFloat
    let font: CGFloat
    var radius: CGFloat = 5
    var mark: Token?
    var ring: Color = Color(Palette.Own.card)

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

/// The needs dot: a disc in the wait's colour inside a ring of the face
/// under it, set out over a corner by a third of its size.
struct NeedsDot: View {
    let ink: Token
    let size: CGFloat
    let ring: Color

    var body: some View {
        Circle()
            .fill(Color(ink))
            .frame(width: size, height: size)
            .padding(Metrics.needsDotRing)
            .background(ring, in: .circle)
            .offset(x: size / 3, y: -size / 3)
            .allowsHitTesting(false)
    }
}
