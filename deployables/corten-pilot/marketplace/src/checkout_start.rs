//! Checkout start (marketplace's `buy-checkout-readiness`, `/checkout/buy/readiness`:
//! `checkout-start.tsx`, its loader and action in `support/route-support/buy-checkout-readiness`,
//! and `features/sessions/ui/checkout-start-*`): where a checkout begins for one listing (Buy
//! now), an offer (a purchase intent) or the cart.
//!
//! The address names the entry (`sourceFromUrl`), and it is the one checkout starts from; a form's
//! fields are read only when the address names none. The page shows the entry and the checkout's
//! summary, and Continue to checkout for someone signed in or a guest checkout already running; a
//! visitor sees Sign in (and, for an offer, Register). Continue posts to the page's own address:
//!
//! 1. Signed in, or a guest checkout running: the guest cart the browser carries is moved into the
//!    account's (best effort), the session starts (the cart's from a fresh readiness snapshot), and
//!    the buyer goes to the checkout. A guest checkout whose guest access no longer matches gets a
//!    fresh guest identity and tries once more.
//! 2. A visitor: an offer needs an account; an empty guest cart is the page saying so; otherwise
//!    Auth starts a contact-less guest checkout, the session starts under it, and the browser keeps
//!    its token (`chase_sets_guest_checkout`) only once the session exists, the guest cart's cookie
//!    cleared. A 403 starts one fresh guest identity and tries once more.
//!
//! A refusal is the page with marketplace's recovery for it (`checkoutRecoveryForError`). The
//! item and listing pages' Buy for a guest or a visitor is this Continue (`buy_as_guest`):
//! marketplace's action re-sends the form here with a 307, and the pilot calls it instead, since a
//! Corten redirect is a 303 (a GET). Either goes on to the pilot's checkout page, which a guest
//! checkout's session reads too.
use std::collections::BTreeMap;

use corten::{
    axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    prelude::*,
    security::cookie,
};
use platform::{api::segment, receipt::Receipt};
use serde_json::{Value, json};

use crate::{
    api::{ApiError, Caller as ApiCaller, Checkout as _, CheckoutStart as _, Decisions, Entry, GuestCheckout, Started},
    app::{GUEST_CHECKOUT, Shared, read_failed, sign_in_back_to, url},
    auth::{Session, Viewer},
    cart::{ANONYMOUS_CART_COOKIE, anonymous_cart},
    checkout_entry::{self, Opened},
    items::Raw,
    listing_new::first,
    sign_in::GUEST_CHECKOUT_COOKIE,
    text::CheckoutMsg,
    views::{self, Layout},
};

/// The page's address.
pub const PATH: &str = "/checkout/buy/readiness";

/// How long the browser keeps a guest checkout's token when Auth does not say (`ONE_DAY_SECONDS`).
const GUEST_DEFAULT_SECONDS: i64 = 24 * 60 * 60;

/// Name to first value, from an address or a form.
pub type Pairs = BTreeMap<String, String>;

/// An address's query as name to first value (`URLSearchParams.get`).
pub fn query_pairs(query: Option<&str>) -> Pairs {
    let decode = |text: &str| {
        let text = text.replace('+', " ");
        percent_encoding::percent_decode_str(&text).decode_utf8_lossy().into_owned()
    };
    let mut pairs = Pairs::new();
    for part in query.unwrap_or_default().split('&').filter(|p| !p.is_empty()) {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        pairs.entry(decode(key)).or_insert_with(|| decode(value));
    }
    pairs
}

fn form_pairs(raw: &Raw) -> Pairs {
    raw.keys().map(|key| (key.clone(), first(raw, key))).collect()
}

/// What a checkout starts from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    BuyNow,
    OfferIntent,
}

/// A listing or an offer the checkout starts from (`CheckoutStartSource`), as its address or form
/// named it.
#[derive(Clone, Debug)]
pub struct Source {
    pub kind: Kind,
    pairs: Pairs,
}

impl Source {
    /// The entry `pairs` name (`source` is `buy-now` or `offer-intent`); `None` is the cart.
    pub fn read(pairs: &Pairs) -> Option<Source> {
        let kind = match pairs.get("source").map(String::as_str) {
            Some("buy-now") => Kind::BuyNow,
            Some("offer-intent") => Kind::OfferIntent,
            _ => return None,
        };
        Some(Source { kind, pairs: pairs.clone() })
    }

