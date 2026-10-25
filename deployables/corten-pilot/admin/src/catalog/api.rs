//! The catalog authoring API (`/api/catalog`), as the signed-in staff member. Types hold only the
//! fields the screens read; they are also the screens' JSON for data clients.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::api::{ApiError, Caller, Method, segment};
use platform::receipt::Receipt;

const CATALOG: &str = "catalog";
const API: &str = "/api/catalog";

/// A page of a list (`ListResponse`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct List<T> {
    pub items: Vec<T>,
    #[serde(default)]
    pub total: u32,
}

/// `Dimension` (features/dimensions/ui/contracts.ts), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Dimension {
    pub dimension_id: String,
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub value_kind: String,
    pub status: String,
    pub updated_at: String,
}

/// `DimensionDetail`: the dimension and its options.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DimensionDetail {
    #[serde(flatten)]
    pub dimension: Dimension,
    #[serde(default)]
    pub options: Vec<DimensionOption>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DimensionOption {
    pub option_id: String,
    pub code: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub label_i18n: Option<LocalizedText>,
    pub display_order: i64,
    pub numeric_value: Option<f64>,
    pub status: String,
}

/// A `LocalizedTextMap`: the default locale and a text per locale.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedText {
    pub default_locale: String,
    pub values: BTreeMap<String, String>,
}

/// `Field` (features/fields/ui/contracts.ts).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Field {
    pub field_id: String,
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub status: String,
    pub value_type: String,
    pub filterable: bool,
    pub searchable: bool,
    pub sortable: bool,
    pub updated_at: String,
}

/// One record of a bulk change: what it is, its status, and what the change does to it
/// (`BulkLifecycleCandidate`: `ready` or `blocked` in a preview; `succeeded`, `skipped` or
/// `failed` in a result) and why.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Candidate {
    pub id: String,
    pub label: String,
    pub status: String,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// What a bulk change would do (`BulkLifecyclePreview`). The API decides which records are ready.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Preview {
    pub action: String,
    #[serde(default)]
    pub ids: Vec<String>,
    pub total: u32,
    pub ready_count: u32,
    pub blocked_count: u32,
    #[serde(default)]
    pub candidates: Vec<Candidate>,
}

/// What a bulk change did (`BulkLifecycleResult`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Outcome {
    pub action: String,
    pub total: u32,
    pub succeeded_count: u32,
    pub skipped_count: u32,
    pub failed_count: u32,
    #[serde(default)]
    pub candidates: Vec<Candidate>,
}

/// A bulk change's job (`CatalogAuthoringBulkJob`): queued, running, then completed with its
/// outcome or failed with a message.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    pub kind: String,
    pub action: String,
    pub status: String,
    pub progress: Progress,
    #[serde(default)]
    pub result: Option<Outcome>,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub completed: u32,
    pub total: u32,
    #[serde(default)]
    pub current_name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

impl Job {
    /// Done: completed or failed. Its stream sends nothing after.
    pub fn done(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }

    /// The kind of record the job changes, when it is one the area edits.
    pub fn of(&self) -> Option<Kind> {
        match self.kind.as_str() {
            "catalog.authoring.dimensions.lifecycle" => Some(Kind::Dimensions),
            "catalog.authoring.fields.lifecycle" => Some(Kind::Fields),
            _ => None,
        }
    }
}

/// A job's status stream (`/bulk-authoring-jobs/{id}/events`), for `Caller::watch_job`.
pub fn job_events(id: &str) -> String {
    format!("{API}/bulk-authoring-jobs/{}/events", segment(id))
}

/// The context the catalog's reads name (`chase-sets-read-target-context`).
pub const CONTEXT: &str = CATALOG;

/// A write the API accepted: the receipt the next read waits for.
pub struct Written {
    pub receipt: Option<Receipt>,
}

/// The kinds the catalog area edits, by their API path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dimensions,
    Fields,
}

impl Kind {
    fn path(self) -> &'static str {
        match self {
            Kind::Dimensions => "dimensions",
            Kind::Fields => "fields",
        }
    }
}

/// The catalog calls. A trait because the caller is the shared crate's.
pub trait Catalog {
    /// A page of `kind`, with the list's query (`search=..&status=..&limit=50&offset=0`).
    async fn list<T: DeserializeOwned>(&self, kind: Kind, query: &str) -> Result<List<T>, ApiError>;
    async fn get<T: DeserializeOwned>(&self, kind: Kind, id: &str) -> Result<T, ApiError>;
    /// A command: `POST` or `PUT` to `/api/catalog/{kind}{rest}` with `body` (`rest` starts with
    /// `/`, or is empty for a create).
    async fn command(&self, method: Method, kind: Kind, rest: &str, body: Option<&Value>) -> Result<Written, ApiError>;
    /// What a bulk change of `kind` would do: `body` is `{ action, selection }`.
    async fn bulk_preview(&self, kind: Kind, body: &Value) -> Result<Preview, ApiError>;
    /// Starts a bulk change of `kind`: its job (202), which runs it.
    async fn bulk_confirm(&self, kind: Kind, body: &Value) -> Result<Job, ApiError>;
    async fn job(&self, id: &str) -> Result<Job, ApiError>;
}

impl Catalog for Caller<'_> {
    async fn list<T: DeserializeOwned>(&self, kind: Kind, query: &str) -> Result<List<T>, ApiError> {
        self.read(&format!("{API}/{}?{query}", kind.path()), CATALOG).await
    }

    async fn get<T: DeserializeOwned>(&self, kind: Kind, id: &str) -> Result<T, ApiError> {
        self.read(&format!("{API}/{}/{}", kind.path(), segment(id)), CATALOG).await
    }

    async fn command(&self, method: Method, kind: Kind, rest: &str, body: Option<&Value>) -> Result<Written, ApiError> {
        let mut req = self.request(method, &format!("{API}/{}{rest}", kind.path()), CATALOG);
        if let Some(body) = body {
            req = req.json(body);
        }
        let (_, receipt): (Value, _) = self.write(req).await?;
        Ok(Written { receipt })
    }

    async fn bulk_preview(&self, kind: Kind, body: &Value) -> Result<Preview, ApiError> {
        let req = self.request(Method::POST, &format!("{API}/{}/bulk-lifecycle/preview", kind.path()), CATALOG);
        let (preview, _) = self.write(req.json(body)).await?;
        Ok(preview)
    }

    async fn bulk_confirm(&self, kind: Kind, body: &Value) -> Result<Job, ApiError> {
        let req = self.request(Method::POST, &format!("{API}/{}/bulk-lifecycle/confirm", kind.path()), CATALOG);
        let (job, _) = self.write(req.json(body)).await?;
        Ok(job)
    }

    async fn job(&self, id: &str) -> Result<Job, ApiError> {
        self.read(&format!("{API}/bulk-authoring-jobs/{}", segment(id)), CATALOG).await
    }
}

/// `/{id}` and more segments, each encoded.
pub fn under(id: &str, rest: &[&str]) -> String {
    std::iter::once(id).chain(rest.iter().copied()).map(|s| format!("/{}", segment(s))).collect()
}
