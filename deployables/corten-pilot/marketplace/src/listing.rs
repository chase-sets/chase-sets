//! The item page's listing forms (marketplace's item action, `list-at-price` and
//! `create-listing-stock-location` in bounded-contexts/discovery/support/route-support/item-detail/
//! action.ts): list the product the Sell tab shows at a price, and the ship-from setup an
//! account's quick listings need first.
//!
//! | Viewer | List this product | Then |
//! |---|---|---|
//! | A guest (or a guest checkout's session) | a listing draft intent, its owner in marketplace's cookie | marketplace's registration, which claims it |
//! | An account with `listings.view` and `listings.manage` | its Listing stock, a listing and its publication | the item, its listing chosen |
//! | Another account | (no form: marketplace's registration link) | |
//!
//! An account's quick listing ships from a Listing stock location, which the Sell tab offers to
//! save (Ship-from setup) when the seller overlay says there is none. The listing's three writes
//! are one form's: the stock is one inventory attempt (the form's `SubmitKey`) and the listing's
//! id is made from the same key (`listingIdOverride`), so the same form sent again is the same
//! stock and the same listing, where marketplace's action creates another. A publication the API
//! refuses leaves the draft, which the form then links to.
//!
//! The product's options and words come from the page the form was drawn as, not the form. The
//! stock's ensure never sends a graded card's details, so a graded product cannot be listed here,
//! as on marketplace (chase-sets/chase-sets#10598); the API's refusal is shown.
use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode, Uri, header},
    },
    prelude::*,
    security::cookie,
};
use serde_json::json;

use crate::{
    api::{self, ApiError, Discovery as _, Inventory as _, Item, Listings as _, LocationCommand, segment},
    app::{GUEST_CHECKOUT, Shared, sign_in_at, url},
    auth::Session,
    buying::{self, BuyNotice},
    items::{self, Address, ItemScreen, Market, Raw},
    selling,
    text::ItemMsg,
};

/// The item page's parameter after a seller's write: the write's receipt, which its reads wait
/// for (`items::After`).
pub const WRITTEN: &str = "after_write";
/// Marketplace's anonymous listing draft cookie (`MARKETPLACE_ANONYMOUS_LISTING_DRAFT_COOKIE_NAME`).
pub const ANONYMOUS_LISTING_DRAFT_COOKIE: &str = "chase_sets_anonymous_listing_drafts";
/// How long it lasts (`THIRTY_DAYS_SECONDS`).
const GUEST_DRAFT_SECONDS: i64 = 30 * 24 * 60 * 60;
/// The Listing stock location marketplace's quick listings ship from (`LISTING_STOCK_LOCATION_*`,
/// support.ts); the seller overlay finds it by this code or name.
const STOCK_NAME: &str = "Listing stock";
const STOCK_DESCRIPTION: &str = "Auto-managed stock backing standard marketplace listings.";
const STOCK_CODE: &str = "LISTING-STOCK";

/// A listing form's own fields, for their names (the forms are read as `Raw`, since they also
/// post the page's address).
#[derive(Fields)]
#[allow(dead_code)]
pub struct ListFields {
    pub attempt: Option<SubmitKey>,
    product: String,
    price: String,
    currency: String,
    quantity: String,
    name: String,
    line1: String,
    city: String,
    state: String,
    postal_code: String,
    country: String,
}

/// The names as text.
pub mod field {
    use super::ListFields;
    pub const ATTEMPT: &str = ListFields::FIELDS.attempt.as_str();
    pub const PRODUCT: &str = ListFields::FIELDS.product.as_str();
    pub const PRICE: &str = ListFields::FIELDS.price.as_str();
    pub const CURRENCY: &str = ListFields::FIELDS.currency.as_str();
    pub const QUANTITY: &str = ListFields::FIELDS.quantity.as_str();
    pub const NAME: &str = ListFields::FIELDS.name.as_str();
    pub const LINE1: &str = ListFields::FIELDS.line1.as_str();
    pub const CITY: &str = ListFields::FIELDS.city.as_str();
    pub const STATE: &str = ListFields::FIELDS.state.as_str();
    pub const POSTAL_CODE: &str = ListFields::FIELDS.postal_code.as_str();
    pub const COUNTRY: &str = ListFields::FIELDS.country.as_str();
}

