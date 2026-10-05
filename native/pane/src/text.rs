//! Fitting words into terminal columns. A line is only ever cut between
//! words, with an ellipsis after the last whole word that fits, so the
//! pane never shows half a word. Widths are terminal cells.

use unicode_width::UnicodeWidthStr;

/// What a cut line ends on.
pub const ELLIPSIS: &str = "…";

/// How many cells `text` takes.
pub fn width(text: &str) -> usize {
    text.width()
}

/// `text` on one line of at most `max` cells: whole words, then an
/// ellipsis when some were left off. A first word too wide to fit leaves
/// the ellipsis alone, so a word is never cut.
pub fn fit(text: &str, max: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let whole = words.join(" ");
    if width(&whole) <= max {
        return whole;
    }
    let mut out = String::new();
    for word in words {
        let gap = usize::from(!out.is_empty());
        if width(&out) + gap + width(word) + width(ELLIPSIS) > max {
            break;
        }
        if gap == 1 {
            out.push(' ');
        }
        out.push_str(word);
    }
    if width(ELLIPSIS) <= max {
        out.push_str(ELLIPSIS);
    }
    out
}

/// How many items of these widths fit whole on a line of `room` cells,
/// `gap` cells apart, and whether some were left off: then an ellipsis
/// after the last one that fits takes its place, a gap before it when
/// any item fits. An item is never cut.
pub fn fit_items(widths: &[usize], gap: usize, room: usize) -> (usize, bool) {
    let all: usize = widths.iter().sum::<usize>() + gap * widths.len().saturating_sub(1);
    if all <= room {
        return (widths.len(), false);
    }
    let tail = width(ELLIPSIS);
    let mut used = 0;
    for (i, w) in widths.iter().enumerate() {
        let lead = if i == 0 { 0 } else { gap };
        if used + lead + w + gap + tail > room {
            return (i, true);
        }
        used += lead + w;
    }
    (widths.len(), false)
}

/// Which items show on a line of `room` cells, `gap` cells apart, and
/// whether some were left off. Every one when all fit; else the ones that
/// give way (a long branch) go first, so the rest keep their room, and
/// then fit_items drops from the end.
pub fn fit_ranked(
    widths: &[usize],
    gives_way: &[bool],
    gap: usize,
    room: usize,
) -> (Vec<bool>, bool) {
    let (all, cut) = fit_items(widths, gap, room);
    if !cut {
        return (vec![true; all], false);
    }
    let keep: Vec<usize> = (0..widths.len())
        .filter(|i| !gives_way.get(*i).copied().unwrap_or(false))
        .collect();
    // The ellipsis rides as one more item, so whatever is kept leaves it room.
    let mut kept: Vec<usize> = keep.iter().map(|i| widths[*i]).collect();
    kept.push(width(ELLIPSIS));
    let (n, _) = fit_items(&kept, gap, room);
    let n = n.min(keep.len());
    let mut shown = vec![false; widths.len()];
    for i in keep.iter().take(n) {
        shown[*i] = true;
    }
    (shown, true)
}

/// `text` wrapped onto at most `lines` lines of `max` cells, between
/// words; the last line ends in an ellipsis when words were left over.
pub fn wrap(text: &str, max: usize, lines: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest: Vec<&str> = text.split_whitespace().collect();
    while !rest.is_empty() && out.len() < lines {
        if out.len() + 1 == lines {
            out.push(fit(&rest.join(" "), max));
            break;
        }
        let mut line = String::new();
        let mut taken = 0;
        for word in &rest {
            let gap = usize::from(!line.is_empty());
            if width(&line) + gap + width(word) > max {
                break;
            }
            if gap == 1 {
                line.push(' ');
            }
            line.push_str(word);
            taken += 1;
        }
        if taken == 0 {
            // A word wider than the line: the ellipsis stands in for it.
            out.push(fit(&rest.join(" "), max));
            break;
        }
        out.push(line);
        rest.drain(..taken);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_whole_items_and_leaves_room_for_the_ellipsis_when_some_go() {
        assert_eq!(fit_items(&[3, 4], 2, 9), (2, false));
        assert_eq!(
            fit_items(&[3, 4], 2, 8),
            (1, true),
            "3, a gap, the ellipsis"
        );
        assert_eq!(fit_items(&[3, 4], 2, 5), (0, true));
        assert_eq!(fit_items(&[], 2, 0), (0, false));
    }

    #[test]
    fn lets_a_long_branch_go_first_so_the_chips_after_it_keep_their_room() {
        let ways = [false, true, false];
        assert_eq!(fit_ranked(&[3, 4, 2], &ways, 2, 20), (vec![true; 3], false));
        // 3 + 2 + 2, then a gap and the ellipsis.
        assert_eq!(
            fit_ranked(&[3, 20, 2], &ways, 2, 10),
            (vec![true, false, true], true)
        );
        assert_eq!(
            fit_ranked(&[3, 20, 2], &ways, 2, 6),
            (vec![true, false, false], true)
        );
        // 3 + 2 + 2 fits 7 exactly, but the ellipsis needs a gap and a cell more.
        assert_eq!(
            fit_ranked(&[3, 20, 2], &ways, 2, 7),
            (vec![true, false, false], true)
        );
    }

    #[test]
    fn keeps_text_that_fits() {
        assert_eq!(fit("fix the login", 13), "fix the login");
    }

    #[test]
    fn cuts_between_words_with_an_ellipsis() {
        assert_eq!(fit("fix the login page", 12), "fix the…");
    }

    #[test]
    fn leaves_the_ellipsis_alone_when_no_word_fits() {
        assert_eq!(fit("unbelievably", 5), "…");
        assert_eq!(fit("anything", 0), "");
    }

    #[test]
    fn folds_runs_of_spaces() {
        assert_eq!(fit("  two   words ", 20), "two words");
    }

    #[test]
    fn wraps_between_words_and_ends_on_an_ellipsis() {
        let got = wrap("one two three four five six", 9, 2);
        assert_eq!(got, vec!["one two", "three…"]);
    }

    #[test]
    fn wraps_onto_fewer_lines_when_the_text_is_short() {
        assert_eq!(wrap("short", 20, 2), vec!["short"]);
        assert!(wrap("", 20, 2).is_empty());
        assert!(wrap("words", 20, 0).is_empty());
    }

    #[test]
    fn never_cuts_a_word_too_wide_for_a_line() {
        assert_eq!(wrap("a enormousword b", 6, 3), vec!["a", "…"]);
    }

    #[test]
    fn counts_cells_not_bytes() {
        assert_eq!(width("café"), 4);
        assert_eq!(fit("café au lait", 8), "café au…");
    }
}
