//! Buy > Cart (marketplace's `/account/cart`): the cart's lines, what each needs before checkout,
//! the estimated total and the lower-price offer, as the Checkout API's cart read returns them.
//! The cart is the account's, or for a visitor or a guest checkout the guest cart the browser
//! carries (`chase_sets_anonymous_cart`), read and written through the API's guest routes, as
//! marketplace's loader and action do (`canUseAccountCart`). Check out and Use lower price start
//! the checkout session here for an account, as marketplace's `/checkout/buy/readiness` action
//! does, and send the buyer to the checkout with the write's receipt (`checkout`); a guest's is
//! checkout start's Continue (`checkout_start::cart_as_guest`), which starts a guest checkout. A
//! cart that is not ready goes to checkout start (`checkout_start`). marketplace's action refuses
//! a post from another origin (React Router's CSRF check), and starting the session is the
//! Checkout API's call, so the pilot makes it.
//!
//! The API computes the readiness, the totals and the savings
//! ([chase-sets/chase-sets#10504](https://github.com/chase-sets/chase-sets/issues/10504)), and how
//! each line is drawn (`linePresentations`): its outcome, whether it has a way to be fulfilled,
//! the listing it would check out with and its price, so the page keeps none of the API's rules
//! ([chase-sets/chase-sets#10576](https://github.com/chase-sets/chase-sets/issues/10576)).
use crate::recovery::{attempt_text, submit_key};
use std::{collections::HashMap, time::Duration};

use corten::{
    http::{HeaderMap, StatusCode, Uri, header},
    prelude::*,
    security::cookie,
};
use platform::{money, receipt::Receipt};
use serde::Serialize;

use crate::chrome::CartCount;
use crate::{
    api::{
        ApiError, Cart, CartCommand, CartLine, CartWrite, Checkout as _, Decisions, LinePresentation, OptimizationDecision,
        Readiness, SellerOption, Snapshot,
    },
    app::{Config, Shared, read_failed, sign_in_at, url},
    auth::Buyer,
    cart_attempt::{self, State as Attempted},
    text::{CartMsg, Pilot},
    views::{self, Layout},
};

/// The quantity a line takes: a whole number from 1, up to the cart read model's `integer` column.
pub const QUANTITY: Bounds<u32> = Bounds::new(1, i32::MAX as u32);

/// The guest cart a browser carries from before it signed in (marketplace's
/// `CHECKOUT_ANONYMOUS_CART_COOKIE_NAME`).
pub const ANONYMOUS_CART_COOKIE: &str = "chase_sets_anonymous_cart";

/// The guest cart the request carries, when it is one the API takes (`readAnonymousCartId`).
pub fn anonymous_cart(headers: &HeaderMap) -> Option<&str> {
    cookie::get(headers, ANONYMOUS_CART_COOKIE).filter(|id| id.starts_with("anon_"))
}

/// What the cart's address carries after a write: its receipt, which the cart read waits for
/// (marketplace's `afterWrite`).
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
pub struct AfterWrite {
    pub after_write: Option<String>,
}

/// A line write's form (marketplace's cart line forms): the attempt (`SubmitKey`), every line
/// merged into the one shown, and for a quantity the quantity the buyer set (stepped or typed, as
/// marketplace's `QuantityStepper` takes it), for a lock the preferred listing.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct LineInput {
    pub attempt: Option<SubmitKey>,
    pub line_id: Vec<String>,
    pub quantity: Entry<u32>,
    pub preference: String,
}

/// Which line write a form is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Write {
    Quantity,
    Remove,
    Lock,
}

