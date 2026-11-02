//! A listing's public page (discovery's `routes/public-listing.tsx`), to anyone:
//! `/listings/{slug}`, the listing, Buy this listing, its seller and a form to report it.
//!
//! | Form | Posts to | Then |
//! |---|---|---|
//! | Buy this listing | `/listings/{slug}/buy` | a checkout session for the listing, then the checkout (a guest: checkout start's Continue) |
//! | Report listing | `/listings/{slug}/report` | the page, saying the report was received (`?reported=1`) |
//!
//! An old slug moves to the listing's own for good, with the address's query. A listing the API
//! does not have is a 404 and a failed read a 502. Where marketplace's page says nothing after a
//! report (chase-sets/chase-sets#10614) and shows its 500 page for a second one
//! (chase-sets/chase-sets#10615), the pilot says it was received, or already reported, or to try
//! again later.
//!
//! Not ported: the realtime patches to the listing, and its Product JSON-LD, which marketplace
//! writes only on the production marketplace when the listing carries a Google Shopping payload.
use corten::{
    axum::http::{HeaderMap, StatusCode, Uri, header},
    prelude::*,
    security::cookie,
};
use serde::Deserialize;
use serde_json::json;

use crate::chrome::Chrome;
use crate::{
    api::{Caller, Checkout as _, Discovery as _, ListingReport, Marketplace as _, PublicListing},
    app::{Shared, marketplace_origin, sign_in_at, url},
    auth::Session,
    buying::{guest_checkout, is_guest},
    cart_attempt,
    items::{Raw, available},
    text::{ListingMsg, Pilot},
    views::{self, ListingNotice},
};

/// Marketplace's cookie for a visitor who reports (`MARKETPLACE_ANONYMOUS_REPORT_COOKIE_NAME`).
pub const ANONYMOUS_REPORT_COOKIE: &str = "chase_sets_anonymous_reports";
/// How long the browser keeps it (thirty days, as marketplace's).
const ANONYMOUS_REPORT_SECONDS: i64 = 30 * 24 * 60 * 60;
/// The reasons a listing is reported for (`marketplaceListingReportReasons`), in the form's order.
pub const REASONS: [&str; 5] = ["counterfeit-concern", "stolen-photos", "prohibited-item", "pricing-scam", "other"];
/// The most a report's details may say (the form's `maxLength`).
pub const MOST_DETAILS: usize = 1000;

/// The page's forms' fields, for their names: Buy this listing's attempt, and the report.
#[derive(Fields)]
#[allow(dead_code)]
pub struct ListingFields {
    attempt: Option<SubmitKey>,
    reason: String,
    details: String,
}

const ATTEMPT: &str = ListingFields::FIELDS.attempt.as_str();
const REASON: &str = ListingFields::FIELDS.reason.as_str();
const DETAILS: &str = ListingFields::FIELDS.details.as_str();

/// The page's own parameter: `reported`, after a report was received.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Reported {
    pub reported: Option<String>,
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<crate::app::url::listings::PublicListing<'_>>,
) -> HtmlResult {
    let (slug, reported) = (route.slug, route.reported);
    let session = session.as_deref();
    let caller = config.platform.caller(&headers, config.proto, None);
    let listing = read(&caller, &slug).await?;
    if !listing.listing_slug.is_empty() && listing.listing_slug != slug {
        let to = url::PublicListing { slug: &listing.listing_slug, reported: Reported::default() }.href();
        let to = match uri.query() {
            Some(query) if !query.is_empty() => format!("{to}?{query}"),
            _ => to,
        };
        let to: Uri = to.parse().map_err(corten::Error::new)?;
        return req.moved(&to);
    }
    let notice = reported.reported.is_some().then_some(ListingNotice::Received);
    render(&req, session, &listing, notice.as_ref(), StatusCode::OK, chrome.cart().await)
}

