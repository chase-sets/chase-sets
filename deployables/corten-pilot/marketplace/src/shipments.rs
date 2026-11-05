//! The account's shipments (Fulfillment's `account-shipments`, `account-shipment` and
//! `account-sale-shipment`): the buyer's shipments, each one's page, and each shipment's page as
//! its seller sees it. The seller's list is the command center (`command_center`); its packing is
//! the packing page's (`packing`).
//!
//! The seller acts on a shipment from its page too: buys its label (with the service, the
//! addresses, why they changed and the package), voids it, dispatches, records delivery or a
//! return, raises an exception, or cancels it. Which of those the page offers is the API's action
//! plan for the shipment, the one the command center draws; the shipment's own read does not carry
//! it yet (https://github.com/chase-sets/chase-sets/issues/11002), so the page reads it from the
//! command center, and a shipment the command center leaves out keeps its link to marketplace.
//! Each action is recovered as packing's writes are (`packing`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/shipments` | the buyer's shipments (the first 100, as marketplace reads them) |
//! | `GET /account/shipments/{id}` | a shipment the buyer is sent |
//! | `GET /account/sales/shipments/{id}` | a shipment the seller sends, with its postage diagnostics and actions, read after the write whose receipt it carries |
//! | `POST /account/sales/shipments/{id}` | the action `intent` on the shipment, then its page |
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::{Deserialize, Serialize};

use platform::receipt::Receipt;

use crate::{
    api::{
        ActionFields, ActionPlan, ApiError, CommandCenter, LabelAddress, LabelPurchase, ShipmentAction, ShipmentCommands as _,
        ShipmentDetail, ShipmentList, Shipments as _, Side,
    },
    app::{Shared, read_failed, sign_in, url},
    auth::{Shipper, Viewer},
    packing::{Failed, Outcome, check, failed},
    recovery::attempt_text,
    text::ShipmentsMsg,
    views::{self, Layout},
};

/// What a seller's shipment page's address carries: the last write's receipt (`after_write`),
/// the attempt that answer settles (`done`) and an attempt to ask the API about (`check`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct SalePlace {
    pub after_write: Option<String>,
    pub done: Option<String>,
    pub check: Option<String>,
}

/// An action's form on the shipment's page: its attempt, the action (the button pressed), Raise
/// exception's type and notes, Record return's reason, and Buy label's fields. An address or the
/// package is sent only when its fields are in the form, as marketplace's `hasAddressInput` reads
/// it; a letter's form has neither.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ActionInput {
    pub attempt: Option<SubmitKey>,
    pub intent: Option<ShipmentAction>,
    pub exception_type: String,
    pub notes: String,
    pub reason: String,
    pub service_level: String,
    pub override_reason: String,
    pub sender_name: Option<String>,
    pub sender_company: Option<String>,
    pub sender_street1: Option<String>,
    pub sender_street2: Option<String>,
    pub sender_city: Option<String>,
    pub sender_state: Option<String>,
    pub sender_postal_code: Option<String>,
    pub sender_country: Option<String>,
    pub sender_phone: Option<String>,
    pub sender_email: Option<String>,
    pub recipient_name: Option<String>,
    pub recipient_company: Option<String>,
    pub recipient_street1: Option<String>,
    pub recipient_street2: Option<String>,
    pub recipient_city: Option<String>,
    pub recipient_state: Option<String>,
    pub recipient_postal_code: Option<String>,
    pub recipient_country: Option<String>,
    pub recipient_phone: Option<String>,
    pub recipient_email: Option<String>,
    pub package_length_inches: Option<String>,
    pub package_width_inches: Option<String>,
    pub package_height_inches: Option<String>,
    pub package_weight_ounces: Option<String>,
}

