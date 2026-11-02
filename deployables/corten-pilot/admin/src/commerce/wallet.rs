//! Commerce > Wallet Workbench (admin-web's `/commerce/wallet-workbench/:accountId`, Settlement's
//! `SettlementWalletWorkbenchPage`): an account's wallet balance, the guided credit or debit (preview,
//! then confirm and submit), the adjustment history with Approve, Reject and Reverse, and the ledger.
//! Read from and written to Settlement's `/api/settlement/wallet-adjustments` as the signed-in staff
//! member: reading needs `wallet-adjustments.view`, and each command its own permission (`create`,
//! `approve` or `reverse`), which the API checks again with its recent sign-in rule.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /commerce/wallet-workbench/{id}?accountName&status&adjustmentsOffset&ledgerOffset` | the page |
//! | `POST /commerce/wallet-workbench/{id}` | a command (`intent`), then the page with what it did |
//!
//! Each command answers with the page and the command's own snapshot of the adjustment, as
//! admin-web's action does (Settlement's write-recovery contract: the page never waits on the
//! adjustment projection). The page is read with the write's receipt; an adjustment the lists have
//! not caught up to is drawn from its snapshot under the "Projection catching up" note. A refused
//! command draws the page again with the form as it was sent and the refusal where it was made.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{ApiError, Method, segment},
    app::{Shared, sign_in},
    auth::{Staff, Viewer, WalletAccess},
    text::Com,
};

const CONTEXT: &str = "settlement";
const BASE: &str = "/api/settlement/wallet-adjustments";
/// admin-web's page size, and the most a page may ask for.
const LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 100;

/// The command permissions (`WALLET_ADJUSTMENT_PERMISSIONS`).
pub const VIEW: &str = "wallet-adjustments.view";
pub const CREATE: &str = "wallet-adjustments.create";
pub const APPROVE: &str = "wallet-adjustments.approve";
pub const REVERSE: &str = "wallet-adjustments.reverse";

/// The commands' intents (`WALLET_ADJUSTMENT_FORM_INTENTS`).
pub const PREVIEW: &str = "preview-adjustment";
pub const REQUEST: &str = "request-adjustment";
pub const APPROVE_INTENT: &str = "approve-adjustment";
pub const REJECT_INTENT: &str = "reject-adjustment";
pub const REVERSE_INTENT: &str = "reverse-adjustment";

/// The history's status filters, in admin-web's order (`all` is none).
pub const STATUSES: [&str; 6] = ["all", "requested", "approved", "rejected", "posted", "reversed"];

/// The reason codes, in admin-web's order (`WALLET_ADJUSTMENT_REASON_CODES`).
pub const REASONS: [&str; 10] = [
    "transaction-correction",
    "refund-correction",
    "fee-correction",
    "dispute-resolution",
    "fraud-recovery",
    "support-resolution",
    "legal-obligation",
    "goodwill-cash-credit",
    "operational-error",
    "other-with-required-detail",
];

/// The one reason whose explanation the API requires.
pub const DETAIL_REQUIRED: &str = "other-with-required-detail";

#[corten::routes(state = crate::app::Shared, area = Workbench, caller = crate::auth::Staff<crate::auth::WalletAccess>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// What the page shows: the account's name (admin-web's links carry it), the history's
    /// status filter, and where each list starts.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct View {
        #[serde(rename = "accountName")]
        pub account_name: Option<String>,
        pub status: Option<String>,
        #[serde(rename = "adjustmentsOffset")]
        pub adjustments_offset: Option<u32>,
        #[serde(rename = "adjustmentsLimit")]
        pub adjustments_limit: Option<u32>,
        #[serde(rename = "ledgerOffset")]
        pub ledger_offset: Option<u32>,
        #[serde(rename = "ledgerLimit")]
        pub ledger_limit: Option<u32>,
    }

    /// The area's prefix: the workbench is always an account's.
    #[route("/commerce/wallet-workbench")]
    pub struct Workbench;

    /// An account's workbench; a `POST` is a command.
    #[route("/commerce/wallet-workbench/{id}", get = crate::commerce::wallet::page, post = crate::commerce::wallet::act)]
    pub struct Wallet<'a> {
        pub id: &'a str,
        #[route(query)]
        pub view: View,
    }
}

