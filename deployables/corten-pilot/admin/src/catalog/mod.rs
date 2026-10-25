//! The catalog area (`/catalog`): admin-web's catalog authoring screens for dimensions and
//! fields, through the Catalog API (`/api/catalog`) as the signed-in staff member. The area
//! has its own stylesheet and guard: reading needs `catalog.view`, writing `catalog.manage`, as
//! the platform API asks for them (`deployables/platform-api/src/app.ts`).
//!
//! Every write is its own typed route; each answers its form with the API's refusal, or a
//! redirect to the page, carrying the write's receipt and what it did (the toast).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog` | a redirect to the dimensions |
//! | `GET /catalog/dimensions?search&status&value_kind&page` | the list; `POST` creates |
//! | `GET /catalog/dimensions/live?search&status&value_kind&page` | the list's rows, again on each change (`<corten-live>`) |
//! | `GET /catalog/dimensions/{id}` | the dimension and its options |
//! | `POST /catalog/dimensions/{id}/edit`, `/lifecycle` | revise; activate, deprecate, archive |
//! | `POST /catalog/dimensions/{id}/options`, `/options/order` | add an option; reorder them |
//! | `POST /catalog/dimensions/{id}/options/{option_id}`, `.../lifecycle` | revise; deprecate, reactivate |
//! | `GET /catalog/fields?search&status&value_type&filterable&searchable&sortable&page` | the list; `POST` creates |
//! | `GET /catalog/fields/live?...` | the list's rows, again on each change |
//! | `GET /catalog/fields/{id}`, `POST .../edit`, `.../lifecycle` | the field; configure; its status |
//! | `POST /catalog/dimensions/bulk?search&status&value_kind&page` | a bulk change's preview (`/catalog/fields/bulk` for fields) |
//! | `POST /catalog/dimensions/bulk/confirm?...` | starts it: a redirect to the list, following its job (`?job=`) |
//! | `GET /catalog/jobs/{id}/live` | the job's status, again on each change until it is done (`<corten-live>`) |
//! | `GET /catalog/scopes?search&status&product_domain&language&page` | the scopes list (`scopes`) |
//!
//! The lists are kept current as admin-web's are (`useCatalogRealtimeRevalidation`): a change to
//! the Catalog topic `catalog:admin:dimensions` (or `:fields`) reads the list again, and the
//! server sends the rows it draws. The detail pages are not live in admin-web either.
//!
//! A bulk change is admin-web's `BulkLifecycleActionBar`: the checked rows (or every record the
//! filters match) and an action, previewed by the API, then confirmed; the API runs it as a job,
//! whose progress the list's dialog follows from the job's own stream.
use std::fmt;

use corten::{
    Fragment, LiveSince,
    axum::{http::HeaderMap, response::IntoResponse},
    prelude::*,
};
use futures_util::StreamExt;
use platform::{jobs::Update, realtime::Tick, receipt::Receipt};
use serde::Deserialize;
use serde_json::{Map, Value};

pub mod api;
pub mod attention;
pub mod form;
pub mod item;
pub mod items;
pub mod scopes;
pub mod views;

use crate::{
    api::{Caller, Method, segment},
    app::{Denied, Shared, read_failed, refused},
    auth::Session,
    text::{Cat, Pilot},
};
use api::{Catalog as _, Dimension, DimensionDetail, Field, Job, Kind, List, Preview, Written, under};
use form::{ActionInput, BulkInput, DimensionInput, FieldInput, OptionInput, ReorderInput};
use views::{Bulk, DimensionForms, Draft, FieldForms, Followed, ListScreen, Previewed, ids};

pub const VIEW: &str = "catalog.view";
pub const MANAGE: &str = "catalog.manage";
/// `CATALOG_LIST_PAGE_SIZE`.
const PAGE_SIZE: u32 = 50;

