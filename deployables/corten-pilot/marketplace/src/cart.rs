//! Buy > Cart (marketplace's `/account/cart`): the account's cart lines, what each needs before
//! checkout, the estimated total and the lower-price offer, as the Checkout API's cart read
//! returns them. Checking out is marketplace's: the page's Check out and Use lower price post the
//! readiness snapshot to marketplace's `/checkout/buy/readiness`, as its cart page does.
//!
//! The API computes the readiness, the totals and the savings
//! ([chase-sets/chase-sets#10504](https://github.com/chase-sets/chase-sets/issues/10504)). Each
//! line's badge is the API's line outcome, not a copy of its rules
//! ([chase-sets/chase-sets#10576](https://github.com/chase-sets/chase-sets/issues/10576)); the
//! line's price is still worked out here from its listings, as marketplace's page does.
use std::collections::HashMap;

use corten::{axum::http::HeaderMap, prelude::*};
use platform::money;
use serde::Serialize;

use crate::{
    api::{Cart, CartLine, Checkout as _, Readiness, SellerOption},
    app::{Shared, read_failed, url, viewer},
    auth::Session,
    text::CartMsg,
    views,
};

pub fn routes(area: Area<Session, url::CartArea>, shared: &Shared) -> Area<Session, url::CartArea> {
    area.route::<url::Cart>(get(page).with_state(shared.clone()))
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct CartScreen {
    /// The cart's lines, those for the same product and fulfillment as one, newest first.
    pub lines: Vec<Line>,
    pub readiness: Option<Readiness>,
}

impl CartScreen {
    pub fn of(cart: Cart) -> Self {
        let readiness = cart.readiness;
        let reasons: HashMap<&str, &str> = readiness
            .iter()
            .flat_map(|r| r.loaded.line_outcomes.iter().map(|o| (o.line_id.as_str(), o.reason.as_str())))
            .collect();
        let lines = group(cart.items)
            .into_iter()
            .map(|(line, line_ids)| {
                let listing_id = readiness.as_ref().and_then(|r| r.line_listing_ids.get(&line.line_id).cloned().flatten());
                let price = price(&line, listing_id.as_deref());
                let reason = reasons.get(line.line_id.as_str()).map(|r| Reason::of(r));
                Line { line, line_ids, listing_id, reason, price }
            })
            .collect();
        CartScreen { lines, readiness }
    }

    /// Every line's quantity, the cart's item count.
    pub fn item_count(&self) -> u64 {
        self.lines.iter().map(|l| u64::from(l.line.quantity)).sum()
    }

    /// The cart can check out as it is: the API's declined snapshot (the cart without the
    /// optimization) is ready.
    pub fn ready(&self) -> bool {
        !self.lines.is_empty() && self.readiness.as_ref().is_some_and(|r| r.declined.status == "ready")
    }

    /// The lower-price offer can be shown: a ready cart whose optimization is available.
    pub fn offer(&self) -> bool {
        self.ready() && self.readiness.as_ref().is_some_and(|r| r.declined.optimization.available)
    }

    /// The listing the offer switches to, for its seller's name and reputation.
    pub fn offered(&self) -> Option<&SellerOption> {
        let optimization = &self.readiness.as_ref()?.declined.optimization;
        let line = self.lines.iter().find(|l| Some(&l.line.line_id) == optimization.proposed_line_id.as_ref())?;
        option(&line.line, optimization.proposed_listing_id.as_deref())
    }
}

/// A cart line as the page shows it: the lines for one product and fulfillment, merged.
#[derive(Clone, Debug, Serialize)]
pub struct Line {
    #[serde(flatten)]
    pub line: CartLine,
    /// Every line merged into this one; the first is `line.line_id`.
    pub line_ids: Vec<String>,
    /// The listing the API chose for the line, which prices it.
    pub listing_id: Option<String>,
    /// What the line needs before checkout, from the API's line outcome.
    pub reason: Option<Reason>,
    pub price: Price,
}

impl Line {
    /// The seller the line would check out with: a locked listing's, or the API's chosen
    /// listing's. A locked listing gone from the options keeps the seller it was locked with.
    pub fn seller(&self) -> Option<Seller<'_>> {
        let line = &self.line;
        let listing = if line.fulfillment_mode == "locked-listing" {
            line.locked_listing_id.as_deref()
        } else {
            self.listing_id.as_deref()
        };
        if let Some(option) = option(line, listing) {
            return option.seller_display_name.as_deref().map(|name| Seller::of(name, option));
        }
        if line.fulfillment_mode == "locked-listing"
            && line.selected_listing_id.is_some()
            && line.selected_listing_id == line.locked_listing_id
        {
            return line.selected_listing_seller_display_name.as_deref().map(|name| Seller { name, rating: None });
        }
        None
    }

    /// The name of a listing the line names: its seller's, or the selected listing's.
    pub fn listing_label<'a>(&'a self, listing_id: &str, fallback: &'a str) -> &'a str {
        let line = &self.line;
        option(line, Some(listing_id))
            .and_then(|o| o.seller_display_name.as_deref())
            .or_else(|| {
                (line.selected_listing_id.as_deref() == Some(listing_id))
                    .then_some(line.selected_listing_seller_display_name.as_deref())
                    .flatten()
            })
            .unwrap_or(fallback)
    }
}

