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
//! A paid guest order offers Save this order (the claim, `GuestClaimPrompt`): saving it to an
//! account with a passkey for the guest's contact email (the shared passkey step, as registration
//! creates one), or with a claim link Auth emails there. Its forms post to the page:
//!
//! | intent | Auth's call | then |
//! | --- | --- | --- |
//! | `claim-passkey` | `POST /api/auth/guest-checkout/claim-with-passkey` | signed in, at the account's payment |
//! | `claim-link-request` | `POST /api/auth/guest-checkout/claim-link/request` | the page, saying the link was sent |
//! | `claim-link-consume` | `POST /api/auth/guest-checkout/claim-with-magic-link` | signed in, at the account's payment |
//!
//! The last is the token typed by hand, offered only where `Config::claim_token_entry` shows it
//! (locally, without email). A claim link's landing (`?claimContinuation=`) claims with it
//! (`claim-with-continuation`) and signs in the same way, in any browser. Each claim ends the guest
//! checkout, so its cookie is cleared, and lands on the account's payment read after the claim.
//! Auth's claim calls need the platform's internal capability, which the server reads from
//! `PLATFORM_INTERNAL_AUTH_SECRET` (`platform::api::InternalAuth`) and sends on these calls only.
//!
//! Save this order is drawn only for a contact Auth reports bound. An unbound one, or a read Auth
//! refuses (it allows five an hour for each guest), leaves it off the page instead of failing the
//! page, and a sent link says so; marketplace's page does none of these
//! (chase-sets/chase-sets#11253). Until a checkout binds a guest's contact
//! (chase-sets/chase-sets#5736), no guest is offered it.
//!
//! Starting a payment again (`/account/payments/new`, where Retry payment goes) is `payment_start`.
//!
//! Not ported: restyling Stripe's fields when the color mode changes while the page is open.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use corten::{
    ClientIp,
    http::{HeaderMap, StatusCode, header},
    prelude::*,
};
use platform::{
    auth::{Authenticated, Credential, PASSKEY_LABEL, call_internal},
    receipt::Receipt,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
/// continuation, which the page claims the order with.
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct GuestPlace {
    pub after_write: Option<String>,
    pub claim_continuation: Option<String>,
}

/// The guest page's forms, named as marketplace's name them: Retry payment's
/// (`intent=retry-payment`) and Save this order's; a passkey's credential is the passkey step's.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct GuestForm {
    pub intent: String,
    pub display_name: String,
    /// The contact's email, which the passkey step creates the passkey for.
    pub email: String,
    /// A claim link's token, typed by hand.
    pub token: String,
    pub challenge_id: String,
    pub challenge: String,
    pub external_credential_id: String,
    pub webauthn_response: String,
}

impl GuestForm {
    /// The passkey's credential, as the passkey step filled it in.
    fn credential(&self) -> Credential<'_> {
        Credential {
            challenge_id: &self.challenge_id,
            challenge: &self.challenge,
            external_credential_id: &self.external_credential_id,
            webauthn_response: &self.webauthn_response,
        }
    }
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
    /// Save this order, for a paid guest order whose contact Auth reports bound.
    pub claim: Option<Claim>,
    /// Why the last claim did not save the order.
    pub claim_error: Option<String>,
    /// That a claim link was sent, when the contact could not be read again to say where.
    pub claim_sent: Option<String>,
    /// The status part to read while the payment waits for the buyer.
    #[serde(skip)]
    pub watch: Option<Watching>,
}

/// Save this order (`GuestClaimPrompt`): the guest's bound contact, and what the last claim form
/// left.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub contact_email: String,
    pub contact_name: String,
    /// The name the passkey is created for: the contact's, or the one typed.
    pub display_name: String,
    /// That a claim link was sent, in the page's words.
    pub link_sent: Option<String>,
    /// The link's token, to type by hand where `Config::claim_token_entry` shows it.
    pub token: Option<String>,
}

/// Auth's claim context (`POST /api/auth/guest-checkout/claim-context`): the guest's contact, both
/// parts null until a checkout binds it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimContext {
    contact_email: Option<String>,
    contact_name: Option<String>,
}

/// A claim link Auth sent (`claim-link/request`): its token, which the page shows only where it is
/// typed by hand.
#[derive(Deserialize)]
struct LinkSent {
    token: String,
}

/// The status part a page watches: the payment and the watch's query.
pub struct Watching {
    pub id: String,
    pub watch: Watch,
    pub guest: bool,
    /// The address, for the step's script once Stripe confirms.
    pub href: String,
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

/// Whose payment page it is: an account's, or a guest checkout's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Payer {
    Account,
    Guest,
}

impl Payer {
    fn guest(self) -> bool {
        self == Payer::Guest
    }
}

