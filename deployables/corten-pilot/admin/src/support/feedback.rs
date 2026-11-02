//! Support > Platform Feedback (admin-web's `/support/platform-feedback`, Platform Operations'
//! `PlatformFeedbackAdminListPage` and `PlatformFeedbackAdminDetailPage`): the feedback counts, the status, topic
//! and workflow filters, the review queue with Mark selected reviewed and Archive selected, the
//! CSV export, and a feedback's page with Mark reviewed, Archive, its operator notes and the
//! marketplace pages it is about. Read from and written to `/api/experience/platform-feedback` as
//! the signed-in staff member. Reading needs `platform-feedback.view`, writing `platform-feedback.manage` and
//! the export `platform-feedback.export`, as the API's routes do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/platform-feedback?status&topic&workflow&after_write` | the counts and the queue (100 at most, as admin-web reads it) |
//! | `POST /support/platform-feedback?status&topic&workflow` | a bulk change (`intent`, `feedbackIds`), then the list |
//! | `GET /support/platform-feedback/export?status&topic&workflow` | the queue as the API's CSV |
//! | `GET /support/platform-feedback/{id}?after_write` | a feedback's page |
//! | `POST /support/platform-feedback/{id}` | Mark reviewed, Archive or Record note (`intent`, `body`), then the page |
//!
//! admin-web's selection is React state; here the queue is one form whose rows each have a box
//! and whose two buttons each send their intent, so it works without a script. admin-web's export
//! link is the API's path on admin-web's host; the pilot relays the API's file from its own route.
use corten::{
    Relay,
    axum::{
        body::Body,
        http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    },
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::views;
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, read_failed, sign_in, sign_in_at},
    auth::{FeedbackAccess, Staff, Viewer},
    text::{Pilot, Sup},
};

const CONTEXT: &str = "platform-operations";
const BASE: &str = "/api/experience/platform-feedback";
/// The permission a bulk change, a review, an archive and a note need.
pub const MANAGE: &str = "platform-feedback.manage";
/// The permission the export needs.
pub const EXPORT: &str = "platform-feedback.export";

#[corten::routes(state = crate::app::Shared, area = crate::support::feedback::url::Feedback, caller = crate::auth::Staff<crate::auth::FeedbackAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The queue's filters, as admin-web names them.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct Filters {
        pub status: Option<String>,
        pub topic: Option<String>,
        pub workflow: Option<String>,
    }

    /// The queue, filtered, after the bulk change whose receipt the address carries; a `POST` is a
    /// bulk change.
    #[derive(Clone, Debug, Default)]
    #[route("/support/platform-feedback", get = list, post = bulk)]
    pub struct Feedback {
        #[route(query)]
        pub filters: Filters,
        pub after_write: Option<String>,
    }

    /// The queue as CSV, filtered as the list is.
    #[derive(Clone, Debug, Default)]
    #[route("/support/platform-feedback/export", get = export)]
    pub struct Export {
        #[route(query)]
        pub filters: Filters,
    }

    /// A feedback's page, after the write whose receipt the address carries; a `POST` is a write.
    #[route("/support/platform-feedback/{id}", get = item, post = act)]
    pub struct Item<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
    }
}

/// The area: its routes and its stylesheet.
pub fn area(area: Area<url::Feedback>, shared: Shared) -> Area<url::Feedback> {
    url::area(area, shared).components(views::FEEDBACK)
}

/// The statuses, topics and workflows the filters offer, in admin-web's order.
pub const STATUSES: [&str; 3] = ["new", "reviewed", "archived"];
pub const TOPICS: [&str; 7] = [
    "ease-of-use",
    "pricing-fees",
    "product-data-search",
    "checkout-payment",
    "selling-inventory",
    "performance-reliability",
    "other",
];
pub const WORKFLOWS: [&str; 7] = [
    "checkout-payment",
    "listing-publish",
    "listing-update",
    "offer-submit",
    "offer-accept",
    "inventory-create",
    "inventory-adjust",
];

