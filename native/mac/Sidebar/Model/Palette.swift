import Foundation

/// A colour as the palette holds it: six hex digits and an alpha. A faint
/// token (a hue at an alpha) keeps its alpha here and is drawn over the
/// ground, rather than blended first.
struct RGBA: Equatable, Sendable {
    let hex: UInt32
    let alpha: UInt8

    init(_ hex: UInt32, _ alpha: UInt8 = 0xFF) {
        self.hex = hex
        self.alpha = alpha
    }

    var red: Double { Double((hex >> 16) & 0xFF) / 255 }
    var green: Double { Double((hex >> 8) & 0xFF) / 255 }
    var blue: Double { Double(hex & 0xFF) / 255 }
    var opacity: Double { Double(alpha) / 255 }
}

/// The colours the panel draws with, light and dark, for each of the core's
/// tokens and for the few the views need of their own. Every colour
/// literal in the extension lives here; docs/design.md#colour says where
/// each is drawn. The dark side is the same hues lifted for a dark ground;
/// the panel ground is cmux's window off-white (docs/design.md#the-ground).
/// The views test pins the light side.
enum Palette {
    /// The colours the views use that no core token names.
    enum Own: CaseIterable {
        /// Under the whole panel (and behind a dragged card): cmux's own
        /// off-white, which the right sidebar sits on (sampled from a
        /// light-mode capture), so the panel matches the
        /// rest of the window. Dark is unsampled and stays the dark ground.
        case panelGround
        /// The third ink: where you left off.
        case tertiary
        /// The outline of a dot with no colour of its own.
        case grey
        /// The unread badge's face, and its words.
        case badge
        case onBadge
        /// The shadow under a card being dragged.
        case lift
        /// A solid face: a card's, the chosen view tab, Next's pill.
        case card
        /// The edge round Next's pill: the Ready pill's green, a step
        /// stronger so a hairline shows.
        case readyEdge
        /// The number on the All tab's waiting count: white on clay or
        /// amber, light and dark alike.
        case onFill
        /// A card's face under the pointer: opaque, as it replaces the face.
        case cardHover
        /// A header, tab or badge under the pointer.
        case hover
        /// The Ready pill's face: the finished green, faint.
        case readyBg
        /// A lane header while a card is dragged over its lane.
        case dropTarget
        /// An empty lane's drop zone while a card is dragged over it.
        case zoneLit
        /// The edge round the filter button and its chip while the All
        /// view is filtered: the working blue, the one accent no state
        /// takes on a control.
        case filterEdge
    }

    private struct Pair {
        let light: RGBA
        let dark: RGBA
        init(_ light: RGBA, _ dark: RGBA) {
            self.light = light
            self.dark = dark
        }
    }

    // The hues, apart so the faint tokens are built from them.
    private static let clay = Pair(RGBA(0xD97757), RGBA(0xE08A6D))
    private static let blue = Pair(RGBA(0x3B6FB6), RGBA(0x6A9BE0))
    private static let amber = Pair(RGBA(0xD9A03F), RGBA(0xE3B260))
    private static let green = Pair(RGBA(0x788C5D), RGBA(0x93A877))
    private static let greenDeep = Pair(RGBA(0x3F5A2B), RGBA(0xA6C58A))
    private static let red = Pair(RGBA(0xC0453A), RGBA(0xD9655A))
    /// Ready to merge's vivid green (issue #299), never the finished olive.
    private static let mergeGreen = Pair(RGBA(0x1DB954), RGBA(0x3DD171))
    /// An open PR's state words: GitHub's open green, cooler than the
    /// merge green and the finished olive, lifted in dark to clear the card.
    private static let openGreen = Pair(RGBA(0x1C7A55), RGBA(0x5CC59C))
    /// A merged PR's state words: GitHub's merged purple, lifted in dark.
    private static let purple = Pair(RGBA(0x8250DF), RGBA(0xB08CF5))
    private static let text = Pair(RGBA(0x141413), RGBA(0xF0EEE6))
    private static let secondary = Pair(RGBA(0x5E5D59), RGBA(0xB7B5A9))
    private static let heading = Pair(RGBA(0x3D3D3A), RGBA(0xD6D4CA))
    private static let faint = Pair(RGBA(0x8A8880), RGBA(0x8A8880))
    private static let clayText = Pair(RGBA(0xA34A2A), RGBA(0xE8997C))
    private static let amberText = Pair(RGBA(0x8A5A0B), RGBA(0xE8BC6E))

    /// `pair` at `alpha`, light and dark alike.
    private static func faint(_ pair: Pair, _ alpha: UInt8) -> Pair {
        Pair(RGBA(pair.light.hex, alpha), RGBA(pair.dark.hex, alpha))
    }

    /// `pair` at `alpha` laid over `ground` and made solid, each side over
    /// its own: a pale face whose words read the same whatever is under
    /// it (a card, a card under the pointer, a waiting row's wash).
    private static func solid(_ pair: Pair, _ alpha: UInt8, over ground: Pair) -> Pair {
        Pair(
            blend(RGBA(pair.light.hex, alpha), over: ground.light),
            blend(RGBA(pair.dark.hex, alpha), over: ground.dark)
        )
    }

    /// `top` laid over `ground`, solid: each channel mixed by the top's
    /// alpha and rounded, the ground's own alpha ignored.
    static func blend(_ top: RGBA, over ground: RGBA) -> RGBA {
        let a = UInt32(top.alpha)
        let mix = { (shift: UInt32) -> UInt32 in
            let t = (top.hex >> shift) & 0xFF
            let g = (ground.hex >> shift) & 0xFF
            return ((t * a + g * (255 - a) + 127) / 255) << shift
        }
        return RGBA(mix(16) | mix(8) | mix(0))
    }

