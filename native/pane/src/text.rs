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

/// Text the core already cut with an ellipsis, which may have landed
/// mid-word: the part word goes, so the ellipsis follows a whole one.
/// Text without the ellipsis comes back with its spaces folded.
pub fn whole_words(text: &str) -> String {
    let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(head) = folded.strip_suffix(ELLIPSIS) else {
        return folded;
    };
    if head.ends_with(' ') || head.is_empty() {
        return format!("{}{ELLIPSIS}", head.trim_end());
    }
    match head.rfind(' ') {
        Some(i) => format!("{}{ELLIPSIS}", &head[..i]),
        None => ELLIPSIS.to_string(),
    }
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
    fn drops_the_part_word_the_core_cut() {
        assert_eq!(whole_words("the batch resum…"), "the batch…");
        assert_eq!(whole_words("the batch …"), "the batch…");
        assert_eq!(whole_words("resum…"), "…");
        assert_eq!(whole_words("the  batch"), "the batch");
    }

    #[test]
    fn counts_cells_not_bytes() {
        assert_eq!(width("café"), 4);
        assert_eq!(fit("café au lait", 8), "café au…");
    }
}
