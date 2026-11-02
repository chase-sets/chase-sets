//! Catalog > Scope Sync Batches (admin-web's `ScopeSyncBatchPage`, `/catalog/scopes/sync-batches`):
//! resolve a held-set export into scopes, preview a bounded sync of the scopes a selection
//! resolves to, confirm and follow the batch, and quote and buy Scrydex counts, through the Catalog
//! API (`/api/catalog/scope-sync-batches`) as the signed-in staff member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes/sync-batches?batch_id&quote_id` | the page, with the batch and the count quote the address names |
//! | `POST /catalog/scopes/sync-batches` | the form's `intent`: Preview batch, Quote count acquisition and Approve count acquisition answer with the page; Confirm and enqueue, Cancel batch, Resume batch and Retry unit go to the batch |
//! | `POST /catalog/scopes/sync-batches/held-sets` | Resolve held sets (`multipart/form-data`): the page with what resolved |
//!
//! Like admin-web's action, a refused or failed command is the page's banner, the form as it was
//! sent. A queued or running batch's page is read again every two seconds (admin-web revalidates
//! on the same interval), with or without JavaScript. The count commands send the browser's
//! `Origin` and `Sec-Fetch-Site` as admin-web's client does: the API refuses a count command from
//! another origin. admin-web's staging count-capture steps (the `countCapture` marker, a JSON
//! protocol for scripts/catalog-staging-count-lifecycle.mjs against admin-web on staging) are not
//! served here.
use std::time::Duration;

