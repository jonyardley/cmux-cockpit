//! test/merged.test.ts: a merged card dims while nothing in it wants
//! Jon, and nothing moves or closes it by itself. The state is seeded as
//! the TypeScript seeds __STATE__.

use cockpit_core::merged::MERGED_OPACITY;
use cockpit_core::session::Session;

use crate::support::*;

const MERGED: &str = r#"{"number": 1, "url": "https://github.com/o/r/pull/1", "status": "merged", "branch": "feat"}"#;
const OPEN: &str =
    r#"{"number": 1, "url": "https://github.com/o/r/pull/1", "status": "open", "branch": "feat"}"#;

fn setup() -> (Session, Fx) {
    let state = format!(r#"{{"prs": {{"done": {MERGED}, "open": {OPEN}}}}}"#);
    (session(&state), Fx::default())
}

mod merged_cards {
    use super::*;

    #[test]
    fn reads_merged_from_the_pr_not_from_an_open_or_missing_one() {
        let (s, ..) = setup();
        assert!(s.is_merged(Some(&ws("done"))));
        assert!(!s.is_merged(Some(&ws("open"))));
        assert!(!s.is_merged(Some(&ws("none"))));
        assert!(!s.is_merged(None));
    }

    #[test]
    fn dims_a_merged_card_but_not_while_lit_or_while_it_still_wants_jon() {
        let (mut s, mut fx) = setup();
        assert_eq!(s.card_opacity(Some(&ws("done")), false), MERGED_OPACITY);
        assert_eq!(
            s.card_opacity(Some(&ws("done")), true),
            1.0,
            "a selected or dragged card reads at full strength"
        );
        assert_eq!(s.card_opacity(Some(&ws("done").unread(2.0)), false), 1.0);
        for st in [Working, NeedsInput] {
            let w = ws("done").agents(vec![fx.agent(st.clone())]);
            assert_eq!(s.card_opacity(Some(&w), false), 1.0, "{st:?}");
        }
        let idle = ws("done").agents(vec![fx.agent(Idle)]);
        assert_eq!(s.card_opacity(Some(&idle), false), MERGED_OPACITY);
        assert_eq!(s.card_opacity(Some(&ws("open")), false), 1.0);
        assert_eq!(s.card_opacity(None, false), 1.0);
    }
}
