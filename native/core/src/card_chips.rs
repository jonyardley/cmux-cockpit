//! A card's chips (src/cockpit/card-chips.ts): what answering the chat
//! takes, the PR, the branch and the ports, in that order, and the card's
//! To review action. A merged card's Park and Close, and the chips row's
//! fit on one line (merged.ts, chips.ts), are not ported: the second is
//! the sidebar's estimate of its own point widths.

use serde::Serialize;

use crate::data::{Data, Workspace};
use crate::lanes::LaneKey;
use crate::model::is_anchor;
use crate::moves::{MoveSize, move_size, move_size_text};
use crate::prs::{PrHealth, pr_health, pr_summary};
use crate::session::Session;

/// One chip, as the TypeScript's `Chip` writes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "id", rename_all = "lowercase")]
pub enum Chip {
    /// What answering the chat takes: "Quick", "Review", "Decide · 2".
    Size { text: String, size: MoveSize },
    /// The PR: its number and its state words, each inked its own way.
    Pr {
        /// "#135", in the chip's own ink.
        tag: String,
        /// The words after the number ("draft", "1 failing"), in its
        /// health's ink; "" with none.
        state: String,
        health: PrHealth,
        /// "+120 −8", faint after the state; "" with none.
        diff: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// The branch, with its uncommitted-changes dot.
    #[serde(rename = "br")]
    Branch { text: String, dirty: bool },
    /// The first port and how many more, opening the first on localhost.
    Port { text: String, url: String },
}

/// A real port number: whole, and from 1 to 65535.
fn is_port(p: f64) -> bool {
    p.fract() == 0.0 && p > 0.0 && p < 65536.0
}

/// The ports chip: the first real port, and how many more, each once.
fn port_chip(ports: Option<&[f64]>) -> Option<Chip> {
    let mut list: Vec<f64> = Vec::new();
    for p in ports.unwrap_or_default() {
        if is_port(*p) && !list.contains(p) {
            list.push(*p);
        }
    }
    let first = crate::js::num_text(*list.first()?);
    let more = if list.len() > 1 {
        format!(" +{}", list.len() - 1)
    } else {
        String::new()
    };
    Some(Chip::Port {
        text: format!(":{first}{more} \u{2197}"),
        url: format!("http://localhost:{first}"),
    })
}

impl Session {
    /// A card's chips, in order: the size, the PR, the branch (when
    /// asked for), the ports.
    pub fn chips_for(&mut self, w: Option<&Workspace>, with_branch: bool) -> Vec<Chip> {
        let mut out = Vec::new();
        let Some(w) = w else { return out };
        // First, so what answering takes reads before where the work is.
        if let Some(m) = self.move_of(Some(w))
            && let Some(size) = move_size(&m)
        {
            let text = move_size_text(size, m.decisions.unwrap_or(0.0));
            out.push(Chip::Size { text, size });
        }
        if let Some(pr) = pr_summary(&self.saved, Some(w)) {
            out.push(Chip::Pr {
                tag: pr.tag,
                state: pr.state,
                health: pr.health,
                diff: pr.diff,
                url: pr.url.filter(|u| !u.is_empty()),
            });
        }
        if with_branch && let Some(branch) = w.branch.as_deref().filter(|b| !b.is_empty()) {
            out.push(Chip::Branch {
                text: branch.to_string(),
                dirty: w.dirty == Some(true),
            });
        }
        out.extend(port_chip(w.ports.as_deref()));
        out
    }

    /// Its PR is ready to merge (the green chip), so "To review" shows in green.
    pub fn review_is_green(&self, w: Option<&Workspace>) -> bool {
        pr_health(&self.saved, w) == PrHealth::Ready
    }

    /// A Ready card, or one whose PR is ready to merge, offers "To
    /// review", unless it is already in For review or anchors a group.
    pub fn can_file_for_review(&mut self, data: &Data, w: Option<&Workspace>) -> bool {
        let Some(w) = w else { return false };
        (self.is_ready(data, Some(w)) || self.review_is_green(Some(w)))
            && self.lane_of(data, w) != LaneKey::Review
            && !is_anchor(data, w)
    }

    /// Files a card into For review.
    pub fn file_for_review(&mut self, data: &Data, w: Option<&Workspace>) {
        self.move_to_lane(data, w, LaneKey::Review);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_whole_ports_in_range() {
        assert!(is_port(1.0) && is_port(65535.0));
        assert!(!is_port(0.0) && !is_port(65536.0) && !is_port(1.5));
        assert!(!is_port(f64::NAN));
        assert_eq!(port_chip(None), None);
    }

    #[test]
    fn writes_each_chip_as_the_typescript_does() {
        let pr = Chip::Pr {
            tag: "#7".into(),
            state: "open".into(),
            health: PrHealth::Quiet,
            diff: String::new(),
            url: None,
        };
        let json = serde_json::to_value(&pr).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "pr", "tag": "#7", "state": "open", "health": "quiet", "diff": ""})
        );
        let br = Chip::Branch {
            text: "feat".into(),
            dirty: true,
        };
        assert_eq!(
            serde_json::to_value(&br).unwrap(),
            serde_json::json!({"id": "br", "text": "feat", "dirty": true})
        );
        let size = Chip::Size {
            text: "Quick".into(),
            size: MoveSize::Quick,
        };
        assert_eq!(serde_json::to_value(&size).unwrap()["size"], "quick");
    }
}
