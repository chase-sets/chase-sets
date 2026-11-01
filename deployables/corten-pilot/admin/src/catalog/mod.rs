//! The catalog area (`/catalog`): admin-web's catalog authoring screens for dimensions and
//! fields, through the Catalog API (`/api/catalog`) as the signed-in staff member. The area
//! has its own stylesheet and caller (`Staff<CatalogAccess>`): reading needs `catalog.view`, writing `catalog.manage`, as
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
//! | `GET /catalog/scopes/{id}` and its writes | a scope's page (`scope`) |
//! | `GET /catalog/categories?...` and its writes | the categories list and a category's page (`categories`) |
//! | `GET /catalog/components?...` and its writes | the components list and a component's page with its rules (`components`) |
//! | `GET /catalog/blueprints?...` and its writes | the blueprints list and a blueprint's page with its components and rules (`blueprints`) |
//! | `GET /catalog/display-templates?...` and its writes | the display templates list and a template's page (`display_templates`) |
//! | `GET /catalog/reference-types?...` and its writes | the reference types list and a type's page (`reference_types`) |
//! | `GET /catalog/reference-records?...` and its writes | the reference records list and a record's page (`reference_records`) |
//! | `GET /catalog/source-observations/{id}` and its review | a Source Observation (`observation`) |
//!
//! The lists are kept current as admin-web's are (`useCatalogRealtimeRevalidation`): a change to
//! the Catalog topic `catalog:admin:dimensions` (or `:fields`) reads the list again, and the
//! server sends the rows it draws. The detail pages are not live in admin-web either.
//!
//! A bulk change is admin-web's `BulkLifecycleActionBar`: the checked rows (or every record the
//! filters match) and an action, previewed by the API, then confirmed; the API runs it as a job,
//! whose progress the list's dialog follows from the job's own stream.
use corten::{Fragment, LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use futures_util::StreamExt;
use platform::{jobs::Update, receipt::Receipt};
use serde::Deserialize;
use serde_json::{Map, Value};

pub mod api;
pub mod attention;
pub mod blueprints;
pub mod categories;
pub mod components;
pub mod coverage;
pub mod display_templates;
pub mod form;
pub mod item;
pub mod items;
pub mod observation;
pub mod reference_records;
pub mod reference_types;
pub mod scope;
pub mod scopes;
pub mod sync_batches;
pub mod views;

use crate::{
    api::{Caller, Method, segment},
    app::{Denied, Shared, live_rows, read_failed, refused},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};
use api::{Catalog as _, Dimension, DimensionDetail, Field, Job, Kind, List, Preview, Written, under};
use form::{ActionInput, BulkInput, DimensionInput, FieldInput, OptionInput, ReorderInput};
use views::{Bulk, DimensionForms, Draft, FieldForms, Followed, ListScreen, Previewed, ids};

pub const VIEW: &str = "catalog.view";
pub const MANAGE: &str = "catalog.manage";
/// `CATALOG_LIST_PAGE_SIZE`.
pub(crate) const PAGE_SIZE: u32 = 50;

/// Every URL the area serves, with its handlers: every one takes staff who may read the catalog,
/// and who may change it for a write (`CatalogAccess`).
#[corten::routes(state = Shared, area = Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use super::Done;
    pub use super::item::url as item;
    pub use super::items::url::{ItemQuery, Items, ItemsBulk, ItemsDrafts, ItemsLive};
    pub use super::scopes::url::{ScopeQuery, Scopes};

    /// The area: admin-web's catalog layout opens on the dimensions.
    #[route("/catalog", get = home)]
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
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/dimensions", get = dimensions, post = create_dimension)]
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
    #[route("/catalog/dimensions/live", get = dimensions_live)]
    pub struct DimensionsLive {
        #[route(query)]
        pub query: DimensionQuery,
    }

    /// A bulk change of the dimensions: its preview (without JavaScript the answer is the list,
    /// with the preview open).
    #[route("/catalog/dimensions/bulk", post = preview_dimensions)]
    pub struct DimensionsBulk {
        #[route(query)]
        pub query: DimensionQuery,
    }

    /// The preview's confirm: it starts the change.
    #[route("/catalog/dimensions/bulk/confirm", post = confirm_dimensions)]
    pub struct DimensionsBulkConfirm {
        #[route(query)]
        pub query: DimensionQuery,
    }

    #[route("/catalog/dimensions/{id}", get = dimension)]
    pub struct Dimension<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<Done>,
    }

    #[route("/catalog/dimensions/{id}/edit", post = edit_dimension)]
    pub struct DimensionEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/dimensions/{id}/lifecycle", post = dimension_lifecycle)]
    pub struct DimensionLifecycle<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/dimensions/{id}/options", post = add_option)]
    pub struct Options<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/dimensions/{id}/options/order", post = reorder_options)]
    pub struct OptionOrder<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/dimensions/{id}/options/{option_id}", post = revise_option)]
    pub struct OptionEdit<'a> {
        pub id: &'a str,
        pub option_id: &'a str,
    }

    #[route("/catalog/dimensions/{id}/options/{option_id}/lifecycle", post = option_lifecycle)]
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
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/fields", get = fields, post = create_field)]
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
    #[route("/catalog/fields/live", get = fields_live)]
    pub struct FieldsLive {
        #[route(query)]
        pub query: FieldQuery,
    }

    /// A bulk change of the fields: its preview.
    #[route("/catalog/fields/bulk", post = preview_fields)]
    pub struct FieldsBulk {
        #[route(query)]
        pub query: FieldQuery,
    }

    #[route("/catalog/fields/bulk/confirm", post = confirm_fields)]
    pub struct FieldsBulkConfirm {
        #[route(query)]
        pub query: FieldQuery,
    }

    /// A bulk change's job status, streamed again on each change until it is done.
    #[route("/catalog/jobs/{id}/live", get = job_live)]
    pub struct JobLive<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/fields/{id}", get = field)]
    pub struct Field<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<Done>,
    }

    #[route("/catalog/fields/{id}/edit", post = configure_field)]
    pub struct FieldEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/fields/{id}/lifecycle", post = field_lifecycle)]
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
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, corten::UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum Done {
    Created,
    Revised,
    Activated,
    Published,
    Deprecated,
    Archived,
    OptionAdded,
    OptionRevised,
    OptionDeprecated,
    OptionReactivated,
    Reordered,
    FieldRuleAdded,
    FieldRuleRemoved,
    DimensionRuleAdded,
    DimensionRuleRemoved,
    ComponentAttached,
    ComponentDetached,
    FieldRulesSet,
    DimensionRulesSet,
    ProductResolutionRulesSet,
}

