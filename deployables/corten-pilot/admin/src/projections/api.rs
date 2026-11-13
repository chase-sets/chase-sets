//! Projection Operations as the platform API answers it (`GET /api/platform/projections`,
//! `ProjectionOperationsSnapshot` and its triage in bounded-contexts/platform-operations), as far as the page
//! uses it. The API derives the attention items, the repair queue and the worker counts
//! (`deriveProjectionTriage`); the page draws what it sent.
use corten::prelude::*;
use reqwest::Method;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

pub use crate::api::ApiError;
use crate::api::Caller;

pub const PATH: &str = "/api/platform/projections";
pub const CONTEXT: &str = "platform-operations";

/// The console's read: the groups, the operations, the workers and the API's triage of them.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub summary: Summary,
    #[serde(default)]
    pub projection_groups: Vec<Group>,
    #[serde(default)]
    pub blocked_projections: Vec<Blocked>,
    #[serde(default)]
    pub workers: Vec<Map<String, Value>>,
    pub worker_heartbeat_history: HeartbeatHistory,
    #[serde(default)]
    pub runners: Vec<Map<String, Value>>,
    #[serde(default)]
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub operation_summary: Option<OperationSummary>,
    #[serde(default = "runtime_memory")]
    pub projection_status_source: String,
    pub attention_items: Vec<AttentionItem>,
    pub repair_queue: Vec<RepairItem>,
    pub active_worker_count: u32,
    pub stale_worker_count: u32,
}

/// admin-web's default for a read without a source (`normalizeProjectionOperationsSnapshot`).
fn runtime_memory() -> String {
    "runtime-memory".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    #[serde(default)]
    pub total_groups: u32,
    #[serde(default)]
    pub caught_up_groups: u32,
    #[serde(default)]
    pub behind_groups: u32,
    #[serde(default)]
    pub error_groups: u32,
    #[serde(default)]
    pub running_groups: u32,
    /// A count as decimal text: it can pass 2^53.
    #[serde(default)]
    pub outstanding_event_count: Count,
}

/// A count the API sends as text (Postgres `bigint`) or as a number.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson, PartialEq, Eq)]
#[serde(from = "Value")]
pub struct Count(pub String);

impl From<Value> for Count {
    fn from(value: Value) -> Self {
        match value {
            Value::String(text) => Count(text),
            Value::Number(n) => Count(n.to_string()),
            _ => Count("0".into()),
        }
    }
}

