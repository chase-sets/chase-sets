//! Starting a payment for a buyer's orders (Payments' `account-payment-new`, marketplace's
//! `payments/routes/marketplace/account-payment-new.tsx`): `/account/payments/new?orderIds=..`,
//! where a purchase's Pay now and a failed or closed payment's Retry payment go.
//!
//! The page reads the orders (Payments' order inputs) and the wallet, then Payments' quote for
//! paying them by card with as much of the wallet as covers them, as marketplace's loader does. It
//! shows the summary, the choice of payment method and how much of the wallet to use, every
//! method's quote, and the purchases. Continue to payment posts the form to the page: Payments
//! quotes the chosen method and wallet credit again and starts a payment at that quote, and the
//! buyer goes on to the payment's page, read after the write. A refusal is the page again with
//! Payments' words and the choices kept.
//!
//! Marketplace computes the wallet's maximum from the total and balance it drew the page with,
//! which the form carries; the pilot reads the orders and the wallet again when the form is posted,
//! so the maximum is the one in effect. Payments checks the credit either way.
//!
//! Marketplace's `autostart=1`, which submits the form as the page loads, is not carried: nothing
//! links to it.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::{money::cents, receipt::Receipt};
use serde::{Deserialize, Serialize};

use crate::{
    api::{ApiError, CheckoutSessions as _, PaymentCalls as _, PaymentOrder, PaymentPreview, Wallet},
    app::{ORDERS_MANAGE, Shared, read_failed, url},
    auth::{PaymentBuyer, Viewer},
    payment::Place,
    text::PaymentStartMsg,
    views::{self, Layout},
};

/// The page's address: the orders to pay, comma separated, as marketplace's links write them.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct StartPlace {
    pub order_ids: Option<String>,
}

impl StartPlace {
    /// The page for `order_ids`.
    pub fn of(order_ids: &[String]) -> Self {
        StartPlace { order_ids: Some(order_ids.join(",")) }
    }
}

/// Continue to payment's form: the orders, the payment method, and how much of the wallet to use
/// (`none`, `max` or `custom` with its amount), in marketplace's names.
#[derive(Clone, Debug, Default, Deserialize, Serialize, Fields)]
#[serde(default)]
pub struct StartForm {
    pub order_ids: String,
    pub payment_method_category: String,
    pub balance_credit_mode: String,
    pub requested_balance_credit_amount: String,
}

/// The orders' totals, in cents, and what the wallet can cover of them (`calculateBalanceCredit`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub total: i64,
    pub sales_fee: i64,
    pub payout: i64,
    pub tax: i64,
    /// The wallet's available balance, which may be negative.
    pub available: i64,
    /// The most of the wallet the payment may use: the total or the balance, whichever is less.
    pub max_credit: i64,
    /// What is left to pay outside the wallet after the most of it.
    pub external_after_max: i64,
}

impl Totals {
    /// The orders' totals with `available` in the wallet; `None` when an amount is not money.
    pub fn of(orders: &[PaymentOrder], available: i64) -> Option<Self> {
        let sum = |amount: fn(&PaymentOrder) -> &str| orders.iter().try_fold(0_i64, |sum, o| Some(sum + cents(amount(o))?));
        let total = sum(|o| &o.total_amount)?;
        let positive = total.max(0);
        let max_credit = positive.min(available.max(0));
        Some(Totals {
            total,
            sales_fee: sum(|o| &o.marketplace_sales_fee_amount)?,
            payout: sum(|o| &o.seller_payout_amount)?,
            tax: sum(|o| o.sales_tax_amount.as_deref().unwrap_or("0.00"))?,
            available,
            max_credit,
            external_after_max: positive - max_credit,
        })
    }
}

/// Cents as the API writes an amount (`centsToMoneyAmount`).
pub fn amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}{}.{:02}", cents.unsigned_abs() / 100, cents.unsigned_abs() % 100)
}