impl ActionInput {
    /// The label the form asks for.
    pub fn label(&self) -> LabelPurchase {
        let sender = address([
            &self.sender_name,
            &self.sender_company,
            &self.sender_street1,
            &self.sender_street2,
            &self.sender_city,
            &self.sender_state,
            &self.sender_postal_code,
            &self.sender_country,
            &self.sender_phone,
            &self.sender_email,
        ]);
        let recipient = address([
            &self.recipient_name,
            &self.recipient_company,
            &self.recipient_street1,
            &self.recipient_street2,
            &self.recipient_city,
            &self.recipient_state,
            &self.recipient_postal_code,
            &self.recipient_country,
            &self.recipient_phone,
            &self.recipient_email,
        ]);
        let sizes =
            [&self.package_length_inches, &self.package_width_inches, &self.package_height_inches, &self.package_weight_ounces];
        let package = sizes.iter().any(|v| v.is_some()).then(|| sizes.map(|v| v.clone().unwrap_or_default()));
        LabelPurchase {
            service_level: self.service_level.clone(),
            sender,
            recipient,
            override_reason: self.override_reason.clone(),
            package,
        }
    }
}

/// An address from its ten fields, in `LabelAddress`'s order, when any is in the form.
fn address(fields: [&Option<String>; 10]) -> Option<LabelAddress> {
    if fields.iter().all(|f| f.is_none()) {
        return None;
    }
    let [name, company, street1, street2, city, state, postal_code, country, phone, email] =
        fields.map(|f| f.clone().unwrap_or_default());
    Some(LabelAddress { name, company, street1, street2, city, state, postal_code, country, phone, email })
}

/// The buyer's list: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ListScreen {
    pub shipments: ShipmentList,
}

/// A shipment's page: for its seller, the actions its state allows (none when the command center
/// leaves it out) and what the page says about the last action.
#[derive(Serialize, ToJson)]
pub struct ShipmentScreen {
    pub side: Side,
    pub shipment: ShipmentDetail,
    pub plan: Option<ActionPlan>,
    pub outcome: Outcome,
    /// The form a refused action sent, so the page keeps what the seller typed.
    #[serde(skip)]
    pub sent: Option<ActionInput>,
}

pub(crate) async fn purchases(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let shipments = match caller.shipments(Side::Buyer).await {
        Ok(shipments) => shipments,
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    let screen = ListScreen { shipments };
    let t: ShipmentsMsg = req.t();
    let view = html! { <views::ShipmentList t={t} p={req.t()} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <Layout req={&req} viewer={Some(&viewer)} title={t.shipments_shipments_marketplace()} head="">
                {view}
            </Layout>
        },
    )
}

pub(crate) async fn purchase(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::shipments::Shipment<'_>>,
) -> HtmlResult {
    let id = route.id;
    let view = View { outcome: Outcome::Ready, sent: None, status: StatusCode::OK };
    shipment(&req, &viewer, &config, &headers, Side::Buyer, &id, None, view).await
}

pub(crate) async fn sale(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::SaleShipment<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id.as_str(), route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let outcome = match (&place.check, &place.done) {
        (Some(attempt), _) => check(&config.platform.caller(&headers, config.proto, None), id, attempt).await,
        (None, Some(done)) => Outcome::Applied(done.clone()),
        (None, None) => Outcome::Ready,
    };
    let view = View { outcome, sent: None, status: StatusCode::OK };
    shipment(&req, &viewer, &config, &headers, Side::Seller, id, receipt, view).await
}