    /// The entry's fields, for Continue's form to send again.
    pub fn fields(&self) -> impl Iterator<Item = (&str, &str)> {
        self.pairs.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    fn text(&self, key: &str) -> &str {
        self.pairs.get(key).map_or("", String::as_str)
    }

    /// A value, `None` when empty (`|| null`).
    fn some(&self, key: &str) -> Option<&str> {
        Some(self.text(key)).filter(|v| !v.is_empty())
    }

    /// The first of `keys` that is there at all (`??`).
    fn either(&self, keys: &[&str]) -> &str {
        keys.iter().find_map(|k| self.pairs.get(*k)).map_or("", String::as_str)
    }

    pub fn title(&self) -> &str {
        self.text("itemTitle")
    }

    pub fn subtitle(&self) -> Option<&str> {
        self.some("itemSubtitle").or_else(|| self.some("productSummary"))
    }

    /// `parseQuantity`: a positive number, else 1.
    pub fn quantity(&self) -> f64 {
        let text = match self.kind {
            Kind::OfferIntent => self.either(&["quantity", "quantityRequested"]),
            Kind::BuyNow => self.text("quantity"),
        };
        let text = if text.trim().is_empty() { "1" } else { text.trim() };
        text.parse::<f64>().ok().filter(|q| q.is_finite() && *q > 0.0).unwrap_or(1.0)
    }

    /// The price and its currency: the offer's, or the listing's when the address names one.
    pub fn price(&self) -> Option<(&str, &str)> {
        match self.kind {
            Kind::OfferIntent => Some((
                self.either(&["offerPriceAmount", "priceAmount"]),
                self.either(&["offerPriceCurrencyCode", "priceCurrencyCode"]),
            )),
            Kind::BuyNow => self.some("priceAmount").zip(self.some("priceCurrencyCode")),
        }
    }

    /// The listing's seller; an offer's seller is not known yet.
    pub fn seller(&self) -> Option<&str> {
        (self.kind == Kind::BuyNow).then(|| self.some("sellerName")).flatten()
    }

    pub fn availability(&self) -> Option<&str> {
        self.some("availability")
    }

    pub fn fulfillment(&self) -> Option<&str> {
        self.some("fulfillment")
    }

    /// `parseSelectedOptions`: the `{dimensionId, optionId}` pairs, else none.
    fn options(&self) -> Value {
        let parsed: Value =
            serde_json::from_str(if self.text("selectedOptions").is_empty() { "[]" } else { self.text("selectedOptions") })
                .unwrap_or(Value::Null);
        let as_text = |v: &Value| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        let items = parsed.as_array().map_or(&[][..], Vec::as_slice);
        Value::Array(
            items
                .iter()
                .filter(|s| s.get("dimensionId").is_some() && s.get("optionId").is_some())
                .map(|s| json!({ "dimensionId": as_text(&s["dimensionId"]), "optionId": as_text(&s["optionId"]) }))
                .collect(),
        )
    }

    fn quantity_json(&self) -> Value {
        let q = self.quantity();
        if q.fract() == 0.0 && q < 9.0e15 { json!(q as u64) } else { json!(q) }
    }

    /// The session's `source`, as the Checkout API takes it.
    pub fn session(&self) -> Value {
        let or_null = |v: Option<&str>| v.map_or(Value::Null, |v| json!(v));
        match self.kind {
            Kind::OfferIntent => json!({
                "type": "offer-intent",
                "catalogItemId": self.text("catalogItemId"),
                "productId": self.text("productId"),
                "itemTitle": self.text("itemTitle"),
                "itemSubtitle": or_null(self.some("itemSubtitle")),
                "selectedOptions": self.options(),
                "productSummary": or_null(self.some("productSummary")),
                "offerPriceAmount": self.either(&["offerPriceAmount", "priceAmount"]),
                "offerPriceCurrencyCode": self.either(&["offerPriceCurrencyCode", "priceCurrencyCode"]),
                "quantity": self.quantity_json(),
            }),
            Kind::BuyNow => json!({
                "type": "buy-now",
                "listingId": self.text("listingId"),
                "fulfillmentMode": if self.text("fulfillmentMode") == "locked-listing" { "locked-listing" } else { "optimize" },
                "lockedListingId": or_null(self.some("lockedListingId")),
                "catalogItemId": self.text("catalogItemId"),
                "productId": self.text("productId"),
                "itemTitle": self.text("itemTitle"),
                "itemSubtitle": or_null(self.some("itemSubtitle")),
                "selectedOptions": self.options(),
                "productSummary": or_null(self.some("productSummary")),
                "quantity": self.quantity_json(),
                "priceAmount": or_null(self.some("priceAmount")),
                "priceCurrencyCode": or_null(self.some("priceCurrencyCode")),
                "sellerName": or_null(self.some("sellerName")),
                "availability": or_null(self.some("availability")),
                "fulfillment": or_null(self.some("fulfillment")),
            }),
        }
    }
}

/// Who is starting: an account, a guest checkout already running, or a visitor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    Account,
    Guest,
    Visitor,
}

