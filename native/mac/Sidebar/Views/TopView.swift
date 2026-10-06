import SwiftUI

/// The view switch, as the core has it on. Showing only: switching goes
/// through outbox/ in R2.7.
struct ViewSwitch: View {
    let view: PanelView

    var body: some View {
        HStack(spacing: 2) {
            tab(Words.all, on: view == .all)
            tab(Words.projects, on: view == .projects)
        }
        .padding(2)
        .background(Color(Token.countBg), in: .rect(cornerRadius: Metrics.corner))
    }

    private func tab(_ label: String, on: Bool) -> some View {
        Text(label)
            .font(.system(size: Metrics.small, weight: on ? .semibold : .regular))
            .foregroundStyle(Color(on ? Token.text : Token.secondary))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
            .background(on ? Color(Palette.Own.ground) : .clear, in: .rect(cornerRadius: Metrics.corner - 2))
    }
}

/// Next: where the next press goes, and its place, or nothing waiting.
struct NextView: View {
    let next: NextLine

    var body: some View {
        let target = NextText.target(next)
        HStack(spacing: 6) {
            Text(Words.next).fontWeight(.semibold).foregroundStyle(Color(Token.heading))
            Text(target.title)
                .foregroundStyle(Color(NextText.isNothing(next) ? Token.faint : Token.text))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            Text(target.place).foregroundStyle(Color(Token.metaText))
        }
        .font(.system(size: Metrics.body))
    }
}

/// The Needs you strip: its count and oldest wait, each waiting session
/// and why, and how many more past the cap.
struct NeedsView: View {
    let needs: Needs

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(Words.needs).fontWeight(.semibold).foregroundStyle(Color(Token.clayText))
                CountPill(count: needs.count, colors: PillColors(bg: .clayCount, fg: .clayText))
                Spacer(minLength: 4)
                Text(needs.wait).foregroundStyle(Color(needs.late ? Token.clayText : Token.metaText))
            }
            ForEach(needs.rows, id: \.wsId) { row in
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(row.icon.glyph).foregroundStyle(Color(dot: row.icon.ink))
                        Text(row.title).foregroundStyle(Color(Token.text)).lineLimit(1)
                    }
                    Text(row.line)
                        .foregroundStyle(Color(row.ink))
                        .lineLimit(2)
                        .padding(.leading, Metrics.cardIndent)
                }
            }
            if !needs.more.isEmpty {
                Text(needs.more).foregroundStyle(Color(Token.metaText)).padding(.leading, Metrics.cardIndent)
            }
        }
        .font(.system(size: Metrics.body))
        .padding(8)
        .background(Color(Palette.Own.needsFace), in: .rect(cornerRadius: Metrics.corner))
    }
}
