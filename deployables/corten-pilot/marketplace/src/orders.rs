//! The account's orders (Ordering's `account-purchases`, `account-purchase`, `account-sales` and
//! `account-sale`): a page of the account's purchases or sales, each one's page, and Cancel on it
//! while it is still open. A cancellation redirects to the order's page with its receipt, which
//! reads after it; a page that has not caught up yet says so and reads again.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/purchases?limit=..&offset=..` | a page of the buyer's purchases |
//! | `GET /account/purchases/{id}?after_write=..` | a purchase |
//! | `POST /account/purchases/{id}/cancel` | cancel it, then its page |
//! | `GET /account/sales?limit=..&offset=..` | a page of the seller's sales |
//! | `GET /account/sales/{id}?after_write=..` | a sale |
//! | `POST /account/sales/{id}/cancel` | cancel it, then its page |
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{ApiError, OrderDetail, OrderList, Orders as _, Side},
    app::{Config, ORDERS_MANAGE, Shared, read_failed, sign_in, url},
    auth::{OrderBuyer, OrderSeller, Viewer},
    cart::AfterWrite,
    text::{OrdersMsg, Pilot},
    views::{self, Layout},
};

/// A page's length when the address names none (`orderListPage`'s `DEFAULT_LIMIT`), and the most.
const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 250;

/// Which page of the list the address asks for (`orderListPageQuery`): `limit` from 1 to 250, 100
/// when it is missing, zero or not a number; `offset` from 0.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Paging {
    pub limit: Option<String>,
    pub offset: Option<String>,
}

impl Paging {
    pub fn at(limit: u32, offset: u32) -> Self {
        Paging { limit: Some(limit.to_string()), offset: Some(offset.to_string()) }
    }

    pub fn limit(&self) -> u32 {
        match self.limit.as_deref().and_then(|l| l.trim().parse::<f64>().ok()) {
            Some(l) if l.is_finite() && l != 0.0 => l.clamp(1.0, MAX_LIMIT as f64) as u32,
            _ => DEFAULT_LIMIT,
        }
    }

    pub fn offset(&self) -> u32 {
        match self.offset.as_deref().and_then(|o| o.trim().parse::<f64>().ok()) {
            Some(o) if o.is_finite() => o.clamp(0.0, u32::MAX as f64) as u32,
            _ => 0,
        }
    }
}

/// The list's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ListScreen {
    pub side: Side,
    pub orders: OrderList,
}

impl ListScreen {
    /// The page shown (from 1) and how many there are (at least 1).
    pub fn page(&self) -> (u64, u64) {
        let size = self.orders.limit.max(1);
        (self.orders.offset / size + 1, self.orders.total.div_ceil(size).max(1))
    }

    /// Whether the list has more than one page (`showPagination`).
    pub fn paged(&self) -> bool {
        self.orders.total > self.orders.limit || self.orders.offset > 0
    }

    /// The list's page `page` (from 1).
    pub fn page_href(&self, page: u64) -> String {
        let size = self.orders.limit.max(1);
        let paging = Paging::at(size as u32, (page.saturating_sub(1) * size) as u32);
        list_href(self.side, paging)
    }
}

/// An order's view model.
#[derive(Serialize, ToJson)]
pub struct OrderScreen {
    pub side: Side,
    /// `None` while a read after a write has not caught up.
    pub order: Option<OrderDetail>,
    /// What a cancellation the API refused said (marketplace's `actionData.error`).
    pub notice: Option<String>,
    /// Whether the caller may cancel (`orders.manage`). Marketplace draws Cancel for anyone who
    /// may read the order, and its action refuses the rest (chase-sets/chase-sets#10635).
    pub may_cancel: bool,
}

pub fn list_href(side: Side, page: Paging) -> String {
    match side {
        Side::Buyer => url::Purchases { page }.href(),
        Side::Seller => url::Sales { page }.href(),
    }
}

/// The order's page, read after the write whose receipt it carries.
pub fn order_href(side: Side, id: &str, receipt: Option<&Receipt>) -> String {
    let after = AfterWrite { after_write: receipt.map(Receipt::param) };
    match side {
        Side::Buyer => url::Purchase { id, after }.href(),
        Side::Seller => url::Sale { id, after }.href(),
    }
}

pub fn cancel_href(side: Side, id: &str) -> String {
    match side {
        Side::Buyer => url::PurchaseCancel { id }.href(),
        Side::Seller => url::SaleCancel { id }.href(),
    }
}

pub(crate) async fn purchases(
    req: Req,
    chrome: Chrome,
    Caller(OrderBuyer(viewer)): Caller<OrderBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::purchases::Purchases>,
) -> HtmlResult {
    let paging = route.page;
    list(&req, &viewer, &config, &headers, Side::Buyer, &paging, &chrome).await
}

pub(crate) async fn sales(
    req: Req,
    chrome: Chrome,
    Caller(OrderSeller(viewer)): Caller<OrderSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sales::Sales>,
) -> HtmlResult {
    let paging = route.page;
    list(&req, &viewer, &config, &headers, Side::Seller, &paging, &chrome).await
}

pub(crate) async fn purchase(
    req: Req,
    chrome: Chrome,
    Caller(OrderBuyer(viewer)): Caller<OrderBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::purchases::Purchase<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, route.after);
    order(&req, &viewer, &config, &headers, Side::Buyer, &id, &after, &chrome).await
}

