//! An account's public page (discovery's `routes/public-account.tsx`), to anyone:
//! `/accounts/{slug}`, the account's standing, its feedback as a seller and as a buyer, a page of
//! its reviews (by role), and its active listings. Report review is the one form, and only an
//! account may send it.
//!
//! | Form | Posts to | Then |
//! |---|---|---|
//! | Report review | `/accounts/{slug}/reviews/{id}/report` | the page at the review, saying the report was received (`?reported={id}#review-{id}`) |
//!
//! An old slug or the account's id moves to its slug for good, with the address's query, as
//! marketplace's loader does. An account the API does not have is a 404 and a failed read a 502;
//! marketplace answers both with a 200 that says the account was not found
//! (chase-sets/chase-sets#10619). A suspended or closed account shows only that it is
//! unavailable, and asks not to be indexed. The seller's chips are best-effort: a failed read
//! shows none.
//!
//! Not ported: the realtime patches to the account's listings and counts.
use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use serde::Deserialize;

use crate::chrome::Chrome;
use crate::{
    api::{Caller, Discovery as _, ListingReport, Marketplace as _, MetricsChips, PublicAccount},
    app::{Shared, marketplace_origin, sign_in_at, url},
    auth::Session,
    items::Raw,
    text::{AccountMsg, Pilot},
    views,
};

/// Reviews a page shows (`ACCOUNT_REVIEW_PAGE_SIZE`).
pub const REVIEWS_PER_PAGE: u64 = 10;
/// The reasons a review is reported for (`reviewReportReasons`), in the form's order.
pub const REASONS: [&str; 5] =
    ["harassment-or-abuse", "hate-or-discrimination", "personal-information", "spam-or-manipulation", "other"];
/// The most a report's explanation may say (the form's `maxLength`).
pub const MOST_DETAILS: usize = 1000;

/// The address's parameters: the reviews' role and page, and the review a report was just
/// received for.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct AccountQuery {
    pub role: Option<String>,
    pub page: Option<String>,
    pub reported: Option<String>,
}

/// Report review's fields, for their names.
#[derive(Fields)]
#[allow(dead_code)]
pub struct ReviewReportFields {
    reason: String,
    details: String,
}

/// Whose reviews the page shows: the account's as a seller, as a buyer, or both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Seller,
    Buyer,
}

impl Role {
    pub fn read(text: Option<&str>) -> Option<Self> {
        match text {
            Some("seller") => Some(Role::Seller),
            Some("buyer") => Some(Role::Buyer),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Seller => "seller",
            Role::Buyer => "buyer",
        }
    }
}

/// What happened to a review's report form.
#[derive(Clone, Debug)]
pub enum ReviewNotice {
    /// The report was received.
    Submitted,
    /// The account had reported the review already.
    Already,
    /// The report was refused, with what was sent.
    Refused { message: String, reason: String, details: String },
}

/// What the page shows.
pub struct AccountScreen {
    pub account: PublicAccount,
    pub chips: Option<MetricsChips>,
    pub role: Option<Role>,
    /// The reviews' page, from 1.
    pub page: u64,
    /// The review a form was sent from, and what happened to it.
    pub notice: Option<(String, ReviewNotice)>,
}

impl AccountScreen {
    pub fn pages(&self) -> u64 {
        self.account.reviews.total.div_ceil(REVIEWS_PER_PAGE).max(1)
    }

    /// The page's address with `role` and `page`, at the feedback.
    pub fn feedback_href(&self, role: Option<Role>, page: u64) -> String {
        let query = AccountQuery {
            role: role.map(|r| r.as_str().to_owned()),
            page: (page > 1).then(|| page.to_string()),
            reported: None,
        };
        url::Account { slug: &self.account.account_slug, query }.at(views::FeedbackId).href()
    }

    /// Where Report review for `review` posts, with the role and page the page shows.
    pub fn report_href(&self, review: &str) -> String {
        url::AccountReviewReport { slug: &self.account.account_slug, review, query: self.query(None) }.href()
    }