impl Count {
    pub fn is_positive(&self) -> bool {
        self.0.trim().parse::<f64>().is_ok_and(|n| n > 0.0)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub projection_name: String,
    #[serde(default)]
    pub projection_revision: i64,
    #[serde(default)]
    pub stored_projection_revision: Option<i64>,
    pub target_context_name: String,
    #[serde(default)]
    pub source_context_names: Vec<String>,
    #[serde(default)]
    pub owned_tables: Vec<String>,
    #[serde(default)]
    pub required_during_bootstrap: bool,
    #[serde(default)]
    pub initialized: bool,
    #[serde(default)]
    pub caught_up: bool,
    pub state: String,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub outstanding_event_count: Count,
    #[serde(default)]
    pub source_lag_event_count: Option<Count>,
    #[serde(default)]
    pub applicable_lag_estimate: Option<Count>,
    #[serde(default)]
    pub blocked_stream_count: u32,
    #[serde(default)]
    pub poison_event_count: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub subscriptions: Vec<Subscription>,
}

impl Group {
    /// The id the page selects it by (admin-web's `groupId`), which is also its repair item's target.
    pub fn id(&self) -> String {
        format!("{}:{}", self.target_context_name, self.projection_name)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub checkpoint_key: String,
    pub source_context_name: String,
    pub target_context_name: String,
    #[serde(default)]
    pub subscription_version: i64,
    #[serde(default)]
    pub last_global_position: Count,
    #[serde(default)]
    pub source_head_global_position: Count,
    #[serde(default)]
    pub outstanding_event_count: Count,
    #[serde(default)]
    pub source_lag_event_count: Option<Count>,
    #[serde(default)]
    pub applicable_lag_estimate: Option<Count>,
    pub state: String,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub blocked_stream_count: u32,
    #[serde(default)]
    pub poison_event_count: u32,
}

/// A projection with blocked streams or poison events. The projections read sends only its counts
/// (chase-sets/chase-sets#10710); its details come from its own read ([`blocked`]).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub projection_key: String,
    #[serde(default)]
    pub blocked_streams: Vec<BlockedStream>,
    #[serde(default)]
    pub poison_events: Vec<PoisonEvent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct BlockedStream {
    pub stream_id: String,
    #[serde(default)]
    pub first_blocked_global_position: Count,
    #[serde(default)]
    pub first_blocked_stream_version: i64,
    #[serde(default)]
    pub last_seen_global_position: Count,
    #[serde(default)]
    pub deferred_event_count: u64,
    #[serde(default)]
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct PoisonEvent {
    pub event_id: String,
    pub event_type: String,
    pub stream_id: String,
    #[serde(default)]
    pub stream_version: i64,
    #[serde(default)]
    pub global_position: Count,
    #[serde(default)]
    pub error_message: String,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub first_seen_at: String,
    #[serde(default)]
    pub last_seen_at: String,
    #[serde(default)]
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatHistory {
    #[serde(default)]
    pub expired_within_diagnostic_window_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: String,
    pub operation_kind: String,
    pub state: String,
    pub context_name: String,
    #[serde(default)]
    pub projection_name: Option<String>,
    #[serde(default)]
    pub projection_key: Option<String>,
    #[serde(default)]
    pub stream_id: Option<String>,
    #[serde(default)]
    pub requested_by_user_id: Option<String>,
    #[serde(default)]
    pub claim_owner_id: Option<String>,
    pub requested_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub error: Option<Map<String, Value>>,
}

impl Operation {
    /// Still moving: its stream has more to say (admin-web's `isLiveProjectionOperation`).
    pub fn live(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "running" | "cancel_requested")
    }

    /// Done: the stream's last record (`isTerminalProjectionOperation`).
    pub fn terminal(&self) -> bool {
        matches!(self.state.as_str(), "succeeded" | "failed" | "cancelled")
    }

    /// What it works on: its projection, key or stream, if any.
    pub fn target(&self) -> Option<&str> {
        self.projection_name.as_deref().or(self.projection_key.as_deref()).or(self.stream_id.as_deref())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct OperationSummary {
    #[serde(default)]
    pub queued_count: Count,
    #[serde(default)]
    pub running_count: Count,
    #[serde(default)]
    pub failed_count: Count,
    #[serde(default)]
    pub oldest_queued_at: Option<String>,
    #[serde(default)]
    pub oldest_running_at: Option<String>,
}

/// A signal the API raised, in its own words (English: admin-web draws them as sent).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct AttentionItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub detail: String,
    pub tone: Tone,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToJson, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Danger,
    Warning,
    Accent,
}

/// Something to repair, most urgent first, as the API ordered it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct RepairItem {
    pub kind: String,
    pub target_id: String,
    pub label: String,
    #[serde(default)]
    pub detail: String,
    pub state: String,
    pub tone: Tone,
    #[serde(default)]
    pub context_name: Option<String>,
    #[serde(default)]
    pub projection_name: Option<String>,
    #[serde(default)]
    pub projection_key: Option<String>,
    #[serde(default)]
    pub stream_id: Option<String>,
}

/// The wake pipeline's read, as far as the page uses it: its attention items.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub attention_items: Vec<AttentionItem>,
}

/// What a write queued (202 `{ operation }`).
#[derive(Clone, Debug, Deserialize)]
struct Queued {
    operation: Operation,
}

/// The console, as the signed-in staff member.
pub async fn read(caller: &Caller<'_>) -> Result<Snapshot, ApiError> {
    caller.read(PATH, CONTEXT).await
}

/// The wake pipeline's attention items, or none when the read fails or predates them: admin-web
/// draws the console without them then (`loadWakeStatusConsoleSnapshot`).
pub async fn wake(caller: &Caller<'_>) -> Option<Wake> {
    match caller.read::<Wake>(&format!("{PATH}/wake-status"), CONTEXT).await {
        Ok(wake) => Some(wake),
        Err(error) => {
            tracing::info!("wake status unavailable: {error}");
            None
        }
    }
}

/// A projection's blocked streams and poison events (`GET /{projectionKey}/blocked-streams`).
pub async fn blocked(caller: &Caller<'_>, projection_key: &str) -> Result<Blocked, ApiError> {
    caller.read(&format!("{PATH}/{}/blocked-streams", crate::api::segment(projection_key)), CONTEXT).await
}

/// The path of an operation's status stream.
pub fn operation_events(id: &str) -> String {
    format!("{PATH}/operations/{}/events", crate::api::segment(id))
}

/// A write: `POST` to `segments` under the console's path with `body`, and its answer.
async fn post<T: DeserializeOwned>(caller: &Caller<'_>, segments: &[&str], body: Value) -> Result<T, ApiError> {
    let path: String = segments.iter().map(|s| format!("/{}", crate::api::segment(s))).collect();
    let req = caller.request(Method::POST, &format!("{PATH}{path}"), CONTEXT).json(&body);
    caller.write(req).await.map(|(answer, _)| answer)
}

/// Reads the groups' status again now (`POST /refresh`).
pub async fn refresh(caller: &Caller<'_>) -> Result<(), ApiError> {
    post::<Value>(caller, &["refresh"], json!({})).await.map(drop)
}

pub async fn retry_stream(caller: &Caller<'_>, projection_key: &str, stream_id: &str) -> Result<Operation, ApiError> {
    post::<Queued>(caller, &[projection_key, "blocked-streams", stream_id, "retry"], json!({})).await.map(|q| q.operation)
}

pub async fn rebuild_group(caller: &Caller<'_>, context: &str, projection: &str) -> Result<Operation, ApiError> {
    post::<Queued>(caller, &["groups", context, projection, "rebuild"], json!({ "confirm": "rebuild" }))
        .await
        .map(|q| q.operation)
}

pub async fn rebuild_context(caller: &Caller<'_>, context: &str) -> Result<Operation, ApiError> {
    post::<Queued>(caller, &["groups", context, "rebuild"], json!({ "confirm": "rebuild-all" })).await.map(|q| q.operation)
}

pub async fn cancel(caller: &Caller<'_>, operation_id: &str) -> Result<(), ApiError> {
    post::<Value>(caller, &["operations", operation_id, "cancel"], json!({})).await.map(drop)
}
