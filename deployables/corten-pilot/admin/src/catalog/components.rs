//! The components (`/catalog/components`, admin-web's `/catalog/components`): the list with its
//! filters, bulk lifecycle changes and create dialog, and a component's page with its status
//! change, edit dialog, and its field and dimension rules (add and remove), through the Catalog
//! API's component routes (`/api/catalog/components`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/components?search&status&has_field_rules&has_dimension_rules&page` | the list; `POST` creates |
//! | `GET /catalog/components/live?...` | the list's rows, again on each change (`<corten-live>`) |
//! | `POST /catalog/components/bulk?...`, `.../bulk/confirm?...` | a bulk change's preview; starts it |
//! | `GET /catalog/components/{id}`, `POST .../edit`, `.../lifecycle` | the component; revise it; its status |
//! | `POST /catalog/components/{id}/field-rules`, `.../field-rules/{field_id}/remove` | add or remove a field rule |
//! | `POST /catalog/components/{id}/dimension-rules`, `.../dimension-rules/{dimension_id}/remove` | add or remove a dimension rule |
//!
//! A rule names its field or dimension by id, typed in, as admin-web's dialogs do; the API checks
//! it. The edit restates the rules the API has when it is posted, from the list, which reads the
//! component's own table: the page's read can miss a rule (chase-sets/chase-sets#10823), and a
//! rule it missed would be deleted (chase-sets/chase-sets#10824).
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde_json::Value;

