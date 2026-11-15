import SwiftUI

// The Ostinato run on its workspace's card (docs/design.md#ostinato-run),
// under the card's own lines: the core says every word and token
// (native/core/src/ostinato/card.rs), and this lays them out.

/// The run section's sizes (docs/design.md#ostinato-run).
private enum RunLook {
    /// Between its lines, and above the section.
    static let column: CGFloat = 5
    static let top: CGFloat = 4
    /// The status dot.
    static let dot: CGFloat = 6
    /// A strip step's and a gauge bar's height, and the gap between steps.
    static let bar: CGFloat = 4
    static let stepGap: CGFloat = 3
    /// Between a gauge's label, bar and words, and between gauges.
    static let gaugeGap: CGFloat = 8
    static let gaugeRow: CGFloat = 4
    /// Between the rows of items, and the question's padding.
    static let rowGap: CGFloat = 3
    static let questionPadH: CGFloat = 7
    static let questionPadV: CGFloat = 5
}

/// The run: its title, status, item, strip, gauges, chips, rows, the
/// park's question and a broken line's notice, each only when it has
/// something to say.
struct RunSection: View {
    let run: RunCard

    var body: some View {
        VStack(alignment: .leading, spacing: RunLook.column) {
            // Each minute, so an ended run's day moves on at midnight
            // with nothing else on the card changing.
            TimelineView(.everyMinute) { context in
                Text(RunText.title(run, now: context.date))
                    .font(.system(size: Metrics.Font.control, weight: .semibold))
                    .foregroundStyle(Color(run.titleInk))
                    .lineLimit(1)
            }
            if !run.status.isEmpty { status }
            if !run.item.isEmpty { RunItem(text: run.item, url: run.url) }
            if let strip = run.strip { StripView(strip: strip) }
            if !run.gauges.isEmpty { gauges }
            if !run.chips.isEmpty { chips }
            if !run.rows.isEmpty { rows }
            if !run.question.isEmpty {
                Text(run.question)
                    .font(.system(size: Metrics.Font.meta))
                    .foregroundStyle(Color(Token.secondary))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, RunLook.questionPadH)
                    .padding(.vertical, RunLook.questionPadV)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(run.questionFace), in: .rect(cornerRadius: Metrics.Radius.chip))
            }
            if !run.error.isEmpty {
                Text(run.error)
                    .font(.system(size: Metrics.Font.meta))
                    .foregroundStyle(Color(run.errorInk))
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, RunLook.top)
    }

    private var status: some View {
        HStack(spacing: Metrics.inlineGap) {
            if run.dot != .clear {
                Circle().fill(Color(run.dot)).frame(width: RunLook.dot, height: RunLook.dot)
            }
            ForEach(Array(run.status.enumerated()), id: \.offset) { _, piece in
                Text(piece.text)
                    .font(.system(size: Metrics.Font.meta, weight: piece.ink == .blueText ? .medium : .regular))
                    .foregroundStyle(Color(piece.ink))
                    .lineLimit(1)
            }
        }
    }

    private var gauges: some View {
        Grid(alignment: .leading, horizontalSpacing: RunLook.gaugeGap, verticalSpacing: RunLook.gaugeRow) {
            ForEach(Array(run.gauges.enumerated()), id: \.offset) { _, gauge in
                GridRow {
                    Text(gauge.label)
                    if let fraction = gauge.fraction {
                        Bar(fraction: fraction, fill: gauge.fill, track: gauge.track)
                    } else {
                        Color.clear.frame(height: RunLook.bar)
                    }
                    Text(gauge.text).monospacedDigit().gridColumnAlignment(.trailing)
                }
                .font(.system(size: Metrics.Font.meta))
                .foregroundStyle(Color(gauge.ink))
                .lineLimit(1)
            }
        }
    }

    private var chips: some View {
        HStack(spacing: ChipLook.gap) {
            ForEach(Array(run.chips.enumerated()), id: \.offset) { _, chip in
                Text(chip.text)
                    .font(.system(size: Metrics.Font.meta, weight: .medium))
                    .foregroundStyle(Color(chip.ink))
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
                    .chipFrame(Color(chip.face), edge: chip.edge)
            }
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: RunLook.rowGap) {
            ForEach(Array(run.rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: Metrics.inlineGap) {
                    Text(row.item).foregroundStyle(Color(Token.text)).lineLimit(1)
                    Spacer(minLength: Metrics.inlineGap)
                    Text(row.outcome).foregroundStyle(Color(row.ink)).lineLimit(1).truncationMode(.middle)
                }
                .font(.system(size: Metrics.Font.meta))
            }
        }
    }
}

/// The item and its attempt; a tap opens its issue when the record gives
/// one.
private struct RunItem: View {
    let text: String
    let url: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        let words = Text(text)
            .font(.system(size: Metrics.Font.control))
            .foregroundStyle(Color(Token.secondary))
            .lineLimit(1)
        if let link = url.flatMap(URL.init(string:)) {
            words.contentShape(.rect).onTapGesture { openURL(link) }.help(link.absoluteString)
        } else {
            words
        }
    }
}

/// The five-step strip: a bar per step, the done ones filled, the steps'
/// names under it.
private struct StripView: View {
    let strip: Strip

    var body: some View {
        VStack(alignment: .leading, spacing: RunLook.stepGap) {
            HStack(spacing: RunLook.stepGap) {
                ForEach(Array(strip.names.enumerated()), id: \.offset) { i, _ in
                    Capsule()
                        .fill(Color(UInt64(i) < strip.done ? strip.fill : strip.track))
                        .frame(height: RunLook.bar)
                        .frame(maxWidth: .infinity)
                }
            }
            HStack(spacing: 0) {
                ForEach(Array(strip.names.enumerated()), id: \.offset) { i, name in
                    Text(name)
                        .frame(maxWidth: .infinity, alignment: i == 0 ? .leading : i == strip.names.count - 1 ? .trailing : .center)
                }
            }
            .font(.system(size: Metrics.Font.tiny))
            .foregroundStyle(Color(strip.ink))
            .lineLimit(1)
        }
    }
}

/// A gauge's bar: the track, filled to `fraction` from the leading end.
private struct Bar: View {
    let fraction: Double
    let fill: Token
    let track: Token

    var body: some View {
        Capsule()
            .fill(Color(track))
            .frame(height: RunLook.bar)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Capsule().fill(Color(fill)).frame(width: geo.size.width * fraction)
                }
            }
            .frame(maxWidth: .infinity)
    }
}