/// What a refused listing form had typed, so it is drawn again with it.
#[derive(Clone, Debug, Default)]
pub struct ListInput {
    pub price: String,
    pub currency: String,
    pub quantity: String,
}

/// What a refused ship-from setup form had typed.
#[derive(Clone, Debug, Default)]
pub struct ShipFromInput {
    pub name: String,
    pub line1: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
}

/// May the viewer list at a price (`canUseListingFeatures`, `canSellOnItem`)?
pub fn listing_features(session: Option<&Session>) -> bool {
    match session {
        Some(Session::Account(viewer)) => viewer.actor.can("listings.view") && viewer.actor.can("listings.manage"),
        _ => false,
    }
}

/// The listing a form's attempt creates: `lst_` and the attempt's UUID (the API takes any `lst_`
/// id, as checkout's reviewed listings use), so the same form sent again names the same listing.
pub fn listing_id(attempt: &str) -> Option<String> {
    uuid::Uuid::parse_str(attempt).ok().map(|id| format!("lst_{}", id.simple()))
}

/// Registration, then the new listing page claiming the draft
/// (`buildRegisterToClaimListingDraftHref`).
fn register_href(intent: &str) -> String {
    crate::register::href(&format!("/account/listings/new?claimListingIntent={}", segment(intent)))
}