/// The page: the orders, the wallet if it was read, Payments' quote, the totals, the choices the
/// form starts with, and why Continue to payment did not start one.
pub struct StartScreen {
    pub order_ids: Vec<String>,
    pub orders: Vec<PaymentOrder>,
    pub wallet: Option<Wallet>,
    pub quote: PaymentPreview,
    pub totals: Totals,
    pub chosen: StartForm,
    pub error: Option<String>,
}

/// The order ids in `value`, comma separated (`parseOrderIds`).
fn order_ids(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned).collect()
}

/// The orders and the wallet, read together, and their totals; a wallet that cannot be read is
/// none, as marketplace's.
async fn orders_and_wallet(
    config: &Shared,
    headers: &HeaderMap,
    ids: &[String],
) -> Result<(Vec<PaymentOrder>, Option<Wallet>, Totals), Read> {
    let caller = config.platform.caller(headers, config.proto, None);
    let (orders, wallet) = tokio::join!(caller.payment_orders(ids), caller.wallet());
    let orders = orders.map_err(Read::Api)?;
    let wallet = wallet.ok().filter(|w| cents(&w.available_balance_amount).is_some());
    let available = wallet.as_ref().and_then(|w| cents(&w.available_balance_amount)).unwrap_or(0);
    let totals = Totals::of(&orders, available).ok_or(Read::NotMoney)?;
    Ok((orders, wallet, totals))
}

/// Why the page could not be read.
enum Read {
    Api(ApiError),
    NotMoney,
}

/// The answer for a read that failed: a purchase the account does not have is marketplace's 404
/// Purchase not found.
fn read_answer(req: &Req, viewer: &Viewer, read: Read) -> HtmlResult {
    match read {
        Read::Api(error) if error.status() == Some(StatusCode::NOT_FOUND) => not_found(req, viewer),
        Read::Api(error) => read_failed(req, Some(viewer), error, None),
        Read::NotMoney => {
            tracing::warn!("an order's amount is not money");
            Err(corten::Error::status(StatusCode::BAD_GATEWAY))
        }
    }
}

/// Starting a payment needs `orders.manage`, as marketplace's loader and action require.
fn may_start(viewer: &Viewer) -> Result<(), corten::Error> {
    if viewer.actor.can(ORDERS_MANAGE) { Ok(()) } else { Err(corten::Error::status(StatusCode::FORBIDDEN)) }
}

