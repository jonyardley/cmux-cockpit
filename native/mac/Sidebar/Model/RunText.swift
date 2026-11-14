import Foundation

/// An Ostinato run card's words the shell adds to the core's
/// (docs/design.md#ostinato-run): the core has no time zone, so an ended
/// run's local time is written here.
enum RunText {
    /// The run's title: "Ostinato run ended 14:40", the end in `zone`'s
    /// time, for a run with an end line; the core's title as it is else.
    static func title(_ run: RunCard, zone: TimeZone = .current) -> String {
        guard let at = run.endedAt else { return run.title }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: at))
        let hour = parts.hour ?? 0
        let minute = parts.minute ?? 0
        return run.title + " " + String(format: "%02d:%02d", hour, minute)
    }

    /// The words the run draws, top to bottom, for the views check.
    static func words(_ run: RunCard, zone: TimeZone = .current) -> [String] {
        var out = [title(run, zone: zone)]
        out += run.status.map(\.text)
        if !run.item.isEmpty { out.append(run.item) }
        out += run.strip?.names ?? []
        out += run.gauges.flatMap { [$0.label, $0.text] }
        out += run.chips.map(\.text)
        out += run.rows.flatMap { [$0.item, $0.outcome] }
        if !run.question.isEmpty { out.append(run.question) }
        if !run.error.isEmpty { out.append(run.error) }
        return out
    }
}
