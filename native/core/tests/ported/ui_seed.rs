//! test/ui-seed.test.ts: the cockpit's view and folds come back from the
//! saved state after a rebuild's reload.

use crate::support::lane_by_key;
use cockpit_core::lanes::LaneKey;
use cockpit_core::persist::ViewMode;
use cockpit_core::session::Session;

use crate::support::*;

const STATE: &str = r#"{"ui": {"mode": "projects", "collapsed": {"lane:unsorted": 1, "lane:parked": 0, "project:/dev/app-two": 1}}}"#;

fn setup() -> Session {
    session(STATE)
}

mod state_and_model_seed_the_view_and_folds_from_the_saved_state {
    use super::*;

    #[test]
    fn opens_on_the_saved_view() {
        assert_eq!(setup().mode(), ViewMode::Projects);
    }

    #[test]
    fn keeps_unsorted_and_a_project_folded() {
        let mut s = setup();
        let data = frame(1_000_000.0, vec![], vec![]);
        assert!(s.is_collapsed(&data, &lane_by_key(LaneKey::unsorted())));
        assert!(s.is_project_collapsed("/dev/app-two"));
        assert!(!s.is_project_collapsed("/dev/app-one"));
    }

    #[test]
    fn leaves_a_touched_parked_lane_to_cmuxs_own_fold_rather_than_starting_it_folded() {
        let mut s = setup();
        let data = frame(
            1_000_000.0,
            vec![group("g-parked", "Parked").collapsed(false)],
            vec![],
        );
        assert!(!s.is_collapsed(&data, &lane_by_key(LaneKey::from("parked"))));
    }
}
