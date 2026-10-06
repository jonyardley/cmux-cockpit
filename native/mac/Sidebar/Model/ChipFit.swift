import Foundation

/// Which chips show on a line, each whole: the pane's fit_ranked
/// (native/pane/src/text.rs) in points rather than cells. Every chip when
/// all fit; else the ones that give way (a long branch) go first, then
/// chips drop from the end, and an ellipsis takes the place of the rest.
/// A chip is never cut. The view lets ViewThatFits pick from
/// `candidates`; the test holds the same rule by width (ChipFit.fit).
enum ChipFit {
    /// The lines a card may draw its chips as, widest first, as indices
    /// into `givesWay`: every chip; then, with an ellipsis after, the
    /// chips that do not give way, dropping from the end down to none. A
    /// view draws the first that fits. When no chip gives way, every chip
    /// with an ellipsis could never fit where every chip did not, so that
    /// line is left out.
    static func candidates(givesWay: [Bool]) -> [[Int]] {
        let keep = givesWay.indices.filter { !givesWay[$0] }
        let longest = keep.count == givesWay.count ? keep.count - 1 : keep.count
        guard longest >= 0 else { return [[]] }
        return [Array(givesWay.indices)] + (0...longest).reversed().map { Array(keep.prefix($0)) }
    }
}