impl url::View {
    /// The status filter, when it is one the API knows (`all` and anything else are none).
    pub fn status(&self) -> Option<&str> {
        self.status.as_deref().filter(|s| *s != "all" && STATUSES.contains(s))
    }

    fn limit(value: Option<u32>) -> u32 {
        value.filter(|l| *l >= 1).map_or(LIMIT, |l| l.min(MAX_LIMIT))
    }

    pub fn adjustments(&self) -> (u32, u32) {
        (Self::limit(self.adjustments_limit), self.adjustments_offset.unwrap_or(0))
    }

    pub fn ledger(&self) -> (u32, u32) {
        (Self::limit(self.ledger_limit), self.ledger_offset.unwrap_or(0))
    }

    /// The same view with the history filtered by `status` from its first page.
    pub fn filtered(&self, status: &str) -> Self {
        url::View {
            account_name: self.account_name.clone(),
            status: (status != "all").then(|| status.to_owned()),
            ..url::View::default()
        }
    }

    /// The same view with the history starting at `offset`.
    pub fn adjustments_at(&self, offset: u32) -> Self {
        url::View { adjustments_offset: (offset > 0).then_some(offset), ..self.clone() }
    }

    /// The same view with the ledger starting at `offset`.
    pub fn ledger_at(&self, offset: u32) -> Self {
        url::View { ledger_offset: (offset > 0).then_some(offset), ..self.clone() }
    }
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Workbench>, shared: Shared) -> Area<url::Workbench> {
    url::area(area, shared).components(views::WALLET)
}

/// An account's wallet (`SettlementWalletRow`); amounts are decimal text.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Wallet {
    pub account_id: String,
    pub currency_code: String,
    pub pending_balance_amount: String,
    pub available_balance_amount: String,
    pub total_credited_amount: String,
    pub total_debited_amount: String,
    pub negative_balance_status: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// A Wallet Adjustment (`SettlementWalletAdjustmentRow`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Adjustment {
    pub adjustment_id: String,
    pub status: String,
    pub target_account_id: String,
    pub direction: String,
    pub amount: String,
    pub currency_code: String,
    pub reason_code: String,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub evidence_references: Vec<String>,
    #[serde(default)]
    pub reversal_of_adjustment_id: Option<String>,
    #[serde(default)]
    pub reversed_by_adjustment_id: Option<String>,
    pub requested_by: String,
    pub requested_at: String,
    #[serde(default)]
    pub approved_by: Option<String>,
    #[serde(default)]
    pub rejected_by: Option<String>,
    #[serde(default)]
    pub elevation_required: bool,
    #[serde(default)]
    pub posted_at: Option<String>,
    #[serde(default)]
    pub available_balance_after: Option<String>,
}

/// A ledger entry (`SettlementLedgerEntryRow`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Entry {
    pub ledger_entry_id: String,
    pub kind: String,
    pub direction: String,
    pub amount: String,
    pub currency_code: String,
    #[serde(default)]
    pub order_id: Option<String>,
    #[serde(default)]
    pub payout_id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub posted_at: String,
}

/// What a credit or debit would do (`WalletAdjustmentPreview`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Preview {
    pub direction: String,
    pub amount: String,
    pub currency_code: String,
    pub reason_code: String,
    pub balance_revision: String,
    pub available_balance_before: String,
    pub available_balance_after: String,
    pub spendable: bool,
    pub payoutable: bool,
    pub creates_or_increases_negative_balance: bool,
    #[serde(default)]
    pub blocked_reason: Option<String>,
    pub requires_second_approval: bool,
    #[serde(default)]
    pub elevation_reasons: Vec<String>,
}

#[derive(Deserialize)]
struct List<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
    #[serde(default)]
    total: Option<u64>,
}

#[derive(Deserialize)]
struct Reversed {
    original: Adjustment,
    reversal: Adjustment,
}

/// Every command's fields (admin-web's form names). The related references are one comma-separated
/// field, where admin-web's tag input sends one field each.
#[derive(Clone, Debug, Deserialize, Serialize, Fields, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CommandForm {
    pub intent: String,
    pub direction: String,
    pub amount: String,
    pub reason_code: String,
    pub explanation: String,
    pub evidence_references: String,
    pub expected_balance_revision: String,
    pub adjustment_id: String,
    pub elevation_approved_by_user_id: String,
    pub approved_by_user_id: String,
    pub rejection_reason: String,
}

