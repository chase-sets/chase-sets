//! The account's reviews (Reputation's marketplace `account-review-summary`,
//! `account-received-reviews` and `account-written-reviews` routes): its ratings as a seller and
//! as a buyer with its ten newest revealed reviews, the reviews others left it, and the reviews it
//! left, each list by role. Report review is each page's one form: a review that is active,
//! revealed and not held may be reported, and the report posts to the page it is on, as
//! marketplace's form action does.
//!
//! A sent report redirects to the page at the review, saying it was received (`?reported={id}`),
//! where marketplace draws the page again from its action. A refused one is the page again with
//! the dialog open and what was sent; a second report of the same review says it was sent before.
//! Open review goes to the review's own page (`review`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/reviews` | the summary |
//! | `GET /account/reviews/received?<place>`, `.../written?<place>` | a list, by `role` |
//! | `POST` any of them | Report review |
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::{Deserialize, Serialize};

use crate::{
    accounts::{MOST_DETAILS, REASONS, ReviewNotice, Role},
    api::{ApiError, Caller as ApiCaller, ListingReport, Marketplace as _, ReviewCalls as _, ReviewItem, ReviewSummary},
    app::{Shared, read_failed, sign_in, url},
    auth::{ReviewMember, Viewer},
    text::{Pilot, ReviewsMsg},
    views::{self, Layout, ReviewAnchorId},
};

/// Which of the three pages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Summary,
    Received,
    Written,
}

impl Which {
    /// The page's path, which a report names as where it was sent from.
    pub fn path(self) -> &'static str {
        match self {
            Which::Summary => "/account/reviews",
            Which::Received => "/account/reviews/received",
            Which::Written => "/account/reviews/written",
        }
    }
}

/// What the address carries: the lists' role, and the review a report was just received for.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub role: Option<String>,
    pub reported: Option<String>,
}

/// Report review's fields: what the form is for (the review's own page also posts its reply), the
/// review (marketplace's `reviewId`), the reason and the explanation; and the reply's words.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ReportInput {
    pub intent: String,
    pub review_id: String,
    pub reason: String,
    pub details: String,
    pub feedback: String,
}

/// A page: which one, its role, the ratings (the summary's), the reviews, and the review a report
/// form was sent from with what happened to it.
#[derive(Serialize, ToJson)]
pub struct ReviewsScreen {
    #[serde(skip)]
    pub which: Which,
    #[serde(skip)]
    pub role: Option<Role>,
    pub summary: Option<ReviewSummary>,
    pub reviews: Vec<ReviewItem>,
    #[serde(skip)]
    pub notice: Option<(String, ReviewNotice)>,
}

impl ReviewsScreen {
    /// The page's address with `role` (the lists'), saying `reported` was received.
    pub fn href(&self, role: Option<Role>, reported: Option<&str>) -> String {
        let place = Place { role: role.map(|r| r.as_str().to_owned()), reported: reported.map(str::to_owned) };
        match self.which {
            Which::Summary => url::Reviews { place: Place { role: None, ..place } }.href(),
            Which::Received => url::ReceivedReviews { place }.href(),
            Which::Written => url::WrittenReviews { place }.href(),
        }
    }

    /// The notice for `review`'s report form, if it was the one sent.
    pub fn notice(&self, review: &str) -> Option<&ReviewNotice> {
        self.notice.as_ref().filter(|(id, _)| id == review).map(|(_, notice)| notice)
    }
}

pub(crate) async fn summary(
    req: Req,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::Reviews>,
) -> HtmlResult {
    let place = route.place;
    show(&req, &viewer, &config, &headers, Which::Summary, place).await
}

pub(crate) async fn received(
    req: Req,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::ReceivedReviews>,
) -> HtmlResult {
    let place = route.place;
    show(&req, &viewer, &config, &headers, Which::Received, place).await
}

pub(crate) async fn written(
    req: Req,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::WrittenReviews>,
) -> HtmlResult {
    let place = route.place;
    show(&req, &viewer, &config, &headers, Which::Written, place).await
}

/// The lists' role: none on the summary, else the address's `seller` or `buyer`.
fn role(which: Which, place: &Place) -> Option<Role> {
    if which == Which::Summary { None } else { Role::read(place.role.as_deref()) }
}

async fn show(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, which: Which, place: Place) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    match read(&caller, viewer, which, role(which, &place)).await {
        Ok(mut screen) => {
            screen.notice = place.reported.map(|review| (review, ReviewNotice::Submitted));
            render(req, viewer, &screen, StatusCode::OK)
        }
        Err(error) => read_failed(req, Some(viewer), error, None),
    }
}

/// A page's reads: the summary's ratings and newest reviews side by side, or a list.
async fn read(caller: &ApiCaller<'_>, viewer: &Viewer, which: Which, role: Option<Role>) -> Result<ReviewsScreen, ApiError> {
    let account = viewer.actor.account_id.as_str();
    let (summary, reviews) = match which {
        Which::Summary => {
            let (summary, reviews) = tokio::join!(caller.review_summary(account), caller.account_reviews(account));
            (Some(summary?), reviews?)
        }
        Which::Received => (None, caller.review_list("received", role.map(Role::as_str)).await?),
        Which::Written => (None, caller.review_list("written", role.map(Role::as_str)).await?),
    };
    Ok(ReviewsScreen { which, role, summary, reviews, notice: None })
}

