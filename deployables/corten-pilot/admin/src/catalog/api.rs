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

/// `CatalogItemListItem` (features/catalog-items/ui/contracts.ts), the fields the list shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ItemRow {
    pub catalog_item_id: String,
    pub language_code: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub blueprint: Option<BlueprintRef>,
    pub status: String,
    #[serde(default)]
    pub source_providers: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub updated_at: String,
}

/// `BlueprintRef`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintRef {
    pub blueprint_id: String,
    pub name: String,
}

/// `BulkPublishCandidate`: an item a bulk publish takes, what it would do (`ready`, `blocked`)
/// or did (`published`, `failed`, `skipped`) and why; `retryable` when publishing it again
/// may succeed (its display identity was not resolved yet).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PublishCandidate {
    pub catalog_item_id: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub source_providers: Vec<String>,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub retryable: bool,
}

/// `BulkPublishPreview`. The confirm takes its `item_ids`, not the selection.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PublishPreview {
    #[serde(default)]
    pub item_ids: Vec<String>,
    pub total: u32,
    pub ready_count: u32,
    pub blocked_count: u32,
    #[serde(default)]
    pub candidates: Vec<PublishCandidate>,
}

/// `BulkPublishResult`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PublishOutcome {
    pub total: u32,
    pub published_count: u32,
    pub failed_count: u32,
    pub skipped_count: u32,
    #[serde(default)]
    pub candidates: Vec<PublishCandidate>,
}

/// `BulkEditCatalogItemCandidate`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EditCandidate {
    pub catalog_item_id: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub blueprint_id: Option<String>,
    #[serde(default)]
    pub category_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `BulkEditCatalogItemPreview`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EditPreview {
    pub action: String,
    pub total: u32,
    pub ready_count: u32,
    pub blocked_count: u32,
    #[serde(default)]
    pub candidates: Vec<EditCandidate>,
}

/// `BulkEditCatalogItemResult`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EditOutcome {
    pub action: String,
    pub total: u32,
    pub succeeded_count: u32,
    pub skipped_count: u32,
    pub failed_count: u32,
    #[serde(default)]
    pub candidates: Vec<EditCandidate>,
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

/// A bulk change's job (`CatalogAuthoringBulkJob<T>`): queued, running, then completed with its
/// outcome or failed with a message. The outcome's shape is the kind's: a lifecycle change's
/// [`Outcome`], a catalog item publish's [`PublishOutcome`], an item edit's [`EditOutcome`].
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(bound(deserialize = "R: Deserialize<'de>", serialize = "R: Serialize"))]
pub struct Job<R = Outcome> {
    pub job_id: String,
    pub kind: String,
    pub action: String,
    pub status: String,
    pub progress: Progress,
    #[serde(default = "none")]
    pub result: Option<R>,
    #[serde(default)]
    pub error_message: Option<String>,
}

fn none<R>() -> Option<R> {
    None
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

/// The job kinds of a catalog item bulk change.
pub const ITEMS_PUBLISH: &str = "catalog.authoring.items.publish";
pub const ITEMS_EDIT: &str = "catalog.authoring.items.edit";

impl<R> Job<R> {
    /// Done: completed or failed. Its stream sends nothing after.
    pub fn done(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }

    /// The kind of record the job changes, when it is one the area edits.
    pub fn of(&self) -> Option<Kind> {
        match self.kind.as_str() {
            "catalog.authoring.dimensions.lifecycle" => Some(Kind::Dimensions),
            "catalog.authoring.fields.lifecycle" => Some(Kind::Fields),
            "catalog.authoring.items.lifecycle" | ITEMS_PUBLISH | ITEMS_EDIT => Some(Kind::Items),
            _ => None,
        }
    }
}

impl Job<Value> {
    /// The job with its outcome read as `S` (none when it is not one).
    pub fn read<S: DeserializeOwned>(&self) -> Job<S> {
        Job {
            job_id: self.job_id.clone(),
            kind: self.kind.clone(),
            action: self.action.clone(),
            status: self.status.clone(),
            progress: self.progress.clone(),
            result: self.result.clone().and_then(|result| serde_json::from_value(result).ok()),
            error_message: self.error_message.clone(),
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
    Items,
}

impl Kind {
    fn path(self) -> &'static str {
        match self {
            Kind::Dimensions => "dimensions",
            Kind::Fields => "fields",
            Kind::Items => "items",
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
    /// A `POST` to `/api/catalog/{kind}{rest}` that answers with `T`: a catalog item bulk
    /// change's preview, or its job.
    async fn post<T: DeserializeOwned>(&self, kind: Kind, rest: &str, body: &Value) -> Result<T, ApiError>;
    async fn job<R: DeserializeOwned>(&self, id: &str) -> Result<Job<R>, ApiError>;
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

    async fn post<T: DeserializeOwned>(&self, kind: Kind, rest: &str, body: &Value) -> Result<T, ApiError> {
        let req = self.request(Method::POST, &format!("{API}/{}{rest}", kind.path()), CATALOG);
        let (answer, _) = self.write(req.json(body)).await?;
        Ok(answer)
    }

    async fn job<R: DeserializeOwned>(&self, id: &str) -> Result<Job<R>, ApiError> {
        self.read(&format!("{API}/bulk-authoring-jobs/{}", segment(id)), CATALOG).await
    }
}

/// `/{id}` and more segments, each encoded.
pub fn under(id: &str, rest: &[&str]) -> String {
    std::iter::once(id).chain(rest.iter().copied()).map(|s| format!("/{}", segment(s))).collect()
}