impl Default for CommandForm {
    /// admin-web's starting values: a credit for a transaction correction.
    fn default() -> Self {
        CommandForm {
            intent: String::new(),
            direction: "credit".to_owned(),
            amount: String::new(),
            reason_code: REASONS[0].to_owned(),
            explanation: String::new(),
            evidence_references: String::new(),
            expected_balance_revision: String::new(),
            adjustment_id: String::new(),
            elevation_approved_by_user_id: String::new(),
            approved_by_user_id: String::new(),
            rejection_reason: String::new(),
        }
    }
}

impl CommandForm {
    /// The direction as admin-web reads it: anything but `debit` is a credit.
    pub fn direction(&self) -> &'static str {
        if self.direction == "debit" { "debit" } else { "credit" }
    }

    /// The reason as admin-web reads it: an unknown one is a transaction correction.
    pub fn reason(&self) -> &'static str {
        REASONS.iter().find(|r| **r == self.reason_code.trim()).copied().unwrap_or(REASONS[0])
    }

    /// The related references: each comma-separated entry, trimmed, the empty ones left out.
    pub fn references(&self) -> Vec<String> {
        self.evidence_references.split(',').map(str::trim).filter(|r| !r.is_empty()).map(str::to_owned).collect()
    }
}

/// `optionalText`: the text trimmed, or null when it is empty.
fn optional(text: &str) -> Value {
    match text.trim() {
        "" => Value::Null,
        text => Value::String(text.to_owned()),
    }
}

/// The body admin-web's action sends for `form` on account `id`: where it goes and what it carries.
pub fn command(id: &str, form: &CommandForm) -> Option<(String, Value)> {
    let adjustment = || format!("{BASE}/{}", segment(form.adjustment_id.trim()));
    Some(match form.intent.as_str() {
        PREVIEW => (
            format!("{BASE}/preview"),
            json!({ "targetAccountId": id, "direction": form.direction(), "amount": form.amount, "reasonCode": form.reason() }),
        ),
        REQUEST => {
            let mut body = json!({
                "targetAccountId": id,
                "direction": form.direction(),
                "amount": form.amount,
                "reasonCode": form.reason(),
                "explanation": optional(&form.explanation),
                "evidenceReferences": form.references(),
            });
            if let Value::String(revision) = optional(&form.expected_balance_revision) {
                body["expectedBalanceRevision"] = Value::String(revision);
            }
            (BASE.to_owned(), body)
        }
        APPROVE_INTENT => {
            let body = match optional(&form.elevation_approved_by_user_id) {
                Value::String(user) => json!({ "elevationApprovedByUserId": user }),
                _ => json!({}),
            };
            (format!("{}/approve", adjustment()), body)
        }
        REJECT_INTENT => (format!("{}/reject", adjustment()), json!({ "rejectionReason": optional(&form.rejection_reason) })),
        REVERSE_INTENT => (
            format!("{}/reverse", adjustment()),
            json!({
                "approvedByUserId": form.approved_by_user_id,
                "elevationApprovedByUserId": form.elevation_approved_by_user_id,
                "explanation": optional(&form.explanation),
            }),
        ),
        _ => return None,
    })
}

/// The permission a command needs.
pub fn needs(intent: &str) -> Option<&'static str> {
    match intent {
        PREVIEW | REQUEST => Some(CREATE),
        APPROVE_INTENT | REJECT_INTENT => Some(APPROVE),
        REVERSE_INTENT => Some(REVERSE),
        _ => None,
    }
}

/// Why a command was not done, in the closed set admin-web's `describeWalletAdjustmentFlowError`
/// draws (`WalletAdjustmentFlowErrorKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Validation,
    StalePreview,
    StepUpRequired,
    RequiresElevatedApproval,
    SelfBenefitingBlocked,
    NotFound,
    Forbidden,
    AuthenticationRequired,
    Conflict,
    Unknown,
}

impl corten::ToJson for Kind {
    fn write_json(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(serde_json::to_string(self).unwrap_or_else(|_| "null".to_owned()).as_bytes());
    }
}

