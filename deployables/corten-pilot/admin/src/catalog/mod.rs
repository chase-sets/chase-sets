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
//! | `GET /catalog/dimensions/{id}` | the dimension and its options |
//! | `POST /catalog/dimensions/{id}/edit`, `/lifecycle` | revise; activate, deprecate, archive |
//! | `POST /catalog/dimensions/{id}/options`, `/options/order` | add an option; reorder them |
//! | `POST /catalog/dimensions/{id}/options/{option_id}`, `.../lifecycle` | revise; deprecate, reactivate |
//! | `GET /catalog/fields?search&status&value_type&filterable&searchable&sortable&page` | the list; `POST` creates |
//! | `GET /catalog/fields/{id}`, `POST .../edit`, `.../lifecycle` | the field; configure; its status |
//!
//! Not ported: bulk lifecycle changes with job progress, and the realtime revalidation over
//! server-sent events (see README.md).
use std::fmt;

use corten::{axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde::Deserialize;
use serde_json::Value;

pub mod api;
pub mod form;
pub mod views;

use crate::{
    api::{Caller, Method, segment},
    app::{Denied, Shared, read_failed, refused},
    auth::Session,
    text::{Cat, Pilot},
};
use api::{Catalog as _, Dimension, DimensionDetail, Field, Kind, List, Written, under};
use form::{ActionInput, DimensionInput, FieldInput, OptionInput, ReorderInput};
use views::{DimensionForms, Draft, FieldForms, ListScreen, ids};

pub const VIEW: &str = "catalog.view";
pub const MANAGE: &str = "catalog.manage";
/// `CATALOG_LIST_PAGE_SIZE`.
const PAGE_SIZE: u32 = 50;

/// Every URL the area serves.
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    pub use super::Done;

    /// The area: its routes, stylesheet and guard.
    #[derive(Route)]
    #[route("/catalog")]
    pub struct Catalog;

    /// The dimensions list: its filters, the page (from 1), and the receipt and notice of the
    /// write before.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route("/catalog/dimensions")]
    pub struct Dimensions {
        pub search: Option<String>,
        pub status: Option<String>,
        pub value_kind: Option<String>,
        pub page: Option<u32>,
        pub after_write: Option<String>,
        pub done: Option<Done>,
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

    /// The fields list; the flags are `true` or `false`.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route("/catalog/fields")]
    pub struct Fields {
        pub search: Option<String>,
        pub status: Option<String>,
        pub value_type: Option<String>,
        pub filterable: Option<String>,
        pub searchable: Option<String>,
        pub sortable: Option<String>,
        pub page: Option<u32>,
        pub after_write: Option<String>,
        pub done: Option<Done>,
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
    area.route::<url::Catalog>(get(home))
        .route::<url::Dimensions>(get(dimensions).post(create_dimension).with_state(shared.clone()))
        .route::<url::Dimension>(get(dimension).with_state(shared.clone()))
        .route::<url::DimensionEdit>(post(edit_dimension).with_state(shared.clone()))
        .route::<url::DimensionLifecycle>(post(dimension_lifecycle).with_state(shared.clone()))
        .route::<url::Options>(post(add_option).with_state(shared.clone()))
        .route::<url::OptionOrder>(post(reorder_options).with_state(shared.clone()))
        .route::<url::OptionEdit>(post(revise_option).with_state(shared.clone()))
        .route::<url::OptionLifecycle>(post(option_lifecycle).with_state(shared.clone()))
        .route::<url::Fields>(get(fields).post(create_field).with_state(shared.clone()))
        .route::<url::Field>(get(field).with_state(shared.clone()))
        .route::<url::FieldEdit>(post(configure_field).with_state(shared.clone()))
        .route::<url::FieldLifecycle>(post(field_lifecycle).with_state(shared))
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

fn screen<T>(list: List<T>, page: u32) -> ListScreen<T> {
    ListScreen { pages: list.total.div_ceil(PAGE_SIZE).max(1), total: list.total, items: list.items, page }
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

// Dimensions.

async fn dimensions(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::Dimensions>,
) -> corten::Result {
    dimension_list(&req, &config, &headers, &query, None).await
}

/// The dimensions page; `create` is a create form that came back, drawn open.
async fn dimension_list(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::Dimensions,
    create: Option<Draft<DimensionInput>>,
) -> corten::Result {
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let api = list_query(&[("search", &query.search), ("status", &query.status), ("valueKind", &query.value_kind)], page);
    let list = match caller.list::<Dimension>(Kind::Dimensions, &api).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = screen(list, page);
    let t: Cat = req.t();
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(DimensionInput::blank()));
    let notice = query.done.map(|done| done.dimension(t));
    let view = views::dimension_list(t, req.t(), query, &screen, create, open, notice);
    req.screen(Meta::new(t.route_dimensions()), &screen, view)
}

async fn create_dimension(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::Dimensions>,
    Form(input): Form<DimensionInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Dimensions, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            return req.redirect(&url::Dimensions { after_write: receipt(&written), done: Some(Done::Created), ..query });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Dimensions { after_write: None, done: None, ..query.clone() }.href();
    let form = views::DimensionForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    req.invalid(&draft.errors, form, || dimension_list(&req, &config, &headers, &query, Some(draft.clone()))).await
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

async fn fields(req: Req, State(config): State<Shared>, headers: HeaderMap, Query(query): Query<url::Fields>) -> corten::Result {
    field_list(&req, &config, &headers, &query, None).await
}

async fn field_list(
    req: &Req,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::Fields,
    create: Option<Draft<FieldInput>>,
) -> corten::Result {
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let filters = [
        ("search", &query.search),
        ("status", &query.status),
        ("valueType", &query.value_type),
        ("filterable", &query.filterable),
        ("searchable", &query.searchable),
        ("sortable", &query.sortable),
    ];
    let list = match caller.list::<Field>(Kind::Fields, &list_query(&filters, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = screen(list, page);
    let t: Cat = req.t();
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(FieldInput::blank()));
    let notice = query.done.map(|done| done.field(t));
    let view = views::field_list(t, req.t(), query, &screen, create, open, notice);
    req.screen(Meta::new(t.route_fields()), &screen, view)
}

async fn create_field(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::Fields>,
    Form(input): Form<FieldInput>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Fields, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            return req.redirect(&url::Fields { after_write: receipt(&written), done: Some(Done::Created), ..query });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Fields { after_write: None, done: None, ..query.clone() }.href();
    let form = views::FieldForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    req.invalid(&draft.errors, form, || field_list(&req, &config, &headers, &query, Some(draft.clone()))).await
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
