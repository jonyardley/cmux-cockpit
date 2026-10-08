import SwiftUI

// A workspace's card at each of the cockpit's shapes (src/cockpit/views
// cards.ts): full, compact and row in All, by the density the core gives
// its lane, and the one shape every Projects card takes. A click switches
// to it and a right-click shows its menu (Actions.swift).

/// The cockpit's card sizes, named for what draws with them.
private enum CardLook {
    /// A full card: the badge, its gap, the padding round it.
    static let fullBadge: CGFloat = 26
    static let fullBadgeFont: CGFloat = 12
    static let fullBadgeRadius: CGFloat = 8
    static let fullGap: CGFloat = 10
    /// A compact card's.
    static let compactBadge: CGFloat = 22
    static let compactBadgeFont: CGFloat = 11
    static let compactBadgeRadius: CGFloat = 7
    static let compactGap: CGFloat = 9
    /// A card's padding: in from the leading edge, the trailing, and above
    /// and below.
    static let padLeading: CGFloat = 10
    static let padTrailing: CGFloat = 12
    static let padV: CGFloat = 11
    /// A row's: its badge, and in from the edge so its dot sits under a
    /// lane header's marker.
    static let rowBadge: CGFloat = 14
    static let rowBadgeFont: CGFloat = 8
    static let rowBadgeRadius: CGFloat = 4
    static let rowPadLeading: CGFloat = 25
    static let rowPadV: CGFloat = 5
    /// A row's lines under its title start where the title does: past the
    /// haloed dot (7pt and its 3pt halo each side), the badge and the gap
    /// after each.
    static let rowIndent: CGFloat = 7 + 6 + 6 + rowBadge + 6
    /// A Projects card's padding, and the gap above its chips.
    static let projectPad: CGFloat = 10
    static let projectGap: CGFloat = 5
    /// A row's title, and a full card's status words.
    static let rowTitle: CGFloat = 12.5
    static let compactStatus: CGFloat = 11.5
    /// The pin at the end of a pinned card's title row.
    static let pin: CGFloat = 9.5
    /// The progress bar's height.
    static let bar: CGFloat = 4
    /// A merged card while nothing in it wants Jon (merged.ts).
    static let dimmed: Double = 0.6
}

/// A lane's card at its lane's density.
struct LaneCard: View {
    let card: Card

    var body: some View {
        switch card.density {
        case .full: FullCard(card: card)
        case .compact: CompactCard(card: card)
        case .row: DenseRow(card: card)
        }
    }
}

/// The full card (cards.ts fullCard): the project's badge beside the title
/// row; the status on its own line; the chips; the detail over two lines;
/// the progress bar along the bottom.
struct FullCard: View {
    let card: Card

    var body: some View {
        HStack(alignment: .top, spacing: CardLook.fullGap) {
            BadgeTile(
                icon: card.badge.icon, color: card.badge.color, size: CardLook.fullBadge,
                font: CardLook.fullBadgeFont, radius: CardLook.fullBadgeRadius
            )
            VStack(alignment: .leading, spacing: 4) {
                TitleRow(card: card, size: Metrics.Font.cardTitle, lines: 2)
                StatusLine(card: card, dot: 7, size: Metrics.Font.control, weight: .medium)
                if ChipsRow.shows(card) { ChipsRow(card: card, prOpens: false) }
                Detail(text: card.detail, lines: CardText.detailLines(card))
                ProgressBar(card: card)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
        }
        .padding(.leading, CardLook.padLeading)
        .padding(.trailing, CardLook.padTrailing)
        .padding(.vertical, CardLook.padV)
        .cardChrome(card, radius: Metrics.Radius.card)
    }
}

/// The compact card (cards.ts compactCard): a smaller badge and title, the
/// PR in words on the status line with its diff size faint after it, the
/// detail on one line, and the actions on a line of their own.
struct CompactCard: View {
    let card: Card