/// A refused command: its kind, the API's message, and each field the API named.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Refusal {
    pub kind: Kind,
    pub message: String,
    pub fields: Vec<String>,
    #[serde(skip)]
    pub status: Option<StatusCode>,
}

#[derive(Default, Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: ErrorDetail,
}

#[derive(Default, Deserialize)]
struct ErrorDetail {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Vec<Detail>,
}

#[derive(Default, Deserialize)]
struct Detail {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: String,
}

/// `describeWalletAdjustmentFlowError`: the kind, by the API's code, its details' codes, and, for
/// the two refusals that have no code of their own, the message's words, as admin-web matches them
/// (chase-sets/chase-sets#10892: until the API gives them codes; then match the codes).
fn classify(status: StatusCode, body: ErrorBody, fallback: &str) -> Refusal {
    let ErrorDetail { code, message, details } = body.error;
    let has = |wanted: &str| details.iter().any(|d| d.code.as_deref() == Some(wanted));
    let conflict = status == StatusCode::CONFLICT;
    let kind = match code.as_deref() {
        Some("step_up_required") => Kind::StepUpRequired,
        _ if has("stale_balance_revision") => Kind::StalePreview,
        _ if conflict && message.contains("elevated approval") => Kind::RequiresElevatedApproval,
        _ if conflict && message.contains("self-benefiting") => Kind::SelfBenefitingBlocked,
        Some("validation_failed") => Kind::Validation,
        Some("not_found") => Kind::NotFound,
        Some("authorization_forbidden") => Kind::Forbidden,
        Some("authentication_required") => Kind::AuthenticationRequired,
        Some("conflict") => Kind::Conflict,
        _ if conflict => Kind::Conflict,
        _ => Kind::Unknown,
    };
    let fields = if kind == Kind::Validation {
        details.into_iter().map(|d| d.message).filter(|m| !m.is_empty()).collect()
    } else {
        Vec::new()
    };
    let message = if message.is_empty() { fallback.to_owned() } else { message };
    Refusal { kind, message, fields, status: Some(status) }
}

/// Sends a command: its answer and the receipt the next read waits for, or why it was refused.
async fn send<T: DeserializeOwned>(req: RequestBuilder, fallback: &str) -> Result<(T, Option<Receipt>), Refusal> {
    let unknown = |error: &dyn std::fmt::Display| {
        tracing::warn!("a wallet adjustment command failed: {error}");
        Refusal { kind: Kind::Unknown, message: fallback.to_owned(), fields: Vec::new(), status: None }
    };
    let res = req.send().await.map_err(|e| unknown(&e))?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if status.is_success() {
        let receipt = Receipt::from_response(res.headers());
        return res.json::<T>().await.map(|answer| (answer, receipt)).map_err(|e| unknown(&e));
    }
    let body: ErrorBody = res.json().await.unwrap_or_default();
    if status.is_server_error() && status != StatusCode::SERVICE_UNAVAILABLE {
        return Err(unknown(&format!("platform API {status}: {:?} {}", body.error.code, body.error.message)));
    }
    Err(classify(status, body, fallback))
}

/// What the last command did: its intent and adjustment, the snapshots it answered with, or why it
/// was refused.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
pub struct Outcome {
    pub intent: String,
    pub adjustment_id: Option<String>,
    pub refusal: Option<Refusal>,
}

/// The page as drawn.
#[derive(Serialize, ToJson)]
pub struct WalletScreen {
    pub account_id: String,
    pub view: ViewState,
    pub wallet: Wallet,
    pub adjustments: Vec<Adjustment>,
    pub adjustments_total: u64,
    pub ledger: Vec<Entry>,
    pub ledger_total: u64,
    /// The request form, as sent when a preview or a request was refused or previewed, else new.
    pub form: CommandForm,
    pub preview: Option<Preview>,
    pub outcome: Option<Outcome>,
    /// That an adjustment the last command answered with is not in the history yet, or not as it
    /// is now: it is drawn from the command's snapshot.
    pub catching_up: bool,
    pub can_create: bool,
    pub can_approve: bool,
    pub can_reverse: bool,
    pub user_id: String,
    pub marketplace: Option<String>,
}

/// The view's parts the page draws (its links are made from the route's view).
#[derive(Clone, Debug, Default, Serialize, ToJson)]
pub struct ViewState {
    pub account_name: Option<String>,
    pub status: Option<String>,
    pub adjustments_limit: u32,
    pub adjustments_offset: u32,
    pub ledger_limit: u32,
    pub ledger_offset: u32,
}

