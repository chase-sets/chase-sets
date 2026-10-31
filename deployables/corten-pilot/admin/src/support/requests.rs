//! Support > Support requests (admin-web's `/support/requests`, Platform Operations'
//! `SupportOperationsPage` and `EntityDetailDrawer`): the operations queue with its status
//! tabs, filters, applied-filter chips, Escalate overdue and pages, and the selected request
//! (`requestId` in the address) in a sheet over it: its summary, the adjudication comparison, the
//! recommended action, the checklist, notes, offers, the audit trail with its photos, the full
//! case context and the other actions. Read from and written to
//! `/api/marketplace/support-requests/ops` as the signed-in staff member; every route needs
//! `support.manage`, as the API's do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/requests?<queue>&requestId&action&after_write&escalated&skipped&capped&escalationTotal` | the queue, with the request's sheet |
//! | `POST /support/requests?<queue>` | Escalate overdue, then the queue with its counts |
//! | `GET /support/requests/{id}?<queue>` | the queue with the request's sheet, as admin-web redirects |
//! | `POST /support/requests/{id}?<queue>` | a case action (`intent`: note, response, escalate, resolve, close, cancel), then the sheet |
//! | `GET /support/requests/{id}/attachments/{attachment}` | an evidence photo, relayed from the API |
//!
//! Departures from admin-web, each until its issue closes:
//! - The ops reads do not answer the next deadline, the recommended action, the responsibility
//!   reasons an operator may choose or the refund ceiling (chase-sets/chase-sets#10849): the pilot
//!   works them out as admin-web does, the reasons from `support-responsibility-reasons.json`.
//! - The remedy lifecycle (proposal, approval, effects, refund release, corrections) is not ported
//!   yet: a request with one links to its sheet on admin-web.
use std::{collections::BTreeMap, sync::LazyLock, time::SystemTime};

use corten::{
    Relay,
    axum::{
        body::Body,
        http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    },
    i18n::parse_timestamp,
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{Staff, SupportManage, Viewer},
    text::Sup,
};

const CONTEXT: &str = "platform-operations";
const BASE: &str = "/api/marketplace/support-requests";
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 250;

#[corten::routes(state = crate::app::Shared, area = crate::support::requests::url::Requests, caller = crate::auth::Staff<crate::auth::SupportManage>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The queue's filters and page, as admin-web names them.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Queue {
        pub status: Option<String>,
        pub priority: Option<String>,
        pub search: Option<String>,
        pub flow_type: Option<String>,
        pub contested: Option<String>,
        pub overdue: Option<String>,
        pub limit: Option<String>,
        pub offset: Option<String>,
    }

    /// The selected request, what was just done to it, and Escalate overdue's counts.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Notice {
        pub request_id: Option<String>,
        pub action: Option<String>,
        /// The write's receipt, named as on every pilot screen.
        #[serde(rename = "after_write")]
        pub after_write: Option<String>,
        pub escalated: Option<String>,
        pub skipped: Option<String>,
        pub capped: Option<String>,
        pub escalation_total: Option<String>,
    }

    /// The queue; a `POST` is Escalate overdue.
    #[derive(Clone, Debug, Default)]
    #[route("/support/requests", get = queue, post = escalate_overdue)]
    pub struct Requests {
        #[route(query)]
        pub queue: Queue,
        #[route(query)]
        pub notice: Notice,
    }

    /// A request: its sheet over the queue; a `POST` is a case action.
    #[route("/support/requests/{id}", get = request, post = act)]
    pub struct Request<'a> {
        pub id: &'a str,
        #[route(query)]
        pub queue: Queue,
    }

    /// An evidence photo of a request.
    #[route("/support/requests/{id}/attachments/{attachment}", get = attachment)]
    pub struct Attachment<'a> {
        pub id: &'a str,
        pub attachment: &'a str,
    }
}

/// The area: its routes, its stylesheet and the sheet's script.
pub fn area(area: Area<url::Requests>, shared: Shared) -> Area<url::Requests> {
    url::area(area, shared).components(views::REQUESTS)
}

