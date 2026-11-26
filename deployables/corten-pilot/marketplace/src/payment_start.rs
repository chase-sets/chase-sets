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
//! What the page offers of the wallet is Payments' quote for the most of it, not the balance: the
//! credit Payments applies (none while it withholds the wallet, less while a hold is on part of
//! it) and what that leaves to pay outside the wallet. Platform credit only is offered only when
//! that leaves nothing. A quote whose amounts are not money is not drawn, rather than falling back
//! to the balance.
//!
//! When Payments withholds the wallet until the buyer accepts the current Terms of Service, the
//! page says so beside Review Terms of Service and Accept Terms of Service, as marketplace's does.
//! Accepting posts to the page: Identity records the acceptance, and the page is read again after
//! Identity's write, so Payments' quote sees it and the wallet may pay. Until that read catches up
//! the page cannot say the wallet may pay, and offers Refresh wallet status instead.
//!
//! Marketplace's `autostart=1`, which submits the form as the page loads, is not carried: nothing
//! links to it.
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::{money::cents, receipt::Receipt};
use serde::Serialize;

use crate::{
    api::{
        ApiError, CheckoutSessions as _, ConsentCalls as _, PaymentCalls as _, PaymentOrder, PaymentPreview, ReasonDetail, Wallet,
    },
    app::{ORDERS_MANAGE, Shared, read_failed, url},
    auth::{PaymentBuyer, Viewer},
    email_verification::{self, Purpose},
    payment::Place,
    text::PaymentStartMsg,
    views::{self, Layout},
};

/// The page's address: the orders to pay, comma separated, as marketplace's links write them, and
/// the receipt of the write the page reads after (accepting the Terms of Service).
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct StartPlace {
    pub order_ids: Option<String>,
    pub after_write: Option<String>,
}

impl StartPlace {
    /// The page for `order_ids`.
    pub fn of(order_ids: &[String]) -> Self {
        StartPlace { order_ids: Some(order_ids.join(",")), after_write: None }
    }
}

/// The `intent` of Accept Terms of Service's form; Continue to payment's sends none.
pub const ACCEPT_TERMS: &str = "accept-terms";

/// The reason Payments gives for withholding the wallet until the buyer accepts the current terms.
const TERMS_NOT_ACCEPTED: &str = "wallet-terms-not-accepted";

/// Why `quote` withholds the wallet until the buyer accepts the current terms, if it does
/// (marketplace's `walletTermsReason`).
fn terms_reason(quote: &PaymentPreview) -> Option<&ReasonDetail> {
    quote.unavailable_reason_details.iter().find(|reason| reason.code == TERMS_NOT_ACCEPTED)
}

/// Continue to payment's form: the orders, the payment method, and how much of the wallet to use
/// (`none`, `max` or `custom` with its amount), in marketplace's names. Accept Terms of
/// Service's sends the orders and its `intent` alone.
#[derive(Clone, Debug, Default, Serialize, Fields)]
#[serde(default)]
pub struct StartForm {
    pub order_ids: String,
    pub intent: String,
    pub payment_method_category: String,
    pub balance_credit_mode: String,
    pub requested_balance_credit_amount: String,
}

/// The orders' totals, in cents, and the most of the wallet to ask Payments for
/// (`calculateBalanceCredit`). What Payments applies of it is its quote's to say
/// (`StartScreen::wallet_credit`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub total: i64,
    pub sales_fee: i64,
    pub payout: i64,
    pub tax: i64,
    /// The most of the wallet to ask for: the total or the balance, whichever is less, and never
    /// below nothing.
    pub max_credit: i64,
}

impl Totals {
    /// The orders' totals with `available` in the wallet; `None` when an amount is not money.
    pub fn of(orders: &[PaymentOrder], available: i64) -> Option<Self> {
        let sum = |amount: fn(&PaymentOrder) -> &str| orders.iter().try_fold(0_i64, |sum, o| Some(sum + cents(amount(o))?));
        let total = sum(|o| &o.total_amount)?;
        Some(Totals {
            total,
            sales_fee: sum(|o| &o.marketplace_sales_fee_amount)?,
            payout: sum(|o| &o.seller_payout_amount)?,
            tax: sum(|o| o.sales_tax_amount.as_deref().unwrap_or("0.00"))?,
            max_credit: total.max(0).min(available.max(0)),
        })
    }
}

