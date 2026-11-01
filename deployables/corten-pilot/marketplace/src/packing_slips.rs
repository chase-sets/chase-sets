//! Packing slips to print (Fulfillment's `account-sale-shipment-packing-slips`): the seller's
//! shipments `shipmentIds` names, one slip per page in US letter or 4x6 thermal, with the format
//! chooser and Print above them. Opened in a new tab from a shipment's page and its packing page.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/sales/shipments/packing-slips?shipmentIds=..&format=..` | the slips, or 400 (marketplace's "No shipments selected.") when none is named |
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Serialize;

use crate::chrome::Chrome;
use crate::{
    api::{ShipmentDetail, Shipments as _},
    app::{Shared, read_failed, url::PackingSlips},
    auth::Shipper,
    text::ShipmentsMsg,
    views::{self, Layout},
};

/// The slips' paper (`FulfillmentPackingSlipFormat`): anything else asked for is letter.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum Format {
    #[default]
    #[serde(rename = "letter")]
    Letter,
    #[serde(rename = "thermal-4x6")]
    Thermal,
}

impl Format {
    pub fn read(text: Option<&str>) -> Self {
        match text {
            Some("thermal-4x6") => Format::Thermal,
            _ => Format::Letter,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Letter => "letter",
            Format::Thermal => "thermal-4x6",
        }
    }
}

/// The shipments asked for (`parseShipmentIds`): every `shipmentIds` value split at commas,
/// trimmed, blanks left out and each id once, in the order first named.
pub fn shipment_ids(values: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in values.iter().flat_map(|v| v.split(',')).map(str::trim).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// A shipment's slip in letter, as the shipment's page and its packing page open it.
pub fn href(shipment: &str) -> String {
    PackingSlips { shipment_ids: &[shipment], format: Some(Format::Letter.as_str()) }.href()
}

/// What the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct SlipsScreen {
    pub format: Format,
    pub slips: Vec<ShipmentDetail>,
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<PackingSlips<'_>>,
) -> HtmlResult {
    let t: ShipmentsMsg = req.t();
    let title = t.slips_route_packing_slips_marketplace();
    let ids = shipment_ids(&route.shipment_ids);
    if ids.is_empty() {
        let view = views::failed(title, t.slips_route_no_shipments_selected());
        let cart = chrome.cart().await;
        return req.page_with_status(
            StatusCode::BAD_REQUEST,
            html! { <Layout req={&req} viewer={Some(&viewer)} cart={cart} title={title} head="">{view}</Layout> },
        );
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let slips = match caller.packing_slips(&ids).await {
        Ok(batch) => batch.items,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let screen = SlipsScreen { format: Format::read(route.format.as_deref()), slips };
    let view = html! { <views::PackingSlipsPage t={t} screen={&screen} /> };
    let cart = chrome.cart().await;
    req.screen(&screen, html! { <Layout req={&req} viewer={Some(&viewer)} cart={cart} title={title} head="">{view}</Layout> })
}
