//! The display templates (`/catalog/display-templates`, admin-web's `/catalog/display-templates`):
//! the list with its filters and create dialog, and a display template's page with its status
//! change and edit dialog, through the Catalog API's display template routes
//! (`/api/catalog/display-templates`). admin-web offers no bulk changes here.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/display-templates?search&status&target_kind&page` | the list; `POST` creates |
//! | `GET /catalog/display-templates/live?...` | the list's rows, again on each change (`<corten-live>`) |
//! | `GET /catalog/display-templates/{id}`, `POST .../edit`, `.../lifecycle` | the template; revise it; its status |
//!
//! The API checks a template's tokens when it is published (an unknown field or reference type
//! is refused); its refusal is the lifecycle form's message.
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;

use super::{
    Done, Sent,
    api::{Catalog as _, DisplayTemplate, Kind, Written, under},
    command,
    form::{ActionInput, TemplateInput},
    list_query, not_offered, receipt, screen,
    views::{self, Draft, TemplateForms, ids},
};
use crate::{
    api::Method,
    app::{Shared, live_rows, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the list (`catalogRealtimeRouteTopics.displayTemplates`).
const TOPIC: &str = "catalog:admin:display-templates";

/// The list's filters (`buildCatalogListApiQuery`), with their API names.
fn filters(q: &url::TemplateQuery) -> [(&'static str, &Option<String>); 3] {
    [("search", &q.search), ("status", &q.status), ("targetKind", &q.target_kind)]
}

fn api_query(query: &url::TemplateQuery, page: u32) -> String {
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
    pub struct TemplateQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub target_kind: Option<String>,
        pub page: Option<u32>,
    }

    impl TemplateQuery {
        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            super::filters(self).iter().any(|(_, value)| value.is_some())
        }
    }

    /// The list.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/display-templates", get = list, post = create)]
    pub struct Templates {
        #[route(query)]
        pub query: TemplateQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl Templates {
        pub fn of(query: &TemplateQuery) -> Self {
            Templates { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The list's rows, streamed again on each change.
    #[route("/catalog/display-templates/live", get = rows_live)]
    pub struct TemplatesLive {
        #[route(query)]
        pub query: TemplateQuery,
    }

    /// A display template, after the write whose receipt the address carries.
    #[route("/catalog/display-templates/{id}", get = template)]
    pub struct Template<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<crate::catalog::Done>,
    }

    #[route("/catalog/display-templates/{id}/edit", post = revise)]
    pub struct TemplateEdit<'a> {
        pub id: &'a str,
    }

    #[route("/catalog/display-templates/{id}/lifecycle", post = lifecycle)]
    pub struct TemplateLifecycle<'a> {
        pub id: &'a str,
    }
}

async fn list(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::display_templates::url::Templates>,
) -> HtmlResult {
    let (query, notice) = (route.query, route.notice);
    page_list(&req, &staff.viewer, &config, &headers, &query, &notice, None).await
}

/// The list page; `create` is a create form that came back, drawn open.
async fn page_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::TemplateQuery,
    notice: &url::ListNotice,
    create: Option<Draft<TemplateInput>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let list = match caller.list::<DisplayTemplate>(Kind::DisplayTemplates, &api_query(query, page)).await {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = screen(list, page);
    let t: Cat = req.t();
    let notice = notice.done.map(|done| done.template(t));
    let view = views::template_list(t, req.t(), query, &screen, create, notice);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_templates()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

async fn rows_live(
    req: Req,
    _: corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
    Params(route): Params<crate::catalog::display_templates::url::TemplatesLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    live_rows(config, headers, since, TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<DisplayTemplate>(Kind::DisplayTemplates, &api_query(&query, page)).await {
                Ok(list) => Some(views::template_rows(t, p, &query, &screen(list, page)).to_html()),
                Err(error) => {
                    tracing::warn!("display templates list read for a change failed: {error}");
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
    Params(route): Params<crate::catalog::display_templates::url::Templates>,
    Form(input): Form<TemplateInput>,
) -> HtmlResult {
    let query = route.query;
    let errors = match input.body(req.t(), true) {
        Ok(body) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::DisplayTemplates, "", Some(&body)).await {
                Sent::Written(written) => {
                    let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
                    return req.redirect(&url::Templates { query, notice });
                }
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let action = url::Templates::of(&query).href();
    let form = views::TemplateForm { t: req.t(), id: ids::CREATE, action: &action, create: true, form: &draft };
    let none = url::ListNotice::default();
    req.invalid(&draft.errors, form, || page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone())))
        .await
}

/// What a display template's page reads after a write: its receipt and what it did.
#[derive(Default)]
struct After {
    after_write: Option<String>,
    done: Option<Done>,
}

async fn template(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Template<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, After { after_write: route.after_write, done: route.done });
    template_page(&req, &staff.viewer, &config, &headers, &id, &after, TemplateForms::default()).await
}

async fn template_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &After,
    forms: TemplateForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let template = match caller.get::<DisplayTemplate>(Kind::DisplayTemplates, id).await {
        Ok(template) => template,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.template(t));
    let view = views::template_page(t, req.t(), &template, notice, forms);
    req.screen(
        &template,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_template()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

fn to_template(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::Template { id, after_write: receipt(written), done: Some(done) })
}

async fn revise(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::display_templates::url::TemplateEdit<'_>>,
    Form(input): Form<TemplateInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.body(req.t(), false) {
        Ok(body) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::PUT, Kind::DisplayTemplates, &under(&id, &[]), Some(&body)).await {
                Sent::Written(written) => return to_template(&req, &id, &written, Done::Revised),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let action = url::TemplateEdit { id: &id }.href();
    let form = views::TemplateForm { t: req.t(), id: ids::EDIT, action: &action, create: false, form: &draft };
    let forms = TemplateForms { edit: Some(draft.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&draft.errors, form, || template_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::display_templates::url::TemplateLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["publish", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::DisplayTemplates, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_template(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::template_transitions(t, &input.status);
    let action = url::TemplateLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = TemplateForms { lifecycle: Some(errors.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&errors, form, || template_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}
