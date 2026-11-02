//! The blueprints (`/catalog/blueprints`, admin-web's `/catalog/blueprints`): the list with its
//! filters, bulk lifecycle changes and create dialog, and a blueprint's page with its status
//! change, edit dialog, its components (attach, detach) and its field, dimension and product
//! resolution rules (set), through the Catalog API's blueprint routes (`/api/catalog/blueprints`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/blueprints?search&status&has_components&has_field_rules&has_dimension_rules&page` | the list; `POST` creates |
//! | `GET /catalog/blueprints/live?...` | the list's rows, again on each change (`<corten-live>`) |
//! | `POST /catalog/blueprints/bulk?...`, `.../bulk/confirm?...` | a bulk change's preview; starts it |
//! | `GET /catalog/blueprints/{id}`, `POST .../edit`, `.../lifecycle` | the blueprint; revise it; its status |
//! | `POST /catalog/blueprints/{id}/components`, `.../components/{component_id}/detach` | attach or detach a component |
//! | `GET /catalog/blueprints/{id}/field-rules`, `.../dimension-rules`, `.../product-resolution-rules` | a Set dialog (drawn when opened); `POST` sets |
//!
//! A Set replaces every rule of its kind with the rows it sends. Its dialog starts from the rules
//! the list has (the blueprint's own table), read when it is opened, not from the page's read,
//! which can miss a change (chase-sets/chase-sets#10823): a rule it missed would be deleted, as
//! a component's edit did (chase-sets/chase-sets#10824). Opening it carries the page's receipt,
//! so the rules it starts from include the write the page shows.
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde_json::Value;

use super::{
    Confirming, Done, Previewing, Sent, action_label, answer_preview,
    api::{Blueprint, BlueprintDetail, BlueprintRules, Catalog as _, Kind, Written, under},
    bulk, command, confirm, filter_query, follow,
    form::{ActionInput, AttachInput, BlueprintInput, BulkInput, DimensionRulesInput, FieldRulesInput, OrderInput},
    list_query, listed, manages, not_offered, preview, receipt, screen,
    views::{self, BlueprintForms, Draft, Previewed, Set, SetRules, ids},
};
use crate::{
    api::{ApiError, Caller, Method},
    app::{Shared, live_rows, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the list (`catalogRealtimeRouteTopics.blueprints`).
const TOPIC: &str = "catalog:admin:blueprints";

/// The list's filters (`buildCatalogListApiQuery`), with their API names.
fn filters(q: &url::BlueprintQuery) -> [(&'static str, &Option<String>); 5] {
    [
        ("search", &q.search),
        ("status", &q.status),
        ("hasComponents", &q.has_components),
        ("hasFieldRules", &q.has_field_rules),
        ("hasDimensionRules", &q.has_dimension_rules),
    ]
}

fn api_query(query: &url::BlueprintQuery, page: u32) -> String {
    list_query(&filters(query), page)
}

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use crate::catalog::url::ListNotice;

    /// The list's filters (the filter form's fields) and page (from 1); the `has_` filters are
    /// `true` or `false`.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct BlueprintQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub has_components: Option<String>,
        pub has_field_rules: Option<String>,
        pub has_dimension_rules: Option<String>,
        pub page: Option<u32>,
    }

    impl BlueprintQuery {
        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            super::filters(self).iter().any(|(_, value)| value.is_some())
        }
    }

    /// What opening a Set dialog carries: the receipt of the write the page shows.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct Opened {
        pub after_write: Option<String>,
    }

    /// The list.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/blueprints", get = list, post = create)]
    pub struct Blueprints {
        #[route(query)]
        pub query: BlueprintQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl Blueprints {
        pub fn of(query: &BlueprintQuery) -> Self {
            Blueprints { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The list's rows, streamed again on each change.
    #[route("/catalog/blueprints/live", get = rows_live)]
    pub struct BlueprintsLive {
        #[route(query)]
        pub query: BlueprintQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/blueprints/bulk", post = preview_bulk)]
    pub struct BlueprintsBulk {
        #[route(query)]
        pub query: BlueprintQuery,
    }

    /// The preview's confirm: it starts the change.
    #[route("/catalog/blueprints/bulk/confirm", post = confirm_bulk)]
    pub struct BlueprintsBulkConfirm {
        #[route(query)]
        pub query: BlueprintQuery,
    }

    /// A blueprint, after the write whose receipt the address carries.
    #[route("/catalog/blueprints/{id}", get = blueprint)]
    pub struct Blueprint<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<crate::catalog::Done>,
    }

    #[route("/catalog/blueprints/{id}/edit", post = revise)]
    pub struct BlueprintEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/blueprints/{id}/lifecycle", post = lifecycle)]
    pub struct BlueprintLifecycle<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/blueprints/{id}/components", post = attach)]
    pub struct Attach<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/blueprints/{id}/components/{component_id}/detach", post = detach)]
    pub struct Detach<'a> {
        pub id: &'a str,
        pub component_id: &'a str,
    }

    /// Set Field Rules: `GET` draws its dialog, `POST` sets.
    #[route("/catalog/blueprints/{id}/field-rules", get = field_rules_dialog, post = set_field_rules)]
    pub struct FieldRules<'a> {
        pub id: &'a str,
        #[route(query)]
        pub opened: Opened,
    }

    impl<'a> FieldRules<'a> {
        pub fn of(id: &'a str) -> Self {
            FieldRules { id, opened: Opened::default() }
        }
    }

    /// Set Dimension Rules: `GET` draws its dialog, `POST` sets.
    #[route("/catalog/blueprints/{id}/dimension-rules", get = dimension_rules_dialog, post = set_dimension_rules)]
    pub struct DimensionRules<'a> {
        pub id: &'a str,
        #[route(query)]
        pub opened: Opened,
    }

    impl<'a> DimensionRules<'a> {
        pub fn of(id: &'a str) -> Self {
            DimensionRules { id, opened: Opened::default() }
        }
    }

    /// Set Product Resolution Rules: `GET` draws its dialog, `POST` sets.
    #[route("/catalog/blueprints/{id}/product-resolution-rules", get = order_dialog, post = set_order)]
    pub struct ProductResolutionRules<'a> {
        pub id: &'a str,
        #[route(query)]
        pub opened: Opened,
    }

    impl<'a> ProductResolutionRules<'a> {
        pub fn of(id: &'a str) -> Self {
            ProductResolutionRules { id, opened: Opened::default() }
        }
    }
}