pub(crate) async fn sale(
    req: Req,
    chrome: Chrome,
    Caller(OrderSeller(viewer)): Caller<OrderSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sales::Sale<'_>>,
) -> HtmlResult {
    let (id, after) = (route.id, route.after);
    order(&req, &viewer, &config, &headers, Side::Seller, &id, &after, &chrome).await
}

pub(crate) async fn cancel_purchase(
    req: Req,
    chrome: Chrome,
    Caller(OrderBuyer(viewer)): Caller<OrderBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::purchases::PurchaseCancel<'_>>,
) -> HtmlResult {
    let id = route.id;
    cancel(&req, &viewer, &config, &headers, Side::Buyer, &id, &chrome).await
}

pub(crate) async fn cancel_sale(
    req: Req,
    chrome: Chrome,
    Caller(OrderSeller(viewer)): Caller<OrderSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sales::SaleCancel<'_>>,
) -> HtmlResult {
    let id = route.id;
    cancel(&req, &viewer, &config, &headers, Side::Seller, &id, &chrome).await
}

async fn list(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    side: Side,
    paging: &Paging,
    chrome: &Chrome,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let orders = match caller.orders(side, paging.limit(), paging.offset()).await {
        Ok(orders) => orders,
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let screen = ListScreen { side, orders };
    let t: OrdersMsg = req.t();
    let (title, description) = match side {
        Side::Buyer => (t.purchases_purchases_marketplace(), t.purchases_track_purchases_and_drill_into_each()),
        Side::Seller => (t.sales_sales_marketplace(), t.sales_review_sales_created_by_checkout_and()),
    };
    let head = html! { <meta name="description" content={description}> };
    let view = html! { <views::OrderList t={t} p={req.t()} screen={&screen} /> };
    let cart = chrome.cart().await;
    req.screen(&screen, html! { <Layout req={req} viewer={Some(viewer)} cart={cart} title={title} head={head}>{view}</Layout> })
}

#[allow(clippy::too_many_arguments)]
async fn order(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    side: Side,
    id: &str,
    after: &AfterWrite,
    chrome: &Chrome,
) -> HtmlResult {
    let receipt = Receipt::from_param(after.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let order = match caller.order(side, id).await {
        Ok(order) => Some(order),
        // The order's projection has not caught up with the write yet (`loadAfterWrite`'s pending
        // read, which marketplace answers 503 with "We are preparing your purchase").
        Err(error) if receipt.is_some() && error.catching_up() => None,
        Err(error) => return order_failed(req, viewer, side, error, receipt.is_some(), chrome.cart().await),
    };
    let may_cancel = viewer.actor.can(ORDERS_MANAGE);
    render(req, viewer, OrderScreen { side, order, notice: None, may_cancel }, StatusCode::OK, chrome.cart().await)
}

/// A read that failed: a 404 is the error page's Not found, after a write the screen's "could not
/// be verified", else as every list's read.
fn order_failed(req: &Req, viewer: &Viewer, side: Side, error: ApiError, after_write: bool, cart: Option<u64>) -> HtmlResult {
    if error.status() == Some(StatusCode::NOT_FOUND) {
        return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
    }
    let p: Pilot = req.t();
    let unverified = match side {
        Side::Buyer => p.orders_purchase_unverified(),
        Side::Seller => p.orders_sale_unverified(),
    };
    read_failed(req, Some(viewer), error, after_write.then_some(unverified), cart)
}

/// Cancels the order: its page with the cancellation's receipt, or with what the API said when it
/// refused (the order read again as it is now).
async fn cancel(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    side: Side,
    id: &str,
    chrome: &Chrome,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let refused = match caller.cancel_order(side, id).await {
        Ok(receipt) => {
            let after = AfterWrite { after_write: receipt.as_ref().map(Receipt::param) };
            return match side {
                Side::Buyer => req.redirect(&url::Purchase { id, after }),
                Side::Seller => req.redirect(&url::Sale { id, after }),
            };
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Err(error) => match error.refusal() {
            Some(message) => (error.status().unwrap_or(StatusCode::CONFLICT), message.to_owned()),
            // The API failed: the error page, as a gateway's.
            None => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    let (status, message) = refused;
    let order = match caller.order(side, id).await {
        Ok(order) => order,
        Err(error) => return order_failed(req, viewer, side, error, false, chrome.cart().await),
    };
    render(
        req,
        viewer,
        OrderScreen { side, order: Some(order), notice: Some(message), may_cancel: true },
        status,
        chrome.cart().await,
    )
}

fn render(req: &Req, viewer: &Viewer, screen: OrderScreen, status: StatusCode, cart: Option<u64>) -> HtmlResult {
    let t: OrdersMsg = req.t();
    let (title, description) = match screen.side {
        Side::Buyer => (t.purchase_purchase_marketplace(), t.purchase_inspect_a_purchase_cancel_it_while()),
        Side::Seller => (t.sale_sale_marketplace(), t.sale_inspect_a_sale_cancel_it_while()),
    };
    let again = screen.order.is_none();
    let head = html! {
        <meta name="description" content={description}>
        if again {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::OrderPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! { <Layout req={req} viewer={Some(viewer)} cart={cart} title={title} head={head}>{view}</Layout> };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}
