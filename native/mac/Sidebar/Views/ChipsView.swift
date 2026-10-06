import SwiftUI

/// One chip: its pieces in their inks, a space apart, on the quiet face.
struct ChipView: View {
    let chip: Chip

    var body: some View {
        chip.pieces.enumerated().reduce(Text("")) { line, item in
            let piece = Text(item.element.text).foregroundStyle(Color(item.element.ink))
            return item.offset == 0 ? piece : line + Text(" ") + piece
        }
        .font(.system(size: Metrics.small))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(Color(Token.chipFace), in: .rect(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(Token.chipEdge)))
    }
}

/// Chips on one line, each whole, never cut: every chip if they fit, else
/// the first of ChipFit's candidates that does, an ellipsis after it.
struct ChipsLine: View {
    let chips: [Chip]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Array(ChipFit.candidates(givesWay: chips.map(\.givesWay)).enumerated()), id: \.offset) { n, shown in
                HStack(spacing: Metrics.chipGap) {
                    ForEach(shown, id: \.self) { ChipView(chip: chips[$0]) }
                    if n > 0 {
                        Text(Words.ellipsis).foregroundStyle(Color(Token.faint))
                    }
                }
                .fixedSize()
            }
        }
    }
}

/// A card's chips, then Park and Close: on the same line while every chip
/// fits whole, else on a line of their own, so neither is ever cut.
struct CardChips: View {
    let chips: [Chip]
    let merged: [Chip]

    var body: some View {
        if merged.isEmpty {
            ChipsLine(chips: chips)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.chipGap) {
                    ForEach(Array((chips + merged).enumerated()), id: \.offset) { ChipView(chip: $0.element) }
                }
                .fixedSize()
                VStack(alignment: .leading, spacing: 3) {
                    if !chips.isEmpty { ChipsLine(chips: chips) }
                    ChipsLine(chips: merged)
                }
            }
        }
    }
}
