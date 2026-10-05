//! The saved half of the local state loop (src/shared/persist.ts and the
//! contract in scripts/state-config.ts): config/state.json as it stands,
//! read unchanged, and the one-entry writes the sidebar sends back.
//!
//! The build cleans the file before baking it in, so most entries arrive
//! valid. A malformed entry in a map, or a field of the wrong type, is
//! still dropped on its own rather than failing the whole file, as the
//! TypeScript reader drops it (lenient.rs).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::data::PrStatus;
use crate::js::{encode_uri_component, utf16_len};
use crate::saved::Stamped;

/// The cockpit's view: "all" (lanes) or "projects".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    #[default]
    All,
    Projects,
}

impl ViewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewMode::All => "all",
            ViewMode::Projects => "projects",
        }
    }
}

/// The cockpit's own view state, so a rebuild's reload keeps it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct UiState {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub mode: Option<ViewMode>,
    /// "lane:<key>", "project:<key>" or "quiet" to 1 folded, 0 unfolded.
    #[serde(deserialize_with = "crate::lenient::map")]
    pub collapsed: BTreeMap<String, f64>,
}

/// A project made or edited in the sidebar.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ProjectSpec {
    pub name: String,
    pub color: String,
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// A saved project: a spec, or a projects.json project removed in the sidebar.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum SavedProject {
    Spec(ProjectSpec),
    Removed { removed: bool },
}

/// One CI check as the poller saves it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SavedCheck {
    pub name: String,
    pub state: String,
}

/// A pull request as the poller saves it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SavedPr {
    pub number: f64,
    pub url: String,
    /// Read as cmux's own PR status is, an unknown word as Unknown.
    pub status: PrStatus,
    pub branch: String,
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub mergeable: Option<bool>,
    #[serde(default)]
    pub conflicts: Option<bool>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub additions: Option<f64>,
    #[serde(default)]
    pub deletions: Option<f64>,
    #[serde(default)]
    pub checks: Option<Vec<SavedCheck>>,
}

/// A subagent run as the hook saves it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSubagent {
    pub id: String,
    pub session: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    pub label: String,
    pub started_epoch: f64,
    #[serde(default)]
    pub ended_epoch: Option<f64>,
}

/// A background shell a chat started.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedShell {
    pub id: String,
    pub session: String,
    pub started_epoch: f64,
}

/// Why an agent stopped to ask, as the notification hook saves it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SavedAsk {
    pub reason: String,
    pub epoch: f64,
    #[serde(default)]
    pub session: Option<String>,
}

impl Stamped for SavedAsk {
    fn epoch(&self) -> f64 {
        self.epoch
    }
    fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }
}

/// What a chat last asked of Jon, as the Stop hook saves it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct SavedMove {
    /// The line after "Your move:".
    pub text: String,
    /// Epoch seconds the hook saw the turn end.
    pub epoch: f64,
    #[serde(default)]
    pub session: Option<String>,
    /// How many numbered decisions the reply laid out.
    #[serde(default)]
    pub decisions: Option<f64>,
    /// The reply's recommended answers ("1b 2a").
    #[serde(default)]
    pub leans: Option<String>,
    /// Set when the line was "Nothing for you:": the turn waits on the agent.
    #[serde(default)]
    pub idle: Option<bool>,
}

impl Stamped for SavedMove {
    fn epoch(&self) -> f64 {
        self.epoch
    }
    fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }
}

/// How the PR poller's last runs went.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedPoll {
    #[serde(deserialize_with = "crate::lenient::field")]
    pub ok_epoch: Option<f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub error: Option<String>,
}

/// config/state.json. The maps only the agents sidebar reads stay as plain
/// JSON until that sidebar is ported.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedState {
    /// wsId to agent id to the start of the dismissed needs_input spell.
    #[serde(deserialize_with = "crate::lenient::map")]
    pub dismissed: BTreeMap<String, BTreeMap<String, f64>>,
    /// wsId to the project key chosen by "Move to project".
    #[serde(deserialize_with = "crate::lenient::map")]
    pub project_override: BTreeMap<String, String>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub projects: BTreeMap<String, SavedProject>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub prs: BTreeMap<String, SavedPr>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub own_prs: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub subagents: BTreeMap<String, Vec<SavedSubagent>>,
    /// Left out of the file while nothing is saved.
    #[serde(deserialize_with = "crate::lenient::map")]
    pub shells: BTreeMap<String, Vec<SavedShell>>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub names: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub published: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub pr_origins: BTreeMap<String, Value>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub asking: BTreeMap<String, SavedAsk>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub moves: BTreeMap<String, SavedMove>,
    #[serde(deserialize_with = "crate::lenient::map")]
    pub merge_kept: BTreeMap<String, f64>,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub ui: UiState,
    #[serde(deserialize_with = "crate::lenient::field")]
    pub poll: Option<SavedPoll>,
}

