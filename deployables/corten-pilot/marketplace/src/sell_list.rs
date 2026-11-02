//! Sell > Sell List (Checkout's `account-sell-list`, at `/account/sell-list`, and the Seller Desk's `account-desk-offers`,
//! the same page at `/account/desk/offers`): the sell list's lines, what each needs before seller
//! checkout, the expected payout, and Continue to seller checkout. A guest's is the browser's guest
//! sell list (its cookie), with the account gate; signing in moves it into the account's.
//!
//! The page's writes are marketplace's intents: Remove (a line), Decline selected (the checked
//! offers, declined on Marketplace, then their lines removed), Classify and Add photo (a listing's
//! evidence, on Marketplace) and Continue to seller checkout, which posts the seller's choices,
//! asks Checkout for the sell list's readiness with them, and starts the pilot's seller checkout
//! with the snapshot (`/checkout/sell/session/{id}`, in [`crate::sell_checkout`]). A guest's Continue checks the guest
//! sell list's readiness and goes to marketplace's registration.
//!
//! Two of the page's rules are marketplace's web layer's, copied here until the API has them: each
//! line's readiness and the list's payout totals
//! ([chase-sets/chase-sets#10749](https://github.com/chase-sets/chase-sets/issues/10749)), worked
//! out in whole cents where marketplace's page adds floats (`moneyNumber`), and the review plan
//! Continue sends to seller checkout with its readiness decisions
//! ([chase-sets/chase-sets#10505](https://github.com/chase-sets/chase-sets/issues/10505)).
use std::{collections::HashMap, time::Duration};

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri, header},
    prelude::*,
    security::cookie,
};
use platform::{api::segment, money, receipt::Receipt};
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{
        ApiError, CommandError, CompositeReview, InventoryOption, LineAction, LineKept, ListingCommand, ListingEvidence,
        OfferMatchCalls as _, OfferReview, Photo, ProductOfferReview, ReadinessDecisions, SellList as _, SellListConfirmation,
        SellListRow, SellPayoutReadiness, SellerListings as _,
    },
    app::{Config, Shared, read_failed, sign_in_back_to, url},
    auth::{DeskSeller, Session},
    items::Raw,
    listing_new::{LIMITS, first},
    selling::{ANONYMOUS_SELL_LIST_COOKIE, SellListLine, account_sell_list},
    text::SellListMsg,
    uploads::{self, Over},
    views::{self, Layout},
};

/// What marketplace's sell list waits for after an add (`ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF`): a list
/// that is not empty.
pub const ADD_LINE_HANDOFF: &str =
    r#"{"kind":"checkout.sell-list.add-line","expectation":"collection-non-empty","surface":"account-sell-list"}"#;
const ADD_LINE_KIND: &str = "checkout.sell-list.add-line";

/// Where the page is: the Sell List, or the Seller Desk's Offers & sell list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    SellList,
    DeskOffers,
}

impl Surface {
    fn read(text: &str) -> Self {
        if text == "desk" { Surface::DeskOffers } else { Surface::SellList }
    }

    pub fn key(self) -> &'static str {
        match self {
            Surface::SellList => "sell-list",
            Surface::DeskOffers => "desk",
        }
    }

    /// The page at this address, with `place`.
    pub fn href(self, place: Place) -> String {
        match self {
            Surface::SellList => url::SellList { place }.href(),
            Surface::DeskOffers => url::DeskOffers { place }.href(),
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Surface::SellList => url::SellList::PATH,
            Surface::DeskOffers => url::DeskOffers::PATH,
        }
    }
}

/// The page's address, as marketplace's pages write it: the write it is read after and the
/// handoff it waits on (`afterWrite`, `postWriteHandoff`), back from registration
/// (`registrationReturn=seller-checkout`), and a seller confirmation still being saved
/// (`confirmation=preparing`, `pendingConfirmationId`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub post_write_handoff: Option<String>,
    pub registration_return: Option<String>,
    pub confirmation: Option<String>,
    pub pending_confirmation_id: Option<String>,
}

impl Place {
    /// After a write: its receipt, and for an add the handoff it waits on.
    pub fn after(receipt: Option<&Receipt>, add: bool) -> Self {
        let after_write = receipt.map(Receipt::param);
        let post_write_handoff = (add && after_write.is_some()).then(|| ADD_LINE_HANDOFF.to_owned());
        Place { after_write, post_write_handoff, ..Place::default() }
    }

    fn registration(&self) -> bool {
        self.registration_return.as_deref() == Some("seller-checkout")
    }

    fn waits_for_a_line(&self) -> bool {
        self.post_write_handoff.as_deref().is_some_and(|h| h.contains(ADD_LINE_KIND) && h.contains("collection-non-empty"))
    }

    /// The seller confirmation the address waits for: none, any, or one.
    fn pending_confirmation(&self) -> Option<Option<String>> {
        (self.confirmation.as_deref() == Some("preparing")).then(|| {
            self.pending_confirmation_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| id.chars().take(200).collect())
        })
    }
}

/// A sell list that is still catching up with a write (marketplace's `sellListRecovery`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    /// The write is saved and the read has not caught up: the page reads itself again.
    Pending,
    /// A seller confirmation is still being saved: the page reads itself again.
    ConfirmationPending,
    /// An add whose line is still not there after its receipt expired: refresh or browse.
    Missing,
}

/// The guest sell list's merge into the account's, back from registration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Merged {
    Lines(u64),
    Failed,
}

/// Why a line cannot go to seller checkout yet, or that it can (`LineReadiness`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineReadiness {
    pub ready: bool,
    pub label: ReadinessLabel,
    pub detail: ReadinessDetail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadinessLabel {
    Ready,
    EvidenceNeedsAction,
    NeedsRefresh,
    NeedsAction,
}

/// A line's readiness in words the page writes: the evidence's unmet codes, or the API's message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadinessDetail {
    EvidenceUnavailable,
    Unmet(Vec<String>),
    StandardPreview,
    SelectedOffer,
    SmartMatch(usize),
    Fallback,
    FallbackForm,
    OfferTermsNeedRefresh,
    ChooseSaleAction,
    Message(String),
}

/// An amount the API sent, in cents; none, or one that is not money, is 0 (as `moneyNumber`).
fn cents(amount: Option<&str>) -> i64 {
    amount.and_then(money::cents).unwrap_or(0)
}

