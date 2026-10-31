//! The account's review pages (Reputation's `ReviewSummaryPage` and `ReviewListPage`): a header with the
//! other pages' links; on the summary the account's ratings as a seller and as a buyer
//! (`RatingDistribution`) and its newest reviews; on a list the role filter and each review, or the
//! words that stand in for a withdrawn, paused or pending one. A review that may be reported has
//! Report review (`ReviewReportAction`), a dialog that opens again when its report is refused. One
//! column on a phone, every control at least 2.75rem tall; from 48rem the two ratings sit side by
//! side and a review's head spreads across its card.
use corten::prelude::*;

use super::{account_page::Side, on_marketplace};
use crate::{
    accounts::{MOST_DETAILS, REASONS, ReviewNotice},
    api::{ReviewItem, ReviewSummary},
    app::url,
    review::{MOST_REPLY, ReviewPlace, ReviewScreen},
    reviews::{ReportInput, ReviewsScreen, Which},
    text::{Pilot, ReviewsMsg},
};

/// A review on the page, so a redirect after its report brings the browser back to it.
#[derive(Id)]
pub struct ReviewAnchorId<'a>(pub &'a str);

/// A review's Report review dialog.
#[derive(Id)]
pub struct ReportReviewDialogId<'a>(pub &'a str);

/// The reply's words, which a refused reply's summary links to.
#[derive(Id)]
pub struct ReplyFeedbackId;

/// A rating as the API writes it (`"4.50"`), when it is a number.
fn rating(text: Option<&str>) -> Option<f64> {
    text.and_then(|r| r.trim().parse::<f64>().ok()).filter(|r| r.is_finite())
}

/// A share of `total`, as a whole percent (`ratingPercent`).
fn percent(count: u64, total: u64) -> u64 {
    if total == 0 { 0 } else { ((count as f64 / total as f64) * 100.0).round() as u64 }
}

fn seller(s: &ReviewSummary) -> Side {
    Side {
        average: rating(s.average_rating_as_seller.as_deref()),
        reviews: s.review_count_as_seller,
        ratings: s.rating_count_as_seller,
        counts: [
            s.rating_5_count_as_seller,
            s.rating_4_count_as_seller,
            s.rating_3_count_as_seller,
            s.rating_2_count_as_seller,
            s.rating_1_count_as_seller,
        ],
    }
}

fn buyer(s: &ReviewSummary) -> Side {
    Side {
        average: rating(s.average_rating_as_buyer.as_deref()),
        reviews: s.review_count_as_buyer,
        ratings: s.rating_count_as_buyer,
        counts: [
            s.rating_5_count_as_buyer,
            s.rating_4_count_as_buyer,
            s.rating_3_count_as_buyer,
            s.rating_2_count_as_buyer,
            s.rating_1_count_as_buyer,
        ],
    }
}

