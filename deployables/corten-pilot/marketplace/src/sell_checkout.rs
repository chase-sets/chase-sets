//! Seller checkout (Checkout's `sell-checkout-session`, at `/checkout/sell/session/{id}`, and its
//! `sell-checkout-confirmation`): the review the Sell List's Continue starts from a readiness snapshot,
//! and the saved confirmation after it.
//!
//! An account's page reads the Sell List, the saved ship-from addresses and the payout readiness,
//! and checks the snapshot in its address against the readiness Checkout works out now with the
//! same decisions (a pure computation, `POST /sell-list/readiness`): a changed list, or one that is not
//! ready, is a recovery that sends the seller back to the Sell List. Confirming (one form) checks
//! the fields, then does what marketplace's route does: the review plan in the address checked
//! against the snapshot, the seller confirmation evidence sent for readiness, the Marketplace
//! handoff (each selected offer and Smart Match target accepted, each fallback listing created and
//! published, with keys derived from the confirmation, so a resent form replays), and
//! `POST /sell-list/confirm` with what it did. The confirmation page is read after that write.
//!
//! A guest's page is the same review of the guest sell list; confirming checks the fields and goes
//! to marketplace's registration, back to the Sell List.
//!
//! Three of the steps are marketplace's web layer's, copied here until the API has them: the
//! review plan's check ([chase-sets/chase-sets#10505](https://github.com/chase-sets/chase-sets/issues/10505)),
//! the seller evidence ([chase-sets/chase-sets#10753](https://github.com/chase-sets/chase-sets/issues/10753))
//! and the handoff ([chase-sets/chase-sets#10754](https://github.com/chase-sets/chase-sets/issues/10754)).
//! Not ported: marketplace's preview hooks (`recovery`, `payoutState`, `riskState` and the other
//! `*State` query parameters and hidden fields), which only force a state.
use std::collections::BTreeMap;

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use platform::{money, receipt::Receipt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::chrome::Chrome;
use crate::{
    api::{
        ApiError, CheckoutSessions as _, EvidenceLabel, EvidencePayout, EvidenceShipFrom, EvidenceStatus, LineAction, LineKept,
        Listings as _, OfferMatchCalls as _, ReadinessDecisions, SavedAddress, SellList as _, SellListConfirmation, SellListRow,
        SellListSnapshot, SellPayoutReadiness, SellerEvidence,
    },
    app::{Shared, read_failed, sign_in_back_to, url},
    auth::Session,
    items::Raw,
    listing_new::first,
    sell_list::{self, Plan, PlanLine, PlanListing, PlanOffer, PlanTarget, guest_id},
    selling::account_sell_list,
    text::{SellCheckoutMsg, SellListMsg},
    views::{self, Layout},
};

/// The address the Sell List's Continue writes: the snapshot, the decisions and the review plan
/// it was built with, and the readiness write's receipt.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub readiness_snapshot_id: Option<String>,
    pub readiness_source_revision: Option<String>,
    pub readiness_decisions: Option<String>,
    pub sell_list_review_plan: Option<String>,
    pub after_write: Option<String>,
}

/// The confirmation's address: the confirm's receipt.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
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
    /// The decisions and the review plan, as the form sends them back.
    pub decisions: String,
    pub plan: String,
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

/// What the address or the form says the review started from.
struct Started {
    snapshot_id: String,
    revision: String,
    decisions: ReadinessDecisions,
    plan: String,
}

impl Started {
    fn of(snapshot_id: Option<&str>, revision: Option<&str>, decisions: Option<&str>, plan: Option<&str>) -> Self {
        let text = |v: Option<&str>| v.map(str::trim).unwrap_or_default().to_owned();
        Started {
            snapshot_id: text(snapshot_id),
            revision: text(revision),
            decisions: parse_decisions(decisions.unwrap_or_default()),
            plan: text(plan),
        }
    }
}

