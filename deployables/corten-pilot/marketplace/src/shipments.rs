//! The account's shipments (Fulfillment's `account-shipments`, `account-shipment` and
//! `account-sale-shipment`): the buyer's shipments, each one's page, and each shipment's page as
//! its seller sees it. The seller's list is marketplace's command center, which marketplace builds
//! from Fulfillment's rules in its own loader; the API does not serve it yet
//! (chase-sets/chase-sets#10638), so `/account/sales/shipments` sends the seller there. A
//! shipment's packing is the pilot's (`packing`); its other actions (labels, dispatch, delivery,
//! returns, exceptions) are not ported: the seller's page links to marketplace's for them.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/shipments` | the buyer's shipments (the first 100, as marketplace reads them) |
//! | `GET /account/shipments/{id}` | a shipment the buyer is sent |
//! | `GET /account/sales/shipments` | 303 to marketplace's command center |
//! | `GET /account/sales/shipments/{id}` | a shipment the seller sends, with its postage diagnostics, read after the write whose receipt it carries |
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Serialize;

use platform::receipt::Receipt;

use crate::{
    api::{ApiError, ShipmentDetail, ShipmentList, Shipments as _, Side},
    app::{Shared, read_failed},
    auth::{Shipper, Viewer},
    text::ShipmentsMsg,
    views::{self, Layout},
};

/// The buyer's list: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ListScreen {
    pub shipments: ShipmentList,
}

/// A shipment's page.
#[derive(Serialize, ToJson)]
pub struct ShipmentScreen {
    pub side: Side,
    pub shipment: ShipmentDetail,
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
        html! { <Layout req={&req} viewer={Some(&viewer)} title={t.shipments_shipments_marketplace()} head="">{view}</Layout> },
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
    shipment(&req, &viewer, &config, &headers, Side::Buyer, &id, None).await
}

pub(crate) async fn sale(
    req: Req,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::SaleShipment<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, route.after);
    let receipt = Receipt::from_param(after.after_write.as_deref());
    shipment(&req, &viewer, &config, &headers, Side::Seller, &id, receipt).await
}

/// The seller's list is marketplace's command center (chase-sets/chase-sets#10638).
pub(crate) async fn command_center(req: Req, Caller(Shipper(_)): Caller<Shipper>) -> HtmlResult {
    match views::marketplace("/account/sales/shipments") {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// A shipment's page; after a write (`receipt`), read after it, and while the read is behind the
/// page says so and reads itself again.
async fn shipment(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    side: Side,
    id: &str,
    receipt: Option<Receipt>,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let shipment = match caller.shipment(side, id).await {
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
    let screen = ShipmentScreen { side, shipment };
    let t: ShipmentsMsg = req.t();
    let title = match side {
        Side::Buyer => t.shipment_shipment_marketplace(),
        Side::Seller => t.sale_shipment_sale_shipment_marketplace(),
    };
    let view = html! { <views::ShipmentPage t={t} p={req.t()} viewer={viewer} screen={&screen} /> };
    req.screen(&screen, html! { <Layout req={req} viewer={Some(viewer)} title={title} head="">{view}</Layout> })
}

/// A read that failed: a 404 is the error page's Not found (marketplace's "Shipment not found."),
/// else as every read.
fn shipment_failed(req: &Req, viewer: &Viewer, error: ApiError) -> HtmlResult {
    if error.status() == Some(StatusCode::NOT_FOUND) {
        return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
    }
    read_failed(req, Some(viewer), error, None)
}
