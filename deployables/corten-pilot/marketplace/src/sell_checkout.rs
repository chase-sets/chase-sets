//! Seller checkout (Checkout's `sell-checkout-session`, at `/checkout/sell/session/{id}`, and its
//! `sell-checkout-confirmation`): the review the Sell List's Continue starts from a readiness snapshot,
//! and the saved confirmation after it.
//!
//! An account's page reads the Sell List, the saved ship-from addresses and the payout readiness,
//! and the review Checkout kept with the snapshot in its address (its readiness, review plan and
//! decisions, `POST /sell-list/readiness` with the snapshot): a list changed since, or one that is
//! not ready, is a recovery that sends the seller back to the Sell List. Confirming (one form)
//! checks the fields, then does what marketplace's route does: the seller's ship-from and label
//! choices with the seller confirmation evidence sent for readiness (Checkout reads risk,
//! fulfillment and the payout estimate from their owners with the choices, and checks them again
//! before it confirms), and `POST /sell-list/confirm` with the same choices. Checkout's confirm
//! checks the kept plan against the snapshot and runs the Marketplace handoff (each selected offer
//! and Smart Match target accepted, each fallback listing created and published, with keys derived
//! from the confirmation, so a resent form replays). The confirmation page is read after the
//! confirm's write and the handoff's.
//!
//! A confirm converges as marketplace's does (chase-sets/chase-sets#9995): a confirmation saved
//! already is looked for first; readiness names the confirmation and the snapshot the page started
//! from; a handoff Checkout reports stopped part way (`checkout_handoff_interrupted`) draws the
//! page with each line's result, its form held and the same form to send again (409); and a
//! confirm whose answer was lost is looked up, the page held the same way when it is not found.
//!
//! A guest's page is the same review of the guest sell list; confirming checks the fields and goes
//! to marketplace's registration, back to the Sell List.
//!
//! One step is marketplace's web layer's, copied here until the API has it: the seller evidence
//! ([chase-sets/chase-sets#10753](https://github.com/chase-sets/chase-sets/issues/10753)).
//! Not ported: marketplace's preview hooks (`recovery`, `payoutState`, `riskState` and the other
//! `*State` query parameters and hidden fields), which only force a state.
use std::collections::BTreeMap;

use corten::{
    http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use platform::{money, receipt::Receipt};
use serde_json::json;

use crate::{
    api::{
        ApiError, CheckoutSessions as _, ConfirmError, EvidenceLabel, EvidencePayout, EvidenceShipFrom, EvidenceStatus,
        LabelChoice, ReadinessDecisions, ReadinessEntry, SavedAddress, SellList as _, SellListConfirmation, SellListReview,
        SellListRow, SellListSnapshot, SellPayoutReadiness, SellerChoices, SellerEvidence, ShipFromChoice,
    },
    app::{Shared, read_failed, sign_in_back_to, url},
    auth::Session,
    cart_attempt::{self, State as Attempted},
    items::Raw,
    listing_new::first,
    sell_list::{self, guest_id},
    selling::account_sell_list,
    text::SellCheckoutMsg,
    views::{self, Layout},
};

/// The address the Sell List's Continue writes: the snapshot Checkout kept the review with, and
/// the review write's receipt.
#[derive(Clone, Debug, Default, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub readiness_snapshot_id: Option<String>,
    pub readiness_source_revision: Option<String>,
    pub after_write: Option<String>,
}

/// The confirmation's address: the confirm's receipt.
#[derive(Clone, Debug, Default, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct ConfirmationPlace {
    pub after_write: Option<String>,
}

/// Why seller checkout cannot go on (`SellCheckoutRecovery`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recovery {
    MissingSellList,
    EmptySellList,
    ReadinessRequired,
    /// The list changed; with the reason when there is one.
    ReadinessStale(Option<String>),
    ReadinessBlocked,
}

/// The account's payout setup as the page shows it (`SignedInSellCheckoutPayoutSummary`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payout {
    Ready,
    /// Not set up: its status and what is missing.
    NeedsSetup {
        status: String,
        missing: Vec<String>,
    },
    Unavailable,
}

