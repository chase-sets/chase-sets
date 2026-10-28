//! A buyer's payment (Payments' `account-payment`, marketplace's
//! `payments/routes/marketplace/account-payment.tsx`): `/account/payments/{id}`, where Continue to
//! payment lands from Checkout received and a purchase's payment link goes.
//!
//! The page reads the payment after the write whose receipt it carries, then its orders (Payments'
//! order inputs), as marketplace's loader does. While the payment waits for the buyer
//! (`pending-confirmation`) it holds the secure payment step: Stripe's fields, mounted by the
//! page's script (`payment_page.js`) from the payment's client secret and publishable key, and
//! Confirm payment, which Stripe confirms in the browser; a payment the provider hands off by
//! address is a link to it instead. Nothing on the page posts to the pilot: the payment's state
//! changes when Payments hears from the provider.
//!
//! So the page watches it. Marketplace's script reads the payment every two seconds and reloads
//! the route when its status changes; a read of the whole page would put Stripe's fields on the
//! page again and lose what the buyer typed. The pilot's watch is the status part
//! (`/account/payments/{id}/status`): a patch that, while the status is the one the page was drawn
//! with, is an empty part that asks to be read again in two seconds (Corten's patch
//! `ReadAgain`), and once it changed is the page's content, drawn again. A page cannot ask for
//! one of its parts to be read again, so the script starts the first read
//! (todd-skelton/corten#276). It stops after five minutes, as marketplace's does; the
//! provider's webhook covers the rest and the buyer can reload.
//!
//! Stripe's origins are in the app's policy, so every marketplace page allows them; the policy
//! is one per app (todd-skelton/corten#275).
//!
//! Not ported: a guest's payment page (`/checkout/payments/{id}`, its retry and saving the order
//! to an account), which a guest is sent to marketplace for; starting a payment again
//! (`/account/payments/new`, marketplace's); restyling Stripe's fields when the color mode
//! changes while the page is open.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{AccountPayment, PaymentCalls as _, PaymentOrder},
    app::{Shared, read_failed, url},
    auth::{PaymentBuyer, Viewer},
    text::PaymentMsg,
    views::{self, Layout},
};

/// How long the page watches a payment that waits for the buyer, as marketplace's does.
const WATCH_FOR: Duration = Duration::from_secs(5 * 60);
/// How often the status part is read again.
const WATCH_EVERY: Duration = Duration::from_secs(2);

/// A payment's address: the receipt of the write it reads after (Pay now's).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub after_write: Option<String>,
}

/// The status part's address: the status the page was drawn with and when the watch ends (Unix
/// seconds).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Watch {
    pub since: Option<String>,
    pub until: Option<u64>,
}

/// What Stripe's fields start with (`PaymentElementDefaultValues`): the buyer's email, name and
/// address from the first order that has an email.
#[derive(Clone, Debug, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub billing_details: BillingDetails,
}

#[derive(Clone, Debug, Serialize, ToJson)]
pub struct BillingDetails {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<BillingAddress>,
}

/// An address in Stripe's names.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct BillingAddress {
    pub line1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
}

/// The payment page: the payment, its orders, whether the viewer is staff who may see the
/// provider's details, and what Stripe's fields start with.
#[derive(Serialize, ToJson)]
pub struct PaymentScreen {
    pub payment: AccountPayment,
    pub orders: Vec<PaymentOrder>,
    pub support_details: bool,
    pub defaults: Option<Defaults>,
    /// The status part to read while the payment waits for the buyer.
    #[serde(skip)]
    pub watch: Option<String>,
}

impl PaymentScreen {
    /// Waiting for the buyer: the secure payment step is on the page.
    pub fn pending(&self) -> bool {
        self.payment.status == "pending-confirmation"
    }

    /// The earliest of the orders' payment deadlines.
    pub fn deadline(&self) -> Option<&str> {
        self.orders
            .iter()
            .filter_map(|o| o.payment_deadline_at.as_deref())
            .filter_map(|at| corten::i18n::parse_timestamp(at).map(|when| (when, at)))
            .min_by_key(|(when, _)| *when)
            .map(|(_, at)| at)
    }
}

/// Stripe's starting values (`resolvePaymentElementDefaultValues`), only while the payment waits for
/// the buyer.
fn defaults(payment: &AccountPayment, orders: &[PaymentOrder]) -> Option<Defaults> {
    if payment.status != "pending-confirmation" {
        return None;
    }
    orders.iter().find_map(|order| {
        let destination = order.shipping_destination_snapshot.as_ref();
        let email = [order.buyer_email.as_deref(), destination.and_then(|d| d.email.as_deref())]
            .into_iter()
            .flatten()
            .map(str::trim)
            .find(|e| !e.is_empty())?;
        Some(Defaults {
            billing_details: BillingDetails {
                email: email.to_owned(),
                name: destination.map(|d| d.name.trim().to_owned()).filter(|n| !n.is_empty()),
                address: destination.map(|d| BillingAddress {
                    line1: d.line1.clone(),
                    line2: d.line2.clone().filter(|l| !l.is_empty()),
                    city: d.city.clone(),
                    state: d.state.clone(),
                    postal_code: d.postal_code.clone(),
                    country: d.country.clone(),
                }),
            },
        })
    })
}