/// The guest draft owner a request writes as, by the id the browser keeps or a new one
/// (`ensureAnonymousListingDraftOwnerId`).
fn guest_owner(headers: &HeaderMap) -> String {
    cookie::get(headers, ANONYMOUS_LISTING_DRAFT_COOKIE)
        .filter(|id| id.starts_with("anon_"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("anon_cmd_{}", uuid::Uuid::new_v4().simple()))
}

/// The item for a listing form, read again; a failed read is the error page.
async fn read_item(caller: &api::Caller<'_>, slug: &str) -> Result<Item, corten::Error> {
    match caller.item(slug).await {
        Ok(Some(item)) => Ok(item),
        Ok(None) => Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The page again on its Sell tab, saying in the form that sent it why nothing (more) was saved.
async fn refused(
    req: &Req,
    session: Option<&Session>,
    caller: &api::Caller<'_>,
    item: Item,
    address: &Address,
    notice: BuyNotice,
) -> HtmlResult {
    let reads = items::sell_reads(req, session, caller, &item, address, false).await;
    items::render(req, session, item, address, Some(&notice), StatusCode::UNPROCESSABLE_ENTITY, reads)
}

/// How a listing write's failure is answered.
enum Failed {
    /// The session ended between the page and the post.
    SignIn,
    /// The API said why: the form shows it.
    Refused(String),
    Error(corten::Error),
}

fn failed(error: ApiError) -> Failed {
    match (error.status(), error.refusal()) {
        (Some(StatusCode::UNAUTHORIZED), _) => Failed::SignIn,
        (Some(StatusCode::FORBIDDEN), _) => Failed::Error(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
        (_, Some(message)) => Failed::Refused(message.to_owned()),
        _ => Failed::Error(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

fn sign_in(req: &Req, slug: &str) -> HtmlResult {
    match sign_in_at(&format!("/items/{}?market=sell", segment(slug))) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// The first value of a form field, trimmed.
fn first(raw: &Raw, key: &str) -> String {
    raw.get(key).and_then(|v| v.all().first()).map(|v| v.trim().to_owned()).unwrap_or_default()
}

/// List this product (the action's `list-at-price`).
pub(crate) async fn list(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemList<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let input = ListInput {
        price: first(&raw, field::PRICE),
        currency: first(&raw, field::CURRENCY).to_ascii_uppercase(),
        quantity: first(&raw, field::QUANTITY),
    };
    let address = Address::read(&raw).with_market(Market::Sell);
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = read_item(&caller, &slug).await?;
    let slug = item.slug.clone().unwrap_or(slug);
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let viewer = match session {
        Some(Session::Account(viewer)) => Some(viewer.actor.account_id.clone()),
        _ => None,
    };
    let screen = ItemScreen::of(item.clone(), &address, viewer);
    let refuse = |message: String, input: ListInput, draft: Option<String>| BuyNotice::ListRefused { message, input, draft };
    let product = first(&raw, field::PRODUCT);
    if product.is_empty() || screen.product_id.as_deref() != Some(product.as_str()) {
        let notice = refuse(t.route_choose_options_to_list_matching_inventory().to_owned(), input, None);
        return refused(&req, session, &caller, item, &address, notice).await;
    }
    let Some(amount) = buying::price(t, &input.price) else {
        let notice = refuse(t.route_validation_price_required().to_owned(), input, None);
        return refused(&req, session, &caller, item, &address, notice).await;
    };
    let Some(quantity) = buying::quantity(&input.quantity) else {
        let notice = refuse(t.route_validation_quantity_required().to_owned(), input, None);
        return refused(&req, session, &caller, item, &address, notice).await;
    };
    // No account sell list: a draft the guest registers to claim (a guest checkout's session too,
    // as marketplace's `canUseAccountSellList` says).
    if !selling::account_sell_list(session) {
        let draft = json!({
            "sourcePath": format!("/items/{slug}?market=sell"),
            "catalogItemId": item.catalog_item_id,
            "productId": product,
            "selectedOptions": screen.product_options,
            "productSummary": screen.product_summary,
            "priceAmount": amount,
            "priceCurrencyCode": input.currency,
            "quantityCap": quantity,
        });
        let owner = guest_owner(&headers);
        let intent = match caller.listing_draft_intent(&owner, &draft).await {
            Ok(intent) => intent,
            Err(error) => {
                return match failed(error) {
                    Failed::Refused(message) => {
                        refused(&req, session, &caller, item, &address, refuse(message, input, None)).await
                    }
                    Failed::SignIn => sign_in(&req, &slug),
                    Failed::Error(error) => Err(error),
                };
            }
        };
        let to: Uri = register_href(&intent.intent_id).parse().map_err(corten::Error::new)?;
        let mut res = req.redirect(&to)?;
        let keep = cookie::SetCookie::new(ANONYMOUS_LISTING_DRAFT_COOKIE, &owner).max_age(GUEST_DRAFT_SECONDS);
        let keep = if config.proto == "https" { keep } else { keep.insecure() };
        res.headers_mut().append(header::SET_COOKIE, keep.header());
        return Ok(res);
    }
    if !listing_features(session) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    // One attempt for the form's three writes: the stock's ensure applies once per attempt, and
    // the listing's id is made from it.
    let attempt = first(&raw, field::ATTEMPT);
    let (attempt, id) = match listing_id(&attempt) {
        Some(id) => (attempt, id),
        None => {
            let attempt = uuid::Uuid::new_v4().to_string();
            let id = listing_id(&attempt).expect("a new UUID");
            (attempt, id)
        }
    };
    let stock = json!({
        "catalogItemId": item.catalog_item_id,
        "selectedOptions": screen.product_options,
        "quantity": quantity,
    });
    let answer = |failure: Failed, input: ListInput, draft: Option<String>| (failure, input, draft);
    let result = async {
        let stock = caller.ensure_listing_stock(&attempt, &stock).await.map_err(|e| answer(failed(e), input.clone(), None))?;
        let listing = json!({
            "inventoryItemId": "",
            "priceAmount": amount,
            "priceCurrencyCode": input.currency,
            "quantityCap": quantity,
            "inventorySnapshot": stock.snapshot,
            "listingIdOverride": id,
        });
        let (created, created_receipt) =
            caller.create_listing(&listing).await.map_err(|e| answer(failed(e), input.clone(), None))?;
        // A resent form finds its listing published already; publishing it again is refused.
        if created.is_active() {
            return Ok((created.id, created_receipt));
        }
        let published = caller
            .publish_listing(&created.id, created.fee_quote_fingerprint.as_deref())
            .await
            .map_err(|e| answer(failed(e), input.clone(), Some(created.id.clone())))?;
        Ok::<_, (Failed, ListInput, Option<String>)>((created.id, published.or(created_receipt)))
    }
    .await;
    match result {
        Ok((listing, receipt)) => {
            let receipt = receipt.map(|r| r.param()).unwrap_or_default();
            let state = address.with_listing(&listing);
            req.redirect(&url::Item {
                slug: &slug,
                state,
                after: crate::items::After { after_write: Some(receipt), ..Default::default() },
            })
        }
        Err((Failed::SignIn, ..)) => sign_in(&req, &slug),
        Err((Failed::Error(error), ..)) => Err(error),
        Err((Failed::Refused(message), input, draft)) => {
            refused(&req, session, &caller, item, &address, refuse(message, input, draft)).await
        }
    }
}

/// Save the ship-from setup (the action's `create-listing-stock-location`): the account's Listing
/// stock location, as one inventory attempt (the form's `SubmitKey`).
pub(crate) async fn ship_from(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemShipFrom<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let input = ShipFromInput {
        name: first(&raw, field::NAME),
        line1: first(&raw, field::LINE1),
        city: first(&raw, field::CITY),
        state: first(&raw, field::STATE),
        postal_code: first(&raw, field::POSTAL_CODE),
        country: Some(first(&raw, field::COUNTRY)).filter(|c| !c.is_empty()).unwrap_or_else(|| "US".to_owned()),
    };
    let address = Address::read(&raw).with_market(Market::Sell);
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = read_item(&caller, &slug).await?;
    let slug = item.slug.clone().unwrap_or(slug);
    match session {
        Some(Session::Unavailable) => return Err(corten::Error::status(StatusCode::BAD_GATEWAY)),
        Some(Session::Account(viewer)) if viewer.actor.can(GUEST_CHECKOUT) => {
            return Err(corten::Error::status(StatusCode::FORBIDDEN));
        }
        Some(Session::Account(_)) if listing_features(session) => {}
        Some(Session::Account(_)) => return Err(corten::Error::status(StatusCode::FORBIDDEN)),
        None => return sign_in(&req, &slug),
    }
    let refuse = |message: String, input: ShipFromInput| BuyNotice::ShipFromRefused { message, input };
    // Nothing typed is marketplace's "required" (`shipFromAddressFromForm`); the API checks the rest.
    let typed = [&input.name, &input.line1, &input.city, &input.state, &input.postal_code];
    if typed.iter().all(|v| v.is_empty()) {
        let notice = refuse(t.route_ship_from_setup_required().to_owned(), input);
        return refused(&req, session, &caller, item, &address, notice).await;
    }
    let attempt = Some(first(&raw, field::ATTEMPT))
        .filter(|a| uuid::Uuid::parse_str(a).is_ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let command = LocationCommand {
        name: STOCK_NAME.to_owned(),
        description: Some(STOCK_DESCRIPTION.to_owned()),
        ship_from_code: STOCK_CODE.to_owned(),
        ship_from_address: api::Address {
            name: input.name.clone(),
            line1: input.line1.clone(),
            city: input.city.clone(),
            state: input.state.clone(),
            postal_code: input.postal_code.clone(),
            country: input.country.clone(),
            ..api::Address::default()
        },
        is_archived: None,
    };
    match caller.create_location(&attempt, &command).await {
        Ok(written) => {
            let receipt = written.receipt.map(|r| r.param()).unwrap_or_default();
            req.redirect(&url::Item {
                slug: &slug,
                state: address,
                after: crate::items::After { after_write: Some(receipt), ..Default::default() },
            })
        }
        Err(error) => match failed(error) {
            Failed::SignIn => sign_in(&req, &slug),
            Failed::Error(error) => Err(error),
            Failed::Refused(message) => refused(&req, session, &caller, item, &address, refuse(message, input)).await,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_id_is_the_attempt_s_uuid() {
        let attempt = "0b6f3c1e-4d2a-4b8e-9f00-1234567890ab";
        assert_eq!(listing_id(attempt).as_deref(), Some("lst_0b6f3c1e4d2a4b8e9f001234567890ab"));
        assert_eq!(listing_id(attempt), listing_id(attempt));
        assert_eq!(listing_id("not a uuid"), None);
        assert_eq!(listing_id(""), None);
    }
}