/// The page.
#[component(css)]
pub fn ReviewsPage<'a>(t: ReviewsMsg, p: Pilot, screen: &'a ReviewsScreen) -> impl Render {
    let (eyebrow, title, description) = match (screen.which, &screen.summary) {
        (Which::Summary, summary) => (
            t.summary_reviews(),
            summary.as_ref().and_then(|s| s.account_display_name.as_deref()).unwrap_or(t.route_summary_your_reviews()),
            t.summary_canonical_post_transaction_feedback_and_rating(),
        ),
        (Which::Received, _) => (
            t.route_received_reviews(),
            t.route_received_received_reviews(),
            t.list_track_written_feedback_current_visibility_and(),
        ),
        (Which::Written, _) => {
            (t.route_written_reviews(), t.route_written_written_reviews(), t.list_track_written_feedback_current_visibility_and())
        }
    };
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{eyebrow}</p>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{description}</p>
                <nav class={Links} aria-label={eyebrow}>
                    match screen.which {
                        Which::Summary => {
                            <a class={Secondary} href={url::ReceivedReviews::default()}>{t.route_summary_received_reviews()}</a>
                            <a class={Secondary} href={url::WrittenReviews::default()}>{t.route_summary_written_reviews()}</a>
                        }
                        Which::Received => {
                            <a class={Secondary} href={url::Reviews::default()}>{t.route_received_summary()}</a>
                            <a class={Secondary} href={url::WrittenReviews::default()}>{t.route_received_written_reviews()}</a>
                        }
                        Which::Written => {
                            <a class={Secondary} href={url::Reviews::default()}>{t.route_written_summary()}</a>
                            <a class={Secondary} href={url::ReceivedReviews::default()}>{t.route_written_received_reviews()}</a>
                        }
                    }
                </nav>
            </header>
            if let Some(summary) = &screen.summary {
                <section class={Section} aria-labelledby="reviews-summary">
                    <h2 id="reviews-summary" class={SectionTitle}>{t.summary_summary()}</h2>
                    <div class={Sides}>
                        <Distribution t={t} title={t.summary_as_seller()} side={&seller(summary)} />
                        <Distribution t={t} title={t.summary_as_buyer()} side={&buyer(summary)} />
                    </div>
                </section>
                <section class={Section} aria-labelledby="reviews-recent">
                    <h2 id="reviews-recent" class={SectionTitle}>{t.summary_recent_reviews()}</h2>
                    if screen.reviews.iter().all(|r| r.rating.is_none()) {
                        <Empty
                            title={t.summary_no_reviews_yet()}
                            description={t.summary_completed_transactions_will_surface_here_once()}
                        />
                    } else {
                        <ul class={Reviews}>
                            for review in screen.reviews.iter().filter(|r| r.rating.is_some()) {
                                <ReviewCard t={t} p={p} screen={screen} review={review} open={None} />
                            }
                        </ul>
                    }
                </section>
            } else {
                <section class={Section} aria-labelledby="reviews-role">
                    <h2 id="reviews-role" class={SectionTitle}>{t.list_filter_by_role()}</h2>
                    <RoleFilter t={t} screen={screen} />
                </section>
                <section class={Section} aria-labelledby="reviews-list">
                    <h2 id="reviews-list" class={SectionTitle}>{t.list_reviews()}</h2>
                    if screen.reviews.is_empty() {
                        if screen.which == Which::Received {
                            <Empty
                                title={t.route_received_no_received_reviews_yet()}
                                description={t.route_received_counterparty_feedback_about_your_completed_transactions()}
                            />
                        } else {
                            <Empty
                                title={t.route_written_no_written_reviews_yet()}
                                description={t.route_written_reviews_you_leave_after_completed_transactions()}
                            />
                        }
                    } else {
                        <ul class={Reviews}>
                            for review in &screen.reviews {
                                <ListItem t={t} p={p} screen={screen} review={review} />
                            }
                        </ul>
                    }
                </section>
            }
        </div>
    }
}

/// The lists' role filter: All, As seller and As buyer, the current one marked.
#[component(css = ReviewsPage)]
fn RoleFilter<'a>(t: ReviewsMsg, screen: &'a ReviewsScreen) -> impl Render {
    use crate::accounts::Role;
    let words = if screen.which == Which::Received {
        [t.route_received_all_roles(), t.route_received_as_seller(), t.route_received_as_buyer()]
    } else {
        [t.route_written_all_roles(), t.route_written_as_seller(), t.route_written_as_buyer()]
    };
    let roles = [None, Some(Role::Seller), Some(Role::Buyer)];
    html! {
        <ul class={Links}>
            for (role, word) in roles.into_iter().zip(words) {
                <li>
                    <a
                        class={if screen.role == role { Primary } else { Secondary }}
                        href={&screen.href(role, None)}
                        aria-current={(screen.role == role).then_some("page")}
                    >
                        {word}
                    </a>
                </li>
            }
        </ul>
    }
}

/// Words that stand in for reviews, or for one that cannot be shown (`MarketplaceEmptyState`).
#[component(css = ReviewsPage)]
fn Empty<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Empty}>
            <p class={Strong}>{title}</p>
            <p class={Muted}>{description}</p>
        </div>
    }
}