fn who(session: Option<&Session>) -> Result<(Who, Option<&Viewer>), corten::Error> {
    match session {
        Some(Session::Account(viewer)) if viewer.actor.can(GUEST_CHECKOUT) => Ok((Who::Guest, Some(viewer))),
        Some(Session::Account(viewer)) => Ok((Who::Account, Some(viewer))),
        Some(Session::Unavailable) => Err(corten::Error::status(StatusCode::BAD_GATEWAY)),
        None => Ok((Who::Visitor, None)),
    }
}

/// Why a checkout did not start, as marketplace's recovery names it (`CheckoutRecoveryKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    AccessRequired,
    /// The entry's key was already used with other details, or the page's key is not one; nothing
    /// was started.
    AttemptChanged,
    CartEmpty,
    Closed,
    Preparing,
    GuestExpired,
    Validation,
    NotFound,
    WrongAccount,
}

impl Recovery {
    /// `checkoutRecoveryForError`.
    fn of(error: &ApiError, who: Who) -> Option<Recovery> {
        let code = error.code().unwrap_or_default();
        Some(match error.status()?.as_u16() {
            401 if who == Who::Visitor => Recovery::AccessRequired,
            401 => Recovery::GuestExpired,
            403 => match who {
                Who::Guest => Recovery::GuestExpired,
                Who::Visitor => Recovery::AccessRequired,
                Who::Account => Recovery::WrongAccount,
            },
            404 => Recovery::NotFound,
            409 if code == "checkout_attempt_conflict" => Recovery::AttemptChanged,
            503 if code == "checkout_closed" => Recovery::Closed,
            503 if code == "projection_freshness_timeout" => Recovery::Preparing,
            400 if code == "cart_empty" => Recovery::CartEmpty,
            400 if matches!(
                code,
                "readiness_snapshot_stale" | "split_group_handoff_stale" | "unresolved_fulfillment" | "validation_failed"
            ) =>
            {
                Recovery::Validation
            }
            _ => return None,
        })
    }

    /// The page's status with it (`CheckoutRecovery.status`; a refused form's 400 is a 422).
    fn status(self) -> StatusCode {
        match self {
            Recovery::AccessRequired | Recovery::GuestExpired => StatusCode::UNAUTHORIZED,
            Recovery::CartEmpty | Recovery::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            Recovery::Closed => StatusCode::SERVICE_UNAVAILABLE,
            Recovery::Preparing => StatusCode::ACCEPTED,
            Recovery::NotFound => StatusCode::NOT_FOUND,
            Recovery::AttemptChanged => StatusCode::CONFLICT,
            Recovery::WrongAccount => StatusCode::FORBIDDEN,
        }
    }
}

/// What the page says above the form after a refused start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Said {
    /// An offer needs an account.
    SignInRequired,
    Recovery(Recovery),
    /// The entry may have started a session, but neither its answer nor one lookup showed it:
    /// Continue is off, since the page's new key would start a second one.
    EntryAmbiguous,
}

/// The account's cart, when it is what checkout starts from.
pub struct CartState {
    pub ready: bool,
    /// The first thing the buyer may be told about a cart that is not ready.
    pub fact: Option<String>,
}

/// What the page shows.
pub struct StartScreen {
    pub who: Who,
    pub source: Option<Source>,
    pub cart: Option<CartState>,
    pub cart_count: u64,
    /// The key that makes Continue start one session however often it is sent.
    pub entry_key: String,
    /// The page's own address, which Continue posts to.
    pub here: String,
    pub sign_in: String,
    pub register: String,
    pub said: Option<Said>,
}

impl StartScreen {
    /// Continue to checkout is offered: someone who can check out, and an entry or a ready cart.
    pub fn can_continue(&self) -> bool {
        self.who != Who::Visitor && (self.source.is_some() || self.cart.as_ref().is_none_or(|c| c.ready))
    }