impl SavedState {
    /// The state from config/state.json's text.
    pub fn from_json(text: &str) -> Result<SavedState, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// Makes one of the cockpit's own writes here, as the handler's
    /// applySet makes it in the file: `dismissed.<ws>`, `projectOverride.<ws>`,
    /// `ui.mode` or `ui.collapsed`, set, or deleted with no value. False
    /// for any other key or a value of the wrong shape, leaving the state
    /// as it was.
    pub fn set_entry(&mut self, key: &str, value: Option<&Value>) -> bool {
        fn parse<T: serde::de::DeserializeOwned>(v: Option<&Value>) -> Result<Option<T>, ()> {
            v.map(|v| serde_json::from_value(v.clone()).map_err(|_| ()))
                .transpose()
        }
        let Some((map, id)) = key.split_once('.') else {
            return false;
        };
        fn put<T>(entries: &mut BTreeMap<String, T>, id: &str, v: Option<T>) {
            match v {
                Some(v) => entries.insert(id.to_string(), v),
                None => entries.remove(id),
            };
        }
        match (map, id) {
            ("dismissed", _) => parse(value)
                .map(|v| put(&mut self.dismissed, id, v))
                .is_ok(),
            ("projectOverride", _) => parse(value)
                .map(|v| put(&mut self.project_override, id, v))
                .is_ok(),
            ("ui", "mode") => parse(value).map(|v| self.ui.mode = v).is_ok(),
            ("ui", "collapsed") => parse(value)
                .map(|v| self.ui.collapsed = v.unwrap_or_default())
                .is_ok(),
            _ => false,
        }
    }

    /// Whether the state already holds this write.
    pub fn shows_entry(&self, key: &str, value: Option<&Value>) -> bool {
        let mut after = self.clone();
        after.set_entry(key, value) && after == *self
    }
}

/// The URL that asks the (separately installed) handler to set or delete
/// one entry. `key` is `<map>.<id>`; a None value asks for a delete. The
/// install's token goes last, when there is one.
pub fn persist_url(key: &str, value: Option<&Value>, token: &str) -> String {
    let mut url = format!("cmux-cockpit://set?key={}", encode_uri_component(key));
    if let Some(v) = value {
        url.push_str("&value=");
        url.push_str(&encode_uri_component(&v.to_string()));
    }
    if !token.is_empty() {
        url.push_str("&token=");
        url.push_str(&encode_uri_component(token));
    }
    url
}

// A move rides to the cockpit in its workspace's description: the line,
// then the rest of the move as one bracketed JSON tail.
static MOVE_TAIL: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?s)^(.*) ⟦move (\{.*\})⟧$").ok());
static LEANS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[1-9][a-z](?: [1-9][a-z])*$").ok());

/// The longest "Your move" line kept.
pub const MAX_MOVE: usize = 200;
/// The most decisions one reply is counted as laying out.
pub const MAX_DECISIONS: f64 = 9.0;

/// Plain, single-line text with no leading, trailing or control characters, up to `max` long.
fn is_text(v: &str, max: usize) -> bool {
    let len = utf16_len(v);
    v.trim() == v && len > 0 && len <= max && v.chars().all(|c| c >= ' ' && c != '\u{7f}')
}

fn is_id(v: &str) -> bool {
    let len = utf16_len(v);
    len > 0 && len <= 128 && !["__proto__", "constructor", "prototype"].contains(&v)
}

fn epoch_of(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|e| e.is_finite() && *e >= 0.0)
}

/// A move from its fields, or None when any is bad (state-config.ts's savedMove).
fn saved_move(fields: &Map<String, Value>, text: &str) -> Option<SavedMove> {
    if !is_text(text, MAX_MOVE) {
        return None;
    }
    let epoch = epoch_of(fields.get("epoch"))?;
    let session = match fields.get("session") {
        None => None,
        Some(Value::String(s)) if is_id(s) => Some(s.clone()),
        Some(_) => return None,
    };
    let decisions = match fields.get("decisions") {
        None => None,
        Some(v) => Some(
            v.as_f64()
                .filter(|d| d.fract() == 0.0 && (1.0..=MAX_DECISIONS).contains(d))?,
        ),
    };
    let leans = match fields.get("leans") {
        None => None,
        Some(Value::String(s))
            if utf16_len(s) <= 40 && LEANS.as_ref().is_some_and(|re| re.is_match(s)) =>
        {
            Some(s.clone())
        }
        Some(_) => return None,
    };
    let idle = match fields.get("idle") {
        None => None,
        Some(Value::Bool(true)) => Some(true),
        Some(_) => return None,
    };
    Some(SavedMove {
        text: text.to_string(),
        epoch,
        session,
        decisions,
        leans,
        idle,
    })
}