impl LineInput {
    /// The write's commands, one attempt (marketplace's `handleAction`), or the reason it is
    /// refused before it is sent. A quantity goes on the first line and the lines merged into it
    /// are removed, all or nothing; one that is not a whole number [`QUANTITY`] holds is refused.
    pub fn commands(&self, t: CartMsg, p: Pilot, write: Write) -> Result<Vec<CartCommand>, &'static str> {
        let ids: Vec<&str> = self.line_id.iter().map(|id| id.trim()).filter(|id| !id.is_empty()).collect();
        match write {
            Write::Quantity => {
                let [first, rest @ ..] = ids.as_slice() else { return Err(t.route_request_failed()) };
                let Some(quantity) = QUANTITY.read(&self.quantity) else { return Err(p.cart_quantity()) };
                let mut commands = vec![CartCommand::Quantity { line_id: (*first).to_owned(), quantity }];
                commands.extend(rest.iter().map(|id| CartCommand::Remove { line_id: (*id).to_owned() }));
                Ok(commands)
            }
            Write::Remove if ids.is_empty() => Err(t.route_request_failed()),
            Write::Remove => Ok(ids.iter().map(|id| CartCommand::Remove { line_id: (*id).to_owned() }).collect()),
            Write::Lock => {
                let preference = self.preference.trim();
                if preference.is_empty() || ids.is_empty() {
                    return Err(t.route_preferred_listing_missing());
                }
                Ok(ids
                    .iter()
                    .map(|id| CartCommand::Fulfillment {
                        line_id: (*id).to_owned(),
                        fulfillment_mode: "locked-listing",
                        locked_listing_id: preference.to_owned(),
                        seller_preference_id: preference.to_owned(),
                        availability_state: "available",
                    })
                    .collect())
            }
        }
    }
}

/// What the page says above the lines: why checkout did not start, or a line write that did not
/// fully apply.
#[derive(Debug)]
pub enum Notice {
    Checkout(String),
    Attempt(AttemptNotice),
}

/// A line write that did not fully apply (marketplace's `AccountCartAttemptActionData`): its
/// state, the API's message, the messages of the lines not applied, and, when it is not known
/// whether it applied, the write as it was posted, to send again with the same attempt.
#[derive(Debug, Serialize)]
pub struct AttemptNotice {
    pub state: Attempted,
    pub message: Option<String>,
    pub not_applied: Vec<Option<String>>,
    #[serde(skip)]
    pub resend: Option<(Write, LineInput)>,
}

impl AttemptNotice {
    /// The cart's other writes wait until the buyer sends this one again or refreshes.
    pub fn pauses(&self) -> bool {
        self.state == Attempted::Ambiguous
    }
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct CartScreen {
    /// The cart's lines, those for the same product and fulfillment as one, newest first.
    pub lines: Vec<Line>,
    pub readiness: Option<Readiness>,
    /// The cart is not readable yet after a write (marketplace's `pending-fresh-write`): the page
    /// says so and reads it again shortly.
    pub pending: bool,
}

impl CartScreen {
    pub fn of(cart: Cart) -> Self {
        // Each line is drawn from the cart as loaded; the readiness (the totals, the offer, checkout)
        // only when the API presented every line, as loaded and without the offer (marketplace's
        // `hasCompleteLinePresentations`).
        let presentations: HashMap<String, LinePresentation> = cart
            .readiness
            .iter()
            .flat_map(|r| r.loaded.line_presentations.iter().map(|p| (p.line_id.clone(), p.clone())))
            .collect();
        let items = cart.items;
        let complete = |s: &Snapshot| items.iter().all(|l| s.line_presentations.iter().any(|p| p.line_id == l.line_id));
        let readiness = cart.readiness.filter(|r| complete(&r.loaded) && complete(&r.declined));
        let lines = group(items, &presentations)
            .into_iter()
            .map(|(line, line_ids, presentation)| {
                let chosen = readiness.as_ref().and_then(|r| r.line_listing_ids.get(&line.line_id).cloned().flatten());
                let listing_id = presentation.as_ref().and_then(|p| p.listing_id.clone()).or(chosen);
                let reason = presentation.as_ref().map_or(Reason::Other, |p| Reason::of(&p.reason));
                let fulfillment_available = presentation.as_ref().map(|p| p.fulfillment_available);
                let price = Price::of(presentation.as_ref());
                Line { line, line_ids, listing_id, reason, fulfillment_available, price }
            })
            .collect();
        CartScreen { lines, readiness, pending: false }
    }