async fn list(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::Blueprints>,
) -> HtmlResult {
    let (query, notice) = (route.query, route.notice);
    page_list(&req, &staff.viewer, &config, &headers, &query, &notice, None, None).await
}

/// The list page; `create` is a create form that came back, drawn open, and `preview` a bulk
/// preview's answer, drawn open.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn page_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::BlueprintQuery,
    notice: &url::ListNotice,
    create: Option<Draft<BlueprintInput>>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<Blueprint>(Kind::Blueprints, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(viewer, t, Kind::Blueprints, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.blueprint(t));
    let view = views::blueprint_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_blueprints()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

async fn rows_live(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Params(route): Params<crate::catalog::blueprints::url::BlueprintsLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
    live_rows(config, headers, since, TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<Blueprint>(Kind::Blueprints, &api_query(&query, page)).await {
                Ok(list) => Some(views::blueprint_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("blueprints list read for a change failed: {error}");
                    None
                }
            }
        }
    })
}

async fn create(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::Blueprints>,
    Form(input): Form<BlueprintInput>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Blueprints, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
            return req.redirect(&url::Blueprints { query, notice });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Blueprints::of(&query).href();
    let form = views::BlueprintForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || {
        page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

/// What a blueprint's page reads after a write: its receipt and what it did.
#[derive(Default)]
struct After {
    after_write: Option<String>,
    done: Option<Done>,
}

async fn blueprint(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Blueprint<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, After { after_write: route.after_write, done: route.done });
    blueprint_page(&req, &staff.viewer, &config, &headers, &id, &after, BlueprintForms::default()).await
}

async fn blueprint_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &After,
    forms: BlueprintForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let blueprint = match caller.get::<BlueprintDetail>(Kind::Blueprints, id).await {
        Ok(blueprint) => blueprint,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.blueprint(t));
    // The Set openers carry the receipt only while it is one the API will still wait for.
    let after_write = receipt.as_ref().and(after.after_write.as_deref());
    let view = views::blueprint_page(t, req.t(), &blueprint, after_write, notice, forms);
    req.screen(
        &blueprint,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_blueprint()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

fn to_blueprint(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::Blueprint { id, after_write: receipt(written), done: Some(done) })
}

/// A refused form on a blueprint's page: the form as a patch, or the page with it open.
#[expect(clippy::too_many_arguments, reason = "the request, who is asking, the blueprint, and the form that came back")]
async fn refused_on_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    errors: &Errors,
    form: impl Patch,
    forms: BlueprintForms,
) -> HtmlResult {
    let after = After::default();
    req.invalid(errors, form, || blueprint_page(req, viewer, config, headers, id, &after, forms)).await
}

