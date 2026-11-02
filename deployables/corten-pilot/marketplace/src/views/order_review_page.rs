//! An order's review form (Reputation's `ReviewSubmissionPage`): the header with Back, the
//! verified order, and Your review: paused while support looks at the order, closed when its
//! window has, or the form (the rating, the words with the community guidelines, and for a buyer
//! the problems), with Resolve this order first? in place of its buttons when the page asks it.
//!
//! No script. The rating is five radio buttons drawn as stars, filled up to the one chosen by
//! CSS `:has`. Resolve this order first? is drawn by the server after a submit that needs it, its
//! heading focused; Continue with feedback only needs its acknowledgement (`required`) and Go
//! back does not (`formnovalidate`). Marketplace's order protection module, which repeats the
//! verified order's three facts, is left out. One column; from 48rem the facts sit in a row.
use corten::prelude::*;

use super::on_marketplace;
use crate::{
    order_review::{OrderReviewScreen, PROBLEMS, ReviewInput},
    text::{Pilot, ReviewsMsg},
};

/// The words' field, which a refusal links to (marketplace's `review-feedback`).
#[derive(Id)]
pub struct ReviewFeedbackId;
/// Resolve this order first?'s heading, focused when it opens.
#[derive(Id)]
pub struct ResolveTitleId;

/// A label the catalog ends with `": "` or `" "`, as a fact's term.
fn term(label: &str) -> &str {
    label.trim_end_matches([':', ' '])
}

/// A problem's words (`PROBLEM_CATEGORY_LABEL_KEYS`).
fn problem(t: ReviewsMsg, key: &str) -> &'static str {
    match key {
        "not-received" => t.write_problem_category_not_received(),
        "damaged" => t.write_problem_category_damaged(),
        "not-as-described" => t.write_problem_category_not_as_described(),
        "missing-items" => t.write_problem_category_missing_items(),
        "authenticity" => t.write_problem_category_authenticity(),
        _ => t.write_problem_category_other(),
    }
}

/// The page.
#[component(css)]
pub fn OrderReviewPage<'a>(t: ReviewsMsg, p: Pilot, screen: &'a OrderReviewScreen) -> impl Render {
    let o = &screen.opportunity;
    let counterparty = o.subject_display_name.as_deref().unwrap_or(&o.subject_account_id);
    let role = if o.author_role == "buyer" { "seller" } else { "buyer" };
    let description = t.write_feedback_description(role, &o.order_id).to_string();
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.write_reviews()}</p>
                <h1 class={Title}>{t.write_review_counterparty_title(counterparty)}</h1>
                <p class={Muted}>{&description}</p>
                <p><a class={Secondary} href={&screen.back}>{t.write_back()}</a></p>
            </header>
            <section class={Section} aria-labelledby="verified-order-title">
                <h2 id="verified-order-title" class={SectionTitle}>{t.write_verified_order()}</h2>
                <div class={Card}>
                    <p class={Muted}>{t.write_reviews_open_only_after_the_order()}</p>
                    <dl class={Facts}>
                        <div>
                            <dt>{term(t.write_order())}</dt>
                            <dd>{&o.order_id}</dd>
                        </div>
                        <div>
                            <dt>{term(t.write_counterparty())}</dt>
                            <dd>{counterparty}</dd>
                        </div>
                        <div>
                            <dt>{t.write_reviews()}</dt>
                            <dd>{role}</dd>
                        </div>
                    </dl>
                </div>
            </section>
            <section class={Section} aria-labelledby="your-review-title">
                <h2 id="your-review-title" class={SectionTitle}>{t.write_your_review()}</h2>
                if o.submission_state == "held" {
                    <div class={Card}>
                        <div class={Empty}>
                            <p class={Strong}>{t.write_feedback_on_hold_title()}</p>
                            <p class={Muted}>{t.write_feedback_on_hold_description()}</p>
                        </div>
                        <p><a class={Primary} href={&screen.support()}>{t.write_resolution_track_action()}</a></p>
                    </div>
                } else if o.window_expired {
                    <div class={Empty}>
                        <p class={Strong}>{t.write_review_window_closed_title()}</p>
                        <p class={Muted}>{t.write_review_window_closed_description()}</p>
                    </div>
                } else {
                    <ReviewForm t={t} p={p} screen={screen} />
                }
            </section>
        </div>
    }
}

