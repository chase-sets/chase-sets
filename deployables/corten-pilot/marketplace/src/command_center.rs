//! The seller's shipment command center (Fulfillment's `account-sale-shipments`): the shipments
//! that need the seller now, in the API's buckets and order, each with the one next action its
//! stored state allows and the others under More actions. The Fulfillment API builds all of it
//! (`GET account/sales/shipments/command-center`) and decides each action against the shipment's
//! stored state, not the state the page was drawn with; the page draws it and posts which
//! shipment and which action.
//!
//! Each action carries its attempt (the form's `SubmitKey`) as the `Idempotency-Key`, and is
//! recovered as packing's writes are (`packing`): a refusal asks the API what came of the attempt;
//! the page's script remembers it, per shipment, before it is sent; and a page that finds a record
//! it does not settle asks the API about it (`check`, `shipment`). While the API cannot say, the
//! page's writes are off. Packing's two actions open the packing page, which keeps its checklist.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/sales/shipments` | the command center, read after the write whose receipt it carries |
//! | `POST /account/sales/shipments` | the action `intent` on `shipment`, then the command center |
use std::time::Duration;

use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{ActionFields, CommandCenter, ShipmentAction, ShipmentCommands as _},
    app::{Shared, read_failed, sign_in, url},
    auth::{Shipper, Viewer},
    packing::{Failed, Outcome, check, failed},
    recovery::attempt_text,
    text::ShipmentsMsg,
    views::{self, Layout},
};

/// What the command center's address carries: the last write's receipt (`after_write`), the
/// attempt that answer settles (`done`), an attempt to ask the API about (`check`), and the
/// shipment either is on (`shipment`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub done: Option<String>,
    pub check: Option<String>,
    pub shipment: Option<String>,
}

/// An action's form: its attempt, the shipment, the action (the button pressed), and Raise
/// exception's type and notes.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ActionInput {
    pub attempt: Option<SubmitKey>,
    pub shipment: String,
    pub intent: Option<ShipmentAction>,
    pub exception_type: String,
    pub notes: String,
}

/// The command center (none while it is catching up with a write), the receipt of the last
/// write, what the page says about it and the shipment it was on.
#[derive(Serialize, ToJson)]
pub struct CenterScreen {
    pub center: Option<CommandCenter>,
    pub after_write: Option<String>,
    pub outcome: Outcome,
    pub shipment: String,
}

pub(crate) async fn page(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::SaleShipments>,
) -> HtmlResult {
    let place = route.place;
    let shipment = place.shipment.clone().unwrap_or_default();
    let caller = config.platform.caller(&headers, config.proto, None);
    let outcome = match (&place.check, &place.done) {
        (Some(attempt), _) if !shipment.is_empty() => check(&caller, &shipment, attempt).await,
        (Some(attempt), _) => Outcome::Uncertain(attempt.clone()),
        (None, Some(done)) => Outcome::Applied(done.clone()),
        (None, None) => Outcome::Ready,
    };
    render(&req, &viewer, &config, &headers, place.after_write, outcome, shipment, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    after_write: Option<String>,
    outcome: Outcome,
    shipment: String,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let center = match caller.command_center().await {
        Ok(center) => Some(center),
        // The write's projection is not readable yet: the page says so and reads itself again.
        Err(error) if receipt.is_some() && error.catching_up() => None,
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let pending = center.is_none();
    let screen = CenterScreen { center, after_write, outcome, shipment };
    let t: ShipmentsMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::CommandCenterPage t={t} p={req.t()} viewer={viewer} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.sales_route_sale_shipments_marketplace()} head={head}>
            {view}
        </Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// The command center after an applied action: read after its receipt, saying it settles
/// `attempt` on `shipment`.
fn applied(req: &Req, shipment: &str, attempt: &str, receipt: Option<Receipt>) -> HtmlResult {
    let place = Place {
        after_write: receipt.map(|r| r.param()),
        done: Some(attempt.to_owned()),
        check: None,
        shipment: Some(shipment.to_owned()),
    };
    req.redirect(&url::SaleShipments { place })
}

pub(crate) async fn act(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<ActionInput>,
) -> HtmlResult {
    let attempt = attempt_text(&input.attempt).to_owned();
    let shipment = input.shipment.trim().to_owned();
    let refuse = |message: String| Outcome::Refused { attempt: attempt.clone(), message };
    let t: ShipmentsMsg = req.t();
    // Packing's two are the packing page's; an action the pilot does not know is not sent.
    let action = input
        .intent
        .filter(|a| !matches!(a, ShipmentAction::StartPacking | ShipmentAction::CompletePacking | ShipmentAction::Other));
    let Some(action) = action.filter(|_| !shipment.is_empty()) else {
        let outcome = refuse(t.sales_route_action_failed().to_owned());
        return render(&req, &viewer, &config, &headers, None, outcome, shipment, StatusCode::UNPROCESSABLE_ENTITY).await;
    };
    let fields = ActionFields { exception_type: input.exception_type, notes: input.notes, ..ActionFields::default() };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.shipment_action(&shipment, action, &fields, &attempt).await {
        Ok(receipt) => applied(&req, &shipment, &attempt, receipt),
        Err(error) => match failed(&caller, &shipment, &attempt, error).await {
            Failed::AppliedBefore => applied(&req, &shipment, &attempt, None),
            Failed::Refused(message) => {
                let outcome = refuse(message);
                render(&req, &viewer, &config, &headers, None, outcome, shipment, StatusCode::UNPROCESSABLE_ENTITY).await
            }
            Failed::Uncertain => {
                let place = Place { check: Some(attempt.clone()), shipment: Some(shipment), ..Place::default() };
                req.redirect(&url::SaleShipments { place })
            }
            Failed::SignIn => sign_in(&req),
            Failed::Unknown(error) => Err(error),
        },
    }
}
