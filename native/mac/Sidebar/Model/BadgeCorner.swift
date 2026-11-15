import Foundation

/// A badge tile's corner, worked out from its side by one rule
/// (docs/design.md#badge-tile), so no badge carries its own radius. Here
/// in the model, not the views, so the views test pins it.
enum BadgeCorner {
    /// The corner as a share of the side, rounded.
    static let share = 0.3

    /// 0.3 of the side, rounded: 26 takes 8, 22 takes 7, 18 and 16 take 5,
    /// 14 takes 4 and 9 takes 3.
    static func radius(_ side: Double) -> Double {
        (side * share).rounded()
    }
}
