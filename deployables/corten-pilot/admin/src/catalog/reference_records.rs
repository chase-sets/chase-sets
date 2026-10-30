//! The reference records (`/catalog/reference-records`, admin-web's `/catalog/reference-records`,
//! the nav's Reference Data): the list with its filters, bulk lifecycle changes and create
//! dialog, and a reference record's page with its relationships, status change and edit dialog,
//! through the Catalog API's reference record routes (`/api/catalog/reference-records`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/reference-records?search&status&type_key&relationship_type&attribute_key&attribute_value&page` | the list; `POST` creates |
//! | `GET /catalog/reference-records/new?...` | the create dialog, with the types and records it picks from |
//! | `GET /catalog/reference-records/live?...` | the list's rows, again on each change (`<corten-live>`) |
//! | `POST /catalog/reference-records/bulk?...`, `.../bulk/confirm?...` | a bulk change's preview; starts it |
//! | `GET /catalog/reference-records/{id}`, `GET` and `POST .../edit`, `POST .../lifecycle` | the record; its edit dialog and revise; its status |
//!
//! The create and edit dialogs read the active types and up to 500 records (admin-web's loaders
//! read the same on every list and page load); here only opening a dialog reads them.
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use futures_util::future::join;
use platform::receipt::Receipt;
use serde_json::Value;

use super::{
    Confirming, Done, Previewing, Sent, action_label, answer_preview,
    api::{Catalog as _, Kind, ReferenceRecord, ReferenceRow, ReferenceType, Written, under},
    bulk, command, confirm, filter_query, follow,
    form::{ActionInput, BulkInput, RefRecordInput},
    list_query, manages, not_offered, preview, receipt, screen,
    views::{self, Draft, Previewed, RecordDraft, RefChoices, RefRecordForms, ids},
};
use crate::{
    api::{Caller, Method},
    app::{Shared, live_rows, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The Catalog's realtime topic for the list (`catalogRealtimeRouteTopics.referenceRecords`).
const TOPIC: &str = "catalog:admin:reference-records";

/// The list's filters (`buildCatalogListApiQuery`), with their API names.
fn filters(q: &url::RefRecordQuery) -> [(&'static str, &Option<String>); 6] {
    [
        ("search", &q.search),
        ("status", &q.status),
        ("typeKey", &q.type_key),
        ("relationshipType", &q.relationship_type),
        ("attributeKey", &q.attribute_key),
        ("attributeValue", &q.attribute_value),
    ]
}

fn api_query(query: &url::RefRecordQuery, page: u32) -> String {
    list_query(&filters(query), page)
}

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use crate::catalog::{blueprints::url::Opened, url::ListNotice};

    /// The list's filters (the filter form's fields) and page (from 1).
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct RefRecordQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub type_key: Option<String>,
        pub relationship_type: Option<String>,
        pub attribute_key: Option<String>,
        pub attribute_value: Option<String>,
        pub page: Option<u32>,
    }

    impl RefRecordQuery {
        /// Whether a filter is set.
        pub fn filtered(&self) -> bool {
            super::filters(self).iter().any(|(_, value)| value.is_some())
        }
    }

    /// The list.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/reference-records", get = list, post = create)]
    pub struct RefRecords {
        #[route(query)]
        pub query: RefRecordQuery,
        #[route(query)]
        pub notice: ListNotice,
    }

    impl RefRecords {
        pub fn of(query: &RefRecordQuery) -> Self {
            RefRecords { query: query.clone(), notice: ListNotice::default() }
        }
    }

    /// The create dialog, drawn by the server with what it picks from.
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/reference-records/new", get = new_dialog)]
    pub struct RefRecordNew {
        #[route(query)]
        pub query: RefRecordQuery,
    }

    /// The list's rows, streamed again on each change.
    #[route("/catalog/reference-records/live", get = rows_live)]
    pub struct RefRecordsLive {
        #[route(query)]
        pub query: RefRecordQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/reference-records/bulk", post = preview_bulk)]
    pub struct RefRecordsBulk {
        #[route(query)]
        pub query: RefRecordQuery,
    }

    /// The preview's confirm: it starts the change.
    #[route("/catalog/reference-records/bulk/confirm", post = confirm_bulk)]
    pub struct RefRecordsBulkConfirm {
        #[route(query)]
        pub query: RefRecordQuery,
    }

    /// A reference record, after the write whose receipt the address carries.
    #[route("/catalog/reference-records/{id}", get = ref_record)]
    pub struct RefRecord<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<crate::catalog::Done>,
    }

    /// Edit: `GET` draws its dialog (carrying the page's receipt), `POST` revises.
    #[route("/catalog/reference-records/{id}/edit", get = edit_dialog, post = revise)]
    pub struct RefRecordEdit<'a> {
        pub id: &'a str,
        #[route(query)]
        pub opened: Opened,
    }

    impl<'a> RefRecordEdit<'a> {
        pub fn of(id: &'a str) -> Self {
            RefRecordEdit { id, opened: Opened::default() }
        }
    }

    #[route("/catalog/reference-records/{id}/lifecycle", post = lifecycle)]
    pub struct RefRecordLifecycle<'a> {
        pub id: &'a str,
    }
}