impl Done {
    fn of(action: &str) -> Done {
        match action {
            "activate" => Done::Activated,
            "publish" => Done::Published,
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
            // A component's or a blueprint's outcomes are not a dimension's.
            Done::Revised
            | Done::FieldRuleAdded
            | Done::FieldRuleRemoved
            | Done::DimensionRuleAdded
            | Done::DimensionRuleRemoved
            | Done::ComponentAttached
            | Done::ComponentDetached
            | Done::FieldRulesSet
            | Done::DimensionRulesSet
            | Done::ProductResolutionRulesSet => t.dimension_dimension_revised().into(),
            Done::Activated | Done::Published => lifecycle(t.dimension_activated()),
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
            Done::Activated | Done::Published => lifecycle(t.field_activated()),
            Done::Deprecated => lifecycle(t.field_deprecated()),
            Done::Archived => lifecycle(t.field_archived()),
            _ => t.field_field_configured().into(),
        }
    }

    /// The toast on a category's pages.
    pub fn category(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.category_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.category_list_category_created().into(),
            Done::Activated | Done::Published => lifecycle(t.category_published()),
            Done::Deprecated => lifecycle(t.category_deprecated()),
            Done::Archived => lifecycle(t.category_archived()),
            _ => t.category_category_revised().into(),
        }
    }

    /// The toast on a component's pages.
    pub fn component(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.component_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.component_list_component_created().into(),
            Done::Activated | Done::Published => lifecycle(t.component_activated()),
            Done::Deprecated => lifecycle(t.component_deprecated()),
            Done::Archived => lifecycle(t.component_archived()),
            Done::FieldRuleAdded => t.component_field_rule_added().into(),
            Done::FieldRuleRemoved => t.component_field_rule_removed().into(),
            Done::DimensionRuleAdded => t.component_dimension_rule_added().into(),
            Done::DimensionRuleRemoved => t.component_dimension_rule_removed().into(),
            _ => t.component_component_updated().into(),
        }
    }

    /// The toast on a blueprint's pages.
    pub fn blueprint(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.blueprint_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.blueprint_list_blueprint_created().into(),
            Done::Activated | Done::Published => lifecycle(t.blueprint_published()),
            Done::Deprecated => lifecycle(t.blueprint_deprecated()),
            Done::Archived => lifecycle(t.blueprint_archived()),
            Done::ComponentAttached => t.blueprint_component_attached().into(),
            Done::ComponentDetached => t.blueprint_component_detached().into(),
            Done::FieldRulesSet => t.blueprint_field_rules_set().into(),
            Done::DimensionRulesSet => t.blueprint_dimension_rules_set().into(),
            Done::ProductResolutionRulesSet => t.blueprint_product_resolution_rules_set().into(),
            _ => t.blueprint_blueprint_revised().into(),
        }
    }

    /// The toast on a display template's pages.
    pub fn template(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.template_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.template_list_display_template_created().into(),
            Done::Activated | Done::Published => lifecycle(t.template_published()),
            Done::Deprecated => lifecycle(t.template_deprecated()),
            Done::Archived => lifecycle(t.template_archived()),
            _ => t.template_display_template_revised().into(),
        }
    }

    /// The toast on a reference record's pages.
    pub fn ref_record(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.ref_record_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.ref_record_list_reference_record_created().into(),
            Done::Activated | Done::Published => lifecycle(t.ref_record_published()),
            Done::Deprecated => lifecycle(t.ref_record_deprecated()),
            Done::Archived => lifecycle(t.ref_record_archived()),
            _ => t.ref_record_reference_record_revised().into(),
        }
    }

    /// The toast on a reference type's pages.
    pub fn ref_type(self, t: Cat) -> String {
        let lifecycle = |action: &str| t.ref_type_lifecycle_completed(action).to_string();
        match self {
            Done::Created => t.ref_type_list_reference_type_created().into(),
            Done::Activated | Done::Published => lifecycle(t.ref_type_published()),
            Done::Deprecated => lifecycle(t.ref_type_deprecated()),
            Done::Archived => lifecycle(t.ref_type_archived()),
            _ => t.ref_type_reference_type_revised().into(),
        }
    }
}