impl Payout {
    fn of(read: Result<SellPayoutReadiness, ApiError>) -> Self {
        match read {
            Ok(r) if r.status == "ready" => Payout::Ready,
            Ok(r) => Payout::NeedsSetup { status: r.status, missing: r.missing_requirements },
            Err(error) => {
                tracing::warn!("payout readiness: {error}");
                Payout::Unavailable
            }
        }
    }

    pub fn ready(&self) -> bool {
        *self == Payout::Ready
    }

    fn status(&self) -> &str {
        match self {
            Payout::Ready => "ready",
            Payout::NeedsSetup { status, .. } => status,
            Payout::Unavailable => "unavailable",
        }
    }
}

/// What the seller entered (`SignedInSellCheckoutFormValues`, `GuestSellCheckoutFormValues`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Values {
    pub seller_name: String,
    pub email: String,
    pub phone: String,
    /// A saved address's id, or `__manual`.
    pub ship_from_address_id: String,
    pub ship_from_name: String,
    pub company: String,
    pub line1: String,
    pub line2: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    /// An account's: `saved-payout` or `setup-payout`.
    pub payout_method: String,
    /// A guest's: `create-account`.
    pub payout_handoff: String,
    /// `prepaid-label` or `seller-label-later`.
    pub label_preference: String,
    pub terms_accepted: bool,
}

pub const MANUAL: &str = "__manual";

impl Default for Values {
    fn default() -> Self {
        Values {
            seller_name: String::new(),
            email: String::new(),
            phone: String::new(),
            ship_from_address_id: MANUAL.into(),
            ship_from_name: String::new(),
            company: String::new(),
            line1: String::new(),
            line2: String::new(),
            city: String::new(),
            state: String::new(),
            postal_code: String::new(),
            country: "US".into(),
            payout_method: "saved-payout".into(),
            payout_handoff: "create-account".into(),
            label_preference: "prepaid-label".into(),
            terms_accepted: false,
        }
    }
}

impl Values {
    /// The posted form, as marketplace's route reads it (trimmed; the email lowercased, the state
    /// and country uppercased, the country US when empty).
    pub fn read(raw: &Raw) -> Self {
        let f = |name: &str| first(raw, name);
        let or = |name: &str, default: &str| Some(f(name)).filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_owned());
        Values {
            seller_name: f("sellerName"),
            email: f("email").to_lowercase(),
            phone: f("phone"),
            ship_from_address_id: or("shipFromAddressId", MANUAL),
            ship_from_name: f("shipFromName"),
            company: f("company"),
            line1: f("shipFromLine1"),
            line2: f("shipFromLine2"),
            city: f("shipFromCity"),
            state: f("shipFromState").to_uppercase(),
            postal_code: f("shipFromPostalCode"),
            country: or("shipFromCountry", "US").to_uppercase(),
            payout_method: or("payoutMethod", "saved-payout"),
            payout_handoff: f("payoutHandoff"),
            label_preference: f("labelPreference"),
            terms_accepted: f("termsAccepted") == "accepted",
        }
    }

    /// An account's defaults: the default saved address (else the first), its contact too.
    fn account_defaults(addresses: &[SavedAddress]) -> Self {
        let mut values = Values::default();
        if let Some(a) = addresses.iter().find(|a| a.is_default).or(addresses.first()) {
            values.seller_name = a.recipient_name.clone();
            values.email = a.email.clone().unwrap_or_default();
            values.phone = a.phone.clone().unwrap_or_default();
            values.ship_from_address_id = a.shipping_address_id.clone();
            values.use_address(a);
        }
        values
    }

    fn use_address(&mut self, a: &SavedAddress) {
        self.ship_from_name = a.recipient_name.clone();
        self.company = a.company.clone().unwrap_or_default();
        self.line1 = a.line1.clone();
        self.line2 = a.line2.clone().unwrap_or_default();
        self.city = a.city.clone();
        self.state = a.state.clone();
        self.postal_code = a.postal_code.clone();
        self.country = if a.country.is_empty() { "US".into() } else { a.country.clone() };
    }

    /// A chosen saved address's fields replace the typed ones (`applySelectedSavedShipFromAddress`).
    fn with_saved(mut self, addresses: &[SavedAddress]) -> Self {
        if let Some(a) = addresses.iter().find(|a| a.shipping_address_id == self.ship_from_address_id) {
            self.use_address(a);
        }
        self
    }

    pub fn contact_ready(&self) -> bool {
        !self.seller_name.is_empty() && email_ok(&self.email)
    }

    pub fn ship_from_ready(&self) -> bool {
        [&self.ship_from_name, &self.line1, &self.city, &self.state, &self.postal_code, &self.country]
            .iter()
            .all(|v| !v.trim().is_empty())
    }
}

