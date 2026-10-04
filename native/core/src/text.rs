//! Text clean-up shared by both sidebars (src/shared/text.ts).
//!
//! The patterns follow the TypeScript ones. JavaScript's `\w` and `\b` are
//! ASCII, so they are written out as ASCII classes here. A pattern that
//! failed to compile would leave its text unchanged; a test below holds
//! every one of them compiling.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::data::Workspace;
use crate::js::{utf16_len, utf16_prefix};

/// A tag block, `<tag ...>...</tag>`, which needs a backreference.
static TAG_BLOCK: LazyLock<Option<fancy_regex::Regex>> = LazyLock::new(|| {
    fancy_regex::Regex::new(
        r"<([A-Za-z][A-Za-z0-9_:-]*)(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))[^>]*>[\s\S]*?</\1\s*>",
    )
    .ok()
});
static LONE_TAG: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"</?[A-Za-z][^>]*>").ok());
static OPEN_TAIL: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"<[^>]*$").ok());
static ATTACHMENT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\[(?:Image|Pasted text)[^\]]*\]").ok());
static SPACES: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\s+").ok());
static PATH: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?:~|\.{0,2})/\S*").ok());
static NON_LETTERS: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[^A-Za-z]+").ok());
static TWO_LETTERS: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[A-Za-z]{2,}").ok());
static OPENING_TAG: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*<([A-Za-z][A-Za-z0-9_:-]*)").ok());

/// `s.replace(/re/g, with)`.
fn replace_all(re: &LazyLock<Option<Regex>>, s: &str, with: &str) -> String {
    match re.as_ref() {
        Some(re) => re.replace_all(s, with).into_owned(),
        None => s.to_string(),
    }
}

/// Agent messages can carry raw markup (e.g. `<task-notification>` blocks).
/// Drop whole tag blocks first, then any lone tags left over.
pub fn strip_tags(s: Option<&str>) -> String {
    let mut t = s.unwrap_or_default().to_string();
    if let Some(block) = TAG_BLOCK.as_ref() {
        // Until nothing changes; past the backtrack limit, keep what there is.
        while let Ok(out) = block.try_replacen(&t, 0, " ") {
            let next = out.into_owned();
            if next == t {
                break;
            }
            t = next;
        }
    }
    replace_all(&OPEN_TAIL, &replace_all(&LONE_TAG, &t, " "), " ")
}

/// A message that is only markup or only file paths says nothing to a
/// person: "" so the caller falls back to its default copy.
pub fn readable(s: Option<&str>) -> String {
    let stripped = replace_all(&ATTACHMENT, &strip_tags(s), " ");
    let t = replace_all(&SPACES, &stripped, " ").trim().to_string();
    let words = replace_all(&NON_LETTERS, &replace_all(&PATH, &t, " "), " ");
    let has_word = TWO_LETTERS
        .as_ref()
        .is_some_and(|re| re.is_match(words.trim()));
    if has_word { t } else { String::new() }
}

/// `t` cut to `max` characters (UTF-16 units, as `.length`) with an ellipsis.
pub fn clip(t: &str, max: usize) -> String {
    if utf16_len(t) > max {
        format!("{}…", utf16_prefix(t, max.saturating_sub(1)))
    } else {
        t.to_string()
    }
}

/// readable(), cut to `max` characters with an ellipsis.
pub fn one_line(s: Option<&str>, max: usize) -> String {
    clip(&readable(s), max)
}

/// Turns the harness writes into a session, which cmux reports as the
/// latest prompt and message just like one Jon typed (issue #103).
const HARNESS_FRAMES: [&str; 3] = [
    "[Subagent hand-back]",
    "[Artifact comment sent to Claude]",
    "[Request interrupted by user",
];