/// What a record's form picks from (`limit=500&status=active` types, `limit=500` records, as
/// admin-web reads them). A failed read leaves that list empty: the type is then typed, and a
/// row's record is kept by its id.
async fn choices(caller: &Caller<'_>) -> RefChoices {
    let (types, records) = join(
        caller.list::<ReferenceType>(Kind::ReferenceTypes, "limit=500&status=active"),
        caller.list::<ReferenceRow>(Kind::ReferenceRecords, "limit=500"),
    )
    .await;
    if let Err(error) = &types {
        tracing::warn!("reference types read for a record's form failed: {error}");
    }
    if let Err(error) = &records {
        tracing::warn!("reference records read for a record's form failed: {error}");
    }
    RefChoices { types: types.map(|l| l.items).unwrap_or_default(), records: records.map(|l| l.items).unwrap_or_default() }
}

async fn list(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecords>,
) -> HtmlResult {
    let (query, notice) = (route.query, route.notice);
    page_list(&req, &staff.viewer, &config, &headers, &query, &notice, None, None).await
}

/// The list page; `create` is the create dialog opened or come back, drawn open, and `preview`
/// a bulk preview's answer, drawn open.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn page_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::RefRecordQuery,
    notice: &url::ListNotice,
    create: Option<RecordDraft>,
    preview: Option<Previewed<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    // The type filter's options: the active types (`referenceTypes`).
    let (list, types) = join(
        caller.list::<ReferenceRecord>(Kind::ReferenceRecords, &api_query(query, page)),
        caller.list::<ReferenceType>(Kind::ReferenceTypes, "limit=500&status=active"),
    )
    .await;
    let list = match list {
        Ok(list) => list,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let types = types.map(|l| l.items).unwrap_or_else(|error| {
        tracing::warn!("reference types read for the list's filter failed: {error}");
        Vec::new()
    });
    let mut screen = screen(list, page);
    screen.preview = preview.and_then(|shown| shown.preview.cloned());
    screen.job = follow(&caller, notice.job.as_deref()).await;
    let t: Cat = req.t();
    let bulk = bulk(viewer, t, Kind::ReferenceRecords, notice.job.is_some(), preview, screen.job.as_ref());
    let notice = notice.done.map(|done| done.ref_record(t));
    let view = views::ref_record_list(t, req.t(), query, &screen, &types, create, notice, bulk);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_ref_records()} head="">
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
    Params(route): Params<crate::catalog::reference_records::url::RefRecordsLive>,
) -> LiveResponse {
    let query = route.query;
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = manages(&staff.viewer);
    live_rows(config, headers, since, TOPIC, move |config, headers| {
        let query = query.clone();
        async move {
            let caller = config.platform.caller(&headers, config.proto, None);
            let page = query.page.unwrap_or(1).max(1);
            match caller.list::<ReferenceRecord>(Kind::ReferenceRecords, &api_query(&query, page)).await {
                Ok(list) => Some(views::ref_record_rows(t, p, &query, &screen(list, page), manage).to_html()),
                Err(error) => {
                    tracing::warn!("reference records list read for a change failed: {error}");
                    None
                }
            }
        }
    })
}