/// Staff who may see a payment's provider details (`isInternalPaymentSupportActor`).
fn support_details(viewer: &Viewer) -> bool {
    viewer.actor.role_key == "platform-admin" && viewer.actor.can(crate::app::SUPPORT_MANAGE)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// What the page needs, read after `receipt`: the screen, or the page to answer instead.
async fn read(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    receipt: Option<&Receipt>,
    until: u64,
) -> Result<PaymentScreen, Box<HtmlResult>> {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let payment = match caller.account_payment(id).await {
        Ok(Some(payment)) => payment,
        Ok(None) if receipt.is_some() => return Err(Box::new(preparing(req, viewer))),
        Ok(None) => return Err(Box::new(not_found(req, viewer))),
        Err(error) if receipt.is_some() && error.catching_up() => return Err(Box::new(preparing(req, viewer))),
        Err(error) => return Err(Box::new(read_failed(req, Some(viewer), error, None))),
    };
    let orders = match config.platform.caller(headers, config.proto, None).payment_orders(&payment.order_ids).await {
        Ok(orders) => orders,
        Err(error) => return Err(Box::new(read_failed(req, Some(viewer), error, None))),
    };
    let watch = (payment.status == "pending-confirmation" && now() < until)
        .then(|| url::BuyerPaymentStatus { id, watch: Watch { since: Some(payment.status.clone()), until: Some(until) } }.href());
    Ok(PaymentScreen { defaults: defaults(&payment, &orders), support_details: support_details(viewer), payment, orders, watch })
}

/// The payment's page, read after the write whose receipt it carries.
pub(crate) async fn page(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(place): Query<Place>,
) -> HtmlResult {
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let until = now() + WATCH_FOR.as_secs();
    let screen = match read(&req, &viewer, &config, &headers, &id, receipt.as_ref(), until).await {
        Ok(screen) => screen,
        Err(page) => return *page,
    };
    let t: PaymentMsg = req.t();
    let view = html! { <views::PaymentPage t={t} screen={&screen} /> };
    let head = html! { <meta name="robots" content="noindex"> };
    req.screen(
        &screen,
        html! { <Layout req={&req} viewer={Some(&viewer)} title={t.payment_marketplace()} head={head}>{view}</Layout> },
    )
}

/// The status part (see the module): while the payment's status is the one the page was drawn
/// with and the watch has time left, an empty part read again shortly; once it changed, the page's
/// content drawn again. Without JavaScript, the page.
pub(crate) async fn status(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(watch): Query<Watch>,
) -> HtmlResult {
    let page = url::BuyerPayment { id: &id, place: Place::default() };
    let caller = config.platform.caller(&headers, config.proto, None);
    let until = watch.until.unwrap_or_default();
    // A read that fails ends the watch: the part stays as it is and the buyer can reload.
    let payment = match caller.account_payment(&id).await {
        Ok(Some(payment)) => payment,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => {
            tracing::warn!("the payment's status could not be read: {error}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    };
    if watch.since.as_deref() == Some(payment.status.as_str()) {
        let again = (now() < until).then_some(&watch);
        let from = url::BuyerPaymentStatus { id: &id, watch: watch.clone() };
        return req.patch_or(views::PaymentWatch { again: again.map(|_| &from) }, || async { req.redirect(&page) }).await;
    }
    let screen = match read(&req, &viewer, &config, &headers, &id, None, until).await {
        Ok(screen) => screen,
        Err(page) => return *page,
    };
    let t: PaymentMsg = req.t();
    req.patch_or(views::PaymentContent { t, screen: &screen }, || async { req.redirect(&page) }).await
}

/// `/account/payments/new`: starting a payment again is marketplace's page (not ported), with the
/// orders it is for.
pub(crate) async fn start(req: Req, _: Caller<PaymentBuyer>, uri: Uri) -> HtmlResult {
    let path = uri.path_and_query().map_or(url::BuyerPaymentNew::PATH, |p| p.as_str());
    match views::marketplace(path) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::NOT_FOUND)),
    }
}

/// A payment the account does not have (marketplace's 404 with `payment.not.found`).
fn not_found(req: &Req, viewer: &Viewer) -> HtmlResult {
    let t: PaymentMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        StatusCode::NOT_FOUND,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.payment_not_found()} head={head}>
                <views::PaymentNotice t={t} title={t.payment_not_found()} says={t.payment_not_found_description()} />
            </Layout>
        },
    )
}

/// A payment Payments has not caught up to after the write (marketplace's 503 Preparing payment):
/// a 202 the page reads again.
fn preparing(req: &Req, viewer: &Viewer) -> HtmlResult {
    let t: PaymentMsg = req.t();
    let head = html! {
        <meta name="robots" content="noindex">
        {ReadAgain { after: WATCH_EVERY }}
    };
    req.page_with_status(
        StatusCode::ACCEPTED,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.payment_preparing()} head={head}>
                <views::PaymentNotice t={t} title={t.payment_preparing()} says={t.payment_preparing_description()} />
            </Layout>
        },
    )
}
