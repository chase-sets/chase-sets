//! The item page's Watch forms (marketplace's item action, `create-product-alert` in
//! bounded-contexts/discovery/support/route-support/item-detail/action.ts): a Watch alert for the
//! product chosen, on its listings (at or below a price) or its offers (at or above one).
//!
//! | Form | `side` | Threshold |
//! |---|---|---|
//! | Watch listings | `listing` | the maximum listing price |
//! | Watch offers | `offer` | the minimum offer price |
//!
//! Each form posts the page's address, the product it showed, the side, and an optional price
//! and currency. The pilot reads the item again and takes the product's options and summary from
//! the page the form was drawn as, not the form (the API checks nothing against the catalog,
//! chase-sets/chase-sets#10595). An account's alert is created and the page comes back on its Watch
//! tab, saying so (marketplace says nothing, chase-sets/chase-sets#10597). A guest's alert is saved
//! as an intent, its owner in marketplace's own cookie, and the guest goes to marketplace's
//! registration, whose return claims it on marketplace's item page.
//!
//! A create has no attempt id, so the same create sent twice is two alerts
//! (chase-sets/chase-sets#10596).
use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode, Uri, header},
    },
    prelude::*,
    security::cookie,
};
use serde::Serialize;

use crate::{
    api::{ApiError, Discovery as _, Item, ProductAlerts as _, Selected, segment},
    app::{Shared, sign_in_at, url},
    auth::Session,
    buying::BuyNotice,
    items::{self, Address, ItemScreen, Market, Raw},
    text::ItemMsg,
    views,
};

/// Marketplace's anonymous alert cookie (`DISCOVERY_ANONYMOUS_PRODUCT_ALERT_COOKIE_NAME`).
pub const ANONYMOUS_PRODUCT_ALERT_COOKIE: &str = "chase_sets_anonymous_product_alerts";
/// How long it lasts (`THIRTY_DAYS_SECONDS`).
const GUEST_ALERT_SECONDS: i64 = 30 * 24 * 60 * 60;
/// The item page's parameter after Set alert: the write's receipt.
pub const WATCHED: &str = "watched";
/// The permission an account's alert needs (`requireActorFromAuthApi`, `accounts.view`).
const ACCOUNTS_VIEW: &str = "accounts.view";

/// A Watch form's own fields, for their names (the form is read as `Raw`, since it also posts
/// the page's address).
#[derive(Fields)]
#[allow(dead_code)]
pub struct WatchFields {
    side: String,
    product: String,
    threshold: String,
    currency: String,
}

/// The names as text.
pub mod field {
    use super::WatchFields;
    pub const SIDE: &str = WatchFields::FIELDS.side.as_str();
    pub const PRODUCT: &str = WatchFields::FIELDS.product.as_str();
    pub const THRESHOLD: &str = WatchFields::FIELDS.threshold.as_str();
    pub const CURRENCY: &str = WatchFields::FIELDS.currency.as_str();
}

/// Which side of the market an alert watches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Listings at or below the price.
    Listing,
    /// Offers at or above it.
    Offer,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Listing => "listing",
            Side::Offer => "offer",
        }
    }

    /// As marketplace reads it: `offer`, else listings.
    fn read(value: &str) -> Self {
        if value == "offer" { Side::Offer } else { Side::Listing }
    }
}

/// What a refused Watch form had typed, so it is drawn again with it.
#[derive(Clone, Debug)]
pub struct WatchInput {
    pub side: Side,
    pub threshold: String,
    pub currency: String,
}

/// An alert as the item page creates one (`CreateProductAlertRequest`), with `sourcePath` for a
/// guest's intent.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertRequest {
    pub market_side: &'static str,
    pub catalog_item_id: String,
    pub product_id: String,
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub threshold_amount: Option<String>,
    pub threshold_currency_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

/// A threshold as marketplace takes one (`normalizeMoneyAmount` with `allowZero` and
/// `optional`): none when empty, else digits with at most two after the point, written with two.
pub fn threshold(text: &str) -> Option<Option<String>> {
    let text = text.trim();
    if text.is_empty() {
        return Some(None);
    }
    let (whole, cents) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(cents) || cents.len() > 2 || (text.contains('.') && cents.is_empty()) {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    Some(Some(format!("{}.{cents:0<2}", if whole.is_empty() { "0" } else { whole })))
}

/// A currency code: three letters, upper case (the API's check, made here so the form says so).
fn currency(text: &str) -> Option<String> {
    let code = text.trim().to_ascii_uppercase();
    (code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())).then_some(code)
}

/// The alerts' settings (the pilot's notification center, section `product-alerts`), read after
/// the write whose receipt is `receipt` (empty for none), at the alerts.
pub fn alerts_href(receipt: &str) -> String {
    let place = crate::notifications::Place {
        view: Some("settings".into()),
        section: Some(crate::notifications::ALERTS.into()),
        after_write: (!receipt.is_empty()).then(|| receipt.to_owned()),
    };
    url::Notifications { place }.at(views::ProductAlertsId).href()
}

/// Marketplace's registration, back to the item's Watch tab with the intent to claim
/// (`buildRegisterToClaimProductAlertHref`). Marketplace's: the claim is its item page's, which
/// the pilot's does not make.
fn register_href(slug: &str, intent: &str) -> String {
    let back = format!("/items/{}?market=watch&claimProductAlertIntent={}", segment(slug), segment(intent));
    let path = format!("/register?returnTo={}", segment(&back));
    views::marketplace(&path).map(|u| u.to_string()).unwrap_or(path)
}