/// The create dialog: a patch, or without JavaScript the list with it open.
async fn new_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecordNew>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    let choices = choices(&caller).await;
    let first = choices.types.first().map(|ty| ty.key.as_str());
    let draft = RecordDraft { form: Draft::new(RefRecordInput::blank(first)), choices };
    if req.mode == Mode::Action {
        let action = url::RefRecords::of(&query).href();
        return req.patch(views::RefRecordCreateDialog { t: req.t(), p: req.t(), action: &action, draft: &draft });
    }
    let none = url::ListNotice::default();
    page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft), None).await
}

async fn create(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecords>,
    Form(input): Form<RefRecordInput>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    let action = url::RefRecords::of(&query).href();
    let none = url::ListNotice::default();
    if let Some(next) = input.rerowed() {
        let draft = RecordDraft { form: Draft::new(next), choices: choices(&caller).await };
        if req.mode == Mode::Action {
            return req.patch(views::RefRecordCreateDialog { t: req.t(), p: req.t(), action: &action, draft: &draft });
        }
        return page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft), None).await;
    }
    let errors = match input.body(req.t(), true) {
        Ok(body) => match command(&caller, Method::POST, Kind::ReferenceRecords, "", Some(&body)).await {
            Sent::Written(written) => {
                let notice = url::ListNotice { after_write: receipt(&written), done: Some(Done::Created), job: None };
                return req.redirect(&url::RefRecords { query, notice });
            }
            Sent::Refused(errors) => errors,
            Sent::Denied(denied) => return denied.answer(&req),
        },
        Err(errors) => errors,
    };
    let draft = RecordDraft { form: Draft { input, errors }, choices: choices(&caller).await };
    let form = views::RefRecordCreateDialog { t: req.t(), p: req.t(), action: &action, draft: &draft };
    req.invalid(&draft.form.errors, form, || {
        page_list(&req, &staff.viewer, &config, &headers, &query, &none, Some(draft.clone()), None)
    })
    .await
}

/// What a reference record's page reads after a write: its receipt and what it did.
#[derive(Default)]
struct After {
    after_write: Option<String>,
    done: Option<Done>,
}

async fn ref_record(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::RefRecord<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, After { after_write: route.after_write, done: route.done });
    record_page(&req, &staff.viewer, &config, &headers, &id, &after, RefRecordForms::default()).await
}

