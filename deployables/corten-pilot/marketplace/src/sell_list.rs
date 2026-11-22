//! Sell > Sell List (Checkout's `account-sell-list`, at `/account/sell-list`, and the Seller Desk's `account-desk-offers`,
//! the same page at `/account/desk/offers`): the sell list's lines, what each needs before seller
//! checkout, the expected payout, and Continue to seller checkout. A guest's is the browser's guest
//! sell list (its cookie), with the account gate; signing in moves it into the account's.
//!
//! The page's writes are marketplace's intents: Remove (a line), Decline selected (the checked
//! offers, declined on Marketplace, then their lines removed), Classify and Add photo (a listing's
//! evidence, on Marketplace) and Continue to seller checkout, which posts the seller's choices,
//! asks Checkout to review the sell list with them, and starts the pilot's seller checkout
//! with the snapshot (`/checkout/sell/session/{id}`, in [`crate::sell_checkout`]). A guest's Continue checks the guest
//! sell list's readiness and goes to marketplace's registration.
//!
//! A line added or removed is one Checkout command attempt (chase-sets/chase-sets#9995): the
//! form's `SubmitKey` (`attemptId`) is its id, so a form sent twice applies once. Decline
//! selected declines each offer as an attempt made from the form's, then removes the declined
//! offers' lines in one batch attempt; the lines are found with the first send and carried by the
//! form from then on (marketplace's `declinedLineTargetsCaptured`). A write not known to have
//! applied, or applied only in part, draws the page with its writes held and the same write to
//! send again (409), as marketplace's `SellListAttemptBoundary` does; one refused draws the
//! page with the API's words (422).
//!
//! Each line's readiness, the list's totals and the way forward are Checkout's: its composite
//! review answers them for the page (`screen`,
//! [chase-sets/chase-sets#10749](https://github.com/chase-sets/chase-sets/issues/10749)), and the
//! page puts them in words. Continue's review plan is Checkout's too: the page sends what the
//! seller chose, and Checkout plans and keeps it.
use std::{collections::HashMap, time::Duration};

use corten::{
    http::{HeaderMap, StatusCode, Uri, header},
    prelude::*,
    security::cookie,
};
use platform::{
    api::segment,
    money,
    post_write::{self, Handoff, HandoffState},
    receipt::{Freshness, Receipt},
};

use crate::{
    api::{
        ApiError, CartWrite, CommandError, CompositeReview, InventoryOption, LineSelection, ListingCommand, ListingSelection,
        OfferMatchCalls as _, OfferReview, OfferSelection, Photo, ProductOfferReview, ReviewSelections, SellList as _,
        SellListConfirmation, SellListLineReview, SellListRow, SellListScreenReview, SellPayoutReadiness, SellerListings as _,
    },
    app::{Config, Shared, read_failed, sign_in_back_to, url},
    auth::{DeskSeller, Session},
    cart_attempt::{self, State as Attempted},
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

/// Whether a handoff is the add's (`isAccountSellListAddLineHandoff`).
fn adds_a_line(handoff: &Handoff) -> bool {
    handoff.kind == ADD_LINE_KIND && handoff.expectation == "collection-non-empty"
}

/// A line write's attempt (a `SubmitKey`), as marketplace's Sell List forms name it.
pub const ATTEMPT: &str = "attemptId";

/// The field a Sell List line write's form carries its attempt in ([`ATTEMPT`]).
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct LineForm {
    pub attempt_id: Option<SubmitKey>,
}
/// Decline selected's lines to remove, as the first send found them, and that it found them
/// (marketplace's `declinedLineId` and `declinedLineTargetsCaptured`).
const DECLINED_LINE: &str = "declinedLineId";
const DECLINED_CAPTURED: &str = "declinedLineTargetsCaptured";

/// What the page says above the lines after a write: why it was refused, or what it came to when
/// it did not fully apply.
#[derive(Clone, Debug)]
pub enum Notice {
    Refused(String),
    Attempt(AttemptNotice),
}

/// A line write not known to have applied, or applied only in part (marketplace's
/// `SellListAttemptState`): the page's writes wait while `resend`, the form as posted with its
/// attempt, is offered to send again.
#[derive(Clone, Debug)]
pub struct AttemptNotice {
    /// `Ambiguous` or `Partial`.
    pub state: Attempted,
    /// The API's words, when it gave any.
    pub message: Option<String>,
    /// The messages of the lines a batch did not apply.
    pub not_applied: Vec<Option<String>>,
    /// Decline selected's offers, each with what its decline came to.
    pub declines: Vec<(String, Declined)>,
    pub resend: Vec<(String, String)>,
}

/// What an offer's decline came to, when Decline selected stopped on one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Declined {
    Yes,
    /// Its decline failed or its answer was lost: not known.
    Unconfirmed,
    /// Not sent: an earlier offer's stopped the batch.
    NotSent,
}

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
#[derive(Clone, Debug, Default, Fields, Route)]
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

/// The sell list's post-write outcomes, as marketplace records them
/// (`recordAccountSellListPostWriteConsistencyOutcome`), for a guest's list or an account's.
struct Outcomes {
    actor: &'static str,
}

impl Outcomes {
    fn record(&self, outcome: &'static str, freshness: &'static str, recovery: &'static str, source: &str) {
        post_write::record(post_write::Event {
            context: "checkout",
            surface: "account-sell-list",
            strategy: "fresh-read",
            outcome,
            route_id: "account-sell-list",
            route_template: "/account/sell-list",
            correction_source: Some(source.to_owned()),
            actor_mode: Some(self.actor),
            recovery_action: Some(recovery),
            freshness_outcome: Some(freshness),
            ..Default::default()
        });
    }