/// `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`.
fn email_ok(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else { return false };
    let clean = |s: &str| !s.is_empty() && !s.contains('@') && !s.chars().any(char::is_whitespace);
    clean(local) && clean(domain) && domain.char_indices().any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// Ship-from regions seller checkout does not serve yet.
const UNSUPPORTED_STATES: &[&str] = &["AA", "AE", "AP", "AS", "FM", "GU", "MH", "MP", "PR", "PW", "VI"];

/// A field's refusal, by the field's name; `form` is the whole form's.
pub type Errors = BTreeMap<&'static str, String>;

/// `validateSignedInSellCheckoutValues` and `validateGuestSellCheckoutValues`, without the preview hooks.
pub fn validate(t: SellCheckoutMsg, values: &Values, account: bool) -> Errors {
    let mut e = Errors::new();
    let mut put = |field: &'static str, message: &str| {
        e.insert(field, message.to_owned());
    };
    if values.seller_name.is_empty() {
        put("sellerName", t.route_validation_seller_name_required());
    }
    if !email_ok(&values.email) {
        put("email", t.route_validation_email_required());
    }
    if values.ship_from_name.is_empty() {
        put("shipFromName", t.route_validation_ship_from_name_required());
    }
    if values.line1.is_empty() {
        put("shipFromLine1", t.route_validation_address_line1_required());
    }
    if values.city.is_empty() {
        put("shipFromCity", t.route_validation_city_required());
    }
    if values.state.is_empty() {
        put("shipFromState", t.route_validation_state_required());
    } else if UNSUPPORTED_STATES.contains(&values.state.as_str()) {
        let m = if account { t.route_validation_signed_in_state_unsupported() } else { t.route_validation_state_unsupported() };
        put("shipFromState", m);
    }
    if values.postal_code.is_empty() {
        put("shipFromPostalCode", t.route_validation_postal_code_required());
    }
    if values.country != "US" {
        let m =
            if account { t.route_validation_signed_in_country_unsupported() } else { t.route_validation_country_unsupported() };
        put("shipFromCountry", m);
    }
    if account {
        if values.payout_method != "saved-payout" && values.payout_method != "setup-payout" {
            put("payoutMethod", t.route_validation_payout_method_required());
        }
    } else if values.payout_handoff != "create-account" {
        put("payoutHandoff", t.route_validation_payout_handoff_required());
    }
    if values.label_preference != "prepaid-label" && values.label_preference != "seller-label-later" {
        put("labelPreference", t.route_validation_label_preference_required());
    }
    if !values.terms_accepted {
        put("termsAccepted", t.route_validation_terms_required());
    }
    e
}

/// The page's view model.
#[derive(Clone, Debug)]
pub struct Screen {
    pub session_id: String,
    pub account: bool,
    /// The lines seller checkout takes (all of them while it cannot go on).
    pub lines: Vec<SellListRow>,
    pub readiness: Option<SellListSnapshot>,
    pub recovery: Option<Recovery>,
    pub values: Values,
    pub errors: Errors,
    pub addresses: Vec<SavedAddress>,
    pub payout: Option<Payout>,
    /// The readiness decisions Checkout kept with an account's snapshot (with its review plan,
    /// which Checkout's confirm runs).
    pub decisions: Option<ReadinessDecisions>,
    /// The last confirm, when it is not known to have finished or finished in part.
    pub attempt: Option<Attempt>,
}

/// A confirm not known to have finished, or finished only in part (marketplace's
/// `SellListAttemptState`): each line's result, and the form as posted to send again. The page's
/// form waits until it is.
#[derive(Clone, Debug)]
pub struct Attempt {
    /// `Ambiguous` or `Partial`.
    pub state: Attempted,
    pub lines: Vec<(String, LineResult)>,
    pub resend: Vec<(String, String)>,
}

