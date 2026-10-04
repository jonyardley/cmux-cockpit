//! Clock and duration formatting shared by both sidebars (src/shared/time.ts).

use crate::data::{Agent, AgentStatus, Data};
use crate::js::{or_zero, truthy};

/// The app clock in epoch seconds; 0 before the first tick.
pub fn now_epoch(data: &Data) -> f64 {
    or_zero(data.epoch)
}

/// Coarse age, "12m" since `at`; "" without a timestamp or clock. A
/// timestamp ahead of the clock reads as "<1m", never blank.
pub fn age_since(data: &Data, at: Option<f64>) -> String {
    let now = now_epoch(data);
    match truthy(at) {
        Some(at) if now != 0.0 => fmt_age((now - at).max(0.0)),
        _ => String::new(),
    }
}

/// Coarse age for cards: "<1m", "12m", "3h", "2d"; "" for a bad input.
pub fn fmt_age(secs: f64) -> String {
    if secs.is_nan() || secs < 0.0 {
        return String::new();
    }
    if secs < 60.0 {
        return "<1m".to_string();
    }
    if secs < 3600.0 {
        return format!("{}m", (secs / 60.0).floor());
    }
    if secs < 86400.0 {
        return format!("{}h", (secs / 3600.0).floor());
    }
    format!("{}d", (secs / 86400.0).floor())
}

/// Finer elapsed time for agents: "45s", "12m", "3h 5m", "2d".
pub fn fmt_elapsed(secs: f64) -> String {
    let s = secs.floor().max(0.0);
    if s < 60.0 {
        return format!("{s}s");
    }
    let m = (s / 60.0).floor();
    if m < 60.0 {
        return format!("{m}m");
    }
    let h = (m / 60.0).floor();
    if h < 24.0 {
        return format!("{h}h {}m", m % 60.0);
    }
    format!("{}d", (h / 24.0).floor())
}

/// When a finished (idle or ended) agent finished, in epoch seconds; 0 when
/// nothing says (issue #98). An idle agent counts from its move to idle,
/// else its last activity; an ended one from its last activity, else its
/// move to ended, which can be hours after the work.
pub fn finished_at(a: &Agent) -> f64 {
    if a.status == Some(AgentStatus::Ended) {
        return truthy(a.last_activity_at)
            .or(truthy(a.since_epoch))
            .unwrap_or(0.0);
    }
    truthy(a.since_epoch)
        .or(truthy(a.last_activity_at))
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_coarse_ages() {
        assert_eq!(fmt_age(30.0), "<1m");
        assert_eq!(fmt_age(14.0 * 60.0), "14m");
        assert_eq!(fmt_age(3.0 * 3600.0), "3h");
        assert_eq!(fmt_age(2.0 * 86400.0 + 5.0), "2d");
        assert_eq!(fmt_age(-1.0), "");
        assert_eq!(fmt_age(f64::NAN), "");
    }

    #[test]
    fn formats_fine_elapsed_times() {
        assert_eq!(fmt_elapsed(45.4), "45s");
        assert_eq!(fmt_elapsed(185.0 * 60.0), "3h 5m");
        assert_eq!(fmt_elapsed(-3.0), "0s");
    }

    #[test]
    fn ages_need_a_timestamp_and_a_clock() {
        let data = Data {
            epoch: Some(1000.0),
            ..Data::default()
        };
        assert_eq!(age_since(&data, Some(400.0)), "10m");
        assert_eq!(age_since(&data, Some(2000.0)), "<1m");
        assert_eq!(age_since(&data, None), "");
        assert_eq!(age_since(&Data::default(), Some(400.0)), "");
    }

    #[test]
    fn dates_a_finish_by_status() {
        let ended = Agent {
            status: Some(AgentStatus::Ended),
            since_epoch: Some(900.0),
            last_activity_at: Some(500.0),
            ..Agent::default()
        };
        assert_eq!(finished_at(&ended), 500.0);
        let idle = Agent {
            status: Some(AgentStatus::Idle),
            ..ended.clone()
        };
        assert_eq!(finished_at(&idle), 900.0);
        assert_eq!(finished_at(&Agent::default()), 0.0);
    }
}