/// Your review's form.
#[component(css = OrderReviewPage)]
fn ReviewForm<'a>(t: ReviewsMsg, p: Pilot, screen: &'a OrderReviewScreen) -> impl Render {
    let f = ReviewInput::FIELDS;
    let invalid = screen.refused.as_ref().is_some_and(|r| r.field).then_some("true");
    html! {
        <div class={Card}>
            if let Some(refused) = &screen.refused {
                <div class={Banner} data-tone="danger" role="alert" tabindex="-1" autofocus>
                    if refused.recovery {
                        <p class={Strong}>{t.recovery_title()}</p>
                        <p>{&refused.message}</p>
                        <p>{t.recovery_draft_kept()}</p>
                        if refused.field {
                            <p><a href={ReviewFeedbackId.fragment()}>{t.write_feedback()}</a></p>
                        }
                    } else {
                        <p class={Strong}>{t.write_your_review()}</p>
                        <p>{&refused.message}</p>
                    }
                </div>
            }
            <form class={Form} method="post" action={&screen.action}>
                <fieldset class={Stars}>
                    <legend class={Strong}>{t.write_rating()}</legend>
                    for n in 1..=5_i64 {
                        <label class={Star}>
                            <input
                                type="radio"
                                name={f.rating}
                                value={n.to_string()}
                                checked={screen.rating == n}
                                required
                                aria-label={p.reviews_rating_star(n).to_string()}
                            >
                            <span aria-hidden="true">"\u{2605}"</span>
                        </label>
                    }
                </fieldset>
                <label class={Field}>
                    <span>{t.write_feedback()}</span>
                    <textarea
                        id={ReviewFeedbackId}
                        name={f.feedback}
                        rows="5"
                        aria-invalid={invalid}
                        aria-description={t.write_tell_the_account_what_went_well()}
                    >
                        {&screen.feedback}
                    </textarea>
                    <span class={Faint}>{t.write_tell_the_account_what_went_well()}</span>
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
                if screen.buyer() {
                    <fieldset class={Problems}>
                        <legend class={Strong}>{t.write_problem_indicators_label()}</legend>
                        <p class={Muted}>{t.write_problem_indicators_description()}</p>
                        for (key, _) in PROBLEMS {
                            <label class={Check}>
                                <input
                                    type="checkbox"
                                    name={f.problem_categories}
                                    value={key}
                                    checked={screen.problems.iter().any(|p| p == key)}
                                >
                                <span>{problem(t, key)}</span>
                            </label>
                        }
                    </fieldset>
                }
                if screen.resolve_first {
                    <Resolve t={t} screen={screen} />
                } else {
                    <div class={Actions}>
                        <button type="submit" class={Primary}>{t.write_submit_account_review()}</button>
                        <button type="submit" class={Secondary} name={f.intent} value="resolve" formnovalidate>
                            {t.write_problem_action()}
                        </button>
                    </div>
                }
            </form>
        </div>
    }
}

/// Resolve this order first? (marketplace's interstitial): Open an order issue (or why one cannot
/// be opened), for a buyer Leave feedback only with its acknowledgement, the privacy note and Go
/// back.
#[component(css = OrderReviewPage)]
fn Resolve<'a>(t: ReviewsMsg, screen: &'a OrderReviewScreen) -> impl Render {
    let f = ReviewInput::FIELDS;
    let buyer = screen.buyer();
    html! {
        <div class={(Card, Tinted)} role="group" aria-labelledby={ResolveTitleId}>
            <h3 id={ResolveTitleId} class={CardTitle} tabindex="-1" autofocus>{t.write_resolution_title()}</h3>
            <p class={Muted}>
                {if buyer { t.write_resolution_buyer_description() } else { t.write_resolution_general_description() }}
            </p>
            if screen.intake_available {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{t.write_resolution_primary_title()}</p>
                    <p>
                        {if buyer {
                            t.write_resolution_primary_description()
                        } else {
                            t.write_resolution_general_primary_description()
                        }}
                    </p>
                    <p><a class={Primary} href={&screen.resolve()}>{t.write_resolution_primary_action()}</a></p>
                </div>
            } else {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.write_resolution_unavailable_title()}</p>
                    <p>{t.write_resolution_unavailable_description()}</p>
                </div>
            }
            if buyer {
                <div class={Banner}>
                    <p class={Strong}>{t.write_resolution_secondary_title()}</p>
                    <p>{t.write_resolution_secondary_description()}</p>
                    <label class={Check}>
                        <input type="checkbox" name={f.feedback_only_acknowledged} value="true" required>
                        <span>{t.write_resolution_secondary_acknowledge()}</span>
                    </label>
                    <p>
                        <button type="submit" class={Secondary} name={f.intent} value="feedback-only">
                            {t.write_resolution_secondary_action()}
                        </button>
                    </p>
                </div>
            }
            <p class={Faint}>{t.write_resolution_privacy_note()}</p>
            <p>
                <button type="submit" class={Ghost} name={f.intent} value="edit" formnovalidate>
                    {t.write_resolution_dismiss()}
                </button>
            </p>
        </div>
    }
}