/// What a line came to when the handoff stopped (`SellListHandoffLineResult`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineResult {
    Completed,
    Partial,
    /// Its offer was accepted, but not as this sale's.
    Conflict,
    /// Its write failed or its answer was lost: not known.
    Unconfirmed,
    /// Not sent: an earlier line stopped the handoff.
    NotSent,
}

impl LineResult {
    /// A line's result as Checkout reports it: `ambiguous`, or any other it does not name here,
    /// is not known.
    fn of(status: &str) -> Self {
        match status {
            "completed" => LineResult::Completed,
            "partial" => LineResult::Partial,
            "conflict" => LineResult::Conflict,
            "not-attempted" | "skipped" => LineResult::NotSent,
            _ => LineResult::Unconfirmed,
        }
    }
}

impl Screen {
    /// The estimated payout in cents (`totalLineValue`): each line's offer price, else its minimum
    /// listing price, times its quantity.
    pub fn total(&self) -> i64 {
        self.lines.iter().map(line_value).sum()
    }
}

/// A line's value in cents (`lineValue`).
pub fn line_value(line: &SellListRow) -> i64 {
    let price = line.offer_price_amount.as_deref().or(line.minimum_listing_price_amount.as_deref());
    let cents = price.and_then(money::cents).unwrap_or(0);
    cents.saturating_mul(i64::try_from(line.quantity).unwrap_or(i64::MAX))
}

/// The snapshot the address or the form says the review started from.
struct Started {
    snapshot_id: String,
    revision: String,
}

impl Started {
    fn of(snapshot_id: Option<&str>, revision: Option<&str>) -> Self {
        let text = |v: Option<&str>| v.map(str::trim).unwrap_or_default().to_owned();
        Started { snapshot_id: text(snapshot_id), revision: text(revision) }
    }
}