use super::{
    Confirming, Done, Previewing, Sent, action_label, answer_preview,
    api::{Catalog as _, Component, ComponentDetail, ComponentRules, Kind, Written, under},
    bulk, command, confirm, filter_query, follow,
    form::{ActionInput, BulkInput, ComponentInput, DimensionRuleInput, FieldRuleInput},
    list_query, listed, manages, not_offered, preview, receipt, screen,
    views::{self, ComponentForms, Draft, Previewed, ids},
};
use crate::{
    api::{ApiError, Caller, Method},
    app::{Shared, live_rows, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the list (`catalogRealtimeRouteTopics.components`).
const TOPIC: &str = "catalog:admin:components";

/// The list's filters (`buildCatalogListApiQuery`), with their API names.
fn filters(q: &url::ComponentQuery) -> [(&'static str, &Option<String>); 4] {
    [
        ("search", &q.search),
        ("status", &q.status),
        ("hasFieldRules", &q.has_field_rules),
        ("hasDimensionRules", &q.has_dimension_rules),
    ]
}

fn api_query(query: &url::ComponentQuery, page: u32) -> String {
    list_query(&filters(query), page)
}

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use crate::catalog::url::ListNotice;

    /// The list's filters (the filter form's fields) and page (from 1); the rule filters are
    /// `true` or `false`.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct ComponentQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub has_field_rules: Option<String>,
        pub has_dimension_rules: Option<String>,
        pub page: Option<u32>,
    }

    impl ComponentQuery {
        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            super::filters(self).iter().any(|(_, value)| value.is_some())
        }
    }

    /// The list.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/components", get = list, post = create)]
    pub struct Components {
        #[route(query)]
        pub query: ComponentQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl Components {
        pub fn of(query: &ComponentQuery) -> Self {
            Components { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The list's rows, streamed again on each change.
    #[route("/catalog/components/live", get = rows_live)]
    pub struct ComponentsLive {
        #[route(query)]
        pub query: ComponentQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/components/bulk", post = preview_bulk)]
    pub struct ComponentsBulk {
        #[route(query)]
        pub query: ComponentQuery,
    }

    /// The preview's confirm: it starts the change.
    #[route("/catalog/components/bulk/confirm", post = confirm_bulk)]
    pub struct ComponentsBulkConfirm {
        #[route(query)]
        pub query: ComponentQuery,
    }

    /// A component, after the write whose receipt the address carries.
    #[route("/catalog/components/{id}", get = component)]
    pub struct Component<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<crate::catalog::Done>,
    }

    #[route("/catalog/components/{id}/edit", post = revise)]
    pub struct ComponentEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/components/{id}/lifecycle", post = lifecycle)]
    pub struct ComponentLifecycle<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/components/{id}/field-rules", post = add_field_rule)]
    pub struct FieldRules<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/components/{id}/field-rules/{field_id}/remove", post = remove_field_rule)]
    pub struct FieldRuleRemove<'a> {
        pub id: &'a str,
        pub field_id: &'a str,
    }

    #[route("/catalog/components/{id}/dimension-rules", post = add_dimension_rule)]
    pub struct DimensionRules<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/components/{id}/dimension-rules/{dimension_id}/remove", post = remove_dimension_rule)]
    pub struct DimensionRuleRemove<'a> {
        pub id: &'a str,
        pub dimension_id: &'a str,
    }
}

async fn list(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::Components>,
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
    query: &url::ComponentQuery,
    notice: &url::ListNotice,
    create: Option<Draft<ComponentInput>>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<Component>(Kind::Components, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(viewer, t, Kind::Components, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.component(t));
    let view = views::component_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_components()} head="">
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
    Params(route): Params<crate::catalog::components::url::ComponentsLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
    live_rows(config, headers, since, TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<Component>(Kind::Components, &api_query(&query, page)).await {
                Ok(list) => Some(views::component_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("components list read for a change failed: {error}");
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
    Params(route): Params<crate::catalog::components::url::Components>,
    Form(input): Form<ComponentInput>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Components, "", Some(&input.create_body())).await {
        Sent::Written(written) => {
            let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
            return req.redirect(&url::Components { query, notice });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Components::of(&query).href();
    let form = views::ComponentForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || {
        page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

/// What a component's page reads after a write: its receipt and what it did.
#[derive(Default)]
struct After {
    after_write: Option<String>,
    done: Option<Done>,
}

async fn component(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Component<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, After { after_write: route.after_write, done: route.done });
    component_page(&req, &staff.viewer, &config, &headers, &id, &after, ComponentForms::default()).await
}

async fn component_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &After,
    forms: ComponentForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let component = match caller.get::<ComponentDetail>(Kind::Components, id).await {
        Ok(component) => component,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.component(t));
    let view = views::component_page(t, req.t(), &component, notice, forms);
    req.screen(
        &component,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_component()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

fn to_component(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::Component { id, after_write: receipt(written), done: Some(done) })
}

/// A refused form on a component's page: the form as a patch, or the page with it open.
#[expect(clippy::too_many_arguments, reason = "the request, who is asking, the component, and the form that came back")]
async fn refused_on_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    errors: &Errors,
    form: impl Patch,
    forms: ComponentForms,
) -> HtmlResult {
    let after = After::default();
    req.invalid(errors, form, || component_page(req, viewer, config, headers, id, &after, forms)).await
}

async fn revise(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::ComponentEdit<'_>>,
    Form(input): Form<ComponentInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    // The API replaces the rules with the body's: read them now, from the component's own table,
    // rather than restating the page's (chase-sets/chase-sets#10824).
    let errors = match current_rules(&caller, &id).await {
        Ok(Some(current)) => {
            let body = input.revise_body(&current);
            match command(&caller, Method::PUT, Kind::Components, &under(&id, &[]), Some(&body)).await {
                Sent::Written(written) => return to_component(&req, &id, &written, Done::Revised),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        Ok(None) => {
            let mut errors = Errors::new();
            errors.add_form(req.t::<Pilot>().catalog_rules_unread());
            errors
        }
        Err(error) => return read_failed(&req, error, false),
    };
    let draft = Draft { input, errors };
    let action = url::ComponentEdit { id: &id }.href();
    let form = views::ComponentForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = ComponentForms { edit: Some(draft.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

/// The component's rules as the list has them (the component's own table); none when the list
/// does not have it.
async fn current_rules(caller: &Caller<'_>, id: &str) -> Result<Option<ComponentRules>, ApiError> {
    listed(caller, Kind::Components, id, |row: &ComponentRules| row.component_id.as_str()).await
}
async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::ComponentLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["activate", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Components, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_component(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::transitions(&input.status, t.component_activate(), t.component_deprecate(), t.component_archive());
    let action = url::ComponentLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = ComponentForms { lifecycle: Some(errors.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &errors, form, forms).await
}

async fn add_field_rule(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::FieldRules<'_>>,
    Form(input): Form<FieldRuleInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Components, &under(&id, &["field-rules"]), Some(&input.body())).await
    {
        Sent::Written(written) => return to_component(&req, &id, &written, Done::FieldRuleAdded),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::FieldRules { id: &id }.href();
    let form = views::FieldRuleForm { t: req.t(), id: ids::ADD_FIELD_RULE, action: &action, form: &draft };
    let forms = ComponentForms { field_rule: Some(draft.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

async fn add_dimension_rule(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::DimensionRules<'_>>,
    Form(input): Form<DimensionRuleInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = under(&id, &["dimension-rules"]);
    let errors = match command(&caller, Method::POST, Kind::Components, &rest, Some(&input.body())).await {
        Sent::Written(written) => return to_component(&req, &id, &written, Done::DimensionRuleAdded),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::DimensionRules { id: &id }.href();
    let form = views::DimensionRuleForm { t: req.t(), id: ids::ADD_DIMENSION_RULE, action: &action, form: &draft };
    let forms = ComponentForms { dimension_rule: Some(draft.clone()), ..Default::default() };
    refused_on_page(&req, &staff.viewer, &config, &headers, &id, &draft.errors, form, forms).await
}

/// A rule's Remove: `kind` is `field-rules` or `dimension-rules`, `of` the rule's field or
/// dimension id.
#[expect(clippy::too_many_arguments, reason = "the request, who is asking, and which rule of which component")]
async fn remove_rule(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    kind: &str,
    of: &str,
    action: &str,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let (done, form_kind, label) = if kind == "field-rules" {
        (Done::FieldRuleRemoved, "field", req.t::<Cat>().component_remove())
    } else {
        (Done::DimensionRuleRemoved, "dimension", req.t::<Cat>().component_remove_2())
    };
    let errors = match command(&caller, Method::DELETE, Kind::Components, &under(id, &[kind, of]), None).await {
        Sent::Written(written) => return to_component(req, id, &written, done),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(req),
    };
    let key = ids::rule(form_kind, of);
    let form = views::RemoveForm { id: ids::RuleId(&key), action, label, errors: &errors };
    let forms = ComponentForms { removal: Some((key.clone(), errors.clone())), ..Default::default() };
    refused_on_page(req, viewer, config, headers, id, &errors, form, forms).await
}

async fn remove_field_rule(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::FieldRuleRemove<'_>>,
) -> HtmlResult {
    let (id, field_id) = (route.id, route.field_id);
    let action = url::FieldRuleRemove { id: &id, field_id: &field_id }.href();
    remove_rule(&req, &staff.viewer, &config, &headers, &id, "field-rules", &field_id, &action).await
}

async fn remove_dimension_rule(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::DimensionRuleRemove<'_>>,
) -> HtmlResult {
    let (id, dimension_id) = (route.id, route.dimension_id);
    let action = url::DimensionRuleRemove { id: &id, dimension_id: &dimension_id }.href();
    remove_rule(&req, &staff.viewer, &config, &headers, &id, "dimension-rules", &dimension_id, &action).await
}

/// The filters set on the list, as the API's bulk selection reads them (`componentListQueryFromRecord`).
fn selection_filter(query: &url::ComponentQuery) -> Value {
    filter_query(&filters(query))
}

async fn preview_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::ComponentsBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let confirm_at = url::ComponentsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::Components, &input, selection_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Components, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm_at, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn confirm_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::components::url::ComponentsBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let action = url::ComponentsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::Components, &input, selection_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::Components { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Components, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}