    pub fn offer(&self) -> bool {
        self.source.as_ref().is_some_and(|s| s.kind == Kind::OfferIntent)
    }

    pub fn entry_ambiguous(&self) -> bool {
        self.said == Some(Said::EntryAmbiguous)
    }
}

fn here(uri: &Uri) -> String {
    uri.path_and_query().map_or(PATH, |p| p.as_str()).to_owned()
}

fn new_entry_key() -> String {
    format!("chkentry_{}", ulid::Ulid::new())
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: Option<&Viewer>,
    uri: &Uri,
    who: Who,
    source: Option<Source>,
    cart: Option<CartState>,
    cart_count: u64,
    said: Option<Said>,
    status: StatusCode,
) -> HtmlResult {
    let t: CheckoutMsg = req.t();
    let here = here(uri);
    let sign_in = sign_in_back_to(&here).map_or_else(|| "/sign-in".to_owned(), |u| u.to_string());
    let register = format!("/register?returnTo={}", segment(&here));
    let screen = StartScreen { who, source, cart, cart_count, entry_key: new_entry_key(), here, sign_in, register, said };
    let head = html! { <meta name="robots" content="noindex"> };
    let page = html! {
        <Layout req={req} viewer={viewer} title={t.start_secure_checkout()} head={head}>
            <views::CheckoutStartPage t={t} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, for the entry its address names: the cart's readiness for an account, the guest
/// cart's count for a visitor.
pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let (who, viewer) = who(session.as_ref().map(|s| &s.0))?;
    let source = Source::read(&query_pairs(uri.query()));
    let caller = config.platform.caller(&headers, config.proto, None);
    let (cart, count) = match (&source, who) {
        (Some(_), _) => (None, 1),
        (None, Who::Account) => match caller.cart_readiness(&Decisions::default(), None).await {
            Ok(snapshot) => {
                let fact = snapshot.customer_safe_facts.first().cloned();
                (Some(CartState { ready: snapshot.status == "ready", fact }), snapshot.line_count)
            }
            Err(error) => return read_failed(&req, viewer, error, None),
        },
        (None, Who::Guest) => (None, 0),
        (None, Who::Visitor) => match caller.guest_cart_count(anonymous_cart(&headers)).await {
            Ok(count) => (None, count),
            Err(error) => return read_failed(&req, viewer, error, None),
        },
    };
    draw(&req, viewer, &uri, who, source, cart, count, None, StatusCode::OK).await
}

/// Starts the session with `caller`: the cart's from a fresh readiness snapshot (the guest cart
/// moved in first, best effort) read with the cart page's `decisions`, or the entry's; sent once
/// with the page's `key` (`openCheckoutSessionOnce`).
async fn begin(
    caller: &ApiCaller<'_>,
    source: Option<&Source>,
    key: Option<&str>,
    anonymous: Option<&str>,
    decisions: &Decisions,
) -> Result<Opened, ApiError> {
    let entry = match (source, key) {
        (Some(source), Some(key)) => Entry::source(key, &source.session()),
        // `refused_before_send` keeps a keyless entry from coming here.
        (Some(_), None) => unreachable!("an entry is only sent with its key"),
        (None, key) => {
            if let Some(id) = anonymous
                && let Err(error) = caller.merge_guest_cart(id).await
            {
                tracing::warn!("the guest cart was not merged before checkout: {error}");
            }
            let snapshot = caller.cart_readiness(decisions, anonymous).await?;
            Entry::cart(&snapshot, decisions, anonymous, key)
        }
    };
    checkout_entry::open_once(caller, &entry).await
}

/// A fresh guest identity and the session started under it.
async fn begin_as_guest(
    config: &Shared,
    headers: &HeaderMap,
    source: Option<&Source>,
    key: Option<&str>,
    anonymous: Option<&str>,
    decisions: &Decisions,
) -> Result<(Opened, GuestCheckout), ApiError> {
    let guest = config.platform.caller(headers, config.proto, None).start_guest_checkout().await?;
    let mut as_guest = HeaderMap::new();
    if let Some(host) = headers.get(header::HOST) {
        as_guest.insert(header::HOST, host.clone());
    }
    let cookie = format!("{GUEST_CHECKOUT_COOKIE}={}", segment(&guest.guest_token));
    as_guest.insert(
        header::COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| ApiError::Status {
            status: StatusCode::BAD_GATEWAY,
            code: None,
            message: "a guest token that is not a cookie value".into(),
        })?,
    );
    let caller = config.platform.caller(&as_guest, config.proto, None);
    Ok((begin(&caller, source, key, anonymous, decisions).await?, guest))
}