    /// A card's own face, which the solid chip faces are laid over.
    private static let cardFace = Pair(RGBA(0xFFFFFF), RGBA(0x30302D))

    private static func pair(_ token: Token) -> Pair {
        switch token {
        case .clear: Pair(RGBA(0, 0), RGBA(0, 0))
        case .blue: blue
        case .clay: clay
        case .green: green
        case .amber: amber
        case .blueHalo: faint(blue, 0x2E)
        case .clayHalo: faint(clay, 0x38)
        case .amberHalo: faint(amber, 0x38)
        case .blueText: Pair(RGBA(0x2F5690), RGBA(0x8FB4EC))
        case .clayText: clayText
        case .greenText: Pair(RGBA(0x5E7A40), RGBA(0xA3BC85))
        case .amberText: amberText
        case .metaText: Pair(RGBA(0x6B6A64), RGBA(0xA3A199))
        case .faint, .laneBackground: faint
        case .heading, .select, .laneMain: heading
        case .greenDeep: greenDeep
        case .text: text
        case .secondary, .laneReview: secondary
        case .redText: Pair(RGBA(0x9E2F27), RGBA(0xE3796F))
        case .chipFace: Pair(RGBA(0xF1EFE8), RGBA(0x30302D))
        case .chipEdge: Pair(RGBA(0xE2DFD3), RGBA(0x484741))
        case .redChipFace: faint(red, 0x1A)
        case .redChipEdge: faint(red, 0x38)
        case .blueChipFace: faint(blue, 0x1A)
        case .blueChipEdge: faint(blue, 0x38)
        case .greenChipFace: faint(green, 0x29)
        case .greenChipEdge: faint(greenDeep, 0x59)
        case .countBg: Pair(RGBA(0xE5E2D6), RGBA(0x3A3935))
        case .blueCount: faint(blue, 0x1F)
        case .clayCount: faint(clay, 0x29)
        case .amberCount: faint(amber, 0x29)
        case .cardEdge: faint(text, 0x1F)
        case .laneParked: Pair(RGBA(0xB0AEA5), RGBA(0x6E6C66))
        case .laneUnsorted: Pair(RGBA(0xC9C6BB), RGBA(0x57564F))
        case .laneViolet: Pair(RGBA(0x7A5BA6), RGBA(0xB39BD6))
        case .laneTeal: Pair(RGBA(0x2E8A86), RGBA(0x6CC2BC))
        case .laneRose: Pair(RGBA(0xB04A75), RGBA(0xE08AAE))
        case .mergeGreen: mergeGreen
        case .mergeHalo: faint(mergeGreen, 0x47)
        case .mergeText: Pair(RGBA(0x12873B), RGBA(0x5FD98A))
        case .openText: openGreen
        case .openChipFace: faint(openGreen, 0x1A)
        case .openChipEdge: faint(openGreen, 0x38)
        case .mergedText: purple
        case .mergedChipFace: faint(purple, 0x1A)
        case .mergedChipEdge: faint(purple, 0x38)
        // A chip in the wait's colour: the hue at 0x1A over the card, made
        // solid so its words clear 4.5:1 on any ground; its edge at 0x38.
        case .clayChipFace: solid(clay, 0x1A, over: cardFace)
        case .clayChipEdge: faint(clay, 0x38)
        case .amberChipFace: solid(amber, 0x1A, over: cardFace)
        case .amberChipEdge: faint(amber, 0x38)
        // A waiting card's edge, the hue at 0x73 (0.45); a waiting dense
        // row's face, the hue at 0x29 (0.16).
        case .clayCardEdge: faint(clay, 0x73)
        case .amberCardEdge: faint(amber, 0x73)
        case .clayWash: faint(clay, 0x29)
        case .amberWash: faint(amber, 0x29)
        }
    }

    private static func pair(_ own: Own) -> Pair {
        switch own {
        case .panelGround: Pair(RGBA(0xFAF9F5), RGBA(0x262624))
        case .tertiary: Pair(RGBA(0x73726C), RGBA(0x9C9A92))
        case .grey: Pair(RGBA(0xA09E95), RGBA(0x77756D))
        case .badge: secondary
        case .onBadge: Pair(RGBA(0xFFFFFF), RGBA(0x1F1E1D))
        case .lift: Pair(RGBA(0x000000, 0x2E), RGBA(0x000000, 0x66))
        case .card: cardFace
        case .readyEdge: faint(green, 0x47)
        case .onFill: Pair(RGBA(0xFFFFFF), RGBA(0xFFFFFF))
        case .cardHover: Pair(RGBA(0xF7F6F2), RGBA(0x383835))
        case .hover: Pair(RGBA(0x7F7F7F, 0x14), RGBA(0x7F7F7F, 0x24))
        case .readyBg: faint(green, 0x1F)
        case .dropTarget: faint(text, 0x1F)
        case .zoneLit: Pair(RGBA(0xE7E4D9), RGBA(0x3A3935))
        case .filterEdge: blue
        }
    }

    static func rgba(_ token: Token, dark: Bool) -> RGBA {
        let p = pair(token)
        return dark ? p.dark : p.light
    }

    static func rgba(_ own: Own, dark: Bool) -> RGBA {
        let p = pair(own)
        return dark ? p.dark : p.light
    }
}