use bytes::Bytes;
use corten::{
    Upload, UploadError,
    axum::http::{HeaderMap, StatusCode, header},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{manages, views};
use crate::{
    api::{ApiError, Caller, Method, segment},
    app::{Refusal, Shared, read_failed, refusal, sign_in},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

const PATH: &str = "/api/catalog/scope-sync-batches";
const CATALOG: &str = "catalog";

/// What a held-set export may send: the API's `heldSetExportContract` (16 MiB) and its
/// multipart framing (64 KiB).
const HELD_SET_BYTES: usize = 16_777_216;
const FRAMING_BYTES: usize = 65_536;

#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use serde::Deserialize;

    /// The batch and the count quote the page shows.
    #[derive(Clone, Debug, Default, Deserialize, corten::Fields, corten::Route)]
    #[route(query)]
    pub struct BatchQuery {
        pub batch_id: Option<String>,
        pub quote_id: Option<String>,
    }

    #[derive(Default)]
    #[route("/catalog/scopes/sync-batches", get = crate::catalog::sync_batches::page, post = crate::catalog::sync_batches::act)]
    pub struct SyncBatches {
        #[route(query)]
        pub query: BatchQuery,
    }

    #[route("/catalog/scopes/sync-batches/held-sets", post = crate::catalog::sync_batches::held_sets)]
    pub struct HeldSets;
}

impl url::SyncBatches {
    /// The page following `batch`.
    pub fn batch(batch: &str) -> Self {
        url::SyncBatches { query: url::BatchQuery { batch_id: Some(batch.to_owned()), quote_id: None } }
    }

    /// The page with count quote `quote`.
    pub fn quote(quote: &str) -> Self {
        url::SyncBatches { query: url::BatchQuery { batch_id: None, quote_id: Some(quote.to_owned()) } }
    }
}

/// The batch form, and every command's fields, in admin-web's names (snake case). Each is the text
/// sent; numbers are read as admin-web's `numberValue` reads them.
#[derive(Clone, Debug, Default, Deserialize, Serialize, Fields, ToJson)]
#[serde(default)]
pub struct BatchInput {
    pub intent: String,
    pub selection_mode: String,
    pub product_domain: String,
    pub scope_kind: String,
    pub language_code: String,
    pub scope_record_ids: String,
    pub max_scopes_per_turn: String,
    pub default_provider_concurrency: String,
    pub scrydex_concurrency: String,
    pub tcgdex_request_limit: String,
    pub scrydex_rate_request_limit: String,
    pub scrydex_request_limit: String,
    pub provider_failure_threshold: String,
    pub count_cap: String,
    pub plan_fingerprint: String,
    pub quote_id: String,
    pub count_fingerprint: String,
    pub batch_id: String,
    pub scope_record_id: String,
}

impl BatchInput {
    /// The New batch form as admin-web first draws it.
    pub fn blank() -> Self {
        BatchInput {
            selection_mode: "matching-scope".into(),
            product_domain: "pokemon".into(),
            scope_kind: "set".into(),
            language_code: "en".into(),
            max_scopes_per_turn: "1".into(),
            default_provider_concurrency: "1".into(),
            scrydex_concurrency: "1".into(),
            tcgdex_request_limit: "1000".into(),
            scrydex_rate_request_limit: "1000".into(),
            scrydex_request_limit: "0".into(),
            provider_failure_threshold: "3".into(),
            count_cap: "0".into(),
            ..Default::default()
        }
    }

    /// The selection the form names (admin-web's `previewRequest`): explicit ids, comma-separated,
    /// or the scopes matching its domain, kind and language.
    pub fn selection(&self) -> Value {
        if self.selection_mode.trim() == "ids" {
            let ids: Vec<&str> = self.scope_record_ids.split(',').map(str::trim).filter(|id| !id.is_empty()).collect();
            json!({ "mode": "ids", "scopeRecordIds": ids })
        } else {
            fn optional(value: &str) -> Option<&str> {
                Some(value.trim()).filter(|v| !v.is_empty())
            }
            json!({
                "mode": "matching-scope",
                "query": {
                    "productDomain": optional(&self.product_domain),
                    "scopeKind": optional(&self.scope_kind),
                    "languageCode": optional(&self.language_code),
                },
            })
        }
    }

    /// The budget the form names (admin-web's `previewRequest`).
    pub fn budget(&self) -> Value {
        json!({
            "maxScopesPerTurn": number(&self.max_scopes_per_turn, 1),
            "defaultProviderConcurrency": number(&self.default_provider_concurrency, 1),
            "providerConcurrency": { "scrydex": number(&self.scrydex_concurrency, 1) },
            "providerRequestLimits": {
                "tcgdex": number(&self.tcgdex_request_limit, 0),
                "scrydex": number(&self.scrydex_rate_request_limit, 0),
            },
            "creditedProviderRequestLimits": { "scrydex": number(&self.scrydex_request_limit, 0) },
            "providerFailureThreshold": number(&self.provider_failure_threshold, 3),
        })
    }
}

/// A number as admin-web's `numberValue` reads it: `Number(text)` when that is an integer (so empty
/// text is 0), else `fallback`.
pub fn number(text: &str, fallback: i64) -> i64 {
    let text = text.trim();
    if text.is_empty() {
        return 0;
    }
    match text.parse::<f64>() {
        Ok(n) if n.is_finite() && n.fract() == 0.0 => n as i64,
        _ => fallback,
    }
}

/// A selection as the API sends it back.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum Selection {
    #[serde(rename_all = "camelCase")]
    Ids {
        scope_record_ids: Vec<String>,
    },
    MatchingScope {
        query: MatchQuery,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct MatchQuery {
    pub product_domain: Option<String>,
    pub scope_kind: Option<String>,
    pub language_code: Option<String>,
}

/// A budget as the API sends it back (`ScopeSyncBatchBudget`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Budget {
    pub max_scopes_per_turn: i64,
    pub default_provider_concurrency: i64,
    pub provider_concurrency: std::collections::BTreeMap<String, i64>,
    pub provider_request_limits: std::collections::BTreeMap<String, i64>,
    pub credited_provider_request_limits: std::collections::BTreeMap<String, i64>,
    pub provider_failure_threshold: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PreviewCounts {
    pub scopes: u64,
    pub ready_scopes: u64,
    pub blocked_scopes: u64,
    pub provider_units: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct MappingVersion {
    pub mapping_id: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ProfileVersion {
    pub provider_key: String,
    pub profile_key: String,
    pub profile_version: String,
}

/// A scope the preview shows (its `samples`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub scope_record_id: String,
    #[serde(default)]
    pub provider_keys: Vec<String>,
    #[serde(default)]
    pub estimated_request_count: Option<i64>,
    #[serde(default)]
    pub mapping_versions: Vec<MappingVersion>,
    #[serde(default)]
    pub profile_versions: Vec<ProfileVersion>,
    #[serde(default)]
    pub blocker_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub code: String,
    #[serde(default)]
    pub scope_record_id: Option<String>,
    #[serde(default)]
    pub message: String,
}

/// What a batch would do (`ScopeSyncBatchPreview`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub selection: Selection,
    pub budget: Budget,
    pub plan_fingerprint: String,
    #[serde(default)]
    pub confirm_allowed: bool,
    #[serde(default)]
    pub counts: PreviewCounts,
    /// By provider, in the API's order.
    #[serde(default)]
    pub provider_unit_totals: serde_json::Map<String, Value>,
    #[serde(default)]
    pub provider_request_estimates: serde_json::Map<String, Value>,
    #[serde(default)]
    pub samples: Vec<Sample>,
    #[serde(default)]
    pub blockers: Vec<Blocker>,
    #[serde(default)]
    pub resolved_at: String,
}

impl Preview {
    /// The Confirm and enqueue form's fields: the preview's selection and budget, as admin-web's
    /// hidden inputs carry them.
    pub fn confirm_input(&self) -> BatchInput {
        let b = &self.budget;
        let of =
            |map: &std::collections::BTreeMap<String, i64>, key: &str, or: i64| map.get(key).copied().unwrap_or(or).to_string();
        let mut input = BatchInput {
            intent: "confirm".into(),
            plan_fingerprint: self.plan_fingerprint.clone(),
            max_scopes_per_turn: b.max_scopes_per_turn.to_string(),
            default_provider_concurrency: b.default_provider_concurrency.to_string(),
            scrydex_concurrency: of(&b.provider_concurrency, "scrydex", 1),
            tcgdex_request_limit: of(&b.provider_request_limits, "tcgdex", 0),
            scrydex_rate_request_limit: of(&b.provider_request_limits, "scrydex", 0),
            scrydex_request_limit: of(&b.credited_provider_request_limits, "scrydex", 0),
            provider_failure_threshold: b.provider_failure_threshold.to_string(),
            ..Default::default()
        };
        match &self.selection {
            Selection::Ids { scope_record_ids } => {
                input.selection_mode = "ids".into();
                input.scope_record_ids = scope_record_ids.join(",");
            }
            Selection::MatchingScope { query } => {
                input.selection_mode = "matching-scope".into();
                input.product_domain = query.product_domain.clone().unwrap_or_default();
                input.scope_kind = query.scope_kind.clone().unwrap_or_default();
                input.language_code = query.language_code.clone().unwrap_or_default();
            }
        }
        input
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct UnitCounts {
    pub queued: u64,
    pub running: u64,
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub scope_record_id: String,
    pub state: String,
    #[serde(default)]
    pub provider_keys: Vec<String>,
    #[serde(default)]
    pub attempt_count: u64,
}

/// A batch and its units (`ScopeSyncBatchSnapshot`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub batch_id: String,
    pub status: String,
    #[serde(default)]
    pub fast_no_op: bool,
    #[serde(default)]
    pub circuit_open_providers: Vec<String>,
    #[serde(default)]
    pub counts: UnitCounts,
    #[serde(default)]
    pub units: Vec<Unit>,
}

impl Batch {
    /// Still moving: its page is read again.
    pub fn moving(&self) -> bool {
        matches!(self.status.as_str(), "queued" | "running")
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Authority {
    pub allowed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct CountQuery {
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CountSource {
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct CountTarget {
    pub scope_record_id: String,
    #[serde(default)]
    pub query: CountQuery,
    #[serde(default)]
    pub source: Option<CountSource>,
    #[serde(default)]
    pub blocked: bool,
}

/// A Scrydex count quote (`CountQuote`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub quote_id: String,
    pub fingerprint: String,
    #[serde(default)]
    pub authority: Authority,
    #[serde(default)]
    pub targets: Vec<CountTarget>,
    #[serde(default)]
    pub planned_credits: u64,
    #[serde(default)]
    pub cap: u64,
    #[serde(default)]
    pub expires_at: String,
    pub state: String,
}

impl Quote {
    /// Missing counts of `kind` it would buy (fresh ones are reused).
    pub fn missing(&self, kind: &str) -> usize {
        self.targets.iter().filter(|t| t.query.kind == kind && t.source.is_none()).count()
    }

    pub fn reused(&self) -> usize {
        self.targets.iter().filter(|t| t.source.is_some()).count()
    }

    /// Approve count acquisition is offered: a quote that would spend.
    pub fn offered(&self) -> bool {
        self.state == "quoted" && self.planned_credits > 0
    }

    /// Approve count acquisition can be pressed (admin-web disables it otherwise).
    pub fn approvable(&self) -> bool {
        self.authority.allowed && !self.targets.iter().any(|t| t.blocked) && self.cap > 0
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub scope_record_id: String,
    pub product_domain: String,
    pub scope_kind: String,
    pub product_line: String,
    pub set_name: String,
    #[serde(default)]
    pub row_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Unresolved {
    pub product_line: String,
    pub set_name: String,
    #[serde(default)]
    pub row_count: u64,
    pub reason: String,
    #[serde(default)]
    pub product_domain: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ResolutionTotals {
    pub rows: u64,
    pub resolved_pairs: u64,
    pub unresolved_pairs: u64,
}

/// What a held-set export resolved to (`HeldSetResolution`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Resolution {
    #[serde(default)]
    pub resolved: Vec<Resolved>,
    #[serde(default)]
    pub unresolved: Vec<Unresolved>,
    #[serde(default)]
    pub totals: ResolutionTotals,
}

impl Resolution {
    /// Preview resolved sets' fields: the resolved scopes with admin-web's fixed budget.
    pub fn preview_input(&self) -> BatchInput {
        let ids: Vec<&str> = self.resolved.iter().map(|r| r.scope_record_id.as_str()).collect();
        BatchInput {
            selection_mode: "ids".into(),
            scope_record_ids: ids.join(","),
            tcgdex_request_limit: "1000".into(),
            scrydex_rate_request_limit: "1000".into(),
            ..BatchInput::blank()
        }
    }
}

/// The page: the form as drawn or sent, a command's answer, the batch and quote the address
/// names, and a refused command's message.
#[derive(Serialize, ToJson)]
pub struct Screen {
    pub form: BatchInput,
    pub resolution: Option<Resolution>,
    pub preview: Option<Preview>,
    pub quote: Option<Quote>,
    pub batch: Option<Batch>,
    pub error: Option<String>,
}

impl Screen {
    fn with(form: BatchInput) -> Self {
        Screen { form, resolution: None, preview: None, quote: None, batch: None, error: None }
    }
}

/// A request to the batch API, with the browser's `Origin` and `Sec-Fetch-Site`, which the count
/// commands check (admin-web's `createCatalogRequestApiClient` sends both).
fn request(caller: &Caller<'_>, headers: &HeaderMap, method: Method, rest: &str) -> reqwest::RequestBuilder {
    let mut req = caller.request(method, &format!("{PATH}{rest}"), CATALOG);
    for name in [header::ORIGIN.as_str(), "sec-fetch-site"] {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            req = req.header(name, value);
        }
    }
    req
}

async fn post<T: serde::de::DeserializeOwned>(
    caller: &Caller<'_>,
    headers: &HeaderMap,
    rest: &str,
    body: Option<Value>,
) -> Result<T, ApiError> {
    let mut req = request(caller, headers, Method::POST, rest);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let (answer, _) = caller.write(req).await?;
    Ok(answer)
}

pub(crate) async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::SyncBatches>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let present = |value: &Option<String>| value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    let (batch_id, quote_id) = (present(&route.query.batch_id), present(&route.query.quote_id));
    let batch = async {
        match &batch_id {
            Some(id) => caller.read::<Batch>(&format!("{PATH}/{}", segment(id)), CATALOG).await.map(Some),
            None => Ok(None),
        }
    };
    let quote = async {
        match &quote_id {
            Some(id) => caller.read::<Quote>(&format!("{PATH}/counts/quote/{}", segment(id)), CATALOG).await.map(Some),
            None => Ok(None),
        }
    };
    let (batch, quote) = tokio::join!(batch, quote);
    let mut screen = Screen::with(BatchInput::blank());
    screen.batch = match batch {
        Ok(batch) => batch,
        Err(error) => return read_failed(&req, error, false),
    };
    screen.quote = match quote {
        Ok(quote) => quote,
        Err(error) => return read_failed(&req, error, false),
    };
    draw(&req, &staff.viewer, &screen, StatusCode::OK)
}

/// The page with `screen`; a moving batch's page is read again in two seconds.
fn draw(req: &Req, viewer: &Viewer, screen: &Screen, status: StatusCode) -> HtmlResult {
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let moving = screen.batch.as_ref().is_some_and(Batch::moving);
    let head = html! {
        if moving {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let view = views::sync_batch_page(t, p, screen, manages(viewer));
    let html = html! {
        <crate::views::Layout req={req} viewer={Some(viewer)} title={t.ssb_routes_admin_meta_title()} head={head}>
            {view}
        </crate::views::Layout>
    };
    if status == StatusCode::OK { req.screen(screen, html) } else { req.page_with_status(status, html) }
}

/// A refused or failed command: the page with its banner and the form as it was sent (admin-web's
/// action answers `{ error }` for any failure). A session that ended signs in again.
fn refused(req: &Req, viewer: &Viewer, form: BatchInput, error: ApiError) -> HtmlResult {
    let p: Pilot = req.t();
    let (status, message) = match refusal(req, error) {
        Refusal::SignIn => return sign_in(req),
        Refusal::Again(status, message) => (status, message),
        Refusal::Failed(error) => {
            tracing::warn!("a scope sync batch command failed: {error}");
            (StatusCode::BAD_GATEWAY, p.sync_failed().to_owned())
        }
    };
    let mut screen = Screen::with(form);
    screen.error = Some(message);
    draw(req, viewer, &screen, status)
}

/// A command the form left a field out of: the page with admin-web's message, as a 422.
fn incomplete(req: &Req, viewer: &Viewer, form: BatchInput, message: &str) -> HtmlResult {
    let mut screen = Screen::with(form);
    screen.error = Some(message.to_owned());
    draw(req, viewer, &screen, StatusCode::UNPROCESSABLE_ENTITY)
}

/// The batch form's commands, by `intent` (admin-web's `action`).
pub(crate) async fn act(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<BatchInput>,
) -> HtmlResult {
    let p: Pilot = req.t();
    let viewer = &staff.viewer;
    let caller = config.platform.caller(&headers, config.proto, None);
    let required = |value: &str| Some(value.trim().to_owned()).filter(|v| !v.is_empty());
    let form = || BatchInput { intent: String::new(), ..input.clone() };
    match input.intent.trim() {
        "count-quote" => {
            let body = json!({ "selection": input.selection(), "cap": number(&input.count_cap, 0) });
            match post::<Quote>(&caller, &headers, "/counts/quote", Some(body)).await {
                Ok(quote) => {
                    let mut screen = Screen::with(form());
                    screen.quote = Some(quote);
                    draw(&req, viewer, &screen, StatusCode::OK)
                }
                Err(error) => refused(&req, viewer, form(), error),
            }
        }
        "count-acquire" => {
            let Some(quote_id) = required(&input.quote_id) else {
                return incomplete(&req, viewer, BatchInput::blank(), p.sync_quote_required());
            };
            let Some(fingerprint) = required(&input.count_fingerprint) else {
                return incomplete(&req, viewer, BatchInput::blank(), p.sync_fingerprint_required());
            };
            let body = json!({ "quoteId": quote_id, "fingerprint": fingerprint });
            match post::<Quote>(&caller, &headers, "/counts/acquire", Some(body)).await {
                Ok(quote) => {
                    let mut screen = Screen::with(BatchInput::blank());
                    screen.quote = Some(quote);
                    draw(&req, viewer, &screen, StatusCode::OK)
                }
                Err(error) => refused(&req, viewer, BatchInput::blank(), error),
            }
        }
        "preview" => {
            let body = json!({ "selection": input.selection(), "budget": input.budget() });
            match post::<Preview>(&caller, &headers, "/preview", Some(body)).await {
                Ok(preview) => {
                    let mut screen = Screen::with(form());
                    screen.preview = Some(preview);
                    draw(&req, viewer, &screen, StatusCode::OK)
                }
                Err(error) => refused(&req, viewer, form(), error),
            }
        }
        "confirm" => {
            let Some(plan) = required(&input.plan_fingerprint) else {
                return incomplete(&req, viewer, form(), p.sync_plan_required());
            };
            let body = json!({ "selection": input.selection(), "budget": input.budget(), "planFingerprint": plan });
            match post::<Batch>(&caller, &headers, "/confirm", Some(body)).await {
                Ok(batch) => req.redirect(&url::SyncBatches::batch(&batch.batch_id)),
                Err(error) => refused(&req, viewer, form(), error),
            }
        }
        intent => {
            let Some(batch) = required(&input.batch_id) else {
                return incomplete(&req, viewer, form(), p.sync_batch_required());
            };
            let rest = match intent {
                "cancel" => format!("/{}/cancel", segment(&batch)),
                "resume" => format!("/{}/resume", segment(&batch)),
                "retry-unit" => {
                    let Some(scope) = required(&input.scope_record_id) else {
                        return incomplete(&req, viewer, form(), p.sync_scope_required());
                    };
                    format!("/{}/units/{}/retry", segment(&batch), segment(&scope))
                }
                _ => return incomplete(&req, viewer, form(), p.sync_unsupported()),
            };
            match post::<Value>(&caller, &headers, &rest, None).await {
                Ok(_) => req.redirect(&url::SyncBatches::batch(&batch)),
                Err(error) => refused(&req, viewer, form(), error),
            }
        }
    }
}

/// Resolve held sets: the export's file, sent on to the API as its one part (admin-web's
/// `resolveHeldSetExport`), and the page with what it resolved to.
pub(crate) async fn held_sets(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    upload: Upload<HeldSetForm>,
) -> HtmlResult {
    let p: Pilot = req.t();
    let viewer = &staff.viewer;
    let file = match read(upload).await {
        Ok(Some(file)) => file,
        Ok(None) => return incomplete(&req, viewer, BatchInput::blank(), p.sync_file_required()),
        Err(UploadError::TooLarge { .. }) => {
            let mut screen = Screen::with(BatchInput::blank());
            screen.error = Some(p.sync_upload_too_large().to_owned());
            return draw(&req, viewer, &screen, StatusCode::PAYLOAD_TOO_LARGE);
        }
        Err(other) => return Err(other.into()),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let part = reqwest::multipart::Part::stream(file.bytes).file_name(file.filename).mime_str(&file.content_type);
    let part = match part {
        Ok(part) => part,
        Err(_) => return incomplete(&req, viewer, BatchInput::blank(), p.sync_file_required()),
    };
    let form = reqwest::multipart::Form::new().part("file", part);
    let sent = request(&caller, &headers, Method::POST, "/resolve-held-sets").multipart(form);
    match caller.write::<Resolution>(sent).await {
        Ok((resolution, _)) => {
            let mut screen = Screen::with(BatchInput::blank());
            screen.resolution = Some(resolution);
            draw(&req, viewer, &screen, StatusCode::OK)
        }
        Err(error) => refused(&req, viewer, BatchInput::blank(), error),
    }
}

/// The held-set form: its one file.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct HeldSetForm {
    pub file: Files,
}

struct Export {
    filename: String,
    content_type: String,
    bytes: Bytes,
}

/// The export the form sent, or none when it sent no file. A file over the API's limit is the
/// whole upload too large, as the API answers it.
async fn read(mut upload: Upload<HeldSetForm>) -> Result<Option<Export>, UploadError> {
    upload.limit(HELD_SET_BYTES + FRAMING_BYTES);
    let field = HeldSetForm::FIELDS.file;
    let mut export = None;
    while let Some(mut file) = upload.next_file().await? {
        if !file.is(field) || export.is_some() {
            continue;
        }
        let filename = file.filename().to_owned();
        let content_type =
            Some(file.content_type().trim().to_owned()).filter(|c| !c.is_empty()).unwrap_or_else(|| "text/csv".into());
        match file.bytes_up_to(HELD_SET_BYTES).await? {
            Some(bytes) if !bytes.is_empty() => export = Some(Export { filename, content_type, bytes }),
            Some(_) => {}
            None => return Err(UploadError::TooLarge { limit: HELD_SET_BYTES }),
        }
    }
    upload.fields().await?;
    Ok(export)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_read_as_admin_webs_number_value_reads_them() {
        assert_eq!(number("7", 1), 7);
        assert_eq!(number(" 1e3 ", 1), 1000);
        assert_eq!(number("", 3), 0, "Number('') is 0");
        assert_eq!(number("2.5", 3), 3);
        assert_eq!(number("ten", 3), 3);
        assert_eq!(number("Infinity", 3), 3);
    }

    #[test]
    fn the_form_names_its_selection_and_budget_as_admin_webs_preview_request() {
        let mut input = BatchInput::blank();
        assert_eq!(
            input.selection(),
            json!({ "mode": "matching-scope", "query": { "productDomain": "pokemon", "scopeKind": "set", "languageCode": "en" } })
        );
        input.selection_mode = "ids".into();
        input.scope_record_ids = " scp_a, ,scp_b ".into();
        assert_eq!(input.selection(), json!({ "mode": "ids", "scopeRecordIds": ["scp_a", "scp_b"] }));
        assert_eq!(
            input.budget(),
            json!({
                "maxScopesPerTurn": 1, "defaultProviderConcurrency": 1, "providerConcurrency": { "scrydex": 1 },
                "providerRequestLimits": { "tcgdex": 1000, "scrydex": 1000 },
                "creditedProviderRequestLimits": { "scrydex": 0 }, "providerFailureThreshold": 3,
            })
        );
    }
}
