//! The item page's sell writes (marketplace's item action, bounded-contexts/discovery/support/
//! route-support/item-detail/action.ts): save the offer the rail shows to the sell list (Accept
//! offer, Add offer to Sell List), or the product chosen (Add product to Sell List), then
//! marketplace's sell list, which reads the write.
//!
//! | Button | `intent` | Sends |
//! |---|---|---|
//! | Accept offer | `sell-now` (an account with seller features) or `add-to-sell-list` | a `selected-offer` line for the offer |
//! | Add offer to Sell List | `add-to-sell-list` | the same line |
//! | Add product to Sell List | `add-product-to-sell-list` | a `product` line for the quantity |
//!
//! Each form posts the page's address, the offer or product the rail showed and the quantity.
//! The pilot reads the item again and builds the line from it: the offer from the item's own
//! offers (it must still be `submitted`), the product from the address's choices, the words from
//! the catalog's read, not the form (chase-sets/chase-sets#10592). A guest's line goes to a guest
//! sell list whose id the browser keeps in marketplace's cookie.
//!
//! The Sell List API refuses every `selected-offer` line without a listing
//! (chase-sets/chase-sets#8830); the rail shows its message, as it shows any refusal (422).
//! A sell-list add has no attempt id, so a product line sent twice adds its quantity twice
//! (chase-sets/chase-sets#9995).
use corten::{
    axum::{
        extract::{Path, State},
        http::{HeaderMap, StatusCode, header},
    },
    prelude::*,
    security::cookie,
};
use serde::Serialize;

use crate::{
    api::{ApiError, Caller, Discovery as _, Item, Offer, Selected, SellList as _, segment},
    app::{GUEST_CHECKOUT, Shared, sign_in_at, url},
    auth::Session,
    buying::{BuyNotice, quantity},
    items::{self, Address, ItemScreen, Raw},
    text::ItemMsg,
    views,
};

/// Marketplace's guest sell list cookie (`CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME`).
pub const ANONYMOUS_SELL_LIST_COOKIE: &str = "chase_sets_anonymous_sell_list";
/// How long it lasts (`THIRTY_DAYS_SECONDS`).
const GUEST_SELL_LIST_SECONDS: i64 = 30 * 24 * 60 * 60;
/// What marketplace's sell list waits for after an add (`ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF`).
const ADD_LINE_HANDOFF: &str =
    r#"{"kind":"checkout.sell-list.add-line","expectation":"collection-non-empty","surface":"account-sell-list"}"#;
/// The permission an account's offer line needs (`requireActorFromAuthApi`).
const OFFERS_MANAGE: &str = "offers.manage";

/// A sell form's own fields, for their names: the form is read as `Raw`, since it also posts the
/// page's address (`dimension.<id>` keys are data, todd-skelton/corten#71).
#[derive(Fields)]
#[allow(dead_code)]
pub struct SellFields {
    intent: String,
    offer: String,
    product: String,
    quantity: String,
}

/// The names as text.
pub mod field {
    use super::SellFields;
    pub const INTENT: &str = SellFields::FIELDS.intent.as_str();
    pub const OFFER: &str = SellFields::FIELDS.offer.as_str();
    pub const PRODUCT: &str = SellFields::FIELDS.product.as_str();
    pub const QUANTITY: &str = SellFields::FIELDS.quantity.as_str();
}

/// The rail's sell forms, each of which shows its own refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SellForm {
    /// The offer shown: Accept offer, Add offer to Sell List.
    Offer,
    /// The product chosen: Add product to Sell List.
    Product,
}

/// Which button sent a sell form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SellIntent {
    SellNow,
    AddOffer,
    AddProduct,
}

impl SellIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            SellIntent::SellNow => "sell-now",
            SellIntent::AddOffer => "add-to-sell-list",
            SellIntent::AddProduct => "add-product-to-sell-list",
        }
    }

    fn read(value: &str) -> Option<Self> {
        match value {
            "sell-now" => Some(SellIntent::SellNow),
            "add-to-sell-list" => Some(SellIntent::AddOffer),
            "add-product-to-sell-list" => Some(SellIntent::AddProduct),
            _ => None,
        }
    }

    pub fn form(self) -> SellForm {
        if self == SellIntent::AddProduct { SellForm::Product } else { SellForm::Offer }
    }
}

