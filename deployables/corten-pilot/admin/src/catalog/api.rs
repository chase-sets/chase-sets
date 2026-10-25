//! The catalog authoring API (`/api/catalog`), as the signed-in staff member. Types hold only the
//! fields the screens read; they are also the screens' JSON for data clients.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use corten::prelude::ToJson;

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
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
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

/// `CatalogScopeRecordDetail` (features/scope-registry/ui/contracts.ts), the fields the scopes list
/// shows.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRecord {
    pub scope_record_id: String,
    pub product_domain: String,
    pub scope_kind: String,
    pub name: String,
    #[serde(default)]
    pub official_set_code: Option<String>,
    #[serde(default)]
    pub language_editions: Vec<String>,
    pub lifecycle_status: String,
    pub updated_at: String,
}

/// The Catalog attention queue (`CatalogAttentionQueueReadModel`, features/attention-queue): every
/// item that needs an operator, most important first, with the API's counts. The kinds and
/// severities are closed sets, so an answer with another one does not read and the page says the
/// queue is unavailable, as admin-web's `resolveCatalogAttentionQueueResult` does.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct AttentionQueue {
    pub generated_at: String,
    pub empty: bool,
    pub items: Vec<AttentionItem>,
    pub counts: AttentionCounts,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCounts {
    pub total: u32,
    pub by_severity: BySeverity,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct BySeverity {
    pub critical: u32,
    pub warning: u32,
    pub info: u32,
}

/// `CatalogAttentionItem`: its title and detail are the API's message keys and arguments.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub item_key: String,
    pub kind: AttentionKind,
    pub severity: Severity,
    pub title_key: String,
    #[serde(default)]
    pub title_params: BTreeMap<String, Value>,
    pub detail_key: String,
    #[serde(default)]
    pub detail_params: BTreeMap<String, Value>,
    pub provider_key: Option<String>,
    pub unit_key: Option<String>,
    pub observed_at: String,
    pub resolution: Resolution,
    #[serde(default)]
    pub secondary_resolutions: Vec<Resolution>,
}

/// An item's resolution: a drawer (its sheet, linking to `href`) or a one-click command.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub intent: String,
    pub mode: ResolutionMode,
    pub label_key: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub requires_reason: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionMode {
    Command,
    Drawer,
}

/// `CatalogAttentionItemKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionKind {
    UnmappedScope,
    MergeConflict,
    ProviderHealth,
    ImportJob,
    AliasCandidate,
    StaleScopeSync,
}

impl AttentionKind {
    /// The kind as the API names it (the dismiss and defer commands send it back).
    pub fn as_str(self) -> &'static str {
        match self {
            AttentionKind::UnmappedScope => "unmapped-scope",
            AttentionKind::MergeConflict => "merge-conflict",
            AttentionKind::ProviderHealth => "provider-health",
            AttentionKind::ImportJob => "import-job",
            AttentionKind::AliasCandidate => "alias-candidate",
            AttentionKind::StaleScopeSync => "stale-scope-sync",
        }
    }
}

/// `CatalogAttentionSeverity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

/// `DimensionDetail`: the dimension and its options.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct DimensionDetail {
    #[serde(flatten)]
    pub dimension: Dimension,
    #[serde(default)]
    pub options: Vec<DimensionOption>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
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
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedText {
    pub default_locale: String,
    pub values: BTreeMap<String, String>,
}

/// `Field` (features/fields/ui/contracts.ts).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
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
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
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
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintRef {
    pub blueprint_id: String,
    pub name: String,
}

/// `CatalogItemDetail` (features/catalog-items/ui/contracts.ts), the fields the item's page shows,
/// and the title and subtitle in each locale, which a metadata revision sends back as they are.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct ItemDetail {
    pub catalog_item_id: String,
    pub language_code: String,
    #[serde(default)]
    pub title_i18n: Value,
    pub title: String,
    #[serde(default)]
    pub subtitle_i18n: Value,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub display_identity_publication: Option<Readiness>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub blueprint: Option<BlueprintRef>,
    pub status: String,
    #[serde(default)]
    pub field_values: Vec<FieldValue>,
    #[serde(default)]
    pub categories: Vec<CategoryRef>,
    #[serde(default)]
    pub external_catalog_item_references: Vec<ExternalRef>,
    #[serde(default)]
    pub external_product_references: Vec<ExternalRef>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub image_fallback: Option<ImageFallback>,
    pub updated_at: String,
}

/// `DisplayIdentityPublicationReadiness`: whether the item's display identity lets it publish.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Readiness {
    pub status: String,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub missing_tokens: Vec<String>,
    #[serde(default)]
    pub retryable: bool,
}

impl Readiness {
    /// What the page says when the API has none (admin-web's fallback).
    pub fn unavailable() -> Self {
        Readiness {
            status: "unavailable".into(),
            reason_code: Some("display-identity-unavailable".into()),
            missing_tokens: Vec::new(),
            retryable: true,
        }
    }
}