/// Cents as the API writes an amount (`centsToMoneyAmount`).
pub fn amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}{}.{:02}", cents.unsigned_abs() / 100, cents.unsigned_abs() % 100)
}

/// The page: the orders, the wallet if it was read, Payments' quote, the totals, the choices the
/// form starts with, and why Continue to payment did not start one. `pending` is a quote read
/// without the write the page reads after, which had not caught up; `after_write` is that
/// write's receipt, which the page's forms and Refresh wallet status carry on.
pub struct StartScreen {
    pub order_ids: Vec<String>,
    pub orders: Vec<PaymentOrder>,
    pub wallet: Option<Wallet>,
    pub quote: PaymentPreview,
    pub totals: Totals,
    pub chosen: StartForm,
    pub error: Option<String>,
    pub pending: bool,
    pub after_write: Option<String>,
}

impl StartScreen {
    /// Why Payments withholds the wallet until the buyer accepts the current terms, if it does.
    pub fn terms_reason(&self) -> Option<&ReasonDetail> {
        terms_reason(&self.quote)
    }

    /// Whether the wallet may not pay: Payments wants the terms accepted, or the read after
    /// accepting them has not caught up, so the page cannot say it may (marketplace's
    /// `walletWithheld`).
    pub fn wallet_withheld(&self) -> bool {
        self.pending || self.terms_reason().is_some()
    }

    /// What Payments applies of the wallet at the page's quote (the most of it) and what that
    /// leaves to pay outside it, in cents (marketplace's `wallet_credit.applied_amount` and
    /// `external_amount`). The page's quote is checked to be money when it is read.
    pub fn wallet_credit(&self) -> (i64, i64) {
        let credit = &self.quote.wallet_credit;
        (cents(&credit.applied_amount).unwrap_or(0), cents(&credit.external_amount).unwrap_or(0))
    }

    /// Whether the wallet may pay this payment: Payments does not withhold it and applies some of
    /// it (marketplace's `walletAvailable`).
    pub fn wallet_usable(&self) -> bool {
        !self.wallet_withheld() && self.wallet_credit().0 > 0
    }
}

/// Whether every amount in `quote` is money and its wallet credit is not negative
/// (marketplace's `validateCheckoutStatus`).
fn quote_is_money(quote: &PaymentPreview) -> bool {
    let credit = &quote.wallet_credit;
    let fees = std::iter::once(&quote.marketplace_checkout_fee).chain(&quote.payment_method_quotes);
    [&credit.requested_amount, &credit.applied_amount, &credit.external_amount].iter().all(|a| cents(a).is_some_and(|c| c >= 0))
        && fees
            .flat_map(|q| {
                [
                    &q.marketplace_checkout_fee_amount,
                    &q.marketplace_checkout_fee_reduction_amount,
                    &q.total_amount,
                    &q.processor_amount,
                ]
            })
            .all(|a| cents(a).is_some())
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
            tracing::warn!("an order's or the quote's amount is not money");
            Err(corten::Error::status(StatusCode::BAD_GATEWAY))
        }
    }
}

/// Starting a payment needs `orders.manage`, as marketplace's loader and action require. A buyer
/// without it is not shown a bare Forbidden (`requirePaymentActor`): one whose `orders.manage`
/// awaits email verification goes to the sign-in that verifies it and returns to the purchase, and
/// anyone else goes back to the purchase, which says this account cannot pay. More than one order
/// is the purchases.
fn refused(req: &Req, viewer: &Viewer, ids: &[String]) -> Option<HtmlResult> {
    if viewer.actor.can(ORDERS_MANAGE) {
        return None;
    }
    let verify = email_verification::awaits(&viewer.actor, ORDERS_MANAGE);
    Some(match ids {
        [id] => back(req, &url::Purchase { id, after: Default::default() }, verify),
        _ => back(req, &url::Purchases::default(), verify),
    })
}

/// `to`, or the sign-in that verifies the email and returns to it.
fn back(req: &Req, to: &impl corten::Route, verify: bool) -> HtmlResult {
    if verify { req.redirect(&email_verification::sign_in(&to.href(), Purpose::PayPurchase)) } else { req.redirect(to) }
}