    /// An outcome of the add's handoff, in the sell list's words for its state
    /// (`freshnessOutcomeForHandoffState`).
    fn handoff(&self, outcome: &'static str, state: &HandoffState, recovery: &'static str) {
        let freshness = match state {
            HandoffState::Missing(_) => "missing-after-write",
            HandoffState::Malformed(_) => "malformed-handoff",
            HandoffState::NotFreshWrite(_, Freshness::Expired) => "expired-after-write",
            HandoffState::NotFreshWrite(_, Freshness::Future) => "future-after-write",
            HandoffState::NotFreshWrite(..) => "missing-after-write",
            HandoffState::Valid(_) => "valid-after-write",
        };
        self.record(outcome, freshness, recovery, &format!("semantic-handoff:{ADD_LINE_KIND}"));
    }

    /// What a read found against the address's handoff (`evaluatePostWriteHandoff`), and the
    /// recovery it draws: an add's list still empty while its receipt is fresh is still being
    /// saved, and once the receipt has expired it is missing.
    fn read(&self, state: &HandoffState, empty: bool) -> Option<Recovery> {
        match state {
            HandoffState::Valid(h) if adds_a_line(h) && empty => {
                self.handoff("handoff_pending", state, "pending_empty_state");
                return Some(Recovery::Pending);
            }
            HandoffState::NotFreshWrite(h, Freshness::Expired) if adds_a_line(h) && empty => {
                self.handoff("handoff_expired", state, "action_required");
                return Some(Recovery::Missing);
            }
            HandoffState::Missing(_) => {}
            HandoffState::Malformed(_) => self.handoff("handoff_malformed", state, "none"),
            HandoffState::NotFreshWrite(_, Freshness::Expired) => self.handoff("handoff_expired", state, "none"),
            HandoffState::NotFreshWrite(..) => self.handoff("handoff_invalid", state, "none"),
            HandoffState::Valid(h) if !adds_a_line(h) => self.handoff("handoff_invalid", state, "none"),
            HandoffState::Valid(_) => self.handoff("handoff_satisfied", state, "none"),
        }
        None
    }

    /// A read after a fresh write that failed only because the write is not readable yet
    /// (`recoverSellListFreshWriteReadError`): the projection's own timeout, or another.
    fn caught_up_with(&self, error: &ApiError, freshness: Freshness, source: &str) {
        let timeout = error.code() == Some("projection_freshness_timeout");
        self.record(if timeout { "freshness_timeout" } else { "fallback_used" }, freshness.outcome(), "reload_prompt", source);
    }