/// `stableKeyPart`: letters, digits, `_` and `-` kept, the rest `_`, at most 80.
fn stable(text: &str) -> String {
    let part: String = text
        .encode_utf16()
        .take(80)
        .map(|u| char::from_u32(u32::from(u)).filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').unwrap_or('_'))
        .collect();
    if part.is_empty() { "unknown".into() } else { part }
}

/// The confirmation a session saves (`confirmationIdForSession`).
pub fn confirmation_id(session: &str) -> String {
    format!("slc_{}", stable(session))
}

/// What the seller chose, as marketplace's action sends it for readiness and confirm: a saved
/// address by its id, else the address typed (an empty line 2 as none), and the label preference.
pub fn choices(values: &Values) -> SellerChoices {
    let ship_from = if values.ship_from_address_id == MANUAL {
        ShipFromChoice::Typed {
            name: values.ship_from_name.clone(),
            line1: values.line1.clone(),
            line2: Some(values.line2.clone()).filter(|l| !l.is_empty()),
            city: values.city.clone(),
            state: values.state.clone(),
            postal_code: values.postal_code.clone(),
            country: values.country.clone(),
        }
    } else {
        ShipFromChoice::Saved { address_id: values.ship_from_address_id.clone() }
    };
    let preference = if values.label_preference == "seller-label-later" { "seller-label-later" } else { "prepaid-label" };
    SellerChoices { ship_from, label: LabelChoice { preference } }
}

/// The seller confirmation evidence marketplace's route builds (`buildSellerEvidence`): every
/// dimension ready, the ship-from's place and the payout readiness read.
pub fn evidence(values: &Values, payout: &Payout) -> SellerEvidence {
    SellerEvidence {
        ship_from: EvidenceShipFrom {
            status: "ready",
            address_id: (values.ship_from_address_id != MANUAL).then(|| values.ship_from_address_id.clone()),
            country: values.country.clone(),
            region: values.state.clone(),
            postal_code: values.postal_code.clone(),
        },
        payout: EvidencePayout {
            status: "ready",
            method: "saved-payout",
            readiness_status: payout.status().to_owned(),
            last_checked_at: None,
        },
        label: EvidenceLabel {
            status: "ready",
            preference: if values.label_preference == "seller-label-later" { "seller-label-later" } else { "prepaid-label" },
        },
        risk: EvidenceStatus { status: "clear" },
        provider: EvidenceStatus { status: "ready" },
        freshness: EvidenceStatus { status: "current" },
    }
}

/// The state the page and its form start from: the lines, whether the snapshot still holds, and
/// for an account its addresses and payout setup.
async fn load(
    t: SellCheckoutMsg,
    caller: &platform::api::Caller<'_>,
    session: Option<&Session>,
    headers: &HeaderMap,
    id: &str,
    started: &Started,
) -> Result<Screen, ApiError> {
    let account = account_sell_list(session);
    let mut screen = Screen {
        session_id: id.to_owned(),
        account,
        lines: Vec::new(),
        readiness: None,
        recovery: None,
        values: Values::default(),
        errors: Errors::new(),
        addresses: Vec::new(),
        payout: None,
        decisions: None,
        attempt: None,
    };
    let guest = guest_id(headers);
    if account {
        let viewer = session.and_then(Session::viewer);
        let may_read = viewer.is_some_and(|v| v.actor.role_key != "guest-buyer" && v.actor.can("accounts.view"));
        if may_read {
            screen.addresses =
                caller.checkout_addresses().await.inspect_err(|e| tracing::warn!("ship-from addresses: {e}")).unwrap_or_default();
        }
        screen.payout = Some(Payout::of(caller.sell_payout_readiness().await));
        screen.values = Values::account_defaults(&screen.addresses);
    } else if guest.is_none() {
        screen.recovery = Some(Recovery::MissingSellList);
        return Ok(screen);
    }
    let owner = if account { None } else { guest.as_deref() };
    let list = caller.sell_list(owner).await?;
    if list.items.is_empty() {
        screen.recovery = Some(Recovery::EmptySellList);
        return Ok(screen);
    }
    screen.lines = list.items;
    if started.snapshot_id.is_empty() || started.revision.is_empty() {
        screen.recovery = Some(Recovery::ReadinessRequired);
        return Ok(screen);
    }
    // An account's review is the one Checkout kept with the snapshot; a guest's is its readiness now.
    let read = match owner {
        None => match caller.stored_sell_list_review(&started.snapshot_id, &started.revision, &confirmation_id(id)).await {
            Ok(SellListReview { readiness, review_plan: Some(_), decisions: Some(decisions) }) => {
                Ok((readiness, Some(decisions)))
            }
            Ok(_) => Err("the kept review has no plan or decisions".to_owned()),
            Err(error) => Err(error.to_string()),
        },
        Some(guest) => {
            caller.guest_sell_list_readiness(guest).await.map(|(readiness, _)| (readiness, None)).map_err(|e| e.to_string())
        }
    };
    let readiness = match read {
        Ok((readiness, decisions)) => {
            screen.decisions = decisions;
            readiness
        }
        Err(error) => {
            tracing::warn!("seller checkout readiness: {error}");
            screen.recovery = Some(Recovery::ReadinessStale(Some(t.route_readiness_unavailable().to_owned())));
            return Ok(screen);
        }
    };
    screen.recovery = if readiness.snapshot_id != started.snapshot_id || readiness.source_revision != started.revision {
        Some(Recovery::ReadinessStale(None))
    } else if !readiness.ready() {
        Some(Recovery::ReadinessBlocked)
    } else {
        screen.lines.retain(|l| readiness.included_line_ids.contains(&l.line_id));
        None
    };
    screen.readiness = Some(readiness);
    Ok(screen)
}

pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sell_checkout::SellCheckout<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let session = session.as_deref();
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let started = Started::of(place.readiness_snapshot_id.as_deref(), place.readiness_source_revision.as_deref());
    match load(req.t(), &caller, session, &headers, &id, &started).await {
        Ok(screen) => render(&req, session, screen, StatusCode::OK),
        Err(error) => read_failed(&req, session.and_then(Session::viewer), error, None),
    }
}

fn render(req: &Req, session: Option<&Session>, screen: Screen, status: StatusCode) -> HtmlResult {
    let t: SellCheckoutMsg = req.t();
    let head = html! {
        <meta name="description" content={t.route_meta_description()}>
        <meta name="robots" content="noindex">
    };
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={session.and_then(Session::viewer)} title={t.route_meta_title()} head={head}>
                <views::SellCheckoutPage t={t} s={req.t()} p={req.t()} screen={&screen} />
            </Layout>
        },
    )
}