/// The move a workspace description carries, or None when it carries none or a bad one.
pub fn move_of_description(d: Option<&str>) -> Option<SavedMove> {
    let caps = MOVE_TAIL.as_ref()?.captures(d?)?;
    let text = caps.get(1)?.as_str();
    let rest: Value = serde_json::from_str(caps.get(2)?.as_str()).ok()?;
    saved_move(rest.as_object()?, text)
}

/// True when a description is a move's, so it is never shown as Jon's own words.
pub fn is_move_description(d: Option<&str>) -> bool {
    match (d, MOVE_TAIL.as_ref()) {
        (Some(d), Some(re)) => re.is_match(d),
        _ => false,
    }
}

/// A move as the workspace description the Stop hook sets.
pub fn move_description(m: &SavedMove) -> String {
    let mut rest = Map::new();
    rest.insert("epoch".into(), crate::js::json_num(m.epoch));
    if let Some(s) = &m.session {
        rest.insert("session".into(), Value::from(s.as_str()));
    }
    if let Some(d) = m.decisions {
        rest.insert("decisions".into(), crate::js::json_num(d));
    }
    if let Some(l) = &m.leans {
        rest.insert("leans".into(), Value::from(l.as_str()));
    }
    if let Some(i) = m.idle {
        rest.insert("idle".into(), Value::from(i));
    }
    format!("{} ⟦move {}⟧", m.text, Value::Object(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert!(MOVE_TAIL.is_some());
        assert!(LEANS.is_some());
    }

    #[test]
    fn reads_a_state_file_dropping_only_its_bad_entries() {
        let json = r##"{
            "dismissed": {"w1": {"a1": 500}, "bad": 3},
            "asking": {"ok": {"reason": "allow?", "epoch": 1}, "bad": {"epoch": 1}},
            "ui": {"mode": "projects", "collapsed": {"lane:unsorted": 1}},
            "projects": {"/a/b/": {"name": "B", "color": "#000000", "icon": "x"}, "/c/d": {"removed": true}},
            "someFutureMap": {}
        }"##;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.dismissed.len(), 1);
        assert_eq!(s.asking.len(), 1);
        assert_eq!(s.ui.mode, Some(ViewMode::Projects));
        assert_eq!(s.ui.collapsed.get("lane:unsorted"), Some(&1.0));
        assert!(matches!(
            s.projects.get("/c/d"),
            Some(SavedProject::Removed { .. })
        ));
        assert!(s.shells.is_empty());
    }

    #[test]
    fn keeps_the_rest_of_the_file_when_one_field_is_bad() {
        let json = r#"{"ui": {"mode": "lanes", "collapsed": {"quiet": 1}},
            "poll": {"okEpoch": "x"}, "ownPrs": null, "names": 3,
            "dismissed": {"w1": {"a1": 500}}}"#;
        let s = SavedState::from_json(json).unwrap();
        assert_eq!(s.ui.mode, None);
        assert_eq!(s.ui.collapsed.get("quiet"), Some(&1.0));
        assert_eq!(s.poll.and_then(|p| p.ok_epoch), None);
        assert!(s.own_prs.is_empty() && s.names.is_empty());
        assert_eq!(s.dismissed.len(), 1);
    }

    #[test]
    fn builds_the_persist_url() {
        let v = Value::from("/dev/app-two");
        assert_eq!(
            persist_url("projectOverride.a", Some(&v), ""),
            "cmux-cockpit://set?key=projectOverride.a&value=%22%2Fdev%2Fapp-two%22"
        );
        assert_eq!(
            persist_url("dismissed.w", None, "t k"),
            "cmux-cockpit://set?key=dismissed.w&token=t%20k"
        );
    }

    #[test]
    fn round_trips_a_move_through_a_description() {
        let m = SavedMove {
            text: "reply \"1a\".".into(),
            epoch: 1000.0,
            session: Some("s".into()),
            decisions: Some(1.0),
            ..SavedMove::default()
        };
        let d = move_description(&m);
        assert!(is_move_description(Some(&d)));
        assert_eq!(move_of_description(Some(&d)), Some(m));
        assert_eq!(move_of_description(Some("plain words")), None);
        assert!(!is_move_description(None));
    }

    #[test]
    fn writes_a_moves_fields_in_the_order_the_typescript_does() {
        let m = SavedMove {
            text: "go".into(),
            epoch: 1000.0,
            session: Some("s".into()),
            decisions: Some(1.0),
            ..SavedMove::default()
        };
        assert_eq!(
            move_description(&m),
            r#"go ⟦move {"epoch":1000,"session":"s","decisions":1}⟧"#
        );
    }

    #[test]
    fn refuses_a_move_with_a_bad_field() {
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"idle":false}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"session":null}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##"go ⟦move {"epoch":1,"decisions":10}⟧"##)),
            None
        );
        assert_eq!(
            move_of_description(Some(r##" go ⟦move {"epoch":1}⟧"##)),
            None
        );
        assert!(move_of_description(Some(r##"go ⟦move {"epoch":1,"leans":"1b 2a"}⟧"##)).is_some());
    }
}
