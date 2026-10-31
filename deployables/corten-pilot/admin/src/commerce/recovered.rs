//! Commerce > Recovered Returns (admin-web's `/commerce/recovered-items`, Inventory's
//! `RecoveredItemsPage`): the items Facility intake handed to Inventory, their figures and recovered
//! value, and one form that records a custody or disposition action on an item by its ID. Read from
//! and written to Inventory's `/api/inventory/recovered-items` as the signed-in staff member:
//! reading needs `recovered-inventory.view`, writing `recovered-inventory.manage` (evidence
//! references show only with `recovered-inventory.evidence`, which the API applies).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /commerce/recovered-items?item&status&after_write` | the page, with what the last action did |
//! | `POST /commerce/recovered-items` | an action (`intent`: one of nine), then the page |
//!
//! The form posts what admin-web's does, field for field, so the API's answer is the same. A
//! refused action draws the page again with the form as it was sent, as admin-web's form keeps its
//! values.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{ApiError, Method, segment},
    app::{Shared, sign_in},
    auth::{RecoveredAccess, Staff, Viewer},
    text::{Com, Pilot},
};

const CONTEXT: &str = "inventory";
const BASE: &str = "/api/inventory/recovered-items";

/// The actions, in admin-web's order.
pub const INTENTS: [&str; 9] = [
    "identify",
    "inspect",
    "require-authenticity-review",
    "complete-authenticity-review",
    "record-authority",
    "decide-disposition",
    "record-value",
    "correct-source",
    "merge",
];

#[corten::routes(state = crate::app::Shared, area = crate::commerce::recovered::url::Recovered, caller = crate::auth::Staff<crate::auth::RecoveredAccess>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// What the last action did: the item, its status, and the write's receipt.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct Done {
        pub item: Option<String>,
        pub status: Option<String>,
        #[serde(rename = "after_write")]
        pub after_write: Option<String>,
    }

    /// The page; a `POST` is an action.
    #[derive(Clone, Debug, Default)]
    #[route("/commerce/recovered-items", get = page, post = act)]
    pub struct Recovered {
        #[route(query)]
        pub done: Done,
    }
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Recovered>, shared: Shared) -> Area<url::Recovered> {
    url::area(area, shared).components(views::RECOVERED)
}

/// A recovered item (`InventoryRecoveredItemRow`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Item {
    pub recovered_item_id: String,
    pub status: String,
    pub custody_identifier: String,
    #[serde(default)]
    pub catalog_item_id: Option<String>,
    #[serde(default)]
    pub condition_grade: Option<String>,
    #[serde(default)]
    pub disposition: Option<String>,
    pub received_at: String,
    #[serde(default)]
    pub evidence_references: Vec<String>,
}

/// The page's figures (`RecoveredItemMetrics`); amounts are decimal text.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
pub struct Metrics {
    pub unidentified_count: u64,
    pub quarantined_count: u64,
    pub sellable_count: u64,
    pub terminal_count: u64,
    pub recovery_rate: f64,
    pub average_age_hours: f64,
    pub gross_value: String,
    pub disposition_cost: String,
    pub net_recovered_value: String,
}

#[derive(Deserialize)]
struct List {
    items: Vec<Item>,
}

/// An action's fields (admin-web's form names).
#[derive(Clone, Debug, Default, Deserialize, Serialize, Fields, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ActionForm {
    pub recovered_item_id: String,
    pub intent: String,
    pub policy_version: String,
    pub evidence_references: String,
    pub catalog_item_id: String,
    pub product_id: String,
    pub condition_grade: String,
    pub outcome: String,
    pub review_reference: String,
    pub legal_owner: String,
    pub authority_kind: String,
    pub allowed_dispositions: String,
    pub disposition: String,
    pub target_account_id: String,
    pub storage_location_id: String,
    pub reason_code: String,
    pub recovery_id: String,
    pub recovery_type: String,
    pub gross_amount: String,
    pub cost_amount: String,
    pub currency_code: String,
    pub corrected_return_shipment_id: String,
    pub canonical_recovered_item_id: String,
}

impl ActionForm {
    /// A new form: admin-web's one default, the currency.
    pub fn new() -> Self {
        ActionForm { currency_code: "USD".to_owned(), ..ActionForm::default() }
    }
}

/// A comma-separated field as its entries (admin-web's `csv`).
fn csv(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned).collect()
}

/// The body admin-web's action sends for `form`: every field, whatever the intent, with the reason
/// taken from the reason code field and no selected options.
pub fn body(form: &ActionForm) -> Value {
    json!({
        "intent": form.intent,
        "policyVersion": form.policy_version,
        "evidenceReferences": csv(&form.evidence_references),
        "catalogItemId": form.catalog_item_id,
        "productId": form.product_id,
        "selectedOptions": [],
        "conditionGrade": form.condition_grade,
        "outcome": form.outcome,
        "reviewReference": form.review_reference,
        "legalOwner": form.legal_owner,
        "authorityKind": form.authority_kind,
        "allowedDispositions": csv(&form.allowed_dispositions),
        "disposition": form.disposition,
        "targetAccountId": form.target_account_id,
        "storageLocationId": form.storage_location_id,
        "reasonCode": form.reason_code,
        "reason": form.reason_code,
        "recoveryId": form.recovery_id,
        "recoveryType": form.recovery_type,
        "grossAmount": form.gross_amount,
        "costAmount": form.cost_amount,
        "currencyCode": form.currency_code,
        "correctedReturnShipmentId": form.corrected_return_shipment_id,
        "canonicalRecoveredItemId": form.canonical_recovered_item_id,
    })
}