/// The readiness decisions in an address (`parseSellListReadinessDecisions`): unknown actions
/// and outcomes left out, anything unreadable none.
pub fn parse_decisions(text: &str) -> ReadinessDecisions {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return ReadinessDecisions::default() };
    let id = |v: &Value| v["lineId"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let line_actions = value["lineActions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let action = match a["action"].as_str().map(str::trim) {
                Some("selected-offer") => "selected-offer",
                Some("smart-match") => "smart-match",
                Some("fallback-listing") => "fallback-listing",
                _ => return None,
            };
            Some(LineAction { line_id: id(a)?, action })
        })
        .collect();
    let line_outcomes = value["lineOutcomes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|o| o["outcome"].as_str().map(str::trim) == Some("keep-in-list"))
        .filter_map(|o| Some(LineKept { line_id: id(o)?, outcome: "keep-in-list" }))
        .collect();
    ReadinessDecisions { line_actions, line_outcomes }
}

/// A review plan in an address (`parseSellListReviewPlan`): incomplete parts left out, anything
/// unreadable none.
pub fn parse_plan(text: &str) -> Option<Plan> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    if value["version"] != 1 {
        return None;
    }
    let s = |v: &Value| v.as_str().map(str::trim).unwrap_or_default().to_owned();
    let n = |v: &Value| v.as_u64().filter(|n| *n > 0).unwrap_or(0);
    let lines = value["lines"]
        .as_array()?
        .iter()
        .filter(|l| l.is_object())
        .filter_map(|l| {
            let line_id = s(&l["lineId"]);
            let line_type = match l["lineType"].as_str() {
                Some("selected-offer") => "selected-offer",
                Some("product") => "product",
                _ => return None,
            };
            if line_id.is_empty() {
                return None;
            }
            let o = &l["selectedOffer"];
            let selected_offer =
                (!s(&o["offerId"]).is_empty() && !s(&o["listingId"]).is_empty() && !s(&o["feeQuoteFingerprint"]).is_empty())
                    .then(|| PlanOffer {
                        offer_id: s(&o["offerId"]),
                        listing_id: s(&o["listingId"]),
                        fee_quote_fingerprint: s(&o["feeQuoteFingerprint"]),
                    });
            let product_offer_targets = l["productOfferTargets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| PlanTarget {
                    offer_id: s(&t["offerId"]),
                    listing_id: s(&t["listingId"]),
                    fee_quote_fingerprint: s(&t["feeQuoteFingerprint"]),
                    quantity: n(&t["quantity"]),
                })
                .filter(|t| {
                    !t.offer_id.is_empty() && !t.listing_id.is_empty() && !t.fee_quote_fingerprint.is_empty() && t.quantity > 0
                })
                .collect();
            let f = &l["fallbackListing"];
            let fallback_listing = (!s(&f["inventoryItemId"]).is_empty()
                && !s(&f["priceAmount"]).is_empty()
                && !s(&f["priceCurrencyCode"]).is_empty()
                && n(&f["quantityCap"]) > 0)
                .then(|| PlanListing {
                    inventory_item_id: s(&f["inventoryItemId"]),
                    price_amount: s(&f["priceAmount"]),
                    price_currency_code: s(&f["priceCurrencyCode"]),
                    quantity_cap: n(&f["quantityCap"]),
                });
            let product_id = Some(s(&l["productId"])).filter(|p| !p.is_empty());
            Some(PlanLine {
                line_id,
                line_type,
                item_title: s(&l["itemTitle"]),
                product_id,
                quantity: n(&l["quantity"]),
                selected_offer,
                product_offer_targets,
                fallback_listing,
                skipped_reasons: l["skippedReasons"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| r.as_str().map_or_else(|| r.to_string(), str::to_owned).trim().to_owned())
                    .filter(|r| !r.is_empty())
                    .collect(),
            })
        })
        .collect();
    Some(Plan { version: 1, lines })
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

/// The listing a reviewed fallback listing is created as, so a resent confirm is the same one
/// (`reviewedListingId`).
pub fn listing_id(confirmation: &str, line: &str) -> String {
    format!("lst_{}_{}", stable(confirmation), stable(line))
}

/// A line seller checkout takes, with its plan and the action readiness decided.
#[derive(Clone, Debug)]
pub struct Reviewed {
    pub line: SellListRow,
    pub plan: PlanLine,
    pub action: String,
}