/// One side's ratings (`RoleReputationDistribution`): the average, how many, and the share of each
/// star rating.
#[component(css = ReviewsPage)]
fn Distribution<'a>(t: ReviewsMsg, title: &'a str, side: &'a Side) -> impl Render {
    let count = if side.ratings != side.reviews {
        t.summary_rating_and_review_count(side.ratings, side.reviews).to_string()
    } else if side.reviews > 0 {
        side.reviews.to_string()
    } else {
        side.average.map_or_else(|| t.summary_not_yet_rated().to_owned(), |a| format!("{a:.2}"))
    };
    html! {
        <div class={Side}>
            <h3 class={CardTitle}>{title}</h3>
            <p class={Rating}>
                <span class={Star} aria-hidden="true">"\u{2605}"</span>
                <span class={Strong}>{format!("{:.1}", side.average.unwrap_or(0.0))}</span>
                <span>{format!("({count})")}</span>
            </p>
            <ul class={Bars}>
                for (n, stars) in side.counts.iter().zip([5, 4, 3, 2, 1]) {
                    <li>
                        <span>{stars}</span>
                        <progress max="100" value={percent(*n, side.ratings)}>
                            {format!("{}%", percent(*n, side.ratings))}
                        </progress>
                        <span class={Faint}>{format!("{}%", percent(*n, side.ratings))}</span>
                    </li>
                }
            </ul>
        </div>
    }
}

/// A list's review: the words for a withdrawn, paused or pending one, else its card and Open
/// review.
#[component(css = ReviewsPage)]
fn ListItem<'a>(t: ReviewsMsg, p: Pilot, screen: &'a ReviewsScreen, review: &'a ReviewItem) -> impl Render {
    let open = url::Review { id: &review.review_id, place: ReviewPlace::default() }.href();
    html! {
        if review.status == "withdrawn" {
            <li id={ReviewAnchorId(&review.review_id)} class={Stack}>
                <Empty title={t.list_review_withdrawn_title()} description={t.list_review_withdrawn_description()} />
                if review.withdrawn_by_actor_type.as_deref() == Some("operator") {
                    <p><span class={Badge} data-tone="danger">{t.list_moderated_withdrawn()}</span></p>
                }
            </li>
        } else if review.held && review.rating.is_none() {
            <li id={ReviewAnchorId(&review.review_id)} class={Stack}>
                <Empty title={t.list_feedback_on_hold_title()} description={t.list_feedback_on_hold_description()} />
            </li>
        } else if review.rating.is_none() {
            <li id={ReviewAnchorId(&review.review_id)} class={Stack}>
                <Empty title={t.list_review_pending_title()} description={t.list_review_pending_description()} />
            </li>
        } else {
            <ReviewCard t={t} p={p} screen={screen} review={review} open={Some(&open)} />
        }
    }
}