/// A sell-list line as an item page adds it (`AddCheckoutSellListLineRequest`): an offer's, or a
/// product's with its quantity, the catalog's words and the product's options.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SellListLine {
    /// `selected-offer` or `product`.
    pub line_type: &'static str,
    pub offer_id: Option<String>,
    pub buyer_account_id: Option<String>,
    pub buyer_display_name: Option<String>,
    pub offer_price_amount: Option<String>,
    pub catalog_item_id: String,
    pub product_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub quantity: u64,
    /// Always `none` from the item page.
    pub fallback_mode: &'static str,
    pub minimum_listing_price_amount: Option<String>,
}

/// The offer a sell form names, when the item still has it for sellers
/// (`getPublicSelectedOfferForSellList`).
fn takeable<'a>(item: &'a Item, id: &str) -> Option<&'a Offer> {
    item.offer_demand_matches.iter().find(|o| {
        !id.is_empty()
            && o.offer_id == id
            && o.catalog_catalog_item_id == item.catalog_item_id
            && o.status.as_deref() == Some("submitted")
    })
}

/// An offer's line (`selectedOfferSellListLineFromPublicOffer`).
pub fn offer_line(item: &Item, offer: &Offer) -> SellListLine {
    SellListLine {
        line_type: "selected-offer",
        offer_id: Some(offer.offer_id.clone()),
        buyer_account_id: None,
        buyer_display_name: offer.buyer_display_name.clone(),
        offer_price_amount: Some(offer.price_amount.clone()),
        catalog_item_id: item.catalog_item_id.clone(),
        product_id: offer.product_id.clone(),
        item_title: item.title.clone(),
        item_subtitle: item.subtitle.clone(),
        selected_options: offer.selected_options.clone(),
        product_summary: offer.product_summary.clone(),
        quantity: offer.quantity_requested,
        fallback_mode: "none",
        minimum_listing_price_amount: None,
    }
}

/// A product's line, from the page the form was drawn as: its options and words, as the address
/// chose them.
pub fn product_line(item: &Item, screen: &ItemScreen, product: &str, quantity: u32) -> SellListLine {
    SellListLine {
        line_type: "product",
        offer_id: None,
        buyer_account_id: None,
        buyer_display_name: None,
        offer_price_amount: None,
        catalog_item_id: item.catalog_item_id.clone(),
        product_id: product.to_owned(),
        item_title: item.title.clone(),
        item_subtitle: item.subtitle.clone(),
        selected_options: screen.product_options.clone(),
        product_summary: screen.product_summary.clone(),
        quantity: u64::from(quantity),
        fallback_mode: "none",
        minimum_listing_price_amount: None,
    }
}

/// Does the viewer use an account sell list (`canUseAccountSellList`): signed in, and not a
/// guest checkout's session?
pub fn account_sell_list(req: &Req) -> bool {
    matches!(req.context::<Session>(), Some(Session::Account(viewer)) if !viewer.actor.can(GUEST_CHECKOUT))
}

/// Does the viewer see the item as a seller (`canUseSellerFeatures`): offers and listings to
/// review, or listings to manage? Their Accept offer is `sell-now`.
pub fn seller_features(req: &Req) -> bool {
    match req.context::<Session>() {
        Some(Session::Account(viewer)) => {
            let can = |p: &str| viewer.actor.can(p);
            (can("offers.view") && can("listings.view")) || (can("listings.view") && can("listings.manage"))
        }
        _ => false,
    }
}