/// The plan checked against the snapshot (`reviewedLinesForConfirmation`): every included line has
/// its plan line, of its type and product, unskipped, doing what readiness decided, and taking at
/// most its quantity. Any other plan is refused.
pub fn reviewed(lines: &[SellListRow], readiness: &SellListSnapshot, plan: Option<&Plan>) -> Option<Vec<Reviewed>> {
    let plan = plan?;
    let mut out = Vec::new();
    for id in &readiness.included_line_ids {
        let line = lines.iter().find(|l| &l.line_id == id)?;
        let review = plan.lines.iter().find(|p| &p.line_id == id)?;
        let action = readiness.action(id)?;
        if !review.skipped_reasons.is_empty()
            || review.line_type != line.line_type
            || review.product_id.as_deref() != Some(line.product_id.as_str())
        {
            return None;
        }
        let quantity = match action {
            "selected-offer" => {
                let offer = review.selected_offer.as_ref()?;
                let fits = line.is_offer()
                    && line.offer_id.as_deref() == Some(offer.offer_id.as_str())
                    && review.product_offer_targets.is_empty()
                    && review.fallback_listing.is_none();
                fits.then_some(line.quantity)?
            }
            "smart-match" => {
                let fits = !line.is_offer() && review.selected_offer.is_none() && !review.product_offer_targets.is_empty();
                let targets: u64 = review.product_offer_targets.iter().map(|t| t.quantity).sum();
                fits.then(|| targets + review.fallback_listing.as_ref().map_or(0, |f| f.quantity_cap))?
            }
            "fallback-listing" => {
                let fits = !line.is_offer() && review.selected_offer.is_none() && review.product_offer_targets.is_empty();
                fits.then_some(review.fallback_listing.as_ref()?.quantity_cap)?
            }
            _ => return None,
        };
        if quantity > line.quantity {
            return None;
        }
        out.push(Reviewed { line: line.clone(), plan: review.clone(), action: action.to_owned() });
    }
    Some(out)
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

/// Marketplace's refusals that mean what the seller reviewed changed (`OFFER_ACCEPTANCE_STALE_CODES`).
const STALE: &[&str] = &[
    "fee_quote_stale",
    "offer_not_open",
    "listing_evidence_incomplete",
    "listing_seller_trust_incomplete",
    "listing_not_eligible",
    "managed_offer_held",
    "managed_offer_refresh_required",
    "managed_offer_conflict",
];

/// Why the handoff stopped.
#[derive(Debug)]
pub enum Stopped {
    /// What the seller reviewed changed: back to the Sell List, with why.
    Stale(String),
    Failed(ApiError),
}

/// What the handoff did: the confirm's body parts and every write's receipt.
#[derive(Debug, Default)]
pub struct Handoff {
    pub completed: Vec<String>,
    pub remaining: Vec<(String, u64)>,
    pub summary: Value,
    pub receipts: Vec<Receipt>,
}

/// The calls the handoff makes, so tests can stand in for Marketplace.
pub trait Market {
    async fn accept(&self, offer: &str, body: &Value) -> Result<Option<Receipt>, ApiError>;
    async fn create(&self, body: &Value) -> Result<(String, Option<String>, Option<Receipt>), ApiError>;
    async fn publish(&self, listing: &str, fingerprint: Option<&str>) -> Result<Option<Receipt>, ApiError>;
}

impl Market for platform::api::Caller<'_> {
    async fn accept(&self, offer: &str, body: &Value) -> Result<Option<Receipt>, ApiError> {
        self.accept_offer_match(offer, body).await
    }

    async fn create(&self, body: &Value) -> Result<(String, Option<String>, Option<Receipt>), ApiError> {
        let (created, receipt) = self.create_listing(body).await?;
        Ok((created.id, created.fee_quote_fingerprint, receipt))
    }

    async fn publish(&self, listing: &str, fingerprint: Option<&str>) -> Result<Option<Receipt>, ApiError> {
        self.publish_listing(listing, fingerprint).await
    }
}

/// One acceptance: an offer already accepted (a resent form) counts with no write; a stale one stops
/// the handoff (`acceptOfferMatchWithRecovery`).
async fn accept(m: &impl Market, t: SellListMsg, offer: &str, title: &str, body: Value) -> Result<Option<Receipt>, Stopped> {
    let error = match m.accept(offer, &body).await {
        Ok(receipt) => return Ok(receipt),
        Err(error) => error,
    };
    let code = error.code().unwrap_or_default().to_owned();
    if code == "offer_already_accepted" {
        Ok(None)
    } else if STALE.contains(&code.as_str()) && code.starts_with("managed_offer_") {
        Err(Stopped::Stale(t.route_managed_offer_refresh_detail(title).to_string()))
    } else if STALE.contains(&code.as_str()) {
        Err(Stopped::Stale(t.route_offer_terms_need_refresh_detail(title).to_string()))
    } else {
        Err(Stopped::Failed(error))
    }
}