/// The pilot's own address for an admin-web Support requests path (the queue, or a request's sheet
/// by `requestId`), which keeps admin-web's query; else `None`.
pub fn serves(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/support/requests")?;
    (rest.is_empty() || rest.starts_with('?')).then(|| path.to_owned())
}

/// The status tabs, in admin-web's order (`all` is the API's default queue).
pub const STATUSES: [&str; 9] = [
    "all",
    "unresolved",
    "open",
    "waiting-on-buyer",
    "waiting-on-seller",
    "ready-for-support",
    "resolved",
    "closed",
    "cancelled",
];
pub const PRIORITIES: [&str; 3] = ["all", "normal", "urgent"];
/// The flows, in admin-web's order: the issue type filter's values when the flows cannot be read.
pub const FLOW_TYPES: [&str; 12] = [
    "product-not-received",
    "product-not-as-described",
    "product-damaged",
    "wrong-product-received",
    "missing-products",
    "authenticity-concern",
    "return-request",
    "buyer-cancel-request",
    "seller-cannot-fulfill",
    "refund-status",
    "shipping-label-or-tracking",
    "payment-problem",
];
/// A support response's types (admin-web's `responseTypeItems`).
pub const RESPONSE_TYPES: [&str; 9] = [
    "request-support-review",
    "provide-tracking",
    "accept-return",
    "offer-partial-refund",
    "offer-replacement",
    "issue-refund",
    "challenge-with-evidence",
    "confirm-cancellation",
    "confirm-cannot-fulfill",
];
/// The resolutions, in admin-web's order; a request offers those its flow allows.
pub const RESOLUTIONS: [&str; 7] =
    ["support-reviewed", "full-refund", "partial-refund", "return-for-refund", "replacement", "cancel-order", "no-action"];

/// The queue as it was asked for: each filter a value admin-web offers, else all; the page.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Filters {
    pub status: String,
    pub priority: String,
    pub search: String,
    pub flow_type: String,
    pub contested: bool,
    pub overdue: bool,
    pub limit: u32,
    pub offset: u32,
}

impl Filters {
    fn read(queue: &url::Queue) -> Self {
        let one = |value: &Option<String>, known: &[&str]| {
            value.as_deref().map(str::trim).filter(|v| known.contains(v)).unwrap_or("all").to_owned()
        };
        let number = |value: &Option<String>| value.as_deref().and_then(|v| v.trim().parse::<u32>().ok());
        Filters {
            status: one(&queue.status, &STATUSES),
            priority: one(&queue.priority, &PRIORITIES),
            search: queue.search.as_deref().unwrap_or_default().trim().to_owned(),
            flow_type: one(&queue.flow_type, &FLOW_TYPES),
            contested: queue.contested.as_deref() == Some("true"),
            overdue: queue.overdue.as_deref() == Some("true"),
            limit: number(&queue.limit).filter(|l| *l > 0).unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT),
            offset: number(&queue.offset).unwrap_or(0),
        }
    }

    /// This queue in an address; `status` and `offset` changed when given.
    pub fn at(&self, status: Option<&str>, offset: Option<u32>) -> url::Queue {
        let set = |value: &str| (value != "all").then(|| value.to_owned());
        let offset = offset.unwrap_or(self.offset);
        url::Queue {
            status: set(status.unwrap_or(&self.status)),
            priority: set(&self.priority),
            search: (!self.search.is_empty()).then(|| self.search.clone()),
            flow_type: set(&self.flow_type),
            contested: self.contested.then(|| "true".to_owned()),
            overdue: self.overdue.then(|| "true".to_owned()),
            limit: (self.limit != DEFAULT_LIMIT || offset > 0).then(|| self.limit.to_string()),
            offset: (offset > 0).then(|| offset.to_string()),
        }
    }

    /// The API's query, as admin-web sends it.
    fn query(&self) -> String {
        let mut parts = vec![format!("limit={}", self.limit), format!("offset={}", self.offset)];
        for (key, value) in [("status", &self.status), ("priority", &self.priority)] {
            if value != "all" {
                parts.push(format!("{key}={}", segment(value)));
            }
        }
        if !self.search.is_empty() {
            parts.push(format!("search={}", segment(&self.search)));
        }
        if self.flow_type != "all" {
            parts.push(format!("flowType={}", segment(&self.flow_type)));
        }
        if self.contested {
            parts.push("contested=true".to_owned());
        }
        if self.overdue {
            parts.push("overdue=true".to_owned());
        }
        parts.join("&")
    }
}