/// A marketplace record a feedback is about.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Entity {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub id: String,
}

/// An operator's note on a feedback.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub note_id: String,
    pub body: String,
    pub recorded_by_user_id: String,
    pub recorded_at: String,
}

/// A feedback (`PlatformFeedbackListItem`, which is also its detail), as far as the pages show it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Entry {
    pub feedback_id: String,
    pub user_id: String,
    pub account_id: String,
    pub rating: u8,
    pub topic: String,
    #[serde(default)]
    pub comment: Option<String>,
    pub follow_up_consent: bool,
    pub workflow: String,
    pub source_route_path: String,
    #[serde(default)]
    pub related_entities: Vec<Entity>,
    pub status: String,
    pub submitted_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub reviewed_by_user_id: Option<String>,
    #[serde(default)]
    pub archived_by_user_id: Option<String>,
    #[serde(default)]
    pub operator_notes: Vec<Note>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Entries {
    pub items: Vec<Entry>,
    pub total: u64,
    pub count: u64,
}

/// The counts (`PlatformFeedbackMetrics`) the page shows.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Metrics {
    pub total_count: u64,
    pub new_count: u64,
    pub reviewed_count: u64,
    #[serde(default)]
    pub average_rating: Option<String>,
}

/// The filters the queue was read with: each a value admin-web offers, else all (`all` included).
#[derive(Clone, Debug, Default, Serialize, ToJson)]
pub struct Chosen {
    pub status: Option<String>,
    pub topic: Option<String>,
    pub workflow: Option<String>,
}

impl Chosen {
    fn read(filters: &url::Filters) -> Self {
        let one = |value: &Option<String>, known: &[&str]| {
            value.as_deref().map(str::trim).filter(|v| known.contains(v)).map(str::to_owned)
        };
        Chosen {
            status: one(&filters.status, &STATUSES),
            topic: one(&filters.topic, &TOPICS),
            workflow: one(&filters.workflow, &WORKFLOWS),
        }
    }

    /// The filters, for an address.
    pub fn filters(&self) -> url::Filters {
        url::Filters { status: self.status.clone(), topic: self.topic.clone(), workflow: self.workflow.clone() }
    }

    /// The API's filters, as admin-web sends them (none for all).
    fn query(&self) -> String {
        [("status", &self.status), ("topic", &self.topic), ("workflow", &self.workflow)]
            .iter()
            .filter_map(|(key, value)| value.as_ref().map(|v| format!("{key}={}", segment(v))))
            .collect::<Vec<_>>()
            .join("&")
    }
}

/// The queue's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ListScreen {
    pub entries: Entries,
    pub metrics: Metrics,
    pub filters: Chosen,
    pub can_manage: bool,
    pub can_export: bool,
    /// Why the last bulk change was refused.
    pub refusal: Option<String>,
    /// Whether the page was read without the change it follows, which is not readable yet.
    pub catching_up: bool,
}

async fn read_list(caller: &ApiCaller<'_>, chosen: &Chosen) -> Result<(Entries, Metrics), ApiError> {
    let filters = chosen.query();
    let path =
        if filters.is_empty() { format!("{BASE}?limit=100&offset=0") } else { format!("{BASE}?limit=100&offset=0&{filters}") };
    let metrics = format!("{BASE}/metrics");
    let (entries, metrics) = tokio::join!(caller.read::<Entries>(&path, CONTEXT), caller.read::<Metrics>(&metrics, CONTEXT));
    Ok((entries?, metrics?))
}

