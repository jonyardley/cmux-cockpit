import Foundation

/// A workspace Jon clicked whose selection the next panel.json has not
/// shown yet. The click goes straight to cmux, past the core, so nothing
/// on the panel says it happened until cmux publishes the change and
/// cockpit-publish writes it out. Until then the clicked one draws as
/// selected and nothing else does. A select cmux refuses or never
/// publishes lapses after `lasts`, as the TypeScript sidebar's tap
/// override does (src/cockpit/state.ts).
struct PendingSelect: Equatable {
    /// How long a click is drawn before the panel must show it.
    static let lasts = PendingMove.lasts

    let id: String
    /// What the panel had selected when Jon clicked.
    let was: Set<String>

    /// What a fresh panel makes of the click.
    enum Outcome: Equatable {
        /// The panel has not moved yet: keep drawing the click.
        case waiting
        /// The panel shows the clicked one selected.
        case shown
        /// The panel shows some other selection (Next, or a switch in cmux
        /// itself), which is newer than the click.
        case movedOn
    }

    /// The click on `id` while the panel has `selected` selected, or nil
    /// when it already is, so there is nothing to wait for.
    static func clicked(_ id: String, selected: Set<String>) -> PendingSelect? {
        selected.contains(id) ? nil : PendingSelect(id: id, was: selected)
    }

    /// Whether the workspace `id`, which panel.json has as `selected` or
    /// not, draws selected: while a click waits, the clicked one alone.
    static func shows(_ id: String, selected: Bool, pending: PendingSelect?) -> Bool {
        pending.map { $0.id == id } ?? selected
    }

    /// The workspaces `panel` draws as selected: cards in the lanes and in
    /// the Projects view, and the lanes' anchors. One in a folded lane or
    /// project is not drawn, so it is not here.
    static func selected(in panel: Panel) -> Set<String> {
        var ids = Set<String>()
        for lane in panel.lanes {
            if let anchor = lane.anchor, anchor.selected { ids.insert(anchor.id) }
            for case .card(let card) in lane.rows where card.selected { ids.insert(card.wsId) }
        }
        for case .card(let card) in panel.projects where card.selected { ids.insert(card.wsId) }
        return ids
    }

    /// The click against a fresh panel with `selected` selected. A panel
    /// with nothing drawn selected says nothing either way: the clicked one
    /// may sit in a folded lane, or cmux may be between the two.
    func outcome(_ selected: Set<String>) -> Outcome {
        if selected.contains(id) { return .shown }
        return selected.isEmpty || selected == was ? .waiting : .movedOn
    }
}
