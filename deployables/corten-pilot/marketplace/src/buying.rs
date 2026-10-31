//! The item page's buy writes (marketplace's item action, bounded-contexts/discovery/support/
//! route-support/item-detail/action.ts): add the listing shown or the product chosen to the buy
//! cart, buy the best match (add it, then the cart), and buy the listing shown now (a checkout
//! session).
//!
//! Each is a plain form posted with the page's address (the choices it was drawn with), the
//! product and the listing the rail showed, the quantity and an attempt (`SubmitKey`). The pilot
//! reads the item again and builds the cart line from it, as marketplace's action does, and from
//! the choices the address makes rather than the words a form sends.
//!
//! | Button | `intent` | Sends | Then |
//! |---|---|---|---|
//! | Add listing to Buy Cart | `add-listing` | a line locked to the listing | the page, saying it was added |
//! | Add product to Buy Cart | `add-product` | a line Smart Match fills | the page, saying it was added |
//! | Buy best match | `buy-best-match` | a line Smart Match fills, once the lowest listing has the quantity | the cart |
//! | Buy this listing | (its own path) | a checkout session for the listing | the checkout (a guest: checkout start) |
//! | Make offer | (its own path) | nothing: the price, currency and quantity are checked | checkout start for the offer |
//!
//! A cart add is one cart attempt (`cart.add-line`), applied once however often it is sent, and
//! resolved as the cart's writes are (`cart_attempt`). A guest's add goes to a guest cart whose
//! id the browser keeps in marketplace's cookie; marketplace's cart reads it, so a guest's View buy
//! cart is marketplace's (the pilot's cart is for accounts). A guest's Buy this listing is checkout
//! start's Continue for the listing (`checkout_start`), as marketplace re-sends it there.
use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode, header},
    },
    prelude::*,
    security::cookie,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    api::{Caller, CartWrite, Checkout as _, Discovery as _, Item, Listing, Selected, segment},
    app::{GUEST_CHECKOUT, Shared, sign_in_at, url},
    auth::Session,
    cart::{ANONYMOUS_CART_COOKIE, AfterWrite},
    cart_attempt::{self, State as Attempted},
    items::{self, Address, ItemScreen, Raw, available},
    text::ItemMsg,
    views,
};

/// The item page's parameter after Add to cart: the write's receipt (empty without one).
pub const ADDED: &str = "added";

/// A buy form's own fields, for their names: the form is read as `Raw`, since it also posts the
/// page's address (`dimension.<id>` keys are data, todd-skelton/corten#71).
#[derive(Fields)]
#[allow(dead_code)]
pub struct BuyFields {
    intent: String,
    attempt: String,
    quantity: String,
    product: String,
    lock: String,
    price: String,
    currency: String,
}

/// The names as text.
pub mod field {
    use super::BuyFields;
    pub const INTENT: &str = BuyFields::FIELDS.intent.as_str();
    pub const ATTEMPT: &str = BuyFields::FIELDS.attempt.as_str();
    pub const QUANTITY: &str = BuyFields::FIELDS.quantity.as_str();
    pub const PRODUCT: &str = BuyFields::FIELDS.product.as_str();
    pub const LOCK: &str = BuyFields::FIELDS.lock.as_str();
    pub const PRICE: &str = BuyFields::FIELDS.price.as_str();
    pub const CURRENCY: &str = BuyFields::FIELDS.currency.as_str();
}

/// How long a guest cart's cookie lasts (`THIRTY_DAYS_SECONDS`).
const GUEST_CART_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Which button sent a buy form.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Intent {
    /// Add the listing shown, locked to it.
    AddListing,
    /// Add the product chosen, for Smart Match to fill.
    #[default]
    AddProduct,
    /// Add the product chosen and open the cart.
    BuyBestMatch,
    /// Buy the listing shown now.
    BuyNow,
    /// Offer a price for the product chosen.
    Offer,
}