    var body: some View {
        let lines = ChipLines(card.chips)
        HStack(spacing: CardLook.compactGap) {
            BadgeTile(
                icon: card.badge.icon, color: card.badge.color, size: CardLook.compactBadge,
                font: CardLook.compactBadgeFont, radius: CardLook.compactBadgeRadius
            )
            VStack(alignment: .leading, spacing: 3) {
                TitleRow(card: card, size: Metrics.Font.compactTitle, lines: 1)
                StatusLine(card: card, dot: 6, size: CardLook.compactStatus, weight: .regular, pr: lines.pr)
                LeftOff(text: card.leftOff)
                Detail(text: card.detail, lines: CardText.detailLines(card))
                if !lines.branch.isEmpty { ActionLine(chips: lines.branch, id: card.wsId) }
                if !card.merged.isEmpty { ActionLine(chips: card.merged, id: card.wsId) }
                ProgressBar(card: card)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
        }
        .padding(.leading, CardLook.padLeading)
        .padding(.trailing, CardLook.padTrailing)
        .padding(.vertical, CardLook.padV)
        .cardChrome(card, radius: Metrics.Radius.card)
    }
}

/// The row (cards.ts denseRow): dot, a small badge, the title, then the
/// unread count, the age and the pin; the detail on one line under the
/// title, and Park and Close under that. No face of its own until it is
/// selected.
struct DenseRow: View {
    let card: Card

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusDot(icon: card.icon, size: 7)
                BadgeTile(
                    icon: card.badge.icon, color: card.badge.color, size: CardLook.rowBadge,
                    font: CardLook.rowBadgeFont, radius: CardLook.rowBadgeRadius
                )
                Text(card.title)
                    .font(.system(size: CardLook.rowTitle, weight: card.selected ? .medium : .regular))
                    .foregroundStyle(Color(Token.text))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Spacer(minLength: 4)
                if !card.unread.isEmpty { UnreadBadge(count: card.unread) }
                if !card.age.isEmpty { MetaText(text: card.age, ink: Color(CardText.ageInk(card) ?? .metaText)) }
                if card.pinned { PinMark() }
            }
            LeftOff(text: card.leftOff).padding(.leading, CardLook.rowIndent)
            Detail(text: card.detail, lines: CardText.detailLines(card), ink: card.detailInk)
                .padding(.leading, CardLook.rowIndent)
            if !card.merged.isEmpty {
                ActionLine(chips: card.merged, id: card.wsId)
                    .padding(.leading, CardLook.rowIndent)
                    .padding(.top, 3)
            }
        }
        .padding(.leading, CardLook.rowPadLeading)
        .padding(.trailing, CardLook.padTrailing)
        .padding(.vertical, CardLook.rowPadV)
        .cardChrome(card, radius: Metrics.Radius.row, quiet: true)
    }
}

/// A Projects card (cards.ts projectRow): no badge, as the project's
/// header carries it; the title and its pills, the status on its own
/// line, the detail, then the chips, whose PR and ports open on a tap.
struct CardView: View {
    let card: Card

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TitleRow(card: card, size: CardLook.rowTitle, lines: 2)
            StatusLine(card: card, dot: 7, size: Metrics.Font.control, weight: .medium)
                .padding(.top, 2)
            Detail(text: card.detail, lines: CardText.detailLines(card)).padding(.top, card.detail.isEmpty ? 0 : 3)
            if ChipsRow.shows(card) {
                ChipsRow(card: card).padding(.top, CardLook.projectGap)
            }
            ProgressBar(card: card).padding(.top, card.progress == nil ? 0 : CardLook.projectGap)
        }
        .padding(CardLook.projectPad)
        .cardChrome(card, radius: Metrics.Radius.row)
    }
}

// MARK: The card's parts (parts.ts)

/// The title, then at its end the Ready pill, the unread count, the age
/// (only while the status line has none) and the pin. The title takes the
/// slack; over two lines the rest sit by its first.
struct TitleRow: View {
    let card: Card
    let size: CGFloat
    let lines: Int