/// The action `intent` on the shipment: applied, its page read after it; refused, the page with
/// why and what was typed; unconfirmed, the page asking the API about it.
pub(crate) async fn act(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::sale_shipments::SaleShipment<'_>>,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let id = route.id.as_str();
    let attempt = attempt_text(&input.attempt).to_owned();
    let t: ShipmentsMsg = req.t();
    // Packing's two are the packing page's; an action the pilot does not know is not sent.
    let action = input
        .intent
        .filter(|a| !matches!(a, ShipmentAction::StartPacking | ShipmentAction::CompletePacking | ShipmentAction::Other));
    let refused = |message: String, input: ActionInput| View {
        outcome: Outcome::Refused { attempt: attempt.clone(), message },
        sent: Some(input),
        status: StatusCode::UNPROCESSABLE_ENTITY,
    };
    let Some(action) = action else {
        let view = refused(t.sales_route_action_failed().to_owned(), input);
        return shipment(&req, &viewer, &config, &headers, Side::Seller, id, None, view).await;
    };
    let fields = ActionFields {
        exception_type: input.exception_type.clone(),
        notes: input.notes.clone(),
        reason: input.reason.clone(),
        label: (action == ShipmentAction::BuyLabel).then(|| input.label()),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.shipment_action(id, action, &fields, &attempt).await {
        Ok(receipt) => applied(&req, id, &attempt, receipt),
        Err(error) => match failed(&caller, id, &attempt, error).await {
            Failed::AppliedBefore => applied(&req, id, &attempt, None),
            Failed::Refused(message) => {
                let view = refused(message, input);
                shipment(&req, &viewer, &config, &headers, Side::Seller, id, None, view).await
            }
            Failed::Uncertain => {
                let place = SalePlace { check: Some(attempt.clone()), ..SalePlace::default() };
                req.redirect(&url::SaleShipment { id, place })
            }
            Failed::SignIn => sign_in(&req),
            Failed::Unknown(error) => Err(error),
        },
    }
}

/// The shipment's page after an applied action: read after its receipt, saying it settles
/// `attempt`.
fn applied(req: &Req, id: &str, attempt: &str, receipt: Option<Receipt>) -> HtmlResult {
    let place = SalePlace { after_write: receipt.map(|r| r.param()), done: Some(attempt.to_owned()), check: None };
    req.redirect(&url::SaleShipment { id, place })
}

/// What the page says about the last action, the form a refused one sent, and the answer's status.
struct View {
    outcome: Outcome,
    sent: Option<ActionInput>,
    status: StatusCode,
}

/// The shipment's action plan, from the command center until the shipment's read carries it
/// (https://github.com/chase-sets/chase-sets/issues/11002): none when the command center leaves the
/// shipment out (dispatched and finished shipments) or cannot be read.
fn plan(center: Result<CommandCenter, ApiError>, id: &str) -> Option<ActionPlan> {
    match center {
        Ok(center) => center.buckets.into_iter().flat_map(|b| b.items).find(|item| item.shipment_id == id).map(|item| item.plan),
        Err(error) => {
            tracing::warn!("the command center read for a shipment's actions failed: {error}");
            None
        }
    }
}

/// A shipment's page; after a write (`receipt`), read after it, and while the read is behind the
/// page says so and reads itself again. The seller's page also reads the command center, for the
/// shipment's actions.
#[allow(clippy::too_many_arguments)]
async fn shipment(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    side: Side,
    id: &str,
    receipt: Option<Receipt>,
    view: View,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let (read, center) = match side {
        Side::Buyer => (caller.shipment(side, id).await, None),
        Side::Seller => {
            let (read, center) = tokio::join!(caller.shipment(side, id), caller.command_center());
            (read, Some(center))
        }
    };
    let shipment = match read {
        Ok(shipment) => shipment,
        Err(error) if receipt.is_some() && error.catching_up() => {
            let t: ShipmentsMsg = req.t();
            let head = html! { <ReadAgain after={std::time::Duration::from_secs(2)} /> };
            let view = html! { <views::ShipmentPending t={t} /> };
            let title = t.sale_shipment_sale_shipment_marketplace();
            return req.page(html! { <Layout req={req} viewer={Some(viewer)} title={title} head={head}>{view}</Layout> });
        }
        Err(error) => return shipment_failed(req, viewer, error),
    };
    let plan = center.and_then(|center| plan(center, id));
    let View { outcome, sent, status } = view;
    let screen = ShipmentScreen { side, shipment, plan, outcome, sent };
    let t: ShipmentsMsg = req.t();
    let title = match side {
        Side::Buyer => t.shipment_shipment_marketplace(),
        Side::Seller => t.sale_shipment_sale_shipment_marketplace(),
    };
    let view = html! { <views::ShipmentPage t={t} p={req.t()} viewer={viewer} screen={&screen} /> };
    let page = html! { <Layout req={req} viewer={Some(viewer)} title={title} head="">{view}</Layout> };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// A read that failed: a 404 is the error page's Not found (marketplace's "Shipment not found."),
/// else as every read.
fn shipment_failed(req: &Req, viewer: &Viewer, error: ApiError) -> HtmlResult {
    if error.status() == Some(StatusCode::NOT_FOUND) {
        return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
    }
    read_failed(req, Some(viewer), error, None)
}