/// A checklist requirement.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub key: String,
    pub label: String,
    pub required: bool,
    #[serde(default)]
    pub satisfied_at: Option<String>,
}

/// A queued request (`SupportRequestListRow`), as far as the queue shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Row {
    pub support_request_id: String,
    #[serde(default)]
    pub display_reference: Option<String>,
    pub order_id: String,
    pub flow_type: String,
    pub status: String,
    pub priority: String,
    #[serde(default)]
    pub seller_response_due_at: Option<String>,
    #[serde(default)]
    pub support_review_due_at: Option<String>,
    #[serde(default)]
    pub seller_condition_attestation_due_at: Option<String>,
    #[serde(default)]
    pub checklist: Vec<Requirement>,
    #[serde(default)]
    pub contested: Option<bool>,
}

impl Row {
    /// What the request is called: its display reference, else its id.
    pub fn reference(&self) -> &str {
        self.display_reference.as_deref().filter(|r| !r.is_empty()).unwrap_or(&self.support_request_id)
    }

    /// The earliest deadline (admin-web's `nextSupportDeadline`; the ops reads do not answer it,
    /// chase-sets/chase-sets#10849).
    pub fn next_deadline(&self) -> Option<&str> {
        [&self.seller_response_due_at, &self.support_review_due_at, &self.seller_condition_attestation_due_at]
            .into_iter()
            .filter_map(|at| at.as_deref())
            .filter_map(|at| parse_timestamp(at).map(|when| (when, at)))
            .min_by_key(|(when, _)| *when)
            .map(|(_, at)| at)
    }

    /// The required checklist items, and how many are satisfied.
    pub fn checklist_counts(&self) -> (usize, usize) {
        let required: Vec<_> = self.checklist.iter().filter(|item| item.required).collect();
        (required.iter().filter(|item| item.satisfied_at.is_some()).count(), required.len())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Queue {
    pub items: Vec<Row>,
    pub total: u64,
    pub count: u64,
}

/// Evidence or a note a party or support submitted.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub evidence_id: String,
    pub submitted_by_role: String,
    pub evidence_type: String,
    pub summary: String,
    pub submitted_at: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub response_id: String,
    pub response_type: String,
    pub submitted_by_role: String,
    pub summary: String,
    pub submitted_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub offer_id: String,
    pub offered_by_role: String,
    pub resolution_type: String,
    #[serde(default)]
    pub refund_amount: Option<String>,
    pub summary: String,
    pub offered_at: String,
    pub status: String,
    #[serde(default)]
    pub decided_by_role: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub summary: String,
    #[serde(default)]
    pub refund_amount: Option<String>,
    #[serde(default)]
    pub resolved_by_role: Option<String>,
    pub resolved_at: String,
}

/// The flow's facts the sheet uses.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    #[serde(default)]
    pub allowed_resolutions: Vec<String>,
}

/// A request (`SupportRequestDetailResponse`), as far as the sheet shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Detail {
    #[serde(flatten)]
    pub row: Row,
    pub buyer_account_id: String,
    pub seller_account_id: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub responses: Vec<Response>,
    #[serde(default)]
    pub offers: Vec<Offer>,
    #[serde(default)]
    pub pending_offer: Option<Offer>,
    #[serde(default)]
    pub resolution: Option<Resolution>,
    #[serde(default)]
    pub escalated_at: Option<String>,
    #[serde(default)]
    pub escalated_by_role: Option<String>,
    #[serde(default)]
    pub escalation_reason: Option<String>,
    #[serde(default)]
    pub order_return_context: Vec<Value>,
    #[serde(default)]
    pub affected_line_items: Vec<Value>,
    #[serde(default)]
    pub closure_eligible: bool,
    #[serde(default)]
    pub closure_blocking_reasons: Vec<String>,
    #[serde(default)]
    pub remedy: Option<Value>,
    #[serde(default)]
    pub remedy_approval: Option<Value>,
    pub flow: Flow,
}