/// A review (`ReviewCard`): who wrote it, its rating, how it counts, what it says, the account's
/// reply, and Report review while it may be reported. The summary names the author alone and says
/// the order was verified; a list says who wrote it and whom it reviews, with its status.
#[component(css = ReviewsPage)]
fn ReviewCard<'a>(
    t: ReviewsMsg,
    p: Pilot,
    screen: &'a ReviewsScreen,
    review: &'a ReviewItem,
    open: Option<&'a str>,
) -> impl Render {
    let list = screen.which != Which::Summary;
    let author = review.author_display_name.as_deref().unwrap_or(&review.author_account_id);
    let subject = review.subject_display_name.as_deref().unwrap_or(&review.subject_account_id);
    let context_only = review.scoring_disposition.as_deref() == Some("context-only");
    let reply = if list {
        review.reply()
    } else {
        review.reply_feedback.as_deref().filter(|_| review.reply_status.as_deref() == Some("active"))
    };
    let feedback =
        review.feedback.as_deref().unwrap_or(if list { t.list_no_written_feedback() } else { t.summary_no_written_feedback() });
    html! {
        <li id={ReviewAnchorId(&review.review_id)} class={Review}>
            <div class={ReviewHead}>
                <p class={Strong}>
                    if list { {t.list_review_author()} }
                    {author}
                </p>
                <div class={Inline}>
                    <Stars value={f64::from(review.rating.unwrap_or(0))} />
                    <span class={Badge} data-tone="success">{p.account_verified_purchase()}</span>
                </div>
            </div>
            if list {
                <div class={Stack}>
                    <p class={Muted}>{t.list_verified_order()}</p>
                    <p class={Muted}>{t.list_reviewed_account()}{subject}</p>
                    <p class={Inline}>
                        <span class={Badge} data-tone="success">{&review.status}</span>
                        if review.revealed_at.is_none() {
                            <span class={Badge} data-tone="warning">{t.list_pending_reveal()}</span>
                        }
                        if review.held {
                            <span class={Badge} data-tone="warning">{t.list_feedback_on_hold_badge()}</span>
                        }
                        if context_only {
                            <span class={Badge}>{t.context_only()}</span>
                        }
                    </p>
                </div>
            } else {
                <p class={Muted}>{if context_only { t.context_only() } else { t.list_verified_order() }}</p>
            }
            <Scoring t={t} review={review} />
            <p class={Body}>{feedback}</p>
            if let Some(reply) = reply {
                <p class={Reply}>
                    <span class={Strong}>{if list { t.list_reply_label() } else { t.summary_reply_label() }}</span>
                    " "{reply}
                </p>
            }
            <div class={ReviewActions} role="group" aria-label={p.account_review_actions()}>
                if review.reportable() {
                    <ReportAction
                        t={t}
                        p={p}
                        action={&screen.href(screen.role, None)}
                        review={&review.review_id}
                        notice={screen.notice(&review.review_id)}
                        intent={false}
                    />
                }
                if let Some(open) = open {
                    <a class={Secondary} href={open}>{t.list_open_review()}</a>
                }
            </div>
        </li>
    }
}

/// A star and a rating with one decimal (`RatingSummary`).
#[component(css = ReviewsPage)]
fn Stars(value: f64) -> impl Render {
    html! {
        <span class={Rating}>
            <span class={Star} aria-hidden="true">"\u{2605}"</span>
            <span class={Strong}>{format!("{value:.1}")}</span>
        </span>
    }
}

/// How a review counts toward the rating (`ReviewScoringContext`): included or not, why, and the
/// remedy; nothing for a review from before scoring.
#[component(css = ReviewsPage)]
fn Scoring<'a>(t: ReviewsMsg, review: &'a ReviewItem) -> impl Render {
    let included = review.scoring_disposition.as_deref() == Some("included");
    let outcome = match review.resolution_context.as_deref() {
        Some("carrier") => Some(t.scoring_carrier()),
        Some("platform") => Some(t.scoring_platform()),
        Some("shared" | "undetermined") => Some(t.scoring_shared_or_undetermined()),
        Some("seller" | "buyer") => Some(t.scoring_support_resolved()),
        _ => {
            review.disposition_reason_code.as_deref().filter(|c| *c != "normal-completion").map(|_| t.scoring_support_resolved())
        }
    };
    let remedy = match review.remedy_kind.as_deref() {
        Some("refund") => Some(t.scoring_remedy_refund()),
        Some("replacement") => Some(t.scoring_remedy_replacement()),
        Some("return") => Some(t.scoring_remedy_return()),
        Some("cancellation") => Some(t.scoring_remedy_cancellation()),
        _ => None,
    };
    html! {
        if review.scoring_disposition.is_some() {
            <div class={Stack}>
                <p class={Inline}>
                    <span class={Badge} data-tone={if included { "success" } else { "neutral" }}>
                        {if included { t.scoring_included() } else { t.scoring_excluded() }}
                    </span>
                    if let Some(outcome) = outcome {
                        <span class={Badge}>{outcome}</span>
                    }
                    if let Some(remedy) = remedy {
                        <span class={Badge} data-tone="accent">{remedy}</span>
                    }
                </p>
                <p class={Muted}>{if included { t.scoring_included_description() } else { t.scoring_excluded_description() }}</p>
            </div>
        }
    }
}

