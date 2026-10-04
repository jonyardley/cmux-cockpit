//! Reading JSON the way the TypeScript reads it: one field at a time. The
//! TypeScript survives a value of the wrong type by misreading only that
//! field, so here a field, list entry or map entry that does not fit reads
//! as missing (or is dropped) instead of failing the whole document.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// A field that does not fit its type reads as its default.
pub fn field<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let raw = Value::deserialize(d)?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

/// A list whose entries that do not fit are dropped; anything but an array reads as none.
pub fn list<'de, D, T>(d: D) -> Result<Option<Vec<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let Value::Array(items) = Value::deserialize(d)? else {
        return Ok(None);
    };
    Ok(Some(
        items
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect(),
    ))
}

/// A list whose entries that do not fit (a null among them) are kept as
/// holes, so its length stays what cmux sent.
pub fn slots<'de, D, T>(d: D) -> Result<Option<Vec<Option<T>>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let Value::Array(items) = Value::deserialize(d)? else {
        return Ok(None);
    };
    Ok(Some(
        items
            .into_iter()
            .map(|v| serde_json::from_value(v).ok())
            .collect(),
    ))
}

/// An object whose entries that do not fit are dropped; anything but an object reads as empty.
pub fn map<'de, D, V>(d: D) -> Result<BTreeMap<String, V>, D::Error>
where
    D: Deserializer<'de>,
    V: DeserializeOwned,
{
    let Value::Object(entries) = Value::deserialize(d)? else {
        return Ok(BTreeMap::new());
    };
    Ok(entries
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|v| (k, v)))
        .collect())
}
