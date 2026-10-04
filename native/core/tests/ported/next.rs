//! test/next.test.ts: the capped Needs you strip (issue #74). The Next
//! queue, the cards sorted by state inside a lane and where a drop lands
//! are next.ts's, lane-entries.ts's and drop.ts's, left for their lanes.

use cockpit_core::data::{Agent, Data, Workspace};

use crate::support::*;

const NOW: f64 = 1_000_100.0;

/// An agent that has asked for `ago` seconds.
fn asking(fx: &mut Fx, ago: f64) -> Vec<Agent> {
    vec![fx.agent(NeedsInput).since(NOW - ago)]
}

/// The Main activity lane with its generated anchor, then `workspaces`.
fn scene(workspaces: Vec<Workspace>) -> Data {
    let mut list = vec![ws("anchor-main").title("Main activity").group("g-main")];
    list.extend(workspaces);
    frame(
        NOW,
        vec![group("g-main", "Main activity").anchor("anchor-main")],
        list,
    )
}

mod the_capped_needs_you_strip {
    use super::*;

    #[test]
    fn shows_four_rows_and_counts_the_rest() {
        let mut fx = Fx::default();
        let data = scene(
            ["a", "b", "c", "d", "e", "f"]
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    ws(id)
                        .group("g-main")
                        .agents(asking(&mut fx, 600.0 - i as f64 * 60.0))
                })
                .collect(),
        );
        let mut s = fresh();
        assert_eq!(s.needs_list(&data).len(), 6);
        let shown: Vec<&str> = s.needs_shown(&data).iter().map(|w| w.id.as_str()).collect();
        assert_eq!(shown, ["a", "b", "c", "d"]);
        assert_eq!(s.needs_more(&data), 2);
    }

    #[test]
    fn has_no_more_line_at_four_or_fewer() {
        let mut fx = Fx::default();
        let data = scene(
            ["a", "b", "c", "d"]
                .iter()
                .map(|id| ws(id).group("g-main").agents(asking(&mut fx, 60.0)))
                .collect(),
        );
        let mut s = fresh();
        assert_eq!(s.needs_shown(&data).len(), 4);
        assert_eq!(s.needs_more(&data), 0);
    }
}