async fn record_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after: &After,
    forms: RefRecordForms,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let record = match caller.get::<ReferenceRecord>(Kind::ReferenceRecords, id).await {
        Ok(record) => record,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let t: Cat = req.t();
    let notice = after.done.map(|done| done.ref_record(t));
    let view = views::ref_record_page(t, req.t(), &record, after.after_write.as_deref(), notice, forms);
    req.screen(
        &record,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_ref_record()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

fn to_record(req: &Req, id: &str, written: &Written, done: Done) -> HtmlResult {
    req.redirect(&url::RefRecord { id, after_write: receipt(written), done: Some(done) })
}

/// The edit dialog, filled from the record as the page's receipt reads it: a patch, or without
/// JavaScript the page with it open.
async fn edit_dialog(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecordEdit<'_>>,
) -> HtmlResult {
    let (id, opened) = (route.id, route.opened);
    let receipt = Receipt::from_param(opened.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let (record, choices) = join(caller.get::<ReferenceRecord>(Kind::ReferenceRecords, &id), choices(&caller)).await;
    let record = match record {
        Ok(record) => record,
        Err(error) => return read_failed(&req, error, receipt.is_some()),
    };
    let draft = RecordDraft { form: Draft::new(RefRecordInput::of(&record)), choices };
    if req.mode == Mode::Action {
        return req.patch(views::RefRecordEditDialog { t: req.t(), p: req.t(), id: &id, draft: &draft });
    }
    let after = After { after_write: opened.after_write, done: None };
    let forms = RefRecordForms { edit: Some(draft), ..Default::default() };
    record_page(&req, &staff.viewer, &config, &headers, &id, &after, forms).await
}

async fn revise(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecordEdit<'_>>,
    Form(input): Form<RefRecordInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let after = After::default();
    if let Some(next) = input.rerowed() {
        let draft = RecordDraft { form: Draft::new(next), choices: choices(&caller).await };
        if req.mode == Mode::Action {
            return req.patch(views::RefRecordEditDialog { t: req.t(), p: req.t(), id: &id, draft: &draft });
        }
        let forms = RefRecordForms { edit: Some(draft), ..Default::default() };
        return record_page(&req, &staff.viewer, &config, &headers, &id, &after, forms).await;
    }
    let errors = match input.body(req.t(), false) {
        Ok(body) => match command(&caller, Method::PUT, Kind::ReferenceRecords, &under(&id, &[]), Some(&body)).await {
            Sent::Written(written) => return to_record(&req, &id, &written, Done::Revised),
            Sent::Refused(errors) => errors,
            Sent::Denied(denied) => return denied.answer(&req),
        },
        Err(errors) => errors,
    };
    let draft = RecordDraft { form: Draft { input, errors }, choices: choices(&caller).await };
    let form = views::RefRecordEditDialog { t: req.t(), p: req.t(), id: &id, draft: &draft };
    let forms = RefRecordForms { edit: Some(draft.clone()), ..Default::default() };
    req.invalid(&draft.form.errors, form, || record_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecordLifecycle<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.of(&["publish", "deprecate", "archive"]) {
        Some(action) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::ReferenceRecords, &under(&id, &[action]), None).await {
                Sent::Written(written) => return to_record(&req, &id, &written, Done::of(action)),
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => not_offered(req.t()),
    };
    let t: Cat = req.t();
    let steps = views::ref_record_transitions(t, &input.status);
    let action = url::RefRecordLifecycle { id: &id }.href();
    let form = views::LifecycleForm {
        t,
        id: ids::LIFECYCLE,
        action: &action,
        status: &input.status,
        transitions: &steps,
        errors: &errors,
    };
    let forms = RefRecordForms { lifecycle: Some(errors.clone()), ..Default::default() };
    let after = After::default();
    req.invalid(&errors, form, || record_page(&req, &staff.viewer, &config, &headers, &id, &after, forms)).await
}

/// The filters set on the list, as the API's bulk selection reads them.
fn selection_filter(query: &url::RefRecordQuery) -> Value {
    filter_query(&filters(query))
}

async fn preview_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecordsBulk>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let confirm_at = url::RefRecordsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (preview, errors) = match preview(&req, &caller, Kind::ReferenceRecords, &input, selection_filter(&query)).await {
        Previewing::Shown(preview) => (Some(preview), Errors::new()),
        Previewing::Refused(errors) => (None, errors),
        Previewing::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::ReferenceRecords, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &confirm_at, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}

async fn confirm_bulk(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::reference_records::url::RefRecordsBulkConfirm>,
    Form(input): Form<BulkInput>,
) -> HtmlResult {
    let query = route.query;
    let action = url::RefRecordsBulkConfirm { query: query.clone() }.href();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (errors, preview) = match confirm(&req, &caller, Kind::ReferenceRecords, &input, selection_filter(&query)).await {
        Confirming::Started(job) => {
            let notice = url::ListNotice { job: Some(job.job_id), ..Default::default() };
            return req.redirect(&url::RefRecords { query, notice });
        }
        Confirming::Refused(errors, preview) => (errors, preview),
        Confirming::Denied(denied) => return denied.answer(&req),
    };
    let label = action_label(req.t(), Kind::ReferenceRecords, &input.action);
    let shown = Previewed { input: &input, preview: preview.as_ref(), errors: &errors, confirm: &action, label };
    let none = url::ListNotice::default();
    answer_preview(&req, shown, |shown| page_list(&req, &staff.viewer, &config, &headers, &query, &none, None, Some(shown))).await
}
