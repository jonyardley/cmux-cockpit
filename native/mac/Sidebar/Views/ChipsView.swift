import SwiftUI

/// The quiet chip's look (shared/pr-colors.ts NEUTRAL_CHIP, ui.ts
/// chipFrame): words at the meta size on the chip face, inside a 1pt edge
/// with 6pt corners.
enum ChipLook {
    static let padH: CGFloat = 6
    static let padV: CGFloat = 1
    /// Between a chip's glyph, its words and its dirty dot.
    static let inner: CGFloat = 4
    /// The PR and branch glyphs.
    static let glyph: CGFloat = 9
    /// The dot after a branch with uncommitted changes.
    static let dirty: CGFloat = 5
    /// Between chips on a line, and between the lines.
    static let gap: CGFloat = 5
    static let lineGap: CGFloat = 4
}

extension View {
    /// A chip's frame (ui.ts chipFrame): the padding, the face, the 6pt
    /// corners and the chip edge, shared by the quiet chips and the action
    /// buttons so the two never drift apart.
    func chipFrame(_ face: some View, padH: CGFloat = ChipLook.padH) -> some View {
        padding(.horizontal, padH)
            .padding(.vertical, ChipLook.padV)
            .background(face)
            .clipShape(.rect(cornerRadius: Metrics.Radius.chip))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.Radius.chip)
                    .strokeBorder(Color(Token.chipEdge), lineWidth: Metrics.hairline)
            )
    }
}

/// One chip, as the cockpit draws its kind (parts.ts chips): the size in
/// its state's ink; the PR with its glyph, its number in medium and its
/// state in its health's ink; the branch with its glyph and a dot when it
/// has uncommitted changes; a port; the diff size unframed and faint
/// beside its PR; an action as a white button. A chip with somewhere to
/// go opens it on a tap and steps darker under the pointer, the PR's
/// glyph turning to an arrow out; the rest leave the tap to the card.
struct ChipView: View {
    let chip: Chip
    let id: String
    /// Whether a PR chip opens its PR; false on the full card (issue #72).
    var prOpens = true
    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        switch chip.kind {
        case .diff:
            words(chip.pieces, weight: .regular)
        case .action:
            ActionChip(chip: chip, id: id)
        default:
            framed
        }
    }

    @ViewBuilder private var framed: some View {
        let face = HStack(spacing: ChipLook.inner) { inside }
            .lineLimit(1)
            .chipFrame(Color(Token.chipFace).overlay { if lit { Color(Palette.Own.hover) } })
        if case .open(let url) = tap {
            face
                .contentShape(.rect)
                .onHover { hovering = $0 }
                .onTapGesture { openURL(url) }
                .help(url.absoluteString)
        } else {
            face
        }
    }

    private var tap: ChipTap { ChipTap.of(chip, id: id, prOpens: prOpens) }

    /// Under the pointer, and a chip that opens: a hover left over from
    /// before the chip went still (its link gone, or another chip now at
    /// its place) draws nothing.
    private var lit: Bool {
        guard hovering, case .open = tap else { return false }
        return true
    }

    @ViewBuilder private var inside: some View {
        switch chip.kind {
        case .pr:
            glyph(lit ? "arrow.up.right" : "arrow.triangle.pull")
            if let tag = chip.pieces.first { piece(tag, weight: .medium) }
            ForEach(Array(chip.pieces.dropFirst().enumerated()), id: \.offset) { piece($0.element, weight: .regular) }
        case .branch:
            let branch = ChipFit.branch(chip)
            glyph("arrow.branch")
            words(branch.pieces, weight: .medium).truncationMode(.middle)
            if branch.dirty {
                Circle().fill(Color(Token.secondary)).frame(width: ChipLook.dirty, height: ChipLook.dirty)
            }
        case .port:
            words(chip.pieces, weight: .medium).monospaced()
        default:
            words(chip.pieces, weight: .medium)
        }
    }

    private func glyph(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: ChipLook.glyph, weight: .semibold))
            .foregroundStyle(Color(Token.secondary))
    }

    private func piece(_ p: Piece, weight: Font.Weight) -> some View {
        Text(p.text)
            .font(.system(size: Metrics.Font.meta, weight: weight))
            .foregroundStyle(Color(p.ink))
            .lineLimit(1)
            .fixedSize()
    }

    /// Pieces a space apart, each in its own ink.
    private func words(_ pieces: [Piece], weight: Font.Weight) -> some View {
        pieces.enumerated().reduce(Text("")) { line, item in
            let piece = Text(item.element.text).foregroundStyle(Color(item.element.ink))
            return item.offset == 0 ? piece : line + Text(" ") + piece
        }
        .font(.system(size: Metrics.Font.meta, weight: weight))
        .lineLimit(1)
    }
}

/// A card's chips row (parts.ts chipsRow): the size, the PR and its diff,
/// then the branch, the ports and the actions, with a merged card's Park
/// and Close at the end. On one line when it all fits; else the branch's
/// line goes under the PR's, Park and Close with it while they fit and on
/// a line of their own when they do not, so nothing is cut while it can be
/// whole. Only where a line alone is too wide does the diff size give way,
/// then the branch name, cut in the middle.
struct ChipsRow: View {
    let card: Card
    /// Whether the PR chip opens its PR (parts.ts PrTap): the Projects
    /// card's does; the full card's stays still (issue #72).
    var prOpens = true

    var body: some View {
        let lines = ChipLines(card.chips)
        let merged = card.merged
        ViewThatFits(in: .horizontal) {
            line(lines.pr + lines.branch + merged).fixedSize()
            VStack(alignment: .leading, spacing: ChipLook.lineGap) {
                if !lines.pr.isEmpty { line(lines.pr).fixedSize() }
                line(lines.branch + merged).fixedSize()
            }
            VStack(alignment: .leading, spacing: ChipLook.lineGap) {
                if !lines.pr.isEmpty { line(lines.pr) }
                if !lines.branch.isEmpty { line(lines.branch) }
                if !merged.isEmpty { line(merged) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Whether a card has a chips row to draw at all.
    static func shows(_ card: Card) -> Bool {
        !card.chips.isEmpty || !card.merged.isEmpty
    }

    private func line(_ chips: [Chip]) -> some View {
        HStack(spacing: ChipLook.gap) {
            ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in
                ChipView(chip: chip, id: card.wsId, prOpens: prOpens)
                    // The diff goes first, then the branch; the rest hold.
                    .layoutPriority(chip.kind == .diff ? -1 : chip.kind == .branch ? 0 : 2)
            }
        }
    }
}
