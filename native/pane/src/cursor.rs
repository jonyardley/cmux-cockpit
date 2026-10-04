//! The card cursor: which card up and down have reached, held by workspace
//! id so a new frame that reorders the cards keeps it on the same one,
//! and how far the lanes scroll to keep that card in sight.

use std::ops::Range;

/// How many lines the body scrolls so the lines `focus` covers sit inside
/// `height`: none until the card would fall off the bottom, then just
/// enough, and never past the card's first line.
pub fn scroll_for(focus: Option<&Range<usize>>, height: usize) -> usize {
    match focus {
        Some(r) if r.end > height => (r.end - height).min(r.start),
        _ => 0,
    }
}

/// The cursor, on a card by its workspace id, or on none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor {
    on: Option<String>,
    /// Where it was in the list, so a card that leaves hands the cursor
    /// to the one that took its place.
    index: usize,
}

impl Cursor {
    /// The card it is on.
    pub fn on(&self) -> Option<&str> {
        self.on.as_deref()
    }

    /// Settles on a new frame's cards: the same card if it is still there,
    /// else the one now in its place, else none.
    pub fn settle(&mut self, cards: &[&str]) {
        if let Some(i) = self.on().and_then(|id| cards.iter().position(|c| *c == id)) {
            self.index = i;
            return;
        }
        if cards.is_empty() {
            self.on = None;
            self.index = 0;
            return;
        }
        let i = self.index.min(cards.len() - 1);
        if self.on.is_some() {
            self.on = cards.get(i).map(|c| (*c).to_string());
            self.index = i;
        }
    }

    /// Moves `step` cards down (up when negative), held at either end.
    /// The first move lands on the first card. True when it moved.
    pub fn step(&mut self, cards: &[&str], step: isize) -> bool {
        let Some(last) = cards.len().checked_sub(1) else {
            return false;
        };
        let next = match self.on() {
            None => 0,
            Some(_) => self.index.saturating_add_signed(step).min(last),
        };
        let target = cards.get(next).map(|c| (*c).to_string());
        if target.as_deref() == self.on() {
            return false;
        }
        self.on = target;
        self.index = next;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lands_on_the_first_card_on_the_first_move() {
        let mut c = Cursor::default();
        assert!(c.step(&["a", "b"], 1));
        assert_eq!(c.on(), Some("a"));
    }

    #[test]
    fn moves_down_and_up_and_stops_at_either_end() {
        let cards = ["a", "b", "c"];
        let mut c = Cursor::default();
        c.step(&cards, 1);
        assert!(c.step(&cards, 1));
        assert!(c.step(&cards, 1));
        assert_eq!(c.on(), Some("c"));
        assert!(!c.step(&cards, 1), "held at the bottom");
        assert!(c.step(&cards, -1));
        assert!(c.step(&cards, -1));
        assert!(!c.step(&cards, -1), "held at the top");
        assert_eq!(c.on(), Some("a"));
    }

    #[test]
    fn does_nothing_with_no_cards() {
        let mut c = Cursor::default();
        assert!(!c.step(&[], 1));
        assert_eq!(c.on(), None);
    }

    #[test]
    fn follows_its_card_when_a_frame_reorders_the_cards() {
        let mut c = Cursor::default();
        c.step(&["a", "b"], 1);
        c.step(&["a", "b"], 1);
        c.settle(&["b", "a"]);
        assert_eq!(c.on(), Some("b"));
        assert!(c.step(&["b", "a"], 1));
        assert_eq!(c.on(), Some("a"));
    }

    #[test]
    fn hands_over_to_the_card_in_its_place_when_its_card_goes() {
        let mut c = Cursor::default();
        let cards = ["a", "b", "c"];
        c.step(&cards, 1);
        c.step(&cards, 1);
        c.settle(&["a", "c"]);
        assert_eq!(c.on(), Some("c"));
        c.settle(&["a"]);
        assert_eq!(c.on(), Some("a"));
        c.settle(&[]);
        assert_eq!(c.on(), None);
    }

    #[test]
    fn scrolls_only_as_far_as_the_card_needs() {
        assert_eq!(scroll_for(None, 10), 0);
        assert_eq!(scroll_for(Some(&(2..5)), 10), 0, "already in sight");
        assert_eq!(
            scroll_for(Some(&(12..15)), 10),
            5,
            "its last line at the bottom"
        );
        assert_eq!(
            scroll_for(Some(&(4..20)), 10),
            4,
            "taller than the pane: its top stays"
        );
    }

    #[test]
    fn stays_off_the_cards_until_moved() {
        let mut c = Cursor::default();
        c.settle(&["a"]);
        assert_eq!(c.on(), None);
    }
}