/// A refusal that means a guest's access is gone (`isAuthOrAuthorizationStatus` 401 or 403).
fn refused_access(error: &crate::api::ApiError) -> bool {
    matches!(error.status(), Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN))
}

/// Save this order for a paid guest order: Auth's bound contact (`getGuestCheckoutClaimContext`,
/// with the internal capability). An unbound contact, or a read Auth refuses or never answers,
/// leaves Save this order off the page rather than failing it (chase-sets/chase-sets#11253).
async fn claim_context(config: &Shared, headers: &HeaderMap, client: Option<ClientIp>, id: &str) -> Option<Claim> {
    let caller = config.platform.caller(headers, config.proto, None);
    let body = json!({ "paymentId": id });
    let context = match call_internal::<ClaimContext>(&caller, client, "/api/auth/guest-checkout/claim-context", body).await {
        Ok((context, _)) => context,
        Err(error) => {
            tracing::warn!("a guest's claim context could not be read: {error}");
            return None;
        }
    };
    let bound = |part: Option<String>| part.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
    let (contact_email, contact_name) = (bound(context.contact_email)?, bound(context.contact_name)?);
    Some(Claim { display_name: contact_name.clone(), contact_email, contact_name, ..Claim::default() })
}

/// Why a claim (`intent`) was refused, in the page's words. Auth answers a passkey whose challenge
/// it cannot verify, and a spent or unknown link, with a 401 whose body is no error envelope; any
/// other refusal says its envelope's message, and the rest that the order could not be saved.
fn claim_refusal(req: &Req, intent: &str, error: &crate::api::ApiError) -> String {
    let (t, p): (PaymentMsg, Pilot) = (req.t(), req.t());
    match (error.status(), error.refusal()) {
        (Some(StatusCode::UNAUTHORIZED), _) if intent == "claim-passkey" => t.passkey_registration_failed().to_owned(),
        (Some(StatusCode::UNAUTHORIZED), _) if intent == "claim-link-consume" => p.guest_claim_link_expired().to_owned(),
        (_, Some(message)) => message.to_owned(),
        _ => {
            tracing::warn!("a guest claim failed: {error}");
            t.could_not_save_this_order().to_owned()
        }
    }
}

/// A claim that signed the guest in (`completeBrowserAuthentication` to `/account/payments/{id}`):
/// the account's payment, read after the claim, with the guest checkout's cookie cleared.
fn claimed(req: &Req, config: &Shared, id: &str, result: Authenticated, receipt: Option<&Receipt>) -> HtmlResult {
    let to = url::BuyerPayment { id, place: Place { after_write: receipt.map(Receipt::param) } }.href();
    crate::sign_in::complete_claim(req, config, &to, result)
}

