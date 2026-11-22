//! A buyer's payment (Payments' `account-payment`, marketplace's
//! `payments/routes/marketplace/account-payment.tsx`): `/account/payments/{id}`, where Continue to
//! payment lands from Checkout received and a purchase's payment link goes.
//!
//! The page reads the payment after the write whose receipt it carries, then its orders (Payments'
//! order inputs), as marketplace's loader does. While the payment waits for the buyer
//! (`pending-confirmation`) it holds the secure payment step: Stripe's fields, mounted by the
//! step's script (`payment_entry.js`) from the payment's client secret and publishable key, and
//! Confirm payment, which Stripe confirms in the browser; a payment the provider hands off by
//! address is a link to it instead. Nothing on the page posts to the pilot: the payment's state
//! changes when Payments hears from the provider.
//!
//! So the page watches it. Marketplace's script reads the payment every two seconds and reloads
//! the route when its status changes; a read of the whole page would put Stripe's fields on the
//! page again and lose what the buyer typed. The pilot's watch is the status part
//! (`/account/payments/{id}/status`): a patch that, while the status is the one the page was drawn
//! with, is an empty part that asks to be read again in two seconds (Corten's patch
//! `ReadAgain`), and once it changed is the page's content, drawn again. The page starts the
//! first read with the same `ReadAgain` in its markup. It stops after five minutes, as marketplace's does; the
//! provider's webhook covers the rest and the buyer can reload.
//!
//! Stripe's origins are in the app's policy, so every marketplace page allows them; the policy
//! is one per app (todd-skelton/corten#275).
//!
//! A guest checkout's payment is the same page at `/checkout/payments/{id}` (Payments'
//! `checkout-payment`): no Back to purchases or Open purchase, and a failed or closed payment's
//! Retry payment is a form that asks Payments for a new payment for the same orders and goes to
//! it. An account there is sent to its own payment page, and a request with no guest checkout, or
//! one Payments refuses, is told the link is no longer good (a 401, as marketplace answers).
//!
//! A paid guest order offers Save this order, a link to Auth's claim (`/checkout/claim/{id}`, see
//! `guest_claim`) that carries the receipt the page was read after. A claim link opens this page's
//! address with its continuation (`?claimContinuation=`), which goes on to the claim with the same
//! query.
//!
//! A payment Checkout confirmed with a card the buyer entered on the checkout page
//! (`deferred_checkout`) has no fields to draw: while it waits, the step says the provider is
//! updating it, and the watch reads it as for any other. The page reads the payment after Payments
//! asked the provider for its status (`?readProcessorStatus=1`), as marketplace's loader does since
//! chase-sets/chase-sets#11670; the watch's reads do not, as marketplace's poll does not.
//!
//! Starting a payment again (`/account/payments/new`, where Retry payment goes) is `payment_start`.
//!
//! Stripe's fields keep Stripe's own appearance, as marketplace's do since chase-sets/chase-sets#11187
//! removed its custom appearance (and with it the restyle when the color mode changes).
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Serialize;

use crate::{
    api::{AccountPayment, PaymentCalls as _, PaymentOrder},
    app::{Shared, read_failed, url},
    auth::{PaymentBuyer, Session, Viewer},
    text::{PaymentMsg, Pilot},
    views::{self, Layout},
};

/// How long the page watches a payment that waits for the buyer, as marketplace's does.
const WATCH_FOR: Duration = Duration::from_secs(5 * 60);
/// How often the status part is read again.
const WATCH_EVERY: Duration = Duration::from_secs(2);

/// A payment's address: the receipt of the write it reads after (Pay now's).
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub after_write: Option<String>,
}

/// A guest's payment's address: the receipt of the write it reads after, and a claim link's
/// continuation, which the page sends on to the claim.
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct GuestPlace {
    pub after_write: Option<String>,
    pub claim_continuation: Option<String>,
}

/// The guest page's form, named as marketplace's names it: Retry payment's (`intent=retry-payment`).
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct GuestForm {
    pub intent: String,
}

/// The status part's address: the status the page was drawn with and when the watch ends (Unix
/// seconds).
#[derive(Clone, Debug, Default, Fields, Route)]
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
    /// A guest checkout's payment (`isGuestCheckoutPayment`).
    pub guest: bool,
    /// Why Retry payment did not start a payment.
    pub retry_error: Option<String>,
    /// The receipt the page was read after, which Save this order's link carries
    /// (`preserveFreshWriteMetadata`).
    pub after_write: Option<String>,
    /// The status part to read while the payment waits for the buyer.
    #[serde(skip)]
    pub watch: Option<Watching>,
}

/// The status part a page watches: the payment and the watch's query.
pub struct Watching {
    pub id: String,
    pub watch: Watch,
    pub guest: bool,
}