/// The rail's three forms, each of which shows its own refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RailForm {
    Listing,
    Product,
    Offer,
}

impl Intent {
    pub fn as_str(self) -> &'static str {
        match self {
            Intent::AddListing => "add-listing",
            Intent::AddProduct => "add-product",
            Intent::BuyBestMatch => "buy-best-match",
            Intent::BuyNow => "buy-now",
            Intent::Offer => "offer",
        }
    }

    fn read(value: &str) -> Self {
        match value {
            "add-listing" => Intent::AddListing,
            "buy-best-match" => Intent::BuyBestMatch,
            "buy-now" => Intent::BuyNow,
            _ => Intent::AddProduct,
        }
    }

    /// The rail's form that sent it.
    pub fn form(self) -> RailForm {
        match self {
            Intent::AddListing | Intent::BuyNow => RailForm::Listing,
            Intent::AddProduct | Intent::BuyBestMatch => RailForm::Product,
            Intent::Offer => RailForm::Offer,
        }
    }
}

/// A buy form as posted: the button, the attempt, the quantity as typed, the product and the
/// listing the rail showed, an offer's price and currency, and the page's address.
#[derive(Clone, Debug, Default)]
pub struct BuyInput {
    pub intent: Intent,
    pub attempt: String,
    pub quantity: String,
    pub product: String,
    pub lock: String,
    pub price: String,
    pub currency: String,
    pub address: Address,
}

impl BuyInput {
    /// The form's fields as posted, to send the same write again (the same attempt).
    pub fn pairs(&self) -> Vec<(String, String)> {
        let mut pairs = vec![
            (field::INTENT.to_owned(), self.intent.as_str().to_owned()),
            (field::ATTEMPT.to_owned(), self.attempt.clone()),
            (field::QUANTITY.to_owned(), self.quantity.clone()),
            (field::PRODUCT.to_owned(), self.product.clone()),
        ];
        if !self.lock.is_empty() {
            pairs.push((field::LOCK.to_owned(), self.lock.clone()));
        }
        for (name, value) in [(field::PRICE, &self.price), (field::CURRENCY, &self.currency)] {
            if !value.is_empty() {
                pairs.push((name.to_owned(), value.clone()));
            }
        }
        pairs.extend(self.address.pairs());
        pairs
    }

    pub fn read(raw: &Raw) -> Self {
        let first = |key: &str| raw.get(key).and_then(|v| v.all().first()).map(|v| v.trim().to_owned()).unwrap_or_default();
        BuyInput {
            intent: Intent::read(&first(field::INTENT)),
            attempt: first(field::ATTEMPT),
            quantity: first(field::QUANTITY),
            product: first(field::PRODUCT),
            lock: first(field::LOCK),
            price: first(field::PRICE),
            currency: first(field::CURRENCY),
            address: Address::read(raw),
        }
    }
}

/// What the item page says about a buy write.
#[derive(Clone, Debug)]
pub enum BuyNotice {
    /// Added: View buy cart's address, which waits for the write.
    Added(String),
    /// Not known to have applied: the same add to send again (the same attempt, so it cannot
    /// apply twice), and the cart's address.
    Ambiguous { resend: BuyInput, cart: String },
    /// Nothing changed, for this reason; the form that sent it shows what was typed.
    Refused { message: String, input: BuyInput },
    /// A sell form's write did not apply, for this reason (`selling`); `form` shows it and the
    /// quantity typed.
    SellRefused { message: String, form: crate::selling::SellForm, quantity: String },
    /// A Watch alert was saved; the alerts' settings, which wait for the write.
    Watched(String),
    /// Add to List added the product (`saving`).
    Saved(crate::saving::Saved),
    /// Add to List did not, for this reason (`saving`); `input` is what was chosen and typed.
    SaveRefused { message: String, input: crate::saving::SaveInput },
    /// A Watch form's alert was not saved, for this reason (`watching`); `input` is what was typed.
    WatchRefused { message: String, input: crate::watching::WatchInput },
    /// List this product did not list, for this reason (`listing`); `draft` is the listing it
    /// left unpublished, if any.
    ListRefused { message: String, input: crate::listing::ListInput, draft: Option<String> },
    /// The ship-from setup was not saved, for this reason (`listing`).
    ShipFromRefused { message: String, input: crate::listing::ShipFromInput },
}