/// What the page needs, read after `receipt`: the screen, or the page to answer instead.
#[allow(clippy::too_many_arguments)]
async fn read(
    req: &Req,
    viewer: &Viewer,
    payer: Payer,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    receipt: Option<&Receipt>,
    until: u64,
) -> Result<PaymentScreen, Box<HtmlResult>> {
    let guest = payer.guest();
    let caller = config.platform.caller(headers, config.proto, receipt);
    let payment = match caller.account_payment(id).await {
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
        let href = WatchRoute::new(id, watch.clone(), guest).href();
        Watching { id: id.to_owned(), watch, guest, href }
    });
    let claim = if guest && payment.status == "captured" { claim_context(config, headers, client, id).await } else { None };
    Ok(PaymentScreen {
        defaults: defaults(&payment, &orders),
        support_details: support_details(viewer),
        guest,
        retry_error: None,
        claim,
        claim_error: None,
        claim_sent: None,
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
    match read(&req, &viewer, Payer::Account, &config, &headers, None, &id, receipt.as_ref(), until).await {
        Ok(screen) => draw(&req, &viewer, &screen, StatusCode::OK),
        Err(page) => *page,
    }
}

/// The status part (see the module): while the payment's status is the one the page was drawn
/// with and the watch has time left, an empty part read again shortly; once it changed, the page's
/// content drawn again. Without JavaScript, the page.
#[allow(clippy::too_many_arguments)]
async fn watch_part<P: corten::Href>(
    req: &Req,
    viewer: &Viewer,
    payer: Payer,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    watch: Watch,
    page: P,
) -> HtmlResult {
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
    let screen = match read(req, viewer, payer, config, headers, client, id, None, until).await {
        Ok(screen) => screen,
        Err(page) => return *page,
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
) -> HtmlResult {
    let page = url::BuyerPayment { id: &route.id, place: Place::default() };
    watch_part(&req, &viewer, Payer::Account, &config, &headers, None, &route.id, route.watch, page).await
}

/// Who is on a guest's payment page: the guest, or what to answer instead (an account goes to its
/// own payment page; anyone else is told the link is no longer good).
fn guest_payer(req: &Req, session: Option<Caller<Session>>, id: &str) -> Result<Viewer, Box<HtmlResult>> {
    match session.map(|Caller(session)| session) {
        Some(Session::Account(viewer)) if viewer.guest() => Ok(viewer),
        Some(Session::Account(_)) => Err(Box::new(req.redirect(&url::BuyerPayment { id, place: Place::default() }))),
        Some(Session::Unavailable) => Err(Box::new(Err(corten::Error::status(StatusCode::SERVICE_UNAVAILABLE)))),
        None => Err(Box::new(expired(req, None))),
    }
}

/// A guest checkout's payment page (`checkout-payment`), read after the write whose receipt it
/// carries. A claim link's landing claims the order with it (see the module).
pub(crate) async fn guest_page(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::guest_payments::GuestPayment<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    if let Some(continuation) = place.claim_continuation.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        return claim_with_link(&req, session, &config, &headers, client, &id, continuation).await;
    }
    let viewer = match guest_payer(&req, session, &id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let until = now() + WATCH_FOR.as_secs();
    match read(&req, &viewer, Payer::Guest, &config, &headers, client, &id, receipt.as_ref(), until).await {
        Ok(screen) => draw(&req, &viewer, &screen, StatusCode::OK),
        Err(page) => *page,
    }
}

/// A claim link's landing (`claimGuestCheckoutWithClaimContinuation`): signed in at the account's
/// payment, told the link is no longer good, or, when Auth limits the link's tries (429), told to
/// wait. The link may be opened in any browser, so no guest checkout is needed.
async fn claim_with_link(
    req: &Req,
    session: Option<Caller<Session>>,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    continuation: &str,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let body = json!({ "continuation": continuation, "paymentId": id });
    let path = "/api/auth/guest-checkout/claim-with-continuation";
    let error = match call_internal::<Authenticated>(&caller, client, path, body).await {
        Ok((result, receipt)) => return claimed(req, config, id, result, receipt.as_ref()),
        Err(error) => error,
    };
    let viewer = match session {
        Some(Caller(Session::Account(viewer))) => Some(viewer),
        _ => None,
    };
    let (t, p): (PaymentMsg, Pilot) = (req.t(), req.t());
    let (status, title, says) = match error.status() {
        Some(StatusCode::UNAUTHORIZED | StatusCode::BAD_REQUEST) => {
            (StatusCode::UNAUTHORIZED, p.guest_claim_link_expired_title(), p.guest_claim_link_expired())
        }
        Some(StatusCode::TOO_MANY_REQUESTS) => {
            (StatusCode::TOO_MANY_REQUESTS, p.guest_claim_link_rate_limited_title(), p.guest_claim_link_rate_limited())
        }
        _ => return read_failed(req, viewer.as_ref(), error, None),
    };
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={viewer.as_ref()} title={title} head={head}>
                <views::PaymentNotice t={t} title={title} says={says} guest={true} />
            </Layout>
        },
    )
}

/// The guest page drawn again after one of its forms, `change`d (why it did not go through, or
/// Save this order's state), with `status`.
#[allow(clippy::too_many_arguments)]
async fn redraw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    status: StatusCode,
    change: impl FnOnce(&mut PaymentScreen),
) -> HtmlResult {
    let until = now() + WATCH_FOR.as_secs();
    match read(req, viewer, Payer::Guest, config, headers, client, id, None, until).await {
        Ok(mut screen) => {
            change(&mut screen);
            draw(req, viewer, &screen, status)
        }
        Err(page) => *page,
    }
}