/// A status part's address: an account's payment's, or a guest's.
pub enum WatchRoute<'a> {
    Account(url::BuyerPaymentStatus<'a>),
    Guest(url::GuestPaymentStatus<'a>),
}

impl<'a> WatchRoute<'a> {
    fn new(id: &'a str, watch: Watch, guest: bool) -> Self {
        if guest {
            WatchRoute::Guest(url::GuestPaymentStatus { id, watch })
        } else {
            WatchRoute::Account(url::BuyerPaymentStatus { id, watch })
        }
    }

    fn href(&self) -> String {
        match self {
            WatchRoute::Account(route) => route.href(),
            WatchRoute::Guest(route) => route.href(),
        }
    }
}

impl Watching {
    /// The status part's address.
    pub fn route(&self) -> WatchRoute<'_> {
        WatchRoute::new(&self.id, self.watch.clone(), self.guest)
    }
}

impl PaymentScreen {
    /// The status part's address without its query, which the secure step's status form sends
    /// once Stripe confirms.
    pub fn status_action(&self) -> String {
        WatchRoute::new(&self.payment.payment_id, Watch::default(), self.guest).href()
    }

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

/// A payment Checkout already confirmed with the card the buyer entered on the checkout page
/// (`isDeferredCheckoutPayment`): a Payment Intent with no client secret and no saved method, so
/// the page has no fields to draw and only says the provider is updating it.
pub fn deferred_checkout(payment: &AccountPayment) -> bool {
    payment.source_context.as_deref() == Some("checkout")
        && payment.processor_payment_kind == "payment-intent"
        && payment.processor_client_secret.is_none()
        && payment.saved_checkout_instrument_id.is_none()
}

/// Staff who may see a payment's provider details (`isInternalPaymentSupportActor`).
fn support_details(viewer: &Viewer) -> bool {
    viewer.actor.role_key == "platform-admin" && viewer.actor.can(crate::app::SUPPORT_MANAGE)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whose payment page it is: an account's, or a guest checkout's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Payer {
    Account,
    Guest,
}

impl Payer {
    fn guest(self) -> bool {
        self == Payer::Guest
    }
}

/// A refusal that means a guest's access is gone (`isAuthOrAuthorizationStatus` 401 or 403).
pub(crate) fn refused_access(error: &crate::api::ApiError) -> bool {
    matches!(error.status(), Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN))
}

/// What the page needs, read after `receipt`: the screen, or the page to answer instead.
#[allow(clippy::too_many_arguments)]
async fn read(
    req: &Req,
    viewer: &Viewer,
    payer: Payer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    receipt: Option<&Receipt>,
    until: u64,
) -> Result<PaymentScreen, Box<HtmlResult>> {
    let guest = payer.guest();
    let caller = config.platform.caller(headers, config.proto, receipt);
    let payment = match caller.account_payment_from_processor(id).await {
        Ok(Some(payment)) => payment,
        Ok(None) if receipt.is_some() => return Err(Box::new(preparing(req, viewer, payer))),
        Ok(None) => return Err(Box::new(not_found(req, viewer, payer))),
        Err(error) if receipt.is_some() && error.catching_up() => {
            return Err(Box::new(preparing(req, viewer, payer)));
        }
        Err(error) if guest && refused_access(&error) => return Err(Box::new(expired(req, Some(viewer)))),
        Err(error) => return Err(Box::new(read_failed(req, Some(viewer), error, None))),
    };
    let orders = match config.platform.caller(headers, config.proto, None).payment_orders(&payment.order_ids).await {
        Ok(orders) => orders,
        Err(error) if guest && refused_access(&error) => return Err(Box::new(expired(req, Some(viewer)))),
        Err(error) => return Err(Box::new(read_failed(req, Some(viewer), error, None))),
    };
    let watch = (payment.status == "pending-confirmation" && now() < until).then(|| {
        let watch = Watch { since: Some(payment.status.clone()), until: Some(until) };
        Watching { id: id.to_owned(), watch, guest }
    });
    Ok(PaymentScreen {
        defaults: defaults(&payment, &orders),
        support_details: support_details(viewer),
        guest,
        retry_error: None,
        after_write: receipt.map(Receipt::param),
        payment,
        orders,
        watch,
    })
}

/// The page, drawn from the screen, with `status`.
fn draw(req: &Req, viewer: &Viewer, screen: &PaymentScreen, status: StatusCode) -> HtmlResult {
    let t: PaymentMsg = req.t();
    let view = html! { <views::PaymentPage t={t} screen={screen} /> };
    let head = html! { <meta name="robots" content="noindex"> };
    let page = html! { <Layout req={req} viewer={Some(viewer)} title={t.payment_marketplace()} head={head}>{view}</Layout> };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

/// The payment's page, read after the write whose receipt it carries.
pub(crate) async fn page(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::payments::BuyerPayment<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let until = now() + WATCH_FOR.as_secs();
    match read(&req, &viewer, Payer::Account, &config, &headers, &id, receipt.as_ref(), until).await {
        Ok(screen) => draw(&req, &viewer, &screen, StatusCode::OK),
        Err(page) => *page,
    }
}

/// The status part (see the module): while the payment's status is the one the page was drawn
/// with and the watch has time left, an empty part read again shortly; once it changed, the page's
/// content drawn again. A read that answers with a page instead (the payment gone, a session that
/// ended) ends the watch with an empty part. Without JavaScript, the page.
#[allow(clippy::too_many_arguments)]
async fn watch_part<P: corten::Href>(
    req: &Req,
    viewer: &Viewer,
    payer: Payer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    watch: Watch,
    page: P,
) -> HtmlResult<Patches> {
    let caller = config.platform.caller(headers, config.proto, None);
    let until = watch.until.unwrap_or_default();
    // A read that fails ends the watch: the part stays as it is and the buyer can reload.
    let payment = match caller.account_payment(id).await {
        Ok(Some(payment)) => payment,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => {
            tracing::warn!("the payment's status could not be read: {error}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    };
    let back = || async { req.redirect(&page) };
    if watch.since.as_deref() == Some(payment.status.as_str()) {
        let from = WatchRoute::new(id, watch.clone(), payer.guest());
        let again = (now() < until).then_some(&from);
        return req.patch_or(views::PaymentWatch { again }, back).await;
    }
    let screen = match read(req, viewer, payer, config, headers, id, None, until).await {
        Ok(screen) => screen,
        Err(page) => return req.patch_or(views::PaymentWatch { again: None }, || async { *page }).await,
    };
    let t: PaymentMsg = req.t();
    req.patch_or(views::PaymentContent { t, screen: &screen }, back).await
}

pub(crate) async fn status(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::payments::BuyerPaymentStatus<'_>>,
) -> HtmlResult<Patches> {
    let page = url::BuyerPayment { id: &route.id, place: Place::default() };
    watch_part(&req, &viewer, Payer::Account, &config, &headers, &route.id, route.watch, page).await
}

/// Who is on a guest's payment page: the guest, or what to answer instead (an account goes to its
/// own payment page; anyone else is told the link is no longer good).
pub(crate) fn guest_payer(req: &Req, session: Option<Caller<Session>>, id: &str) -> Result<Viewer, Box<HtmlResult>> {
    match session.map(|Caller(session)| session) {
        Some(Session::Account(viewer)) if viewer.guest() => Ok(viewer),
        Some(Session::Account(_)) => Err(Box::new(req.redirect(&url::BuyerPayment { id, place: Place::default() }))),
        Some(Session::Unavailable) => Err(Box::new(Err(corten::Error::status(StatusCode::SERVICE_UNAVAILABLE)))),
        None => Err(Box::new(expired(req, None))),
    }
}

/// A guest checkout's payment page (`checkout-payment`), read after the write whose receipt it
/// carries. A claim link's landing goes on to the claim with the same query (see the module).
pub(crate) async fn guest_page(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::guest_payments::GuestPayment<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    if place.claim_continuation.as_deref().is_some_and(|c| !c.trim().is_empty()) {
        let GuestPlace { after_write, claim_continuation } = place;
        let place = crate::guest_claim::ClaimPlace { after_write, claim_continuation };
        return req.redirect(&url::GuestClaim { id: &id, place });
    }
    let viewer = match guest_payer(&req, session, &id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let until = now() + WATCH_FOR.as_secs();
    match read(&req, &viewer, Payer::Guest, &config, &headers, &id, receipt.as_ref(), until).await {
        Ok(screen) => draw(&req, &viewer, &screen, StatusCode::OK),
        Err(page) => *page,
    }
}

/// The guest page drawn again after Retry payment, `change`d (why it did not go through), with
/// `status`.
async fn redraw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    status: StatusCode,
    change: impl FnOnce(&mut PaymentScreen),
) -> HtmlResult {
    let until = now() + WATCH_FOR.as_secs();
    match read(req, viewer, Payer::Guest, config, headers, id, None, until).await {
        Ok(mut screen) => {
            change(&mut screen);
            draw(req, viewer, &screen, status)
        }
        Err(page) => *page,
    }
}

/// The guest page's form (the action's intent): Retry payment, which for a failed or closed
/// payment asks Payments for its orders' quote again and a new payment at it, then goes to the new
/// payment's page, read after it. A refusal is the page with why; an intent the page does not draw,
/// Save this order's among them (they post to the claim now), goes back to the page.
pub(crate) async fn guest_write(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::guest_payments::GuestPayment<'_>>,
    Form(form): Form<GuestForm>,
) -> HtmlResult {
    // Lent to each answer that draws the page, the refusals' closures among them.
    let id = route.id;
    let viewer = match guest_payer(&req, session, &id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    if form.intent != "retry-payment" {
        return req.redirect(&url::GuestPayment { id: &id, place: GuestPlace::default() });
    }
    let t: PaymentMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let failed = |message: String| {
        let (req, viewer, config, headers, id) = (&req, &viewer, &config, &headers, &id);
        redraw(req, viewer, config, headers, id, StatusCode::UNPROCESSABLE_ENTITY, move |screen| {
            screen.retry_error = Some(message)
        })
    };
    let payment = match caller.account_payment(&id).await {
        Ok(Some(payment)) => payment,
        Ok(None) => return not_found(&req, &viewer, Payer::Guest),
        Err(error) if refused_access(&error) => return expired(&req, Some(&viewer)),
        Err(error) => return failed(error.refusal().unwrap_or(t.could_not_retry_this_payment()).to_owned()).await,
    };
    if !matches!(payment.status.as_str(), "failed" | "cancelled") {
        return failed(t.this_payment_cannot_be_retried().to_owned()).await;
    }
    let recovered = async {
        let quote = caller.checkout_status(&payment).await?;
        let fingerprint = quote.marketplace_checkout_fee.quote_fingerprint;
        caller.recover_payment(&payment, &fingerprint, "/checkout/payments/:paymentId").await
    };
    match recovered.await {
        Ok((new, receipt)) => {
            let place = GuestPlace { after_write: receipt.as_ref().map(Receipt::param), ..GuestPlace::default() };
            req.redirect(&url::GuestPayment { id: &new.payment_id, place })
        }
        Err(error) if refused_access(&error) => expired(&req, Some(&viewer)),
        Err(error) => {
            tracing::warn!("Retry payment was refused: {error}");
            failed(error.refusal().unwrap_or(t.could_not_retry_this_payment()).to_owned()).await
        }
    }
}

/// A guest's status part (see `status`). Someone who is not the guest ends the watch with an empty
/// part; without JavaScript, they get the payment page's answer.
pub(crate) async fn guest_status(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::guest_payments::GuestPaymentStatus<'_>>,
) -> HtmlResult<Patches> {
    let viewer = match guest_payer(&req, session, &route.id) {
        Ok(viewer) => viewer,
        Err(answer) => return req.patch_or(views::PaymentWatch { again: None }, || async { *answer }).await,
    };
    let page = url::GuestPayment { id: &route.id, place: GuestPlace::default() };
    watch_part(&req, &viewer, Payer::Guest, &config, &headers, &route.id, route.watch, page).await
}

/// A payment the account does not have (marketplace's 404 with `payment.not.found`).
pub(crate) fn not_found(req: &Req, viewer: &Viewer, payer: Payer) -> HtmlResult {
    let t: PaymentMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        StatusCode::NOT_FOUND,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.payment_not_found()} head={head}>
                <views::PaymentNotice
                    t={t}
                    title={t.payment_not_found()}
                    says={t.payment_not_found_description()}
                    guest={payer.guest()}
                />
            </Layout>
        },
    )
}

/// A payment Payments has not caught up to after the write (marketplace's 503 Preparing payment):
/// a 202 the page reads again.
pub(crate) fn preparing(req: &Req, viewer: &Viewer, payer: Payer) -> HtmlResult {
    let t: PaymentMsg = req.t();
    let head = html! {
        <meta name="robots" content="noindex">
        {ReadAgain { after: WATCH_EVERY }}
    };
    req.page_with_status(
        StatusCode::ACCEPTED,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.payment_preparing()} head={head}>
                <views::PaymentNotice
                    t={t}
                    title={t.payment_preparing()}
                    says={t.payment_preparing_description()}
                    guest={payer.guest()}
                />
            </Layout>
        },
    )
}

/// A guest's payment link that is no longer good: no guest checkout, or one Payments refuses
/// (marketplace's 401 Guest checkout link expired).
pub(crate) fn expired(req: &Req, viewer: Option<&Viewer>) -> HtmlResult {
    let t: PaymentMsg = req.t();
    let p: Pilot = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        StatusCode::UNAUTHORIZED,
        html! {
            <Layout req={req} viewer={viewer} title={p.guest_payment_link_expired_title()} head={head}>
                <views::PaymentNotice
                    t={t}
                    title={p.guest_payment_link_expired_title()}
                    says={p.guest_payment_link_expired()}
                    guest={true}
                />
            </Layout>
        },
    )
}