impl WalletScreen {
    /// The route's view, for the page's links.
    pub fn route_view(&self) -> url::View {
        let v = &self.view;
        url::View {
            account_name: v.account_name.clone(),
            status: v.status.clone(),
            adjustments_offset: (v.adjustments_offset > 0).then_some(v.adjustments_offset),
            adjustments_limit: (v.adjustments_limit != LIMIT).then_some(v.adjustments_limit),
            ledger_offset: (v.ledger_offset > 0).then_some(v.ledger_offset),
            ledger_limit: (v.ledger_limit != LIMIT).then_some(v.ledger_limit),
        }
    }

    /// The name the page calls the account by: the one its link carried, or its ID.
    pub fn label(&self) -> &str {
        self.view.account_name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&self.account_id)
    }
}

/// What a read of the page found.
struct Found {
    wallet: Wallet,
    adjustments: List<Adjustment>,
    ledger: List<Entry>,
}

async fn read(
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    view: &url::View,
    receipt: Option<&Receipt>,
) -> Result<Found, ApiError> {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let account = format!("{BASE}/accounts/{}", segment(id));
    let wallet: Wallet = caller.read(&format!("{account}/summary"), CONTEXT).await?;
    let (limit, offset) = view.adjustments();
    let mut query = format!("limit={limit}&offset={offset}");
    if let Some(status) = view.status() {
        query.push_str(&format!("&status={status}"));
    }
    let (ledger_limit, ledger_offset) = view.ledger();
    let (history, entries) =
        (format!("{account}/adjustments?{query}"), format!("{account}/ledger?limit={ledger_limit}&offset={ledger_offset}"));
    let (adjustments, ledger) =
        tokio::try_join!(caller.read::<List<Adjustment>>(&history, CONTEXT), caller.read::<List<Entry>>(&entries, CONTEXT))?;
    Ok(Found { wallet, adjustments, ledger })
}

/// The page when the wallet cannot be shown: not found, not allowed, or not answering.
fn missing(req: &Req, viewer: &Viewer, id: &str, error: ApiError) -> HtmlResult {
    let t: Com = req.t();
    let (status, title, description) = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(StatusCode::NOT_FOUND) => {
            (StatusCode::NOT_FOUND, t.ww_account_not_found_title(), t.ww_account_not_found_description(id).to_string())
        }
        Some(StatusCode::FORBIDDEN) => {
            (StatusCode::FORBIDDEN, t.ww_permission_denied_title(), t.ww_permission_denied_description().to_owned())
        }
        _ => {
            tracing::warn!("the wallet workbench could not be read: {error}");
            (StatusCode::BAD_GATEWAY, t.ww_unavailable_title(), t.ww_unavailable_description().to_owned())
        }
    };
    let view = html! { <views::WalletMissing t={t} title={title} description={&description} /> };
    req.screen_with_status(
        status,
        &json!({ "status": status.as_u16() }),
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.ww_route_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// What a draw shows besides the lists: the form, the preview, the last command and its snapshots.
#[derive(Default)]
struct Shown {
    form: CommandForm,
    preview: Option<Preview>,
    outcome: Option<Outcome>,
    snapshots: Vec<Adjustment>,
    receipt: Option<Receipt>,
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    view: &url::View,
    shown: Shown,
    status: StatusCode,
) -> HtmlResult {
    let found = match read(config, headers, id, view, shown.receipt.as_ref()).await {
        Ok(found) => found,
        Err(error) if shown.receipt.is_some() && error.catching_up() => match read(config, headers, id, view, None).await {
            Ok(found) => found,
            Err(error) => return missing(req, viewer, id, error),
        },
        Err(error) => return missing(req, viewer, id, error),
    };
    let Found { wallet, adjustments, ledger } = found;
    let adjustments_total = adjustments.total.unwrap_or(adjustments.items.len() as u64);
    let ledger_total = ledger.total.unwrap_or(ledger.items.len() as u64);
    let (items, catching_up) = merge(adjustments.items, shown.snapshots);
    let (adjustments_limit, adjustments_offset) = view.adjustments();
    let (ledger_limit, ledger_offset) = view.ledger();
    let screen = WalletScreen {
        account_id: id.to_owned(),
        view: ViewState {
            account_name: view.account_name.clone(),
            status: view.status().map(str::to_owned),
            adjustments_limit,
            adjustments_offset,
            ledger_limit,
            ledger_offset,
        },
        wallet,
        adjustments: items,
        adjustments_total,
        ledger: ledger.items,
        ledger_total,
        form: shown.form,
        preview: shown.preview,
        outcome: shown.outcome,
        catching_up,
        can_create: viewer.can(CREATE),
        can_approve: viewer.can(APPROVE),
        can_reverse: viewer.can(REVERSE),
        user_id: viewer.user_id.clone(),
        marketplace: crate::app::marketplace_origin().map(str::to_owned),
    };
    let t: Com = req.t();
    let title = match &screen.view.account_name {
        Some(name) if !name.trim().is_empty() => t.ww_wallet_for_account(name).to_string(),
        _ => t.ww_wallet_workbench().to_owned(),
    };
    let page = html! { <views::WalletPage t={t} screen={&screen} title={&title} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.ww_route_title()} head="">
                {page}
            </crate::views::Layout>
        },
    )
}

