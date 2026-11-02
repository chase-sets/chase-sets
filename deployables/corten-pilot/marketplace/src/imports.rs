//! Inventory import (Inventory's `account-inventory-imports`): upload or paste a CSV, follow its
//! validation, review a batch's rows and commit the accepted ones.
//!
//! Validation and commit are durable jobs. Where marketplace's page subscribes from the browser to
//! the job's event stream, the pilot reads the job when the page is read and, while it runs, reads
//! the page again every two seconds (`ReadAgain`), so it works without a script. A finished job
//! sends the page to its batch, with the job's receipt so the read waits for it.
//!
//! A new import is sent once per form: the form's `SubmitKey` is the `Inventory-Mutation-Attempt`,
//! so the same form sent again is the same job. Resolving a row is not ported yet: Resolve opens
//! marketplace's batch page at the row. Which rows need the seller, whether a batch can commit and
//! the next row to resolve are Inventory's answers, read from the batch and from a resolve.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/inventory/imports?jobId=..` | the upload form and the recent batches; a job's progress, or its batch once done |
//! | `POST /account/inventory/imports` | start a batch's validation: 303 to the page with the job, or the page with the API's refusal (422) |
//! | `GET /account/inventory/imports/template.csv`, `../export.csv` | the native template, or the account's inventory, as the API sends it |
//! | `GET /account/inventory/imports/{batch}?offset=..&jobId=..` | a batch: its summary, 100 rows from `offset`, Commit when it can |
//! | `POST /account/inventory/imports/{batch}/commit` | commit the accepted rows: 303 to the batch with the job |
use crate::recovery::attempt_text;
use corten::{
    Relay,
    axum::{
        body::Body,
        http::{HeaderMap, StatusCode, header},
    },
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{ApiError, ImportBatch, ImportBatchDetail, ImportRow, Imports as _, Location, NewImport, RowFix},
    app::{Shared, read_failed, url},
    auth::{Seller, Viewer},
    items::Raw,
    listing_new::{self, Catalog, Draft, first},
    recovery::valid_attempt,
    text::ImportsMsg,
    uploads::{self, Limits, Over},
    views::{self, Layout},
};

/// A CSV file up to 8 MiB; the form with it up to 9 MiB.
pub const LIMITS: Limits = Limits { file: 8 * 1024 * 1024, files: 1, whole: 9 * 1024 * 1024 };

/// The CSV sources a seller may upload (`listInventoryImportSources` of kind `csv`), in
/// marketplace's order.
pub const SOURCES: [&str; 6] = ["native-csv", "tcgplayer-csv", "ebay-csv", "shopify-csv", "whatnot-csv", "cardtrader-csv"];
pub const MODES: [&str; 2] = ["add", "replace"];

/// What an import page's address carries: the job to follow, the batch's row page, and the receipt
/// of the write the page follows.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct Place {
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
    pub offset: Option<String>,
    pub after_write: Option<String>,
    /// The row the resolution drawer is open on (marketplace's `resolveRowId`).
    #[serde(rename = "resolveRowId")]
    pub resolve_row_id: Option<String>,
}

impl Place {
    /// The first row shown: a whole number, else the first.
    pub fn offset(&self) -> u64 {
        self.offset.as_deref().and_then(|o| o.trim().parse().ok()).unwrap_or(0)
    }

    fn job(&self) -> Option<&str> {
        self.job_id.as_deref().map(str::trim).filter(|j| !j.is_empty())
    }

    fn resolving(&self) -> Option<&str> {
        self.resolve_row_id.as_deref().map(str::trim).filter(|r| !r.is_empty())
    }
}

/// A batch's page at `offset`, with nothing else.
pub fn batch_href(batch: &str, offset: u64) -> String {
    let place = Place { offset: (offset > 0).then(|| offset.to_string()), ..Place::default() };
    url::ImportBatch { batch, place }.href()
}

