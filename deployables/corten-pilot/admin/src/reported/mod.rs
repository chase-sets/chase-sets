//! Support > Reported Content (admin-web's `/support/reported-content`, Platform Operations'
//! `ReportedContentAdminListPage` and `ReportedContentAdminDetailPage`): the moderation queue with
//! its counts and its status and target filters, and a reported target's page with its reports and
//! the moderation actions its target type has. Read from and written to `/api/experience/reported-content`
//! as the signed-in staff member; every route needs `reported-content.view`, as the API's do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/reported-content?status&targetType` | the counts and the queue (100 at most, as admin-web reads it) |
//! | `GET /support/reported-content/{targetType}/{targetId}?after_write&recorded` | a target's page |
//! | `POST /support/reported-content/{targetType}/{targetId}` | a moderation action (`action`, `note`), then the page |
//!
//! Which actions a target type has is the published contract table
//! (`platformOperationsReportedContentActionsByTargetType`, exported to
//! `reported-content-actions.json`); the API checks it again, and that a note is there when the
//! action needs one.
//!
//! Support > Risk Alerts ([`risk`]) is its own area with the same permission and this area's
//! stylesheet.
use std::{collections::BTreeMap, sync::LazyLock};

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;

pub mod risk;
pub mod views;

use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{ReportedContentView, Staff, Viewer},
    text::Ops,
};

const CONTEXT: &str = "platform-operations";
const BASE: &str = "/api/experience/reported-content";

/// The queue's routes. admin-web challenges the section's page for its nav entry's permission.
#[corten::routes(state = crate::app::Shared, area = crate::reported::url::Reported, caller = crate::auth::Staff<crate::auth::ReportedContentView>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The queue, filtered.
    #[derive(Clone, Debug, Default)]
    #[route("/support/reported-content", get = list)]
    pub struct Reported {
        #[route(query)]
        pub filters: Filters,
    }

    /// The queue's filters, as admin-web names them.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Filters {
        pub status: Option<String>,
        pub target_type: Option<String>,
    }

    /// A reported target's page, after the action whose receipt the address carries, or the time
    /// the action was recorded when it answered no receipt; a `POST` is a moderation action.
    #[route("/support/reported-content/{target_type}/{target_id}", get = item, post = act)]
    pub struct Item<'a> {
        pub target_type: &'a str,
        pub target_id: &'a str,
        pub after_write: Option<String>,
        pub recorded: Option<String>,
    }
}

/// The area: its routes and its stylesheet.
pub fn area(area: Area<url::Reported>, shared: Shared) -> Area<url::Reported> {
    url::area(area, shared).components(views::COMPONENTS)
}

/// The statuses the queue filters by, in admin-web's order.
pub const STATUSES: [&str; 11] = [
    "needs-review",
    "auto-unlisted",
    "dismissed",
    "seller-contact-requested",
    "manually-unlisted",
    "suspension-escalated",
    "review-withdrawn",
    "review-feedback-redacted",
    "review-reply-withdrawn",
    "account-contact-requested",
    "profile-display-name-redacted",
];

/// The target types, in admin-web's order.
pub const TARGET_TYPES: [&str; 3] = ["listing", "review", "account-profile"];

/// Each target type's moderation actions (the contract table, from scripts/export.mjs).
pub fn actions(target_type: &str) -> &'static [String] {
    static TABLE: LazyLock<BTreeMap<String, Vec<String>>> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../reported-content-actions.json"))
            .expect("reported-content-actions.json is the export's output")
    });
    TABLE.get(target_type).map_or(&[], Vec::as_slice)
}

/// A reason and how many reports gave it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Reason {
    pub reason: String,
    pub count: u64,
}

/// A report as an operator sees it (`ReportedContentReportSummary`: never who sent it).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub report_id: String,
    pub reporter_kind: String,
    pub reason: String,
    #[serde(default)]
    pub details: Option<String>,
    pub submitted_at: String,
}