/// A cart line as an item page adds it (`AddCheckoutCartLineRequest`): the catalog's words and
/// picture, the product's options, the quantity, and the listing it is locked to, if any.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CartLine {
    pub catalog_item_id: String,
    pub product_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub item_image_url: Option<String>,
    pub item_image_src_set: Option<String>,
    pub item_image_loading_url: Option<String>,
    pub item_image_loading_alt: Option<String>,
    pub item_image_loading_src_set: Option<String>,
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub quantity: u32,
    /// `locked-listing` or `optimize`.
    pub fulfillment_mode: &'static str,
    pub locked_listing_id: Option<String>,
    pub seller_preference_id: Option<String>,
    pub selected_listing_snapshot: Option<ListingSnapshot>,
}

/// The listing a locked line was added from, as the buyer saw it (`selectedListingSnapshotFromListing`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingSnapshot {
    pub listing_id: String,
    pub seller_account_id: String,
    pub seller_display_name: Option<String>,
    pub seller_slug: Option<String>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub listing_stream_version: Option<u64>,
    pub source: &'static str,
}

/// A quantity as marketplace takes it (`parsePositiveQuantity`): digits only, 1 or more.
pub fn quantity(text: &str) -> Option<u32> {
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|q| *q >= 1)
}

/// A listing of the item a buyer can buy (`findSelectedListingForAction`): active, with stock.
fn buyable<'a>(item: &'a Item, id: &str) -> Option<&'a Listing> {
    item.market_listings
        .iter()
        .chain(&item.market_product_listings)
        .find(|l| !id.is_empty() && l.listing_id == id)
        .filter(|l| l.status == "active" && available(l) >= 1)
}

/// The product's lowest listing (`findLowestListingForProductAction`).
fn lowest<'a>(item: &'a Item, product: &str) -> Option<&'a Listing> {
    let id = item.market_products.iter().find(|p| p.product_id == product)?.lowest_listing_id.as_deref()?;
    buyable(item, id)
}

/// `listing` has `quantity` (`assertSelectedListingQuantityAvailable`).
fn enough(t: ItemMsg, listing: &Listing, quantity: u32) -> Result<(), String> {
    let left = available(listing);
    if u64::from(quantity) > left { Err(t.route_validation_selected_listing_quantity_exceeded(left).to_string()) } else { Ok(()) }
}

/// The item's picture for a cart line (`selectItemImage(item, "thumbnail")`) and its srcset.
fn thumbnail(item: &Item) -> (Option<String>, Option<String>) {
    for set in &item.product_asset_sets {
        let mut variants: Vec<_> = set.variants.iter().filter(|v| v.role == "thumbnail").collect();
        variants.sort_by_key(|v| v.width);
        if let Some(one) = variants.iter().find(|v| v.density == 1).or(variants.first()) {
            let srcset = variants.iter().map(|v| format!("{} {}w", v.public_url, v.width)).collect::<Vec<_>>().join(", ");
            return (Some(one.public_url.clone()), Some(srcset));
        }
    }
    let permanent = item.image_fallback.as_ref().filter(|f| f.usage == "permanent").map(|f| f.url.clone());
    (item.image_urls.first().cloned().or(permanent), None)
}