/// An operator's case action (admin-web's `OperatorAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseAction {
    Response,
    Escalate,
    Resolve,
}

impl Detail {
    pub fn terminal(&self) -> bool {
        matches!(self.row.status.as_str(), "resolved" | "closed" | "cancelled")
    }

    /// The recommended action (admin-web's `supportRequestPrimaryAction`; chase-sets/chase-sets#10849):
    /// Resolve when the request is ready for support, Escalate once its deadline has passed,
    /// else Respond.
    pub fn recommended(&self, now: SystemTime) -> CaseAction {
        if self.row.status == "ready-for-support" {
            return CaseAction::Resolve;
        }
        match self.row.next_deadline().and_then(parse_timestamp) {
            Some(deadline) if deadline <= now => CaseAction::Escalate,
            _ => CaseAction::Response,
        }
    }

    /// Whether the sheet shows the adjudication comparison.
    pub fn adjudicating(&self) -> bool {
        !self.terminal() && (self.row.contested == Some(true) || self.row.status == "ready-for-support")
    }

    /// Whether the request has a remedy lifecycle to show (admin-web's condition for its panel).
    pub fn has_remedy(&self) -> bool {
        self.resolution.as_ref().is_some_and(|r| r.refund_amount.is_some())
            || self.remedy_approval.as_ref().is_some_and(|v| !v.is_null())
            || self.remedy.as_ref().is_some_and(|v| !v.is_null())
    }

    /// The resolutions the flow allows, in admin-web's order.
    pub fn resolutions(&self) -> Vec<&'static str> {
        RESOLUTIONS.into_iter().filter(|r| self.flow.allowed_resolutions.iter().any(|a| a == r)).collect()
    }

    /// The refund ceiling: the affected lines' total (admin-web's `adjudicationRefundCap`; the
    /// domain enforces it, chase-sets/chase-sets#10849). None without lines, or with one it cannot read.
    pub fn refund_cap(&self) -> Option<i64> {
        if self.affected_line_items.is_empty() {
            return None;
        }
        self.affected_line_items.iter().try_fold(0i64, |total, line| {
            line["currencyCode"].as_str()?;
            Some(total + cents(line["amount"].as_str()?)?)
        })
    }

    /// The refund field's prefill (admin-web's `adjudicationRefundPrefill`): the latest offer's refund
    /// within the ceiling, else the ceiling.
    pub fn refund_prefill(&self) -> Option<String> {
        let cap = self.refund_cap();
        let latest = match self.pending_offer.as_ref().and_then(|o| o.refund_amount.as_deref()) {
            Some(amount) => Some(amount),
            None => {
                let mut offers: Vec<&Offer> = self.offers.iter().collect();
                offers.sort_by(|a, b| b.offered_at.cmp(&a.offered_at));
                offers.iter().find_map(|o| o.refund_amount.as_deref())
            }
        };
        if let Some(offer) = latest.and_then(cents)
            && cap.is_none_or(|cap| offer <= cap)
        {
            return Some(amount(offer));
        }
        cap.map(amount)
    }

    /// The case's activity, newest first (admin-web's `auditItems`): kind, summary, when and photos.
    pub fn activity(&self) -> Vec<Activity<'_>> {
        let mut items: Vec<Activity<'_>> = Vec::new();
        for item in &self.evidence {
            let kind = if item.evidence_type == "support-note" { ActivityKind::Note } else { ActivityKind::Evidence };
            items.push(Activity { kind, summary: &item.summary, at: &item.submitted_at, attachments: &item.attachments });
        }
        for item in &self.responses {
            items.push(Activity {
                kind: ActivityKind::Response,
                summary: &item.summary,
                at: &item.submitted_at,
                attachments: &[],
            });
        }
        for item in &self.offers {
            items.push(Activity { kind: ActivityKind::Offer, summary: &item.summary, at: &item.offered_at, attachments: &[] });
        }
        if let Some(at) = &self.escalated_at {
            let summary = self.escalation_reason.as_deref().unwrap_or_default();
            items.push(Activity { kind: ActivityKind::Escalation, summary, at, attachments: &[] });
        }
        if let Some(resolution) = &self.resolution {
            let at = &resolution.resolved_at;
            items.push(Activity { kind: ActivityKind::Resolution, summary: &resolution.summary, at, attachments: &[] });
        }
        items.sort_by(|a, b| b.at.cmp(a.at));
        items
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ActivityKind {
    Note,
    Evidence,
    Response,
    Offer,
    Escalation,
    Resolution,
}

