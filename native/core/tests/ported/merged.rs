//! test/merged.test.ts. Every case tests merged.ts, which a later lane
//! ports; the one that moves a card checks model.rs's part of it.

use cockpit_core::lanes::LaneKey;

use crate::support::*;

mod merged_cards {
    use super::*;

    /// Partly ported: Park's offer is merged.ts's; filing the card into Parked is model.rs's.
    #[test]
    fn offers_park_until_the_card_is_in_parked_and_park_files_it_there() {
        let mut s = fresh();
        let data = frame(
            1_000_100.0,
            vec![group("g-parked", "Parked").anchor("anchor")],
            vec![ws("anchor").title("Parked").group("g-parked"), ws("parks")],
        );
        let w = by_id(&data, "parks");
        assert!(calls(&s).is_empty(), "nothing moves until Park is tapped");
        s.move_to_lane(&data, Some(w), LaneKey::Parked);
        assert_eq!(
            calls(&s).last(),
            Some(&call(
                "workspace.group.add",
                &[("group_id", "g-parked"), ("workspace_id", "parks")]
            ))
        );
        assert_eq!(s.lane_of(&data, w), LaneKey::Parked);
    }
}