pub(crate) async fn write(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sell_checkout::SellCheckout<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let id = route.id;
    let session = session.as_deref();
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let t: SellCheckoutMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let started = Started::of(Some(&first(&raw, "readinessSnapshotId")), Some(&first(&raw, "readinessSourceRevision")));
    // A confirmation saved already (a resent form) is its page, before anything else is read. One
    // that cannot be looked for is not known: the page waits for the same form again.
    let mut unknown = false;
    if account_sell_list(session) {
        match caller.sell_list_confirmation(&confirmation_id(&id)).await {
            Ok(_) => return req.redirect(&confirmed(&id).parse::<Uri>().map_err(corten::Error::new)?),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {}
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => {
                return match sign_in_back_to(&format!("/checkout/sell/session/{}", stable(&id))) {
                    Some(to) => req.redirect(&to),
                    None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
                };
            }
            Err(error) => {
                tracing::warn!("seller checkout's confirmation lookup: {error}");
                unknown = true;
            }
        }
    }
    let mut screen = match load(t, &caller, session, &headers, &id, &started).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, session.and_then(Session::viewer), error, None),
    };
    screen.values = Values::read(&raw).with_saved(&screen.addresses);
    if unknown {
        screen.attempt = Some(Attempt { state: Attempted::Ambiguous, lines: Vec::new(), resend: cart_attempt::posted(&raw) });
        return render(&req, session, screen, StatusCode::CONFLICT);
    }
    if screen.recovery.is_some() {
        return refuse(&req, session, screen, t.route_validation_readiness_recovery());
    }
    screen.errors = validate(t, &screen.values, screen.account);
    if screen.account && !screen.payout.as_ref().is_some_and(Payout::ready) {
        screen.errors.insert("payoutMethod", t.route_validation_payout_setup_required().to_owned());
    }
    if !screen.errors.is_empty() {
        return render(&req, session, screen, StatusCode::UNPROCESSABLE_ENTITY);
    }
    if !screen.account {
        let back = format!("{}?registrationReturn=seller-checkout", url::SellList::PATH);
        return req.redirect(&url::Register { join: crate::register::Join::back_to(&back) });
    }
    confirm(&req, session, &caller, screen, cart_attempt::posted(&raw)).await
}

/// The saved confirmation's page, as a resent form finds it.
fn confirmed(session: &str) -> String {
    url::SellConfirmation { id: &stable(session), place: ConfirmationPlace::default() }.href()
}

/// The page again with the whole form's refusal (422).
fn refuse(req: &Req, session: Option<&Session>, mut screen: Screen, message: &str) -> HtmlResult {
    screen.errors.insert("form", message.to_owned());
    render(req, session, screen, StatusCode::UNPROCESSABLE_ENTITY)
}