/// The guest sell list a request writes, by the id the browser keeps or a new one
/// (`ensureAnonymousSellListId`).
fn guest_sell_list(headers: &HeaderMap) -> String {
    cookie::get(headers, ANONYMOUS_SELL_LIST_COOKIE)
        .filter(|id| id.starts_with("anon_"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("anon_cmd_{}", uuid::Uuid::new_v4().simple()))
}

/// Marketplace's sell list after a write whose receipt is `receipt` (empty for none), with the
/// handoff it waits on.
pub fn sell_list_href(receipt: &str) -> String {
    let mut path = String::from("/account/sell-list");
    if !receipt.is_empty() {
        path.push_str(&format!("?afterWrite={}&postWriteHandoff={}", segment(receipt), segment(ADD_LINE_HANDOFF)));
    }
    views::marketplace(&path).map(|u| u.to_string()).unwrap_or(path)
}

/// The page again, saying in `form` why nothing changed.
async fn refused(
    req: &Req,
    caller: &Caller<'_>,
    item: Item,
    address: &Address,
    form: SellForm,
    typed: String,
    message: String,
) -> corten::Result {
    let notice = BuyNotice::SellRefused { message, form, quantity: typed };
    let terms = items::offer_terms(req, caller, &item, address).await;
    items::render(req, item, address, Some(&notice), StatusCode::UNPROCESSABLE_ENTITY, terms)
}

/// Accept offer, Add offer to Sell List and Add product to Sell List (the action's `sell-now`,
/// `add-to-sell-list` and `add-product-to-sell-list`).
pub(crate) async fn add(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Form(raw): Form<Raw>,
) -> corten::Result {
    let t: ItemMsg = req.t();
    let first = |key: &str| raw.get(key).and_then(|v| v.all().first()).map(|v| v.trim().to_owned()).unwrap_or_default();
    let Some(intent) = SellIntent::read(&first(field::INTENT)) else {
        return Err(corten::Error::status(StatusCode::BAD_REQUEST));
    };
    let address = Address::read(&raw);
    let typed = first(field::QUANTITY);
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = match caller.item(&slug).await {
        Ok(Some(item)) => item,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    if matches!(req.context::<Session>(), Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let account = account_sell_list(&req);
    let line = match intent {
        SellIntent::SellNow | SellIntent::AddOffer => {
            let Some(offer) = takeable(&item, &first(field::OFFER)) else {
                let message = t.route_validation_selected_offer_unavailable().to_owned();
                return refused(&req, &caller, item, &address, SellForm::Offer, typed, message).await;
            };
            let may = matches!(req.context::<Session>(), Some(Session::Account(viewer)) if viewer.actor.can(OFFERS_MANAGE));
            if account && !may {
                return Err(corten::Error::status(StatusCode::FORBIDDEN));
            }
            offer_line(&item, offer)
        }
        SellIntent::AddProduct => {
            let Some(quantity) = quantity(&typed) else {
                let message = t.route_validation_quantity_required().to_owned();
                return refused(&req, &caller, item, &address, SellForm::Product, typed, message).await;
            };
            let viewer = match req.context::<Session>() {
                Some(Session::Account(viewer)) => Some(viewer.actor.account_id.clone()),
                _ => None,
            };
            let screen = ItemScreen::of(item.clone(), &address, viewer);
            let product = first(field::PRODUCT);
            if product.is_empty() || screen.product_id.as_deref() != Some(product.as_str()) {
                let message = t.route_choose_options_to_sell_this_item().to_owned();
                return refused(&req, &caller, item, &address, SellForm::Product, typed, message).await;
            }
            product_line(&item, &screen, &product, quantity)
        }
    };
    let guest = (!account).then(|| guest_sell_list(&headers));
    let receipt = match caller.add_sell_list_line(&line, guest.as_deref()).await {
        Ok(receipt) => receipt.map(|r| r.param()).unwrap_or_default(),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => {
            return match sign_in_at(&url::Item { slug: &slug, state: Address::default() }.href()) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            };
        }
        Err(error) => return refusal(&req, &caller, item, &address, intent.form(), typed, error).await,
    };
    let to = sell_list_href(&receipt).parse::<corten::axum::http::Uri>().map_err(corten::Error::new)?;
    let mut res = req.redirect(&to)?;
    if let Some(id) = guest {
        let keep = cookie::SetCookie::new(ANONYMOUS_SELL_LIST_COOKIE, &id).max_age(GUEST_SELL_LIST_SECONDS);
        let keep = if config.proto == "https" { keep } else { keep.insecure() };
        res.headers_mut().append(header::SET_COOKIE, keep.header());
    }
    Ok(res)
}

/// A write the API refused shows its reason on the rail; anything else is the API failing.
async fn refusal(
    req: &Req,
    caller: &Caller<'_>,
    item: Item,
    address: &Address,
    form: SellForm,
    typed: String,
    error: ApiError,
) -> corten::Result {
    match error.refusal() {
        Some(message) => refused(req, caller, item, address, form, typed, message.to_owned()).await,
        None => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}
