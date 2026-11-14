import Foundation

/// An Ostinato run card's words the shell adds to the core's
/// (docs/design.md#ostinato-run): the core has no time zone, so an ended
/// run's local time and day are written here.
enum RunText {
    /// The run's title: "Ostinato run ended 14:40", the end in `zone`'s
    /// time with its day as `ended` words it, for a run with an end line;
    /// the core's title as it is else.
    static func title(_ run: RunCard, zone: TimeZone = .current, now: Date = Date()) -> String {
        guard let at = run.endedAt else { return run.title }
        return run.title + " " + ended(Date(timeIntervalSince1970: at), zone: zone, now: now)
    }

    /// When a run ended, as `now` sees it in `zone`: "14:40" the same day,
    /// "yesterday 14:40" the day before, "Thu 14:40" up to six days
    /// before, and "12 Nov" before that, "12 Nov 2025" in another year.
    /// Days are `zone`'s calendar days, so 00:30 after an end at 23:30 is
    /// the next day. An end after `now` (a clock running ahead) reads as
    /// the same day. The words are fixed English, whatever the Mac's
    /// language: en_US_POSIX keeps "Sep" three letters where a locale's
    /// own data may write "Sept".
    static func ended(_ end: Date, zone: TimeZone, now: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        calendar.locale = Locale(identifier: "en_US_POSIX")
        let parts = calendar.dateComponents([.hour, .minute], from: end)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let endDay = calendar.startOfDay(for: end)
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: endDay, to: today).day ?? 0
        switch days {
        case ...0: return time
        case 1: return "yesterday " + time
        case 2...6: return format("EEE", end, calendar) + " " + time
        default:
            let sameYear = calendar.component(.year, from: end) == calendar.component(.year, from: now)
            return format(sameYear ? "d MMM" : "d MMM yyyy", end, calendar)
        }
    }

    /// `date` in `calendar`'s zone and locale, in the fixed `pattern`.
    private static func format(_ pattern: String, _ date: Date, _ calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = calendar.locale
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }

    /// The words the run draws, top to bottom, for the views check.
    static func words(_ run: RunCard, zone: TimeZone = .current, now: Date = Date()) -> [String] {
        var out = [title(run, zone: zone, now: now)]
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