/// A batch's page at `offset` with the drawer open on `row`, or closed.
pub fn resolve_href(batch: &str, offset: u64, row: Option<&str>) -> String {
    let place =
        Place { offset: (offset > 0).then(|| offset.to_string()), resolve_row_id: row.map(str::to_owned), ..Place::default() };
    url::ImportBatch { batch, place }.href()
}

/// The drawer's fields (`ImportRowResolutionForm`): the picker's, which are Create listing's
/// (`q`, `choose`, `change`, `redraw`, `catalogItemId` and `option.<dimension>`), the storage
/// location, and the row page to come back to.
#[derive(Deserialize, Fields)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct FixFields {
    pub q: String,
    pub choose: String,
    pub change: String,
    pub redraw: String,
    pub catalog_item_id: String,
    pub storage_location_id: String,
    pub offset: String,
}

/// The resolution drawer, open on a row that still needs the seller (`activeResolutionRow`).
#[derive(Clone, Debug, Serialize)]
pub struct Fixing {
    pub row: ImportRow,
    /// Its place among the rows that need the seller, from 1, and how many there are.
    pub position: usize,
    pub total: usize,
    #[serde(skip)]
    pub catalog: Catalog,
    #[serde(skip)]
    pub draft: Draft,
    pub storage_location_id: String,
    /// The API's refusal of the fix last sent, or why it was not sent.
    pub error: Option<String>,
}

impl Fixing {
    /// The chosen catalog item with every option it needs (`canApplyRowFix`).
    pub fn ready(&self) -> Option<(&crate::api::CatalogItem, &crate::items::Picks)> {
        self.catalog.ready()
    }
}

/// The picker's draft for `row`: what the form sent, else the row's own item and options, else
/// its name or note to search for (`initialCatalogItemPickerState`).
fn row_draft(row: &ImportRow, raw: &Raw) -> Draft {
    let f = FixFields::FIELDS;
    let sent = [f.q, f.choose, f.change, f.catalog_item_id, f.redraw].iter().any(|name| raw.contains_key(name.as_str()));
    if sent {
        return Draft::read(raw);
    }
    let mut draft = Draft::read(&Raw::new());
    match &row.catalog_item_id {
        Some(item) => {
            draft.catalog_item_id = item.clone();
            draft.options = row.selected_options.iter().map(|s| (s.dimension_id.clone(), s.option_id.clone())).collect();
        }
        None => {
            let name = row.external_reference.as_ref().and_then(|r| r.display_name.as_deref());
            draft.q = name.or(row.row_note.as_deref()).unwrap_or_default().trim().to_owned();
        }
    }
    draft
}

/// The drawer for the row the address names, if it still needs the seller; a row already
/// resolved closes it, as marketplace's stale link does.
async fn fixing(
    caller: &crate::api::Caller<'_>,
    detail: &ImportBatchDetail,
    row_id: Option<&str>,
    raw: &Raw,
    error: Option<String>,
) -> Option<Fixing> {
    let open = unresolved(detail);
    let position = open.iter().position(|row| Some(row.row_id.as_str()) == row_id)?;
    let row = open[position].clone();
    let draft = row_draft(&row, raw);
    let catalog = listing_new::catalog(caller, &draft).await;
    let sent = first(raw, FixFields::FIELDS.storage_location_id.as_str());
    let storage_location_id = if sent.is_empty() { row.storage_location_id.clone().unwrap_or_default() } else { sent };
    Some(Fixing { position: position + 1, total: open.len(), row, catalog, draft, storage_location_id, error })
}

/// The upload form's fields, in marketplace's names.
#[derive(Deserialize, Fields)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ImportFields {
    source_key: String,
    quantity_mode: String,
    default_storage_location_id: String,
    file: String,
    csv_text: String,
    /// The form's `SubmitKey`: the import's attempt.
    attempt: Option<SubmitKey>,
}