    /// The cart while its read catches up to a write.
    pub fn pending() -> Self {
        CartScreen { lines: Vec::new(), readiness: None, pending: true }
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

/// What Check out and Use lower price post: the lower-price offer's decision as the snapshot the
/// page drew was read with (`offer` `declined` or `accepted`, for `line` and `listing`), or
/// none. Checkout reads the cart's readiness again with it, so the page's snapshot is not sent.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct CheckoutInput {
    pub offer: String,
    pub line: String,
    pub listing: String,
}

impl CheckoutInput {
    /// The form for `snapshot`.
    pub fn of(snapshot: &Snapshot) -> Self {
        let optimization = &snapshot.optimization;
        let decided = matches!(optimization.decision.as_str(), "declined" | "accepted");
        match (decided, &optimization.proposed_line_id, &optimization.proposed_listing_id) {
            (true, Some(line), Some(listing)) => {
                CheckoutInput { offer: optimization.decision.clone(), line: line.clone(), listing: listing.clone() }
            }
            _ => CheckoutInput::default(),
        }
    }

    /// The decisions checkout is started with (`readinessDecisions`).
    pub fn decisions(&self) -> Decisions {
        let decision = match self.offer.as_str() {
            "declined" => "declined",
            "accepted" => "accepted",
            _ => return Decisions::default(),
        };
        let (line, listing) = (self.line.trim(), self.listing.trim());
        if line.is_empty() || listing.is_empty() {
            return Decisions::default();
        }
        Decisions {
            optimization: Some(OptimizationDecision { decision, line_id: line.to_owned(), listing_id: listing.to_owned() }),
        }
    }
}

/// A cart line as the page shows it: the lines for one product and fulfillment, merged.
#[derive(Clone, Debug, Serialize)]
pub struct Line {
    #[serde(flatten)]
    pub line: CartLine,
    /// Every line merged into this one; the first is `line.line_id`.
    pub line_ids: Vec<String>,
    /// The listing the line would check out with, the API's.
    pub listing_id: Option<String>,
    /// What the line needs before checkout, the API's; a line it did not present needs review.
    pub reason: Reason,
    /// Whether the line has a way to be fulfilled, the API's; none for a line it did not present.
    pub fulfillment_available: Option<bool>,
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

/// What a line needs before checkout: its presentation's `reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    Ready,
    UnassignedFulfillment,
    Unavailable,
    WaitingForSupply,
    Changed,
    ShippingMeasureMissing,
    /// The line's currency is not the cart's: it needs review.
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
}

/// A line's price for its quantity, the API's (`linePresentations[].price`): a locked listing's
/// is exact, Smart Match's is "from" the listing it chose, and a line with no priced listing is
/// priced at checkout. The amount is the API's decimal text; the page writes it in the request's
/// locale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Price {
    Exact { amount: String, currency: String },
    From { amount: String, currency: String },
    Deferred,
}

impl Price {
    fn of(presentation: Option<&LinePresentation>) -> Self {
        match presentation.and_then(|p| p.price.as_ref()) {
            Some(p) if p.state == "exact" => Price::Exact { amount: p.amount.clone(), currency: p.currency.clone() },
            Some(p) if p.state == "indicative" => Price::From { amount: p.amount.clone(), currency: p.currency.clone() },
            _ => Price::Deferred,
        }
    }
}

/// The listing `listing_id` among the line's options.
fn option<'a>(line: &'a CartLine, listing_id: Option<&str>) -> Option<&'a SellerOption> {
    let id = listing_id?;
    line.seller_options.iter().find(|o| o.listing_id == id)
}

