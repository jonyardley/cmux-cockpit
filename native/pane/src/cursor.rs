//! The card cursor: which card up and down have reached, held by workspace
//! id so a new frame that reorders the cards keeps it on the same one,
//! and how far the lanes scroll to keep that card in sight.

use std::ops::Range;

/// Where the body's view sits: the lines the cursor's card covers, whether
/// it is the last card, the line scroll keys set with no card to move to,
/// and the body's and the pane's heights.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scroll {
    pub focus: Option<Range<usize>>,
    pub last: bool,
    pub manual: usize,
    pub total: usize,
    pub height: usize,
}

/// How many lines the body scrolls. With a card under the cursor: none
/// until it would fall off the bottom, then just enough, never past its
/// first line, and on the last card as far as the body goes, so what is
/// below it comes into sight, or further by the line scroll Down sets
/// past it. With none: the line scroll, held at the end.
pub fn scroll_for(s: &Scroll) -> usize {
    let most = s.total.saturating_sub(s.height);
    match &s.focus {
        Some(r) if s.last => most.min(r.start.max(s.manual)),
        Some(r) if r.end > s.height => (r.end - s.height).min(r.start),
        Some(_) => 0,
        None => s.manual.min(most),
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

    /// Puts the cursor on `id`, as a click does. True when it moved; a
    /// card not in `cards` leaves it where it is.
    pub fn jump(&mut self, cards: &[&str], id: &str) -> bool {
        let Some(i) = cards.iter().position(|c| *c == id) else {
            return false;
        };
        if self.on() == Some(id) {
            return false;
        }
        self.on = Some(id.to_string());
        self.index = i;
        true
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

    fn at(focus: Option<Range<usize>>, last: bool, manual: usize) -> usize {
        scroll_for(&Scroll {
            focus,
            last,
            manual,
            total: 30,
            height: 10,
        })
    }

    #[test]
    fn scrolls_only_as_far_as_the_card_needs() {
        assert_eq!(at(Some(2..5), false, 0), 0, "already in sight");
        assert_eq!(at(Some(12..15), false, 0), 5, "its last line at the bottom");
        assert_eq!(
            at(Some(4..20), false, 0),
            4,
            "taller than the pane: its top stays"
        );
    }

    #[test]
    fn shows_what_is_below_the_last_card() {
        assert_eq!(at(Some(15..18), true, 0), 15, "never past its top");
        assert_eq!(at(Some(22..25), true, 0), 20, "to the end of the body");
        assert_eq!(at(Some(2..5), true, 9), 9, "on by line past the last card");
        assert_eq!(at(Some(2..5), true, 99), 20, "held at the end");
    }

    #[test]
    fn scrolls_by_line_with_no_card_and_holds_at_the_end() {
        assert_eq!(at(None, false, 0), 0);
        assert_eq!(at(None, false, 7), 7);
        assert_eq!(at(None, false, 99), 20);
    }

    #[test]
    fn jumps_to_a_clicked_card_and_steps_on_from_there() {
        let cards = ["a", "b", "c"];
        let mut c = Cursor::default();
        assert!(c.jump(&cards, "b"));
        assert!(!c.jump(&cards, "b"), "already there");
        assert!(!c.jump(&cards, "z"), "not a card");
        assert_eq!(c.on(), Some("b"));
        assert!(c.step(&cards, 1));
        assert_eq!(c.on(), Some("c"));
    }

    #[test]
    fn stays_off_the_cards_until_moved() {
        let mut c = Cursor::default();
        c.settle(&["a"]);
        assert_eq!(c.on(), None);
    }
}
