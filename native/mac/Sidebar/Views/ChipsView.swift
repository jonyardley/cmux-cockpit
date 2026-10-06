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