/// A seller's name and, when it has reviews, its rating and count.
pub struct Seller<'a> {
    pub name: &'a str,
    pub rating: Option<(f64, u64)>,
}

impl<'a> Seller<'a> {
    pub fn of(name: &'a str, option: &'a SellerOption) -> Self {
        let rating = option.seller_average_rating.as_deref().and_then(|r| r.trim().parse::<f64>().ok()).filter(|r| r.is_finite());
        let count = option.seller_review_count.unwrap_or(0);
        Seller { name, rating: rating.filter(|_| count > 0).map(|r| (r, count)) }
    }
}

/// What a line needs before checkout: the API's `lineOutcomes[].reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    Ready,
    UnassignedFulfillment,
    Unavailable,
    WaitingForSupply,
    Changed,
    ShippingMeasureMissing,
    /// The line's currency is not the cart's. marketplace draws it as Ready, since its page does
    /// not look at currency (chase-sets/chase-sets#10576); the pilot says it needs review.
    CurrencyMismatch,
    /// A reason this build does not know.
    Other,
}

impl Reason {
    fn of(reason: &str) -> Self {
        match reason {
            "ready" => Reason::Ready,
            "unassigned-fulfillment" => Reason::UnassignedFulfillment,
            "unavailable" => Reason::Unavailable,
            "waiting-for-supply" => Reason::WaitingForSupply,
            "changed" => Reason::Changed,
            "shipping-measure-missing" => Reason::ShippingMeasureMissing,
            "currency-mismatch" => Reason::CurrencyMismatch,
            _ => Reason::Other,
        }
    }

    /// The line can be fulfilled as it is (marketplace's `hasFulfillmentPath`): no "Find
    /// alternatives".
    pub fn fulfillable(self) -> bool {
        matches!(self, Reason::Ready | Reason::CurrencyMismatch)
    }
}

/// A line's price (marketplace's `linePriceState`): a locked listing's is exact, Smart Match's is
/// "from" the chosen listing, and a line with no priced listing is priced at checkout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "text", rename_all = "kebab-case")]
pub enum Price {
    Exact(String),
    From(String),
    Deferred,
}

/// The listing `listing_id` among the line's options.
fn option<'a>(line: &'a CartLine, listing_id: Option<&str>) -> Option<&'a SellerOption> {
    let id = listing_id?;
    line.seller_options.iter().find(|o| o.listing_id == id)
}

/// A listing's unit price in cents and its currency, when it is a usable price (marketplace's
/// `listingMoney`): non-negative money, a three-letter currency and a stream version.
fn unit(amount: Option<&str>, currency: Option<&str>, version: Option<u64>) -> Option<(i64, String)> {
    let cents = money::cents(amount?).filter(|c| *c >= 0)?;
    let currency = currency.filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))?;
    version.filter(|v| *v > 0)?;
    Some((cents, currency.to_owned()))
}

fn option_unit(option: &SellerOption) -> Option<(i64, String)> {
    unit(Some(&option.price_amount), option.price_currency_code.as_deref(), option.listing_stream_version)
}

