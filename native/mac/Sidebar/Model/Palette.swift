import Foundation

/// A colour as the palette holds it: six hex digits and an alpha. A faint
/// token (a hue at an alpha) keeps its alpha here and is drawn over the
/// ground, rather than blended first as the terminal pane must.
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
/// literal in the extension lives here. The light side is the sidebars'
/// palette (src/shared/palette.ts, as native/pane/src/theme.rs maps it);
/// the dark side is this file's own, the same hues lifted for a dark
/// ground, as nothing else in the repo has one yet. Two exceptions: the
/// panel ground is cmux's window off-white, and a card's face is the
/// cockpit sidebar's card white (C.card in src/cockpit/theme.ts).
enum Palette {
    /// The colours the views use that no core token names.
    enum Own: CaseIterable {
        /// The pane's cream: the selected tab.
        case ground
        /// Under the whole panel (and behind a dragged card): cmux's own
        /// off-white, which the TS sidebar and the right sidebar sit on
        /// (sampled from a light-mode capture), so the panel matches the
        /// rest of the window. Dark is unsampled and stays the dark ground.
        case panelGround
        /// The Needs you strip's face.
        case needsFace
        /// A card's face: white on the panel ground, as the TS sidebar's cards.
        case cardFace
        /// The third ink: where you left off.
        case tertiary
        /// The outline of a dot with no colour of its own.
        case grey
        /// The unread badge's face, and its words.
        case badge
        case onBadge
        /// The shadow under a card being dragged.
        case lift
        /// A solid face: the chosen view tab, Next's pill.
        case card
        /// The edge round Next's pill and the Needs you strip.
        case needsEdge
        /// Next's pill and a Needs you row under the pointer.
        case needsHover
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
        /// A lane anchor's header badge while it is cmux's selected workspace.
        case anchorSelected
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
        case .amberRowEdge: faint(amberText, 0x29)
        case .needsRowEdge: faint(clayText, 0x29)
        case .cardEdge: faint(text, 0x1F)
        case .laneParked: Pair(RGBA(0xB0AEA5), RGBA(0x6E6C66))
        case .laneUnsorted: Pair(RGBA(0xC9C6BB), RGBA(0x57564F))
        }
    }

    private static func pair(_ own: Own) -> Pair {
        switch own {
        case .ground: Pair(RGBA(0xF4F2EA), RGBA(0x262624))
        case .panelGround: Pair(RGBA(0xFAF9F5), RGBA(0x262624))
        case .needsFace: Pair(RGBA(0xFBECE4), RGBA(clay.dark.hex, 0x1C))
        case .cardFace: Pair(RGBA(0xFFFFFF), RGBA(0x30302D, 0x99))
        case .tertiary: Pair(RGBA(0x73726C), RGBA(0x9C9A92))
        case .grey: Pair(RGBA(0xA09E95), RGBA(0x77756D))
        case .badge: secondary
        case .onBadge: Pair(RGBA(0xFFFFFF), RGBA(0x1F1E1D))
        case .lift: Pair(RGBA(0x000000, 0x2E), RGBA(0x000000, 0x66))
        case .card: Pair(RGBA(0xFFFFFF), RGBA(0x30302D))
        case .needsEdge: Pair(RGBA(0xF0D2C3), RGBA(clay.dark.hex, 0x47))
        case .needsHover: Pair(RGBA(0xFBF1EB), RGBA(0x3A3330))
        case .cardHover: Pair(RGBA(0xF7F6F2), RGBA(0x383835))
        case .hover: Pair(RGBA(0x7F7F7F, 0x14), RGBA(0x7F7F7F, 0x24))
        case .readyBg: faint(green, 0x1F)
        case .dropTarget, .anchorSelected: faint(text, 0x1F)
        case .zoneLit: Pair(RGBA(0xE7E4D9), RGBA(0x3A3935))
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