/// The card back a line shows while its picture loads, and its 1x/2x srcset (`imageVariantSrcSet`).
fn loading(item: &Item) -> (Option<String>, Option<String>, Option<String>) {
    let Some(fallback) = &item.image_fallback else { return (None, None, None) };
    let srcset = fallback.variants.get("thumbnail").map(|v| {
        [v.one_x.as_ref().map(|u| format!("{u} 1x")), v.two_x.as_ref().map(|u| format!("{u} 2x"))]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ")
    });
    (Some(fallback.url.clone()), Some(fallback.alt.clone()), srcset.filter(|s| !s.is_empty()))
}

/// The page as the form saw it, read again: the product must be the one it showed.
fn screen_for(session: Option<&Session>, item: &Item, input: &BuyInput) -> Option<ItemScreen> {
    let viewer = match session {
        Some(Session::Account(viewer)) => Some(viewer.actor.account_id.clone()),
        _ => None,
    };
    let screen = ItemScreen::of(item.clone(), &input.address, viewer);
    (!input.product.is_empty() && screen.product_id.as_deref() == Some(input.product.as_str())).then_some(screen)
}

/// The cart line an add sends, or why it is refused before it is sent (the action's checks).
pub fn cart_line(t: ItemMsg, item: &Item, screen: &ItemScreen, input: &BuyInput) -> Result<CartLine, String> {
    let quantity = quantity(&input.quantity).ok_or_else(|| t.route_validation_quantity_required().to_owned())?;
    let unavailable = || t.route_validation_selected_listing_unavailable().to_owned();
    let locked = match input.intent {
        Intent::AddListing => {
            let listing = buyable(item, &input.lock).filter(|l| l.product_id == input.product).ok_or_else(unavailable)?;
            enough(t, listing, quantity)?;
            Some(listing)
        }
        Intent::BuyBestMatch => {
            enough(t, lowest(item, &input.product).ok_or_else(unavailable)?, quantity)?;
            None
        }
        _ => None,
    };
    let (image, srcset) = thumbnail(item);
    let (loading_url, loading_alt, loading_srcset) = loading(item);
    Ok(CartLine {
        catalog_item_id: item.catalog_item_id.clone(),
        product_id: input.product.clone(),
        item_title: item.title.clone(),
        item_subtitle: item.subtitle.clone(),
        item_image_url: image,
        item_image_src_set: srcset,
        item_image_loading_url: loading_url,
        item_image_loading_alt: loading_alt,
        item_image_loading_src_set: loading_srcset,
        selected_options: screen.product_options.clone(),
        product_summary: screen.product_summary.clone(),
        quantity,
        fulfillment_mode: if locked.is_some() { "locked-listing" } else { "optimize" },
        locked_listing_id: locked.map(|l| l.listing_id.clone()),
        seller_preference_id: locked.map(|l| l.listing_id.clone()),
        selected_listing_snapshot: locked.map(|l| ListingSnapshot {
            listing_id: l.listing_id.clone(),
            seller_account_id: l.account_id.clone(),
            seller_display_name: l.seller_display_name.clone(),
            seller_slug: l.seller_slug.clone(),
            price_amount: l.price_amount.clone(),
            price_currency_code: l.price_currency_code.clone(),
            listing_stream_version: l.listing_stream_version,
            source: "discovery.item-detail.add-to-cart",
        }),
    })
}

/// Whose cart a request writes: the account's (`None`), or a guest's, by the id the browser keeps
/// or a new one (`ensureAnonymousCartId`). A guest checkout's session writes a guest cart too.
fn guest_cart(session: Option<&Session>, headers: &HeaderMap) -> Result<Option<String>, corten::Error> {
    match session {
        Some(Session::Account(viewer)) if !viewer.actor.can(GUEST_CHECKOUT) => Ok(None),
        Some(Session::Unavailable) => Err(corten::Error::status(StatusCode::BAD_GATEWAY)),
        _ => Ok(Some(
            cookie::get(headers, ANONYMOUS_CART_COOKIE)
                .filter(|id| id.starts_with("anon_"))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("anon_cmd_{}", uuid::Uuid::new_v4().simple())),
        )),
    }
}

