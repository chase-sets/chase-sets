//! Support > Risk Alerts (admin-web's `/support/risk-alerts`, Platform Operations'
//! `RiskAlertAdminListPage` and `RiskAlertAdminDetailPage`): the alert queue with its counts and
//! its status and kind filters, and an alert's page with its evidence, its threshold and the two
//! responses. Read from and written to `/api/experience/risk-alerts` as the signed-in staff
//! member; the API asks for `reported-content.view`, as admin-web's nav entry does.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/risk-alerts?status&alertKind` | the counts and the queue (100 at most, as admin-web reads it) |
//! | `GET /support/risk-alerts/{alertId}?after_write&recorded` | an alert's page |
//! | `POST /support/risk-alerts/{alertId}` | a response (`action`, `note`), then the page |
//!
//! Request manual payout review is offered only for a candidate, as admin-web offers it; the API
//! refuses it for any other alert, and the page is drawn again with that refusal.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{ActionForm, After, after_action, behind, chosen, views};
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{ReportedContentView, Staff, Viewer},
    text::Ops,
};

const CONTEXT: &str = "platform-operations";
const BASE: &str = "/api/experience/risk-alerts";

/// The area: its routes, and Reported Content's stylesheet, which draws its pages too.
pub fn area(area: Area<url::Risks>, shared: Shared) -> Area<url::Risks> {
    url::area(area, shared).components(views::COMPONENTS)
}

#[corten::routes(state = crate::app::Shared, area = crate::reported::risk::url::Risks, caller = crate::auth::Staff<crate::auth::ReportedContentView>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The alert queue, filtered.
    #[derive(Clone, Debug, Default)]
    #[route("/support/risk-alerts", get = list)]
    pub struct Risks {
        #[route(query)]
        pub filters: Filters,
    }

    /// The queue's filters, as admin-web names them.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Filters {
        pub status: Option<String>,
        pub alert_kind: Option<String>,
    }

    /// An alert's page, after the response whose receipt (or recorded time) the address carries;
    /// a `POST` is a response.
    #[route("/support/risk-alerts/{alert_id}", get = alert, post = act)]
    pub struct Alert<'a> {
        pub alert_id: &'a str,
        pub after_write: Option<String>,
        pub recorded: Option<String>,
    }
}

/// The statuses the queue filters by, in admin-web's order.
pub const STATUSES: [&str; 3] = ["needs-review", "manual-payout-review-requested", "acknowledged"];

/// The alert kinds, in admin-web's order.
pub const KINDS: [&str; 4] =
    ["chargeback-velocity", "new-seller-listing-velocity", "review-velocity", "young-buyer-spend-velocity"];

/// The responses (`RiskAlertAction`).
pub const ACTIONS: [&str; 2] = ["request-manual-payout-review", "acknowledge"];

/// An alert (`RiskAlertQueueItem`; its page reads the same).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct RiskAlert {
    pub alert_id: String,
    pub account_id: String,
    pub alert_kind: String,
    pub status: String,
    pub severity: String,
    pub manual_payout_review_candidate: bool,
    #[serde(default)]
    pub evidence: Map<String, Value>,
    #[serde(default)]
    pub threshold: Map<String, Value>,
    #[serde(default)]
    pub first_triggered_at: Option<String>,
    #[serde(default)]
    pub last_triggered_at: Option<String>,
    #[serde(default)]
    pub last_action: Option<String>,
    #[serde(default)]
    pub last_action_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Alerts {
    pub items: Vec<RiskAlert>,
    pub total: u64,
    pub count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct AlertMetrics {
    pub total_count: u64,
    pub needs_review_count: u64,
    pub manual_payout_review_candidate_count: u64,
}

/// The queue's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct RisksScreen {
    pub queue: Alerts,
    pub metrics: AlertMetrics,
    pub status: Option<String>,
    pub alert_kind: Option<String>,
}

