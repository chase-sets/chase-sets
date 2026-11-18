//! An order's review form (Reputation's marketplace `account-purchase-review` and
//! `account-sale-review` routes, their `review-submission-route` and `ReviewSubmissionPage`):
//! the order it is for, the rating and the words, and for a buyer what went wrong with the order.
//!
//! The page reads the order's review opportunity: one already written is that review's page, no
//! such order is a 404, a review held while support looks at the order says so with Track order
//! issue, and a closed window says so. The form posts to the page. Marketplace asks a buyer who
//! rates two stars or less, or ticks a problem, to resolve the order first before it submits; its
//! script stops the form to ask. The pilot asks with the page: such a submit draws the form again
//! with Resolve this order first? open (Open an order issue, the support page with the order and
//! the problem's flow; or Continue with feedback only, once it is acknowledged; or Go back), so it
//! works without a script. Problem with this order? opens it for anyone. What the API refuses is
//! the form again with what was typed, the closed authoring codes saying how to fix it. A sent
//! review goes to its page, read after the write.
//!
//! The review is sent as its form's attempt (`marketplace_attempt`). One whose answer was lost is
//! looked up by its attempt: committed is the review's page, not observed keeps the form to send
//! again, and one that cannot be confirmed, or whose attempt was another review's, keeps what was
//! typed without Submit until the page is opened again (where a review written is its page).
//!
//! With JavaScript, following Open an order issue keeps the form in the tab's session storage and
//! the form takes it back the next time it opens, as marketplace's does, and the resolution
//! funnel's events go to window listeners and `dataLayer` (`views/order_review_draft.js`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/purchases/{id}/review?resolution=` | the form, for the buyer (`intake-unavailable`: an issue cannot be opened) |
//! | `GET /account/sales/{id}/review` | the form, for the seller |
//! | `POST` either | submit (`intent` empty or `feedback-only`), `resolve` (ask first) or `edit` (Go back) |
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    api::{ApiError, Caller as ApiCaller, ReviewCalls as _, ReviewOpportunity},
    app::{Shared, read_failed, sign_in, url},
    auth::{Reviewer, Viewer},
    marketplace_attempt::{self, Locked, Observed},
    recovery::attempt_text,
    review::ReviewPlace,
    support_list::Ask,
    text::{Pilot, ReviewsMsg},
    views::{self, Layout},
};

/// A rating at or under this asks a buyer to resolve the order first
/// (`LOW_RATING_RESOLUTION_THRESHOLD`).
pub const LOW_RATING: i64 = 2;

/// What can go wrong with an order, and the support flow each opens (`REVIEW_PROBLEM_CATEGORIES`
/// and `PROBLEM_CATEGORY_INTAKE_FLOW`), in the form's order.
pub const PROBLEMS: [(&str, &str); 6] = [
    ("not-received", "product-not-received"),
    ("damaged", "product-damaged"),
    ("not-as-described", "product-not-as-described"),
    ("missing-items", "missing-products"),
    ("authenticity", "authenticity-concern"),
    ("other", "return-request"),
];

/// What the address carries: `resolution=intake-unavailable` when the support page sent the
/// buyer back because an issue cannot be opened.
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
pub struct ReviewAsk {
    pub resolution: Option<String>,
}

/// The form: what the button was for, the rating, the words, the problems ticked and whether
/// feedback only was acknowledged.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewInput {
    pub intent: String,
    pub attempt: Option<SubmitKey>,
    pub rating: String,
    pub feedback: String,
    pub problem_categories: Vec<String>,
    pub feedback_only_acknowledged: String,
}

/// A refused review: what to say, whether the words are at fault (a rate limit is not), whether
/// it is one of the closed authoring codes, and why Submit is off, when it is.
#[derive(Clone, Debug)]
pub struct Refused {
    pub message: String,
    pub field: bool,
    pub recovery: bool,
    pub locked: Option<Locked>,
}