/// Every URL the area serves.
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use super::Done;
    pub use super::item::url as item;
    pub use super::items::url::{ItemQuery, Items, ItemsBulk, ItemsDrafts, ItemsLive};
    pub use super::scopes::url::{ScopeQuery, Scopes};

    /// The area: its routes, stylesheet and guard.
    #[derive(Route)]
    #[route("/catalog")]
    pub struct Catalog;

    /// What the write before left on a list: its receipt and notice, and the bulk change's job
    /// the page follows after its confirm.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct ListNotice {
        pub after_write: Option<String>,
        pub done: Option<Done>,
        pub job: Option<String>,
    }

    /// The dimensions list's filters (the filter form's fields) and page (from 1): what the list,
    /// its live rows, its bulk preview and the preview's confirm all carry.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct DimensionQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub value_kind: Option<String>,
        pub page: Option<u32>,
    }

    /// The dimensions list.
    #[derive(Clone, Debug, Default, Route)]
    #[route("/catalog/dimensions")]
    pub struct Dimensions {
        #[route(query)]
        pub query: DimensionQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl Dimensions {
        pub fn of(query: &DimensionQuery) -> Self {
            Dimensions { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The dimensions list's rows, streamed again on each change.
    #[derive(Route)]
    #[route("/catalog/dimensions/live")]
    pub struct DimensionsLive {
        #[route(query)]
        pub query: DimensionQuery,
    }

    /// A bulk change of the dimensions: its preview (without JavaScript the answer is the list,
    /// with the preview open).
    #[derive(Route)]
    #[route("/catalog/dimensions/bulk")]
    pub struct DimensionsBulk {
        #[route(query)]
        pub query: DimensionQuery,
    }

    /// The preview's confirm: it starts the change.
    #[derive(Route)]
    #[route("/catalog/dimensions/bulk/confirm")]
    pub struct DimensionsBulkConfirm {
        #[route(query)]
        pub query: DimensionQuery,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}")]
    pub struct Dimension<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<Done>,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}/edit")]
    pub struct DimensionEdit<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}/lifecycle")]
    pub struct DimensionLifecycle<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}/options")]
    pub struct Options<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}/options/order")]
    pub struct OptionOrder<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}/options/{option_id}")]
    pub struct OptionEdit<'a> {
        pub id: &'a str,
        pub option_id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/dimensions/{id}/options/{option_id}/lifecycle")]
    pub struct OptionLifecycle<'a> {
        pub id: &'a str,
        pub option_id: &'a str,
    }

    /// The fields list's filters and page; the flags are `true` or `false`.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct FieldQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub value_type: Option<String>,
        pub filterable: Option<String>,
        pub searchable: Option<String>,
        pub sortable: Option<String>,
        pub page: Option<u32>,
    }

    /// The fields list.
    #[derive(Clone, Debug, Default, Route)]
    #[route("/catalog/fields")]
    pub struct Fields {
        #[route(query)]
        pub query: FieldQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl Fields {
        pub fn of(query: &FieldQuery) -> Self {
            Fields { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The fields list's rows, streamed again on each change.
    #[derive(Route)]
    #[route("/catalog/fields/live")]
    pub struct FieldsLive {
        #[route(query)]
        pub query: FieldQuery,
    }

    /// A bulk change of the fields: its preview.
    #[derive(Route)]
    #[route("/catalog/fields/bulk")]
    pub struct FieldsBulk {
        #[route(query)]
        pub query: FieldQuery,
    }

    #[derive(Route)]
    #[route("/catalog/fields/bulk/confirm")]
    pub struct FieldsBulkConfirm {
        #[route(query)]
        pub query: FieldQuery,
    }

    /// A bulk change's job status, streamed again on each change until it is done.
    #[derive(Route)]
    #[route("/catalog/jobs/{id}/live")]
    pub struct JobLive<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/fields/{id}")]
    pub struct Field<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<Done>,
    }

    #[derive(Route)]
    #[route("/catalog/fields/{id}/edit")]
    pub struct FieldEdit<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/catalog/fields/{id}/lifecycle")]
    pub struct FieldLifecycle<'a> {
        pub id: &'a str,
    }

    /// What a record's page reads after a write: its receipt and what it did.
    #[derive(Debug, Default, Deserialize)]
    pub struct After {
        pub after_write: Option<String>,
        pub done: Option<Done>,
    }
}

/// What a write did, for the page it redirects to: admin-web's success toasts.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Done {
    Created,
    Revised,
    Activated,
    Deprecated,
    Archived,
    OptionAdded,
    OptionRevised,
    OptionDeprecated,
    OptionReactivated,
    Reordered,
}

impl fmt::Display for Done {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Done::Created => "created",
            Done::Revised => "revised",
            Done::Activated => "activated",
            Done::Deprecated => "deprecated",
            Done::Archived => "archived",
            Done::OptionAdded => "option_added",
            Done::OptionRevised => "option_revised",
            Done::OptionDeprecated => "option_deprecated",
            Done::OptionReactivated => "option_reactivated",
            Done::Reordered => "reordered",
        })
    }
}