/// The Commit form's one field: its `SubmitKey`, the commit's attempt.
#[derive(Deserialize, Fields)]
pub struct CommitFields {
    pub attempt: Option<SubmitKey>,
}

/// What the upload form shows: what was sent (a refused import keeps it) and the API's refusal.
#[derive(Clone, Debug, Serialize)]
pub struct Upload {
    pub source_key: String,
    pub quantity_mode: String,
    pub default_storage_location_id: String,
    pub csv_text: String,
    pub error: Option<String>,
}

impl Default for Upload {
    fn default() -> Self {
        Upload {
            source_key: SOURCES[0].to_owned(),
            quantity_mode: MODES[0].to_owned(),
            default_storage_location_id: String::new(),
            csv_text: String::new(),
            error: None,
        }
    }
}

/// What a running job says (`activeJob`).
#[derive(Clone, Debug, Serialize)]
pub struct JobNotice {
    pub failed: bool,
    pub message: Option<String>,
}

/// What the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ImportsScreen {
    pub batches: Vec<ImportBatch>,
    pub locations: Vec<Location>,
    pub detail: Option<ImportBatchDetail>,
    /// The batch was asked for after a write its read has not caught up with.
    pub pending: bool,
    pub job: Option<JobNotice>,
    pub upload: Upload,
    pub offset: u64,
    /// The resolution drawer, when the address opens it on a row that needs the seller.
    pub fixing: Option<Fixing>,
}

impl ImportsScreen {
    /// The batch Latest batch opens: the one shown, else the newest.
    pub fn latest(&self) -> Option<&str> {
        self.detail.as_ref().map(|d| d.batch.batch_id.as_str()).or_else(|| self.batches.first().map(|b| b.batch_id.as_str()))
    }
}

/// The shown rows that Inventory says need the seller, in row order.
pub fn unresolved(detail: &ImportBatchDetail) -> Vec<&ImportRow> {
    detail.rows.iter().filter(|row| row.needs_seller).collect()
}

/// How many rows Commit would commit, when Inventory says the batch can commit.
pub fn commit_ready(detail: &ImportBatchDetail) -> Option<u64> {
    detail.can_commit.then_some(detail.commit_ready_count)
}

/// The job the address names: where its finished work goes, or what it says while it runs. A job
/// that is not the caller's (the API's 404) says nothing.
enum Followed {
    Nothing,
    Running(JobNotice),
    /// Done: its batch, if it made one, and the receipt of its write.
    Done(Option<String>, Option<String>),
}

/// Where a finished job's page goes: its batch, else the list, reading after its write.
fn finished(req: &Req, batch: Option<String>, after_write: Option<String>) -> HtmlResult {
    let place = Place { after_write, ..Place::default() };
    match batch {
        Some(batch) => req.redirect(&url::ImportBatch { batch: &batch, place }),
        None => req.redirect(&url::Imports { place }),
    }
}

async fn follow(caller: &crate::api::Caller<'_>, place: &Place) -> Result<Followed, ApiError> {
    let Some(id) = place.job() else { return Ok(Followed::Nothing) };
    let Some(job) = caller.import_job(id).await? else { return Ok(Followed::Nothing) };
    if job.status == "completed" {
        let batch = job.result.as_ref().and_then(|r| r.batch.as_ref()).map(|b| b.batch_id.clone());
        return Ok(Followed::Done(batch, job.receipt().map(|r| r.param())));
    }
    let message = job.error_message.clone().or_else(|| job.progress.message.clone());
    Ok(Followed::Running(JobNotice { failed: job.status == "failed", message }))
}

/// The page's two shared reads: the recent batches and the storage locations.
async fn lists(caller: &crate::api::Caller<'_>) -> Result<(Vec<ImportBatch>, Vec<Location>), ApiError> {
    let (batches, locations) = tokio::join!(caller.import_batches(), caller.import_locations());
    Ok((batches?.items, locations?.items))
}