/// A cookie as this deployment sends them: `Secure` only over HTTPS.
fn secure(config: &Shared, cookie: cookie::SetCookie) -> cookie::SetCookie {
    if config.proto == "https" { cookie } else { cookie.insecure() }
}

/// Seconds until `expires_at`, at least 0; a day when Auth does not say.
fn guest_seconds(expires_at: &str) -> i64 {
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};
    match OffsetDateTime::parse(expires_at, &Rfc3339) {
        Ok(at) => ((at - OffsetDateTime::now_utc()).as_seconds_f64().ceil() as i64).max(0),
        Err(_) => GUEST_DEFAULT_SECONDS,
    }
}

/// The checkout page of a session that started, read after the start's receipt.
fn session_page<'a>(started: &'a Started, receipt: Option<&Receipt>) -> url::BuyCheckout<'a> {
    url::BuyCheckout { id: &started.session_id, place: crate::checkout::Place::started(receipt) }
}

/// The guest's token, kept for as long as Auth gives it.
fn keep_guest(config: &Shared, guest: &GuestCheckout) -> cookie::SetCookie {
    secure(config, cookie::SetCookie::new(GUEST_CHECKOUT_COOKIE, &guest.guest_token).max_age(guest_seconds(&guest.expires_at)))
}

/// Sends a guest whose session started to its checkout, keeping the guest's token and forgetting
/// the guest cart.
fn guest_started(req: &Req, config: &Shared, started: &Started, receipt: Option<&Receipt>, guest: &GuestCheckout) -> HtmlResult {
    Ok(req
        .redirect(&session_page(started, receipt))?
        .with_cookie(keep_guest(config, guest))
        .with_cookie(secure(config, cookie::SetCookie::remove(ANONYMOUS_CART_COOKIE))))
}

/// The answer forgetting the guest cart, once it has moved into the checkout.
fn forget_cart(res: corten::HtmlResponse, config: &Shared, anonymous: Option<&str>) -> corten::HtmlResponse {
    match anonymous {
        Some(_) => res.with_cookie(secure(config, cookie::SetCookie::remove(ANONYMOUS_CART_COOKIE))),
        None => res,
    }
}

/// Whether a guest's start refused for its access may start again with a fresh identity
/// (`canRecoverGuestCheckoutMismatch`).
fn may_start_again(source: Option<&Source>, anonymous: Option<&str>) -> bool {
    match source {
        Some(source) => source.kind == Kind::BuyNow,
        None => anonymous.is_some(),
    }
}

fn forbidden(error: &ApiError) -> bool {
    error.status() == Some(StatusCode::FORBIDDEN)
}

/// Continue to checkout: the session started and the buyer at its checkout, or the page with why
/// not.
pub(crate) async fn start(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    start_at(&req, session.as_deref(), &config, &headers, &uri, &form_pairs(&raw), &Decisions::default()).await
}

/// A guest's or a visitor's Buy on an item or a listing page: checkout start's Continue for the
/// entry `query` names, sent with the form's entry key, as marketplace's action re-sends the form
/// to checkout start (a 307). The page's address is checkout start's, so a refusal is that page.
pub(crate) async fn buy_as_guest(
    req: &Req,
    session: Option<&Session>,
    config: &Shared,
    headers: &HeaderMap,
    query: &str,
    entry: &str,
) -> HtmlResult {
    let uri: Uri = format!("{PATH}?{query}").parse().map_err(corten::Error::new)?;
    let posted = Pairs::from([("entryAttemptKey".to_owned(), entry.to_owned())]);
    start_at(req, session, config, headers, &uri, &posted, &Decisions::default()).await
}

/// The cart page's Check out for a guest or a visitor, whose cart has no checkout of its own
/// (marketplace's cart form posts to checkout start): Continue for the cart, with the lower-price
/// offer's `decisions` as the page drew it. A refusal is checkout start's page, at its address.
pub(crate) async fn cart_as_guest(
    req: &Req,
    session: Option<&Session>,
    config: &Shared,
    headers: &HeaderMap,
    decisions: &Decisions,
) -> HtmlResult {
    start_at(req, session, config, headers, &Uri::from_static(PATH), &Pairs::new(), decisions).await
}