/// The page as drawn.
#[derive(Serialize, ToJson)]
pub struct RecoveredScreen {
    pub items: Vec<Item>,
    pub metrics: Metrics,
    /// The form, as sent when an action was refused, else new.
    pub form: ActionForm,
    /// Why the last action was not recorded.
    pub error: Option<String>,
    /// The item the last action was recorded on, and its status after it.
    pub done: Option<(String, Option<String>)>,
    /// That the page was read without the write's receipt, which it had not caught up to.
    pub catching_up: bool,
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<RecoveredAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Recovered>,
) -> HtmlResult {
    let done = route.done;
    let receipt = Receipt::from_param(done.after_write.as_deref());
    let finished = done.item.filter(|i| !i.trim().is_empty()).map(|item| (item, done.status.filter(|s| !s.trim().is_empty())));
    draw(&req, &staff.viewer, &config, &headers, receipt, ActionForm::new(), None, finished, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    receipt: Option<Receipt>,
    form: ActionForm,
    error: Option<String>,
    done: Option<(String, Option<String>)>,
    status: StatusCode,
) -> HtmlResult {
    let metrics_path = format!("{BASE}/metrics");
    let read = |receipt: Option<&Receipt>| {
        let caller = config.platform.caller(headers, config.proto, receipt);
        let metrics_path = metrics_path.as_str();
        async move { tokio::try_join!(caller.read::<List>(BASE, CONTEXT), caller.read::<Metrics>(metrics_path, CONTEXT)) }
    };
    let mut catching_up = false;
    let (list, metrics) = match read(receipt.as_ref()).await {
        Ok(found) => found,
        Err(error) if receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match read(None).await {
                Ok(found) => found,
                Err(error) => return crate::app::read_failed(req, error, false),
            }
        }
        Err(error) => return crate::app::read_failed(req, error, false),
    };
    let screen = RecoveredScreen { items: list.items, metrics, form, error, done, catching_up };
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let view = html! { <views::RecoveredPage t={t} p={p} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.rr_route_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// What the page says when the API refuses an action, and its status.
fn refusal(t: Com, error: &ApiError) -> (String, StatusCode) {
    match error.status() {
        Some(status) if status.is_client_error() => {
            let status = if status == StatusCode::CONFLICT { status } else { StatusCode::UNPROCESSABLE_ENTITY };
            (error.refusal().unwrap_or(t.rr_action_failed()).to_owned(), status)
        }
        _ => {
            tracing::warn!("a recovered item action failed: {error}");
            (t.rr_action_failed().to_owned(), StatusCode::BAD_GATEWAY)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recorded {
    recovered_item_id: String,
    #[serde(default)]
    status: Option<String>,
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<RecoveredAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<ActionForm>,
) -> HtmlResult {
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let refused = |form: ActionForm, message: String, status: StatusCode| {
        draw(&req, &staff.viewer, &config, &headers, None, form, Some(message), None, status)
    };
    if !INTENTS.contains(&form.intent.as_str()) {
        return refused(form, t.rr_action_unknown().to_owned(), StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let id = form.recovered_item_id.trim().to_owned();
    if id.is_empty() {
        return refused(form, p.check_required().to_owned(), StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let request = caller.request(Method::POST, &format!("{BASE}/{}/actions", segment(&id)), CONTEXT).json(&body(&form));
    match caller.write::<Recorded>(request).await {
        Ok((recorded, receipt)) => {
            let done = url::Done {
                item: Some(recorded.recovered_item_id),
                status: recorded.status,
                after_write: receipt.map(|r| r.param()),
            };
            req.redirect(&url::Recovered { done })
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
        Err(error) => {
            let (message, status) = refusal(t, &error);
            refused(form, message, status).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_is_admin_webs() {
        let form = ActionForm {
            recovered_item_id: "rci_1".into(),
            intent: "correct-source".into(),
            evidence_references: " ev_1, ,ev_2 ".into(),
            allowed_dispositions: "resell,dispose".into(),
            reason_code: "wrong-shipment".into(),
            ..ActionForm::new()
        };
        let sent = body(&form);
        assert_eq!(sent["evidenceReferences"], json!(["ev_1", "ev_2"]));
        assert_eq!(sent["allowedDispositions"], json!(["resell", "dispose"]));
        assert_eq!(sent["reason"], "wrong-shipment");
        assert_eq!(sent["reasonCode"], "wrong-shipment");
        assert_eq!(sent["selectedOptions"], json!([]));
        assert_eq!(sent["currencyCode"], "USD");
        assert_eq!(sent.get("recoveredItemId"), None, "the item is in the path");
    }
}
