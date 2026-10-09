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

    /// A lane's own hex colour, the same in light and dark.
    init(own c: Rgba) {
        let rgba = RGBA(c.rgb, c.alpha)
        self.init(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.opacity)
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
    /// The leading edge down a card waiting on Jon.
    static let waitingEdge: CGFloat = 4
    /// Between the cards in a lane, as the cockpit's.
    static let cardGap: CGFloat = 6
    static let corner: CGFloat = 6

    // The cockpit JS sidebar's sizes (src/cockpit/views, src/shared/ui.ts),
    // named for what draws with them, so each part reads as the cockpit's.

    /// Type sizes, 10 to 13.5.
    enum Font {
        /// The fold chevron, the unread badge.
        static let tiny: CGFloat = 10
        /// A section heading in tracked capitals: a lane's name, NEEDS YOU.
        static let section: CGFloat = 10.5
        /// Meta words: an age, a count pill, a header's hint, a chip.
        static let meta: CGFloat = 11
        /// Next's line.
        static let next: CGFloat = 11.5
        /// The view switch's tabs, a card's detail line.
        static let control: CGFloat = 12
        /// A lane or project header's name.
        static let title: CGFloat = 12.5
        /// A compact card's title.
        static let compactTitle: CGFloat = 13
        /// A full card's title.
        static let cardTitle: CGFloat = 13.5
    }

    /// Corner radii.
    enum Radius {
        /// A card.
        static let card: CGFloat = 12
        /// A compact row, a Projects card.
        static let row: CGFloat = 9
        /// The view switch's track.
        static let track: CGFloat = 10
        /// A view switch tab, Next's pill, the unread badge.
        static let tab: CGFloat = 7
        /// A lane header and an empty lane's drop zone.
        static let header: CGFloat = 8
        /// A lane anchor's badge.
        static let anchor: CGFloat = 6
        /// A count pill.
        static let pill: CGFloat = 10
        /// A chip round a branch, a PR or a port.
        static let chip: CGFloat = 6
    }

    /// The view switch: a ringed track round two tabs.
    static let switchHeight: CGFloat = 26
    static let switchInset: CGFloat = 3
    /// Lines round a face: a tab's edge, the track's, Next's.
    static let hairline: CGFloat = 1

    /// A header's fold chevron sits in this slot, so names line up.
    static let chevronWidth: CGFloat = 12
    static let chevronHeight: CGFloat = 16
    /// A lane's square marker on its header.
    static let laneMarker: CGFloat = 9
    /// A status dot on a header, beside its count.
    static let headerDot: CGFloat = 7
    /// Between the parts of a header row.
    static let headerSpacing: CGFloat = 8
    static let headerPadH: CGFloat = 8
    static let headerPadV: CGFloat = 5
    /// From the section above to a header's words.
    static let sectionGap: CGFloat = 14
    /// An empty lane's marker and count, faded.
    static let emptyFade: Double = 0.55
    /// A count pill's padding.
    static let pillPadH: CGFloat = 7
    static let pillPadV: CGFloat = 1
    /// A section heading's letter spacing, for the JS side's hair spaces.
    static let sectionTracking: CGFloat = 1
}