/// Starts the checkout the entry at `uri` (or else the posted form) names, for whoever is asking;
/// a cart's with `decisions`. Each session is started as an account the request presents, and
/// sent once: a page whose key is missing or not one sends nothing (an entry other than the cart's
/// needs one), and an answer that may have been lost is looked up once, never sent again.
async fn start_at(
    req: &Req,
    session: Option<&Session>,
    config: &Shared,
    headers: &HeaderMap,
    uri: &Uri,
    posted: &Pairs,
    decisions: &Decisions,
) -> HtmlResult {
    let (who, viewer) = who(session)?;
    let source = Source::read(&query_pairs(uri.query())).or_else(|| Source::read(posted));
    let presented = posted.get("entryAttemptKey").map_or("", String::as_str);
    let key = checkout_entry::key(presented);
    let refused_before_send = checkout_entry::refused_before_send(presented, source.is_none());
    let anonymous = anonymous_cart(headers);
    let said = |who: Who, said: Said, status: StatusCode| {
        let source = source.clone();
        async move { draw(req, viewer, uri, who, source, None, 1, Some(said), status).await }
    };
    let refuse = |who: Who, error: ApiError| async move {
        match Recovery::of(&error, who) {
            Some(kind) => said(who, Said::Recovery(kind), kind.status()).await,
            None => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        }
    };
    let changed = || said(who, Said::Recovery(Recovery::AttemptChanged), Recovery::AttemptChanged.status());
    // A guest whose start was ambiguous keeps the guest it started as, so the page and a later
    // look are that guest's.
    let guest_ambiguous = |guest: GuestCheckout| async move {
        let res = said(Who::Guest, Said::EntryAmbiguous, StatusCode::OK).await?;
        Ok(res.with_cookie(keep_guest(config, &guest)))
    };
    if who != Who::Visitor {
        if refused_before_send {
            return changed().await;
        }
        let caller = config.platform.caller(headers, config.proto, None);
        return match begin(&caller, source.as_ref(), key, anonymous, decisions).await {
            Ok(Opened::Started(started, receipt)) => {
                let res = req.redirect(&session_page(&started, receipt.as_ref()))?;
                Ok(forget_cart(res, config, anonymous))
            }
            Ok(Opened::Ambiguous) => said(who, Said::EntryAmbiguous, StatusCode::OK).await,
            // A guest's access no longer matches: one fresh guest, which never recovers again.
            Err(error) if who == Who::Guest && forbidden(&error) && may_start_again(source.as_ref(), anonymous) => {
                match begin_as_guest(config, headers, source.as_ref(), key, anonymous, decisions).await {
                    Ok((Opened::Started(started, receipt), guest)) => {
                        guest_started(req, config, &started, receipt.as_ref(), &guest)
                    }
                    Ok((Opened::Ambiguous, guest)) => guest_ambiguous(guest).await,
                    Err(again) if forbidden(&again) => refuse(who, error).await,
                    Err(again) => refuse(who, again).await,
                }
            }
            Err(error) => refuse(who, error).await,
        };
    }
    if source.as_ref().is_some_and(|s| s.kind == Kind::OfferIntent) {
        return draw(req, None, uri, who, source, None, 1, Some(Said::SignInRequired), StatusCode::UNAUTHORIZED).await;
    }
    if refused_before_send {
        return changed().await;
    }
    if source.is_none() {
        let caller = config.platform.caller(headers, config.proto, None);
        match caller.guest_cart_count(anonymous).await {
            Ok(0) => {
                let said = Some(Said::Recovery(Recovery::CartEmpty));
                return draw(req, None, uri, who, None, None, 0, said, Recovery::CartEmpty.status()).await;
            }
            Ok(_) => {}
            Err(error) => return refuse(who, error).await,
        }
    }
    // A visitor starts as one new guest, and a refusal is the page's with no second guest
    // (marketplace's followed guest entry never recovers). The browser keeps no guest then, so the
    // page is still a visitor's.
    match begin_as_guest(config, headers, source.as_ref(), key, anonymous, decisions).await {
        Ok((Opened::Started(started, receipt), guest)) => guest_started(req, config, &started, receipt.as_ref(), &guest),
        Ok((Opened::Ambiguous, guest)) => guest_ambiguous(guest).await,
        Err(error) => refuse(who, error).await,
    }
}