fn times(amount: Option<&str>, quantity: u64) -> i64 {
    cents(amount).saturating_mul(i64::try_from(quantity).unwrap_or(i64::MAX))
}

/// An evidence review that is not complete: `Some(None)` could not be read, `Some(Some(e))` misses
/// `e`'s unmet codes. Absent is no review.
fn evidence_blocks(evidence: &Option<Option<ListingEvidence>>) -> Option<LineReadiness> {
    let blocked = |detail| Some(LineReadiness { ready: false, label: ReadinessLabel::EvidenceNeedsAction, detail });
    match evidence {
        Some(None) => blocked(ReadinessDetail::EvidenceUnavailable),
        Some(Some(e)) if !e.coverage.complete => blocked(ReadinessDetail::Unmet(e.coverage.unmet_codes.clone())),
        _ => None,
    }
}

/// A selected offer's readiness (`selectedOfferReadiness`).
pub fn selected_offer_readiness(review: Option<&OfferReview>) -> LineReadiness {
    match review {
        Some(r) if r.status == "ready" && r.terms.is_some() => {
            if let Some(blocked) = evidence_blocks(&r.evidence) {
                return blocked;
            }
            let standard = r.terms.as_ref().is_some_and(|t| t.standard());
            LineReadiness {
                ready: true,
                label: ReadinessLabel::Ready,
                detail: if standard { ReadinessDetail::StandardPreview } else { ReadinessDetail::SelectedOffer },
            }
        }
        _ => LineReadiness {
            ready: false,
            label: ReadinessLabel::NeedsRefresh,
            detail: review
                .and_then(|r| r.message.clone())
                .map_or(ReadinessDetail::OfferTermsNeedRefresh, ReadinessDetail::Message),
        },
    }
}

fn incomplete_offer(review: Option<&ProductOfferReview>) -> Option<LineReadiness> {
    review?.offers.iter().find_map(|o| evidence_blocks(&o.evidence))
}

/// A product line can go to seller checkout (`productLineCanSubmitCheckout`): no Smart Match offer missing
/// evidence, and an offer or inventory for a listing.
pub fn product_can_submit(review: Option<&ProductOfferReview>, inventory: Option<&InventoryOption>) -> bool {
    incomplete_offer(review).is_none() && (review.is_some_and(|r| !r.offers.is_empty()) || inventory.is_some())
}

/// A product line's readiness (`productLineReadiness`).
pub fn product_readiness(
    line: &SellListRow,
    review: Option<&ProductOfferReview>,
    inventory: Option<&InventoryOption>,
) -> LineReadiness {
    if let Some(blocked) = incomplete_offer(review) {
        return blocked;
    }
    let offers = review.map_or(0, |r| r.offers.len());
    let fallback =
        line.fallback_mode == "create-listing" && inventory.is_some() && cents(line.minimum_listing_price_amount.as_deref()) > 0;
    let ready = |detail| LineReadiness { ready: true, label: ReadinessLabel::Ready, detail };
    if offers > 0 {
        ready(ReadinessDetail::SmartMatch(offers))
    } else if fallback {
        ready(ReadinessDetail::Fallback)
    } else if inventory.is_some() {
        ready(ReadinessDetail::FallbackForm)
    } else {
        LineReadiness {
            ready: false,
            label: ReadinessLabel::NeedsAction,
            detail: review.and_then(|r| r.message.clone()).map_or(ReadinessDetail::ChooseSaleAction, ReadinessDetail::Message),
        }
    }
}

/// An offer the seller may pick on a line: a selected offer's own, or a Smart Match offer.
#[derive(Clone, Debug)]
pub struct Pick {
    pub offer_id: String,
    pub buyer: Option<String>,
    /// The offer's price, its quantity, and what the seller gets and pays a unit.
    pub price: Option<String>,
    pub quantity: u64,
    pub net: Option<String>,
    pub fee: Option<String>,
    pub basis: Option<String>,
    pub allowance_bps: Option<i64>,
}

/// A line as the page draws it, with everything its card and its form fields need.
#[derive(Clone, Debug)]
pub struct Line {
    pub row: SellListRow,
    pub readiness: LineReadiness,
    pub can_submit: bool,
    pub offer_review: Option<OfferReview>,
    pub product_review: Option<ProductOfferReview>,
    pub inventory: Vec<InventoryOption>,
    pub picks: Vec<Pick>,
}

impl Line {
    /// The pick that pays the seller the most a unit, and what it would pay for the line
    /// (`estimatedNet`).
    pub fn best(&self) -> Option<(&Pick, i64)> {
        let best = self.picks.iter().fold(None::<&Pick>, |best, p| match best {
            Some(b) if cents(p.net.as_deref()) <= cents(b.net.as_deref()) => Some(b),
            _ => Some(p),
        })?;
        Some((best, times(best.net.as_deref(), self.row.quantity.min(best.quantity))))
    }

    /// The Smart Match offers' quantity.
    pub fn matched(&self) -> u64 {
        self.product_review.as_ref().map_or(0, |r| r.offers.iter().map(|o| o.offer.quantity_requested).sum())
    }

    /// The inventory a fallback listing ships from by default: the first.
    pub fn default_inventory(&self) -> Option<&InventoryOption> {
        self.inventory.first()
    }