/// The page, with what happened to a form it was sent from.
fn render(
    req: &Req,
    session: Option<&Session>,
    listing: &PublicListing,
    notice: Option<&ListingNotice>,
    status: StatusCode,
    cart: Option<u64>,
) -> HtmlResult {
    let t: ListingMsg = req.t();
    let p: Pilot = req.t();
    let title_name = listing.item_title.as_deref().unwrap_or(t.page_marketplace_listing());
    let title = format!("{title_name} | Marketplace");
    let price = views::listing_price(t, listing);
    let seller = listing.listing.seller_display_name.as_deref().unwrap_or(t.page_a_marketplace_seller());
    let description = format!("{price} from {seller}.");
    let canonical = format!(
        "{}{}",
        marketplace_origin(),
        url::PublicListing { slug: &listing.listing_slug, reported: Reported::default() }.href()
    );
    let (og_title, og_description) = (title.as_str(), description.as_str());
    let head = html! {
        <meta name="description" content={og_description}>
        <link rel="canonical" href={&canonical}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={og_description}>
        <meta property="og:type" content="product">
    };
    let viewer = session.and_then(Session::viewer);
    req.page_with_status(
        status,
        html! {
            <views::Layout req={req} viewer={viewer} cart={cart} title={&title} head={head}>
                <views::ListingPage t={t} p={p} listing={listing} notice={notice} />
            </views::Layout>
        },
    )
}

async fn read(caller: &Caller<'_>, slug: &str) -> Result<PublicListing, corten::Error> {
    match caller.public_listing(slug).await {
        Ok(Some(listing)) => Ok(listing),
        Ok(None) => Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The value a form sent as `name`, trimmed.
fn field<'a>(raw: &'a Raw, name: &str) -> &'a str {
    raw.get(name).and_then(|v| v.all().first()).map_or("", |v| v.trim())
}