/// The page: the opportunity, the form as typed, and whether it asks to resolve first.
#[derive(Serialize, ToJson)]
pub struct OrderReviewScreen {
    pub opportunity: ReviewOpportunity,
    pub intake_available: bool,
    pub rating: i64,
    pub feedback: String,
    pub problems: Vec<String>,
    pub resolve_first: bool,
    #[serde(skip)]
    pub refused: Option<Refused>,
    /// The order's page, and the form's own address.
    #[serde(skip)]
    pub back: String,
    #[serde(skip)]
    pub action: String,
}

impl OrderReviewScreen {
    /// Whether the buyer writes it (the payment protection words and the problems are a buyer's).
    pub fn buyer(&self) -> bool {
        self.opportunity.author_role == "buyer"
    }

    /// Why Submit is off: a review whose result cannot be confirmed, or whose attempt was another
    /// review's.
    pub fn locked(&self) -> Option<Locked> {
        self.refused.as_ref().and_then(|r| r.locked)
    }

    /// The support page for the order (Track order issue).
    pub fn support(&self) -> String {
        support(&self.opportunity.order_id, None)
    }

    /// Open an order issue: the support page for the order and the first problem's flow.
    pub fn resolve(&self) -> String {
        let flow = self.problems.first().and_then(|p| PROBLEMS.iter().find(|(key, _)| key == p)).map(|(_, flow)| *flow);
        support(&self.opportunity.order_id, flow)
    }
}

fn support(order: &str, flow: Option<&str>) -> String {
    let ask = Ask { order_id: Some(order.to_owned()), flow: flow.map(str::to_owned), ..Ask::default() };
    url::SupportList { ask }.href()
}

/// Whether a buyer's review asks to resolve the order first (`shouldRouteToResolution`).
pub fn resolve_first(rating: i64, problems: &[String]) -> bool {
    rating <= LOW_RATING || !problems.is_empty()
}

#[derive(Clone, Copy)]
enum For {
    Purchase,
    Sale,
}

impl For {
    fn back(self, id: &str) -> String {
        match self {
            For::Purchase => url::Purchase { id, after: Default::default() }.href(),
            For::Sale => url::Sale { id, after: Default::default() }.href(),
        }
    }

    fn action(self, id: &str, ask: &ReviewAsk) -> String {
        match self {
            For::Purchase => url::PurchaseReview { id, ask: ask.clone() }.href(),
            For::Sale => url::SaleReview { id, ask: ask.clone() }.href(),
        }
    }
}

pub(crate) async fn purchase(
    req: Req,
    Caller(Reviewer(viewer)): Caller<Reviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::purchase_reviews::PurchaseReview<'_>>,
) -> HtmlResult {
    let (id, ask) = (route.id, route.ask);
    page(&req, &viewer, &config, &headers, For::Purchase, &id, ask).await
}

pub(crate) async fn sale(
    req: Req,
    Caller(Reviewer(viewer)): Caller<Reviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_reviews::SaleReview<'_>>,
) -> HtmlResult {
    let (id, ask) = (route.id, route.ask);
    page(&req, &viewer, &config, &headers, For::Sale, &id, ask).await
}

pub(crate) async fn submit_purchase(
    req: Req,
    Caller(Reviewer(viewer)): Caller<Reviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::purchase_reviews::PurchaseReview<'_>>,
    Form(input): Form<ReviewInput>,
) -> HtmlResult {
    let (id, ask) = (route.id, route.ask);
    submit(&req, &viewer, &config, &headers, For::Purchase, &id, ask, input).await
}

pub(crate) async fn submit_sale(
    req: Req,
    Caller(Reviewer(viewer)): Caller<Reviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_reviews::SaleReview<'_>>,
    Form(input): Form<ReviewInput>,
) -> HtmlResult {
    let (id, ask) = (route.id, route.ask);
    submit(&req, &viewer, &config, &headers, For::Sale, &id, ask, input).await
}

#[allow(clippy::too_many_arguments)]
async fn page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    which: For,
    id: &str,
    ask: ReviewAsk,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let opportunity = match read(req, viewer, &caller, id).await {
        Read::Open(opportunity) => opportunity,
        Read::Answer(answer) => return answer,
    };
    let screen = screen(opportunity, which, id, &ask, 5, String::new(), Vec::new());
    draw(req, viewer, which, &screen, StatusCode::OK)
}