/// Marketplace's handoff (`performMarketplaceHandoff`), line by line in the snapshot's order.
pub async fn handoff(
    m: &impl Market,
    t: SellListMsg,
    c: SellCheckoutMsg,
    confirmation: &str,
    lines: &[Reviewed],
) -> Result<Handoff, Stopped> {
    let mut done = Handoff::default();
    let (mut accepted_count, mut published_count) = (0u64, 0u64);
    let mut outcomes = Vec::new();
    for Reviewed { line, plan, action } in lines {
        let id = &line.line_id;
        let title = &line.item_title;
        let mut accepted: Vec<&str> = Vec::new();
        let mut listing = None;
        let mut completed = 0u64;
        if action == "selected-offer"
            && let Some(o) = &plan.selected_offer
        {
            let body = json!({
                "listingId": o.listing_id, "feeQuoteFingerprint": o.fee_quote_fingerprint,
                "sourceActionKey": format!("sell-confirm:{confirmation}:{id}:selected:{}", o.offer_id),
            });
            done.receipts.extend(accept(m, t, &o.offer_id, title, body).await?);
            accepted.push(&o.offer_id);
            completed += line.quantity;
            accepted_count += 1;
        }
        if action == "smart-match" {
            let batch = format!("offer-acceptance:{confirmation}:{id}");
            for target in &plan.product_offer_targets {
                let body = json!({
                    "listingId": target.listing_id, "feeQuoteFingerprint": target.fee_quote_fingerprint,
                    "sourceActionKey": format!("sell-confirm:{confirmation}:{id}:match:{}", target.offer_id),
                    "acceptanceBatchId": batch, "acceptanceBatchSize": plan.product_offer_targets.len(),
                });
                done.receipts.extend(accept(m, t, &target.offer_id, title, body).await?);
                accepted.push(&target.offer_id);
                completed += target.quantity;
                accepted_count += 1;
            }
        }
        if let Some(f) = &plan.fallback_listing {
            let over = listing_id(confirmation, id);
            let body = json!({
                "inventoryItemId": f.inventory_item_id, "priceAmount": f.price_amount,
                "priceCurrencyCode": f.price_currency_code, "quantityCap": f.quantity_cap, "listingIdOverride": over,
            });
            let (created, fingerprint, receipt) = m.create(&body).await.map_err(Stopped::Failed)?;
            done.receipts.extend(receipt);
            let created = if created.is_empty() { over } else { created };
            match m.publish(&created, fingerprint.as_deref()).await {
                Ok(receipt) => done.receipts.extend(receipt),
                // Published already: a resent confirm.
                Err(error) if error.refusal().is_some_and(|m| m.contains("already active")) => {}
                Err(error) => return Err(Stopped::Failed(error)),
            }
            listing = Some(created);
            completed += f.quantity_cap;
            published_count += 1;
        }
        let remaining = line.quantity.saturating_sub(completed);
        if remaining > 0 {
            done.remaining.push((id.clone(), remaining));
        } else {
            done.completed.push(id.clone());
        }
        let kind = match (accepted.is_empty(), &listing) {
            (false, Some(_)) => "mixed",
            (false, None) if action == "selected-offer" => "accepted-offer",
            (false, None) => "accepted-smart-match",
            (true, _) => "published-listing",
        };
        let mut references = serde_json::Map::new();
        if !accepted.is_empty() {
            references.insert("offerIds".into(), json!(accepted));
        }
        if let Some(listing) = &listing {
            references.insert("listingId".into(), json!(listing));
        }
        let detail = if remaining > 0 {
            c.route_confirmation_line_partial(title).to_string()
        } else {
            c.route_confirmation_line_completed(title).to_string()
        };
        outcomes.push(json!({
            "lineId": id, "itemTitle": title, "status": if remaining > 0 { "partial" } else { "completed" },
            "action": kind, "quantity": line.quantity, "remainingQuantity": remaining, "detail": detail,
            "references": references,
        }));
    }
    let offers = accepted_count > 0;
    let any = offers || published_count > 0;
    let effect = |on: bool, status: &str| if on { status.to_owned() } else { "not-applicable".to_owned() };
    done.summary = json!({
        "acceptedOfferCount": accepted_count, "publishedListingCount": published_count, "skippedLineCount": 0,
        "skippedReasons": [], "lineOutcomes": outcomes,
        "sideEffects": {
            "sale": effect(offers, "handoff-recorded"), "label": effect(offers, "pending-downstream"),
            "payout": effect(offers, "pending-downstream"), "settlement": effect(offers, "pending-downstream"),
            "notification": effect(any, "pending-downstream"), "accountHistory": effect(any, "pending-downstream"),
        },
    });
    Ok(done)
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
        decisions: serde_json::to_string(&started.decisions).unwrap_or_default(),
        plan: started.plan.clone(),
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
    let decisions = if account { started.decisions.clone() } else { ReadinessDecisions::default() };
    let readiness = match caller.sell_list_readiness(&decisions, owner).await {
        Ok((readiness, _)) => readiness,
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
    chrome: Chrome,
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
    let started = Started::of(
        place.readiness_snapshot_id.as_deref(),
        place.readiness_source_revision.as_deref(),
        place.readiness_decisions.as_deref(),
        place.sell_list_review_plan.as_deref(),
    );
    match load(req.t(), &caller, session, &headers, &id, &started).await {
        Ok(screen) => render(&req, session, screen, StatusCode::OK, chrome.cart().await),
        Err(error) => read_failed(&req, session.and_then(Session::viewer), error, None, chrome.cart().await),
    }
}

fn render(req: &Req, session: Option<&Session>, screen: Screen, status: StatusCode, cart: Option<u64>) -> HtmlResult {
    let t: SellCheckoutMsg = req.t();
    let head = html! {
        <meta name="description" content={t.route_meta_description()}>
        <meta name="robots" content="noindex">
    };
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={session.and_then(Session::viewer)} cart={cart} title={t.route_meta_title()} head={head}>
                <views::SellCheckoutPage t={t} screen={&screen} />
            </Layout>
        },
    )
}

pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
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
    let started = Started::of(
        Some(&first(&raw, "readinessSnapshotId")),
        Some(&first(&raw, "readinessSourceRevision")),
        Some(&first(&raw, "readinessDecisions")),
        Some(&first(&raw, "sellListReviewPlan")),
    );
    let mut screen = match load(t, &caller, session, &headers, &id, &started).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, session.and_then(Session::viewer), error, None, chrome.cart().await),
    };
    screen.values = Values::read(&raw).with_saved(&screen.addresses);
    if screen.recovery.is_some() {
        return refuse(&req, session, screen, t.route_validation_readiness_recovery(), chrome.cart().await);
    }
    screen.errors = validate(t, &screen.values, screen.account);
    if screen.account && !screen.payout.as_ref().is_some_and(Payout::ready) {
        screen.errors.insert("payoutMethod", t.route_validation_payout_setup_required().to_owned());
    }
    if !screen.errors.is_empty() {
        return render(&req, session, screen, StatusCode::UNPROCESSABLE_ENTITY, chrome.cart().await);
    }
    if !screen.account {
        let back = format!("{}?registrationReturn=seller-checkout", url::SellList::PATH);
        return req.redirect(&url::Register { join: crate::register::Join::back_to(&back) });
    }
    confirm(&req, session, &caller, screen, &started, &chrome).await
}

/// The page again with the whole form's refusal (422).
fn refuse(req: &Req, session: Option<&Session>, mut screen: Screen, message: &str, cart: Option<u64>) -> HtmlResult {
    screen.errors.insert("form", message.to_owned());
    render(req, session, screen, StatusCode::UNPROCESSABLE_ENTITY, cart)
}