/// The guest page's forms (the action's intents): Retry payment, which for a failed or closed
/// payment asks Payments for its orders' quote again and a new payment at it, then goes to the new
/// payment's page, read after it; and Save this order's claims (see the module). A refusal is the
/// page with why; an intent the page does not draw goes back to the page.
pub(crate) async fn guest_write(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::guest_payments::GuestPayment<'_>>,
    Form(form): Form<GuestForm>,
) -> HtmlResult {
    // Lent to each answer that draws the page, the refusals' closures among them.
    let id = route.id;
    let viewer = match guest_payer(&req, session, &id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    let t: PaymentMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let retry = form.intent == "retry-payment";
    if !retry && !matches!(form.intent.as_str(), "claim-link-request" | "claim-link-consume" | "claim-passkey") {
        return req.redirect(&url::GuestPayment { id: &id, place: GuestPlace::default() });
    }
    let failed = |message: String| {
        let (req, viewer, config, headers, id) = (&req, &viewer, &config, &headers, &id);
        redraw(req, viewer, config, headers, client, id, StatusCode::UNPROCESSABLE_ENTITY, move |screen| {
            if retry { screen.retry_error = Some(message) } else { screen.claim_error = Some(message) }
        })
    };
    let payment = match caller.account_payment(&id).await {
        Ok(Some(payment)) => payment,
        Ok(None) => return not_found(&req, &viewer, Payer::Guest),
        Err(error) if refused_access(&error) => return expired(&req, Some(&viewer)),
        Err(error) => {
            let fallback = if retry { t.could_not_retry_this_payment() } else { t.could_not_save_this_order() };
            return failed(error.refusal().unwrap_or(fallback).to_owned()).await;
        }
    };
    if retry {
        if !matches!(payment.status.as_str(), "failed" | "cancelled") {
            return failed(t.this_payment_cannot_be_retried().to_owned()).await;
        }
        let recovered = async {
            let quote = caller.checkout_status(&payment).await?;
            let fingerprint = quote.marketplace_checkout_fee.quote_fingerprint;
            caller.recover_payment(&payment, &fingerprint, "/checkout/payments/:paymentId").await
        };
        return match recovered.await {
            Ok((new, receipt)) => {
                let place = GuestPlace { after_write: receipt.as_ref().map(Receipt::param), ..GuestPlace::default() };
                req.redirect(&url::GuestPayment { id: &new.payment_id, place })
            }
            Err(error) if refused_access(&error) => expired(&req, Some(&viewer)),
            Err(error) => {
                tracing::warn!("Retry payment was refused: {error}");
                failed(error.refusal().unwrap_or(t.could_not_retry_this_payment()).to_owned()).await
            }
        };
    }
    if payment.status != "captured" {
        return failed(t.you_can_save_this_order_after_payment().to_owned()).await;
    }
    let display_name = form.display_name.trim().to_owned();
    let claim = match form.intent.as_str() {
        "claim-link-request" => {
            // The page's origin, which the emailed link opens (Auth falls back to the site's).
            let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
            let origin = host.map(|host| format!("{}://{host}", config.proto));
            let body = json!({ "paymentId": id, "origin": origin });
            let path = "/api/auth/guest-checkout/claim-link/request";
            return match call_internal::<LinkSent>(&caller, client, path, body).await {
                Ok((sent, _)) => {
                    let p: Pilot = req.t();
                    let token = config.claim_token_entry.then_some(sent.token);
                    redraw(&req, &viewer, &config, &headers, client, &id, StatusCode::OK, move |screen| {
                        match &mut screen.claim {
                            Some(claim) => {
                                claim.link_sent = Some(p.guest_claim_link_sent(&claim.contact_email).to_string());
                                claim.token = token;
                                if !display_name.is_empty() {
                                    claim.display_name = display_name;
                                }
                            }
                            // Auth sent the link but the contact's read after it failed.
                            None => screen.claim_sent = Some(p.guest_claim_link_sent_unread().to_owned()),
                        }
                    })
                    .await
                }
                Err(error) => failed(claim_refusal(&req, "claim-link-request", &error)).await,
            };
        }
        "claim-link-consume" if !config.claim_token_entry => {
            return failed(t.claim_token_entry_is_not_available().to_owned()).await;
        }
        "claim-link-consume" => {
            let body = json!({ "token": form.token.trim(), "paymentId": id, "displayName": display_name });
            call_internal::<Authenticated>(&caller, client, "/api/auth/guest-checkout/claim-with-magic-link", body).await
        }
        // No credential: the step's script did not run, or the browser has no passkeys.
        _ if form.credential().is_missing() => return failed(t.passkey_registration_failed().to_owned()).await,
        _ => {
            let mut body = form.credential().json();
            body.insert("displayName".into(), display_name.into());
            body.insert("email".into(), form.email.trim().into());
            body.insert("paymentId".into(), json!(id));
            body.insert("label".into(), PASSKEY_LABEL.into());
            let path = "/api/auth/guest-checkout/claim-with-passkey";
            call_internal::<Authenticated>(&caller, client, path, Value::Object(body)).await
        }
    };
    match claim {
        Ok((result, receipt)) => claimed(&req, &config, &id, result, receipt.as_ref()),
        Err(error) => failed(claim_refusal(&req, &form.intent, &error)).await,
    }
}

/// A guest's status part (see `status`).
pub(crate) async fn guest_status(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::guest_payments::GuestPaymentStatus<'_>>,
) -> HtmlResult {
    let viewer = match guest_payer(&req, session, &route.id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    let page = url::GuestPayment { id: &route.id, place: GuestPlace::default() };
    watch_part(&req, &viewer, Payer::Guest, &config, &headers, client, &route.id, route.watch, page).await
}

/// A payment the account does not have (marketplace's 404 with `payment.not.found`).
fn not_found(req: &Req, viewer: &Viewer, payer: Payer) -> HtmlResult {
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
fn preparing(req: &Req, viewer: &Viewer, payer: Payer) -> HtmlResult {
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
fn expired(req: &Req, viewer: Option<&Viewer>) -> HtmlResult {
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