fn price(line: &CartLine, listing_id: Option<&str>) -> Price {
    let unit = match line.locked_listing_id.as_deref() {
        Some(locked) => option(line, Some(locked)).and_then(option_unit).or_else(|| {
            (line.selected_listing_id.as_deref() == Some(locked))
                .then(|| {
                    unit(
                        line.selected_listing_price_amount.as_deref(),
                        line.selected_listing_price_currency_code.as_deref(),
                        line.selected_listing_stream_version,
                    )
                })
                .flatten()
        }),
        None => option(line, listing_id).and_then(option_unit),
    };
    match unit {
        None => Price::Deferred,
        Some((cents, currency)) => {
            let text = money::from_cents(cents.saturating_mul(i64::from(line.quantity)), &currency);
            if line.fulfillment_mode == "locked-listing" && line.locked_listing_id.is_some() {
                Price::Exact(text)
            } else {
                Price::From(text)
            }
        }
    }
}

/// The lines for one product and fulfillment as one (marketplace's `groupCartLines`): their
/// quantities added, their listings merged, the newest first. Each comes with the ids it merged.
fn group(items: Vec<CartLine>) -> Vec<(CartLine, Vec<String>)> {
    let key = |l: &CartLine| {
        let or = |v: &Option<String>| v.clone().unwrap_or_default();
        format!(
            "{}:{}:{}:{}:{}",
            l.catalog_catalog_item_id,
            l.product_id,
            l.fulfillment_mode,
            or(&l.locked_listing_id),
            or(&l.seller_preference_id)
        )
    };
    let mut groups: Vec<(String, CartLine, Vec<String>)> = Vec::new();
    for line in items {
        let k = key(&line);
        let Some((_, existing, ids)) = groups.iter_mut().find(|(g, _, _)| *g == k) else {
            let id = line.line_id.clone();
            groups.push((k, line, vec![id]));
            continue;
        };
        ids.push(line.line_id.clone());
        existing.quantity += line.quantity;
        for option in &line.seller_options {
            if !existing.seller_options.iter().any(|o| o.listing_id == option.listing_id) {
                existing.seller_options.push(option.clone());
            }
        }
        existing.seller_options.sort_by(|a, b| {
            let cents = |o: &SellerOption| money::cents(&o.price_amount);
            a.price_currency_code
                .cmp(&b.price_currency_code)
                .then_with(|| match (cents(a), cents(b)) {
                    (Some(x), Some(y)) => x.cmp(&y),
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, None) => std::cmp::Ordering::Equal,
                })
                .then_with(|| a.listing_id.cmp(&b.listing_id))
        });
        if existing.selected_listing_id.is_none() {
            existing.selected_listing_id = line.selected_listing_id.clone();
            existing.selected_listing_seller_display_name = line.selected_listing_seller_display_name.clone();
            existing.selected_listing_price_amount = line.selected_listing_price_amount.clone();
            existing.selected_listing_price_currency_code = line.selected_listing_price_currency_code.clone();
            existing.selected_listing_stream_version = line.selected_listing_stream_version;
        }
        if platform::when::instant(&line.updated_at) > platform::when::instant(&existing.updated_at) {
            existing.updated_at = line.updated_at.clone();
        }
    }
    let mut lines: Vec<_> = groups.into_iter().map(|(_, line, ids)| (line, ids)).collect();
    lines.sort_by(|(a, _), (b, _)| {
        platform::when::instant(&b.updated_at)
            .cmp(&platform::when::instant(&a.updated_at))
            .then_with(|| a.line_id.cmp(&b.line_id))
    });
    lines
}

async fn page(req: Req, State(config): State<Shared>, headers: HeaderMap) -> corten::Result {
    let viewer = viewer(&req)?;
    let caller = config.platform.caller(&headers, config.proto, None);
    let cart = match caller.cart().await {
        Ok(cart) => cart,
        Err(error) => return read_failed(&req, error, None),
    };
    let screen = CartScreen::of(cart);
    let t: CartMsg = req.t();
    let meta = Meta::new(t.route_cart_marketplace()).description(t.route_review_cart_lines_adjust_quantity_and());
    let view = views::cart_page(t, viewer, &screen);
    req.screen(meta, &screen, view)
}