/// Whether a raw prompt or message is a harness turn rather than Jon's or
/// the agent's words. `t` is its readable() text.
pub fn is_harness_turn(raw: Option<&str>, t: &str) -> bool {
    let s = raw.unwrap_or_default();
    let tag = OPENING_TAG
        .as_ref()
        .and_then(|re| re.captures(s))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str());
    if let Some(tag) = tag
        && (t.is_empty() || !s.contains(&format!("</{tag}")))
    {
        return true;
    }
    HARNESS_FRAMES.iter().any(|f| t.starts_with(f))
}

/// A card's message line: latestMessage, unless it only echoes the prompt.
pub fn card_message(w: Option<&Workspace>) -> String {
    let message = w.and_then(|w| w.latest_message.as_deref());
    let msg = readable(message);
    if is_harness_turn(message, &msg) {
        return String::new();
    }
    let prompt = readable(w.and_then(|w| w.latest_prompt.as_deref()));
    if !msg.is_empty() && msg == prompt {
        String::new()
    } else {
        msg
    }
}

/// The last prompt Jon typed in each workspace, so a harness turn keeps it
/// on screen. Written during a read, as the TypeScript does; a reload only
/// forgets it.
#[derive(Debug, Default, Clone)]
pub struct PromptMemory {
    last: HashMap<String, String>,
}

impl PromptMemory {
    /// The last prompt Jon typed, readable, kept through a harness turn; ""
    /// when there is none.
    pub fn prompt_text(&mut self, w: Option<&Workspace>) -> String {
        let Some(w) = w else { return String::new() };
        let t = readable(w.latest_prompt.as_deref());
        if is_harness_turn(w.latest_prompt.as_deref(), &t) {
            return self.last.get(&w.id).cloned().unwrap_or_default();
        }
        if !t.is_empty() {
            self.last.insert(w.id.clone(), t.clone());
        }
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert!(TAG_BLOCK.is_some());
        for re in [
            &LONE_TAG,
            &OPEN_TAIL,
            &ATTACHMENT,
            &SPACES,
            &PATH,
            &NON_LETTERS,
            &TWO_LETTERS,
            &OPENING_TAG,
        ] {
            assert!(re.is_some());
        }
    }

    #[test]
    fn strips_tag_blocks_then_lone_tags() {
        let s = "<task-notification><id>1</id></task-notification> Done <b>now";
        assert_eq!(
            strip_tags(Some(s)).split_whitespace().collect::<Vec<_>>(),
            ["Done", "now"]
        );
        assert_eq!(strip_tags(Some("a <open")), "a  ");
    }

    #[test]
    fn reads_markup_and_paths_alone_as_unreadable() {
        assert_eq!(
            readable(Some("  Running   the tests ")),
            "Running the tests"
        );
        assert_eq!(readable(Some("/private/tmp/x/output.txt")), "");
        assert_eq!(readable(Some("<x>only</x>")), "");
        assert_eq!(readable(Some("[Image #1] ok")), "ok");
        assert_eq!(readable(None), "");
    }

    #[test]
    fn clips_with_an_ellipsis() {
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(clip("abc", 4), "abc");
    }

    #[test]
    fn tells_a_harness_turn_from_real_words() {
        assert!(is_harness_turn(Some("<local-command>x"), "x"));
        assert!(!is_harness_turn(Some("<b>bold</b> words"), "bold words"));
        assert!(is_harness_turn(
            Some("[Subagent hand-back] hi"),
            "[Subagent hand-back] hi"
        ));
    }

    #[test]
    fn keeps_the_last_prompt_through_a_harness_turn() {
        let mut memory = PromptMemory::default();
        let mut w = Workspace {
            id: "w".into(),
            latest_prompt: Some("tighten slides".into()),
            ..Workspace::default()
        };
        assert_eq!(memory.prompt_text(Some(&w)), "tighten slides");
        w.latest_prompt = Some("<task-notification>done".into());
        assert_eq!(memory.prompt_text(Some(&w)), "tighten slides");
        assert_eq!(memory.prompt_text(None), "");
    }
}