/// A queued target (`ReportedContentQueueItem`); a target's page also has its reports
/// (`ReportedContentQueueDetail`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct QueueItem {
    pub target_type: String,
    pub target_id: String,
    #[serde(default)]
    pub target_owner_account_id: Option<String>,
    pub status: String,
    pub report_count: u64,
    #[serde(default)]
    pub reasons: Vec<Reason>,
    #[serde(default)]
    pub first_reported_at: Option<String>,
    #[serde(default)]
    pub last_reported_at: Option<String>,
    #[serde(default)]
    pub auto_unlisted_at: Option<String>,
    #[serde(default)]
    pub last_action: Option<String>,
    #[serde(default)]
    pub last_action_at: Option<String>,
    #[serde(default)]
    pub reports: Vec<Report>,
    #[serde(default)]
    pub distinct_reporter_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Queue {
    pub items: Vec<QueueItem>,
    pub total: u64,
    pub count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Metrics {
    pub total_count: u64,
    pub needs_review_count: u64,
    pub auto_unlisted_count: u64,
}

/// A filter's value as admin-web reads it: a value it offers, else all (`"all"` included).
fn chosen(value: Option<&str>, known: &[&str]) -> Option<String> {
    value.map(str::trim).filter(|v| known.contains(v)).map(str::to_owned)
}

/// The queue's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct QueueScreen {
    pub queue: Queue,
    pub metrics: Metrics,
    pub status: Option<String>,
    pub target_type: Option<String>,
}

async fn list(
    req: Req,
    Caller(staff): Caller<Staff<ReportedContentView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Reported>,
) -> HtmlResult {
    let status = chosen(route.filters.status.as_deref(), &STATUSES);
    let target_type = chosen(route.filters.target_type.as_deref(), &TARGET_TYPES);
    let mut query = String::from("limit=100&offset=0");
    if let Some(status) = &status {
        query.push_str(&format!("&status={}", segment(status)));
    }
    if let Some(target_type) = &target_type {
        query.push_str(&format!("&targetType={}", segment(target_type)));
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let path = format!("{BASE}?{query}");
    let metrics_path = format!("{BASE}/metrics");
    let (queue, metrics) = tokio::join!(caller.read::<Queue>(&path, CONTEXT), caller.read::<Metrics>(&metrics_path, CONTEXT));
    let screen = match (queue, metrics) {
        (Ok(queue), Ok(metrics)) => QueueScreen { queue, metrics, status, target_type },
        (Err(error), _) | (_, Err(error)) => return read_failed(&req, error, false),
    };
    let t: Ops = req.t();
    let view = html! { <views::ReportedPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.reported_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// A target's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ItemScreen {
    pub item: QueueItem,
    /// The marketplace page of a listing target, when the marketplace's origin is configured.
    pub marketplace_href: Option<String>,
    /// Why the last action was refused.
    pub refusal: Option<String>,
    /// Whether the page was read without the action it follows, which is not readable yet.
    pub catching_up: bool,
}

/// marketplace's origin (`CHASE_SETS_MARKETPLACE_ORIGIN`, as admin-web reads it), if set.
pub(crate) fn marketplace_origin() -> Option<&'static str> {
    static ORIGIN: LazyLock<Option<String>> = LazyLock::new(|| {
        std::env::var("CHASE_SETS_MARKETPLACE_ORIGIN")
            .ok()
            .map(|o| o.trim().trim_end_matches('/').to_owned())
            .filter(|o| !o.is_empty())
    });
    ORIGIN.as_deref()
}

async fn read_item(caller: &ApiCaller<'_>, target_type: &str, target_id: &str) -> Result<QueueItem, ApiError> {
    caller.read(&format!("{BASE}/{}/{}", segment(target_type), segment(target_id)), CONTEXT).await
}

async fn item(
    req: Req,
    Caller(staff): Caller<Staff<ReportedContentView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Item<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let target = (route.target_type.as_str(), route.target_id.as_str());
    let after = After { receipt, recorded: route.recorded.as_deref() };
    draw(&req, &staff.viewer, &config, &headers, target, after, None, StatusCode::OK).await
}

/// The action a page follows: its receipt, or the time it was recorded when it answered none.
#[derive(Default)]
struct After<'a> {
    receipt: Option<Receipt>,
    recorded: Option<&'a str>,
}

