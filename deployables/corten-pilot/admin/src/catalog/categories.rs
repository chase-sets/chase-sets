//! The categories (`/catalog/categories`, admin-web's `/catalog/categories`): the list with its
//! filters, bulk lifecycle changes and create dialog, and a category's page with its status
//! change and edit dialog, through the Catalog API's category routes (`/api/catalog/categories`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/categories?search&status&hierarchy&parent_category_id&page` | the list; `POST` creates |
//! | `GET /catalog/categories/live?...` | the list's rows, again on each change (`<corten-live>`) |
//! | `POST /catalog/categories/bulk?...`, `.../bulk/confirm?...` | a bulk change's preview; starts it |
//! | `GET /catalog/categories/{id}`, `POST .../edit`, `.../lifecycle` | the category; revise it; publish, deprecate, archive |
//!
//! The list is kept current as admin-web's is (`useCatalogRealtimeRevalidation` on the topic
//! `catalog:admin:categories`). A category's parent is typed as an id in both dialogs, as in
//! admin-web; the API checks it.
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde_json::Value;

use super::{
    Confirming, Done, Previewing, Sent, action_label, answer_preview,
    api::{Catalog as _, Category, Kind, Written, under},
    bulk, command, confirm, filter_query, follow,
    form::{ActionInput, BulkInput, CategoryInput},
    list_query, manages, not_offered, preview, receipt, screen,
    views::{self, Draft, Previewed, ids},
};
use crate::{
    api::Method,
    app::{Shared, live_rows, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the list (`catalogRealtimeRouteTopics.categories`).
const TOPIC: &str = "catalog:admin:categories";

/// The list's filters (`buildCatalogListApiQuery`), with their API names.
fn filters(q: &url::CategoryQuery) -> [(&'static str, &Option<String>); 4] {
    [("search", &q.search), ("status", &q.status), ("parentCategoryId", &q.parent_category_id), ("hierarchy", &q.hierarchy)]
}

fn api_query(query: &url::CategoryQuery, page: u32) -> String {
    list_query(&filters(query), page)
}

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use crate::catalog::url::ListNotice;

    /// The list's filters (the filter form's fields) and page (from 1). `hierarchy` is `root` or
    /// `child`.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct CategoryQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub hierarchy: Option<String>,
        pub parent_category_id: Option<String>,
        pub page: Option<u32>,
    }

    impl CategoryQuery {
        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            super::filters(self).iter().any(|(_, value)| value.is_some())
        }
    }

    /// The list.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/categories", get = list, post = create)]
    pub struct Categories {
        #[route(query)]
        pub query: CategoryQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl Categories {
        pub fn of(query: &CategoryQuery) -> Self {
            Categories { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The list's rows, streamed again on each change.
    #[route("/catalog/categories/live", get = rows_live)]
    pub struct CategoriesLive {
        #[route(query)]
        pub query: CategoryQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/categories/bulk", post = preview_bulk)]
    pub struct CategoriesBulk {
        #[route(query)]
        pub query: CategoryQuery,
    }

    /// The preview's confirm: it starts the change.
    #[route("/catalog/categories/bulk/confirm", post = confirm_bulk)]
    pub struct CategoriesBulkConfirm {
        #[route(query)]
        pub query: CategoryQuery,
    }

    /// A category, after the write whose receipt the address carries.
    #[route("/catalog/categories/{id}", get = category)]
    pub struct Category<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<crate::catalog::Done>,
    }

    #[route("/catalog/categories/{id}/edit", post = revise)]
    pub struct CategoryEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/categories/{id}/lifecycle", post = lifecycle)]
    pub struct CategoryLifecycle<'a> {
        pub id: &'a str,
    }
}

async fn list(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::categories::url::Categories>,
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
    query: &url::CategoryQuery,
    notice: &url::ListNotice,
    create: Option<Draft<CategoryInput>>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<Category>(Kind::Categories, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(viewer, t, Kind::Categories, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.category(t));
    let view = views::category_list(t, req.t(), query, &screen, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_categories()} head="">
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
    Params(route): Params<crate::catalog::categories::url::CategoriesLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
    live_rows(config, headers, since, TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<Category>(Kind::Categories, &api_query(&query, page)).await {
                Ok(list) => Some(views::category_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("categories list read for a change failed: {error}");
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
    Params(route): Params<crate::catalog::categories::url::Categories>,
    Form(input): Form<CategoryInput>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::POST, Kind::Categories, "", Some(&input.body(true))).await {
        Sent::Written(written) => {
            let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
            return req.redirect(&url::Categories { query, notice });
        }
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::Categories::of(&query).href();
    let form = views::CategoryForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || {
        page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

/// What a category's page reads after a write: its receipt and what it did.
#[derive(Default)]
struct After {
    after_write: Option<String>,
    done: Option<Done>,
}

async fn category(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Category<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, After { after_write: route.after_write, done: route.done });
    category_page(&req, &staff.viewer, &config, &headers, &id, &after, views::CategoryForms::default()).await
}

async fn category_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &After,
    forms: views::CategoryForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let category = match caller.get::<Category>(Kind::Categories, id).await {
        Ok(category) => category,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.category(t));
    let view = views::category_page(t, req.t(), &category, notice, forms);
    req.screen(
        &category,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_category()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

fn to_category(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::Category { id, after_write: receipt(written), done: Some(done) })
}

async fn revise(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::categories::url::CategoryEdit<'_>>,
    Form(input): Form<CategoryInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match command(&caller, Method::PUT, Kind::Categories, &under(&id, &[]), Some(&input.body(false))).await {
        Sent::Written(written) => return to_category(&req, &id, &written, Done::Revised),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(&req),
    };
    let draft = Draft { input, errors };
    let action = url::CategoryEdit { id: &id }.href();
    let form = views::CategoryForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = views::CategoryForms { edit: Some(draft.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&draft.errors, form, || category_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::categories::url::CategoryLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["publish", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::Categories, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_category(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::category_transitions(t, &input.status);
    let action = url::CategoryLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = views::CategoryForms { lifecycle: Some(errors.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&errors, form, || category_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

/// The filters set on the list, as the API's bulk selection reads them (`categoryListQueryFromRecord`).
fn selection_filter(query: &url::CategoryQuery) -> Value {
    filter_query(&filters(query))
}

async fn preview_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::categories::url::CategoriesBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let confirm_at = url::CategoriesBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::Categories, &input, selection_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Categories, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm_at, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn confirm_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::categories::url::CategoriesBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let action = url::CategoriesBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::Categories, &input, selection_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::Categories { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::Categories, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}