impl Done {
    fn of(action: &str) -> Done {
        match action {
            "activate" => Done::Activated,
            "deprecate" => Done::Deprecated,
            "archive" => Done::Archived,
            "reactivate" => Done::OptionReactivated,
            _ => Done::Revised,
        }
    }

    /// The toast on a dimension's pages.
    pub fn dimension(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.dimension_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.dimension_list_dimension_created().into(),
            Done::Revised => t.dimension_dimension_revised().into(),
            Done::Activated => lifecycle(t.dimension_activated()),
            Done::Deprecated => lifecycle(t.dimension_deprecated()),
            Done::Archived => lifecycle(t.dimension_archived()),
            Done::OptionAdded => t.dimension_option_added().into(),
            Done::OptionRevised => t.dimension_option_revised().into(),
            Done::OptionDeprecated => t.dimension_option_deprecated().into(),
            Done::OptionReactivated => t.dimension_option_reactivated().into(),
            Done::Reordered => t.dimension_options_reordered().into(),
        }
    }

    /// The toast on a field's pages.
    pub fn field(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.field_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.field_list_field_created().into(),
            Done::Activated => lifecycle(t.field_activated()),
            Done::Deprecated => lifecycle(t.field_deprecated()),
            Done::Archived => lifecycle(t.field_archived()),
            _ => t.field_field_configured().into(),
        }
    }
}

pub fn routes(area: Area<Session, url::Catalog>, shared: Shared) -> Area<Session, url::Catalog> {
    let area = area
        .route::<url::Catalog>(get(home))
        .route::<url::Dimensions>(get(dimensions).post(create_dimension).with_state(shared.clone()))
        .route::<url::DimensionsLive>(get(dimensions_live).with_state(shared.clone()))
        .route::<url::DimensionsBulk>(post(preview_dimensions).with_state(shared.clone()))
        .route::<url::DimensionsBulkConfirm>(post(confirm_dimensions).with_state(shared.clone()))
        .route::<url::Dimension>(get(dimension).with_state(shared.clone()))
        .route::<url::DimensionEdit>(post(edit_dimension).with_state(shared.clone()))
        .route::<url::DimensionLifecycle>(post(dimension_lifecycle).with_state(shared.clone()))
        .route::<url::Options>(post(add_option).with_state(shared.clone()))
        .route::<url::OptionOrder>(post(reorder_options).with_state(shared.clone()))
        .route::<url::OptionEdit>(post(revise_option).with_state(shared.clone()))
        .route::<url::OptionLifecycle>(post(option_lifecycle).with_state(shared.clone()))
        .route::<url::Fields>(get(fields).post(create_field).with_state(shared.clone()))
        .route::<url::FieldsLive>(get(fields_live).with_state(shared.clone()))
        .route::<url::FieldsBulk>(post(preview_fields).with_state(shared.clone()))
        .route::<url::FieldsBulkConfirm>(post(confirm_fields).with_state(shared.clone()))
        .route::<url::JobLive>(get(job_live).with_state(shared.clone()))
        .route::<url::Field>(get(field).with_state(shared.clone()))
        .route::<url::FieldEdit>(post(configure_field).with_state(shared.clone()))
        .route::<url::FieldLifecycle>(post(field_lifecycle).with_state(shared.clone()));
    let area = scopes::routes(area, shared.clone());
    item::routes(items::routes(area, shared.clone()), shared)
}

/// admin-web's catalog layout opens on the dimensions.
async fn home(req: Req) -> corten::Result {
    req.redirect(&url::Dimensions::default())
}

/// A list's API query: the filters that are set, then `limit` and `offset`
/// (`buildCatalogListApiQuery`).
fn list_query(filters: &[(&str, &Option<String>)], page: u32) -> String {
    let mut query: Vec<String> = filters
        .iter()
        .filter_map(|(key, value)| {
            let value = value.as_deref()?.trim();
            (!value.is_empty()).then(|| format!("{key}={}", segment(value)))
        })
        .collect();
    query.push(format!("limit={PAGE_SIZE}"));
    query.push(format!("offset={}", (page - 1) * PAGE_SIZE));
    query.join("&")
}

fn screen<T, P>(list: List<T>, page: u32) -> ListScreen<T, P> {
    ListScreen {
        pages: list.total.div_ceil(PAGE_SIZE).max(1),
        total: list.total,
        items: list.items,
        page,
        preview: None,
        job: None,
    }
}