fn draw(
    req: &Req,
    viewer: &Viewer,
    screen: &ImportsScreen,
    reads_again: bool,
    status: StatusCode,
    cart: Option<u64>,
) -> HtmlResult {
    let t: ImportsMsg = req.t();
    let head = html! {
        if reads_again {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::ImportsPage t={t} p={req.t()} m={req.t()} screen={screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_inventory_import_marketplace()} head={head}>
            {view}
        </Layout>
    };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn list(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Imports>,
) -> HtmlResult {
    let place = route.place;
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let job = match follow(&caller, &place).await {
        Ok(Followed::Done(batch, after_write)) => return finished(&req, batch, after_write),
        Ok(Followed::Running(notice)) => Some(notice),
        Ok(Followed::Nothing) => None,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let (batches, locations) = match lists(&caller).await {
        Ok(lists) => lists,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let running = job.as_ref().is_some_and(|j| !j.failed);
    let screen = ImportsScreen {
        batches,
        locations,
        detail: None,
        pending: false,
        job,
        upload: Upload::default(),
        offset: 0,
        fixing: None,
    };
    draw(&req, &viewer, &screen, running, StatusCode::OK, chrome.cart().await)
}

pub(crate) async fn batch(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::ImportBatch<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let (id, place) = (route.batch, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let plain = config.platform.caller(&headers, config.proto, None);
    let job = match follow(&plain, &place).await {
        Ok(Followed::Done(batch, after_write)) => return finished(&req, batch, after_write),
        Ok(Followed::Running(notice)) => Some(notice),
        Ok(Followed::Nothing) => None,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let offset = place.offset();
    let (detail, lists) = tokio::join!(caller.import_batch(&id, offset), lists(&plain));
    let (batches, locations) = match lists {
        Ok(lists) => lists,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let (detail, pending) = match detail {
        Ok(detail) => (Some(detail), false),
        // The batch's read has not caught up with the write the page follows: say so, read again.
        Err(error) if receipt.is_some() && error.catching_up() => (None, true),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
        }
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let running = job.as_ref().is_some_and(|j| !j.failed);
    let fixing = match &detail {
        Some(detail) => fixing(&plain, detail, place.resolving(), &raw, None).await,
        None => None,
    };
    let screen = ImportsScreen { batches, locations, detail, pending, job, upload: Upload::default(), offset, fixing };
    draw(&req, &viewer, &screen, running || pending, StatusCode::OK, chrome.cart().await)
}

pub(crate) async fn create(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    upload: corten::Upload<crate::items::Raw>,
) -> HtmlResult {
    let t: ImportsMsg = req.t();
    let f = ImportFields::FIELDS;
    let caller = config.platform.caller(&headers, config.proto, None);
    let posted = match uploads::read(upload, LIMITS).await {
        Ok(posted) => posted,
        Err(corten::UploadError::TooLarge { .. }) => {
            let upload = Upload { error: Some(t.api_import_source_not_accepted().to_owned()), ..Upload::default() };
            return refuse(&req, &viewer, &caller, upload, StatusCode::PAYLOAD_TOO_LARGE, &chrome).await;
        }
        Err(other) => return Err(other.into()),
    };
    let raw = &posted.fields;
    let pick = |key: &str, allowed: &[&str]| {
        let value = first(raw, key);
        if allowed.contains(&value.as_str()) { value } else { allowed[0].to_owned() }
    };
    let mut sent = Upload {
        source_key: pick(f.source_key.as_str(), &SOURCES),
        quantity_mode: pick(f.quantity_mode.as_str(), &MODES),
        default_storage_location_id: first(raw, f.default_storage_location_id.as_str()).trim().to_owned(),
        csv_text: first(raw, f.csv_text.as_str()),
        error: None,
    };
    let attempt = first(raw, f.attempt.as_str());
    let file = posted.files.into_iter().find(|file| file.field == f.file.as_str() && !file.bytes.is_empty());
    // The file's text, as marketplace's `TextDecoder("utf-8", { fatal: true })` reads it, else the pasted rows.
    let (csv_text, filename) = match (&file, posted.over) {
        (_, Some(Over::FileTooLarge | Over::TooManyFiles)) => (None, None),
        (Some(file), None) => (std::str::from_utf8(&file.bytes).ok().map(str::to_owned), Some(file.filename.clone())),
        (None, None) => (Some(sent.csv_text.clone()), None),
    };
    let Some(csv_text) = csv_text.filter(|_| valid_attempt(&attempt)) else {
        sent.error = Some(t.api_import_source_not_accepted().to_owned());
        return refuse(&req, &viewer, &caller, sent, StatusCode::UNPROCESSABLE_ENTITY, &chrome).await;
    };
    let body = NewImport {
        csv_text,
        source_key: sent.source_key.clone(),
        quantity_mode: sent.quantity_mode.clone(),
        default_storage_location_id: Some(sent.default_storage_location_id.clone()).filter(|l| !l.is_empty()),
        source_filename: filename.filter(|n| !n.trim().is_empty()),
    };
    match caller.create_import(&attempt, &body).await {
        Ok(job) => req.redirect(&url::Imports { place: Place { job_id: Some(job.job_id), ..Place::default() } }),
        Err(error) => match error.refusal() {
            Some(message) if error.status() != Some(StatusCode::FORBIDDEN) => {
                sent.error = Some(message.to_owned());
                refuse(&req, &viewer, &caller, sent, StatusCode::UNPROCESSABLE_ENTITY, &chrome).await
            }
            _ => read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
        },
    }
}

/// The page again with the upload form as it was sent and why it was refused.
async fn refuse(
    req: &Req,
    viewer: &Viewer,
    caller: &crate::api::Caller<'_>,
    upload: Upload,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let (batches, locations) = match lists(caller).await {
        Ok(lists) => lists,
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let screen = ImportsScreen { batches, locations, detail: None, pending: false, job: None, upload, offset: 0, fixing: None };
    draw(req, viewer, &screen, false, status, chrome.cart().await)
}

pub(crate) async fn commit(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::ImportCommit<'_>>,
    Form(input): Form<CommitFields>,
) -> HtmlResult {
    let id = route.batch;
    let caller = config.platform.caller(&headers, config.proto, None);
    // A form without its key (sent before the page carried one) is refused before the API.
    let sent = if valid_attempt(attempt_text(&input.attempt)) {
        caller.commit_import(&id, attempt_text(&input.attempt)).await
    } else {
        let p: crate::text::Pilot = req.t();
        Err(ApiError::Status { status: StatusCode::BAD_REQUEST, code: None, message: p.check_attempt().to_owned() })
    };
    match sent {
        Ok(job) => {
            let place = Place { job_id: Some(job.job_id), ..Place::default() };
            req.redirect(&url::ImportBatch { batch: &id, place })
        }
        Err(error) => match error.refusal() {
            Some(message) if error.status() != Some(StatusCode::FORBIDDEN) => {
                let message = message.to_owned();
                let (detail, lists) = tokio::join!(caller.import_batch(&id, 0), lists(&caller));
                let ((batches, locations), detail) = match (lists, detail) {
                    (Ok(lists), Ok(detail)) => (lists, detail),
                    (Err(error), _) | (_, Err(error)) => {
                        return read_failed(&req, Some(&viewer), error, None, chrome.cart().await);
                    }
                };
                let upload = Upload { error: Some(message), ..Upload::default() };
                let screen = ImportsScreen {
                    batches,
                    locations,
                    detail: Some(detail),
                    pending: false,
                    job: None,
                    upload,
                    offset: 0,
                    fixing: None,
                };
                draw(&req, &viewer, &screen, false, StatusCode::UNPROCESSABLE_ENTITY, chrome.cart().await)
            }
            _ => read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
        },
    }
}

/// Apply a row's fix (`resolve-row`): the batch at the next row that needs the seller, or with the
/// drawer closed once none is left (`resolveRowRedirectTarget`). The picker's steps (Find,
/// Choose, Change, Update options) are GETs of the batch page, so only Apply posts here. A fix
/// without its item, every option it needs and a location, or one the API refuses, is the drawer
/// again with why (422).
pub(crate) async fn resolve(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::ImportResolve<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let (id, row_id) = (route.batch, route.row);
    let f = FixFields::FIELDS;
    let offset = first(&raw, f.offset.as_str()).parse().unwrap_or(0);
    let caller = config.platform.caller(&headers, config.proto, None);
    let catalog = listing_new::catalog(&caller, &Draft::read(&raw)).await;
    let location = first(&raw, f.storage_location_id.as_str());
    let fix = catalog.ready().filter(|_| !location.is_empty()).map(|(item, picks)| RowFix {
        catalog_item_id: item.catalog_item_id.clone(),
        selected_options: item.product_schema.as_ref().map(|s| listing_new::entries(s, picks)).unwrap_or_default(),
        storage_location_id: location.clone(),
    });
    let refused = match fix {
        Some(fix) => match caller.resolve_import_row(&id, &row_id, &fix).await {
            Ok(resolution) => {
                let next = resolution.next_needs_seller_row_id;
                let place = Place { offset: (offset > 0).then(|| offset.to_string()), resolve_row_id: next, ..Place::default() };
                return req.redirect(&url::ImportBatch { batch: &id, place });
            }
            Err(error) => match error.refusal() {
                Some(message) if error.status() != Some(StatusCode::FORBIDDEN) => message.to_owned(),
                _ => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
            },
        },
        None => {
            let p: crate::text::Pilot = req.t();
            p.listing_new_choose_options().to_owned()
        }
    };
    let (detail, lists) = tokio::join!(caller.import_batch(&id, offset), lists(&caller));
    let ((batches, locations), detail) = match (lists, detail) {
        (Ok(lists), Ok(detail)) => (lists, detail),
        (Err(error), _) | (_, Err(error)) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let fixing = fixing(&caller, &detail, Some(&row_id), &raw, Some(refused)).await;
    let upload = Upload::default();
    let screen = ImportsScreen { batches, locations, detail: Some(detail), pending: false, job: None, upload, offset, fixing };
    draw(&req, &viewer, &screen, false, StatusCode::UNPROCESSABLE_ENTITY, chrome.cart().await)
}

/// The native template, as the API sends it.
pub(crate) async fn template(
    req: Req,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> corten::Result<Relay> {
    csv(&req, &viewer, &config, &headers, "templates").await
}

/// The account's inventory as CSV, as the API sends it.
pub(crate) async fn export(
    req: Req,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> corten::Result<Relay> {
    csv(&req, &viewer, &config, &headers, "exports").await
}

/// The API's CSV passed on with its type and file name, nothing else of its headers.
async fn csv(_req: &Req, _viewer: &Viewer, config: &Shared, headers: &HeaderMap, which: &str) -> corten::Result<Relay> {
    let caller = config.platform.caller(headers, config.proto, None);
    let res = caller.import_csv(which).await.map_err(|error| {
        let status = match error.status() {
            Some(StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED) => StatusCode::FORBIDDEN,
            _ => StatusCode::BAD_GATEWAY,
        };
        corten::Error::new(error).with_status(status)
    })?;
    let mut kept = HeaderMap::new();
    for name in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION] {
        if let Some(value) =
            res.headers().get(name.as_str()).and_then(|v| corten::axum::http::HeaderValue::from_bytes(v.as_bytes()).ok())
        {
            kept.insert(name, value);
        }
    }
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}