/// An account's confirm: once per session, readiness with the seller's evidence, then Checkout's
/// confirm, which runs the handoff; then the confirmation, read after both. `resend` is the form
/// as posted, which a confirm that is not known to have finished offers to send again.
async fn confirm(
    req: &Req,
    session: Option<&Session>,
    caller: &platform::api::Caller<'_>,
    mut screen: Screen,
    resend: Vec<(String, String)>,
) -> HtmlResult {
    let t: SellCheckoutMsg = req.t();
    let Some(readiness) = screen.readiness.clone() else {
        return refuse(req, session, screen, t.route_validation_readiness_recovery());
    };
    let confirmation = confirmation_id(&screen.session_id);
    let key = stable(&screen.session_id);
    let Some(decisions) = screen.decisions.clone() else {
        return refuse(req, session, screen, t.route_validation_review_plan_required());
    };
    let payout = screen.payout.clone().unwrap_or(Payout::Unavailable);
    let evidence = evidence(&screen.values, &payout);
    let choices = choices(&screen.values);
    let entry = ReadinessEntry {
        confirmation_id: &confirmation,
        entry_readiness_snapshot_id: &readiness.snapshot_id,
        entry_readiness_source_revision: &readiness.source_revision,
    };
    match caller.seller_readiness(&decisions, &choices, &evidence, &entry).await {
        Ok(now) if now.status == "ready" && now.unresolved_line_ids.is_empty() && now.seller_readiness.status == "ready" => {
            let body = json!({
                "confirmationId": confirmation, "readinessSnapshotId": now.snapshot_id,
                "readinessSourceRevision": now.source_revision, "readinessDecisions": decisions,
                "shipFrom": choices.ship_from, "label": choices.label,
            });
            let receipt = match caller.confirm_sell_list(&body).await {
                Ok(receipt) => receipt,
                // The handoff stopped part way: what each line came to, the form held and offered
                // again; and the way back to the Sell List when what the seller reviewed changed.
                Err(ConfirmError::Interrupted { message, lines, stale }) => {
                    if stale.is_some() {
                        screen.recovery = Some(Recovery::ReadinessStale(stale));
                    }
                    let message = if message.is_empty() { t.route_validation_review_plan_required().to_owned() } else { message };
                    screen.errors.insert("form", message);
                    let lines = lines.into_iter().map(|line| (line.line_id, LineResult::of(&line.status))).collect();
                    screen.attempt = Some(Attempt { state: Attempted::Partial, lines, resend });
                    return render(req, session, screen, StatusCode::CONFLICT);
                }
                // An answer that may have been lost: the confirmation is looked for once.
                Err(ConfirmError::Api(error))
                    if error.status().is_none_or(|s| s == StatusCode::REQUEST_TIMEOUT || s.is_server_error()) =>
                {
                    tracing::warn!("seller checkout's confirm: {error}");
                    return match caller.sell_list_confirmation(&confirmation).await {
                        Ok(_) => req.redirect(&confirmed(&screen.session_id).parse::<Uri>().map_err(corten::Error::new)?),
                        Err(_) => {
                            screen.attempt = Some(Attempt { state: Attempted::Ambiguous, lines: Vec::new(), resend });
                            render(req, session, screen, StatusCode::CONFLICT)
                        }
                    };
                }
                Err(ConfirmError::Api(error)) => return failed(req, session, screen, error, t),
            };
            let place = ConfirmationPlace { after_write: receipt.as_ref().map(Receipt::param) };
            let to = url::SellConfirmation { id: &key, place };
            req.redirect(&to.href().parse::<Uri>().map_err(corten::Error::new)?)
        }
        Ok(_) => refuse(req, session, screen, t.route_validation_readiness_recovery()),
        Err(error) => failed(req, session, screen, error, t),
    }
}