    /// Whether Settlement's payout readiness reached a page read after a write it took part in
    /// (`recordPayoutReadinessPostWriteConsistencyOutcome`).
    fn payout_readiness(&self, available: bool, freshness: Freshness) {
        post_write::record(post_write::Event {
            context: "settlement",
            surface: "payout-readiness",
            strategy: "fresh-read",
            outcome: if available { "projection_hit" } else { "freshness_timeout" },
            route_id: "account-sell-list",
            route_template: "/account/sell-list",
            correction_source: Some("settlement-payout-readiness".to_owned()),
            actor_mode: Some("account"),
            recovery_action: Some(if available { "none" } else { "reload_prompt" }),
            freshness_outcome: Some(freshness.outcome()),
            source_context: Some("settlement"),
            projection: Some("settlement-payout-readiness-projection"),
            read_model_table: Some("settlement_payout_readiness_pages"),
        });
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

/// A line's readiness as Checkout reviewed it (`screen.lines`), in the page's terms. A line the
/// review does not answer for (it could not be read) is not ready: a selected offer's terms need a
/// refresh, a product line a sale action.
pub fn readiness(review: Option<&SellListLineReview>, offer: bool) -> LineReadiness {
    let unknown = || {
        if offer {
            LineReadiness { ready: false, label: ReadinessLabel::NeedsRefresh, detail: ReadinessDetail::OfferTermsNeedRefresh }
        } else {
            LineReadiness { ready: false, label: ReadinessLabel::NeedsAction, detail: ReadinessDetail::ChooseSaleAction }
        }
    };
    let Some(review) = review else { return unknown() };
    let label = match review.label_code.as_str() {
        "ready" => ReadinessLabel::Ready,
        "evidence-needs-action" => ReadinessLabel::EvidenceNeedsAction,
        "needs-refresh" => ReadinessLabel::NeedsRefresh,
        _ => ReadinessLabel::NeedsAction,
    };
    let message = review.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    let detail = match (message, review.detail_code.as_str()) {
        (Some(message), _) => ReadinessDetail::Message(message.to_owned()),
        (None, "evidence-unavailable") => ReadinessDetail::EvidenceUnavailable,
        (None, "evidence-incomplete") => ReadinessDetail::Unmet(review.unmet_evidence_codes.clone()),
        (None, "public-standard-preview-ready") => ReadinessDetail::StandardPreview,
        (None, "selected-offer-ready") => ReadinessDetail::SelectedOffer,
        (None, "smart-match-ready") => ReadinessDetail::SmartMatch(review.parameters.count.unwrap_or(0) as usize),
        (None, "fallback-listing-ready") => ReadinessDetail::Fallback,
        (None, "fallback-listing-form-ready") => ReadinessDetail::FallbackForm,
        (None, "offer-terms-need-refresh") => ReadinessDetail::OfferTermsNeedRefresh,
        (None, "choose-sale-action") => ReadinessDetail::ChooseSaleAction,
        // A code this page does not know: the line's usual words for being ready or not.
        (None, _) if review.ready => {
            if offer {
                ReadinessDetail::SelectedOffer
            } else {
                ReadinessDetail::FallbackForm
            }
        }
        (None, _) => unknown().detail,
    };
    LineReadiness { ready: review.ready, label, detail }
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
    /// Checkout's review of the line, with its links, when the review was read.
    pub review: Option<SellListLineReview>,
    pub offer_review: Option<OfferReview>,
    pub product_review: Option<ProductOfferReview>,
    pub inventory: Vec<InventoryOption>,
    pub picks: Vec<Pick>,
}

impl Line {
    /// The pick that pays the seller the most a unit, and what it would pay for its own quantity
    /// (`estimatedNet`): none when it has no terms yet.
    pub fn best(&self) -> Option<(&Pick, Option<i64>)> {
        let best = self.picks.iter().fold(None::<&Pick>, |best, p| match best {
            Some(b) if cents(p.net.as_deref()) <= cents(b.net.as_deref()) => Some(b),
            _ => Some(p),
        })?;
        Some((best, best.net.as_deref().map(|net| times(Some(net), best.quantity))))
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

    /// Create listing for the line (Checkout's `setupHref`), when the review was read.
    pub fn setup_href(&self) -> Option<&str> {
        self.review.as_ref().map(|r| r.setup_href.as_str()).filter(|h| !h.is_empty())
    }

    /// Inventory for the line's item, back to the sell list (Checkout's `inventoryHref`), when the
    /// review was read.
    pub fn inventory_href(&self) -> Option<&str> {
        self.review.as_ref().map(|r| r.inventory_href.as_str()).filter(|h| !h.is_empty())
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
    /// What Checkout worked out for the page: readiness, totals and the way forward
    /// (chase-sets/chase-sets#10749). None when the review could not be read.
    pub review: Option<SellListScreenReview>,
    pub confirmation: Option<SellListConfirmation>,
    pub payout: Option<SellPayoutReadiness>,
    pub recovery: Option<Recovery>,
    /// Why the last write did not happen.
    pub notice: Option<String>,
    /// The last write, when it is not known to have applied or applied in part.
    pub attempt: Option<AttemptNotice>,
}

/// The list's totals in cents, as Checkout added them up. The amounts are none while they are
/// not known: the fees and the payout while a line is not quoted, and all of them when the review
/// could not be read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub quantity: u64,
    pub offer_gross: Option<i64>,
    pub future_listing_gross: Option<i64>,
    pub fees: Option<i64>,
    pub payout: Option<i64>,
    /// A product line has more than one offer, so the payout is all of them (`hasMultipleOffers`).
    pub all_offers: bool,
}

impl SellListScreen {
    /// The page for `rows` and their review. `payout` is the payout readiness read on its own,
    /// for a list Checkout was not asked to review; the review's own comes first.
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
        let mut screen = review.screen;
        let lines = rows
            .into_iter()
            .map(|row| {
                let offer_review = offers.remove(&row.line_id).filter(|_| row.is_offer());
                let product_review = products.remove(&row.line_id).filter(|_| !row.is_offer());
                let inventory = inventory.get(&row.product_id).cloned().unwrap_or_default();
                let line_review = screen.as_mut().and_then(|s| s.lines.remove(&row.line_id));
                let readiness = readiness(line_review.as_ref(), row.is_offer());
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
                Line { row, readiness, review: line_review, offer_review, product_review, inventory, picks }
            })
            .collect();
        let payout = match &screen {
            Some(review) => review.payout_readiness.clone(),
            None => payout,
        };
        SellListScreen {
            surface,
            account,
            registration: false,
            merged: None,
            lines,
            review: screen,
            confirmation: None,
            payout,
            recovery: None,
            notice: None,
            attempt: None,
        }
    }

    pub fn totals(&self) -> Totals {
        let quantity = self.lines.iter().map(|l| l.row.quantity).sum();
        let Some(review) = &self.review else { return Totals { quantity, ..Totals::default() } };
        Totals {
            quantity: review.total_quantity,
            offer_gross: money::cents(&review.selected_offer_gross),
            future_listing_gross: money::cents(&review.future_listing_gross),
            fees: review.estimated_sales_fees.as_deref().and_then(money::cents),
            payout: review.expected_seller_payout.as_deref().and_then(money::cents),
            all_offers: review.has_multiple_offers,
        }
    }

    /// Lines not ready.
    pub fn blocked(&self) -> usize {
        match &self.review {
            Some(review) => usize::try_from(review.blocked_line_count).unwrap_or(usize::MAX),
            None => self.lines.len(),
        }
    }

    /// Lines ready.
    pub fn ready(&self) -> usize {
        self.review.as_ref().map_or(0, |r| usize::try_from(r.ready_line_count).unwrap_or(usize::MAX))
    }

    /// Payouts are ready (a guest's are checked after registration).
    pub fn payout_ready(&self) -> bool {
        match &self.review {
            Some(review) => review.payout_is_ready,
            None => !self.account || self.payout.as_ref().is_some_and(|p| p.status == "ready"),
        }
    }

    /// Continue to seller checkout is offered (Checkout's `canContinue`).
    pub fn can_continue(&self) -> bool {
        self.review.as_ref().is_some_and(|r| r.can_continue)
    }

    /// Payout setup, back to the page.
    pub fn payout_setup_href(&self) -> String {
        match self.review.as_ref().map(|r| r.payout_setup_href.as_str()).filter(|h| !h.is_empty()) {
            Some(href) => href.to_owned(),
            None => format!("/account/payouts/setup?returnTo={}", segment(self.surface.path())),
        }
    }

    /// The other way forward (Checkout's `recoveryHref` and `recoveryCode`): payout setup, the
    /// first line to fix, or keep selling. Without the review, search, to resolve the lines.
    pub fn recovery(&self) -> (String, RecoveryLabel) {
        let Some(review) = self.review.as_ref().filter(|r| !r.recovery_href.is_empty()) else {
            return (url::Search::PATH.to_owned(), RecoveryLabel::Resolve);
        };
        let label = match review.recovery_code.as_str() {
            "set-up-payouts" => RecoveryLabel::SetUpPayouts,
            "keep-selling" => RecoveryLabel::KeepSelling,
            _ => RecoveryLabel::Resolve,
        };
        (review.recovery_href.clone(), label)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryLabel {
    SetUpPayouts,
    Resolve,
    KeepSelling,
}

/// The form's every value for `key`, trimmed, the empty ones left out.
fn all(raw: &Raw, key: &str) -> Vec<String> {
    raw.get(key).map(|v| v.all().iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
}

/// What the seller chose, from the posted form, as Continue sends it (marketplace's
/// `reviewSelectionsFromForm`): each line the form names a selected offer's fee quote, a Smart
/// Match offer or a fallback mode for, with those, and a listing when the seller chose to create
/// one. Checkout plans from these against the lines as it reads them.
pub fn selections(raw: &Raw) -> ReviewSelections {
    const PREFIXES: [&str; 3] = ["offerFeeQuoteFingerprint:", "productOfferId:", "fallbackMode:"];
    let mut ids: Vec<&str> = Vec::new();
    for key in raw.keys() {
        if let Some(id) = PREFIXES.iter().find_map(|prefix| key.strip_prefix(prefix))
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    let lines = ids
        .into_iter()
        .map(|id| {
            let field = |name: &str| first(raw, &format!("{name}:{id}"));
            LineSelection {
                line_id: id.to_owned(),
                selected_offer_fee_quote_fingerprint: field("offerFeeQuoteFingerprint"),
                product_offers: all(raw, &format!("productOfferId:{id}"))
                    .into_iter()
                    .map(|offer| OfferSelection {
                        fee_quote_fingerprint: first(raw, &format!("productOfferFeeQuoteFingerprint:{id}:{offer}")),
                        offer_id: offer,
                    })
                    .collect(),
                fallback_listing: (field("fallbackMode") == "create-listing").then(|| ListingSelection {
                    inventory_item_id: field("inventoryItemId"),
                    price_amount: field("priceAmount"),
                    price_currency_code: field("priceCurrencyCode"),
                    quantity_cap: field("quantityCap"),
                }),
            }
        })
        .collect();
    ReviewSelections { bulk_offer_ids: all(raw, "bulkOfferId"), lines }
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

/// The guest sell list the browser presents.
pub(crate) fn guest_id(headers: &HeaderMap) -> Option<String> {
    cookie::get(headers, ANONYMOUS_SELL_LIST_COOKIE).filter(|id| id.starts_with("anon_")).map(str::to_owned)
}

fn forget_guest(config: &Config) -> corten::http::HeaderValue {
    let forget = cookie::SetCookie::remove(ANONYMOUS_SELL_LIST_COOKIE);
    let forget = if config.proto == "https" { forget } else { forget.insecure() };
    forget.header()
}

pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sell_list::SellList>,
) -> HtmlResult {
    let place = route.place;
    render(&req, session.as_deref(), &config, &headers, Surface::SellList, &place, None).await
}

pub(crate) async fn desk_page(
    req: Req,
    Caller(DeskSeller(viewer)): Caller<DeskSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::desk_offers::DeskOffers>,
) -> HtmlResult {
    let place = route.place;
    let session = Session::Account(viewer);
    render(&req, Some(&session), &config, &headers, Surface::DeskOffers, &place, None).await
}

/// The page, read after the address's write, with `notice`: a write that did not happen (422), or
/// one not known to have applied or applied in part (409).
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    session: Option<&Session>,
    config: &Config,
    headers: &HeaderMap,
    surface: Surface,
    place: &Place,
    notice: Option<Notice>,
) -> HtmlResult {
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let t: SellListMsg = req.t();
    let viewer = session.and_then(Session::viewer);
    let account = account_sell_list(session);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    // A write Settlement took part in, whose payout readiness the page should then show.
    let settled = receipt.as_ref().is_some_and(|r| r.has_source("settlement"));
    let mut handoff = HandoffState::of(place.post_write_handoff.as_deref(), place.after_write.as_deref());
    let outcomes = Outcomes { actor: if account { "account" } else { "guest" } };
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
                    // As marketplace's `requestWithMergeFreshness`: the merged lines are an add.
                    let add = Handoff {
                        kind: ADD_LINE_KIND.to_owned(),
                        expectation: "collection-non-empty".to_owned(),
                        surface: Some("account-sell-list".to_owned()),
                    };
                    handoff = HandoffState::Valid(add);
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
    // An add whose receipt has expired, and whose line is still not there, is "missing".
    let lapsed = matches!(&handoff, HandoffState::NotFreshWrite(h, Freshness::Expired) if adds_a_line(h));
    let mut recovery = None;
    let list = match read {
        Ok(list) => list,
        Err(error) if waiting && error.catching_up() => {
            outcomes.caught_up_with(&error, handoff.freshness(), "fresh-read");
            recovery = Some(Recovery::Pending);
            Default::default()
        }
        Err(error) if lapsed && error.catching_up() => {
            outcomes.handoff("handoff_expired", &handoff, "action_required");
            recovery = Some(Recovery::Missing);
            Default::default()
        }
        Err(error) => {
            return read_failed(req, viewer, error, waiting.then(|| t.route_sell_list_request_failed()));
        }
    };
    if recovery.is_none() {
        recovery = outcomes.read(&handoff, list.items.is_empty() && list.count == 0);
    }
    let mut confirmation = list.latest_confirmation;
    if let Some(pending) = place.pending_confirmation().filter(|_| account) {
        let arrived = matches!((&pending, &confirmation), (Some(id), Some(c)) if c.confirmation_id == *id);
        if !arrived {
            confirmation = None;
            if recovery.is_none() {
                outcomes.record(
                    "handoff_pending",
                    handoff.freshness().outcome(),
                    "pending_empty_state",
                    "sell-checkout-confirmation",
                );
            }
            recovery = recovery.or(Some(Recovery::ConfirmationPending));
        }
    }
    // A list with lines is reviewed by Checkout, payout readiness and all; an empty one has only
    // the payout readiness to show.
    let (review, payout) = if account && !list.items.is_empty() {
        let review = match caller.sell_list_review(place.registration(), surface.path()).await {
            Ok(review) => review,
            Err(error) if waiting && error.catching_up() => {
                outcomes.caught_up_with(&error, handoff.freshness(), "sell-list-composite-review");
                recovery = recovery.or(Some(Recovery::Pending));
                CompositeReview::default()
            }
            Err(error) => return read_failed(req, viewer, error, None),
        };
        (review, None)
    } else if account {
        let payout = caller.sell_payout_readiness().await.inspect_err(|e| tracing::warn!("payout readiness: {e}")).ok();
        (CompositeReview::default(), payout)
    } else {
        let review = match guest.as_deref().filter(|_| !list.items.is_empty()) {
            Some(id) => match caller.guest_sell_list_review(id).await {
                Ok(review) => review,
                Err(error) => {
                    if waiting && error.catching_up() {
                        outcomes.caught_up_with(&error, handoff.freshness(), "guest-sell-list-offer-reviews");
                        recovery = recovery.or(Some(Recovery::Pending));
                    }
                    tracing::warn!("guest sell list review: {error}");
                    CompositeReview::default()
                }
            },
            None => CompositeReview::default(),
        };
        (review, None)
    };
    if account && settled {
        let available = payout.is_some() || review.screen.as_ref().is_some_and(|s| s.payout_readiness.is_some());
        outcomes.payout_readiness(available, Freshness::Valid);
    }
    let mut screen = SellListScreen::of(surface, account, list.items, review, payout);
    screen.registration = account && place.registration();
    screen.merged = merged.filter(|_| screen.registration);
    screen.confirmation = confirmation.filter(|_| account);
    screen.recovery = recovery;
    let status = match &notice {
        None => StatusCode::OK,
        Some(Notice::Refused(_)) => StatusCode::UNPROCESSABLE_ENTITY,
        Some(Notice::Attempt(_)) => StatusCode::CONFLICT,
    };
    match notice {
        Some(Notice::Refused(message)) => screen.notice = Some(message),
        Some(Notice::Attempt(attempt)) => screen.attempt = Some(attempt),
        None => {}
    }
    let reads_again = matches!(screen.recovery, Some(Recovery::Pending | Recovery::ConfirmationPending));
    let head = html! {
        <meta name="description" content={t.route_review_selected_offers_and_product_level()}>
        <meta name="robots" content="noindex">
        if reads_again {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let mut res = req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={viewer} title={t.route_sell_list_chase_sets()} head={head}>
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
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    act(&req, session.as_deref(), &config, &headers, Surface::SellList, raw).await
}

pub(crate) async fn desk_write(
    req: Req,
    Caller(DeskSeller(viewer)): Caller<DeskSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let session = Session::Account(viewer);
    act(&req, Some(&session), &config, &headers, Surface::DeskOffers, raw).await
}

/// Why a write did not happen, or where it went.
enum Done {
    To(String),
    Refused(String),
    Failed(ApiError),
    /// Not known to have applied, or applied in part.
    Attempt(AttemptNotice),
    /// The caller's answer, not the attempt's (401, 403).
    Status(StatusCode),
}

async fn act(
    req: &Req,
    session: Option<&Session>,
    config: &Config,
    headers: &HeaderMap,
    surface: Surface,
    raw: Raw,
) -> HtmlResult {
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let t: SellListMsg = req.t();
    let account = account_sell_list(session);
    let guest = guest_id(headers);
    let caller = config.platform.caller(headers, config.proto, None);
    let failed = t.route_sell_list_request_failed().to_owned();
    let attempt = cart_attempt::attempt_id(&first(&raw, ATTEMPT));
    let done = match first(&raw, "intent").as_str() {
        "remove-sell-list-line" => {
            let line = first(&raw, "lineId");
            match (account, guest.as_deref()) {
                _ if line.is_empty() => Done::Refused(failed),
                (false, None) => Done::Refused(failed),
                (account, guest) => {
                    let write = CartWrite::sell_list_remove(&line, guest.filter(|_| !account).map(str::to_owned));
                    let resend = cart_attempt::resend(&raw, ATTEMPT, &attempt);
                    submit(&caller, &attempt, write, resend, surface, false, failed).await
                }
            }
        }
        "add-selected-offer" if !account => Done::Refused(t.page_sign_in_required().to_owned()),
        "add-selected-offer" => {
            let id = first(&raw, "offerId");
            match caller.sell_list_offer(&id).await {
                Ok(Some(offer)) => {
                    let write = CartWrite::sell_list_add(&SellListLine::offer_match(&offer), None);
                    let resend = cart_attempt::resend(&raw, ATTEMPT, &attempt);
                    submit(&caller, &attempt, write, resend, surface, true, failed).await
                }
                Ok(None) => Done::Refused(failed),
                Err(error) => Done::Failed(error),
            }
        }
        "decline-sell-list-offers" if !account => Done::Refused(t.page_sign_in_required().to_owned()),
        "decline-sell-list-offers" => decline(&caller, &raw, &attempt, surface, failed).await,
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
                    listing_written(caller.listing_command(&listing, &command, None).await, surface, &failed)
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
        Done::Refused(message) => {
            render(req, session, config, headers, surface, &Place::default(), Some(Notice::Refused(message))).await
        }
        Done::Attempt(attempt) => {
            render(req, session, config, headers, surface, &Place::default(), Some(Notice::Attempt(attempt))).await
        }
        Done::Status(StatusCode::UNAUTHORIZED) => match sign_in_back_to(surface.path()) {
            Some(to) => req.redirect(&to),
            None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
        },
        Done::Status(status) => Err(corten::Error::status(status)),
        Done::Failed(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => match sign_in_back_to(surface.path()) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            },
            Some(StatusCode::FORBIDDEN) => Err(crate::app::api_refused(error)),
            Some(status) if status.is_client_error() => {
                let message = error.refusal().unwrap_or(t.route_sell_list_request_failed()).to_owned();
                render(req, session, config, headers, surface, &Place::default(), Some(Notice::Refused(message))).await
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}

/// A line write sent as the form's attempt (`submitCheckoutCartAttempt`): the page read after it,
/// the API's words for a refusal, or the page held with `resend` when it is not known to have
/// applied or applied in part.
async fn submit(
    caller: &platform::api::Caller<'_>,
    attempt: &str,
    write: CartWrite,
    resend: Vec<(String, String)>,
    surface: Surface,
    add: bool,
    failed: String,
) -> Done {
    let outcome = match cart_attempt::submit(caller, attempt, &write).await {
        Ok(outcome) => outcome,
        Err(status) => return Done::Status(status),
    };
    match outcome.state {
        Attempted::Succeeded => Done::To(surface.href(Place::after(outcome.receipt.as_ref(), add))),
        Attempted::FailedSafe => {
            Done::Refused(outcome.message.or_else(|| outcome.not_applied.into_iter().flatten().next()).unwrap_or(failed))
        }
        state => Done::Attempt(AttemptNotice {
            state,
            message: outcome.message,
            not_applied: outcome.not_applied,
            declines: Vec::new(),
            resend,
        }),
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
/// Marketplace as an attempt made from the form's, then the selected-offer lines for them removed
/// in one batch attempt, as marketplace's action does. The lines are the ones the first send found;
/// the form carries them from then on. A decline that fails stops the batch, and the page says
/// which offers were declined.
async fn decline(caller: &platform::api::Caller<'_>, raw: &Raw, attempt: &str, surface: Surface, failed: String) -> Done {
    let mut ids: Vec<String> = Vec::new();
    for id in all(raw, "bulkOfferId") {
        if !ids.contains(&id) && ids.len() < 100 {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Done::Refused(failed);
    }
    let mut resend = cart_attempt::resend(raw, ATTEMPT, attempt);
    let lines = if first(raw, DECLINED_CAPTURED) == "true" {
        all(raw, DECLINED_LINE)
    } else {
        let list = match caller.sell_list(None).await {
            Ok(list) => list,
            Err(error) => return Done::Failed(error),
        };
        let lines: Vec<String> = list
            .items
            .iter()
            .filter(|l| l.is_offer() && l.offer_id.as_ref().is_some_and(|id| ids.contains(id)))
            .map(|l| l.line_id.clone())
            .collect();
        resend.retain(|(key, _)| key != DECLINED_LINE && key != DECLINED_CAPTURED);
        resend.extend(lines.iter().map(|line| (DECLINED_LINE.to_owned(), line.clone())));
        resend.push((DECLINED_CAPTURED.to_owned(), "true".to_owned()));
        lines
    };
    let mut declines = Vec::new();
    for (at, id) in ids.iter().enumerate() {
        let message = match caller.decline_offer_match(id, &cart_attempt::decline_attempt(attempt, id)).await {
            Ok(_) => {
                declines.push((id.clone(), Declined::Yes));
                continue;
            }
            Err(CommandError::Api(error)) => error.refusal().map(str::to_owned),
            Err(CommandError::EvidenceIncomplete { message, .. }) => Some(message),
            Err(other) => {
                tracing::warn!("a decline was refused with a listing's conflict: {other:?}");
                None
            }
        };
        declines.push((id.clone(), Declined::Unconfirmed));
        declines.extend(ids[at + 1..].iter().map(|id| (id.clone(), Declined::NotSent)));
        return Done::Attempt(AttemptNotice { state: Attempted::Partial, message, not_applied: Vec::new(), declines, resend });
    }
    if lines.is_empty() {
        return Done::To(surface.href(Place::default()));
    }
    submit(caller, attempt, CartWrite::sell_list_remove_lines(&lines), resend, surface, false, failed).await
}

/// Continue to seller checkout (`review-sell-list-checkout`). An account's: what the seller chose
/// sent for Checkout's review, which plans each line and keeps the plan with the snapshot, then
/// marketplace's seller checkout with the snapshot, read after the review's write. A guest's: the
/// guest sell list's readiness, then marketplace's registration, back to the sell list.
async fn review(t: SellListMsg, caller: &platform::api::Caller<'_>, raw: &Raw, account: bool, guest: Option<&str>) -> Done {
    let back = format!("{}?registrationReturn=seller-checkout", url::SellList::PATH);
    if !account {
        let Some(id) = guest else {
            return Done::To(sign_in_back_to(&back).map(|u| u.to_string()).unwrap_or_else(|| back.clone()));
        };
        return match caller.guest_sell_list_readiness(id).await {
            Ok((snapshot, _)) if snapshot.status == "ready" && snapshot.unresolved_line_ids.is_empty() => {
                Done::To(crate::register::href(&back))
            }
            Ok(_) => Done::Refused(t.route_sell_list_readiness_must_be_resolved().to_owned()),
            Err(error) => Done::Failed(error),
        };
    }
    let (review, receipt) = match caller.review_sell_list(&selections(raw)).await {
        Ok(answer) => answer,
        Err(error) => return Done::Failed(error),
    };
    let snapshot = review.readiness;
    if snapshot.status != "ready" || !snapshot.unresolved_line_ids.is_empty() {
        return Done::Refused(t.route_sell_list_readiness_must_be_resolved().to_owned());
    }
    Done::To(checkout_path(&snapshot.snapshot_id, &snapshot.source_revision, receipt.as_ref()))
}

/// Seller checkout for a readiness snapshot (marketplace's `sellCheckoutRedirectUrl`): a new session
/// id, with the write's receipt. Checkout keeps the snapshot's review, so the address names only
/// the snapshot.
pub fn checkout_path(snapshot: &str, revision: &str, receipt: Option<&Receipt>) -> String {
    let id = format!("chk_{}", ulid::Ulid::new());
    let place = crate::sell_checkout::Place {
        readiness_snapshot_id: Some(snapshot.to_owned()),
        readiness_source_revision: Some(revision.to_owned()),
        after_write: receipt.map(Receipt::param),
    };
    url::SellCheckout { id: &id, place }.href()
}

/// Add photo (`add-listing-evidence`): `multipart/form-data`, the photo added to the listing on
/// Marketplace with its alt text.
pub(crate) async fn evidence(
    req: Req,
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
            return render(
                &req,
                session,
                &config,
                &headers,
                Surface::SellList,
                &Place::default(),
                Some(Notice::Refused(message)),
            )
            .await;
        }
        Err(other) => return Err(other.into()),
    };
    let surface = Surface::read(&first(&posted.fields, "surface"));
    if !account_sell_list(session) {
        let message = t.page_sign_in_required().to_owned();
        return render(&req, session, &config, &headers, surface, &Place::default(), Some(Notice::Refused(message))).await;
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
            return render(&req, session, &config, &headers, surface, &Place::default(), Some(Notice::Refused(message))).await;
        }
    };
    let photo = Photo { filename: file.filename, content_type: file.content_type, bytes: file.bytes };
    let alt = first(&posted.fields, "listingPhotoAltText");
    let caller = config.platform.caller(&headers, config.proto, None);
    let failed = t.route_sell_list_request_failed().to_owned();
    match listing_written(caller.add_listing_photos(&listing, &[photo], Some(&alt)).await, surface, &failed) {
        Done::To(to) => req.redirect(&to.parse::<Uri>().map_err(corten::Error::new)?),
        Done::Refused(message) => {
            render(&req, session, &config, &headers, surface, &Place::default(), Some(Notice::Refused(message))).await
        }
        Done::Attempt(attempt) => {
            render(&req, session, &config, &headers, surface, &Place::default(), Some(Notice::Attempt(attempt))).await
        }
        Done::Status(status) => Err(corten::Error::status(status)),
        Done::Failed(error) => {
            let message = error.refusal().map_or(failed, str::to_owned);
            render(&req, session, &config, &headers, surface, &Place::default(), Some(Notice::Refused(message))).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(answer: serde_json::Value) -> SellListLineReview {
        serde_json::from_value(answer).unwrap()
    }

    #[test]
    fn a_lines_readiness_is_checkouts_answer_in_the_pages_words() {
        let ready = readiness(
            Some(&line(
                serde_json::json!({ "ready": true, "labelCode": "ready", "detailCode": "smart-match-ready", "parameters": { "count": 2 } }),
            )),
            false,
        );
        assert_eq!((ready.ready, ready.label, ready.detail), (true, ReadinessLabel::Ready, ReadinessDetail::SmartMatch(2)));
        let unmet = readiness(
            Some(&line(
                serde_json::json!({ "labelCode": "evidence-needs-action", "detailCode": "evidence-incomplete", "unmetEvidenceCodes": ["missing-required-view:back"] }),
            )),
            true,
        );
        assert_eq!(
            (unmet.ready, unmet.label, unmet.detail),
            (false, ReadinessLabel::EvidenceNeedsAction, ReadinessDetail::Unmet(vec!["missing-required-view:back".into()]))
        );
        // The API's own words win over its code.
        let said = readiness(
            Some(&line(
                serde_json::json!({ "labelCode": "needs-refresh", "detailCode": "offer-terms-need-refresh", "message": "Offer expired." }),
            )),
            true,
        );
        assert_eq!((said.label, said.detail), (ReadinessLabel::NeedsRefresh, ReadinessDetail::Message("Offer expired.".into())));
        // A code the page does not know keeps its label and the line's usual words.
        let new = readiness(
            Some(&line(serde_json::json!({ "ready": true, "labelCode": "ready", "detailCode": "something-new" }))),
            false,
        );
        assert_eq!((new.ready, new.detail), (true, ReadinessDetail::FallbackForm));
        // Without a review, a line is not ready, in its kind's words.
        assert_eq!(readiness(None, true).detail, ReadinessDetail::OfferTermsNeedRefresh);
        assert_eq!(readiness(None, false).detail, ReadinessDetail::ChooseSaleAction);
    }

    /// The offer line `a` (2 at 10.00) and the product line `b` (3), with `offers` Smart Match
    /// offers of 2 each (the first 7.00 net, the rest 7.50; 0.50 fee) and the offer's terms when
    /// `offer_terms`, reviewed by Checkout as `screen`.
    fn quoted_screen(offer_terms: bool, offers: usize, screen: serde_json::Value) -> SellListScreen {
        let terms = |net: &str, fee: &str| serde_json::json!({ "basis_amount": "10.00", "marketplace_sales_fee_unit_amount": fee, "seller_net_unit_amount": net });
        let smart: Vec<_> = (0..offers)
            .map(|i| {
                serde_json::json!({
                    "offer": { "offer_id": format!("off_{i}"), "quantity_requested": 2, "price_amount": "8.00" },
                    "terms": terms(if i == 0 { "7.00" } else { "7.50" }, "0.50"),
                })
            })
            .collect();
        let review: CompositeReview = serde_json::from_value(serde_json::json!({
            "offerReviews": [{ "lineId": "a", "status": "ready", "terms": if offer_terms { terms("9.00", "1.00") } else { serde_json::Value::Null } }],
            "productOfferReviews": [{ "lineId": "b", "status": "ready", "offers": smart }],
            "screen": screen,
        }))
        .unwrap();
        let rows = vec![
            SellListRow {
                line_id: "a".into(),
                line_type: "selected-offer".into(),
                offer_id: Some("off_a".into()),
                offer_price_amount: Some("10.00".into()),
                quantity: 2,
                ..SellListRow::default()
            },
            SellListRow { line_id: "b".into(), line_type: "product".into(), quantity: 3, ..SellListRow::default() },
        ];
        SellListScreen::of(Surface::SellList, true, rows, review, None)
    }

    #[test]
    fn the_totals_and_the_way_forward_are_checkouts_and_unknown_without_its_review() {
        let reviewed = quoted_screen(
            true,
            2,
            serde_json::json!({
                "lines": {
                    "a": { "ready": true, "canSubmit": true, "labelCode": "ready", "detailCode": "selected-offer-ready", "setupHref": "/account/listings/new?catalogItemId=c" },
                    "b": { "ready": false, "canSubmit": false, "labelCode": "needs-action", "detailCode": "choose-sale-action" },
                },
                "totalQuantity": 5, "readyLineCount": 1, "blockedLineCount": 1, "canContinue": false,
                "payoutIsReady": true, "payoutReadiness": { "status": "ready", "missing_requirements": [] },
                "payoutSetupHref": "/account/payouts/setup?returnTo=%2Faccount%2Fsell-list",
                "recoveryHref": "/account/inventory?catalogItemId=c", "recoveryCode": "resolve-items",
                "hasMultipleOffers": true, "selectedOfferGross": "20.00", "futureListingGross": "0.00",
                "estimatedSalesFees": "4.00", "expectedSellerPayout": "47.00",
            }),
        );
        let totals = reviewed.totals();
        assert_eq!(
            (totals.quantity, totals.offer_gross, totals.future_listing_gross, totals.fees, totals.payout, totals.all_offers),
            (5, Some(2_000), Some(0), Some(400), Some(4_700), true)
        );
        assert_eq!((reviewed.blocked(), reviewed.ready(), reviewed.can_continue(), reviewed.payout_ready()), (1, 1, false, true));
        assert_eq!(reviewed.recovery(), ("/account/inventory?catalogItemId=c".to_owned(), RecoveryLabel::Resolve));
        assert_eq!(reviewed.lines[0].setup_href(), Some("/account/listings/new?catalogItemId=c"));
        assert_eq!(reviewed.lines[1].inventory_href(), None);
        assert_eq!(reviewed.payout.as_ref().map(|p| p.status.as_str()), Some("ready"), "the review's payout readiness");

        let unreviewed = quoted_screen(true, 2, serde_json::Value::Null);
        let totals = unreviewed.totals();
        assert_eq!((totals.quantity, totals.offer_gross, totals.payout), (5, None, None));
        assert_eq!((unreviewed.blocked(), unreviewed.can_continue()), (2, false));
        assert_eq!(unreviewed.recovery().1, RecoveryLabel::Resolve);
        assert_eq!(unreviewed.lines[0].setup_href(), None);
    }

    #[test]
    fn a_lines_best_net_is_its_offers_own_quantity_or_none_without_terms() {
        let screen = quoted_screen(false, 2, serde_json::Value::Null);
        let (pick, net) = screen.lines[1].best().unwrap();
        // The 7.50 offer, for the 2 it asks for.
        assert_eq!((pick.offer_id.as_str(), net), ("off_1", Some(1_500)));
        assert_eq!(screen.lines[0].best().map(|(_, net)| net), Some(None));
    }

    #[test]
    fn a_support_reference_drops_the_prefix_and_keeps_safe_characters() {
        assert_eq!(support_reference("slc_01JABC"), "CS-SL-01JABC");
        assert_eq!(support_reference(" SLC-ab/c "), "CS-SL-AB_C");
        assert_eq!(support_reference("slc_"), "CS-SL-UNKNOWN");
        assert_eq!(support_reference("other"), "CS-SL-OTHER");
    }

    #[test]
    fn continue_sends_each_line_the_form_names_with_its_offers_and_a_listing_only_when_one_was_chosen() {
        let mut raw = Raw::new();
        for (k, v) in [
            ("bulkOfferId", " off_a "),
            ("offerFeeQuoteFingerprint:sll_offer", " fq_offer "),
            ("productOfferId:sll_product", "off_a"),
            ("productOfferId:sll_product", " "),
            ("productOfferId:sll_product", "off_b"),
            ("productOfferFeeQuoteFingerprint:sll_product:off_a", "fq_a"),
            ("fallbackMode:sll_product", "create-listing"),
            ("inventoryItemId:sll_product", "inv_1"),
            ("priceAmount:sll_product", "21.00"),
            ("priceCurrencyCode:sll_product", "USD"),
            ("fallbackMode:sll_kept", "keep-in-list"),
            ("inventoryItemId:sll_kept", "inv_2"),
            ("intent", "review-sell-list-checkout"),
        ] {
            crate::items::put(&mut raw, k.to_owned(), v.to_owned());
        }
        let sent = selections(&raw);
        assert_eq!(sent.bulk_offer_ids, ["off_a"]);
        let ids: Vec<_> = sent.lines.iter().map(|l| l.line_id.as_str()).collect();
        assert_eq!(ids, ["sll_kept", "sll_product", "sll_offer"], "one entry per line the form names");
        let line = |id: &str| sent.lines.iter().find(|l| l.line_id == id).unwrap();
        assert_eq!(line("sll_offer").selected_offer_fee_quote_fingerprint, "fq_offer");
        assert_eq!(
            line("sll_product").product_offers,
            [
                OfferSelection { offer_id: "off_a".into(), fee_quote_fingerprint: "fq_a".into() },
                OfferSelection { offer_id: "off_b".into(), fee_quote_fingerprint: String::new() },
            ],
            "an empty offer is left out; one without terms is sent for Checkout to skip"
        );
        assert_eq!(
            line("sll_product").fallback_listing,
            Some(ListingSelection {
                inventory_item_id: "inv_1".into(),
                price_amount: "21.00".into(),
                price_currency_code: "USD".into(),
                quantity_cap: String::new(),
            })
        );
        assert_eq!(line("sll_kept").fallback_listing, None, "a listing only when the seller chose to create one");
    }
}