/// What a command came to.
enum Sent {
    Written(Written),
    /// The API's refusal, for the form.
    Refused(Errors),
    /// An answer other than the form: sign in again, or the API failing.
    Denied(Denied),
}

async fn command(caller: &Caller<'_>, method: Method, kind: Kind, rest: &str, body: Option<&Value>) -> Sent {
    match caller.command(method, kind, rest, body).await {
        Ok(written) => Sent::Written(written),
        Err(error) => match refused(error) {
            Ok(errors) => Sent::Refused(errors),
            Err(denied) => Sent::Denied(denied),
        },
    }
}

fn receipt(written: &Written) -> Option<String> {
    written.receipt.as_ref().map(Receipt::param)
}

/// A form whose input is not one it offers: the form's message.
fn not_offered(p: Pilot) -> Errors {
    let mut errors = Errors::new();
    errors.add_form(p.catalog_action());
    errors
}

/// The Catalog's realtime topic for a list (`catalogRealtimeTopics.adminSurface`).
const DIMENSIONS_TOPIC: &str = "catalog:admin:dimensions";
const FIELDS_TOPIC: &str = "catalog:admin:fields";

/// A list's rows for `<corten-live>`, drawn on each change to `topic` until the API refuses the
/// stream. Each fragment carries the realtime stream's cursor after it, so a browser that
/// reconnects (`since`, from its `Last-Event-ID`) gets what changed while it was away, and
/// nothing when nothing did. A first connection has no cursor (the list's read does not give one),
/// so the rows are drawn once the stream is open: a change after the page was drawn is not missed.
/// A read that fails sends nothing, and the rows stay as they were.
fn live_rows<F, Fut>(config: Shared, headers: HeaderMap, since: LiveSince, topic: &'static str, rows: F) -> impl IntoResponse
where
    F: Fn(Shared, HeaderMap) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    let resumed = since.0.is_some();
    let changes = config.platform.caller(&headers, config.proto, None).changes(&[topic], since.0);
    let fragments = changes
        .take_while(|tick| std::future::ready(!matches!(tick, Tick::Refused(_))))
        .filter_map(move |tick| {
            std::future::ready(match tick {
                Tick::Opened(_) if resumed => None,
                Tick::Opened(cursor) | Tick::Changed(cursor, _) => Some(cursor),
                Tick::Refused(_) => None,
            })
        })
        .then(move |cursor| {
            let rows = rows(config.clone(), headers.clone());
            async move {
                let html = rows.await?;
                Some(match cursor {
                    Some(cursor) => Fragment::new(html).cursor(cursor),
                    None => Fragment::new(html),
                })
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

// Dimensions.

async fn dimensions(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::DimensionQuery>,
    Query(notice): Query<url::ListNotice>,
) -> corten::Result {
    dimension_list(&req, &config, &headers, &query, &notice, None, None).await
}

/// The dimensions page; `create` is a create form that came back, drawn open, and `preview` a
/// bulk preview's answer, drawn open.
async fn dimension_list(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::DimensionQuery,
    notice: &url::ListNotice,
    create: Option<Draft<DimensionInput>>,
    preview: Option<Previewed<'_>>,
) -> corten::Result {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let api = list_query(&[("search", &query.search), ("status", &query.status), ("valueKind", &query.value_kind)], page);
    let list = match caller.list::<Dimension>(Kind::Dimensions, &api).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(req, t, Kind::Dimensions, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.dimension(t));
    let view = views::dimension_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(Meta::new(t.route_dimensions()), &screen, view)
}

async fn dimensions_live(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Query(query): Query<url::DimensionQuery>,
) -> impl IntoResponse {
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&req);
    live_rows(config, headers, since, DIMENSIONS_TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            let api = list_query(&[("search", &query.search), ("status", &query.status), ("valueKind", &query.value_kind)], page);
            match caller.list::<Dimension>(Kind::Dimensions, &api).await {
                Ok(list) => Some(views::dimension_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("dimensions list read for a change failed: {error}");
                    None
                }
            }
        }
    })
}

async fn create_dimension(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::DimensionQuery>,
    Form(input): Form<DimensionInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Dimensions, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
            return req.redirect(&url::Dimensions { query, notice });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Dimensions::of(&query).href();
    let form = views::DimensionForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || dimension_list(&req, &config, &headers, &query, &none, Some(draft.clone()), None)).await
}

async fn dimension(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(after): Query<url::After>,
) -> corten::Result {
    dimension_page(&req, &config, &headers, &id, &after, DimensionForms::default()).await
}