/// Report review (`ReviewReportAction`): its button opens a dialog with the reason and an
/// explanation, posting to the page it is on (`action`, naming its `intent` where the page has
/// another form). Once sent it says so and the button is off. A refused report draws the dialog
/// open again with what was sent, modal once it joins the page.
#[component(css = ReviewsPage)]
fn ReportAction<'a>(
    t: ReviewsMsg,
    p: Pilot,
    action: &'a str,
    review: &'a str,
    notice: Option<&'a ReviewNotice>,
    intent: bool,
) -> impl Render {
    let labels = [
        t.report_reason_harassment(),
        t.report_reason_hate(),
        t.report_reason_personal_information(),
        t.report_reason_spam(),
        t.report_reason_other(),
    ];
    let (sent, title, description) = match notice {
        Some(ReviewNotice::Submitted) => (true, t.report_submitted(), t.report_submitted_description()),
        Some(ReviewNotice::Already) => (true, t.report_already_submitted(), t.report_already_submitted_description()),
        _ => (false, t.report_title(), ""),
    };
    let refused = match notice {
        Some(ReviewNotice::Refused { message, reason, details }) => Some((message.as_str(), reason.as_str(), details.as_str())),
        _ => None,
    };
    let (reason, details) = refused.map_or(("", ""), |(_, r, d)| (r, d));
    let heading = format!("report-review-{review}-title");
    let f = ReportInput::FIELDS;
    let max = MOST_DETAILS.to_string();
    html! {
        <div class={Stack}>
            if sent {
                <div class={Banner} data-tone="success" role="status">
                    <p class={Strong}>{title}</p>
                    <p>{description}</p>
                </div>
            }
            <button type="button" class={Ghost} command="show-modal" commandfor={ReportReviewDialogId(review)} disabled={sent}>
                <span aria-hidden="true">"\u{26a0}"</span>" "{title}
            </button>
            if !sent {
                <dialog
                    id={ReportReviewDialogId(review)}
                    class={Dialog}
                    aria-labelledby={&heading}
                    open={refused.is_some()}
                    on:connect={corten_ui::dialog::modal(target)}
                >
                    <div class={DialogHead}>
                        <h3 id={&heading} class={CardTitle}>{t.report_title()}</h3>
                        <button type="button" class={Ghost} command="close" commandfor={ReportReviewDialogId(review)}>
                            {p.account_report_close()}
                        </button>
                    </div>
                    <p class={Muted}>{t.report_description()}</p>
                    <form class={Form} method="post" action={action}>
                        if intent {
                            <input type="hidden" name={f.intent} value="report-review">
                        }
                        <input type="hidden" name={f.review_id} value={review}>
                        if let Some((message, _, _)) = refused {
                            <div class={Banner} data-tone="danger" role="alert">
                                <p class={Strong}>{t.report_failed()}</p>
                                <p>{message}</p>
                            </div>
                        }
                        <label class={Field}>
                            <span>{t.report_reason()}<span class={Required} aria-hidden="true">" *"</span></span>
                            <select
                                name={f.reason}
                                required
                                aria-invalid={refused.is_some_and(|_| !REASONS.contains(&reason)).then_some("true")}
                            >
                                for (value, label) in REASONS.iter().zip(labels) {
                                    <option value={*value} selected={reason == *value}>{label}</option>
                                }
                            </select>
                        </label>
                        <label class={Field}>
                            <span>{t.report_details()}</span>
                            <textarea
                                name={f.details}
                                rows="4"
                                maxlength={&max}
                                aria-description={t.report_details_description()}
                            >
                                {details}
                            </textarea>
                            <span class={Faint}>{t.report_details_description()}</span>
                        </label>
                        <p><button type="submit" class={Secondary}>{t.report_submit()}</button></p>
                    </form>
                </dialog>
            }
        </div>
    }
}

