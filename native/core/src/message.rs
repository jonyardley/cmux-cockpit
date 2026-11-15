//! "Message agent…" on a card (R2.7, cmux 0.65.0): Jon's words to the
//! agent in that workspace, sent with `cmux agent message`. cmux delivers
//! them through the agent's hooks, never by typing into its terminal, so
//! they cannot land in a half-typed prompt; an idle Claude wakes to read
//! them. The pane has no equivalent yet: only the sidebar sends one.

use crate::data::Data;
use crate::session::{Outbound, Session};

impl Session {
    /// Sends `text` to the agent in workspace `id`. Nothing for a
    /// workspace not in the frame, or for text that is only blank: an
    /// empty message would wake an idle agent for nothing.
    pub fn message_agent(&mut self, data: &Data, id: &str, text: &str) {
        let text = text.trim();
        if text.is_empty() || data.ws_by_id(id).is_none() {
            return;
        }
        self.outbox.push(Outbound::AgentMessage {
            workspace: id.to_string(),
            text: text.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::SavedState;

    fn data() -> Data {
        serde_json::from_value(serde_json::json!({
            "epoch": 1000.0,
            "workspaces": [{ "id": "a", "title": "App" }],
        }))
        .unwrap()
    }

    fn session() -> Session {
        Session::new(Vec::new(), SavedState::default())
    }

    #[test]
    fn sends_the_words_trimmed_to_the_workspace() {
        let (mut s, d) = (session(), data());
        s.message_agent(&d, "a", "  Rebase when free.\n");
        assert_eq!(
            s.take_outbox(),
            [Outbound::AgentMessage {
                workspace: "a".into(),
                text: "Rebase when free.".into(),
            }]
        );
    }

    #[test]
    fn sends_nothing_blank_or_to_a_workspace_not_in_the_frame() {
        let (mut s, d) = (session(), data());
        s.message_agent(&d, "a", " \n\t");
        s.message_agent(&d, "a", "");
        s.message_agent(&d, "gone", "hello");
        assert!(s.outbox().is_empty());
    }
}
