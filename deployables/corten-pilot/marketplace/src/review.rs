//! A review's own page (Reputation's marketplace `account-review` route): the review as the
//! account sees it, a link to its order and back to the list it is on, Report review, and Respond
//! to this review for the account it reviews, once, while it is active, revealed and not held.
//!
//! Both writes post to the page, as marketplace's form action does, by `intent`. A sent report
//! comes back saying it was received (`?reported={id}`). A posted reply comes back read after its
//! receipt (`?after_write=`); while Reputation has not caught up the page says the review is
//! preparing and reads itself again. A refused reply is the page again with what was typed, and
//! the closed authoring codes (`authoredTextRecoveryCopy`) say how to fix it.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/reviews/{id}?<place>` | the review, read after the reply whose receipt it carries |
//! | `POST /account/reviews/{id}` | Report review (`intent=report-review`) or the reply (`intent=reply`) |
use std::time::Duration;

use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
    },
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    accounts::{ReviewNotice, Role},
    api::{ApiError, Caller as ApiCaller, ReviewCalls as _, ReviewItem},
    app::{Shared, read_failed, sign_in, url},
    auth::{ReviewMember, Viewer},
    reviews::{self, ReportInput, Reported},
    text::{Pilot, ReviewsMsg},
    views::{self, Layout},
};

/// The most a reply may say (the form's `maxLength`).
pub const MOST_REPLY: usize = 1000;

/// What the address carries: the reply's receipt, and the review a report was just received for.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct ReviewPlace {
    pub after_write: Option<String>,
    pub reported: Option<String>,
}

/// A refused reply: what to say, whether the text itself is at fault (a rate limit is not), and
/// what was typed.
#[derive(Clone, Debug)]
pub struct ReplyRefused {
    pub message: String,
    pub field: bool,
    pub recovery: bool,
    pub draft: String,
}

/// The page: the review, who is looking, and what came of a report or a reply.
#[derive(Serialize, ToJson)]
pub struct ReviewScreen {
    pub review: ReviewItem,
    #[serde(skip)]
    pub viewer_account: String,
    #[serde(skip)]
    pub report: Option<ReviewNotice>,
    #[serde(skip)]
    pub reply: Option<ReplyRefused>,
}

impl ReviewScreen {
    /// Whether the account wrote it.
    pub fn owns(&self) -> bool {
        self.review.author_account_id == self.viewer_account
    }

    /// The role the account had in the order (`reviewRoleForViewer`).
    pub fn role(&self) -> Role {
        let author = if self.review.author_role == "seller" { Role::Seller } else { Role::Buyer };
        match (self.owns(), author) {
            (true, role) => role,
            (false, Role::Buyer) => Role::Seller,
            (false, Role::Seller) => Role::Buyer,
        }
    }

    /// Back to the list the review is on, in the account's role.
    pub fn back_href(&self) -> String {
        let place = reviews::Place { role: Some(self.role().as_str().to_owned()), reported: None };
        if self.owns() { url::WrittenReviews { place }.href() } else { url::ReceivedReviews { place }.href() }
    }

    /// The order the review is about: a purchase for a buyer, a sale for a seller.
    pub fn order_href(&self) -> String {
        let id = self.review.order_id.as_str();
        match self.role() {
            Role::Buyer => url::Purchase { id, after: Default::default() }.href(),
            Role::Seller => url::Sale { id, after: Default::default() }.href(),
        }
    }

    /// Report review's place: anyone signed in, on an active, revealed review that is not held and
    /// whose feedback was not redacted (`canReportReview`).
    pub fn can_report(&self) -> bool {
        self.review.reportable() && self.review.feedback_redacted_at.is_none()
    }

    /// Respond to this review: only the account reviewed, once, on an active, revealed review that is
    /// not held (`canComposeReply`). A withdrawn reply keeps its id, so it cannot be posted again.
    pub fn can_reply(&self) -> bool {
        self.review.subject_account_id == self.viewer_account && self.review.reportable() && self.review.reply_id.is_none()
    }

    /// The account's reply, while the review and the reply are both shown.
    pub fn shown_reply(&self) -> Option<&str> {
        self.review.reply()
    }
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::Review<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let report = place.reported.as_deref().filter(|r| *r == id).map(|_| ReviewNotice::Submitted);
    match read(&caller, &viewer, &id).await {
        Ok(mut screen) => {
            screen.report = report;
            render(&req, &viewer, &screen, StatusCode::OK, chrome.cart().await)
        }
        Err(error) if receipt.is_some() && error.catching_up() => preparing(&req, &viewer, &id, place, chrome.cart().await),
        Err(error) => failed(&req, &viewer, error, chrome.cart().await),
    }
}

async fn read(caller: &ApiCaller<'_>, viewer: &Viewer, id: &str) -> Result<ReviewScreen, ApiError> {
    let review = caller.review(id).await?;
    Ok(ReviewScreen { review, viewer_account: viewer.actor.account_id.clone(), report: None, reply: None })
}

/// A review the API does not have is not found; any other failed read is the list's answer.
fn failed(req: &Req, viewer: &Viewer, error: ApiError, cart: Option<u64>) -> HtmlResult {
    if error.status() == Some(StatusCode::NOT_FOUND) {
        return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
    }
    read_failed(req, Some(viewer), error, None, cart)
}