    var body: some View {
        HStack(alignment: lines > 1 ? .top : .center, spacing: 6) {
            Text(card.title)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(Color(Token.text))
                .lineLimit(lines)
                // One line keeps both ends; over more the end is cut.
                .truncationMode(lines > 1 ? .tail : .middle)
                .layoutPriority(1)
            Spacer(minLength: 4)
            if card.ready { ReadyPill() }
            if !card.unread.isEmpty { UnreadBadge(count: card.unread) }
            let age = CardText.titleAge(card)
            if !age.isEmpty { MetaText(text: age, ink: ageInk) }
            if card.pinned { PinMark() }
        }
        .frame(maxWidth: .infinity)
    }

    /// The waiting ink while the card waits on Jon, else the third ink.
    private var ageInk: Color {
        CardText.ageInk(card).map { Color($0) } ?? Color(Palette.Own.tertiary)
    }
}

/// The status line: the haloed dot, the status and its age, the live
/// helpers; on a compact card the PR in words and its diff size after.
struct StatusLine: View {
    let card: Card
    let dot: CGFloat
    let size: CGFloat
    let weight: Font.Weight
    var pr: [Chip] = []

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(icon: card.icon, size: dot)
            if !card.status.isEmpty {
                Text(card.status)
                    .font(.system(size: size, weight: weight))
                    .foregroundStyle(Color(card.statusInk))
                    .lineLimit(1)
                    .layoutPriority(2)
            }
            if !card.helpers.isEmpty {
                Text(card.helpers)
                    .font(.system(size: size))
                    .foregroundStyle(Color(Palette.Own.tertiary))
                    .lineLimit(1)
                    .layoutPriority(2)
            }
            // The PR's words give way to the status; the diff goes first.
            ForEach(Array(pr.enumerated()), id: \.offset) { _, chip in
                Text(CardText.chip(chip))
                    .font(.system(size: size))
                    .foregroundStyle(Color(chip.pieces.first?.ink ?? .secondary))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(chip.kind == .diff ? -1 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A status dot over its soft halo (ui.ts haloDot): filled, or hollow in
/// its ring's colour. The frame is always the halo's, so dots with and
/// without one line up down a lane.
struct StatusDot: View {
    let icon: Icon
    let size: CGFloat

    /// The halo's size round a dot: 3pt of soft colour each side.
    nonisolated static func frame(_ size: CGFloat) -> CGFloat { size + 6 }

    var body: some View {
        ZStack {
            Circle().fill(Color(CardText.halo(icon)))
            if icon.glyph == CardText.filledDot {
                Circle().fill(Color(dot: icon.ink)).frame(width: size, height: size)
            } else {
                Circle().strokeBorder(Color(dot: icon.ink), lineWidth: 1.5).frame(width: size, height: size)
            }
        }
        .frame(width: Self.frame(size), height: Self.frame(size))
    }
}

/// Ready: the agent finished while Jon was elsewhere (parts.ts readyPill).
struct ReadyPill: View {
    var body: some View {
        Text(CardText.ready)
            .font(.system(size: Metrics.Font.section, weight: .medium))
            .foregroundStyle(Color(Token.greenText))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Color(Palette.Own.readyBg), in: .rect(cornerRadius: 8))
    }
}

/// The unread count, grey on both sides so clay only ever means needs you.
struct UnreadBadge: View {
    let count: String

    var body: some View {
        Text(count)
            .font(.system(size: Metrics.Font.tiny, weight: .bold))
            .foregroundStyle(Color(Palette.Own.onBadge))
            .fixedSize()
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color(Palette.Own.badge), in: .rect(cornerRadius: Metrics.Radius.tab))
    }
}

/// Trailing metadata, an age: monospaced so digits hold still, never cut.
struct MetaText: View {
    let text: String
    let ink: Color

