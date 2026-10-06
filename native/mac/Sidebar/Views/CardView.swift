import SwiftUI

/// A workspace's card: its dot and title with the status on the right,
/// the chips, where you left off, then the detail.
struct CardView: View {
    let card: Card

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.icon.glyph).foregroundStyle(Color(dot: card.icon.ink))
                Text(card.title)
                    .foregroundStyle(Color(Token.text))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Spacer(minLength: 6)
                if !card.status.isEmpty {
                    Text(card.status)
                        .foregroundStyle(Color(card.statusInk))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                if !card.chips.isEmpty || !card.merged.isEmpty {
                    CardChips(chips: card.chips, merged: card.merged)
                }
                if !card.leftOff.isEmpty {
                    Text(card.leftOff)
                        .foregroundStyle(Color(Palette.Own.tertiary))
                        .lineLimit(1)
                }
                if !card.detail.isEmpty {
                    Text(card.detail)
                        .foregroundStyle(Color(Token.secondary))
                        .lineLimit(CardText.detailLines(card))
                }
            }
            .padding(.leading, Metrics.cardIndent)
        }
        .font(.system(size: Metrics.body))
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(Palette.Own.cardFace), in: .rect(cornerRadius: Metrics.corner))
        .overlay(RoundedRectangle(cornerRadius: Metrics.corner).strokeBorder(Color(Token.cardEdge)))
        .opacity(card.dimmed ? 0.55 : 1)
    }
}

/// Where a card waiting in Needs you would sit: faint, one line.
struct GhostRow: View {
    let title: String
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Text(Words.ghost)
            Text(CardText.ghost(title: title, text: text)).lineLimit(1).truncationMode(.tail)
        }
        .font(.system(size: Metrics.body))
        .foregroundStyle(Color(Token.faint))
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A lane's row, card or placeholder.
struct RowView: View {
    let row: Row

    var body: some View {
        switch row {
        case .card(let card): CardView(card: card)
        case .ghost(_, let title, let text, _): GhostRow(title: title, text: text)
        }
    }
}