/// An account's confirm: once per session, after the plan, readiness with the seller's evidence
/// and the handoff; then the confirmation, read after it.
async fn confirm(
    req: &Req,
    session: Option<&Session>,
    caller: &platform::api::Caller<'_>,
    mut screen: Screen,
    started: &Started,
    chrome: &Chrome,
) -> HtmlResult {
    let t: SellCheckoutMsg = req.t();
    let list: SellListMsg = req.t();
    let Some(readiness) = screen.readiness.clone() else {
        return refuse(req, session, screen, t.route_validation_readiness_recovery(), chrome.cart().await);
    };
    let confirmation = confirmation_id(&screen.session_id);
    let key = stable(&screen.session_id);
    let done = url::SellConfirmation { id: &key, place: ConfirmationPlace::default() };
    match caller.sell_list_confirmation(&confirmation).await {
        // Confirmed already (a resent form): its page.
        Ok(_) => return req.redirect(&done.href().parse::<Uri>().map_err(corten::Error::new)?),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {}
        Err(error) => return failed(req, session, screen, error, t, chrome.cart().await),
    }
    let plan = parse_plan(&started.plan);
    let Some(lines) = reviewed(&screen.lines, &readiness, plan.as_ref()) else {
        return refuse(req, session, screen, t.route_validation_review_plan_required(), chrome.cart().await);
    };
    let payout = screen.payout.clone().unwrap_or(Payout::Unavailable);
    let evidence = evidence(&screen.values, &payout);
    match caller.seller_readiness(&started.decisions, &evidence).await {
        Ok(now) if now.status == "ready" && now.unresolved_line_ids.is_empty() && now.seller_readiness.status == "ready" => {
            let handed = match handoff(caller, list, t, &confirmation, &lines).await {
                Ok(handed) => handed,
                Err(Stopped::Stale(detail)) => {
                    screen.recovery = Some(Recovery::ReadinessStale(Some(detail.clone())));
                    return refuse(req, session, screen, &detail, chrome.cart().await);
                }
                Err(Stopped::Failed(error)) => return failed(req, session, screen, error, t, chrome.cart().await),
            };
            let remaining: Vec<Value> =
                handed.remaining.iter().map(|(line, quantity)| json!({ "lineId": line, "quantity": quantity })).collect();
            let body = json!({
                "confirmationId": confirmation, "readinessSnapshotId": now.snapshot_id,
                "readinessSourceRevision": now.source_revision, "readinessDecisions": started.decisions,
                "completedLineIds": handed.completed, "remainingLineQuantities": remaining,
                "sellerEvidence": evidence, "handoffSummary": handed.summary,
            });
            let receipt = match caller.confirm_sell_list(&body).await {
                Ok(receipt) => receipt,
                Err(error) => return failed(req, session, screen, error, t, chrome.cart().await),
            };
            let latest = handed.receipts.into_iter().chain(receipt).reduce(Receipt::later);
            let place = ConfirmationPlace { after_write: latest.as_ref().map(Receipt::param) };
            let to = url::SellConfirmation { id: &key, place };
            req.redirect(&to.href().parse::<Uri>().map_err(corten::Error::new)?)
        }
        Ok(_) => refuse(req, session, screen, t.route_validation_readiness_recovery(), chrome.cart().await),
        Err(error) => failed(req, session, screen, error, t, chrome.cart().await),
    }
}

/// A write the API refused or that failed: sign-in for a session that ended, the API's words on
/// the page for a refusal (422), else a bad gateway.
fn failed(
    req: &Req,
    session: Option<&Session>,
    screen: Screen,
    error: ApiError,
    t: SellCheckoutMsg,
    cart: Option<u64>,
) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => {
            match sign_in_back_to(&format!("/checkout/sell/session/{}", stable(&screen.session_id))) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            }
        }
        Some(StatusCode::FORBIDDEN) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
        Some(status) if status.is_client_error() => {
            let message = error.refusal().unwrap_or(t.route_validation_review_plan_required()).to_owned();
            refuse(req, session, screen, &message, cart)
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The saved confirmation, read after the confirm. One not readable yet goes to the Sell List,
/// which waits for it; one not saved goes there too. A guest goes to registration.
pub(crate) async fn confirmation(
    req: Req,
    chrome: Chrome,
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
        Err(error) => return read_failed(&req, session.and_then(Session::viewer), error, None, chrome.cart().await),
    };
    render_confirmation(&req, session, &saved, chrome.cart().await)
}