/// A write the API refused or that failed: sign-in for a session that ended, the API's words on
/// the page for a refusal (422), with the way back to the Sell List when the list changed since
/// the review (`checkout_readiness_stale`), else a bad gateway.
fn failed(req: &Req, session: Option<&Session>, mut screen: Screen, error: ApiError, t: SellCheckoutMsg) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => {
            match sign_in_back_to(&format!("/checkout/sell/session/{}", stable(&screen.session_id))) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            }
        }
        Some(StatusCode::FORBIDDEN) => Err(crate::app::api_refused(error)),
        Some(status) if status.is_client_error() => {
            if error.code() == Some("checkout_readiness_stale") {
                screen.recovery = Some(Recovery::ReadinessStale(None));
            }
            let message = error.refusal().unwrap_or(t.route_validation_review_plan_required()).to_owned();
            refuse(req, session, screen, &message)
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The saved confirmation, read after the confirm. One not readable yet goes to the Sell List,
/// which waits for it; one not saved goes there too. A guest goes to registration.
pub(crate) async fn confirmation(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sell_checkout::SellConfirmation<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let session = session.as_deref();
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    if !account_sell_list(session) {
        let back = format!("{}?registrationReturn=seller-checkout", url::SellList::PATH);
        return req.redirect(&url::Register { join: crate::register::Join::back_to(&back) });
    }
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let pending = confirmation_id(&id);
    let read = caller.sell_list_confirmation(&pending).await;
    let back = |confirmation: &str, after_write: Option<String>| {
        let place = sell_list::Place {
            after_write,
            confirmation: Some(confirmation.to_owned()),
            pending_confirmation_id: (confirmation == "preparing").then(|| pending.clone()),
            ..sell_list::Place::default()
        };
        url::SellList { place }.href().parse::<Uri>().map_err(corten::Error::new)
    };
    let saved = match read {
        Ok(saved) => saved,
        Err(error) if receipt.is_some() && error.catching_up() => {
            return req.redirect(&back("preparing", place.after_write.clone())?);
        }
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => return req.redirect(&back("missing", None)?),
        Err(error) => return read_failed(&req, session.and_then(Session::viewer), error, None),
    };
    render_confirmation(&req, session, &saved)
}

fn render_confirmation(req: &Req, session: Option<&Session>, saved: &SellListConfirmation) -> HtmlResult {
    let t: SellCheckoutMsg = req.t();
    let head = html! {
        <meta name="description" content={t.signed_confirmation_description()}>
        <meta name="robots" content="noindex">
    };
    req.page_with_status(
        StatusCode::OK,
        html! {
            <Layout
                req={req}
                viewer={session.and_then(Session::viewer)}
                title={t.signed_confirmation_title()}
                head={head}
            >
                <views::SellConfirmationPage t={t} s={req.t()} confirmation={saved} />
            </Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lines_result_is_what_checkout_reports_and_anything_else_is_not_known() {
        let results: Vec<_> = ["completed", "partial", "conflict", "not-attempted", "skipped", "ambiguous", "other"]
            .iter()
            .map(|status| LineResult::of(status))
            .collect();
        use LineResult::*;
        assert_eq!(results, [Completed, Partial, Conflict, NotSent, NotSent, Unconfirmed, Unconfirmed]);
    }

    #[test]
    fn keys_are_stable_for_a_session_and_safe_in_a_path() {
        assert_eq!(confirmation_id("chk_01J"), "slc_chk_01J");
        assert_eq!(confirmation_id("chk 1/2"), "slc_chk_1_2");
        assert_eq!(confirmation_id(""), "slc_unknown");
        assert_eq!(confirmation_id(&"x".repeat(100)).len(), 84);
    }

    #[test]
    fn an_email_needs_one_at_and_a_dotted_domain() {
        for ok in ["a@b.co", "seller+1@chasesets.test"] {
            assert!(email_ok(ok), "{ok}");
        }
        for bad in ["", "a@b", "a@.co", "a@b.", "a b@c.co", "a@@b.co", "@b.co"] {
            assert!(!email_ok(bad), "{bad}");
        }
    }

    #[test]
    fn the_evidence_names_a_saved_address_only_when_one_was_chosen() {
        let mut values = Values { state: "IL".into(), postal_code: "60201".into(), ..Values::default() };
        assert_eq!(evidence(&values, &Payout::Ready).ship_from.address_id, None);
        values.ship_from_address_id = "adr_home".into();
        values.label_preference = "anything".into();
        let sent = evidence(&values, &Payout::Unavailable);
        assert_eq!(sent.ship_from.address_id.as_deref(), Some("adr_home"));
        assert_eq!(sent.label.preference, "prepaid-label");
        assert_eq!(sent.payout.readiness_status, "unavailable");
    }

    #[test]
    fn the_choices_are_a_saved_address_by_its_id_or_the_one_typed_and_the_label() {
        let mut values = Values {
            ship_from_name: "Demo".into(),
            line1: "1 Main".into(),
            city: "Evanston".into(),
            state: "IL".into(),
            postal_code: "60201".into(),
            label_preference: "seller-label-later".into(),
            ..Values::default()
        };
        assert_eq!(
            serde_json::to_value(choices(&values)).unwrap(),
            json!({ "shipFrom": { "name": "Demo", "line1": "1 Main", "line2": null, "city": "Evanston", "state": "IL",
                "postalCode": "60201", "country": "US" }, "label": { "preference": "seller-label-later" } })
        );
        values.ship_from_address_id = "adr_home".into();
        values.line2 = "Unit 2".into();
        values.label_preference = "anything".into();
        assert_eq!(
            serde_json::to_value(choices(&values)).unwrap(),
            json!({ "shipFrom": { "addressId": "adr_home" }, "label": { "preference": "prepaid-label" } })
        );
    }
}