/// A field's value on the item, and the reference record it names, if it is a reference.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    pub field_id: String,
    #[serde(default)]
    pub field_name: String,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub reference: Option<Reference>,
}

/// `CatalogReferenceRecordRef`: a reference record and the records it relates to.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub reference_id: String,
    pub type_key: String,
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub attributes: Value,
    #[serde(default)]
    pub relationships: Vec<Relationship>,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub relationship_type: String,
    pub reference_id: String,
    #[serde(default)]
    pub reference: Option<Box<Reference>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRef {
    pub category_id: String,
    pub name: String,
}

/// An external reference: a provider's key for the item (a catalog item reference), or for one
/// of its products, with the options that pick it (a product reference).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRef {
    pub provider_key: String,
    pub external_key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_options: Vec<SelectedOption>,
}

/// A dimension's option (`ProductContentSelectedOption`, and a product reference's options).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedOption {
    pub dimension_id: String,
    pub option_id: String,
}

/// `CatalogItemImageFallback`.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct ImageFallback {
    pub url: String,
    pub alt: String,
    pub usage: String,
    #[serde(default)]
    pub variants: Value,
}

/// `ProductContentLineDetail`: a line of what a product contains, resolved to a catalog item or
/// left as the provider's evidence.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ContentLine {
    pub line_id: String,
    pub container_catalog_item_id: String,
    #[serde(default)]
    pub container_selected_options: Option<Vec<SelectedOption>>,
    #[serde(default)]
    pub contained_catalog_item_id: Option<String>,
    #[serde(default)]
    pub contained_selected_options: Option<Vec<SelectedOption>>,
    #[serde(default)]
    pub quantity: Option<f64>,
    pub content_type_id: String,
    #[serde(default)]
    pub inclusion_policy_id: Option<String>,
    #[serde(default)]
    pub provenance: Value,
    pub resolution_status: String,
}

/// `ProductContentTypeRef` and `ProductContentInclusionPolicyRef`: a choice for a content line.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct ContentChoice {
    #[serde(alias = "content_type_id", alias = "inclusion_policy_id")]
    pub id: String,
    pub key: String,
    #[serde(default)]
    pub display_name: Value,
    pub status: String,
}

/// A reference record, as a field value's picker lists it (`ReferenceRecord`, the fields shown).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReferenceRow {
    pub reference_record_id: String,
    pub type_key: String,
    pub key: String,
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
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
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
    ProductContents,
    ReferenceRecords,
    ScopeRecords,
    AttentionQueue,
    AliasReview,
}

impl Kind {
    fn path(self) -> &'static str {
        match self {
            Kind::Dimensions => "dimensions",
            Kind::Fields => "fields",
            Kind::Items => "items",
            Kind::ProductContents => "product-contents",
            Kind::ReferenceRecords => "reference-records",
            Kind::ScopeRecords => "scope-records",
            Kind::AttentionQueue => "attention-queue",
            Kind::AliasReview => "alias-review",
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
    /// A read of `/api/catalog/{kind}{rest}`, `rest` encoded by the caller (`under`).
    async fn read_at<T: DeserializeOwned>(&self, kind: Kind, rest: &str) -> Result<T, ApiError>;
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

    async fn read_at<T: DeserializeOwned>(&self, kind: Kind, rest: &str) -> Result<T, ApiError> {
        self.read(&format!("{API}/{}{rest}", kind.path()), CATALOG).await
    }
}

/// `/{id}` and more segments, each encoded.
pub fn under(id: &str, rest: &[&str]) -> String {
    std::iter::once(id).chain(rest.iter().copied()).map(|s| format!("/{}", segment(s))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page's script reads a dimension's fields beside its options, as the API sends them.
    #[test]
    fn a_dimension_detail_is_written_as_serde_writes_it() {
        let detail = DimensionDetail {
            dimension: Dimension {
                dimension_id: "dim_1".into(),
                key: "grade".into(),
                name: "Grade".into(),
                description: None,
                value_kind: "numeric".into(),
                status: "active".into(),
                updated_at: "2026-10-25T00:00:00Z".into(),
            },
            options: vec![DimensionOption {
                option_id: "chc_1".into(),
                code: "nm".into(),
                label: "Near Mint".into(),
                label_i18n: Some(LocalizedText {
                    default_locale: "en".into(),
                    values: BTreeMap::from([("en".into(), "Near Mint".into())]),
                }),
                display_order: 1,
                numeric_value: Some(9.5),
                status: "active".into(),
            }],
        };
        let derived: serde_json::Value = serde_json::from_str(&detail.to_json()).unwrap();
        assert_eq!(derived, serde_json::to_value(&detail).unwrap());
    }
}