/// The area: each screen's routes module (all in `/catalog`, each holding its handlers to the
/// area's caller) and the area's stylesheet.
pub fn area(area: Area<url::Catalog>, shared: Shared) -> Area<url::Catalog> {
    let area = url::area(area, shared.clone());
    let area = scopes::url::area(area, shared.clone());
    let area = scope::url::area(area, shared.clone());
    let area = coverage::url::area(area, shared.clone());
    let area = observation::url::area(area, shared.clone());
    let area = sync_batches::url::area(area, shared.clone());
    let area = attention::url::area(area, shared.clone());
    let area = categories::url::area(area, shared.clone());
    let area = components::url::area(area, shared.clone());
    let area = blueprints::url::area(area, shared.clone());
    let area = display_templates::url::area(area, shared.clone());
    let area = reference_types::url::area(area, shared.clone());
    let area = reference_records::url::area(area, shared.clone());
    let area = items::url::area(area, shared.clone());
    item::url::area(area, shared).components(views::COMPONENTS).components(crate::views::LIVE)
}

/// admin-web's catalog layout opens on the dimensions.
async fn home(req: Req, _: corten::Caller<Staff<CatalogAccess>>) -> HtmlResult {
    req.redirect(&url::Dimensions::default())
}

/// The record `id` as `kind`'s list has it (the record's own table, which a write's command
/// reads), page by page until its row; none when the list does not have it. A command that
/// replaces rules starts from this rather than the detail, whose admin page can miss a change
/// (chase-sets/chase-sets#10823).
async fn listed<T: serde::de::DeserializeOwned>(
    caller: &Caller<'_>,
    kind: Kind,
    id: &str,
    id_of: impl Fn(&T) -> &str,
) -> Result<Option<T>, crate::api::ApiError> {
    let mut page = 1;
    loop {
        let list = caller.list::<T>(kind, &list_query(&[], page)).await?;
        let read = list.items.len();
        if let Some(row) = list.items.into_iter().find(|row| id_of(row) == id) {
            return Ok(Some(row));
        }
        if read == 0 || page * PAGE_SIZE >= list.total {
            return Ok(None);
        }
        page += 1;
    }
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

// Dimensions.

async fn dimensions(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::Dimensions>,
) -> HtmlResult {
    let (query, notice) = (route.query, route.notice);
    dimension_list(&req, &staff.viewer, &config, &headers, &query, &notice, None, None).await
}

/// The dimensions page; `create` is a create form that came back, drawn open, and `preview` a
/// bulk preview's answer, drawn open.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn dimension_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::DimensionQuery,
    notice: &url::ListNotice,
    create: Option<Draft<DimensionInput>>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
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
    let bulk = bulk(viewer, t, Kind::Dimensions, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.dimension(t));
    let view = views::dimension_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_dimensions()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

async fn dimensions_live(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Params(route): Params<crate::catalog::url::DimensionsLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
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
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::Dimensions>,
    Form(input): Form<DimensionInput>,
) -> HtmlResult {
    let query = route.query;
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
    req.invalid(&draft.errors, form, || {
        dimension_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

async fn dimension(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Dimension<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, url::After { after_write: route.after_write, done: route.done });
    dimension_page(&req, &staff.viewer, &config, &headers, &id, &after, DimensionForms::default()).await
}

/// A dimension's page, with `forms` in place of its values.
async fn dimension_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &url::After,
    forms: DimensionForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let detail = match caller.get::<DimensionDetail>(Kind::Dimensions, id).await {
        Ok(detail) => detail,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.dimension(t));
    let view = views::dimension_page(t, req.t(), &detail, notice, forms);
    req.screen(
        &detail,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_dimension()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// After a write to dimension `id`: its page, waiting for the write.
fn to_dimension(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::Dimension { id, after_write: receipt(written), done: Some(done) })
}

/// A form of dimension `id` that came back: the form as a patch (422), or the page with it.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn dimension_invalid(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    errors: &Errors,
    form: impl Patch,
    forms: DimensionForms,
) -> HtmlResult {
    let after = url::After::default();
    req.invalid(errors, form, || dimension_page(req, viewer, config, headers, id, &after, forms)).await
}

async fn edit_dimension(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::DimensionEdit<'_>>,
    Form(input): Form<DimensionInput>,
) -> HtmlResult {
    let id = route.id;
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
    dimension_invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn dimension_lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::DimensionLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
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
    dimension_invalid(&req, &staff.viewer, &config, &headers, &id, &errors, form, forms).await
}

async fn add_option(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::Options<'_>>,
    Form(input): Form<OptionInput>,
) -> HtmlResult {
    let id = route.id;
    let action = url::Options { id: &id }.href();
    if let Some(next) = input.relabeled() {
        let draft = Draft::new(next);
        let form = views::OptionForm { t: req.t(), id: ids::ADD_OPTION, action: &action, add: true, form: &draft };
        let forms = DimensionForms { add: Some(draft.clone()), ..Default::default() };
        return redraw(&req, &staff.viewer, &config, &headers, &id, form, forms).await;
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
    dimension_invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn revise_option(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::OptionEdit<'_>>,
    Form(input): Form<OptionInput>,
) -> HtmlResult {
    let (id, option_id) = (route.id, route.option_id);
    let action = url::OptionEdit { id: &id, option_id: &option_id }.href();
    let form_id = ids::option_form(&option_id);
    if let Some(next) = input.relabeled() {
        let draft = Draft::new(next);
        let form = views::OptionForm { t: req.t(), id: &form_id, action: &action, add: false, form: &draft };
        let forms = DimensionForms { option: Some((option_id.clone(), draft.clone())), ..Default::default() };
        return redraw(&req, &staff.viewer, &config, &headers, &id, form, forms).await;
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
    dimension_invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

/// A form drawn again without writing (a label row added or removed): the form as a patch, or
/// the page with it open.
async fn redraw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    form: impl Patch,
    forms: DimensionForms,
) -> HtmlResult {
    if req.mode == Mode::Action {
        return req.patch(form);
    }
    let after = url::After::default();
    dimension_page(req, viewer, config, headers, id, &after, forms).await
}

async fn option_lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::OptionLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let (id, option_id) = (route.id, route.option_id);
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
    let form = views::OptionLifecycleForm { t: req.t(), id: form_id, action: &action, status: &input.status, errors: &errors };
    let forms = DimensionForms { option_lifecycle: Some((option_id.clone(), errors.clone())), ..Default::default() };
    dimension_invalid(&req, &staff.viewer, &config, &headers, &id, &errors, form, forms).await
}

async fn reorder_options(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::OptionOrder<'_>>,
    Form(input): Form<ReorderInput>,
) -> HtmlResult {
    let id = route.id;
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
    dimension_invalid(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

// Fields.

async fn fields(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::Fields>,
) -> HtmlResult {
    let (query, notice) = (route.query, route.notice);
    field_list(&req, &staff.viewer, &config, &headers, &query, &notice, None, None).await
}

#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn field_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::FieldQuery,
    notice: &url::ListNotice,
    create: Option<Draft<FieldInput>>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
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
    let bulk = bulk(viewer, t, Kind::Fields, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.field(t));
    let view = views::field_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_fields()} head="">{view}</crate::views::Layout>
        },
    )
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
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Params(route): Params<crate::catalog::url::FieldsLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
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
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::Fields>,
    Form(input): Form<FieldInput>,
) -> HtmlResult {
    let query = route.query;
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
    req.invalid(&draft.errors, form, || {
        field_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

async fn field(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Field<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, url::After { after_write: route.after_write, done: route.done });
    field_page(&req, &staff.viewer, &config, &headers, &id, &after, FieldForms::default()).await
}

async fn field_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &url::After,
    forms: FieldForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let field = match caller.get::<Field>(Kind::Fields, id).await {
        Ok(field) => field,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.field(t));
    let view = views::field_page(t, req.t(), &field, notice, forms);
    req.screen(
        &field,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_field()} head="">{view}</crate::views::Layout>
        },
    )
}

fn to_field(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::Field { id, after_write: receipt(written), done: Some(done) })
}

