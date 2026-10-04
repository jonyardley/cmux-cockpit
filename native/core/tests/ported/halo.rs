//! test/halo.test.ts

use cockpit_core::data::{Data, Workspace};
use cockpit_core::lanes::{LaneKey, lane_by_key};
use cockpit_core::session::Session;
use cockpit_core::theme::Token;
use cockpit_core::ui::{HaloStatus, halo_status};

use crate::support::*;

fn halo_of(s: &mut Session, data: &Data, w: &Workspace) -> Token {
    s.status_info(data, Some(w)).halo
}

mod halo_status {
    use super::*;

    #[test]
    fn is_the_one_decision_behind_board_1s_halo_working_and_needs_only() {
        assert_eq!(halo_status(Some("working")), Some(HaloStatus::Working));
        assert_eq!(
            halo_status(Some("needs_input")),
            Some(HaloStatus::NeedsInput)
        );
        assert_eq!(halo_status(Some("idle")), None);
        assert_eq!(halo_status(Some("ended")), None);
        assert_eq!(halo_status(Some("none")), None);
        assert_eq!(halo_status(None), None);
    }
}

mod cockpit_status_halo {
    use super::*;

    #[test]
    fn rings_working_and_needs_dots_only() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let data = frame(1_000_000.0, vec![], vec![]);
        let cases = [
            (ws("w").agents(vec![fx.agent(Working)]), Token::BlueHalo),
            (ws("n").agents(vec![fx.agent(NeedsInput)]), Token::ClayHalo),
            (ws("i").agents(vec![fx.agent(Idle)]), Token::Clear),
            (ws("e").agents(vec![fx.agent(Ended)]), Token::Clear),
            (ws("q"), Token::Clear),
        ];
        for (w, want) in cases {
            assert_eq!(halo_of(&mut s, &data, &w), want, "{}", w.id);
        }
    }

    #[test]
    fn drops_the_halo_once_needs_you_is_dismissed() {
        let mut fx = Fx::default();
        let mut s = fresh();
        let data = frame(1_000_100.0, vec![], vec![]);
        let w = ws("d").agents(vec![fx.agent(NeedsInput).since(500.0)]);
        s.dismiss_needs(Some(&w));
        assert_eq!(halo_of(&mut s, &data, &w), Token::Clear);
    }
}

mod lane_colours {
    use super::*;

    #[test]
    fn uses_board_1s_tokens_for_background_and_unsorted() {
        assert_eq!(lane_by_key(LaneKey::Bg).color, Token::LaneBackground);
        assert_eq!(lane_by_key(LaneKey::Unsorted).color, Token::LaneUnsorted);
    }
}