/// An entry of the audit trail.
pub struct Activity<'a> {
    pub kind: ActivityKind,
    pub summary: &'a str,
    pub at: &'a str,
    pub attachments: &'a [String],
}

/// A money amount in cents (`12.34`, `12.3`, `12`), else none.
pub fn cents(text: &str) -> Option<i64> {
    let (whole, fraction) = text.trim().split_once('.').unwrap_or((text.trim(), ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let fraction = format!("{fraction:0<2}");
    Some(whole.parse::<i64>().ok()? * 100 + fraction.parse::<i64>().ok()?)
}

/// Cents as an amount (`12.30`).
pub fn amount(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

/// A responsibility reason an operator may choose (the domain table, exported).
#[derive(Clone, Debug, Deserialize)]
pub struct Reason {
    pub code: String,
    pub responsibility: String,
    pub label: String,
}

/// A flow's responsibility reasons (chase-sets/chase-sets#10849).
pub fn reasons(flow_type: &str) -> &'static [Reason] {
    static TABLE: LazyLock<BTreeMap<String, Vec<Reason>>> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../support-responsibility-reasons.json"))
            .expect("support-responsibility-reasons.json is the export's output")
    });
    TABLE.get(flow_type).map_or(&[], Vec::as_slice)
}

/// A flow's title, from the API's flows.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct FlowTitle {
    pub flow_type: String,
    pub title: String,
}

#[derive(Deserialize)]
struct Flows {
    items: Vec<FlowTitle>,
}

/// What Escalate overdue did.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Escalation {
    pub escalated: u64,
    pub skipped: u64,
    pub capped: bool,
    pub total: u64,
}

/// The page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct QueueScreen {
    pub filters: Filters,
    pub queue: Queue,
    /// That the queue could not be read (admin-web's "Support operations API unavailable").
    pub unavailable: bool,
    /// The issue types, with the API's titles when it answered them.
    pub flows: Vec<FlowTitle>,
    pub escalation: Option<Escalation>,
    /// The selected request, or why it could not be read.
    pub selected: Option<Detail>,
    pub selected_failed: bool,
    /// What was just done to it, why a case action was refused, and whether the read is behind it.
    pub action: Option<String>,
    pub refusal: Option<String>,
    pub catching_up: bool,
    /// The marketplace's origin, for an order's purchase and sale pages.
    pub marketplace: Option<String>,
}

/// The marketplace's origin (`CHASE_SETS_MARKETPLACE_ORIGIN`), when configured.
fn marketplace() -> Option<String> {
    crate::reported::marketplace_origin().map(str::to_owned)
}

async fn queue(
    req: Req,
    Caller(staff): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Requests>,
) -> HtmlResult {
    let filters = Filters::read(&route.queue);
    let notice = &route.notice;
    let number = |value: &Option<String>| value.as_deref().and_then(|v| v.parse::<u64>().ok());
    let escalation = match (number(&notice.escalated), number(&notice.skipped)) {
        (Some(escalated), Some(skipped)) => Some(Escalation {
            escalated,
            skipped,
            capped: notice.capped.as_deref() == Some("true"),
            total: number(&notice.escalation_total).unwrap_or(0),
        }),
        _ => None,
    };
    let selected = notice.request_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let shown = Shown {
        selected,
        receipt: Receipt::from_param(notice.after_write.as_deref()),
        action: notice.action.clone(),
        refusal: None,
        escalation,
    };
    draw(&req, &staff.viewer, &config, &headers, filters, shown, StatusCode::OK).await
}