/// Cents as the API's decimal text.
fn amount(cents: i64) -> String {
    corten::i18n::Decimal::new(i128::from(cents), 2).to_string()
}

/// What a line looks like, so only lines drawn alike are merged (marketplace's
/// `cartLinePresentationKey`): its presentation, its price per item when the quantity divides it.
fn presentation_key(line: &CartLine, presentation: Option<&LinePresentation>) -> String {
    let Some(p) = presentation else { return "no-read".to_owned() };
    let quantity = i64::from(line.quantity.max(1));
    let price = p.price.as_ref().map(|price| match money::cents(&price.amount) {
        Some(cents) if cents % quantity == 0 => format!("{}:{}:each {}", price.state, price.currency, cents / quantity),
        _ => format!("{}:{}:{}", price.state, price.currency, price.amount),
    });
    format!("{}:{}:{}:{}", p.reason, p.fulfillment_available, p.listing_id.as_deref().unwrap_or(""), price.unwrap_or_default())
}

/// Two merged lines' presentation (marketplace's `mergeLinePresentations`): the first's, its price
/// the two added when both are priced alike.
fn merge(left: Option<LinePresentation>, right: Option<&LinePresentation>) -> Option<LinePresentation> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            if let (Some(l), Some(r)) = (left.price.as_mut(), right.price.as_ref())
                && l.state == r.state
                && l.currency == r.currency
                && let (Some(a), Some(b)) = (money::cents(&l.amount), money::cents(&r.amount))
            {
                l.amount = amount(a.saturating_add(b));
            }
            Some(left)
        }
        (left, right) => left.or_else(|| right.cloned()),
    }
}

/// The lines for one product and fulfillment, drawn alike, as one (marketplace's `groupCartLines`):
/// their quantities added, their listings merged, the newest first. Each comes with the ids it
/// merged and its presentation.
fn group(
    items: Vec<CartLine>,
    presentations: &HashMap<String, LinePresentation>,
) -> Vec<(CartLine, Vec<String>, Option<LinePresentation>)> {
    let key = |l: &CartLine| {
        let or = |v: &Option<String>| v.clone().unwrap_or_default();
        format!(
            "{}:{}:{}:{}:{}:{}",
            l.catalog_catalog_item_id,
            l.product_id,
            l.fulfillment_mode,
            or(&l.locked_listing_id),
            or(&l.seller_preference_id),
            presentation_key(l, presentations.get(&l.line_id))
        )
    };
    let mut groups: Vec<(String, CartLine, Vec<String>, Option<LinePresentation>)> = Vec::new();
    for line in items {
        let k = key(&line);
        let presentation = presentations.get(&line.line_id);
        let Some((_, existing, ids, presented)) = groups.iter_mut().find(|(g, _, _, _)| *g == k) else {
            let id = line.line_id.clone();
            groups.push((k, line, vec![id], presentation.cloned()));
            continue;
        };
        *presented = merge(presented.take(), presentation);
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
        if corten::i18n::parse_timestamp(&line.updated_at) > corten::i18n::parse_timestamp(&existing.updated_at) {
            existing.updated_at = line.updated_at.clone();
        }
    }
    let mut lines: Vec<_> = groups.into_iter().map(|(_, line, ids, presented)| (line, ids, presented)).collect();
    lines.sort_by(|(a, _, _), (b, _, _)| {
        corten::i18n::parse_timestamp(&b.updated_at)
            .cmp(&corten::i18n::parse_timestamp(&a.updated_at))
            .then_with(|| a.line_id.cmp(&b.line_id))
    });
    lines
}

pub(crate) async fn page(
    req: Req,
    Caller(buyer): Caller<Buyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::cart::Cart>,
) -> HtmlResult {
    let after = route.after;
    let receipt = Receipt::from_param(after.after_write.as_deref());
    render(&req, &buyer, &config, &headers, receipt.as_ref(), None).await
}

