import SwiftUI

/// A project's badge: its icon in semibold on a rounded square of its
/// colour, the glyph inked light or dark for contrast (BadgeInk). The port
/// of `projectBadge` in src/shared/ui.ts, so every badge in the panel (a
/// card, a project header, the editor) is the one view. A project with no
/// colour takes the cockpit's grey.
struct BadgeTile: View {
    let icon: String
    let color: UInt32?
    let size: CGFloat
    let font: CGFloat
    var radius: CGFloat = 5

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
    }
}