/// What the page shows besides the queue.
struct Shown<'a> {
    selected: Option<&'a str>,
    receipt: Option<Receipt>,
    action: Option<String>,
    refusal: Option<String>,
    escalation: Option<Escalation>,
}

async fn read_detail(caller: &ApiCaller<'_>, id: &str) -> Result<Detail, ApiError> {
    caller.read(&format!("{BASE}/ops/{}", segment(id)), CONTEXT).await
}

async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    filters: Filters,
    shown: Shown<'_>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, shown.receipt.as_ref());
    let queue_path = format!("{BASE}/ops?{}", filters.query());
    let flows_path = format!("{BASE}/flows");
    let detail = async {
        match shown.selected {
            Some(id) => Some(read_detail(&caller, id).await),
            None => None,
        }
    };
    let (queue, flows, detail) =
        tokio::join!(caller.read::<Queue>(&queue_path, CONTEXT), caller.read::<Flows>(&flows_path, CONTEXT), detail);
    let mut catching_up = false;
    let (queue, unavailable) = match queue {
        Ok(queue) => (queue, false),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => return read_failed(req, error, false),
        // The write's projection is not readable yet: the queue is read without it.
        Err(error) if shown.receipt.is_some() && error.catching_up() => {
            catching_up = true;
            let plain = config.platform.caller(headers, config.proto, None);
            match plain.read::<Queue>(&queue_path, CONTEXT).await {
                Ok(queue) => (queue, false),
                Err(_) => (Queue { items: Vec::new(), total: 0, count: 0 }, true),
            }
        }
        // admin-web shows the queue empty under its "unavailable" banner.
        Err(error) => {
            tracing::warn!("the support operations queue could not be read: {error}");
            (Queue { items: Vec::new(), total: 0, count: 0 }, true)
        }
    };
    let (selected, selected_failed) = match detail {
        None => (None, false),
        Some(Ok(detail)) => (Some(detail), false),
        Some(Err(error)) if shown.receipt.is_some() && error.catching_up() => {
            catching_up = true;
            let plain = config.platform.caller(headers, config.proto, None);
            match read_detail(&plain, shown.selected.unwrap_or_default()).await {
                Ok(detail) => (Some(detail), false),
                Err(_) => (None, true),
            }
        }
        Some(Err(error)) => {
            tracing::warn!("a support request could not be read: {error}");
            (None, true)
        }
    };
    let flows = match flows {
        Ok(flows) if !flows.items.is_empty() => flows.items,
        _ => FLOW_TYPES.iter().map(|f| FlowTitle { flow_type: (*f).to_owned(), title: (*f).to_owned() }).collect(),
    };
    let screen = QueueScreen {
        filters,
        queue,
        unavailable,
        flows,
        escalation: shown.escalation,
        selected,
        selected_failed,
        action: shown.action,
        refusal: shown.refusal,
        catching_up,
        marketplace: marketplace(),
    };
    let t: Sup = req.t();
    let title = match &screen.selected {
        Some(detail) => t.ops_detail_route_meta_title(detail.row.reference()).to_string(),
        None => t.ops_route_meta_title().to_owned(),
    };
    let view = html! { <views::RequestsPage t={t} p={req.t()} screen={&screen} now={SystemTime::now()} /> };
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