fn screen(
    opportunity: ReviewOpportunity,
    which: For,
    id: &str,
    ask: &ReviewAsk,
    rating: i64,
    feedback: String,
    problems: Vec<String>,
) -> OrderReviewScreen {
    OrderReviewScreen {
        back: which.back(if opportunity.order_id.is_empty() { id } else { &opportunity.order_id }),
        action: which.action(id, ask),
        intake_available: ask.resolution.as_deref() != Some("intake-unavailable"),
        opportunity,
        rating,
        feedback,
        problems,
        resolve_first: false,
        refused: None,
    }
}

/// The order's review opportunity, or the page's answer instead of the form.
enum Read {
    Open(ReviewOpportunity),
    Answer(HtmlResult),
}

/// The order's review opportunity: a review already written is its page, and no such order is a
/// 404.
async fn read(req: &Req, viewer: &Viewer, caller: &ApiCaller<'_>, id: &str) -> Read {
    match caller.review_opportunity(id).await {
        Ok(Some(opportunity)) => match opportunity.active_review_id.as_deref().filter(|r| !r.is_empty()) {
            Some(review) => Read::Answer(req.redirect(&url::Review { id: review, place: ReviewPlace::default() })),
            None => Read::Open(opportunity),
        },
        Ok(None) => Read::Answer(Err(corten::Error::status(StatusCode::NOT_FOUND))),
        Err(error) => Read::Answer(read_failed(req, Some(viewer), error, None)),
    }
}