    /// What the remaining quantity does by default: a listing when the offers do not cover it
    /// and there is inventory.
    pub fn fallback_default(&self) -> &'static str {
        if self.matched() < self.row.quantity && self.default_inventory().is_some() { "create-listing" } else { "none" }
    }

    /// A listing's quantity cap by default: the line's quantity, at most what the inventory has.
    pub fn quantity_cap(&self) -> u64 {
        self.row.quantity.min(self.default_inventory().map_or(self.row.quantity, |i| i.available_quantity))
    }

    /// A thumbnail of the line's evidence: its review's first active photo.
    pub fn thumbnail(&self) -> Option<&str> {
        let evidence = match (&self.offer_review, &self.product_review) {
            (Some(r), _) => r.evidence.as_ref(),
            (None, Some(r)) => r.offers.first().and_then(|o| o.evidence.as_ref()),
            _ => None,
        }?;
        evidence.as_ref()?.evidence.iter().filter(|p| p.status == "active").find_map(|p| p.thumbnail())
    }

    /// Where the seller fixes a line that is not ready (`sellListLineRecoveryHref`): inventory for a
    /// product without it, else Create listing.
    pub fn recovery_href(&self) -> String {
        if !self.row.is_offer() && self.default_inventory().is_none() { self.inventory_href() } else { self.setup_href() }
    }

    /// Create listing for the line (`sellListLineSetupHref`).
    pub fn setup_href(&self) -> String {
        let row = &self.row;
        let price = if row.is_offer() { row.offer_price_amount.as_deref() } else { row.minimum_listing_price_amount.as_deref() };
        let mut pairs = Vec::new();
        let inventory = self.default_inventory().filter(|_| !row.is_offer());
        match inventory {
            Some(item) => pairs.push(("inventoryItemId", item.item_id.clone())),
            None => pairs.push(("catalogItemId", row.catalog_catalog_item_id.clone())),
        }
        if cents(price) > 0 {
            pairs.push(("recommendedPrice", price.unwrap_or_default().to_owned()));
        }
        if inventory.is_none() && !row.selected_options.is_empty() {
            pairs.push(("selectedOptions", serde_json::to_string(&row.selected_options).unwrap_or_default()));
        }
        format!("{}?{}", url::NewListing::PATH, query(&pairs))
    }

    /// Inventory for the line's item (`inventorySetupHref`), back to the sell list.
    pub fn inventory_href(&self) -> String {
        let mut pairs =
            vec![("catalogItemId", self.row.catalog_catalog_item_id.clone()), ("returnTo", url::SellList::PATH.to_owned())];
        if !self.row.selected_options.is_empty() {
            pairs.push(("selectedOptions", serde_json::to_string(&self.row.selected_options).unwrap_or_default()));
        }
        format!("{}?{}", url::Inventory::PATH, query(&pairs))
    }
}

/// The page's view model (marketplace's `useSellListPageModel` and its loader's data).
#[derive(Clone, Debug)]
pub struct SellListScreen {
    pub surface: Surface,
    /// An account's sell list; a guest's is the browser's.
    pub account: bool,
    pub registration: bool,
    pub merged: Option<Merged>,
    pub lines: Vec<Line>,
    pub confirmation: Option<SellListConfirmation>,
    pub payout: Option<SellPayoutReadiness>,
    pub recovery: Option<Recovery>,
    /// Why the last write did not happen.
    pub notice: Option<String>,
}

/// The list's totals in cents (`useSellListPageModel`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub quantity: u64,
    pub offer_gross: i64,
    pub future_listing_gross: i64,
    pub fees: i64,
    pub payout: i64,
}

