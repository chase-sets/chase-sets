//! The reference types (`/catalog/reference-types`, admin-web's `/catalog/reference-types`): the
//! list with its filters, bulk lifecycle changes and create dialog, and a reference type's page
//! with its status change and edit dialog, through the Catalog API's reference type routes
//! (`/api/catalog/reference-types`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/reference-types?search&status&attribute_key&page` | the list; `POST` creates |
//! | `GET /catalog/reference-types/live?...` | the list's rows, again on each change (`<corten-live>`) |
//! | `POST /catalog/reference-types/bulk?...`, `.../bulk/confirm?...` | a bulk change's preview; starts it |
//! | `GET /catalog/reference-types/{id}`, `POST .../edit`, `.../lifecycle` | the type; revise it; its status |
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde_json::Value;

use super::{
    Confirming, Done, Previewing, Sent, action_label, answer_preview,
    api::{Catalog as _, Kind, ReferenceType, Written, under},
    bulk, command, confirm, filter_query, follow,
    form::{ActionInput, BulkInput, RefTypeInput},
    list_query, manages, not_offered, preview, receipt, screen,
    views::{self, Draft, Previewed, RefTypeForms, ids},
};
use crate::{
    api::Method,
    app::{Shared, live_rows, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the list (`catalogRealtimeRouteTopics.referenceTypes`).
const TOPIC: &str = "catalog:admin:reference-types";

/// The list's filters (`buildCatalogListApiQuery`), with their API names.
fn filters(q: &url::RefTypeQuery) -> [(&'static str, &Option<String>); 3] {
    [("search", &q.search), ("status", &q.status), ("attributeKey", &q.attribute_key)]
}

fn api_query(query: &url::RefTypeQuery, page: u32) -> String {
    list_query(&filters(query), page)
}

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use crate::catalog::url::ListNotice;

    /// The list's filters (the filter form's fields) and page (from 1).
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct RefTypeQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub attribute_key: Option<String>,
        pub page: Option<u32>,
    }

    impl RefTypeQuery {
        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            super::filters(self).iter().any(|(_, value)| value.is_some())
        }
    }

    /// The list.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/reference-types", get = list, post = create)]
    pub struct RefTypes {
        #[route(query)]
        pub query: RefTypeQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl RefTypes {
        pub fn of(query: &RefTypeQuery) -> Self {
            RefTypes { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The list's rows, streamed again on each change.
    #[route("/catalog/reference-types/live", get = rows_live)]
    pub struct RefTypesLive {
        #[route(query)]
        pub query: RefTypeQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/reference-types/bulk", post = preview_bulk)]
    pub struct RefTypesBulk {
        #[route(query)]
        pub query: RefTypeQuery,
    }

    /// The preview's confirm: it starts the change.
    #[route("/catalog/reference-types/bulk/confirm", post = confirm_bulk)]
    pub struct RefTypesBulkConfirm {
        #[route(query)]
        pub query: RefTypeQuery,
    }

    /// A reference type, after the write whose receipt the address carries.
    #[route("/catalog/reference-types/{id}", get = ref_type)]
    pub struct RefType<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<crate::catalog::Done>,
    }

    #[route("/catalog/reference-types/{id}/edit", post = revise)]
    pub struct RefTypeEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/reference-types/{id}/lifecycle", post = lifecycle)]
    pub struct RefTypeLifecycle<'a> {
        pub id: &'a str,
    }
}

async fn list(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_types::url::RefTypes>,
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
    query: &url::RefTypeQuery,
    notice: &url::ListNotice,
    create: Option<Draft<RefTypeInput>>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<ReferenceType>(Kind::ReferenceTypes, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(viewer, t, Kind::ReferenceTypes, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.ref_type(t));
    let view = views::ref_type_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_ref_types()} head="">
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
    Params(route): Params<crate::catalog::reference_types::url::RefTypesLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
    live_rows(config, headers, since, TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<ReferenceType>(Kind::ReferenceTypes, &api_query(&query, page)).await {
                Ok(list) => Some(views::ref_type_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("reference types list read for a change failed: {error}");
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
    Params(route): Params<crate::catalog::reference_types::url::RefTypes>,
    Form(input): Form<RefTypeInput>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::ReferenceTypes, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
            return req.redirect(&url::RefTypes { query, notice });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::RefTypes::of(&query).href();
    let form = views::RefTypeForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || {
        page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

/// What a reference type's page reads after a write: its receipt and what it did.
#[derive(Default)]
struct After {
    after_write: Option<String>,
    done: Option<Done>,
}

async fn ref_type(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::RefType<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, After { after_write: route.after_write, done: route.done });
    ref_type_page(&req, &staff.viewer, &config, &headers, &id, &after, RefTypeForms::default()).await
}

async fn ref_type_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &After,
    forms: RefTypeForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let ref_type = match caller.get::<ReferenceType>(Kind::ReferenceTypes, id).await {
        Ok(ref_type) => ref_type,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.ref_type(t));
    let view = views::ref_type_page(t, req.t(), &ref_type, notice, forms);
    req.screen(
        &ref_type,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_ref_type()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

fn to_ref_type(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::RefType { id, after_write: receipt(written), done: Some(done) })
}

async fn revise(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_types::url::RefTypeEdit<'_>>,
    Form(input): Form<RefTypeInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::PUT, Kind::ReferenceTypes, &under(&id, &[]), Some(&input.body(false))).await {
        Sent::Written(written) => return to_ref_type(&req, &id, &written, Done::Revised),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::RefTypeEdit { id: &id }.href();
    let form = views::RefTypeForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = RefTypeForms { edit: Some(draft.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&draft.errors, form, || ref_type_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_types::url::RefTypeLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["publish", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::ReferenceTypes, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_ref_type(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::ref_type_transitions(t, &input.status);
    let action = url::RefTypeLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = RefTypeForms { lifecycle: Some(errors.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&errors, form, || ref_type_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

/// The filters set on the list, as the API's bulk selection reads them (`referenceTypeListQueryFromRecord`).
fn selection_filter(query: &url::RefTypeQuery) -> Value {
    filter_query(&filters(query))
}

async fn preview_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_types::url::RefTypesBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let confirm_at = url::RefTypesBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::ReferenceTypes, &input, selection_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::ReferenceTypes, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm_at, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn confirm_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_types::url::RefTypesBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let action = url::RefTypesBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::ReferenceTypes, &input, selection_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::RefTypes { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::ReferenceTypes, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}
