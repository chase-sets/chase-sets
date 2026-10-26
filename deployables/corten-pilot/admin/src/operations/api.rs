//! The Operations Attention queue as the platform API answers it (`GET /api/platform/operations-attention`,
//! `OperationsAttentionQueue` in bounded-contexts/platform-operations), as far as the page uses it.
//! The API composes the sources, drops the ones the caller may not see, orders the items and counts
//! them; the page only draws what it sent.
use corten::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::api::{ApiError, Caller};

pub const PATH: &str = "/api/platform/operations-attention";
pub const CONTEXT: &str = "platform-operations";

/// The queue: its items in the API's order, their counts, and each source's health.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub items: Vec<Item>,
    pub rollup: Rollup,
    pub sources: Vec<SourceHealth>,
    pub degraded: bool,
}

/// A closed set, as the read model's: an answer with another severity does not read.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToJson, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub source: String,
    pub severity: Severity,
    pub summary: Summary,
    pub deep_link: DeepLink,
    #[serde(default)]
    pub due_at: Option<String>,
    pub observed_at: String,
}

/// An item's words: a code the page has a message for, and the message's arguments.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Summary {
    pub code: String,
    #[serde(default)]
    pub params: Map<String, Value>,
}

/// Where an item is resolved: the admin surface and its path in admin-web.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct DeepLink {
    pub surface: String,
    pub href: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Rollup {
    pub total: u32,
    pub by_severity: BySeverity,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct BySeverity {
    pub critical: u32,
    pub warning: u32,
    pub info: u32,
}

/// A source the API read, or could not (`reason` says why).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct SourceHealth {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

impl SourceHealth {
    pub fn unavailable(&self) -> bool {
        self.status == "unavailable"
    }
}

/// The queue, as the signed-in staff member.
pub async fn read(caller: &Caller<'_>) -> Result<Queue, ApiError> {
    caller.read(PATH, CONTEXT).await
}
