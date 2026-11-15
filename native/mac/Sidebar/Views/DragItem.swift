import Foundation
import UniformTypeIdentifiers

/// What a card's drag carries: its workspace, under a type of our own and
/// nothing else. A terminal or another app takes text, links and files, so
/// it turns this drop away rather than typing the card's id; only the
/// lanes, which ask for this type, take it.
///
/// A drop reads the lifted card from DragState, not this, so a drag from
/// another app (with nothing lifted) is turned away by validateDrop; a late
/// drop, after the release watch, checks this against the card let go of.
enum DragItem {
    /// Declared in Sidebar/Info.plist. Plain data, never text, so nothing
    /// that takes text sees a match.
    static let type = UTType(exportedAs: "dev.jonyardley.cockpit.card", conformingTo: .data)

    static func text(_ card: Card) -> String { "cockpit-card:" + card.wsId }

    /// Seen by every process, not only ours: the drag reaches the lanes
    /// through cmux, which hosts this extension. The type is what keeps
    /// other drop targets out.
    static func provider(_ card: Card) -> NSItemProvider {
        let data = Data(text(card).utf8)
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
            done(data, nil)
            return nil
        }
        return provider
    }

    /// The card a drop carries, or nil when it carries none of our type.
    @MainActor static func read(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                done.resume(returning: data.flatMap { String(data: $0, encoding: .utf8) })
            }
        }
    }
}