fn render(req: &Req, viewer: &Viewer, screen: &ReviewScreen, status: StatusCode, cart: Option<u64>) -> HtmlResult {
    let t: ReviewsMsg = req.t();
    let view = html! { <views::ReviewPage t={t} p={req.t()} screen={screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_detail_review_marketplace()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

/// The review is not readable yet after its reply (`ReviewDetailRecoveryPage`): it says so, reads
/// itself again in two seconds, and offers Refresh review.
fn preparing(req: &Req, viewer: &Viewer, id: &str, place: ReviewPlace, cart: Option<u64>) -> HtmlResult {
    let t: ReviewsMsg = req.t();
    let again = url::Review { id, place }.href();
    let head = html! { <ReadAgain after={Duration::from_secs(2)} /> };
    let view = html! { <views::ReviewPreparing t={t} again={&again} /> };
    req.page(html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_detail_review_preparing()} head={head}>{view}</Layout>
    })
}

pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    Caller(ReviewMember(viewer)): Caller<ReviewMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::reviews::Review<'_>>,
    Form(input): Form<ReportInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    match input.intent.as_str() {
        "report-review" => {
            let from = url::Review { id: &id, place: ReviewPlace::default() }.href();
            match reviews::send_report(req.t(), &caller, &id, &input, &from).await {
                Reported::Sent => req.redirect(&url::Review {
                    id: &id,
                    place: ReviewPlace { reported: Some(id.clone()), ..ReviewPlace::default() },
                }),
                Reported::Again(notice, status) => {
                    again(&req, &viewer, &caller, &id, status, |s| s.report = Some(notice), &chrome).await
                }
                Reported::SignIn => sign_in(&req),
                Reported::Failed(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            }
        }
        "reply" => reply(&req, &viewer, &caller, &id, input.feedback, &chrome).await,
        // Marketplace's action answers nothing for another intent, and the page is read again.
        _ => req.redirect(&url::Review { id: &id, place: ReviewPlace::default() }),
    }
}

/// The page again after a refused write, with what came of it.
async fn again(
    req: &Req,
    viewer: &Viewer,
    caller: &ApiCaller<'_>,
    id: &str,
    status: StatusCode,
    said: impl FnOnce(&mut ReviewScreen),
    chrome: &Chrome,
) -> HtmlResult {
    match read(caller, viewer, id).await {
        Ok(mut screen) => {
            said(&mut screen);
            render(req, viewer, &screen, status, chrome.cart().await)
        }
        Err(error) => failed(req, viewer, error, chrome.cart().await),
    }
}

/// Respond to this review: the words are needed and at most 1,000 characters (as the form's
/// `maxLength` counts them), sent as typed; the API decides the rest.
async fn reply(req: &Req, viewer: &Viewer, caller: &ApiCaller<'_>, id: &str, feedback: String, chrome: &Chrome) -> HtmlResult {
    let p: Pilot = req.t();
    let t: ReviewsMsg = req.t();
    let refused = |message: &str, field: bool, recovery: bool, status: StatusCode, draft: String| {
        let reply = ReplyRefused { message: message.to_owned(), field, recovery, draft };
        again(req, viewer, caller, id, status, move |s| s.reply = Some(reply), chrome)
    };
    if feedback.trim().is_empty() {
        return refused(p.reviews_reply_required(), true, false, StatusCode::UNPROCESSABLE_ENTITY, feedback).await;
    }
    if feedback.encode_utf16().count() > MOST_REPLY {
        return refused(p.reviews_reply_too_long(), true, false, StatusCode::UNPROCESSABLE_ENTITY, feedback).await;
    }
    match caller.reply_to_review(id, &feedback).await {
        Ok(receipt) => {
            let after_write = receipt.map(|r| r.param());
            req.redirect(&url::Review { id, place: ReviewPlace { after_write, reported: None } })
        }
        Err(error) => match error.status() {
            Some(StatusCode::NOT_FOUND) => Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND)),
            Some(StatusCode::UNAUTHORIZED) => sign_in(req),
            status => {
                let code = error.code().unwrap_or_default();
                if let Some(message) = recovery(t, code) {
                    let status = status.filter(StatusCode::is_client_error).unwrap_or(StatusCode::UNPROCESSABLE_ENTITY);
                    return refused(message, code != "rate_limited", true, status, feedback).await;
                }
                match status {
                    Some(status) if status.is_client_error() => {
                        let message = error.refusal().unwrap_or(t.route_detail_reply_failed()).to_owned();
                        refused(&message, false, false, StatusCode::UNPROCESSABLE_ENTITY, feedback).await
                    }
                    // The API failed: nothing says it was posted, and the words are kept.
                    _ => {
                        tracing::warn!("a review reply failed: {error}");
                        refused(t.route_detail_reply_failed(), false, false, StatusCode::BAD_GATEWAY, feedback).await
                    }
                }
            }
        },
    }
}

/// The closed authoring codes a reply is refused with, and their words (`authoredTextRecoveryCopy`).
pub(crate) fn recovery(t: ReviewsMsg, code: &str) -> Option<&'static str> {
    Some(match code {
        "text_control_character" => t.recovery_control_character(),
        "text_direction_override" => t.recovery_direction_override(),
        "text_unsafe_link" => t.recovery_unsafe_link(),
        "text_duplicate_link" => t.recovery_duplicate_link(),
        "rate_limited" => t.recovery_rate_limited(),
        _ => return None,
    })
}