/// The page for the orders in its address; none is the purchases.
pub(crate) async fn page(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::payments::BuyerPaymentNew>,
) -> HtmlResult {
    may_start(&viewer)?;
    let ids = order_ids(route.place.order_ids.as_deref().unwrap_or_default());
    if ids.is_empty() {
        return req.redirect(&url::Purchases::default());
    }
    let (orders, wallet, totals) = match orders_and_wallet(&config, &headers, &ids).await {
        Ok(read) => read,
        Err(read) => return read_answer(&req, &viewer, read),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let quote = match caller.quote(&ids, "usd", Some(&amount(totals.max_credit)), "card").await {
        Ok(quote) => quote,
        Err(error) => return read_answer(&req, &viewer, Read::Api(error)),
    };
    let chosen = StartForm {
        order_ids: ids.join(","),
        payment_method_category: "card".to_owned(),
        balance_credit_mode: if totals.available > 0 { "max" } else { "none" }.to_owned(),
        requested_balance_credit_amount: String::new(),
    };
    let screen = StartScreen { order_ids: ids, orders, wallet, quote, totals, chosen, error: None };
    draw(&req, &viewer, &screen, StatusCode::OK)
}

/// Continue to payment: Payments' quote for the chosen method and wallet credit, then a payment at
/// it, and the payment's page, read after it. A refusal is the page again with why.
pub(crate) async fn start(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<StartForm>,
) -> HtmlResult {
    may_start(&viewer)?;
    let t: PaymentStartMsg = req.t();
    let ids = order_ids(&form.order_ids);
    if ids.is_empty() {
        return req.redirect(&url::Purchases::default());
    }
    let (orders, wallet, totals) = match orders_and_wallet(&config, &headers, &ids).await {
        Ok(read) => read,
        Err(read) => return read_answer(&req, &viewer, read),
    };
    let credit = match form.balance_credit_mode.as_str() {
        "max" => Some(amount(totals.max_credit)),
        "custom" => Some(form.requested_balance_credit_amount.trim().to_owned()).filter(|a| !a.is_empty()),
        _ => None,
    };
    let method = Some(form.payment_method_category.trim()).filter(|m| !m.is_empty()).unwrap_or("card").to_owned();
    let caller = config.platform.caller(&headers, config.proto, None);
    let started = async {
        let quote = caller.quote(&ids, "usd", credit.as_deref(), &method).await?;
        let fingerprint = quote.marketplace_checkout_fee.quote_fingerprint.clone();
        caller.start_payment(&ids, credit.as_deref(), &method, &fingerprint).await
    };
    let refusal = match started.await {
        Ok((payment, receipt)) => {
            let place = Place { after_write: receipt.as_ref().map(Receipt::param) };
            return req.redirect(&url::BuyerPayment { id: &payment.payment_id, place });
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return read_failed(&req, Some(&viewer), error, None),
        Err(error) => {
            tracing::warn!("Continue to payment was refused: {error}");
            error.refusal().unwrap_or(t.payment_could_not_be_started()).to_owned()
        }
    };
    // The page again, quoted as it was drawn (by card, with the most of the wallet).
    let quote = match caller.quote(&ids, "usd", Some(&amount(totals.max_credit)), "card").await {
        Ok(quote) => quote,
        Err(error) => return read_answer(&req, &viewer, Read::Api(error)),
    };
    let chosen = StartForm { order_ids: ids.join(","), ..form };
    let screen = StartScreen { order_ids: ids, orders, wallet, quote, totals, chosen, error: Some(refusal) };
    draw(&req, &viewer, &screen, StatusCode::UNPROCESSABLE_ENTITY)
}

fn draw(req: &Req, viewer: &Viewer, screen: &StartScreen, status: StatusCode) -> HtmlResult {
    let t: PaymentStartMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.start_payment_marketplace()} head={head}>
                <views::PaymentStartPage t={t} screen={screen} />
            </Layout>
        },
    )
}

/// Orders the account does not have (marketplace's 404 Purchase not found).
fn not_found(req: &Req, viewer: &Viewer) -> HtmlResult {
    let t: PaymentStartMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        StatusCode::NOT_FOUND,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.start_payment_marketplace()} head={head}>
                <views::PaymentStartMissing t={t} />
            </Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{Totals, amount, order_ids};
    use crate::api::PaymentOrder;

    fn order(total: &str, fee: &str, payout: &str, tax: Option<&str>) -> PaymentOrder {
        PaymentOrder {
            total_amount: total.to_owned(),
            marketplace_sales_fee_amount: fee.to_owned(),
            seller_payout_amount: payout.to_owned(),
            sales_tax_amount: tax.map(str::to_owned),
            ..PaymentOrder::default()
        }
    }

    #[test]
    fn the_wallet_covers_at_most_the_total_and_never_a_negative_balance() {
        let orders = [order("21.50", "1.08", "20.42", Some("1.60")), order("3.00", "0.15", "2.85", None)];
        let rich = Totals::of(&orders, 10_000).unwrap();
        assert_eq!((rich.total, rich.sales_fee, rich.payout, rich.tax), (2450, 123, 2327, 160));
        assert_eq!((rich.max_credit, rich.external_after_max), (2450, 0));
        let some = Totals::of(&orders, 1000).unwrap();
        assert_eq!((some.max_credit, some.external_after_max), (1000, 1450));
        let owing = Totals::of(&orders, -500).unwrap();
        assert_eq!((owing.max_credit, owing.external_after_max), (0, 2450));
        assert_eq!(Totals::of(&[order("21.505", "0", "0", None)], 0), None);
    }

    #[test]
    fn amounts_and_order_ids_read_and_write_as_marketplace_does() {
        assert_eq!(amount(2450), "24.50");
        assert_eq!(amount(5), "0.05");
        assert_eq!(amount(-150), "-1.50");
        assert_eq!(order_ids(" ord_1, ,ord_2,"), ["ord_1", "ord_2"]);
    }
}