/// The page for the orders in its address; none is the purchases.
pub(crate) async fn page(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::payments::BuyerPaymentNew>,
) -> HtmlResult {
    let ids = order_ids(route.place.order_ids.as_deref().unwrap_or_default());
    if let Some(answer) = refused(&req, &viewer, &ids) {
        return answer;
    }
    if ids.is_empty() {
        return req.redirect(&url::Purchases::default());
    }
    let receipt = Receipt::from_param(route.place.after_write.as_deref());
    let (orders, wallet, totals) = match orders_and_wallet(&config, &headers, &ids).await {
        Ok(read) => read,
        Err(read) => return read_answer(&req, &viewer, read),
    };
    let (quote, pending) = match page_quote(&config, &headers, &ids, &totals, receipt.as_ref()).await {
        Ok(read) => read,
        Err(read) => return read_answer(&req, &viewer, read),
    };
    let chosen = StartForm { order_ids: ids.join(","), payment_method_category: "card".to_owned(), ..StartForm::default() };
    let after_write = receipt.as_ref().map(Receipt::param);
    let mut screen = StartScreen { order_ids: ids, orders, wallet, quote, totals, chosen, error: None, pending, after_write };
    screen.chosen.balance_credit_mode = if screen.wallet_usable() { "max" } else { "none" }.to_owned();
    draw(&req, &viewer, &screen, StatusCode::OK)
}

/// Payments' quote for the page (by card, with the most of the wallet), read after the write
/// `receipt` names. A read that has not caught up with it is quoted without it and marked
/// pending (marketplace's `onPending`): the page then does not say the wallet may pay. A quote
/// whose amounts are not money is refused, as an order's is.
async fn page_quote(
    config: &Shared,
    headers: &HeaderMap,
    ids: &[String],
    totals: &Totals,
    receipt: Option<&Receipt>,
) -> Result<(PaymentPreview, bool), Read> {
    let credit = amount(totals.max_credit);
    let caller = config.platform.caller(headers, config.proto, receipt);
    let (quote, pending) = match caller.quote(ids, "usd", Some(&credit), "card").await {
        Ok(quote) => (quote, false),
        Err(error) if receipt.is_some() && error.catching_up() => {
            tracing::info!("the quote has not caught up with the Terms of Service acceptance: {error}");
            let caller = config.platform.caller(headers, config.proto, None);
            (caller.quote(ids, "usd", Some(&credit), "card").await.map_err(Read::Api)?, true)
        }
        Err(error) => return Err(Read::Api(error)),
    };
    if !quote_is_money(&quote) {
        tracing::warn!("Payments' quote for starting a payment has an amount that is not money");
        return Err(Read::NotMoney);
    }
    Ok((quote, pending))
}