/// The cart page, read after `receipt`'s write when there is one, with `notice` above the lines:
/// a checkout or a write that applied nothing is 422, a write that applied part or may not have
/// applied is 409. The nav's count is the one this read found, which the page gives the layout
/// read (`chrome::CartCount`, which Corten starts no read of its own for on this page: `gives` on its
/// route).
async fn render(
    req: &Req,
    buyer: &Buyer,
    config: &Config,
    headers: &HeaderMap,
    receipt: Option<&Receipt>,
    notice: Option<Notice>,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let read = match buyer {
        Buyer::Account(_) => caller.cart().await,
        Buyer::Guest(_) => caller.guest_cart(anonymous_cart(headers)).await,
    };
    let viewer = buyer.viewer();
    let screen = match read {
        Ok(cart) => CartScreen::of(cart),
        // marketplace's pending answer: the page says the change is saved and reads again.
        Err(error) if receipt.is_some() && error.catching_up() => CartScreen::pending(),
        Err(error) => {
            let t: CartMsg = req.t();
            // The page the route gives the count for (`gives(CartCount)`): a read that failed after a
            // write draws it as one still catching up.
            return read_failed(req, viewer, error, receipt.is_some().then(|| t.route_cart_pending_fresh_write()))
                .map(|page| page.give::<CartCount>(None));
        }
    };
    let t: CartMsg = req.t();
    // Read the same address again in 2 s, as marketplace's revalidation does, until the receipt
    // it carries is too old to wait for (the read then fails for good and stops asking).
    let pending = screen.pending;
    let head = html! {
        <meta name="description" content={t.route_review_cart_lines_adjust_quantity_and()}>
        if pending {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let status = match &notice {
        None => StatusCode::OK,
        Some(Notice::Attempt(a)) if a.state != Attempted::FailedSafe => StatusCode::CONFLICT,
        Some(_) => StatusCode::UNPROCESSABLE_ENTITY,
    };
    let view = views::cart_page(t, req.t(), &screen, notice.as_ref());
    let title = t.route_cart_marketplace();
    let cart = (!screen.pending).then(|| screen.item_count());
    req.screen_with_status(status, &screen, html! { <Layout req={req} viewer={viewer} title={title} head={head}>{view}</Layout> })
        .map(|page| page.give::<CartCount>(cart))
}

pub(crate) async fn quantity(
    req: Req,
    Caller(buyer): Caller<Buyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    write(&req, &buyer, &config, &headers, Write::Quantity, input).await
}

pub(crate) async fn remove(
    req: Req,
    Caller(buyer): Caller<Buyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    write(&req, &buyer, &config, &headers, Write::Remove, input).await
}

pub(crate) async fn lock(
    req: Req,
    Caller(buyer): Caller<Buyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    write(&req, &buyer, &config, &headers, Write::Lock, input).await
}

/// A line write (marketplace's `submitAccountCartCommands`): one attempt, applied once however
/// often it is sent. Succeeded is the cart again, read after the write; otherwise the cart with
/// what did not apply, and for a write not known to have applied, the same write to send again. A
/// guest's goes to the guest cart it carries; one that carries none is refused before it is sent,
/// as marketplace refuses it.
async fn write(req: &Req, buyer: &Buyer, config: &Config, headers: &HeaderMap, which: Write, mut input: LineInput) -> HtmlResult {
    let t: CartMsg = req.t();
    let attempt = cart_attempt::attempt_id(attempt_text(&input.attempt));
    input.attempt = submit_key(&attempt);
    let guest = match buyer {
        Buyer::Account(_) => None,
        Buyer::Guest(_) => anonymous_cart(headers).map(str::to_owned),
    };
    let commands = match buyer {
        Buyer::Guest(_) if guest.is_none() => Err(t.route_request_failed()),
        _ => input.commands(t, req.t(), which),
    };
    let commands = match commands {
        Ok(commands) => commands,
        Err(message) => {
            let notice = AttemptNotice {
                state: Attempted::FailedSafe,
                message: Some(message.to_owned()),
                not_applied: Vec::new(),
                resend: None,
            };
            return render(req, buyer, config, headers, None, Some(Notice::Attempt(notice))).await;
        }
    };
    let caller = config.platform.caller(headers, config.proto, None);
    let sent = CartWrite::commands(&commands).for_guest(guest);
    let outcome = match cart_attempt::submit(&caller, &attempt, &sent).await {
        Ok(outcome) => outcome,
        Err(StatusCode::UNAUTHORIZED) => return sign_in_to_cart(req),
        Err(status) => return Err(corten::Error::status(status)),
    };
    if outcome.state == Attempted::Succeeded {
        let after = AfterWrite { after_write: outcome.receipt.map(|r| r.param()) };
        return req.redirect(&url::Cart { after });
    }
    let resend = (outcome.state == Attempted::Ambiguous).then_some((which, input));
    let notice = AttemptNotice { state: outcome.state, message: outcome.message, not_applied: outcome.not_applied, resend };
    // What applied (a partial write's) is read back as the API has it now.
    render(req, buyer, config, headers, outcome.receipt.as_ref(), Some(Notice::Attempt(notice))).await
}

/// Check out (marketplace's `/checkout/buy/readiness` action for a signed-in cart): move a guest
/// cart the browser still carries into the account's (best effort, as marketplace does), read the
/// cart's readiness again with the posted decision, start a checkout session from it, and send
/// the buyer to the checkout page with the write's receipt, the guest cart forgotten. A
/// session started again from the same readiness is the same session, so sending again is safe.
/// A refusal is the cart again with the API's reason. A guest's cart checks out as checkout
/// start's Continue, with the same decision.
pub(crate) async fn checkout(
    req: Req,
    Caller(buyer): Caller<Buyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<CheckoutInput>,
) -> HtmlResult {
    let decisions = input.decisions();
    if let Buyer::Guest(_) = buyer {
        let session = buyer.session();
        return crate::checkout_start::cart_as_guest(&req, session.as_ref(), &config, &headers, &uri, &decisions).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let guest = anonymous_cart(&headers);
    if let Some(id) = guest
        && let Err(error) = caller.merge_guest_cart(id).await
    {
        tracing::warn!("the guest cart was not merged before checkout: {error}");
    }
    let started = async {
        let snapshot = caller.cart_readiness(&decisions, guest).await?;
        caller.start_checkout(&snapshot, &decisions, guest).await
    };
    let (session, receipt) = match started.await {
        Ok(started) => started,
        Err(error) => return refused(&req, &buyer, &config, &headers, error).await,
    };
    let place = crate::checkout::Place::started(receipt.as_ref());
    let mut res = req.redirect(&url::BuyCheckout { id: &session.session_id, place })?;
    if guest.is_some() {
        let forget = cookie::SetCookie::remove(ANONYMOUS_CART_COOKIE);
        let forget = if config.proto == "https" { forget } else { forget.insecure() };
        res.headers_mut().append(header::SET_COOKIE, forget.header());
    }
    Ok(res)
}

/// Checkout did not start: sign in again, the error page, or the cart with the API's reason.
async fn refused(req: &Req, buyer: &Buyer, config: &Config, headers: &HeaderMap, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in_to_cart(req),
        Some(StatusCode::FORBIDDEN) => Err(crate::app::api_refused(error)),
        Some(status) if status.is_client_error() => {
            let t: CartMsg = req.t();
            let reason = error.refusal().unwrap_or(t.route_request_failed()).to_owned();
            render(req, buyer, config, headers, None, Some(Notice::Checkout(reason))).await
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// Marketplace's sign-in, back to the cart: a write's own path takes only a post.
fn sign_in_to_cart(req: &Req) -> HtmlResult {
    match sign_in_at(url::Cart::PATH) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}
