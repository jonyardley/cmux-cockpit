import Foundation

/// A workspace Jon clicked whose selection the next panel.json has not
/// shown yet. The click goes straight to cmux, past the core, so nothing
/// on the panel says it happened until cmux publishes the change and
/// cockpit-publish writes it out. Until then the clicked one draws as
/// selected and nothing else does. A select cmux refuses or never
/// publishes lapses at `until`, as the TypeScript sidebar's tap override
/// does (src/cockpit/state.ts).
struct PendingSelect: Equatable {
    /// How long a click is drawn before the panel must show it.
    static let lasts = PendingMove.lasts

    let id: String
    let until: Date

    /// Whether the workspace `id`, which panel.json has as `selected` or
    /// not, draws selected: while a click waits, the clicked one alone.
    static func shows(_ id: String, selected: Bool, pending: PendingSelect?) -> Bool {
        pending.map { $0.id == id } ?? selected
    }

    /// The workspaces `panel` draws as selected: cards in the lanes and in
    /// the Projects view, and the lanes' anchors.
    static func selected(in panel: Panel) -> Set<String> {
        var ids = Set<String>()
        for lane in panel.lanes {
            if let anchor = lane.anchor, anchor.selected { ids.insert(anchor.id) }
            for case .card(let card) in lane.rows where card.selected { ids.insert(card.wsId) }
        }
        for case .card(let card) in panel.projects where card.selected { ids.insert(card.wsId) }
        return ids
    }

    /// Whether `panel` shows this click done.
    func confirmed(by panel: Panel) -> Bool {
        Self.selected(in: panel).contains(id)
    }

    /// Whether the click is still drawn at `now`.
    func live(at now: Date) -> Bool {
        until > now
    }
}