fn draw(req: &Req, viewer: &Viewer, which: For, screen: &OrderReviewScreen, status: StatusCode) -> HtmlResult {
    let t: ReviewsMsg = req.t();
    let title = match which {
        For::Purchase => t.route_purchase_review_write_review_marketplace(),
        For::Sale => t.route_sale_review_write_review_marketplace(),
    };
    let view = html! { <views::OrderReviewPage t={t} p={req.t()} screen={screen} /> };
    let page = html! { <Layout req={req} viewer={Some(viewer)} title={title} head={()}>{view}</Layout> };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

#[allow(clippy::too_many_arguments)]
async fn submit(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    which: For,
    id: &str,
    ask: ReviewAsk,
    input: ReviewInput,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let opportunity = match read(req, viewer, &caller, id).await {
        Read::Open(opportunity) => opportunity,
        Read::Answer(answer) => return answer,
    };
    // `Number(value ?? 0)`: what is not a number is sent as 0, for Reputation to refuse.
    let rating = input.rating.trim().parse::<i64>().unwrap_or(0);
    let mut problems = Vec::new();
    for (key, _) in PROBLEMS {
        if input.problem_categories.iter().any(|p| p == key) {
            problems.push(key.to_owned());
        }
    }
    let mut screen = screen(opportunity, which, id, &ask, rating, input.feedback.clone(), problems);
    let buyer = screen.buyer();
    match input.intent.as_str() {
        "edit" => return draw(req, viewer, which, &screen, StatusCode::OK),
        "resolve" => {
            screen.resolve_first = true;
            return draw(req, viewer, which, &screen, StatusCode::OK);
        }
        // The acknowledgement is required; a form sent without it asks again.
        "feedback-only" if buyer && input.feedback_only_acknowledged != "true" => {
            screen.resolve_first = true;
            return draw(req, viewer, which, &screen, StatusCode::UNPROCESSABLE_ENTITY);
        }
        "feedback-only" => {}
        _ if buyer && resolve_first(rating, &screen.problems) => {
            screen.resolve_first = true;
            return draw(req, viewer, which, &screen, StatusCode::OK);
        }
        _ => {}
    }
    let order = if screen.opportunity.order_id.is_empty() { id.to_owned() } else { screen.opportunity.order_id.clone() };
    let subject = screen.opportunity.subject_account_id.clone();
    let t: ReviewsMsg = req.t();
    let Some(attempt) = marketplace_attempt::presented(attempt_text(&input.attempt)) else {
        screen.refused = Some(Refused { message: t.attempt_not_sent().to_owned(), field: false, recovery: false, locked: None });
        return draw(req, viewer, which, &screen, StatusCode::UNPROCESSABLE_ENTITY);
    };
    match caller.submit_review(attempt, &order, &subject, rating, &input.feedback).await {
        Ok((review, receipt)) => {
            let place = ReviewPlace { after_write: receipt.map(|r| r.param()), reported: None };
            req.redirect(&url::Review { id: &review, place })
        }
        Err(error) if marketplace_attempt::locked_by(&error).is_some() => {
            locked(req, viewer, which, screen, marketplace_attempt::locked_by(&error).unwrap_or(Locked::Unconfirmed))
        }
        Err(error) if marketplace_attempt::lost(&error) => {
            tracing::warn!("a review had no answer, looking up its attempt: {error}");
            let request = json!({
                "orderId": order, "subjectAccountId": subject, "rating": rating,
                "feedback": marketplace_attempt::review_text(&input.feedback),
            });
            match marketplace_attempt::observe(&caller, "review.submit", "order", &order, attempt, &request).await {
                Observed::Committed { id: review, .. } => {
                    req.redirect(&url::Review { id: &review, place: ReviewPlace::default() })
                }
                Observed::Conflict => locked(req, viewer, which, screen, Locked::Conflict),
                Observed::NotObserved => {
                    let message = t.attempt_not_observed().to_owned();
                    screen.refused = Some(Refused { message, field: false, recovery: false, locked: None });
                    draw(req, viewer, which, &screen, StatusCode::BAD_GATEWAY)
                }
                Observed::Unsettled => locked(req, viewer, which, screen, Locked::Unconfirmed),
            }
        }
        Err(error) => refused(req, viewer, which, screen, error),
    }
}

/// A review whose result cannot be confirmed, or whose attempt was another review's: the form
/// again with what was typed, and no Submit.
fn locked(req: &Req, viewer: &Viewer, which: For, mut screen: OrderReviewScreen, locked: Locked) -> HtmlResult {
    let t: ReviewsMsg = req.t();
    let (message, status) = match locked {
        Locked::Conflict => (t.attempt_changed_request(), StatusCode::CONFLICT),
        Locked::Unconfirmed => (t.attempt_unconfirmed(), StatusCode::BAD_GATEWAY),
    };
    screen.refused = Some(Refused { message: message.to_owned(), field: false, recovery: false, locked: Some(locked) });
    draw(req, viewer, which, &screen, status)
}

/// A refused review: the form again with what was typed and why.
fn refused(req: &Req, viewer: &Viewer, which: For, mut screen: OrderReviewScreen, error: ApiError) -> HtmlResult {
    let (t, p): (ReviewsMsg, Pilot) = (req.t(), req.t());
    let status = match error.status() {
        Some(StatusCode::NOT_FOUND) => return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND)),
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        status => status,
    };
    let code = error.code().unwrap_or_default();
    let (said, answer) = if let Some(message) = crate::review::recovery(t, code) {
        let status = status.filter(StatusCode::is_client_error).unwrap_or(StatusCode::UNPROCESSABLE_ENTITY);
        (Refused { message: message.to_owned(), field: code != "rate_limited", recovery: true, locked: None }, status)
    } else if status.is_some_and(|s| s.is_client_error()) {
        let message = error.refusal().unwrap_or(p.reviews_submit_failed()).to_owned();
        (Refused { message, field: false, recovery: false, locked: None }, StatusCode::UNPROCESSABLE_ENTITY)
    } else {
        // The API failed: nothing says it was sent, and the words are kept.
        tracing::warn!("a review could not be submitted: {error}");
        let message = p.reviews_submit_failed().to_owned();
        (Refused { message, field: false, recovery: false, locked: None }, StatusCode::BAD_GATEWAY)
    };
    screen.refused = Some(said);
    draw(req, viewer, which, &screen, answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_low_rating_or_a_problem_asks_to_resolve_first() {
        assert!(resolve_first(2, &[]) && resolve_first(1, &[]) && resolve_first(0, &[]));
        assert!(!resolve_first(3, &[]));
        assert!(resolve_first(5, &["damaged".into()]));
    }
}