    var body: some View {
        Text(text)
            .font(.system(size: Metrics.Font.meta).monospaced())
            .foregroundStyle(ink)
            .lineLimit(1)
            .fixedSize()
    }
}

/// The faint pin on a pinned card: a property, not a control.
struct PinMark: View {
    var body: some View {
        Image(systemName: "pin.fill")
            .font(.system(size: CardLook.pin))
            .foregroundStyle(Color(Token.faint))
    }
}

/// Jon's last prompt, in the third ink, on cards in lanes he comes back to.
struct LeftOff: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.system(size: Metrics.Font.control))
                .foregroundStyle(Color(Palette.Own.tertiary))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The latest message, or what the waiting chat wants.
struct Detail: View {
    let text: String
    let lines: Int
    /// The core's ink: the waiting ink on a waiting row's reason.
    var ink: Token = .secondary

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.system(size: Metrics.Font.control))
                .foregroundStyle(Color(ink))
                .lineLimit(lines)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Along the bottom while the workspace sends a progress value.
struct ProgressBar: View {
    let card: Card

    var body: some View {
        if let fraction = CardText.progress(card) {
            Capsule()
                .fill(Color(Token.countBg))
                .frame(height: CardLook.bar)
                .overlay(alignment: .leading) {
                    GeometryReader { geo in
                        Capsule().fill(Color(Token.blue)).frame(width: geo.size.width * fraction)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 2)
        }
    }
}

// MARK: The card's chrome

extension View {
    /// A card's face, edge, dimming, click and menu.
    func cardChrome(_ card: Card, radius: CGFloat, quiet: Bool = false) -> some View {
        modifier(CardChrome(card: card, radius: radius, quiet: quiet))
    }
}

/// A card's opaque white face with the hairline edge, or the select ink's
/// on cmux's selected workspace (status.ts outline); a step darker under
/// the pointer. A quiet row has no face or edge until it is selected, and
/// takes the hover wash. A merged card nothing in wants sits dimmed, at
/// full strength under the pointer. A card waiting on Jon carries a 4pt
/// leading edge in its clay or amber (issue #281), under the outline so
/// the selection still reads.
struct CardChrome: ViewModifier {
    let card: Card
    let radius: CGFloat
    let quiet: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(face, in: .rect(cornerRadius: radius))
            .overlay { WaitingEdge(card: card, radius: radius) }
            .overlay(Outline(selected: card.selected, radius: radius, rest: quiet ? .clear : .cardEdge))
            .opacity(card.dimmed && !hovering ? CardLook.dimmed : 1)
            .onHover { hovering = $0 }
            .cardActions(card)
    }

    private var face: Color {
        if quiet && !card.selected { return hovering ? Color(Palette.Own.hover) : .clear }
        return Color(hovering ? Palette.Own.cardHover : Palette.Own.card)
    }
}

/// The leading edge down a card waiting on Jon, clipped by the card's
/// rounded shape; nothing on any other card.
struct WaitingEdge: View {
    let card: Card
    let radius: CGFloat

    var body: some View {
        if let edge = CardText.edge(card) {
            HStack(spacing: 0) {
                Rectangle().fill(Color(edge)).frame(width: Metrics.waitingEdge)
                Spacer(minLength: 0)
            }
            .clipShape(.rect(cornerRadius: radius))
            .allowsHitTesting(false)
        }
    }
}

/// A card's edge: the select ink at 2pt on cmux's selected workspace, the
/// one open in the terminal, else the hairline (status.ts outline). A
/// click moves it at once: the core draws the clicked card selected
/// before cmux says so. Drawn inside the card, so the wider line moves
/// nothing.
struct Outline: View {
    let selected: Bool
    var radius: CGFloat = Metrics.Radius.card
    var rest: Token = .cardEdge

    var body: some View {
        RoundedRectangle(cornerRadius: radius)
            .strokeBorder(Color(selected ? Token.select : rest), lineWidth: selected ? 2 : 1)
    }
}

/// A lane's row: its card.
struct RowView: View {
    let row: Row

    var body: some View {
        switch row {
        case .card(let card): LaneCard(card: card)
        }
    }
}
