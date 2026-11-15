//! JavaScript's rules, where the port has to match them to give the same
//! answers as the TypeScript sidebars: which numbers count as set, how a
//! number prints, how long a string is, and how a URL part is escaped.

use serde_json::Value;

/// A number the TypeScript reads with `x || ...` or `if (x)`: set, not zero
/// and not NaN. `??` keeps a zero, so those sites read the option directly.
pub fn truthy(x: Option<f64>) -> Option<f64> {
    x.filter(|v| *v != 0.0 && !v.is_nan())
}

/// `x || 0`.
pub fn or_zero(x: Option<f64>) -> f64 {
    truthy(x).unwrap_or(0.0)
}

/// `x > 0`, false for NaN: what `!(x > 0)` negates in the TypeScript.
pub fn positive(x: f64) -> bool {
    x > 0.0
}

/// A string the TypeScript reads with `if (s)`: set and not empty.
pub fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|t| !t.is_empty())
}

/// The largest whole number an f64 holds exactly, as JavaScript's
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A whole number within the safe range, as an i64; None otherwise.
fn whole(x: f64) -> Option<i64> {
    if x.fract() == 0.0 && x.abs() <= MAX_SAFE {
        // In range and whole, so the cast is exact.
        Some(x as i64)
    } else {
        None
    }
}

/// A number as `String(x)` prints it: "1000100" for a whole number, not
/// "1000100.0".
pub fn num_text(x: f64) -> String {
    match whole(x) {
        Some(n) => n.to_string(),
        None => x.to_string(),
    }
}

/// A number as `JSON.stringify` writes it: whole numbers without a ".0",
/// and null for NaN or an infinity.
pub fn json_num(x: f64) -> Value {
    match whole(x) {
        Some(n) => Value::from(n),
        None => serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number),
    }
}

/// A string's `.length`: its count of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The first `n` UTF-16 code units of `s`, as `s.slice(0, n)`. A surrogate
/// pair cut in half becomes U+FFFD, where JavaScript would keep half a pair.
pub fn utf16_prefix(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `encodeURIComponent`: every byte of the UTF-8 form is escaped except
/// the letters, digits and `-_.!~*'()`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_zero_and_nan_as_unset() {
        assert_eq!(truthy(Some(0.0)), None);
        assert_eq!(truthy(Some(f64::NAN)), None);
        assert_eq!(truthy(Some(5.0)), Some(5.0));
        assert_eq!(or_zero(None), 0.0);
        assert_eq!(non_empty(Some("")), None);
    }

    #[test]
    fn prints_numbers_as_javascript_does() {
        assert_eq!(num_text(1_000_100.0), "1000100");
        assert_eq!(num_text(0.4), "0.4");
        assert_eq!(json_num(500.0).to_string(), "500");
        assert_eq!(json_num(f64::NAN), Value::Null);
    }

    #[test]
    fn counts_and_cuts_utf16_units() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("abc", 2), "ab");
    }

    #[test]
    fn escapes_a_url_part_as_encode_uri_component() {
        assert_eq!(
            encode_uri_component("\"/dev/app-two\""),
            "%22%2Fdev%2Fapp-two%22"
        );
        assert_eq!(encode_uri_component("a b~é"), "a%20b~%C3%A9");
    }
}