/// The guest alert owner a request writes as, by the id the browser keeps or a new one
/// (`ensureAnonymousProductAlertOwnerId`).
fn guest_owner(headers: &HeaderMap) -> String {
    cookie::get(headers, ANONYMOUS_PRODUCT_ALERT_COOKIE)
        .filter(|id| id.starts_with("anon_"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("anon_cmd_{}", uuid::Uuid::new_v4().simple()))
}

/// The page again on its Watch tab, saying in the form that sent it why nothing was saved.
fn refused(
    req: &Req,
    session: Option<&Session>,
    item: Item,
    address: &Address,
    input: WatchInput,
    message: String,
    status: StatusCode,
) -> HtmlResult {
    let notice = BuyNotice::WatchRefused { message, input };
    let address = address.with_market(Market::Watch);
    items::render(req, session, item, &address, Some(&notice), status, Default::default())
}

/// Watch listings and Watch offers (the action's `create-product-alert`).
pub(crate) async fn watch(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemWatch<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let first = |key: &str| raw.get(key).and_then(|v| v.all().first()).map(|v| v.trim().to_owned()).unwrap_or_default();
    let input = WatchInput {
        side: Side::read(&first(field::SIDE)),
        threshold: first(field::THRESHOLD),
        currency: first(field::CURRENCY),
    };
    let address = Address::read(&raw).with_market(Market::Watch);
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = match caller.item(&slug).await {
        Ok(Some(item)) => item,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let viewer = match session {
        Some(Session::Account(viewer)) => Some(viewer),
        _ => None,
    };
    let screen = ItemScreen::of(item.clone(), &address, viewer.map(|v| v.actor.account_id.clone()));
    let product = first(field::PRODUCT);
    if product.is_empty() || screen.product_id.as_deref() != Some(product.as_str()) {
        let message = t.route_product_intent_choose_options_guidance().to_owned();
        return refused(&req, session, item, &address, input, message, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let Some(amount) = threshold(&input.threshold) else {
        let message = t.route_validation_threshold_invalid().to_owned();
        return refused(&req, session, item, &address, input, message, StatusCode::UNPROCESSABLE_ENTITY);
    };
    // A price needs its currency; without a price the alert has no threshold, whatever the
    // currency field says (the API refuses one without the other).
    let code = match &amount {
        None => None,
        Some(_) => match currency(&input.currency) {
            Some(code) => Some(code),
            None => {
                let message = t.route_validation_threshold_invalid().to_owned();
                return refused(&req, session, item, &address, input, message, StatusCode::UNPROCESSABLE_ENTITY);
            }
        },
    };
    let back = format!("/items/{}?market=watch", item.slug.as_deref().unwrap_or(&item.catalog_item_id));
    let mut alert = AlertRequest {
        market_side: input.side.as_str(),
        catalog_item_id: item.catalog_item_id.clone(),
        product_id: product.clone(),
        selected_options: screen.product_options.clone(),
        product_summary: screen.product_summary.clone(),
        threshold_amount: amount,
        threshold_currency_code: code,
        source_path: None,
    };
    let Some(viewer) = viewer else {
        // No one signed in: the intent, then marketplace's registration, which claims it on the
        // way back. (A guest checkout's session is an account without accounts.view, refused below
        // as marketplace refuses it.)
        alert.source_path = Some(back);
        let owner = guest_owner(&headers);
        let intent = match caller.product_alert_intent(&owner, &alert).await {
            Ok(intent) => intent,
            Err(error) => return refusal(&req, session, item, &address, input, error),
        };
        let to: Uri = register_href(&slug, &intent.intent_id).parse().map_err(corten::Error::new)?;
        let mut res = req.redirect(&to)?;
        let keep = cookie::SetCookie::new(ANONYMOUS_PRODUCT_ALERT_COOKIE, &owner).max_age(GUEST_ALERT_SECONDS);
        let keep = if config.proto == "https" { keep } else { keep.insecure() };
        res.headers_mut().append(header::SET_COOKIE, keep.header());
        return Ok(res);
    };
    if !viewer.actor.can(ACCOUNTS_VIEW) {
        let message = t.route_account_cannot_create_product_alerts().to_owned();
        return refused(&req, session, item, &address, input, message, StatusCode::FORBIDDEN);
    }
    match caller.create_product_alert(&alert).await {
        Ok(receipt) => {
            let receipt = receipt.map(|r| r.param()).unwrap_or_default();
            req.redirect(&url::Item {
                slug: &slug,
                state: address,
                after: crate::items::After { watched: Some(receipt), ..Default::default() },
            })
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => match sign_in_at(&back) {
            Some(to) => req.redirect(&to),
            None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
        },
        Err(error) => refusal(&req, session, item, &address, input, error),
    }
}

/// A write the API refused shows its reason in the form; anything else is the API failing.
fn refusal(
    req: &Req,
    session: Option<&Session>,
    item: Item,
    address: &Address,
    input: WatchInput,
    error: ApiError,
) -> HtmlResult {
    match error.refusal() {
        Some(message) => refused(req, session, item, address, input, message.to_owned(), StatusCode::UNPROCESSABLE_ENTITY),
        None => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_threshold_is_optional_may_be_zero_and_has_two_decimals() {
        assert_eq!(threshold(""), Some(None));
        assert_eq!(threshold("0"), Some(Some("0.00".into())));
        assert_eq!(threshold("012.5"), Some(Some("12.50".into())));
        assert_eq!(threshold("300.00"), Some(Some("300.00".into())));
        assert_eq!(threshold("1.234"), None);
        assert_eq!(threshold("-1"), None);
        assert_eq!(threshold("1."), None);
        assert_eq!(currency(" usd "), Some("USD".into()));
        assert_eq!(currency("US"), None);
    }
}