fn render(req: &Req, viewer: &Viewer, screen: &ReviewsScreen, status: StatusCode) -> HtmlResult {
    let t: ReviewsMsg = req.t();
    let title = match screen.which {
        Which::Summary => t.route_summary_reviews_marketplace(),
        Which::Received => t.route_received_received_reviews_marketplace(),
        Which::Written => t.route_written_written_reviews_marketplace(),
    };
    let view = html! { <views::ReviewsPage t={t} p={req.t()} screen={screen} /> };
    let page = html! { <Layout req={req} viewer={Some(viewer)} title={title} head={()}>{view}</Layout> };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn report_on_summary(
    req: Req,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::Reviews>,
    Form(input): Form<ReportInput>,
) -> HtmlResult {
    let place = route.place;
    report(&req, &viewer, &config, &headers, Which::Summary, place, input).await
}

pub(crate) async fn report_on_received(
    req: Req,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::ReceivedReviews>,
    Form(input): Form<ReportInput>,
) -> HtmlResult {
    let place = route.place;
    report(&req, &viewer, &config, &headers, Which::Received, place, input).await
}

pub(crate) async fn report_on_written(
    req: Req,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::WrittenReviews>,
    Form(input): Form<ReportInput>,
) -> HtmlResult {
    let place = route.place;
    report(&req, &viewer, &config, &headers, Which::Written, place, input).await
}

/// Report review from a list or the summary (`send_report`): a sent report goes back to the review
/// on the page, a refused one draws the page again.
#[allow(clippy::too_many_arguments)]
async fn report(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    which: Which,
    place: Place,
    input: ReportInput,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let role = role(which, &place);
    let review = input.review_id.trim().to_owned();
    match send_report(req.t(), &caller, &review, &input, which.path()).await {
        Reported::Sent => {
            let place = Place { role: role.map(|r| r.as_str().to_owned()), reported: Some(review.clone()) };
            let anchor = ReviewAnchorId(&review);
            match which {
                Which::Summary => req.redirect(&url::Reviews { place: Place { role: None, ..place } }.at(anchor)),
                Which::Received => req.redirect(&url::ReceivedReviews { place }.at(anchor)),
                Which::Written => req.redirect(&url::WrittenReviews { place }.at(anchor)),
            }
        }
        Reported::Again(notice, status) => match read(&caller, viewer, which, role).await {
            Ok(mut screen) => {
                screen.notice = Some((review, notice));
                render(req, viewer, &screen, status)
            }
            Err(error) => read_failed(req, Some(viewer), error, None),
        },
        Reported::SignIn => sign_in(req),
        Reported::Failed(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// What came of a report: sent, refused (the page again with that notice and status), the session
/// gone, or the API failing.
pub(crate) enum Reported {
    Sent,
    Again(ReviewNotice, StatusCode),
    SignIn,
    Failed(ApiError),
}

/// Report review's checks and its send, from the page at `from`: the reason must be one of the
/// form's, the explanation at most 1,000 characters (as the form's `maxLength` counts them), and the
/// API decides the rest. A refusal keeps what was sent.
pub(crate) async fn send_report(p: Pilot, caller: &ApiCaller<'_>, review: &str, input: &ReportInput, from: &str) -> Reported {
    let (reason, details) = (input.reason.trim(), input.details.trim());
    let refused = |message: &str| ReviewNotice::Refused {
        message: message.to_owned(),
        reason: reason.to_owned(),
        details: details.to_owned(),
    };
    if review.is_empty() || !REASONS.contains(&reason) {
        return Reported::Again(refused(p.account_report_reason_required()), StatusCode::UNPROCESSABLE_ENTITY);
    }
    if details.encode_utf16().count() > MOST_DETAILS {
        return Reported::Again(refused(p.account_report_details_too_long()), StatusCode::UNPROCESSABLE_ENTITY);
    }
    let body = ListingReport { reason, details: (!details.is_empty()).then_some(details), source_route_path: from };
    match caller.report_review(review, &body).await {
        Ok(()) => Reported::Sent,
        Err(error) => match (error.status(), error.code()) {
            (_, Some("report_already_submitted")) => Reported::Again(ReviewNotice::Already, StatusCode::CONFLICT),
            (Some(StatusCode::UNAUTHORIZED), _) => Reported::SignIn,
            (Some(StatusCode::TOO_MANY_REQUESTS), _) => {
                Reported::Again(refused(p.account_report_limited()), StatusCode::TOO_MANY_REQUESTS)
            }
            (Some(status), _) if status.is_client_error() => {
                let message = error.refusal().map_or_else(|| p.account_report_refused().to_owned(), str::to_owned);
                Reported::Again(refused(&message), StatusCode::UNPROCESSABLE_ENTITY)
            }
            _ => Reported::Failed(error),
        },
    }
}