async fn list(
    req: Req,
    Caller(staff): Caller<Staff<FeedbackAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Feedback>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let chosen = Chosen::read(&route.filters);
    draw_list(&req, &staff.viewer, &config, &headers, chosen, receipt, None, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    chosen: Chosen,
    receipt: Option<Receipt>,
    refusal: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let mut catching_up = false;
    let (entries, metrics) = match read_list(&caller, &chosen).await {
        Ok(read) => read,
        // The change is not readable yet: the page is read without it and says so.
        Err(error) if receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match read_list(&config.platform.caller(headers, config.proto, None), &chosen).await {
                Ok(read) => read,
                Err(error) => return read_failed(req, error, false),
            }
        }
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = ListScreen {
        entries,
        metrics,
        filters: chosen,
        can_manage: viewer.can(MANAGE),
        can_export: viewer.can(EXPORT),
        refusal,
        catching_up,
    };
    let t: Sup = req.t();
    let view = html! { <views::FeedbackPage t={t} p={req.t()} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.fb_route_list()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// What a refused write answers: the page again with the API's message and a status, or not
/// the page (sign in, or the API failing).
enum Refused {
    Page(String, StatusCode),
    Answer(HtmlResult),
}

fn refused(req: &Req, error: ApiError) -> Refused {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => Refused::Answer(sign_in(req)),
        Some(status) if status.is_client_error() => {
            let p: Pilot = req.t();
            let message = error.refusal().unwrap_or(p.access_refused()).to_owned();
            let status = match status {
                StatusCode::CONFLICT | StatusCode::FORBIDDEN => status,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            Refused::Page(message, status)
        }
        _ => Refused::Answer(Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))),
    }
}

/// A bulk change: which (`bulk-review`, `bulk-archive`) and the boxes ticked.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct BulkForm {
    pub intent: String,
    pub feedback_ids: Vec<String>,
}

async fn bulk(
    req: Req,
    Caller(staff): Caller<Staff<FeedbackAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Feedback>,
    Form(form): Form<BulkForm>,
) -> HtmlResult {
    let chosen = Chosen::read(&route.filters);
    let back = |after_write: Option<String>| url::Feedback { filters: chosen.filters(), after_write };
    let ids: Vec<&str> = form.feedback_ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()).collect();
    // admin-web goes back to the list for an intent it does not know, and its buttons cannot
    // be pressed with no row selected.
    let action = match form.intent.as_str() {
        "bulk-review" => "review",
        "bulk-archive" => "archive",
        _ => return req.redirect(&back(None)),
    };
    if ids.is_empty() {
        return req.redirect(&back(None));
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let request = caller.request(Method::POST, &format!("{BASE}/bulk/{action}"), CONTEXT).json(&json!({ "feedbackIds": ids }));
    match caller.write::<serde_json::Value>(request).await {
        Ok((_, receipt)) => req.redirect(&back(receipt.map(|r| r.param()))),
        Err(error) => match refused(&req, error) {
            Refused::Page(refusal, status) => {
                draw_list(&req, &staff.viewer, &config, &headers, chosen, None, Some(refusal), status).await
            }
            Refused::Answer(answer) => answer,
        },
    }
}

/// The queue as the API's CSV, with its type and file name.
async fn export(
    req: Req,
    Caller(staff): Caller<Staff<FeedbackAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Export>,
) -> corten::Result<Relay> {
    if !staff.viewer.can(EXPORT) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let filters = Chosen::read(&route.filters).query();
    let path = if filters.is_empty() { format!("{BASE}/export") } else { format!("{BASE}/export?{filters}") };
    let caller = config.platform.caller(&headers, config.proto, None);
    let res = caller
        .request(Method::GET, &path, CONTEXT)
        .send()
        .await
        .map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    match res.status().as_u16() {
        200..=299 => {}
        // The session ended meanwhile: sign in again, back to the list.
        401 => {
            let to = sign_in_at(req.path()).ok_or_else(|| corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR))?;
            let mut kept = HeaderMap::new();
            kept.insert(header::LOCATION, HeaderValue::from_str(&to.to_string()).map_err(corten::Error::new)?);
            return Ok(Relay::new(StatusCode::SEE_OTHER, kept, Body::empty()));
        }
        403 => return Err(corten::Error::status(StatusCode::FORBIDDEN)),
        status => {
            tracing::warn!("the platform feedback export answered {status}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    }
    let mut kept = HeaderMap::new();
    for name in ["content-type", "content-disposition"] {
        if let Some(value) = res.headers().get(name).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
            kept.insert(HeaderName::from_static(name), value);
        }
    }
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}

/// A feedback's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ItemScreen {
    pub entry: Entry,
    /// Each related record with its marketplace page, when the marketplace's origin is configured
    /// and admin-web links that type.
    pub related: Vec<(Entity, Option<String>)>,
    pub can_manage: bool,
    /// Why the last write was refused, and the note as it was typed.
    pub refusal: Option<String>,
    pub note: String,
    /// Whether the page was read without the write it follows, which is not readable yet.
    pub catching_up: bool,
}