/// Is the request a guest's (no account cart)?
pub(crate) fn is_guest(session: Option<&Session>) -> bool {
    !matches!(session, Some(Session::Account(viewer)) if !viewer.actor.can(GUEST_CHECKOUT))
}

/// The buy cart after a write whose receipt is `receipt` (empty for none): the pilot's for an
/// account, marketplace's for a guest, with the handoff marketplace's cart waits on
/// (`ACCOUNT_CART_ADD_LINE_HANDOFF`).
pub fn cart_href(session: Option<&Session>, receipt: &str) -> String {
    let receipt = (!receipt.is_empty()).then_some(receipt);
    if !is_guest(session) {
        return url::Cart { after: AfterWrite { after_write: receipt.map(str::to_owned) } }.href();
    }
    let mut path = String::from("/account/cart");
    if let Some(receipt) = receipt {
        let handoff = r#"{"kind":"checkout.cart.add-line","expectation":"collection-non-empty","surface":"account-cart"}"#;
        path.push_str(&format!("?afterWrite={}&postWriteHandoff={}", segment(receipt), segment(handoff)));
    }
    views::marketplace(&path).map(|u| u.to_string()).unwrap_or(path)
}

async fn read_item(caller: &Caller<'_>, slug: &str) -> Result<Item, corten::Error> {
    match caller.item(slug).await {
        Ok(Some(item)) => Ok(item),
        Ok(None) => Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The page again, saying why nothing changed.
fn refused(req: &Req, session: Option<&Session>, item: Item, input: BuyInput, message: String) -> HtmlResult {
    let address = input.address.clone();
    let notice = BuyNotice::Refused { message, input };
    items::render(req, session, item, &address, Some(&notice), StatusCode::UNPROCESSABLE_ENTITY, Default::default())
}

/// Marketplace's sign-in, back to the item: the session ended between the page and the post.
fn sign_in(req: &Req, slug: &str) -> HtmlResult {
    match sign_in_at(&url::Item { slug, state: Address::default(), after: Default::default() }.href()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// Add to cart and Buy best match (the action's `add-to-cart` and `buy-best-match`).
pub(crate) async fn add(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemCart<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let mut input = BuyInput::read(&raw);
    input.attempt = cart_attempt::attempt_id(&input.attempt);
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = read_item(&caller, &slug).await?;
    let guest = guest_cart(session, &headers)?;
    let Some(screen) = screen_for(session, &item, &input) else {
        return refused(&req, session, item, input, t.route_add_to_cart_failed().to_owned());
    };
    let line = match cart_line(t, &item, &screen, &input) {
        Ok(line) => line,
        Err(message) => return refused(&req, session, item, input, message),
    };
    let write = CartWrite::add_line(&line, guest.clone());
    let outcome = match cart_attempt::submit(&caller, &input.attempt, &write).await {
        Ok(outcome) => outcome,
        Err(StatusCode::UNAUTHORIZED) => return sign_in(&req, &slug),
        Err(status) => return Err(corten::Error::status(status)),
    };
    let receipt = outcome.receipt.as_ref().map(|r| r.param()).unwrap_or_default();
    let slug = item.slug.clone().unwrap_or(slug);
    let mut res = match outcome.state {
        Attempted::Succeeded if input.intent == Intent::BuyBestMatch => {
            let to = cart_href(session, &receipt);
            req.redirect(&to.parse::<corten::axum::http::Uri>().map_err(corten::Error::new)?)?
        }
        Attempted::Succeeded => req.redirect(&url::Item {
            slug: &slug,
            state: input.address.clone(),
            after: items::After { added: Some(receipt), ..Default::default() },
        })?,
        Attempted::Ambiguous => {
            let address = input.address.clone();
            let notice = BuyNotice::Ambiguous { cart: cart_href(session, ""), resend: input };
            items::render(&req, session, item, &address, Some(&notice), StatusCode::CONFLICT, Default::default())?
        }
        Attempted::Partial | Attempted::FailedSafe => {
            let message = outcome
                .message
                .or_else(|| outcome.not_applied.into_iter().flatten().next())
                .unwrap_or_else(|| t.route_add_to_cart_failed().to_owned());
            refused(&req, session, item, input, message)?
        }
    };
    if let Some(id) = guest {
        let keep = cookie::SetCookie::new(ANONYMOUS_CART_COOKIE, &id).max_age(GUEST_CART_SECONDS);
        let keep = if config.proto == "https" { keep } else { keep.insecure() };
        res.headers_mut().append(header::SET_COOKIE, keep.header());
    }
    Ok(res)
}

/// Buy this listing (the action's `buy-this-listing`): a checkout session for the listing shown,
/// started once per form (its `SubmitKey` is the entry key, so sending it again is the same
/// session), then the checkout. A guest's or a visitor's is checkout start's Continue for the
/// listing, as marketplace re-sends the form there.
pub(crate) async fn buy(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemBuy<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let mut input = BuyInput::read(&raw);
    input.intent = Intent::BuyNow;
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = read_item(&caller, &slug).await?;
    let changed = t.route_buy_changed().to_owned();
    if cart_attempt::attempt_id(&input.attempt) != input.attempt {
        return refused(&req, session, item, input, changed);
    }
    let Some(screen) = screen_for(session, &item, &input) else { return refused(&req, session, item, input, changed) };
    let Some(quantity) = quantity(&input.quantity) else {
        return refused(&req, session, item, input, t.route_validation_quantity_required().to_owned());
    };
    let listing = if input.lock.is_empty() { lowest(&item, &input.product) } else { buyable(&item, &input.lock) };
    let Some(listing) = listing.cloned() else {
        return refused(&req, session, item, input, t.route_validation_selected_listing_unavailable().to_owned());
    };
    if let Err(message) = enough(t, &listing, quantity) {
        return refused(&req, session, item, input, message);
    }
    let summary = screen.product_summary.clone();
    let source = json!({
        "type": "buy-now",
        "listingId": listing.listing_id,
        "catalogItemId": item.catalog_item_id,
        "productId": input.product,
        "itemTitle": item.title,
        "itemSubtitle": item.subtitle,
        "selectedOptions": screen.product_options,
        "productSummary": summary,
        "quantity": quantity,
        "fulfillmentMode": "locked-listing",
        "lockedListingId": listing.listing_id,
    });
    if is_guest(session) {
        let available =
            t.route_inventory_option_label(summary.as_deref().unwrap_or(&item.title), available(&listing)).to_string();
        let entry = guest_checkout(&source, &listing, &available, t.route_confirmed_at_checkout());
        return crate::checkout_start::buy_as_guest(&req, session, &config, &headers, &entry, &input.attempt).await;
    }
    match caller.buy_now(&input.attempt, &source).await {
        Ok((session, receipt)) => {
            let place = crate::checkout::Place::started(receipt.as_ref());
            req.redirect(&crate::app::url::BuyCheckout { id: &session.session_id, place })
        }
        Err(error) => match (error.status(), error.code()) {
            (Some(StatusCode::UNAUTHORIZED), _) => sign_in(&req, &slug),
            (Some(StatusCode::FORBIDDEN), _) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
            (_, Some("checkout_attempt_conflict")) => refused(&req, session, item, input, changed),
            (_, Some("checkout_closed")) => refused(&req, session, item, input, t.route_checkout_closed().to_owned()),
            (Some(status), _) if status.is_client_error() => {
                let message = error.refusal().map(str::to_owned).unwrap_or(changed);
                refused(&req, session, item, input, message)
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}

/// Marketplace's one currency.
const USD: corten::i18n::Currency = corten::i18n::Currency::new("USD");

/// A price typed in the page's locale (`t.parse_money`, in US dollars, the only currency
/// marketplace sells in): `24.5`, `$1,299.50` in en. More than zero, written as marketplace's API
/// takes an amount (`normalizeMoneyAmount`: two fraction digits). Before todd-skelton/corten#208 the
/// pilot read only a plain decimal, as marketplace's form does.
pub fn price(t: ItemMsg, text: &str) -> Option<String> {
    let cents = t.parse_money(text.trim(), USD).map(|c| c.0).filter(|c| *c > 0)?;
    Some(format!("{}.{:02}", cents / 100, cents % 100))
}

/// Make an offer (the action's `submit-offer`): checked as marketplace checks it, then checkout
/// start with the product and the offer in its query. Nothing is written here; the offer is placed
/// from there.
pub(crate) async fn offer(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemOffer<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let mut input = BuyInput::read(&raw);
    input.intent = Intent::Offer;
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = read_item(&caller, &slug).await?;
    let Some(amount) = price(t, &input.price) else {
        return refused(&req, session, item, input, t.route_validation_price_required().to_owned());
    };
    let Some(quantity) = quantity(&input.quantity) else {
        return refused(&req, session, item, input, t.route_validation_quantity_required().to_owned());
    };
    let Some(screen) = screen_for(session, &item, &input) else {
        return refused(&req, session, item, input, t.route_choose_options_to_make_an_offer().to_owned());
    };
    let options = serde_json::to_string(&screen.product_options).unwrap_or_else(|_| "[]".to_owned());
    let pairs = [
        ("source", "offer-intent".to_owned()),
        ("catalogItemId", item.catalog_item_id.clone()),
        ("productId", input.product.clone()),
        ("itemTitle", item.title.clone()),
        ("itemSubtitle", item.subtitle.clone().unwrap_or_default()),
        ("selectedOptions", options),
        ("productSummary", screen.product_summary.clone().unwrap_or_default()),
        ("offerPriceAmount", amount),
        ("offerPriceCurrencyCode", input.currency.to_ascii_uppercase()),
        ("quantity", quantity.to_string()),
    ];
    let query = pairs.iter().map(|(k, v)| format!("{k}={}", segment(v))).collect::<Vec<_>>().join("&");
    req.redirect(&checkout_start(&query).parse::<corten::axum::http::Uri>().map_err(corten::Error::new)?)
}

/// Checkout start (`/checkout/buy/readiness`) with an entry's query.
fn checkout_start(query: &str) -> String {
    format!("{}?{query}", crate::app::url::CheckoutStart.href())
}

/// Checkout start's entry for one listing (`/checkout/buy/readiness`'s query), as marketplace's
/// item action builds it.
pub(crate) fn guest_checkout(source: &Value, listing: &Listing, available: &str, fulfillment: &str) -> String {
    let text = |key: &str| match &source[key] {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let pairs = [
        ("source", "buy-now".to_owned()),
        ("listingId", text("listingId")),
        ("fulfillmentMode", text("fulfillmentMode")),
        ("lockedListingId", text("lockedListingId")),
        ("catalogItemId", text("catalogItemId")),
        ("productId", text("productId")),
        ("itemTitle", text("itemTitle")),
        ("itemSubtitle", text("itemSubtitle")),
        ("selectedOptions", source["selectedOptions"].to_string()),
        ("productSummary", text("productSummary")),
        ("quantity", text("quantity")),
        ("priceAmount", listing.price_amount.clone()),
        ("priceCurrencyCode", listing.price_currency_code.clone().unwrap_or_default()),
        ("sellerName", listing.seller_display_name.clone().unwrap_or_default()),
        ("availability", available.to_owned()),
        ("fulfillment", fulfillment.to_owned()),
    ];
    pairs.iter().map(|(k, v)| format!("{k}={}", segment(v))).collect::<Vec<_>>().join("&")
}