    fn query(&self, reported: Option<&str>) -> AccountQuery {
        AccountQuery {
            role: self.role.map(|r| r.as_str().to_owned()),
            page: (self.page > 1).then(|| self.page.to_string()),
            reported: reported.map(str::to_owned),
        }
    }
}

/// An account's page at its feedback, for the item and listing pages' seller links.
pub fn feedback(slug: &str) -> String {
    url::Account { slug, query: AccountQuery::default() }.at(views::FeedbackId).href()
}

/// The reviews' page the address asks for (`reviewPageFromRequest`): a whole number from 1.
fn page_number(text: Option<&str>) -> u64 {
    text.and_then(|p| p.trim().parse::<f64>().ok()).filter(|p| p.is_finite() && *p > 0.0).map_or(1, |p| p.floor() as u64).max(1)
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<crate::app::url::accounts::Account<'_>>,
) -> HtmlResult {
    let (slug, query) = (route.slug, route.query);
    let session = session.as_deref();
    let caller = config.platform.caller(&headers, config.proto, None);
    let role = Role::read(query.role.as_deref());
    let page = page_number(query.page.as_deref());
    let account = read(&caller, &slug, role, page).await?;
    if !account.account_slug.is_empty() && account.account_slug != slug {
        let to = url::Account { slug: &account.account_slug, query: AccountQuery::default() }.href();
        let to = match uri.query() {
            Some(query) if !query.is_empty() => format!("{to}?{query}"),
            _ => to,
        };
        let to: Uri = to.parse().map_err(corten::Error::new)?;
        return req.moved(&to);
    }
    let notice = query.reported.filter(|id| !id.is_empty()).map(|id| (id, ReviewNotice::Submitted));
    let chips = chips(&caller, &account).await;
    let screen = AccountScreen { account, chips, role, page, notice };
    render(&req, session, &screen, StatusCode::OK, chrome.cart().await)
}

/// The account with the page of reviews asked for; a 404 when there is none, a 502 when the read
/// failed.
async fn read(caller: &Caller<'_>, slug: &str, role: Option<Role>, page: u64) -> Result<PublicAccount, corten::Error> {
    let mut query = format!("limit={REVIEWS_PER_PAGE}&offset={}", (page - 1) * REVIEWS_PER_PAGE);
    if let Some(role) = role {
        query.push_str(&format!("&role={}", role.as_str()));
    }
    match caller.public_account(slug, &query).await {
        Ok(Some(account)) => Ok(account),
        Ok(None) => Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The seller's chips, best-effort (`fetchSellerBehavioralMetricsChips`): none for an account
/// that is not active, or when the read fails.
async fn chips(caller: &Caller<'_>, account: &PublicAccount) -> Option<MetricsChips> {
    if account.status != "active" {
        return None;
    }
    match caller.metrics_chips(&account.account_id).await {
        Ok(chips) => Some(chips),
        Err(error) => {
            tracing::warn!("the seller's chips' read failed: {error}");
            None
        }
    }
}

/// The page, with what happened to a form it was sent from.
fn render(req: &Req, session: Option<&Session>, screen: &AccountScreen, status: StatusCode, cart: Option<u64>) -> HtmlResult {
    let t: AccountMsg = req.t();
    let p: Pilot = req.t();
    let account = &screen.account;
    let name = account.account_display_name.as_deref().unwrap_or(t.page_account());
    let title = t.page_account_meta_title(name).to_string();
    let description = t.page_browse_active_listings(account.active_listing_count).to_string();
    let canonical = format!(
        "{}{}",
        marketplace_origin(),
        url::Account { slug: &account.account_slug, query: AccountQuery::default() }.href()
    );
    let active = account.status == "active";
    let (og_title, og_description) = (title.as_str(), description.as_str());
    let head = html! {
        <meta name="description" content={og_description}>
        <link rel="canonical" href={&canonical}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={og_description}>
        <meta property="og:type" content="website">
        if !active {
            <meta name="robots" content="noindex">
        }
    };
    let viewer = session.and_then(Session::viewer);
    req.page_with_status(
        status,
        html! {
            <views::Layout req={req} viewer={viewer} cart={cart} title={&title} head={head}>
                <views::AccountPage t={t} p={p} screen={screen} />
            </views::Layout>
        },
    )
}

/// The value a form sent as `name`, trimmed.
fn field<'a>(raw: &'a Raw, name: &str) -> &'a str {
    raw.get(name).and_then(|v| v.all().first()).map_or("", |v| v.trim())
}