/// The history with the command's snapshots in it: each in place of the row it is newer than, or
/// first when the list has no row for it yet (admin-web's `staleSnapshots`). Whether any was missing
/// or older in the list.
fn merge(mut items: Vec<Adjustment>, snapshots: Vec<Adjustment>) -> (Vec<Adjustment>, bool) {
    let mut ahead = Vec::new();
    let mut catching_up = false;
    for snapshot in snapshots {
        match items.iter_mut().find(|i| i.adjustment_id == snapshot.adjustment_id) {
            Some(row) if row.status != snapshot.status => {
                *row = snapshot;
                catching_up = true;
            }
            Some(_) => {}
            None => {
                ahead.push(snapshot);
                catching_up = true;
            }
        }
    }
    ahead.extend(items);
    (ahead, catching_up)
}

pub(crate) async fn page(
    req: Req,
    Caller(staff): Caller<Staff<WalletAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Wallet<'_>>,
) -> HtmlResult {
    draw(&req, &staff.viewer, &config, &headers, &route.id, &route.view, Shown::default(), StatusCode::OK).await
}

/// The page's status for a refusal: the API's for a refusal the operator can act on (a bad field is
/// 422), else 502.
fn refused_status(refusal: &Refusal) -> StatusCode {
    match refusal.status {
        Some(StatusCode::BAD_REQUEST) => StatusCode::UNPROCESSABLE_ENTITY,
        Some(status) if status.is_client_error() => status,
        Some(StatusCode::SERVICE_UNAVAILABLE) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// The message a command's failure falls back to.
fn fallback(t: Com, intent: &str) -> &'static str {
    match intent {
        PREVIEW => t.ww_preview_could_not_be_generated(),
        REQUEST => t.ww_adjustment_could_not_be_submitted(),
        APPROVE_INTENT => t.ww_approval_could_not_be_completed(),
        REJECT_INTENT => t.ww_rejection_could_not_be_completed(),
        _ => t.ww_reversal_could_not_be_completed(),
    }
}

pub(crate) async fn act(
    req: Req,
    Caller(staff): Caller<Staff<WalletAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Wallet<'_>>,
    Form(form): Form<CommandForm>,
) -> HtmlResult {
    let (id, view, viewer) = (&route.id, &route.view, &staff.viewer);
    let t: Com = req.t();
    let Some(permission) = needs(&form.intent) else {
        return Err(corten::Error::status(StatusCode::UNPROCESSABLE_ENTITY));
    };
    if !viewer.can(permission) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let Some((path, body)) = command(id, &form) else {
        return Err(corten::Error::status(StatusCode::UNPROCESSABLE_ENTITY));
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let request = caller.request(Method::POST, &path, CONTEXT).json(&body);
    let intent = form.intent.clone();
    let fallback = fallback(t, &intent);
    let adjustment_id = (!matches!(intent.as_str(), PREVIEW | REQUEST)).then(|| form.adjustment_id.trim().to_owned());
    let done = |snapshots: Vec<Adjustment>, receipt: Option<Receipt>, form: CommandForm| Shown {
        form,
        outcome: Some(Outcome { intent: intent.clone(), adjustment_id: adjustment_id.clone(), refusal: None }),
        snapshots,
        receipt,
        ..Shown::default()
    };
    let shown = match intent.as_str() {
        PREVIEW => match send::<Preview>(request, fallback).await {
            Ok((preview, _)) => Shown { form, preview: Some(preview), ..Shown::default() },
            Err(refusal) => return refuse(&req, viewer, &config, &headers, id, view, form, intent, None, refusal).await,
        },
        REVERSE_INTENT => match send::<Reversed>(request, fallback).await {
            Ok((reversed, receipt)) => done(vec![reversed.original, reversed.reversal], receipt, CommandForm::default()),
            Err(refusal) => {
                let form = CommandForm { explanation: String::new(), ..CommandForm::default() };
                return refuse(&req, viewer, &config, &headers, id, view, form, intent, adjustment_id, refusal).await;
            }
        },
        _ => match send::<Adjustment>(request, fallback).await {
            Ok((snapshot, receipt)) => done(vec![snapshot], receipt, CommandForm::default()),
            Err(refusal) => {
                // A refused request keeps what was sent, as admin-web's form keeps its values.
                let kept = if intent == REQUEST { form } else { CommandForm::default() };
                return refuse(&req, viewer, &config, &headers, id, view, kept, intent, adjustment_id, refusal).await;
            }
        },
    };
    draw(&req, viewer, &config, &headers, id, view, shown, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn refuse(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    view: &url::View,
    form: CommandForm,
    intent: String,
    adjustment_id: Option<String>,
    refusal: Refusal,
) -> HtmlResult {
    // A session that ended signs in again; a session that is too old for this command (step-up)
    // keeps the page and offers a new sign-in in another tab, as admin-web does.
    if refusal.kind == Kind::AuthenticationRequired {
        return sign_in(req);
    }
    let status = refused_status(&refusal);
    let outcome = Outcome { intent, adjustment_id, refusal: Some(refusal) };
    draw(req, viewer, config, headers, id, view, Shown { form, outcome: Some(outcome), ..Shown::default() }, status).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bodies_are_admin_webs() {
        let form = CommandForm {
            intent: REQUEST.into(),
            direction: "sideways".into(),
            amount: "12.50".into(),
            reason_code: DETAIL_REQUIRED.into(),
            explanation: "  goodwill  ".into(),
            evidence_references: " ord_1, ,sup_2 ".into(),
            expected_balance_revision: "rev_9".into(),
            ..CommandForm::default()
        };
        let (path, body) = command("acc_1", &form).unwrap();
        assert_eq!(path, BASE);
        assert_eq!(
            body,
            json!({ "targetAccountId": "acc_1", "direction": "credit", "amount": "12.50", "reasonCode": DETAIL_REQUIRED,
                "explanation": "goodwill", "evidenceReferences": ["ord_1", "sup_2"], "expectedBalanceRevision": "rev_9" })
        );
        let (path, body) =
            command("acc_1", &CommandForm { intent: PREVIEW.into(), reason_code: "nope".into(), ..form.clone() }).unwrap();
        assert_eq!(path, format!("{BASE}/preview"));
        assert_eq!(body["reasonCode"], "transaction-correction", "an unknown reason is admin-web's default");
        assert_eq!(body.get("explanation"), None);

        let approve = CommandForm { intent: APPROVE_INTENT.into(), adjustment_id: "wad_1".into(), ..CommandForm::default() };
        assert_eq!(command("acc_1", &approve).unwrap(), (format!("{BASE}/wad_1/approve"), json!({})));
        let elevated = CommandForm { elevation_approved_by_user_id: " usr_2 ".into(), ..approve.clone() };
        assert_eq!(command("acc_1", &elevated).unwrap().1, json!({ "elevationApprovedByUserId": "usr_2" }));
        let reject = CommandForm { intent: REJECT_INTENT.into(), ..approve.clone() };
        assert_eq!(command("acc_1", &reject).unwrap(), (format!("{BASE}/wad_1/reject"), json!({ "rejectionReason": null })));
        let reverse = CommandForm {
            intent: REVERSE_INTENT.into(),
            approved_by_user_id: "usr_2".into(),
            elevation_approved_by_user_id: "usr_3".into(),
            ..approve
        };
        assert_eq!(
            command("acc_1", &reverse).unwrap().1,
            json!({ "approvedByUserId": "usr_2", "elevationApprovedByUserId": "usr_3", "explanation": null })
        );
        assert_eq!(command("acc_1", &CommandForm { intent: "teleport".into(), ..CommandForm::default() }), None);
    }

    #[test]
    fn refusals_are_classified_as_admin_web_classifies_them() {
        let body = |code: Option<&str>, message: &str, details: &[&str]| ErrorBody {
            error: ErrorDetail {
                code: code.map(str::to_owned),
                message: message.to_owned(),
                details: details.iter().map(|c| Detail { code: Some((*c).to_owned()), message: format!("{c}!") }).collect(),
            },
        };
        let kind = |status: StatusCode, b: ErrorBody| classify(status, b, "fallback").kind;
        assert_eq!(kind(StatusCode::UNAUTHORIZED, body(Some("step_up_required"), "Sign in again.", &[])), Kind::StepUpRequired);
        assert_eq!(kind(StatusCode::CONFLICT, body(Some("conflict"), "stale", &["stale_balance_revision"])), Kind::StalePreview);
        assert_eq!(
            kind(
                StatusCode::CONFLICT,
                body(Some("conflict"), "This Wallet Adjustment requires a second, elevated approval.", &[])
            ),
            Kind::RequiresElevatedApproval
        );
        assert_eq!(
            kind(StatusCode::CONFLICT, body(Some("conflict"), "A self-benefiting Wallet Adjustment is blocked outright.", &[])),
            Kind::SelfBenefitingBlocked
        );
        assert_eq!(kind(StatusCode::NOT_FOUND, body(Some("not_found"), "Gone.", &[])), Kind::NotFound);
        assert_eq!(kind(StatusCode::FORBIDDEN, body(Some("authorization_forbidden"), "No.", &[])), Kind::Forbidden);
        assert_eq!(kind(StatusCode::TOO_MANY_REQUESTS, body(Some("limit"), "Too many.", &[])), Kind::Unknown);
        let refusal = classify(StatusCode::BAD_REQUEST, body(Some("validation_failed"), "", &["invalid_amount"]), "fallback");
        assert_eq!(
            (refusal.kind, refusal.message.as_str(), refusal.fields),
            (Kind::Validation, "fallback", vec!["invalid_amount!".to_owned()])
        );
    }

    #[test]
    fn a_snapshot_replaces_its_older_row_or_goes_first() {
        let row = |id: &str, status: &str| Adjustment {
            adjustment_id: id.into(),
            status: status.into(),
            target_account_id: "acc_1".into(),
            direction: "credit".into(),
            amount: "1.00".into(),
            currency_code: "USD".into(),
            reason_code: REASONS[0].into(),
            explanation: None,
            evidence_references: Vec::new(),
            reversal_of_adjustment_id: None,
            reversed_by_adjustment_id: None,
            requested_by: "usr_1".into(),
            requested_at: "2026-10-31T00:00:00.000Z".into(),
            approved_by: None,
            rejected_by: None,
            elevation_required: false,
            posted_at: None,
            available_balance_after: None,
        };
        let (items, catching_up) = merge(vec![row("wad_1", "requested")], vec![row("wad_1", "requested")]);
        assert_eq!((items.len(), catching_up), (1, false));
        let (items, catching_up) =
            merge(vec![row("wad_1", "requested")], vec![row("wad_1", "posted"), row("wad_2", "requested")]);
        assert!(catching_up);
        assert_eq!(
            items.iter().map(|i| (i.adjustment_id.as_str(), i.status.as_str())).collect::<Vec<_>>(),
            [("wad_2", "requested"), ("wad_1", "posted")]
        );
    }

    #[test]
    fn the_view_keeps_admin_webs_bounds() {
        let view = url::View {
            adjustments_limit: Some(500),
            ledger_limit: Some(0),
            status: Some("bogus".into()),
            ..url::View::default()
        };
        assert_eq!(view.adjustments(), (100, 0));
        assert_eq!(view.ledger(), (20, 0));
        assert_eq!(view.status(), None);
        assert_eq!(url::View { status: Some("posted".into()), ..url::View::default() }.status(), Some("posted"));
    }
}