/// Escalate overdue: the API escalates up to 100 overdue requests, and the queue says how many.
async fn escalate_overdue(
    req: Req,
    Caller(staff): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Requests>,
) -> HtmlResult {
    let filters = Filters::read(&route.queue);
    let caller = config.platform.caller(&headers, config.proto, None);
    let request = caller.request(Method::POST, &format!("{BASE}/ops/escalate-overdue"), CONTEXT).json(&json!({ "limit": 100 }));
    match caller.write::<Value>(request).await {
        Ok((answer, receipt)) => {
            let count = |key: &str| answer[key].as_u64().unwrap_or(0).to_string();
            let notice = url::Notice {
                after_write: receipt.map(|r| r.param()),
                escalated: Some(count("escalated")),
                skipped: Some(count("skipped")),
                capped: Some(answer["capped"].as_bool().unwrap_or(false).to_string()),
                escalation_total: Some(count("total")),
                ..url::Notice::default()
            };
            req.redirect(&url::Requests { queue: filters.at(None, None), notice })
        }
        Err(error) => match refused(&req, error) {
            Refused::Page(refusal, status) => {
                let shown = Shown { selected: None, receipt: None, action: None, refusal: Some(refusal), escalation: None };
                draw(&req, &staff.viewer, &config, &headers, filters, shown, status).await
            }
            Refused::Answer(answer) => answer,
        },
    }
}

/// admin-web's request page is its sheet over the queue.
async fn request(req: Req, Caller(_): Caller<Staff<SupportManage>>, Params(route): Params<url::Request<'_>>) -> HtmlResult {
    let filters = Filters::read(&route.queue);
    let notice = url::Notice { request_id: Some(route.id.to_string()), ..url::Notice::default() };
    req.redirect(&url::Requests { queue: filters.at(None, None), notice })
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
            let t: Sup = req.t();
            let message = error.refusal().unwrap_or(t.ops_detail_route_request_failed()).to_owned();
            let status = match status {
                StatusCode::CONFLICT | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => status,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            Refused::Page(message, status)
        }
        _ => Refused::Answer(Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))),
    }
}

/// A case action's fields (admin-web's form names).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct ActionForm {
    pub intent: String,
    pub summary: String,
    pub response_type: String,
    pub reason: String,
    pub resolution_type: String,
    pub refund_amount: String,
    pub responsibility_finding: String,
    pub evidence_basis_type: String,
}

impl ActionForm {
    /// The API call an intent makes, and the action the sheet then reports; none for an intent
    /// admin-web does not know.
    fn call(&self, id: &str) -> Option<(String, Value, &'static str)> {
        let at = format!("{BASE}/ops/{}", segment(id));
        Some(match self.intent.as_str() {
            "note" => (format!("{at}/evidence"), json!({ "evidenceType": "support-note", "summary": self.summary }), "note"),
            "response" => {
                (format!("{at}/responses"), json!({ "responseType": self.response_type, "summary": self.summary }), "response")
            }
            "escalate" => (format!("{at}/escalate"), json!({ "reason": self.reason }), "escalate"),
            "resolve" => {
                let (responsibility, code) =
                    self.responsibility_finding.split_once('|').unwrap_or((&self.responsibility_finding, ""));
                // admin-web's evidence basis references.
                let reference = if self.evidence_basis_type == "insufficient-evidence" {
                    "support-workbench.insufficient-evidence.v1"
                } else {
                    "support-workbench.operator-adjudication.v1"
                };
                let refund = Some(self.refund_amount.as_str()).filter(|a| !a.is_empty());
                (
                    format!("{at}/resolve"),
                    json!({
                        "resolutionType": self.resolution_type,
                        "summary": self.summary,
                        "refundAmount": refund,
                        "responsibility": responsibility,
                        "evidenceBasis": { "type": self.evidence_basis_type, "reference": reference },
                        "responsibilityReasonCode": code,
                    }),
                    "resolve",
                )
            }
            "close" => (format!("{at}/close"), json!({}), "close"),
            "cancel" => (format!("{at}/cancel"), json!({ "reason": self.reason }), "cancel"),
            _ => return None,
        })
    }
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Request<'_>>,
    Form(form): Form<ActionForm>,
) -> HtmlResult {
    let id: &str = &route.id;
    let filters = Filters::read(&route.queue);
    let back = |action: Option<&str>, after_write: Option<String>| url::Requests {
        queue: filters.at(None, None),
        notice: url::Notice {
            request_id: Some(id.to_owned()),
            action: action.map(str::to_owned),
            after_write,
            ..url::Notice::default()
        },
    };
    // admin-web does nothing for an intent it does not know (the remedy intents are not ported).
    let Some((path, body, done)) = form.call(id) else { return req.redirect(&back(None, None)) };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.write::<Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        Ok((_, receipt)) => req.redirect(&back(Some(done), receipt.map(|r| r.param()))),
        Err(error) => match refused(&req, error) {
            Refused::Page(refusal, status) => {
                let shown = Shown { selected: Some(id), receipt: None, action: None, refusal: Some(refusal), escalation: None };
                draw(&req, &staff.viewer, &config, &headers, filters, shown, status).await
            }
            Refused::Answer(answer) => answer,
        },
    }
}