async fn configure_field(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::FieldEdit<'_>>,
    Form(input): Form<FieldInput>,
) -> HtmlResult {
    let id = route.id;
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
    req.invalid(&draft.errors, form, || field_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

async fn field_lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::FieldLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
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
    req.invalid(&errors, form, || field_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

// Bulk changes.

/// The actions a bulk change of `kind` offers (each list's `lifecycleActions`): a category or a
/// blueprint is published where the others are activated.
fn bulk_actions_of(kind: Kind) -> [&'static str; 3] {
    match kind {
        Kind::Categories | Kind::Blueprints | Kind::ReferenceTypes | Kind::ReferenceRecords => {
            ["publish", "deprecate", "archive"]
        }
        _ => ["activate", "deprecate", "archive"],
    }
}

/// Whether the viewer may change the area's records: the bulk bar is theirs (its posts need
/// `catalog.manage`, as the API's do).
fn manages(viewer: &Viewer) -> bool {
    viewer.can(MANAGE)
}

/// An action's label for records of `kind`, or the action itself when it is not one offered.
fn action_label(t: Cat, kind: Kind, action: &str) -> &str {
    let actions: Vec<(&str, &str)> = match kind {
        Kind::Dimensions => views::bulk_actions(t.dimension_activate(), t.dimension_deprecate(), t.dimension_archive()).to_vec(),
        Kind::Fields => views::bulk_actions(t.field_activate(), t.field_deprecate(), t.field_archive()).to_vec(),
        Kind::Categories => views::category_actions(t).to_vec(),
        Kind::Components => views::bulk_actions(t.component_activate(), t.component_deprecate(), t.component_archive()).to_vec(),
        Kind::Blueprints => views::blueprint_actions(t).to_vec(),
        Kind::ReferenceTypes => views::ref_type_actions(t).to_vec(),
        Kind::ReferenceRecords => views::ref_record_actions(t).to_vec(),
        // admin-web labels the archive with the item page's Archive.
        Kind::Items => views::item_operations(t)
            .map(|(value, label)| if value == "archive" { (value, t.item_archive()) } else { (value, label) })
            .to_vec(),
        // No bulk changes.
        Kind::DisplayTemplates
        | Kind::ProductContents
        | Kind::ScopeRecords
        | Kind::AttentionQueue
        | Kind::AliasReview
        | Kind::ProviderScopeMappings
        | Kind::SourceObservations => Vec::new(),
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
fn bulk<'a>(
    viewer: &Viewer,
    t: Cat,
    kind: Kind,
    asked: bool,
    preview: Option<Previewed<'a>>,
    job: Option<&'a Job<Value>>,
) -> Bulk<'a> {
    let followed = asked.then(|| Followed {
        job,
        label: job.map_or("", |job| action_label(t, job.of().unwrap_or(kind), &job.action)),
        live: job.filter(|job| !job.done()).map(|job| url::JobLive { id: &job.job_id }.href()),
    });
    Bulk { manage: manages(viewer), preview, job: followed }
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
fn bulk_refusal(p: Pilot, kind: Kind, input: &BulkInput) -> Option<Errors> {
    let mut errors = Errors::new();
    if !bulk_actions_of(kind).contains(&input.action.as_str()) || !matches!(input.mode.as_str(), "ids" | "filter") {
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
    if let Some(errors) = bulk_refusal(req.t(), kind, input) {
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
async fn answer_preview<'a, F, Fut>(req: &Req, shown: Previewed<'a>, page: F) -> HtmlResult
where
    F: FnOnce(Previewed<'a>) -> Fut,
    Fut: Future<Output = HtmlResult>,
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
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::DimensionsBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
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
    answer_preview(&req, shown, |shown| dimension_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown)))
        .await
}

async fn preview_fields(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::FieldsBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
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
    answer_preview(&req, shown, |shown| field_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown)))
        .await
}

/// What a confirm came to: the job the API started, or the refusal and the preview again (for
/// the dialog it is drawn in).
enum Confirming {
    Started(Job),
    Refused(Errors, Option<Preview>),
    Denied(Denied),
}

async fn confirm(req: &Req, caller: &Caller<'_>, kind: Kind, input: &BulkInput, filter: Value) -> Confirming {
    let errors = match bulk_refusal(req.t(), kind, input) {
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
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::DimensionsBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
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
    answer_preview(&req, shown, |shown| dimension_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown)))
        .await
}

async fn confirm_fields(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::url::FieldsBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
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
    answer_preview(&req, shown, |shown| field_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown)))
        .await
}

/// A job's status for `<corten-live>`: each change the job's stream sends, drawn, until the job
/// is done (the stream then ends, so the element stays as it is). Each fragment carries the job
/// event's id, so a browser that reconnects (`since`) gets only the changes after the status it
/// shows. The page's read of the job has no event id, so a first connection replays the job's
/// events from its start.
async fn job_live(
    req: Req,
    _: corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Params(route): Params<crate::catalog::url::JobLive<'_>>,
) -> LiveResponse {
    let id = route.id;
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