/// A review's own page (`ReviewDetailPage`): the header with View order outcome and Back; the
/// review, or the words for a withdrawn, paused or pending one; and Respond to this review for the
/// account it reviews.
#[component(css = ReviewsPage)]
pub fn ReviewPage<'a>(t: ReviewsMsg, p: Pilot, screen: &'a ReviewScreen) -> impl Render {
    let review = &screen.review;
    let action = url::Review { id: &review.review_id, place: ReviewPlace::default() }.href();
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.detail_review()}</p>
                <h1 class={Title}>{t.detail_review_details()}</h1>
                <p class={Muted}>{t.detail_verified_order_feedback()}</p>
                <nav class={Links} aria-label={t.detail_review()}>
                    <a class={Primary} href={&screen.order_href()}>{t.detail_view_order_outcome()}</a>
                    <a class={Secondary} href={&screen.back_href()}>{t.detail_back()}</a>
                </nav>
            </header>
            <section class={Section} aria-labelledby="review-summary">
                <h2 id="review-summary" class={SectionTitle}>{t.detail_summary()}</h2>
                if review.status == "withdrawn" {
                    <div class={Stack}>
                        <Empty title={t.detail_review_withdrawn_title()} description={t.detail_review_withdrawn_description()} />
                        if review.withdrawn_by_actor_type.as_deref() == Some("operator") {
                            <p><span class={Badge} data-tone="danger">{t.detail_moderated_withdrawn()}</span></p>
                        }
                    </div>
                } else if review.held && review.rating.is_none() {
                    <Empty title={t.detail_feedback_on_hold_title()} description={t.detail_feedback_on_hold_description()} />
                } else if review.rating.is_none() {
                    <Empty title={t.detail_review_pending_title()} description={t.detail_review_pending_description()} />
                } else {
                    <DetailCard t={t} p={p} screen={screen} action={&action} />
                }
            </section>
            if screen.can_reply() {
                <section class={Section} aria-labelledby="review-reply">
                    <h2 id="review-reply" class={SectionTitle}>{t.detail_reply_title()}</h2>
                    <ReplyForm t={t} screen={screen} action={&action} />
                </section>
            }
        </div>
    }
}

/// The review's card on its own page: who wrote it in which role, whom it reviews, its badges
/// (status, pending, paused, context only, redacted), how it counts, what it says, the reply, and
/// Report review.
#[component(css = ReviewsPage)]
fn DetailCard<'a>(t: ReviewsMsg, p: Pilot, screen: &'a ReviewScreen, action: &'a str) -> impl Render {
    let review = &screen.review;
    let author = review.author_display_name.as_deref().unwrap_or(&review.author_account_id);
    let subject = review.subject_display_name.as_deref().unwrap_or(&review.subject_account_id);
    html! {
        <article id={ReviewAnchorId(&review.review_id)} class={Review}>
            <div class={ReviewHead}>
                <p class={Strong}>{t.detail_review_author()}{author}</p>
                <div class={Inline}>
                    <Stars value={f64::from(review.rating.unwrap_or(0))} />
                    <span class={Badge} data-tone="success">{p.account_verified_purchase()}</span>
                </div>
            </div>
            <div class={Stack}>
                <p class={Muted}>{t.detail_author_role()}{&review.author_role}</p>
                <p class={Muted}>{t.detail_reviewed_account()}{subject}</p>
                <p class={Inline}>
                    <span class={Badge} data-tone="success">{&review.status}</span>
                    if review.revealed_at.is_none() {
                        <span class={Badge} data-tone="warning">{t.detail_pending_reveal()}</span>
                    }
                    if review.held {
                        <span class={Badge} data-tone="warning">{t.detail_feedback_on_hold_badge()}</span>
                    }
                    if review.scoring_disposition.as_deref() == Some("context-only") {
                        <span class={Badge}>{t.context_only()}</span>
                    }
                    if review.feedback_redacted_at.is_some() {
                        <span class={Badge} data-tone="danger">{t.detail_moderated_redacted()}</span>
                    }
                </p>
            </div>
            <Scoring t={t} review={review} />
            <p class={Body}>{review.feedback.as_deref().unwrap_or(t.detail_no_written_feedback())}</p>
            if let Some(reply) = screen.shown_reply() {
                <p class={Reply}><span class={Strong}>{t.detail_reply_label()}</span>" "{reply}</p>
            }
            if screen.can_report() {
                <div class={ReviewActions} role="group" aria-label={p.account_review_actions()}>
                    <ReportAction
                        t={t}
                        p={p}
                        action={action}
                        review={&review.review_id}
                        notice={screen.report.as_ref()}
                        intent={true}
                    />
                </div>
            }
        </article>
    }
}