/// Report review: as the account signed in (a visitor goes to sign in, as the API answers 401),
/// then the page at the review, saying it was received. A second report says it was sent already;
/// a refusal draws the review's dialog open again with what was sent.
pub(crate) async fn report_review(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::accounts::AccountReviewReport<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let (slug, review, query) = (route.slug, route.review, route.query);
    let session = session.as_deref();
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let role = Role::read(query.role.as_deref());
    let page = page_number(query.page.as_deref());
    let account = read(&caller, &slug, role, page).await?;
    let f = ReviewReportFields::FIELDS;
    let (reason, details) = (field(&raw, f.reason.as_str()), field(&raw, f.details.as_str()));
    let refused = |message: &str| ReviewNotice::Refused {
        message: message.to_owned(),
        reason: reason.to_owned(),
        details: details.to_owned(),
    };
    let mut screen = AccountScreen { account, chips: None, role, page, notice: None };
    let again = |cart: Option<u64>, mut screen: AccountScreen, notice: ReviewNotice, status: StatusCode| {
        screen.notice = Some((review.clone(), notice));
        render(&req, session, &screen, status, cart)
    };
    if !REASONS.contains(&reason) {
        screen.chips = chips(&caller, &screen.account).await;
        return again(chrome.cart().await, screen, refused(p.account_report_reason_required()), StatusCode::UNPROCESSABLE_ENTITY);
    }
    if details.encode_utf16().count() > MOST_DETAILS {
        screen.chips = chips(&caller, &screen.account).await;
        return again(
            chrome.cart().await,
            screen,
            refused(p.account_report_details_too_long()),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
    }
    let path = format!("/accounts/{}", screen.account.account_slug);
    let body = ListingReport { reason, details: (!details.is_empty()).then_some(details), source_route_path: &path };
    let result = caller.report_review(&review, &body).await;
    match result {
        Ok(()) => {
            let to = url::Account { slug: &screen.account.account_slug, query: screen.query(Some(&review)) };
            req.redirect(&to.at(views::ReviewId(&review)))
        }
        Err(error) => {
            screen.chips = chips(&caller, &screen.account).await;
            match (error.status(), error.code()) {
                (_, Some("report_already_submitted")) => {
                    again(chrome.cart().await, screen, ReviewNotice::Already, StatusCode::CONFLICT)
                }
                (Some(StatusCode::UNAUTHORIZED), _) => sign_in(&req, &screen.account.account_slug),
                (Some(StatusCode::TOO_MANY_REQUESTS), _) => {
                    again(chrome.cart().await, screen, refused(p.account_report_limited()), StatusCode::TOO_MANY_REQUESTS)
                }
                (Some(status), _) if status.is_client_error() => {
                    let message = error.refusal().map_or_else(|| p.account_report_refused().to_owned(), str::to_owned);
                    again(chrome.cart().await, screen, refused(&message), StatusCode::UNPROCESSABLE_ENTITY)
                }
                _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            }
        }
    }
}

/// Marketplace's sign-in, back to the account's page: Report review needs an account.
fn sign_in(req: &Req, slug: &str) -> HtmlResult {
    match sign_in_at(&url::Account { slug, query: AccountQuery::default() }.href()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

#[cfg(test)]
mod tests {
    use super::page_number;

    #[test]
    fn a_reviews_page_is_a_whole_number_from_one() {
        assert_eq!([None, Some("2"), Some("2.7"), Some("0"), Some("-3"), Some("x")].map(page_number), [1, 2, 2, 1, 1, 1]);
    }
}