async fn list(
    req: Req,
    Caller(staff): Caller<Staff<ReportedContentView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Risks>,
) -> HtmlResult {
    let status = chosen(route.filters.status.as_deref(), &STATUSES);
    let alert_kind = chosen(route.filters.alert_kind.as_deref(), &KINDS);
    let mut query = String::from("limit=100&offset=0");
    if let Some(status) = &status {
        query.push_str(&format!("&status={}", segment(status)));
    }
    if let Some(kind) = &alert_kind {
        query.push_str(&format!("&alertKind={}", segment(kind)));
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let (path, metrics_path) = (format!("{BASE}?{query}"), format!("{BASE}/metrics"));
    let (queue, metrics) =
        tokio::join!(caller.read::<Alerts>(&path, CONTEXT), caller.read::<AlertMetrics>(&metrics_path, CONTEXT));
    let screen = match (queue, metrics) {
        (Ok(queue), Ok(metrics)) => RisksScreen { queue, metrics, status, alert_kind },
        (Err(error), _) | (_, Err(error)) => return read_failed(&req, error, false),
    };
    let t: Ops = req.t();
    let view = html! { <views::RisksPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.risk_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// An alert's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct AlertScreen {
    pub alert: RiskAlert,
    /// Why the last response was refused.
    pub refusal: Option<String>,
    /// Whether the page shows the alert before the response it follows, which is not readable yet.
    pub catching_up: bool,
}

async fn read_alert(caller: &ApiCaller<'_>, alert_id: &str) -> Result<RiskAlert, ApiError> {
    caller.read(&format!("{BASE}/{}", segment(alert_id)), CONTEXT).await
}

async fn alert(
    req: Req,
    Caller(staff): Caller<Staff<ReportedContentView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Alert<'_>>,
) -> HtmlResult {
    let after = After { receipt: Receipt::from_param(route.after_write.as_deref()), recorded: route.recorded.as_deref() };
    draw(&req, &staff.viewer, &config, &headers, route.alert_id.as_str(), after, None, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    alert_id: &str,
    After { receipt, recorded }: After<'_>,
    refusal: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let mut catching_up = false;
    let alert = match read_alert(&caller, alert_id).await {
        Ok(alert) => alert,
        // The response is not readable yet: the page is read without it and says so.
        Err(error) if receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match read_alert(&config.platform.caller(headers, config.proto, None), alert_id).await {
                Ok(alert) => alert,
                Err(error) => return read_failed(req, error, false),
            }
        }
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    // A response answers no receipt (chase-sets/chase-sets#10835).
    catching_up |= behind(recorded, alert.last_action_at.as_deref());
    let screen = AlertScreen { alert, refusal, catching_up };
    let t: Ops = req.t();
    let title = t.risk_detail_meta_title(&views::alert_kind(t, &screen.alert.alert_kind)).to_string();
    let view = html! { <views::AlertPage t={t} p={req.t()} screen={&screen} /> };
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

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<ReportedContentView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Alert<'_>>,
    Form(form): Form<ActionForm>,
) -> HtmlResult {
    let alert_id = route.alert_id.as_str();
    // admin-web refuses a response it does not know (400) before the API sees it.
    if !ACTIONS.contains(&form.action.as_str()) {
        return Err(corten::Error::status(StatusCode::BAD_REQUEST));
    }
    let note = Some(form.note.trim()).filter(|n| !n.is_empty());
    let path = format!("{BASE}/{}/actions", segment(alert_id));
    let caller = config.platform.caller(&headers, config.proto, None);
    let body = json!({ "action": form.action, "note": note });
    match caller.write::<Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        Ok((answer, receipt)) => {
            let (after_write, recorded) = after_action(&answer, receipt.as_ref());
            req.redirect(&url::Alert { alert_id, after_write, recorded })
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
            draw(&req, &staff.viewer, &config, &headers, alert_id, After::default(), refusal, status).await
        }
    }
}