/// A form drawn again with nothing written (a Set dialog's row added or removed): the form as a
/// patch, or the page with it open.
async fn redraw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    form: impl Patch,
    forms: BlueprintForms,
) -> HtmlResult {
    if req.mode == Mode::Action {
        return req.patch(form);
    }
    blueprint_page(req, viewer, config, headers, id, &After::default(), forms).await
}

async fn revise(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::BlueprintEdit<'_>>,
    Form(input): Form<BlueprintInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    // `ReviseBlueprint` takes the key, name and description only: the rules are not restated.
    let errors = match command(&caller, Method::PUT, Kind::Blueprints, &under(&id, &[]), Some(&input.body(false))).await {
        Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::Revised),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::BlueprintEdit { id: &id }.href();
    let form = views::BlueprintForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = BlueprintForms { edit: Some(draft.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::BlueprintLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["publish", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Blueprints, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::blueprint_transitions(t, &input.status);
    let action = url::BlueprintLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = BlueprintForms { lifecycle: Some(errors.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &errors, form, forms).await
}

async fn attach(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::Attach<'_>>,
    Form(input): Form<AttachInput>,
) -> HtmlResult {
    let id = route.id;
    let component_id = input.component_id.trim();
    let errors = if component_id.is_empty() {
        // The id is the address's last segment: without one there is no command to send.
        let mut errors = Errors::new();
        errors.add(AttachInput::FIELDS.component_id, req.t::<Pilot>().check_required());
        errors
    } else {
        let caller = config.platform.caller(&headers, config.proto, None);
        match command(&caller, Method::POST, Kind::Blueprints, &under(&id, &["components", component_id]), None).await {
            Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::ComponentAttached),
            Sent::Refused(errors) => errors,
            Sent::Denied(denied) => return denied.answer(&req),
        }
    };
    let draft = Draft { input, errors };
    let action = url::Attach { id: &id }.href();
    let form = views::AttachForm { t: req.t(), id: ids::ATTACH, action: &action, form: &draft };
    let forms = BlueprintForms { attach: Some(draft.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn detach(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::Detach<'_>>,
) -> HtmlResult {
    let (id, component_id) = (route.id, route.component_id);
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = under(&id, &["components", &component_id]);
    let errors = match command(&caller, Method::DELETE, Kind::Blueprints, &rest, None).await {
        Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::ComponentDetached),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let key = ids::rule("component", &component_id);
    let action = url::Detach { id: &id, component_id: &component_id }.href();
    let label = req.t::<Cat>().blueprint_detach();
    let form = views::RemoveForm { id: ids::RuleId(&key), action: &action, label, errors: &errors };
    let forms = BlueprintForms { removal: Some((key.clone(), errors.clone())), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &errors, form, forms).await
}

// The Set dialogs.

/// The blueprint's rules as the list has them (its own table), page by page until its row; none
/// when the list does not have it.
async fn current_rules(caller: &Caller<'_>, id: &str) -> Result<Option<BlueprintRules>, ApiError> {
    listed(caller, Kind::Blueprints, id, |row: &BlueprintRules| row.blueprint_id.as_str()).await
}

/// A Set dialog opened: drawn from the rules the list has, with the receipt the page carried.
async fn open_set(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    opened: &url::Opened,
    which: Set,
) -> HtmlResult {
    let receipt = Receipt::from_param(opened.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let set = match current_rules(&caller, id).await {
        Ok(Some(rules)) => match which {
            Set::Fields => SetRules::Fields(Draft::new(FieldRulesInput::of(&rules.field_rules))),
            Set::Dimensions => SetRules::Dimensions(Draft::new(DimensionRulesInput::of(&rules.dimension_rules))),
            Set::Order => SetRules::Order(Draft::new(OrderInput::of(&rules.canonical_dimension_order))),
        },
        Ok(None) => SetRules::Unread(which),
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    if req.mode == Mode::Action {
        let (t, p) = (req.t(), req.t());
        return match &set {
            SetRules::Fields(form) => req.patch(views::FieldRulesDialog { t, p, id, form: Some(form) }),
            SetRules::Dimensions(form) => req.patch(views::DimensionRulesDialog { t, p, id, form: Some(form) }),
            SetRules::Order(form) => req.patch(views::OrderDialog { t, p, id, form: Some(form) }),
            SetRules::Unread(Set::Fields) => req.patch(views::FieldRulesDialog { t, p, id, form: None }),
            SetRules::Unread(Set::Dimensions) => req.patch(views::DimensionRulesDialog { t, p, id, form: None }),
            SetRules::Unread(Set::Order) => req.patch(views::OrderDialog { t, p, id, form: None }),
        };
    }
    let forms = BlueprintForms { set: Some(set), ..Default::default() };
    blueprint_page(req, viewer, config, headers, id, &After::default(), forms).await
}

async fn field_rules_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::FieldRules<'_>>,
) -> HtmlResult {
    let (id, opened) = (route.id, route.opened);
    open_set(&req, &staff.viewer, &config, &headers, &id, &opened, Set::Fields).await
}

async fn dimension_rules_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::DimensionRules<'_>>,
) -> HtmlResult {
    let (id, opened) = (route.id, route.opened);
    open_set(&req, &staff.viewer, &config, &headers, &id, &opened, Set::Dimensions).await
}

async fn order_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::ProductResolutionRules<'_>>,
) -> HtmlResult {
    let (id, opened) = (route.id, route.opened);
    open_set(&req, &staff.viewer, &config, &headers, &id, &opened, Set::Order).await
}

/// A Set's write: `PUT /api/catalog/blueprints/{id}/{rest}` with `body`.
async fn put_rules(config: &Shared, headers: &HeaderMap, id: &str, rest: &str, body: &Value) -> Sent {
    let caller = config.platform.caller(headers, config.proto, None);
    command(&caller, Method::PUT, Kind::Blueprints, &under(id, &[rest]), Some(body)).await
}

async fn set_field_rules(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::FieldRules<'_>>,
    Form(input): Form<FieldRulesInput>,
) -> HtmlResult {
    let id = route.id;
    let action = url::FieldRules::of(&id).href();
    if let Some(next) = input.rerowed() {
        let draft = Draft::new(next);
        let form = views::FieldRulesForm { t: req.t(), id: ids::SET_FIELDS, action: &action, form: &draft };
        let forms = BlueprintForms { set: Some(SetRules::Fields(draft.clone())), ..Default::default() };
        return redraw(&req, &staff.viewer, &config, &headers, &id, form, forms).await;
    }
    let errors = match put_rules(&config, &headers, &id, "fields", &input.body()).await {
        Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::FieldRulesSet),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let form = views::FieldRulesForm { t: req.t(), id: ids::SET_FIELDS, action: &action, form: &draft };
    let forms = BlueprintForms { set: Some(SetRules::Fields(draft.clone())), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn set_dimension_rules(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::DimensionRules<'_>>,
    Form(input): Form<DimensionRulesInput>,
) -> HtmlResult {
    let id = route.id;
    let action = url::DimensionRules::of(&id).href();
    if let Some(next) = input.rerowed() {
        let draft = Draft::new(next);
        let form = views::DimensionRulesForm { t: req.t(), id: ids::SET_DIMENSIONS, action: &action, form: &draft };
        let forms = BlueprintForms { set: Some(SetRules::Dimensions(draft.clone())), ..Default::default() };
        return redraw(&req, &staff.viewer, &config, &headers, &id, form, forms).await;
    }
    let errors = match put_rules(&config, &headers, &id, "dimensions", &input.body()).await {
        Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::DimensionRulesSet),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let form = views::DimensionRulesForm { t: req.t(), id: ids::SET_DIMENSIONS, action: &action, form: &draft };
    let forms = BlueprintForms { set: Some(SetRules::Dimensions(draft.clone())), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn set_order(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::ProductResolutionRules<'_>>,
    Form(input): Form<OrderInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match put_rules(&config, &headers, &id, "product-resolution-rules", &input.body()).await {
        Sent::Written(written) => return to_blueprint(&req, &id, &written, Done::ProductResolutionRulesSet),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::ProductResolutionRules::of(&id).href();
    let form = views::OrderForm { t: req.t(), id: ids::SET_ORDER, action: &action, form: &draft };
    let forms = BlueprintForms { set: Some(SetRules::Order(draft.clone())), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

// Bulk changes.

/// The filters set on the list, as the API's bulk selection reads them (`blueprintListQueryFromRecord`).
fn selection_filter(query: &url::BlueprintQuery) -> Value {
    filter_query(&filters(query))
}

async fn preview_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::BlueprintsBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let confirm_at = url::BlueprintsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::Blueprints, &input, selection_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Blueprints, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm_at, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn confirm_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::blueprints::url::BlueprintsBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let action = url::BlueprintsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::Blueprints, &input, selection_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::Blueprints { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Blueprints, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}