/// Whether a page read after an action that answered no receipt, recorded at `recorded`, shows
/// a latest action older than it.
fn behind(recorded: Option<&str>, last_action_at: Option<&str>) -> bool {
    let Some(at) = recorded.and_then(corten::i18n::parse_timestamp) else { return false };
    last_action_at.and_then(corten::i18n::parse_timestamp).is_none_or(|last| last < at)
}

/// Where an action's page goes after it: with its receipt, or with the time the API says it
/// recorded the action when it answered no receipt.
fn after_action(answer: &serde_json::Value, receipt: Option<&Receipt>) -> (Option<String>, Option<String>) {
    match receipt {
        Some(receipt) => (Some(receipt.param()), None),
        None => (None, answer["recordedAt"].as_str().map(str::to_owned)),
    }
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    (target_type, target_id): (&str, &str),
    After { receipt, recorded }: After<'_>,
    refusal: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let mut catching_up = false;
    let item = match read_item(&caller, target_type, target_id).await {
        Ok(item) => item,
        // The action is not readable yet: the page is read without it and says so.
        Err(error) if receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match read_item(&config.platform.caller(headers, config.proto, None), target_type, target_id).await {
                Ok(item) => item,
                Err(error) => return read_failed(req, error, false),
            }
        }
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    // An action answers no receipt (chase-sets/chase-sets#10833): until the target shows an
    // action as late as it, the page says the action is still being applied.
    catching_up |= behind(recorded, item.last_action_at.as_deref());
    let marketplace_href = (item.target_type == "listing")
        .then(marketplace_origin)
        .flatten()
        .map(|origin| format!("{origin}/account/listings/{}", segment(&item.target_id)));
    let screen = ItemScreen { item, marketplace_href, refusal, catching_up };
    let t: Ops = req.t();
    let title =
        t.reported_detail_meta_title(&views::target_type(t, &screen.item.target_type), &screen.item.target_id).to_string();
    let view = html! { <views::ItemPage t={t} p={req.t()} screen={&screen} /> };
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

/// A moderation action: which, and the note an action may need.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ActionForm {
    pub action: String,
    pub note: String,
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<ReportedContentView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Item<'_>>,
    Form(form): Form<ActionForm>,
) -> HtmlResult {
    let target = (route.target_type.as_str(), route.target_id.as_str());
    // admin-web refuses an action it does not know (400) before the API sees it.
    if !TARGET_TYPES.iter().any(|t| actions(t).contains(&form.action)) {
        return Err(corten::Error::status(StatusCode::BAD_REQUEST));
    }
    let note = Some(form.note.trim()).filter(|n| !n.is_empty());
    let path = format!("{BASE}/{}/{}/actions", segment(target.0), segment(target.1));
    let caller = config.platform.caller(&headers, config.proto, None);
    let body = json!({ "action": form.action, "note": note });
    match caller.write::<serde_json::Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        // admin-web drops the section here (chase-sets/chase-sets#10832); the pilot does not.
        Ok((answer, receipt)) => {
            let (after_write, recorded) = after_action(&answer, receipt.as_ref());
            req.redirect(&url::Item { target_type: target.0, target_id: target.1, after_write, recorded })
        }
        Err(error) => {
            let status = match error.status() {
                Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
                Some(status) if status.is_client_error() => status,
                _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            };
            let p: crate::text::Pilot = req.t();
            let refusal = Some(error.refusal().unwrap_or(p.access_refused()).to_owned());
            let status = match status {
                StatusCode::CONFLICT | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => status,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            draw(&req, &staff.viewer, &config, &headers, target, After::default(), refusal, status).await
        }
    }
}