impl SellListScreen {
    pub fn of(
        surface: Surface,
        account: bool,
        rows: Vec<SellListRow>,
        review: CompositeReview,
        payout: Option<SellPayoutReadiness>,
    ) -> Self {
        let mut offers: HashMap<String, OfferReview> = review.offer_reviews.into_iter().map(|r| (r.line_id.clone(), r)).collect();
        let mut products: HashMap<String, ProductOfferReview> =
            review.product_offer_reviews.into_iter().map(|r| (r.line_id.clone(), r)).collect();
        let mut inventory: HashMap<String, Vec<InventoryOption>> = HashMap::new();
        for item in review.inventory_items {
            inventory.entry(item.product_id.clone()).or_default().push(item);
        }
        let lines = rows
            .into_iter()
            .map(|row| {
                let offer_review = offers.remove(&row.line_id).filter(|_| row.is_offer());
                let product_review = products.remove(&row.line_id).filter(|_| !row.is_offer());
                let inventory = inventory.get(&row.product_id).cloned().unwrap_or_default();
                let (readiness, can_submit) = if row.is_offer() {
                    let readiness = selected_offer_readiness(offer_review.as_ref());
                    let ready = readiness.ready;
                    (readiness, ready)
                } else {
                    (
                        product_readiness(&row, product_review.as_ref(), inventory.first()),
                        product_can_submit(product_review.as_ref(), inventory.first()),
                    )
                };
                let picks = match (&offer_review, &product_review) {
                    _ if row.is_offer() => row
                        .offer_id
                        .iter()
                        .map(|id| {
                            let terms = offer_review.as_ref().and_then(|r| r.terms.as_ref());
                            Pick {
                                offer_id: id.clone(),
                                buyer: row.buyer_display_name.clone(),
                                price: row.offer_price_amount.clone(),
                                quantity: row.quantity,
                                net: terms.map(|t| t.seller_net_unit_amount.clone()),
                                fee: terms.map(|t| t.marketplace_sales_fee_unit_amount.clone()),
                                basis: terms.map(|t| t.basis_amount.clone()),
                                allowance_bps: terms.and_then(|t| t.shipping_allowance_percentage_bps),
                            }
                        })
                        .collect(),
                    (_, Some(review)) => review
                        .offers
                        .iter()
                        .map(|o| Pick {
                            offer_id: o.offer.offer_id.clone(),
                            buyer: o.offer.buyer_display_name.clone(),
                            price: Some(o.offer.price_amount.clone()),
                            quantity: o.offer.quantity_requested,
                            net: Some(o.terms.seller_net_unit_amount.clone()),
                            fee: Some(o.terms.marketplace_sales_fee_unit_amount.clone()),
                            basis: Some(o.terms.basis_amount.clone()),
                            allowance_bps: o.terms.shipping_allowance_percentage_bps,
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                Line { row, readiness, can_submit, offer_review, product_review, inventory, picks }
            })
            .collect();
        SellListScreen {
            surface,
            account,
            registration: false,
            merged: None,
            lines,
            confirmation: None,
            payout,
            recovery: None,
            notice: None,
        }
    }

    pub fn totals(&self) -> Totals {
        let mut t = Totals::default();
        for line in &self.lines {
            let row = &line.row;
            t.quantity += row.quantity;
            if row.is_offer() {
                let terms = line.offer_review.as_ref().and_then(|r| r.terms.as_ref());
                t.offer_gross += times(row.offer_price_amount.as_deref(), row.quantity);
                let net = terms.map(|t| t.seller_net_unit_amount.as_str()).or(row.offer_price_amount.as_deref());
                t.payout += times(net, row.quantity);
                t.fees += times(terms.map(|t| t.marketplace_sales_fee_unit_amount.as_str()), row.quantity);
            } else {
                for o in line.product_review.iter().flat_map(|r| &r.offers) {
                    t.payout += times(Some(&o.terms.seller_net_unit_amount), o.offer.quantity_requested);
                    t.fees += times(Some(&o.terms.marketplace_sales_fee_unit_amount), o.offer.quantity_requested);
                }
                let fallback =
                    if row.fallback_mode == "create-listing" { row.quantity.saturating_sub(line.matched()) } else { 0 };
                t.future_listing_gross += times(row.minimum_listing_price_amount.as_deref(), fallback);
            }
        }
        t
    }

    /// Lines not ready.
    pub fn blocked(&self) -> usize {
        self.lines.iter().filter(|l| !l.readiness.ready).count()
    }

    /// Payouts are ready (a guest's are checked after registration).
    pub fn payout_ready(&self) -> bool {
        !self.account || self.payout.as_ref().is_some_and(|p| p.status == "ready")
    }

    /// Continue to seller checkout is offered: payouts ready and every line can go.
    pub fn can_continue(&self) -> bool {
        self.payout_ready() && !self.lines.is_empty() && self.lines.iter().all(|l| l.can_submit)
    }

    /// Payout setup, back to the page.
    pub fn payout_setup_href(&self) -> String {
        format!("/account/payouts/setup?returnTo={}", segment(self.surface.path()))
    }

    /// The other way forward: payout setup, the first line to fix, or keep selling.
    pub fn recovery(&self) -> (String, RecoveryLabel) {
        if !self.payout_ready() {
            return (self.payout_setup_href(), RecoveryLabel::SetUpPayouts);
        }
        let first = self.lines.iter().find(|l| !l.can_submit).or_else(|| self.lines.iter().find(|l| !l.readiness.ready));
        match first {
            Some(line) => {
                (line.recovery_href(), if self.blocked() > 0 { RecoveryLabel::Resolve } else { RecoveryLabel::KeepSelling })
            }
            None => (
                url::Search::PATH.to_owned(),
                if self.blocked() > 0 { RecoveryLabel::Resolve } else { RecoveryLabel::KeepSelling },
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryLabel {
    SetUpPayouts,
    Resolve,
    KeepSelling,
}

/// What Continue sends to seller checkout (`SellListReviewPlan`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub version: u8,
    pub lines: Vec<PlanLine>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLine {
    pub line_id: String,
    pub line_type: &'static str,
    pub item_title: String,
    pub product_id: Option<String>,
    pub quantity: u64,
    pub selected_offer: Option<PlanOffer>,
    pub product_offer_targets: Vec<PlanTarget>,
    pub fallback_listing: Option<PlanListing>,
    pub skipped_reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOffer {
    pub offer_id: String,
    pub listing_id: String,
    pub fee_quote_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTarget {
    pub offer_id: String,
    pub listing_id: String,
    pub fee_quote_fingerprint: String,
    pub quantity: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanListing {
    pub inventory_item_id: String,
    pub price_amount: String,
    pub price_currency_code: String,
    pub quantity_cap: u64,
}

/// A Smart Match offer as Checkout reads it now, for the plan: its product, quantity and listing.
pub struct Matched {
    pub product_id: String,
    pub quantity: u64,
    pub listing_id: String,
}

/// The form's every value for `key`, trimmed, the empty ones left out.
fn all(raw: &Raw, key: &str) -> Vec<String> {
    raw.get(key).map(|v| v.all().iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
}

/// The review plan for `lines` from the posted form (`buildSellListReviewPlan`): each selected
/// offer with its fee quote, each product line's Smart Match offers as Checkout reads them now
/// (`read`, by id) while they fit its quantity, and a listing for the rest when the seller chose
/// one. With offers checked (`bulkOfferId`) only those are planned; the other lines stay in the
/// sell list. A reason a line was skipped is written as marketplace's route writes it.
pub async fn plan<F, Fut>(t: SellListMsg, lines: &[SellListRow], raw: &Raw, read: F) -> Plan
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<Matched, String>>,
{
    let bulk: Vec<String> = all(raw, "bulkOfferId");
    let is_bulk = !bulk.is_empty();
    let mut planned = Vec::new();
    for line in lines {
        let title = &line.item_title;
        let mut skipped = Vec::new();
        if line.is_offer() {
            let fingerprint = first(raw, &format!("offerFeeQuoteFingerprint:{}", line.line_id));
            let mut selected = None;
            let picked = line.offer_id.as_ref().is_some_and(|id| bulk.contains(id));
            if is_bulk && !picked {
                // Unchecked lines stay in the sell list.
            } else if let (Some(offer), Some(listing)) = (&line.offer_id, &line.listing_id) {
                if fingerprint.is_empty() {
                    skipped.push(t.route_offer_terms_need_refresh_detail(title).to_string());
                } else {
                    selected = Some(PlanOffer {
                        offer_id: offer.clone(),
                        listing_id: listing.clone(),
                        fee_quote_fingerprint: fingerprint,
                    });
                }
            } else {
                skipped.push(t.route_selected_offer_missing_detail(title).to_string());
            }
            planned.push(PlanLine {
                line_id: line.line_id.clone(),
                line_type: "selected-offer",
                item_title: title.clone(),
                product_id: Some(line.product_id.clone()),
                quantity: line.quantity,
                selected_offer: selected,
                product_offer_targets: Vec::new(),
                fallback_listing: None,
                skipped_reasons: skipped,
            });
            continue;
        }
        let mut remaining = line.quantity;
        let mut targets = Vec::new();
        let mut ids: Vec<String> = Vec::new();
        for id in all(raw, &format!("productOfferId:{}", line.line_id)) {
            if !ids.contains(&id) && (!is_bulk || bulk.contains(&id)) {
                ids.push(id);
            }
        }
        for id in ids {
            match read(id.clone()).await {
                Ok(offer) if offer.product_id != line.product_id => {
                    skipped.push(format!("{title}: matching offer {id} no longer matches this product."));
                }
                Ok(offer) if offer.quantity > remaining => {
                    skipped.push(format!("{title}: matching offer {id} exceeds remaining quantity."));
                }
                Ok(offer) => {
                    let fingerprint = first(raw, &format!("productOfferFeeQuoteFingerprint:{}:{id}", line.line_id));
                    if fingerprint.is_empty() {
                        skipped.push(format!("{title}: matching offer terms need refresh."));
                        continue;
                    }
                    remaining -= offer.quantity;
                    targets.push(PlanTarget {
                        offer_id: id,
                        listing_id: offer.listing_id,
                        fee_quote_fingerprint: fingerprint,
                        quantity: offer.quantity,
                    });
                }
                Err(message) => skipped.push(format!("{title}: {message}")),
            }
        }
        let mut listing = None;
        let fallback = !is_bulk && first(raw, &format!("fallbackMode:{}", line.line_id)) == "create-listing";
        if remaining > 0 && fallback {
            let field = |name: &str| first(raw, &format!("{name}:{}", line.line_id));
            let (inventory, price, currency) = (field("inventoryItemId"), field("priceAmount"), field("priceCurrencyCode"));
            let asked = field("quantityCap");
            let cap = if asked.is_empty() { Some(remaining) } else { asked.parse::<u64>().ok() }.map(|c| c.min(remaining));
            match cap.filter(|c| *c >= 1) {
                Some(cap) if !inventory.is_empty() && !price.is_empty() && !currency.is_empty() => {
                    listing = Some(PlanListing {
                        inventory_item_id: inventory,
                        price_amount: price,
                        price_currency_code: currency,
                        quantity_cap: cap,
                    });
                }
                _ => skipped.push(format!("{title}: listing needs inventory, price, currency, and quantity.")),
            }
        } else if remaining > 0 && !is_bulk {
            skipped.push(t.route_matching_offers_do_not_cover_quantity_detail(title).to_string());
        }
        planned.push(PlanLine {
            line_id: line.line_id.clone(),
            line_type: "product",
            item_title: title.clone(),
            product_id: Some(line.product_id.clone()),
            quantity: line.quantity,
            selected_offer: None,
            product_offer_targets: targets,
            fallback_listing: listing,
            skipped_reasons: skipped,
        });
    }
    Plan { version: 1, lines: planned }
}

/// The readiness decisions a plan makes (`readinessDecisionsFromReviewPlan`): a skipped line, or one with
/// nothing to do, stays in the sell list.
pub fn decisions(plan: &Plan) -> ReadinessDecisions {
    let mut decisions = ReadinessDecisions::default();
    for line in &plan.lines {
        let action = if !line.skipped_reasons.is_empty() {
            None
        } else if line.line_type == "selected-offer" && line.selected_offer.is_some() {
            Some("selected-offer")
        } else if !line.product_offer_targets.is_empty() {
            Some("smart-match")
        } else if line.fallback_listing.is_some() {
            Some("fallback-listing")
        } else {
            None
        };
        match action {
            Some(action) => decisions.line_actions.push(LineAction { line_id: line.line_id.clone(), action }),
            None => decisions.line_outcomes.push(LineKept { line_id: line.line_id.clone(), outcome: "keep-in-list" }),
        }
    }
    decisions
}

/// A seller confirmation's support reference (`sellListConfirmationSupportReference`).
pub fn support_reference(confirmation_id: &str) -> String {
    let id = confirmation_id.trim();
    let id = id
        .get(..3)
        .filter(|p| p.eq_ignore_ascii_case("slc"))
        .map_or(id, |_| id[3..].strip_prefix(['_', '-']).unwrap_or(&id[3..]));
    let part: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(80)
        .collect::<String>()
        .to_ascii_uppercase();
    format!("CS-SL-{}", if part.is_empty() { "UNKNOWN" } else { &part })
}

/// A query's text, each value encoded as `encodeURIComponent` does.
fn query(pairs: &[(&str, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{k}={}", segment(v))).collect::<Vec<_>>().join("&")
}

/// The guest sell list the browser presents.
pub(crate) fn guest_id(headers: &HeaderMap) -> Option<String> {
    cookie::get(headers, ANONYMOUS_SELL_LIST_COOKIE).filter(|id| id.starts_with("anon_")).map(str::to_owned)
}

fn forget_guest(config: &Config) -> corten::axum::http::HeaderValue {
    let forget = cookie::SetCookie::remove(ANONYMOUS_SELL_LIST_COOKIE);
    let forget = if config.proto == "https" { forget } else { forget.insecure() };
    forget.header()
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sell_list::SellList>,
) -> HtmlResult {
    let place = route.place;
    render(&req, session.as_deref(), &config, &headers, Surface::SellList, &place, None, &chrome).await
}

pub(crate) async fn desk_page(
    req: Req,
    chrome: Chrome,
    Caller(DeskSeller(viewer)): Caller<DeskSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::desk_offers::DeskOffers>,
) -> HtmlResult {
    let place = route.place;
    let session = Session::Account(viewer);
    render(&req, Some(&session), &config, &headers, Surface::DeskOffers, &place, None, &chrome).await
}

/// The page, read after the address's write, with `notice` (a write that did not happen, 422).
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    session: Option<&Session>,
    config: &Config,
    headers: &HeaderMap,
    surface: Surface,
    place: &Place,
    notice: Option<String>,
    chrome: &Chrome,
) -> HtmlResult {
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let t: SellListMsg = req.t();
    let viewer = session.and_then(Session::viewer);
    let account = account_sell_list(session);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    // An add whose receipt has expired, and whose line is still not there, is "missing".
    let expired = place.after_write.is_some() && receipt.is_none();
    let guest = guest_id(headers);
    let mut merged = None;
    let mut forget = false;
    let mut read_receipt = receipt;
    if account && let Some(id) = guest.as_deref() {
        let caller = config.platform.caller(headers, config.proto, None);
        match caller.merge_guest_sell_list(id).await {
            Ok((count, merge_receipt)) => {
                merged = Some(Merged::Lines(count));
                forget = true;
                if count > 0 && merge_receipt.is_some() {
                    read_receipt = merge_receipt;
                }
            }
            Err(error) => {
                tracing::warn!("the guest sell list was not merged: {error}");
                merged = Some(Merged::Failed);
            }
        }
    }
    let caller = config.platform.caller(headers, config.proto, read_receipt.as_ref());
    let waiting = read_receipt.is_some();
    let read = match (account, guest.as_deref()) {
        (true, _) => caller.sell_list(None).await,
        (false, Some(id)) => caller.sell_list(Some(id)).await,
        (false, None) => Ok(Default::default()),
    };
    let mut recovery = None;
    let list = match read {
        Ok(list) => list,
        Err(error) if waiting && error.catching_up() => {
            recovery = Some(Recovery::Pending);
            Default::default()
        }
        Err(error) if expired && place.waits_for_a_line() && error.catching_up() => {
            recovery = Some(Recovery::Missing);
            Default::default()
        }
        Err(error) => {
            return read_failed(req, viewer, error, waiting.then(|| t.route_sell_list_request_failed()), chrome.cart().await);
        }
    };
    if recovery.is_none() && list.items.is_empty() && list.count == 0 && place.waits_for_a_line() {
        recovery = (waiting || expired).then_some(if waiting { Recovery::Pending } else { Recovery::Missing });
    }
    let mut confirmation = list.latest_confirmation;
    if let Some(pending) = place.pending_confirmation().filter(|_| account) {
        let arrived = matches!((&pending, &confirmation), (Some(id), Some(c)) if c.confirmation_id == *id);
        if !arrived {
            confirmation = None;
            recovery = recovery.or(Some(Recovery::ConfirmationPending));
        }
    }
    let (review, payout) = if account && !list.items.is_empty() {
        let review = match caller.sell_list_review(place.registration()).await {
            Ok(review) => review,
            Err(error) if waiting && error.catching_up() => {
                recovery = recovery.or(Some(Recovery::Pending));
                CompositeReview::default()
            }
            Err(error) => return read_failed(req, viewer, error, None, chrome.cart().await),
        };
        let payout = caller.sell_payout_readiness().await.inspect_err(|e| tracing::warn!("payout readiness: {e}")).ok();
        (review, payout)
    } else if account {
        let payout = caller.sell_payout_readiness().await.inspect_err(|e| tracing::warn!("payout readiness: {e}")).ok();
        (CompositeReview::default(), payout)
    } else {
        let reviews = match guest.as_deref().filter(|_| !list.items.is_empty()) {
            Some(id) => caller
                .guest_offer_reviews(id)
                .await
                .inspect_err(|e| tracing::warn!("guest offer reviews: {e}"))
                .unwrap_or_default(),
            None => Vec::new(),
        };
        (CompositeReview { offer_reviews: reviews, ..CompositeReview::default() }, None)
    };
    let mut screen = SellListScreen::of(surface, account, list.items, review, payout);
    screen.registration = account && place.registration();
    screen.merged = merged.filter(|_| screen.registration);
    screen.confirmation = confirmation.filter(|_| account);
    screen.recovery = recovery;
    let status = if notice.is_some() { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::OK };
    screen.notice = notice;
    let reads_again = matches!(screen.recovery, Some(Recovery::Pending | Recovery::ConfirmationPending));
    let head = html! {
        <meta name="description" content={t.route_review_selected_offers_and_product_level()}>
        <meta name="robots" content="noindex">
        if reads_again {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let cart = chrome.cart().await;
    let mut res = req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={viewer} cart={cart} title={t.route_sell_list_chase_sets()} head={head}>
                <views::SellListPage t={t} p={req.t()} screen={&screen} />
            </Layout>
        },
    )?;
    if forget {
        res.headers_mut().append(header::SET_COOKIE, forget_guest(config));
    }
    Ok(res)
}

/// The page's forms: the intent and, for each, what it sends.
pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    act(&req, session.as_deref(), &config, &headers, Surface::SellList, raw, &chrome).await
}

pub(crate) async fn desk_write(
    req: Req,
    chrome: Chrome,
    Caller(DeskSeller(viewer)): Caller<DeskSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let session = Session::Account(viewer);
    act(&req, Some(&session), &config, &headers, Surface::DeskOffers, raw, &chrome).await
}

/// Why a write did not happen, or where it went.
enum Done {
    To(String),
    Refused(String),
    Failed(ApiError),
}

async fn act(
    req: &Req,
    session: Option<&Session>,
    config: &Config,
    headers: &HeaderMap,
    surface: Surface,
    raw: Raw,
    chrome: &Chrome,
) -> HtmlResult {
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let t: SellListMsg = req.t();
    let account = account_sell_list(session);
    let guest = guest_id(headers);
    let caller = config.platform.caller(headers, config.proto, None);
    let failed = t.route_sell_list_request_failed().to_owned();
    let done = match first(&raw, "intent").as_str() {
        "remove-sell-list-line" => {
            let line = first(&raw, "lineId");
            match (account, guest.as_deref()) {
                _ if line.is_empty() => Done::Refused(failed),
                (false, None) => Done::Refused(failed),
                (account, guest) => match caller.remove_sell_list_line(&line, if account { None } else { guest }).await {
                    Ok(receipt) => Done::To(surface.href(Place::after(receipt.as_ref(), false))),
                    Err(error) => Done::Failed(error),
                },
            }
        }
        "add-selected-offer" if !account => Done::Refused(t.page_sign_in_required().to_owned()),
        "add-selected-offer" => {
            let id = first(&raw, "offerId");
            match caller.sell_list_offer(&id).await {
                Ok(Some(offer)) => match caller.add_sell_list_line(&SellListLine::offer_match(&offer), None).await {
                    Ok(receipt) => Done::To(surface.href(Place::after(receipt.as_ref(), true))),
                    Err(error) => Done::Failed(error),
                },
                Ok(None) => Done::Refused(failed),
                Err(error) => Done::Failed(error),
            }
        }
        "decline-sell-list-offers" if !account => Done::Refused(t.page_sign_in_required().to_owned()),
        "decline-sell-list-offers" => decline(&caller, &raw, surface, failed).await,
        "classify-listing-evidence" if !account => Done::Refused(t.page_sign_in_required().to_owned()),
        "classify-listing-evidence" => {
            let listing = first(&raw, "listingId");
            let classification = first(&raw, "classification");
            match classification.split_once("::").filter(|(s, v)| !s.is_empty() && !v.is_empty()) {
                _ if listing.is_empty() => Done::Refused(t.page_evidence_unavailable().to_owned()),
                None => Done::Refused(t.page_evidence_choose_slot().to_owned()),
                Some((slot, view)) => {
                    let command = ListingCommand::Classify {
                        photo: first(&raw, "photoId"),
                        slot_id: Some(slot.to_owned()),
                        view_kind: Some(view.to_owned()),
                        alt_text: None,
                    };
                    listing_written(caller.listing_command(&listing, &command).await, surface, &failed)
                }
            }
        }
        "review-sell-list-checkout" => review(t, &caller, &raw, account, guest.as_deref()).await,
        _ => return Err(corten::Error::status(StatusCode::BAD_REQUEST)),
    };
    match done {
        Done::To(to) => {
            let to = to.parse::<Uri>().map_err(corten::Error::new)?;
            req.redirect(&to)
        }
        Done::Refused(message) => render(req, session, config, headers, surface, &Place::default(), Some(message), chrome).await,
        Done::Failed(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => match sign_in_back_to(surface.path()) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            },
            Some(StatusCode::FORBIDDEN) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
            Some(status) if status.is_client_error() => {
                let message = error.refusal().unwrap_or(t.route_sell_list_request_failed()).to_owned();
                render(req, session, config, headers, surface, &Place::default(), Some(message), chrome).await
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}

/// A listing write's outcome: the page again, read after it, or why it did not happen.
fn listing_written(result: Result<Option<Receipt>, CommandError>, surface: Surface, failed: &str) -> Done {
    match result {
        Ok(receipt) => Done::To(surface.href(Place::after(receipt.as_ref(), false))),
        Err(CommandError::Api(error)) => Done::Failed(error),
        Err(CommandError::EvidenceIncomplete { message, .. }) if !message.is_empty() => Done::Refused(message),
        Err(other) => {
            tracing::warn!("a listing evidence write was refused: {other:?}");
            Done::Refused(failed.to_owned())
        }
    }
}

/// Decline selected (`decline-sell-list-offers`): each checked offer (at most 100) declined on
/// Marketplace (each as the attempt `decline_{id}`, padded to 22 with `_`), then the
/// selected-offer lines for them removed, as marketplace's action does.
async fn decline(caller: &platform::api::Caller<'_>, raw: &Raw, surface: Surface, failed: String) -> Done {
    let mut ids: Vec<String> = Vec::new();
    for id in all(raw, "bulkOfferId") {
        if !ids.contains(&id) && ids.len() < 100 {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Done::Refused(failed);
    }
    let list = match caller.sell_list(None).await {
        Ok(list) => list,
        Err(error) => return Done::Failed(error),
    };
    for id in &ids {
        // The offer's own attempt, as marketplace's action names it, so declining it again is the same one.
        match caller.decline_offer_match(id, &format!("{:_<22}", format!("decline_{id}"))).await {
            Ok(_) => {}
            Err(CommandError::Api(error)) => return Done::Failed(error),
            Err(other) => {
                tracing::warn!("a decline was refused with a listing's conflict: {other:?}");
                return Done::Refused(failed);
            }
        }
    }
    let mut last = None;
    for line in list.items.iter().filter(|l| l.is_offer() && l.offer_id.as_ref().is_some_and(|id| ids.contains(id))) {
        match caller.remove_sell_list_line(&line.line_id, None).await {
            Ok(receipt) => last = receipt.or(last),
            Err(error) => return Done::Failed(error),
        }
    }
    Done::To(surface.href(Place::after(last.as_ref(), false)))
}

/// Continue to seller checkout (`review-sell-list-checkout`). An account's: the plan from the posted form,
/// its decisions sent for the sell list's readiness, and marketplace's seller checkout with the
/// snapshot, the decisions and the plan, read after the readiness write. A guest's: the guest
/// sell list's readiness, then marketplace's registration, back to the sell list.
async fn review(t: SellListMsg, caller: &platform::api::Caller<'_>, raw: &Raw, account: bool, guest: Option<&str>) -> Done {
    let back = format!("{}?registrationReturn=seller-checkout", url::SellList::PATH);
    if !account {
        let Some(id) = guest else {
            return Done::To(sign_in_back_to(&back).map(|u| u.to_string()).unwrap_or_else(|| back.clone()));
        };
        return match caller.sell_list_readiness(&ReadinessDecisions::default(), Some(id)).await {
            Ok((snapshot, _)) if snapshot.status == "ready" && snapshot.unresolved_line_ids.is_empty() => {
                Done::To(crate::register::href(&back))
            }
            Ok(_) => Done::Refused(t.route_sell_list_readiness_must_be_resolved().to_owned()),
            Err(error) => Done::Failed(error),
        };
    }
    let list = match caller.sell_list(None).await {
        Ok(list) => list,
        Err(error) => return Done::Failed(error),
    };
    let read = |id: String| async move {
        match caller.sell_list_offer(&id).await {
            Ok(Some(offer)) => {
                Ok(Matched { product_id: offer.product_id, quantity: offer.quantity_requested, listing_id: offer.listing_id })
            }
            Ok(None) => Err("offer match failed".to_owned()),
            Err(error) => Err(error.refusal().map_or_else(|| "offer match failed".to_owned(), str::to_owned)),
        }
    };
    let plan = plan(t, &list.items, raw, read).await;
    let decisions = decisions(&plan);
    let (snapshot, receipt) = match caller.sell_list_readiness(&decisions, None).await {
        Ok(answer) => answer,
        Err(error) => return Done::Failed(error),
    };
    if snapshot.status != "ready" || !snapshot.unresolved_line_ids.is_empty() {
        return Done::Refused(t.route_sell_list_readiness_must_be_resolved().to_owned());
    }
    Done::To(checkout_path(&snapshot.snapshot_id, &snapshot.source_revision, &decisions, &plan, receipt.as_ref()))
}

/// Seller checkout for a readiness snapshot (marketplace's `sellCheckoutRedirectUrl`): a new session
/// id, with the write's receipt.
pub fn checkout_path(
    snapshot: &str,
    revision: &str,
    decisions: &ReadinessDecisions,
    plan: &Plan,
    receipt: Option<&Receipt>,
) -> String {
    let id = format!("chk_{}", ulid::Ulid::new());
    let place = crate::sell_checkout::Place {
        readiness_snapshot_id: Some(snapshot.to_owned()),
        readiness_source_revision: Some(revision.to_owned()),
        readiness_decisions: Some(serde_json::to_string(decisions).unwrap_or_default()),
        sell_list_review_plan: Some(serde_json::to_string(plan).unwrap_or_default()),
        after_write: receipt.map(Receipt::param),
    };
    url::SellCheckout { id: &id, place }.href()
}

/// Add photo (`add-listing-evidence`): `multipart/form-data`, the photo added to the listing on
/// Marketplace with its alt text.
pub(crate) async fn evidence(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    upload: Upload<Raw>,
) -> HtmlResult {
    let session = session.as_deref();
    let t: SellListMsg = req.t();
    let posted = match uploads::read(upload, LIMITS).await {
        Ok(posted) => posted,
        Err(UploadError::TooLarge { .. }) => {
            let p: crate::text::Pilot = req.t();
            let message = p.seller_listing_photos_too_large().to_owned();
            return render(&req, session, &config, &headers, Surface::SellList, &Place::default(), Some(message), &chrome).await;
        }
        Err(other) => return Err(other.into()),
    };
    let surface = Surface::read(&first(&posted.fields, "surface"));
    if !account_sell_list(session) {
        let message = t.page_sign_in_required().to_owned();
        return render(&req, session, &config, &headers, surface, &Place::default(), Some(message), &chrome).await;
    }
    let listing = first(&posted.fields, "listingId");
    let file = posted.files.into_iter().find(|u| u.field == "listingPhoto" && !u.bytes.is_empty());
    let refusal = match (&file, posted.over) {
        _ if listing.is_empty() => Some(t.page_evidence_unavailable()),
        (_, Some(Over::FileTooLarge | Over::TooManyFiles)) | (None, _) => Some(t.page_evidence_photo()),
        (Some(u), None) if !uploads::is_picture(&u.content_type, &u.bytes) => Some(t.page_evidence_photo()),
        _ => None,
    };
    let file = match (file, refusal) {
        (Some(file), None) => file,
        (_, refusal) => {
            let message = refusal.unwrap_or(t.page_evidence_photo()).to_owned();
            return render(&req, session, &config, &headers, surface, &Place::default(), Some(message), &chrome).await;
        }
    };
    let photo = Photo { filename: file.filename, content_type: file.content_type, bytes: file.bytes };
    let alt = first(&posted.fields, "listingPhotoAltText");
    let caller = config.platform.caller(&headers, config.proto, None);
    let failed = t.route_sell_list_request_failed().to_owned();
    match listing_written(caller.add_listing_photos(&listing, &[photo], Some(&alt)).await, surface, &failed) {
        Done::To(to) => req.redirect(&to.parse::<Uri>().map_err(corten::Error::new)?),
        Done::Refused(message) => {
            render(&req, session, &config, &headers, surface, &Place::default(), Some(message), &chrome).await
        }
        Done::Failed(error) => {
            let message = error.refusal().map_or(failed, str::to_owned);
            render(&req, session, &config, &headers, surface, &Place::default(), Some(message), &chrome).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer_review(status: &str, terms: bool, evidence: Option<Option<ListingEvidence>>) -> OfferReview {
        OfferReview {
            line_id: "sll_1".into(),
            status: status.into(),
            terms: terms.then(crate::api::SellTerms::default),
            message: None,
            evidence,
            ..OfferReview::default()
        }
    }

    #[test]
    fn a_selected_offer_is_ready_with_terms_and_complete_or_no_evidence() {
        assert!(selected_offer_readiness(Some(&offer_review("ready", true, None))).ready);
        let unread = selected_offer_readiness(Some(&offer_review("ready", true, Some(None))));
        assert_eq!((unread.ready, unread.label), (false, ReadinessLabel::EvidenceNeedsAction));
        let refresh = selected_offer_readiness(Some(&offer_review("ready", false, None)));
        assert_eq!((refresh.label, refresh.detail), (ReadinessLabel::NeedsRefresh, ReadinessDetail::OfferTermsNeedRefresh));
        let said = OfferReview { message: Some("Offer expired.".into()), ..offer_review("unavailable", true, None) };
        assert_eq!(selected_offer_readiness(Some(&said)).detail, ReadinessDetail::Message("Offer expired.".into()));
        assert!(!selected_offer_readiness(None).ready);
    }

    #[test]
    fn a_product_line_needs_an_offer_or_inventory_and_a_listing_needs_a_minimum_price() {
        let row = |fallback: &str, minimum: Option<&str>| SellListRow {
            line_type: "product".into(),
            fallback_mode: fallback.into(),
            minimum_listing_price_amount: minimum.map(str::to_owned),
            quantity: 1,
            ..SellListRow::default()
        };
        let stock = InventoryOption { item_id: "inv_1".into(), available_quantity: 1, ..InventoryOption::default() };
        let none = product_readiness(&row("none", None), None, None);
        assert_eq!((none.ready, none.detail), (false, ReadinessDetail::ChooseSaleAction));
        assert!(!product_can_submit(None, None));
        assert_eq!(
            product_readiness(&row("create-listing", Some("20.00")), None, Some(&stock)).detail,
            ReadinessDetail::Fallback
        );
        // A minimum that is not money (or 0) is the listing form, still ready.
        assert_eq!(
            product_readiness(&row("create-listing", Some("abc")), None, Some(&stock)).detail,
            ReadinessDetail::FallbackForm
        );
        assert!(product_can_submit(None, Some(&stock)));
    }

    #[test]
    fn a_support_reference_drops_the_prefix_and_keeps_safe_characters() {
        assert_eq!(support_reference("slc_01JABC"), "CS-SL-01JABC");
        assert_eq!(support_reference(" SLC-ab/c "), "CS-SL-AB_C");
        assert_eq!(support_reference("slc_"), "CS-SL-UNKNOWN");
        assert_eq!(support_reference("other"), "CS-SL-OTHER");
    }

    #[test]
    fn a_skipped_line_or_one_with_nothing_to_do_stays_in_the_sell_list() {
        let line = |id: &str, skipped: bool, listing: bool| PlanLine {
            line_id: id.into(),
            line_type: "product",
            item_title: "Pikachu".into(),
            product_id: None,
            quantity: 1,
            selected_offer: None,
            product_offer_targets: Vec::new(),
            fallback_listing: listing.then(|| PlanListing {
                inventory_item_id: "inv_1".into(),
                price_amount: "1.00".into(),
                price_currency_code: "USD".into(),
                quantity_cap: 1,
            }),
            skipped_reasons: if skipped { vec!["no".into()] } else { Vec::new() },
        };
        let plan = Plan { version: 1, lines: vec![line("a", false, true), line("b", true, true), line("c", false, false)] };
        let d = decisions(&plan);
        assert_eq!(d.line_actions, [LineAction { line_id: "a".into(), action: "fallback-listing" }]);
        let kept: Vec<_> = d.line_outcomes.iter().map(|k| k.line_id.as_str()).collect();
        assert_eq!(kept, ["b", "c"]);
    }
}