/// A related record's marketplace page (admin-web's `accountRelativeRelatedEntityHref` on its
/// marketplace origin), if it has one.
fn related_href(entity: &Entity, origin: Option<&str>) -> Option<String> {
    let path = match entity.entity_type.as_str() {
        "payment" => "/account/payments/",
        "listing" => "/account/listings/",
        "offer" => "/account/offers/submitted/",
        "inventory-item" => "/account/inventory/items/",
        _ => return None,
    };
    Some(format!("{}{path}{}", origin?, segment(&entity.id)))
}

async fn read_entry(caller: &ApiCaller<'_>, id: &str) -> Result<Entry, ApiError> {
    caller.read(&format!("{BASE}/{}", segment(id)), CONTEXT).await
}

async fn item(
    req: Req,
    Caller(staff): Caller<Staff<FeedbackAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Item<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    draw_item(&req, &staff.viewer, &config, &headers, &route.id, receipt, None, String::new(), StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw_item(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    receipt: Option<Receipt>,
    refusal: Option<String>,
    note: String,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let mut catching_up = false;
    let entry = match read_entry(&caller, id).await {
        Ok(entry) => entry,
        Err(error) if receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match read_entry(&config.platform.caller(headers, config.proto, None), id).await {
                Ok(entry) => entry,
                Err(error) => return read_failed(req, error, false),
            }
        }
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let origin = crate::reported::marketplace_origin();
    let related = entry.related_entities.iter().map(|e| (e.clone(), related_href(e, origin))).collect();
    let screen = ItemScreen { entry, related, can_manage: viewer.can(MANAGE), refusal, note, catching_up };
    let t: Sup = req.t();
    let title = t.fb_route_detail(&screen.entry.feedback_id).to_string();
    let view = html! { <views::FeedbackItemPage t={t} p={req.t()} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={&title} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// A feedback's write: which (`review`, `archive`, `record-note`) and a note's text.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ItemForm {
    pub intent: String,
    pub body: String,
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<FeedbackAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Item<'_>>,
    Form(form): Form<ItemForm>,
) -> HtmlResult {
    let id: &str = &route.id;
    let at = format!("{BASE}/{}", segment(id));
    let (path, body) = match form.intent.as_str() {
        "review" => (format!("{at}/review"), json!({})),
        "archive" => (format!("{at}/archive"), json!({})),
        // The API says whether a note is there (admin-web sends it as typed).
        "record-note" => (format!("{at}/notes"), json!({ "body": form.body })),
        _ => return req.redirect(&url::Item { id, after_write: None }),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.write::<serde_json::Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        Ok((_, receipt)) => req.redirect(&url::Item { id, after_write: receipt.map(|r| r.param()) }),
        Err(error) => match refused(&req, error) {
            Refused::Page(refusal, status) => {
                let note = if form.intent == "record-note" { form.body } else { String::new() };
                draw_item(&req, &staff.viewer, &config, &headers, id, None, Some(refusal), note, status).await
            }
            Refused::Answer(answer) => answer,
        },
    }
}

/// The pilot's page for an admin-web path, when it is a feedback's (the attention queue's Open).
pub fn serves(path: &str) -> Option<String> {
    let id = path.strip_prefix("/support/platform-feedback/")?;
    (!id.is_empty() && !id.contains(['/', '?', '#'])).then(|| path.to_owned())
}