/// Continue to payment: Payments' quote for the chosen method and wallet credit, then a payment at
/// it, and the payment's page, read after it. A refusal is the page again with why. A quote that
/// withholds the wallet the buyer chose to use starts nothing: the page again says why, as
/// marketplace's action answers. Accept Terms of Service posts here too (`accept_terms`).
pub(crate) async fn start(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::payments::BuyerPaymentNew>,
    Form(form): Form<StartForm>,
) -> HtmlResult {
    let t: PaymentStartMsg = req.t();
    let ids = order_ids(&form.order_ids);
    if let Some(answer) = refused(&req, &viewer, &ids) {
        return answer;
    }
    if ids.is_empty() {
        return req.redirect(&url::Purchases::default());
    }
    let receipt = Receipt::from_param(route.place.after_write.as_deref());
    if form.intent == ACCEPT_TERMS {
        return accept_terms(&req, &viewer, &config, &headers, ids, receipt.as_ref()).await;
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
    let uses_wallet = credit.as_deref().and_then(cents).is_some_and(|c| c > 0);
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    // A quote whose amounts are not money starts nothing (`Err`), as the page does not draw one.
    let started = async {
        let quote = caller.quote(&ids, "usd", credit.as_deref(), &method).await?;
        if !quote_is_money(&quote) {
            return Ok(Err(Read::NotMoney));
        }
        if uses_wallet && terms_reason(&quote).is_some() {
            return Ok(Ok(None));
        }
        let fingerprint = quote.marketplace_checkout_fee.quote_fingerprint.clone();
        caller.start_payment(&ids, credit.as_deref(), &method, &fingerprint).await.map(|started| Ok(Some(started)))
    };
    let refusal = match started.await {
        Ok(Err(read)) => {
            tracing::warn!("Payments' quote for Continue to payment has an amount that is not money");
            return read_answer(&req, &viewer, read);
        }
        Ok(Ok(Some((payment, receipt)))) => {
            let place = Place { after_write: receipt.as_ref().map(Receipt::param) };
            return req.redirect(&url::BuyerPayment { id: &payment.payment_id, place });
        }
        // The page again says the wallet is withheld and why.
        Ok(Ok(None)) => None,
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => {
            return read_failed(&req, Some(&viewer), error, None);
        }
        Err(error) if receipt.is_some() && error.catching_up() => Some(t.wallet_catching_up().to_owned()),
        Err(error) => {
            tracing::warn!("Continue to payment was refused: {error}");
            Some(error.refusal().unwrap_or(t.payment_could_not_be_started()).to_owned())
        }
    };
    let chosen = StartForm { order_ids: ids.join(","), ..form };
    let after_write = receipt.as_ref().map(Receipt::param);
    let screen = StartScreen {
        order_ids: ids,
        orders,
        wallet,
        quote: PaymentPreview::default(),
        totals,
        chosen,
        error: refusal,
        pending: false,
        after_write,
    };
    again(&req, &viewer, &config, &headers, receipt.as_ref(), screen).await
}

/// Accept Terms of Service (marketplace's `accept-terms` intent): Identity records the buyer's
/// acceptance of the current terms, once, and the page is read again after Identity's write. An
/// answer that does not confirm Identity's write (none of its receipt's sources is Identity's) is
/// the page again with the orders, saying so; the wallet stays withheld.
async fn accept_terms(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    ids: Vec<String>,
    receipt: Option<&Receipt>,
) -> HtmlResult {
    let t: PaymentStartMsg = req.t();
    match config.platform.caller(headers, config.proto, None).accept_terms().await {
        Ok(Some(accepted)) => {
            let place = StartPlace { order_ids: Some(ids.join(",")), after_write: Some(accepted.param()) };
            return req.redirect(&url::BuyerPaymentNew { place });
        }
        Ok(None) => tracing::warn!("Identity did not confirm accepting the Terms of Service"),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => {
            return read_failed(req, Some(viewer), error, None);
        }
        Err(error) => tracing::warn!("accepting the Terms of Service failed: {error}"),
    }
    let (orders, wallet, totals) = match orders_and_wallet(config, headers, &ids).await {
        Ok(read) => read,
        Err(read) => return read_answer(req, viewer, read),
    };
    let chosen = StartForm {
        order_ids: ids.join(","),
        payment_method_category: "card".to_owned(),
        balance_credit_mode: "none".to_owned(),
        ..StartForm::default()
    };
    let screen = StartScreen {
        order_ids: ids,
        orders,
        wallet,
        quote: PaymentPreview::default(),
        totals,
        chosen,
        error: Some(t.terms_accept_failed().to_owned()),
        pending: false,
        after_write: receipt.map(Receipt::param),
    };
    again(req, viewer, config, headers, receipt, screen).await
}

/// `screen` again after a post that started nothing, quoted as the page quotes it (by card, with
/// the most of the wallet).
async fn again(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    receipt: Option<&Receipt>,
    mut screen: StartScreen,
) -> HtmlResult {
    match page_quote(config, headers, &screen.order_ids, &screen.totals, receipt).await {
        Ok((quote, pending)) => (screen.quote, screen.pending) = (quote, pending),
        Err(read) => return read_answer(req, viewer, read),
    }
    draw(req, viewer, &screen, StatusCode::UNPROCESSABLE_ENTITY)
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
        assert_eq!(rich.max_credit, 2450);
        assert_eq!(Totals::of(&orders, 1000).unwrap().max_credit, 1000);
        assert_eq!(Totals::of(&orders, -500).unwrap().max_credit, 0);
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