/// An evidence photo, as the API sends it to staff.
async fn attachment(
    _req: Req,
    Caller(_): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Attachment<'_>>,
) -> corten::Result<Relay> {
    let path = format!("{BASE}/{}/attachments/{}", segment(&route.id), segment(&route.attachment));
    let caller = config.platform.caller(&headers, config.proto, None);
    let res = caller
        .request(Method::GET, &path, CONTEXT)
        .send()
        .await
        .map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(corten::Error::status(StatusCode::FORBIDDEN)),
        404 => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        status => {
            tracing::warn!("a support attachment answered {status}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    }
    let mut kept = HeaderMap::new();
    for name in ["content-type", "content-length", "cache-control", "etag"] {
        if let Some(value) = res.headers().get(name).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
            kept.insert(HeaderName::from_static(name), value);
        }
    }
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}

/// A private evidence photo's id, from its reference (`support-attachment:v1:{id}:{sha256}:{ext}`).
pub fn attachment_id(reference: &str) -> Option<&str> {
    let mut parts = reference.strip_prefix("support-attachment:v1:")?.split(':');
    let id = parts.next()?;
    let sha = parts.next()?;
    let ext = parts.next()?;
    let ok = id.starts_with("sea_")
        && id.len() > 4
        && id[4..].bytes().all(|b| b.is_ascii_alphanumeric())
        && sha.len() == 64
        && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && matches!(ext, "jpg" | "png" | "webp")
        && parts.next().is_none();
    ok.then_some(id)
}

/// A deadline's countdown (admin-web's `countdownParts`): whether it has passed, and how long in
/// whole minutes, hours (under two days) or days, rounded up.
pub fn countdown(due: SystemTime, now: SystemTime) -> (bool, u64, &'static str) {
    let (overdue, delta) = match due.duration_since(now) {
        Ok(left) => (false, left),
        Err(past) => (true, past.duration()),
    };
    let minutes = delta.as_millis().div_ceil(60_000).max(1) as u64;
    if minutes < 60 {
        return (overdue, minutes, if minutes == 1 { "minute" } else { "minutes" });
    }
    let hours = minutes.div_ceil(60);
    if hours < 48 {
        return (overdue, hours, if hours == 1 { "hour" } else { "hours" });
    }
    let days = hours.div_ceil(24);
    (overdue, days, if days == 1 { "day" } else { "days" })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn amounts_are_read_and_written_in_cents() {
        assert_eq!(cents("56.83"), Some(5683));
        assert_eq!(cents("12.3"), Some(1230));
        assert_eq!(cents("12"), Some(1200));
        assert_eq!(cents("1.234"), None);
        assert_eq!(cents("-1"), None);
        assert_eq!(amount(1230), "12.30");
    }

    #[test]
    fn a_countdown_rounds_up_to_its_largest_unit() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(countdown(now + Duration::from_secs(30), now), (false, 1, "minute"));
        assert_eq!(countdown(now + Duration::from_secs(61 * 60), now), (false, 2, "hours"));
        assert_eq!(countdown(now - Duration::from_secs(3 * 86_400), now), (true, 3, "days"));
    }

    #[test]
    fn only_a_private_reference_has_an_attachment_id() {
        let sha = "b".repeat(64);
        assert_eq!(attachment_id(&format!("support-attachment:v1:sea_01J9:{sha}:png")), Some("sea_01J9"));
        assert_eq!(attachment_id("https://example.test/photo.png"), None);
        assert_eq!(attachment_id(&format!("support-attachment:v1:sea_01J9:{sha}:gif")), None);
    }
}
