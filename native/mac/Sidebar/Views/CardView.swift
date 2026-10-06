import SwiftUI

/// A workspace's card: its dot and title with the status on the right,
/// the chips, where you left off, then the detail. A click switches to it
/// and a right-click shows its menu (Actions.swift).
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
                Spacer(minLength: 6)
                if !card.status.isEmpty {
                    // The pane fits the status first and gives the title
                    // what is left, so the status keeps its room here too.
                    Text(card.status)
                        .foregroundStyle(Color(card.statusInk))
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                if !card.chips.isEmpty || !card.merged.isEmpty {
                    ActionChips(id: card.wsId, chips: card.chips, merged: card.merged)
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
        .overlay(Outline(selected: SelectState.shared.shows(card.wsId, selected: card.selected)))
        .opacity(card.dimmed ? 0.55 : 1)
        .cardActions(card)
    }
}

/// A card's edge: the select ink at 2pt on cmux's selected workspace, the
/// one open in the terminal, else the hairline (status.ts outline). A
/// click moves it at once, before cmux says so (Select.swift). Drawn
/// inside the card, so the wider line moves nothing.
struct Outline: View {
    let selected: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: Metrics.corner)
            .strokeBorder(Color(selected ? Token.select : Token.cardEdge), lineWidth: selected ? 2 : 1)
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