/// A dimension's page, with `forms` in place of its values.
async fn dimension_page(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &url::After,
    forms: DimensionForms,
) -> corten::Result {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let detail = match caller.get::<DimensionDetail>(Kind::Dimensions, id).await {
        Ok(detail) => detail,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.dimension(t));
    let view = views::dimension_page(t, req.t(), &detail, notice, forms);
    req.screen(Meta::new(t.route_dimension()), &detail, view)
}

/// After a write to dimension `id`: its page, waiting for the write.
fn to_dimension(req: &Req, id: &str, written: &Written, done: Done) -> corten::Result {
    req.redirect(&url::Dimension { id, after_write: receipt(written), done: Some(done) })
}

/// A form of dimension `id` that came back: the form as a patch (422), or the page with it.
async fn dimension_invalid(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    errors: &Errors,
    form: impl Render,
    forms: DimensionForms,
) -> corten::Result {
    let after = url::After::default();
    req.invalid(errors, form, || dimension_page(req, config, headers, id, &after, forms)).await
}

async fn edit_dimension(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<DimensionInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::PUT, Kind::Dimensions, &under(&id, &[]), Some(&input.body(false))).await {
        Sent::Written(written) => return to_dimension(&req, &id, &written, Done::Revised),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::DimensionEdit { id: &id }.href();
    let form = views::DimensionForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = DimensionForms { edit: Some(draft.clone()), ..Default::default() };
    dimension_invalid(&req, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn dimension_lifecycle(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<ActionInput>,
) -> corten::Result {
    let errors = match input.of(&["activate", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Dimensions, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_dimension(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::transitions(&input.status, t.dimension_activate(), t.dimension_deprecate(), t.dimension_archive());
    let action = url::DimensionLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = DimensionForms { lifecycle: Some(errors.clone()), ..Default::default() };
    dimension_invalid(&req, &config, &headers, &id, &errors, form, forms).await
}

async fn add_option(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<OptionInput>,
) -> corten::Result {
    let action = url::Options { id: &id }.href();
    if let Some(next) = input.relabeled() {
        let draft = Draft::new(next);
        let form = views::OptionForm { t: req.t(), id: ids::ADD_OPTION, action: &action, add: true, form: &draft };
        let forms = DimensionForms { add: Some(draft.clone()), ..Default::default() };
        return redraw(&req, &config, &headers, &id, form, forms).await;
    }
    let errors = match input.body(req.t(), true) {
        Ok(body) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Dimensions, &under(&id, &["options"]), Some(&body)).await {
                Sent::Written(written) => return to_dimension(&req, &id, &written, Done::OptionAdded),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::OptionForm { t: req.t(), id: ids::ADD_OPTION, action: &action, add: true, form: &draft };
    let forms = DimensionForms { add: Some(draft.clone()), ..Default::default() };
    dimension_invalid(&req, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn revise_option(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path((id, option_id)): Path<(String, String)>,
    Form(input): Form<OptionInput>,
) -> corten::Result {
    let action = url::OptionEdit { id: &id, option_id: &option_id }.href();
    let form_id = ids::option_form(&option_id);
    if let Some(next) = input.relabeled() {
        let draft = Draft::new(next);
        let form = views::OptionForm { t: req.t(), id: &form_id, action: &action, add: false, form: &draft };
        let forms = DimensionForms { option: Some((option_id.clone(), draft.clone())), ..Default::default() };
        return redraw(&req, &config, &headers, &id, form, forms).await;
    }
    let errors = match input.body(req.t(), false) {
        Ok(body) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::PUT, Kind::Dimensions, &under(&id, &["options", &option_id]), Some(&body)).await {
                Sent::Written(written) => return to_dimension(&req, &id, &written, Done::OptionRevised),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::OptionForm { t: req.t(), id: &form_id, action: &action, add: false, form: &draft };
    let forms = DimensionForms { option: Some((option_id.clone(), draft.clone())), ..Default::default() };
    dimension_invalid(&req, &config, &headers, &id, &draft.errors, form, forms).await
}

/// A form drawn again without writing (a label row added or removed): the form as a patch, or
/// the page with it open.
async fn redraw(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    form: impl Render,
    forms: DimensionForms,
) -> corten::Result {
    if req.mode == Mode::Action {
        return req.patch(form);
    }
    let after = url::After::default();
    dimension_page(req, config, headers, id, &after, forms).await
}

async fn option_lifecycle(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path((id, option_id)): Path<(String, String)>,
    Form(input): Form<ActionInput>,
) -> corten::Result {
    let errors = match input.of(&["deprecate", "reactivate"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Dimensions, &under(&id, &["options", &option_id, action]), None).await {
                Sent::Written(written) => {
                    let done = if action == "deprecate" { Done::OptionDeprecated } else { Done::OptionReactivated };
                    return to_dimension(&req, &id, &written, done);
                }
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let action = url::OptionLifecycle { id: &id, option_id: &option_id }.href();
    let form_id = ids::option_lifecycle(&option_id);
    let form = views::OptionLifecycleForm { t: req.t(), id: &form_id, action: &action, status: &input.status, errors: &errors };
    let forms = DimensionForms { option_lifecycle: Some((option_id.clone(), errors.clone())), ..Default::default() };
    dimension_invalid(&req, &config, &headers, &id, &errors, form, forms).await
}

async fn reorder_options(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<ReorderInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors =
        match command(&caller, Method::PUT, Kind::Dimensions, &under(&id, &["options", "order"]), Some(&input.body())).await {
            Sent::Written(written) => return to_dimension(&req, &id, &written, Done::Reordered),
            Sent::Refused(errors) => errors,
            Sent::Denied(denied) => return denied.answer(&req),
        };
    let draft = Draft { input, errors };
    let action = url::OptionOrder { id: &id }.href();
    let form = views::ReorderForm { t: req.t(), id: ids::REORDER, action: &action, form: &draft };
    let forms = DimensionForms { reorder: Some(draft.clone()), ..Default::default() };
    dimension_invalid(&req, &config, &headers, &id, &draft.errors, form, forms).await
}

// Fields.

async fn fields(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::FieldQuery>,
    Query(notice): Query<url::ListNotice>,
) -> corten::Result {
    field_list(&req, &config, &headers, &query, &notice, None, None).await
}

async fn field_list(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::FieldQuery,
    notice: &url::ListNotice,
    create: Option<Draft<FieldInput>>,
    preview: Option<Previewed<'_>>,
) -> corten::Result {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<Field>(Kind::Fields, &field_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(req, t, Kind::Fields, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.field(t));
    let view = views::field_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(Meta::new(t.route_fields()), &screen, view)
}

/// The fields list's API query.
fn field_query(query: &url::FieldQuery, page: u32) -> String {
    let filters = [
        ("search", &query.search),
        ("status", &query.status),
        ("valueType", &query.value_type),
        ("filterable", &query.filterable),
        ("searchable", &query.searchable),
        ("sortable", &query.sortable),
    ];
    list_query(&filters, page)
}

async fn fields_live(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Query(query): Query<url::FieldQuery>,
) -> impl IntoResponse {
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&req);
    live_rows(config, headers, since, FIELDS_TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<Field>(Kind::Fields, &field_query(&query, page)).await {
                Ok(list) => Some(views::field_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("fields list read for a change failed: {error}");
                    None
                }
            }
        }
    })
}

async fn create_field(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::FieldQuery>,
    Form(input): Form<FieldInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Fields, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
            return req.redirect(&url::Fields { query, notice });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Fields::of(&query).href();
    let form = views::FieldForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || field_list(&req, &config, &headers, &query, &none, Some(draft.clone()), None)).await
}

async fn field(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(after): Query<url::After>,
) -> corten::Result {
    field_page(&req, &config, &headers, &id, &after, FieldForms::default()).await
}

async fn field_page(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &url::After,
    forms: FieldForms,
) -> corten::Result {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let field = match caller.get::<Field>(Kind::Fields, id).await {
        Ok(field) => field,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.field(t));
    let view = views::field_page(t, req.t(), &field, notice, forms);
    req.screen(Meta::new(t.route_field()), &field, view)
}

fn to_field(req: &Req, id: &str, written: &Written, done: Done) -> corten::Result {
    req.redirect(&url::Field { id, after_write: receipt(written), done: Some(done) })
}

async fn configure_field(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<FieldInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::PUT, Kind::Fields, &under(&id, &[]), Some(&input.body(false))).await {
        Sent::Written(written) => return to_field(&req, &id, &written, Done::Revised),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::FieldEdit { id: &id }.href();
    let form = views::FieldForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = FieldForms { edit: Some(draft.clone()), ..Default::default() };
    let after = url::After::default();
    req.invalid(&draft.errors, form, || field_page(&req, &config, &headers, &id, &after, forms)).await
}

async fn field_lifecycle(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<ActionInput>,
) -> corten::Result {
    let errors = match input.of(&["activate", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Fields, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_field(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::transitions(&input.status, t.field_activate(), t.field_deprecate(), t.field_archive());
    let action = url::FieldLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = FieldForms { lifecycle: Some(errors.clone()), ..Default::default() };
    let after = url::After::default();
    req.invalid(&errors, form, || field_page(&req, &config, &headers, &id, &after, forms)).await
}

// Bulk changes.

/// The actions a bulk change offers (`lifecycleActions` on both lists).
const BULK_ACTIONS: [&str; 3] = ["activate", "deprecate", "archive"];

/// Whether the viewer may change the area's records: the bulk bar is theirs (its posts need
/// `catalog.manage`, as the API's do).
fn manages(req: &Req) -> bool {
    matches!(req.context::<Session>(), Some(Session::Staff(viewer)) if viewer.can(MANAGE))
}

/// An action's label for records of `kind`, or the action itself when it is not one offered.
fn action_label(t: Cat, kind: Kind, action: &str) -> &str {
    let actions: Vec<(&str, &str)> = match kind {
        Kind::Dimensions => views::bulk_actions(t.dimension_activate(), t.dimension_deprecate(), t.dimension_archive()).to_vec(),
        Kind::Fields => views::bulk_actions(t.field_activate(), t.field_deprecate(), t.field_archive()).to_vec(),
        // admin-web labels the archive with the item page's Archive.
        Kind::Items => views::item_operations(t)
            .map(|(value, label)| if value == "archive" { (value, t.item_archive()) } else { (value, label) })
            .to_vec(),
        // No bulk changes.
        Kind::ProductContents | Kind::ReferenceRecords | Kind::ScopeRecords | Kind::AttentionQueue | Kind::AliasReview => {
            Vec::new()
        }
    };
    actions.into_iter().find(|(value, _)| *value == action).map_or(action, |(_, label)| label)
}

/// The job a list page follows (`?job=`), or none when it asks for none or the API does not
/// know it (the dialog says so).
async fn follow(caller: &Caller<'_>, id: Option<&str>) -> Option<Job<Value>> {
    match caller.job(id?).await {
        Ok(job) => Some(job),
        Err(error) => {
            tracing::warn!("bulk job read failed: {error}");
            None
        }
    }
}

/// A list page's bulk parts: the bar for staff who may change the records, the preview to draw
/// open, and the job's dialog when the page follows one (`asked`), its stream while it runs.
fn bulk<'a>(req: &Req, t: Cat, kind: Kind, asked: bool, preview: Option<Previewed<'a>>, job: Option<&'a Job<Value>>) -> Bulk<'a> {
    let followed = asked.then(|| Followed {
        job,
        label: job.map_or("", |job| action_label(t, job.of().unwrap_or(kind), &job.action)),
        live: job.filter(|job| !job.done()).map(|job| url::JobLive { id: &job.job_id }.href()),
    });
    Bulk { manage: manages(req), preview, job: followed }
}

/// The filters set on a list, as the API's bulk selection reads them (`dimensionListQueryFromRecord`).
fn filter_query(filters: &[(&str, &Option<String>)]) -> Value {
    let set = filters.iter().filter_map(|(key, value)| {
        let value = value.as_deref()?.trim();
        (!value.is_empty()).then(|| ((*key).to_owned(), Value::String(value.to_owned())))
    });
    Value::Object(set.collect::<Map<_, _>>())
}

fn dimension_filter(query: &url::DimensionQuery) -> Value {
    filter_query(&[("search", &query.search), ("status", &query.status), ("valueKind", &query.value_kind)])
}

fn field_filter(query: &url::FieldQuery) -> Value {
    filter_query(&[
        ("search", &query.search),
        ("status", &query.status),
        ("valueType", &query.value_type),
        ("filterable", &query.filterable),
        ("searchable", &query.searchable),
        ("sortable", &query.sortable),
    ])
}

/// The form's message when it is not a change the bar offers, or the checked rows when there
/// are none; the API decides the rest (which records are ready).
fn bulk_refusal(p: Pilot, input: &BulkInput) -> Option<Errors> {
    let mut errors = Errors::new();
    if !BULK_ACTIONS.contains(&input.action.as_str()) || !matches!(input.mode.as_str(), "ids" | "filter") {
        errors.add_form(p.catalog_action());
    } else if input.mode == "ids" && input.ids.is_empty() {
        errors.add_form(p.bulk_none_selected());
    }
    (!errors.is_empty()).then_some(errors)
}

/// What a preview came to.
enum Previewing {
    Shown(Preview),
    Refused(Errors),
    Denied(Denied),
}

async fn preview(req: &Req, caller: &Caller<'_>, kind: Kind, input: &BulkInput, filter: Value) -> Previewing {
    if let Some(errors) = bulk_refusal(req.t(), input) {
        return Previewing::Refused(errors);
    }
    match caller.bulk_preview(kind, &input.body(filter)).await {
        Ok(preview) => Previewing::Shown(preview),
        Err(error) => match refused(error) {
            Ok(errors) => Previewing::Refused(errors),
            Err(denied) => Previewing::Denied(denied),
        },
    }
}

/// A preview's answer: its dialog as a patch, or the list page with it open; a refusal is the
/// dialog with the message (422).
async fn answer_preview<'a, F, Fut>(req: &Req, shown: Previewed<'a>, page: F) -> corten::Result
where
    F: FnOnce(Previewed<'a>) -> Fut,
    Fut: Future<Output = corten::Result>,
{
    let dialog = views::PreviewDialog { t: req.t(), p: req.t(), shown };
    if !shown.errors.is_empty() {
        return req.invalid(shown.errors, dialog, || page(shown)).await;
    }
    if req.mode == Mode::Action {
        return req.patch(dialog);
    }
    page(shown).await
}

async fn preview_dimensions(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::DimensionQuery>,
    Form(input): Form<BulkInput>,
) -> corten::Result {
    let confirm = url::DimensionsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::Dimensions, &input, dimension_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Dimensions, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| dimension_list(&req, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn preview_fields(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::FieldQuery>,
    Form(input): Form<BulkInput>,
) -> corten::Result {
    let confirm = url::FieldsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::Fields, &input, field_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Fields, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| field_list(&req, &config, &headers, &query, &none, None, Some(shown))).await
}

/// What a confirm came to: the job the API started, or the refusal and the preview again (for
/// the dialog it is drawn in).
enum Confirming {
    Started(Job),
    Refused(Errors, Option<Preview>),
    Denied(Denied),
}

async fn confirm(req: &Req, caller: &Caller<'_>, kind: Kind, input: &BulkInput, filter: Value) -> Confirming {
    let errors = match bulk_refusal(req.t(), input) {
        Some(errors) => errors,
        None => match caller.bulk_confirm(kind, &input.body(filter.clone())).await {
            Ok(job) => return Confirming::Started(job),
            Err(error) => match refused(error) {
                Ok(errors) => errors,
                Err(denied) => return Confirming::Denied(denied),
            },
        },
    };
    let again = match preview(req, caller, kind, input, filter).await {
        Previewing::Shown(preview) => Some(preview),
        _ => None,
    };
    Confirming::Refused(errors, again)
}

async fn confirm_dimensions(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::DimensionQuery>,
    Form(input): Form<BulkInput>,
) -> corten::Result {
    let action = url::DimensionsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::Dimensions, &input, dimension_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::Dimensions { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Dimensions, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| dimension_list(&req, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn confirm_fields(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::FieldQuery>,
    Form(input): Form<BulkInput>,
) -> corten::Result {
    let action = url::FieldsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::Fields, &input, field_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::Fields { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Fields, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| field_list(&req, &config, &headers, &query, &none, None, Some(shown))).await
}

/// A job's status for `<corten-live>`: each change the job's stream sends, drawn, until the job
/// is done (the stream then ends, so the element stays as it is). Each fragment carries the job
/// event's id, so a browser that reconnects (`since`) gets only the changes after the status it
/// shows. The page's read of the job has no event id, so a first connection replays the job's
/// events from its start.
async fn job_live(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let caller = config.platform.caller(&headers, config.proto, None);
    let updates = caller.watch_job::<Job<Value>>(&api::job_events(&id), api::CONTEXT, since.0, Job::done);
    let fragments = updates.map(move |update| match update {
        Update::Job(job, Some(event)) => Fragment::new(views::job_status(t, p, Some(&job)).to_html()).cursor(event),
        Update::Job(job, None) => Fragment::new(views::job_status(t, p, Some(&job)).to_html()),
        Update::Refused(_) => Fragment::new(views::job_status(t, p, None).to_html()),
    });
    corten::live(fragments)
}
