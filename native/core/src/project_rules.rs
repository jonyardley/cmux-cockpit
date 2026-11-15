//! The rules a saved project keeps (src/shared/project-rules.ts): the
//! state handler checks every value arriving from a URL against them, and
//! the editor (edit.rs) uses the same ones to say why Done would not save.

use crate::js::utf16_len;
use crate::persist::is_text;
use crate::projects::MAX_NAME;

/// The longest saved project key or folder.
pub const MAX_PROJECT_KEY: usize = 512;

/// A saved project's key: lowercase, at least two segments deep, as
/// `/^(\/[^/]+){2,}\/?$/`, and no longer than MAX_PROJECT_KEY.
pub fn is_match_key(v: &str) -> bool {
    let Some(rest) = v.strip_prefix('/') else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let parts: Vec<&str> = rest.split('/').collect();
    parts.len() >= 2
        && parts.iter().all(|p| !p.is_empty())
        && utf16_len(v) <= MAX_PROJECT_KEY
        && v == v.to_lowercase()
}

/// A six-digit hex colour, e.g. "#D97757".
pub fn is_hex(v: &str) -> bool {
    v.strip_prefix('#')
        .is_some_and(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()))
}

/// An SF Symbol name: dotted lowercase words, e.g. "music.note".
pub fn is_symbol(v: &str) -> bool {
    let word = |w: &str| {
        !w.is_empty()
            && w.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    v.len() <= 64 && v.split('.').all(word)
}

/// A project name: plain, single-line text up to MAX_NAME long.
pub fn is_name(v: &str) -> bool {
    is_text(v, MAX_NAME)
}

/// Absolute, or under "~" as in projects.json, up to MAX_PROJECT_KEY long.
pub fn is_root(v: &str) -> bool {
    (v.starts_with('/') || v == "~" || v.starts_with("~/")) && utf16_len(v) <= MAX_PROJECT_KEY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_match_key_is_two_lowercase_segments_deep() {
        assert!(is_match_key("/dev/app-one"));
        assert!(is_match_key("/users/jon/dev/app/"));
        assert!(!is_match_key("applet"));
        assert!(!is_match_key("/dev"));
        assert!(!is_match_key("/dev//app"));
        assert!(!is_match_key("/Dev/app"));
        assert!(!is_match_key(&format!("/a/{}", "x".repeat(511))));
    }

    #[test]
    fn a_colour_is_six_hex_digits_in_any_case() {
        assert!(is_hex("#D97757"));
        assert!(is_hex("#abcdef"));
        assert!(!is_hex("red"));
        assert!(!is_hex("#abcde"));
        assert!(!is_hex("#abcdeg"));
    }

    #[test]
    fn a_symbol_is_dotted_lowercase_words() {
        assert!(is_symbol("music.note"));
        assert!(is_symbol("music.quarternote.3"));
        assert!(!is_symbol("Not An Icon"));
        assert!(!is_symbol("music..note"));
        assert!(!is_symbol(".note"));
        assert!(!is_symbol(""));
    }

    #[test]
    fn a_root_is_absolute_or_under_tilde() {
        assert!(is_root("/opt/x"));
        assert!(is_root("~"));
        assert!(is_root("~/dev"));
        assert!(!is_root("dev/two"));
        assert!(!is_root("~bob/x"));
    }
}