/// Respond to this review: what a reply is, a refused reply's words (the closed authoring codes as
/// `AuthoredTextRecoverySummary` with a link to the words, else a banner), the words as typed, and
/// the community guidelines before Post response.
#[component(css = ReviewsPage)]
fn ReplyForm<'a>(t: ReviewsMsg, screen: &'a ReviewScreen, action: &'a str) -> impl Render {
    let f = ReportInput::FIELDS;
    let refused = screen.reply.as_ref();
    let draft = refused.map_or("", |r| r.draft.as_str());
    let invalid = refused.is_some_and(|r| r.field).then_some("true");
    let max = MOST_REPLY.to_string();
    html! {
        <div class={Card}>
            <p class={Muted}>{t.detail_reply_description()}</p>
            if let Some(refused) = refused {
                <div class={Banner} data-tone="danger" role="alert" tabindex="-1">
                    if refused.recovery {
                        <p class={Strong}>{t.recovery_title()}</p>
                        <p>{&refused.message}</p>
                        <p>{t.recovery_draft_kept()}</p>
                        if refused.field {
                            <p><a href={ReplyFeedbackId.fragment()}>{t.detail_reply_feedback()}</a></p>
                        }
                    } else {
                        <p class={Strong}>{t.detail_reply_title()}</p>
                        <p>{&refused.message}</p>
                    }
                </div>
            }
            <form class={Form} method="post" action={action}>
                <input type="hidden" name={f.intent} value="reply">
                <label class={Field}>
                    <span>{t.detail_reply_feedback()}<span class={Required} aria-hidden="true">" *"</span></span>
                    <textarea
                        id={ReplyFeedbackId}
                        name={f.feedback}
                        rows="4"
                        required
                        maxlength={&max}
                        aria-invalid={invalid}
                        aria-description={t.detail_reply_feedback_description()}
                    >
                        {draft}
                    </textarea>
                    <span class={Faint}>{t.detail_reply_feedback_description()}</span>
                </label>
                <div class={Stack}>
                    <p class={Muted}>{t.guidance_description()}</p>
                    <p class={Inline}>
                        <a href={&on_marketplace("/help/buying/community-guidelines-and-enforcement")}>
                            {t.guidance_community_guidelines()}
                        </a>
                        <a href={&on_marketplace("/contact")}>{t.guidance_contact_support()}</a>
                    </p>
                </div>
                <p><button type="submit" class={Primary}>{t.detail_reply_submit()}</button></p>
            </form>
        </div>
    }
}

/// A review not readable yet after its reply (`ReviewDetailRecoveryPage`): the words for it,
/// Refresh review and Back.
#[component(css = ReviewsPage)]
pub fn ReviewPreparing<'a>(t: ReviewsMsg, again: &'a str) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.detail_review()}</p>
                <h1 class={Title}>{t.route_detail_review_preparing()}</h1>
                <p class={Muted}>{t.route_detail_review_preparing_description()}</p>
            </header>
            <section class={Section} aria-labelledby="review-recover">
                <h2 id="review-recover" class={SectionTitle}>{t.recover_recover_review()}</h2>
                <div class={Empty} role="status">
                    <p class={Strong}>{t.route_detail_review_preparing()}</p>
                    <p class={Muted}>{t.recover_review_submission_saved()}</p>
                    <p class={Links}>
                        <a class={Primary} href={again}>{t.recover_refresh_review()}</a>
                        <a class={Secondary} href={url::Reviews::default()}>{t.detail_back()}</a>
                    </p>
                </div>
            </section>
        </div>
    }
}