fn render_confirmation(req: &Req, session: Option<&Session>, saved: &SellListConfirmation, cart: Option<u64>) -> HtmlResult {
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
                cart={cart}
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
    use crate::api::SnapshotLine;

    fn row(id: &str, kind: &str, quantity: u64, offer: Option<&str>) -> SellListRow {
        SellListRow {
            line_id: id.into(),
            line_type: kind.into(),
            product_id: "cat_pika::form:raw".into(),
            item_title: "Pikachu".into(),
            offer_id: offer.map(str::to_owned),
            quantity,
            ..SellListRow::default()
        }
    }

    fn snapshot(actions: &[(&str, &str)]) -> SellListSnapshot {
        SellListSnapshot {
            status: "ready".into(),
            included_line_ids: actions.iter().map(|(id, _)| (*id).to_owned()).collect(),
            line_outcomes: actions
                .iter()
                .map(|(id, action)| SnapshotLine {
                    line_id: (*id).into(),
                    outcome: "checkout".into(),
                    action: Some((*action).into()),
                })
                .collect(),
            ..SellListSnapshot::default()
        }
    }

    const PLAN: &str = r#"{"version":1,"lines":[
        {"lineId":" sll_offer ","lineType":"selected-offer","itemTitle":"Pikachu","productId":"cat_pika::form:raw","quantity":2,
         "selectedOffer":{"offerId":"off_ready","listingId":"lst_pika","feeQuoteFingerprint":"fq"},"productOfferTargets":[],"skippedReasons":[]},
        {"lineId":"sll_product","lineType":"product","productId":"cat_pika::form:raw","quantity":3,
         "productOfferTargets":[{"offerId":"off_short","listingId":"lst_pika","feeQuoteFingerprint":"fq","quantity":2},
                                {"offerId":"","listingId":"lst_pika","feeQuoteFingerprint":"fq","quantity":1}],
         "fallbackListing":{"inventoryItemId":"inv_pika","priceAmount":"21.00","priceCurrencyCode":"USD","quantityCap":1}},
        {"lineId":"","lineType":"product"},
        {"lineId":"sll_odd","lineType":"bundle"}
    ]}"#;

    #[test]
    fn a_plan_keeps_its_complete_parts_and_anything_unreadable_is_none() {
        let plan = parse_plan(PLAN).unwrap();
        assert_eq!(plan.lines.len(), 2, "lines with no id or an unknown type are left out");
        assert_eq!(plan.lines[0].line_id, "sll_offer");
        assert_eq!(plan.lines[1].product_offer_targets.len(), 1, "a target with no offer is left out");
        assert_eq!(plan.lines[1].fallback_listing.as_ref().map(|f| f.quantity_cap), Some(1));
        assert!(parse_plan("").is_none());
        assert!(parse_plan(r#"{"version":2,"lines":[]}"#).is_none());
        assert!(parse_plan(r#"{"version":1}"#).is_none());
    }

    #[test]
    fn the_plan_must_do_what_readiness_decided_for_every_included_line() {
        let lines = [row("sll_offer", "selected-offer", 2, Some("off_ready")), row("sll_product", "product", 3, None)];
        let plan = parse_plan(PLAN).unwrap();
        let both = snapshot(&[("sll_offer", "selected-offer"), ("sll_product", "smart-match")]);
        let reviewed = reviewed(&lines, &both, Some(&plan)).unwrap();
        assert_eq!(reviewed.iter().map(|r| r.action.as_str()).collect::<Vec<_>>(), ["selected-offer", "smart-match"]);
        // A different action, a line with no plan, more than the line has, no plan at all.
        assert!(super::reviewed(&lines, &snapshot(&[("sll_product", "fallback-listing")]), Some(&plan)).is_none());
        assert!(super::reviewed(&lines, &snapshot(&[("sll_missing", "fallback-listing")]), Some(&plan)).is_none());
        let short = [row("sll_product", "product", 2, None)];
        assert!(super::reviewed(&short, &snapshot(&[("sll_product", "smart-match")]), Some(&plan)).is_none());
        assert!(super::reviewed(&lines, &both, None).is_none());
        // A line readiness keeps in the list is not the plan's to take.
        let one = snapshot(&[("sll_offer", "selected-offer")]);
        assert_eq!(super::reviewed(&lines, &one, Some(&plan)).unwrap().len(), 1);
    }

    #[test]
    fn keys_are_stable_for_a_session_and_safe_in_a_path() {
        assert_eq!(confirmation_id("chk_01J"), "slc_chk_01J");
        assert_eq!(confirmation_id("chk 1/2"), "slc_chk_1_2");
        assert_eq!(confirmation_id(""), "slc_unknown");
        assert_eq!(confirmation_id(&"x".repeat(100)).len(), 84);
        assert_eq!(listing_id("slc_chk", "sll_product"), "lst_slc_chk_sll_product");
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
}