/// Marketplace's sign-in, back to the listing: the session ended between the page and the post.
fn sign_in(req: &Req, slug: &str) -> HtmlResult {
    match sign_in_at(&url::PublicListing { slug, reported: Reported::default() }.href()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// Can the listing be bought now (`canPurchase`): its seller is not away or at capacity.
pub fn can_purchase(listing: &PublicListing) -> bool {
    listing.seller_listing_availability_status.as_deref().unwrap_or("available") == "available"
        && !listing.listing.seller_at_capacity
}

/// Buy this listing: a checkout session for it, started once per form (its `SubmitKey` is the
/// entry key), then the checkout; a guest's or a visitor's is checkout start's Continue for the
/// listing, as marketplace's form posts there (`checkoutStartHref`).
pub(crate) async fn buy(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::listings::PublicListingBuy<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ListingMsg = req.t();
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let listing = read(&caller, &slug).await?;
    let attempt = field(&raw, ATTEMPT);
    let refuse = |cart: Option<u64>, message: String| {
        render(&req, session, &listing, Some(&ListingNotice::BuyRefused(message)), StatusCode::UNPROCESSABLE_ENTITY, cart)
    };
    if attempt.is_empty() || cart_attempt::attempt_id(attempt) != attempt {
        return refuse(chrome.cart().await, p.check_attempt().to_owned());
    }
    if !can_purchase(&listing) {
        let (_, description) = views::unbuyable(t, &listing).unwrap_or_default();
        return refuse(chrome.cart().await, description);
    }
    let l = &listing.listing;
    let title = listing.item_title.as_deref().unwrap_or(t.page_marketplace_listing());
    let source = json!({
        "type": "buy-now",
        "listingId": l.listing_id,
        "catalogItemId": l.catalog_catalog_item_id,
        "productId": l.product_id,
        "itemTitle": title,
        "itemSubtitle": listing.item_subtitle,
        "selectedOptions": l.selected_options,
        "productSummary": l.product_summary,
        "quantity": 1,
        "fulfillmentMode": "locked-listing",
        "lockedListingId": l.listing_id,
    });
    if is_guest(session) {
        let quantity = t.page_available_quantity(views::grouped(available(l))).to_string();
        let availability = match views::purchase_limit(l) {
            Some(limit) => format!("{quantity} | {limit}"),
            None => quantity,
        };
        let fulfillment = views::fulfillment(t, listing.ship_from_code.as_deref());
        let entry = guest_checkout(&source, l, &availability, &fulfillment);
        return crate::checkout_start::buy_as_guest(&req, session, &config, &headers, &entry, attempt, &chrome).await;
    }
    match caller.buy_now(attempt, &source).await {
        Ok((started, receipt)) => {
            let place = crate::checkout::Place::started(receipt.as_ref());
            req.redirect(&crate::app::url::BuyCheckout { id: &started.session_id, place })
        }
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req, &slug),
            Some(StatusCode::FORBIDDEN) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
            Some(status) if status.is_client_error() => {
                refuse(chrome.cart().await, error.refusal().map_or_else(|| p.listing_buy_refused().to_owned(), str::to_owned))
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}

/// Report listing: the report, as the account signed in or as the visitor marketplace's cookie
/// names (a new one when there is none, kept thirty days), then the page saying it was received.
pub(crate) async fn report(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::listings::PublicListingReport<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let listing = read(&caller, &slug).await?;
    let (reason, details) = (field(&raw, REASON), field(&raw, DETAILS));
    let again = |cart: Option<u64>, notice: ListingNotice, status: StatusCode| {
        render(&req, session, &listing, Some(&notice), status, cart)
    };
    let refused = |message: &str| ListingNotice::ReportRefused {
        message: message.to_owned(),
        reason: reason.to_owned(),
        details: details.to_owned(),
    };
    if !REASONS.contains(&reason) {
        return again(chrome.cart().await, refused(p.listing_report_reason_required()), StatusCode::UNPROCESSABLE_ENTITY);
    }
    if details.chars().count() > MOST_DETAILS {
        return again(chrome.cart().await, refused(p.listing_report_details_too_long()), StatusCode::UNPROCESSABLE_ENTITY);
    }
    let kept = cookie::get(&headers, ANONYMOUS_REPORT_COOKIE).filter(|id| id.starts_with("anon_")).map(str::to_owned);
    let anonymous = kept.clone().unwrap_or_else(|| format!("anon_cmd_{}", uuid::Uuid::new_v4().simple()));
    let path = format!("/listings/{slug}");
    let body = ListingReport { reason, details: (!details.is_empty()).then_some(details), source_route_path: &path };
    match caller.report_listing(&listing.listing.listing_id, &anonymous, &body).await {
        Ok(()) => {
            let to = url::PublicListing { slug: &slug, reported: Reported { reported: Some("1".to_owned()) } };
            let mut res = req.redirect(&to)?;
            if kept.is_none() {
                let keep = cookie::SetCookie::new(ANONYMOUS_REPORT_COOKIE, &anonymous).max_age(ANONYMOUS_REPORT_SECONDS);
                let keep = if config.proto == "https" { keep } else { keep.insecure() };
                res.headers_mut().append(header::SET_COOKIE, keep.header());
            }
            Ok(res)
        }
        Err(error) => match (error.status(), error.code()) {
            (_, Some("report_already_submitted")) => again(chrome.cart().await, ListingNotice::Repeat, StatusCode::CONFLICT),
            (Some(StatusCode::TOO_MANY_REQUESTS), _) => {
                again(chrome.cart().await, ListingNotice::Limited, StatusCode::TOO_MANY_REQUESTS)
            }
            (Some(StatusCode::UNAUTHORIZED), _) => sign_in(&req, &slug),
            (Some(status), _) if status.is_client_error() => {
                let message = error.refusal().map_or_else(|| p.listing_report_refused().to_owned(), str::to_owned);
                again(chrome.cart().await, refused(&message), StatusCode::UNPROCESSABLE_ENTITY)
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}
