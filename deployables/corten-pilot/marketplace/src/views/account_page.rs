//! An account's public page, after discovery's `routes/public-account.tsx`: the account's standing
//! (`AccountCredibilityHeader`), the seller's chips, its feedback as a seller and as a buyer with a
//! page of reviews (`RatingDistribution`, `ReviewCard`, Reputation's `ReviewReportAction` and
//! `ReviewScoringContext`), the order confidence promises, and its active listings
//! (`ListingCard`). One column on a phone; the facts two by two from 40rem and in a row from
//! 64rem, the two ratings side by side from 48rem, the listings two by two from 64rem.
use corten::{
    i18n::{DateStyle, MonthStyle, parse_timestamp},
    prelude::*,
};

use super::{listing_page::options, on_marketplace};
use crate::{
    accounts::{AccountScreen, MOST_DETAILS, REASONS, ReviewNotice, ReviewReportFields, Role},
    api::{AccountListing, AccountReview, PublicAccount},
    app::url,
    items::Address,
    text::{AccountMsg, Pilot},
};

/// The feedback section, which the role and page links go to.
#[derive(Id)]
pub struct FeedbackId;
/// The picture every listing card shows (`discoveryAssetUrls.defaultProductImage`).
const CARD_BACK: &str = "/fake-cdn/assets/pokemon_tcg_back.png";

/// A review, so a redirect after its report can bring the browser back to it.
#[derive(Id)]
pub struct ReviewId<'a>(pub &'a str);

/// A review's Report review dialog.
#[derive(Id)]
pub struct ReportDialogId<'a>(pub &'a str);

/// A rating as the API writes it (`"4.50"`), when it is a number.
fn rating(text: Option<&str>) -> Option<f64> {
    text.and_then(|r| r.trim().parse::<f64>().ok()).filter(|r| r.is_finite())
}

/// A share of `total`, as a whole percent (`ratingPercent`).
fn percent(count: u64, total: u64) -> u64 {
    if total == 0 { 0 } else { ((count as f64 / total as f64) * 100.0).round() as u64 }
}

/// One side of the account's ratings (`AccountRatingDimension`).
pub struct Side {
    pub average: Option<f64>,
    pub reviews: u64,
    pub ratings: u64,
    /// Ratings of 5, 4, 3, 2 and 1, in that order.
    pub counts: [u64; 5],
}

impl Side {
    pub fn seller(a: &PublicAccount) -> Self {
        Side {
            average: rating(a.average_rating_as_seller.as_deref()),
            reviews: a.review_count_as_seller,
            ratings: a.rating_count_as_seller,
            counts: [
                a.rating_5_count_as_seller,
                a.rating_4_count_as_seller,
                a.rating_3_count_as_seller,
                a.rating_2_count_as_seller,
                a.rating_1_count_as_seller,
            ],
        }
    }

    pub fn buyer(a: &PublicAccount) -> Self {
        Side {
            average: rating(a.average_rating_as_buyer.as_deref()),
            reviews: a.review_count_as_buyer,
            ratings: a.rating_count_as_buyer,
            counts: [
                a.rating_5_count_as_buyer,
                a.rating_4_count_as_buyer,
                a.rating_3_count_as_buyer,
                a.rating_2_count_as_buyer,
                a.rating_1_count_as_buyer,
            ],
        }
    }
}

/// Where a listing ships from (`buyerFulfillmentLabel`), by its location's code.
fn fulfillment(t: AccountMsg, code: Option<&str>) -> String {
    let code = code.map(str::trim).filter(|c| !c.is_empty()).map(str::to_ascii_uppercase);
    match code.as_deref() {
        None => t.page_fulfillment_confirmed_at_checkout().to_owned(),
        Some(c) if c.starts_with("STL") => t.page_ships_from("St. Louis, MO").to_string(),
        Some(c) if c.starts_with("CHI") => t.page_ships_from("Chicago, IL").to_string(),
        Some(_) => t.page_account_fulfillment_center().to_owned(),
    }
}

/// A listing's purchase limit (`purchaseLimitLabel`), the strictest kind first. Marketplace writes
/// these in English in the route, not from the catalog.
fn limit(listing: &AccountListing) -> Option<String> {
    if let Some(n) = listing.max_units_per_customer_account.filter(|n| *n > 0) {
        return Some(format!("Limit {n} per customer"));
    }
    if let Some(n) = listing.max_units_per_day.filter(|n| *n > 0) {
        return Some(format!("Limit {n} per day"));
    }
    listing.max_units_per_order.filter(|n| *n > 0).map(|n| format!("Limit {n} per order"))
}

/// A listing's price (`formatMoney`), or "Price unavailable" without a currency.
fn price(t: AccountMsg, listing: &AccountListing) -> String {
    match (listing.price_currency_code.as_deref(), platform::money::decimal(&listing.price_amount)) {
        (Some(code), Some(amount)) => match corten::i18n::Currency::parse(code.trim()) {
            Some(currency) => t.money(amount, currency).to_string(),
            None => format!("{} {}", listing.price_amount, code.trim().to_ascii_uppercase()),
        },
        (Some(code), None) => format!("{} {}", listing.price_amount, code.trim().to_ascii_uppercase()),
        (None, _) => t.price_unavailable().to_owned(),
    }
}

/// The page numbers Pagination shows (`buildPageRange`): all of them up to seven, else the first,
/// the last and the ones beside the current, with a gap (`None`) where some are left out.
pub fn page_range(page: u64, pages: u64) -> Vec<Option<u64>> {
    if pages <= 7 {
        return (1..=pages).map(Some).collect();
    }
    let mut out = vec![Some(1)];
    if page > 3 {
        out.push(None);
    }
    out.extend((page.saturating_sub(1).max(2)..=(page + 1).min(pages - 1)).map(Some));
    if page + 2 < pages {
        out.push(None);
    }
    out.push(Some(pages));
    out
}

/// The page.
#[component(css)]
pub fn AccountPage<'a>(t: AccountMsg, p: Pilot, screen: &'a AccountScreen) -> impl Render {
    let account = &screen.account;
    let name = account.account_display_name.as_deref().unwrap_or(t.page_account());
    html! {
        <div class={Page}>
            if account.status != "active" {
                <section class={Card}>
                    <h1 class={Title}>{t.page_account_unavailable()}</h1>
                    <p class={Muted}>{&t.page_account_profile_unavailable_description(name).to_string()}</p>
                </section>
            } else {
                <Header t={t} account={account} name={name} />
                <Chips t={t} screen={screen} />
                <section id={FeedbackId} class={Feedback} aria-labelledby="account-feedback-heading">
                    <h2 id="account-feedback-heading" class={SectionTitle}>{t.page_feedback()}</h2>
                    <div class={Sides}>
                        <Distribution t={t} title={t.page_as_seller()} side={&Side::seller(account)} />
                        <Distribution t={t} title={t.page_as_buyer()} side={&Side::buyer(account)} />
                    </div>
                    <ul class={Roles}>
                        for (role, label) in [(None, t.page_all_roles()), (Some(Role::Seller), t.page_as_seller()), (Some(Role::Buyer), t.page_as_buyer())] {
                            <li>
                                <a
                                    class={if screen.role == role { Primary } else { Secondary }}
                                    href={&screen.feedback_href(role, 1)}
                                    aria-current={(screen.role == role).then_some("page")}
                                >
                                    {label}
                                </a>
                            </li>
                        }
                    </ul>
                    if account.reviews.items.is_empty() {
                        <p class={Muted}>{t.page_no_written_feedback()}</p>
                    } else {
                        <ol class={Reviews}>
                            for review in &account.reviews.items {
                                <ReviewCard t={t} p={p} screen={screen} review={review} />
                            }
                        </ol>
                    }
                    if account.reviews.total > crate::accounts::REVIEWS_PER_PAGE {
                        <Pager p={p} screen={screen} />
                    }
                </section>
                <section class={Confidence} aria-labelledby="account-confidence-heading">
                    <h2 id="account-confidence-heading" class={ConfidenceTitle}>{t.page_buyer_confidence()}</h2>
                    <ul class={Promises}>
                        <li>
                            <p class={Strong}>{t.page_verified_account_status()}</p>
                            <p class={Muted}>{t.page_verified_account_status_description()}</p>
                        </li>
                        <li>
                            <p class={Strong}>{t.page_clear_listing_details()}</p>
                            <p class={Muted}>{t.page_clear_listing_details_description()}</p>
                        </li>
                        <li>
                            <p class={Strong}>{t.page_secure_checkout()}</p>
                            <p class={Muted}>{t.page_secure_checkout_description()}</p>
                        </li>
                    </ul>
                </section>
                if account.listings.is_empty() {
                    <section class={Card}>
                        <h2 class={CardTitle}>{t.page_no_active_listings()}</h2>
                        <p class={Muted}>{t.page_this_account_does_not_have_active()}</p>
                        <p>
                            <a class={Primary} href={&url::Search { terms: crate::search::Terms::default() }.href()}>
                                {t.page_browse_marketplace()}
                            </a>
                        </p>
                    </section>
                } else {
                    <ul class={Listings} aria-label={t.page_active_listings()}>
                        for (index, listing) in account.listings.iter().enumerate() {
                            <ListingCard t={t} account={account} name={name} listing={listing} index={index} />
                        }
                    </ul>
                }
            }
        </div>
    }
}

/// The account's standing (`AccountCredibilityHeader`): its name and badges, what kind of profile
/// it is, Contact and Report, four facts and the two policies.
#[component(css = AccountPage)]
fn Header<'a>(t: AccountMsg, account: &'a PublicAccount, name: &'a str) -> impl Render {
    let seller = rating(account.average_rating_as_seller.as_deref()).filter(|_| account.rating_count_as_seller > 0);
    let since = account.created_at.as_deref().and_then(parse_timestamp).map(|at| t.date(at, MonthStyle::Long).to_string());
    let founder = account.badges.iter().any(|b| b == "founding-account").then(|| match account.founder_number {
        Some(n) if n > 0 => format!("{} #{n:03}", t.badges_founder()),
        _ => t.badges_founder().to_owned(),
    });
    let summary = if account.active_listing_count > 0 {
        t.page_verified_marketplace_account_profile()
    } else {
        t.page_new_account_protected_checkout()
    };
    html! {
        <section class={Card} aria-labelledby="account-name">
            <div class={HeadRow}>
                <div class={Stack}>
                    <div class={Inline}>
                        <h1 id="account-name" class={Title}>{name}</h1>
                        <span class={Badge} data-tone="trust">{t.page_verified_account()}</span>
                        if account.badges.iter().any(|b| b == "trusted-seller") {
                            <span class={Badge} data-tone="policy" title={t.badges_trusted_seller_explainer()}>
                                {t.badges_trusted_seller()}
                            </span>
                        }
                        if let Some(founder) = &founder {
                            <span class={Badge} data-tone="trust" title={t.badges_founder_explainer()}>{founder}</span>
                        }
                    </div>
                    <p class={Muted}>{summary}</p>
                </div>
                <div class={Inline}>
                    <a class={Secondary} href={url::SignIn { ask: crate::sign_in::Ask::back_to("/account/messages") }}>
                        {t.page_sign_in_to_contact_account()}
                    </a>
                    <a class={Ghost} href={&on_marketplace("/support")}>{t.page_report_account()}</a>
                </div>
            </div>
            <dl class={Facts}>
                <div>
                    <dt>{t.page_active_listings()}</dt>
                    <dd>{account.active_listing_count}</dd>
                </div>
                <div>
                    <dt>{t.page_review_history()}</dt>
                    <dd>
                        match seller {
                            Some(value) => { <Stars value={value} count={Some(account.rating_count_as_seller)} /> }
                            None => { {t.page_no_feedback_yet()} }
                        }
                    </dd>
                </div>
                <div>
                    <dt>{t.page_member_since_label()}</dt>
                    <dd>{since.as_deref().unwrap_or(t.page_member_since_unknown())}</dd>
                </div>
                <div>
                    <dt>{t.page_response_time()}</dt>
                    <dd>{t.page_responds_through_order_updates()}</dd>
                </div>
            </dl>
            <ul class={Policies}>
                <li>
                    <p class={Strong}>{t.page_buyer_protection()}</p>
                    <p class={Muted}>{t.page_buyer_protection_description()}</p>
                </li>
                <li>
                    <p class={Strong}>{t.page_return_refund_policy()}</p>
                    <p class={Muted}>{t.page_policies_confirmed_before_payment()}</p>
                </li>
            </ul>
        </section>
    }
}

/// The seller's chips (`BehavioralMetricsChipRow`): each only when the API says its rate is
/// confidently good; nothing when none is.
#[component(css = AccountPage)]
fn Chips<'a>(t: AccountMsg, screen: &'a AccountScreen) -> impl Render {
    let labels: Vec<&str> = screen.chips.as_ref().map_or_else(Vec::new, |c| {
        [
            (c.ships_on_time == Some(true)).then(|| t.page_chips_ships_on_time()),
            (c.low_cancellation_rate == Some(true)).then(|| t.page_chips_rarely_cancels()),
            (c.low_dispute_rate == Some(true)).then(|| t.page_chips_rarely_disputed()),
        ]
        .into_iter()
        .flatten()
        .collect()
    });
    html! {
        if !labels.is_empty() {
            <ul class={Inline}>
                for label in &labels {
                    <li class={Badge} data-tone="success">{*label}</li>
                }
            </ul>
        }
    }
}

/// A star and a rating with one decimal, and how many it is from (`RatingSummary`).
#[component(css = AccountPage)]
fn Stars(value: f64, count: Option<u64>) -> impl Render {
    html! {
        <span class={Rating}>
            <span class={Star} aria-hidden="true">"\u{2605}"</span>
            <span class={Strong}>{format!("{value:.1}")}</span>
            if let Some(count) = count {
                <span>{format!("({count})")}</span>
            }
        </span>
    }
}

/// One side's ratings (`RoleRatingDistribution`): the average, how many, and the share of each
/// star rating.
#[component(css = AccountPage)]
fn Distribution<'a>(t: AccountMsg, title: &'a str, side: &'a Side) -> impl Render {
    let count = if side.ratings == 0 {
        t.page_no_feedback_yet().to_owned()
    } else if side.ratings == side.reviews {
        side.ratings.to_string()
    } else {
        t.page_ratings_included(side.ratings, side.reviews).to_string()
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

/// A review (`ReviewCard`): who wrote it and when, in which role the account was reviewed, the
/// rating, how it counts, what it says, the account's reply, and Report review.
#[component(css = AccountPage)]
fn ReviewCard<'a>(t: AccountMsg, p: Pilot, screen: &'a AccountScreen, review: &'a AccountReview) -> impl Render {
    let author = review.author_display_name.as_deref().unwrap_or(t.page_marketplace_buyer());
    let date = review.submitted_at.as_deref().or(review.updated_at.as_deref()).and_then(parse_timestamp);
    let byline = match date {
        Some(at) => t.page_review_byline(author, &t.date(at, DateStyle::Medium).to_string()).to_string(),
        None => author.to_owned(),
    };
    let role = if review.author_role == "buyer" { t.page_as_seller() } else { t.page_as_buyer() };
    let reply = review.reply_feedback.as_deref().filter(|_| review.reply_status.as_deref() == Some("active"));
    let notice = screen.notice.as_ref().filter(|(id, _)| *id == review.review_id).map(|(_, notice)| notice);
    html! {
        <li id={ReviewId(&review.review_id)} class={Review}>
            <div class={ReviewHead}>
                <div>
                    <p class={Strong}>{&byline}</p>
                    <p class={Faint}>{role}</p>
                </div>
                <div class={Inline}>
                    <Stars value={f64::from(review.rating)} count={None} />
                    <span class={Badge} data-tone="trust">{p.account_verified_purchase()}</span>
                </div>
            </div>
            if review.scoring_disposition.as_deref() == Some("context-only") {
                <span class={Badge}>{t.page_context_only_rating()}</span>
            }
            <Scoring t={t} review={review} />
            <p class={Body}>{review.feedback.as_deref().unwrap_or(t.page_no_written_feedback())}</p>
            if let Some(reply) = reply {
                <p class={Reply}><span class={Strong}>{t.page_review_reply_label()}</span>" "{reply}</p>
            }
            <div class={ReviewActions} role="group" aria-label={p.account_review_actions()}>
                <ReportAction t={t} p={p} screen={screen} review={&review.review_id} notice={notice} />
            </div>
        </li>
    }
}

/// How a review counts toward the rating (`ReviewScoringContext`): included or not, why, and the
/// remedy; nothing for a review from before scoring.
#[component(css = AccountPage)]
fn Scoring<'a>(t: AccountMsg, review: &'a AccountReview) -> impl Render {
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
                <div class={Inline}>
                    <span class={Badge} data-tone={if included { "success" } else { "neutral" }}>
                        {if included { t.scoring_included() } else { t.scoring_excluded() }}
                    </span>
                    if let Some(outcome) = outcome {
                        <span class={Badge}>{outcome}</span>
                    }
                    if let Some(remedy) = remedy {
                        <span class={Badge} data-tone="accent">{remedy}</span>
                    }
                </div>
                <p class={Muted}>{if included { t.scoring_included_description() } else { t.scoring_excluded_description() }}</p>
            </div>
        }
    }
}

/// Report review (`ReviewReportAction`): its button opens a dialog with the reason and an
/// explanation. Once sent it says so and the button is off. A refused report draws the dialog open
/// again with what was sent, modal once it joins the page (`corten_ui::dialog::modal`).
#[component(css = AccountPage)]
fn ReportAction<'a>(
    t: AccountMsg,
    p: Pilot,
    screen: &'a AccountScreen,
    review: &'a str,
    notice: Option<&'a ReviewNotice>,
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
    let dialog = ReportDialogId(review);
    let heading = format!("report-dialog-{review}-title");
    let f = ReviewReportFields::FIELDS;
    let max = MOST_DETAILS.to_string();
    html! {
        <div class={Stack}>
            if sent {
                <div class={Banner} data-tone="success" role="status">
                    <p class={Strong}>{title}</p>
                    <p>{description}</p>
                </div>
            }
            <button type="button" class={Ghost} command="show-modal" commandfor={ReportDialogId(review)} disabled={sent}>
                <span aria-hidden="true">"\u{26a0}"</span>" "{title}
            </button>
            if !sent {
                <dialog
                    id={dialog}
                    class={Dialog}
                    aria-labelledby={&heading}
                    open={refused.is_some()}
                    on:connect={corten_ui::dialog::modal(target)}
                >
                    <div class={DialogHead}>
                        <h3 id={&heading} class={CardTitle}>{t.report_title()}</h3>
                        <button type="button" class={Ghost} command="close" commandfor={ReportDialogId(review)}>
                            {p.account_report_close()}
                        </button>
                    </div>
                    <p class={Muted}>{t.report_description()}</p>
                    <form class={Form} method="post" action={&screen.report_href(review)}>
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

/// The reviews' pages (`Pagination`), as links to each page at the feedback: Previous, the
/// numbers, Next.
#[component(css = AccountPage)]
fn Pager<'a>(p: Pilot, screen: &'a AccountScreen) -> impl Render {
    let (page, pages) = (screen.page, screen.pages());
    let range = page_range(page, pages);
    html! {
        <nav class={Pager} aria-label={p.account_pagination()}>
            if page > 1 {
                <a class={Secondary} href={&screen.feedback_href(screen.role, page - 1)}>{p.account_previous_page()}</a>
            }
            <ul class={Inline}>
                for number in &range {
                    <li>
                        match number {
                            Some(n) => {
                                <a
                                    class={if *n == page { Primary } else { Secondary }}
                                    href={&screen.feedback_href(screen.role, *n)}
                                    aria-current={(*n == page).then_some("page")}
                                    aria-label={&p.account_page_number(*n).to_string()}
                                >
                                    {*n}
                                </a>
                            }
                            None => { <span class={Faint} aria-hidden="true">"\u{2026}"</span> }
                        }
                    </li>
                }
            </ul>
            if page < pages {
                <a class={Secondary} href={&screen.feedback_href(screen.role, page + 1)}>{p.account_next_page()}</a>
            }
        </nav>
    }
}

/// One of the account's listings (`ListingCard`): the picture, its product's options and how many
/// there are, the title, the price, the seller, where it ships from, and View listing and Compare.
#[component(css = AccountPage)]
fn ListingCard<'a>(
    t: AccountMsg,
    account: &'a PublicAccount,
    name: &'a str,
    listing: &'a AccountListing,
    index: usize,
) -> impl Render {
    let title = listing.item_title.as_deref().unwrap_or(t.page_marketplace_listing());
    let chips = options(listing.product_summary.as_deref());
    let alt = match (listing.item_title.as_deref().map(str::trim).filter(|s| !s.is_empty()), chips.is_empty()) {
        (Some(title), false) => format!("{title}, {}", chips.join(", ")),
        (Some(title), true) => title.to_owned(),
        (None, false) => chips.join(", "),
        (None, true) => t.page_pokemon_card_back().to_owned(),
    };
    let available = t.page_quantity_available(listing.visible_quantity).to_string();
    let detail = match limit(listing) {
        Some(limit) => format!("{available} | {limit}"),
        None => available.clone(),
    };
    let seller = rating(account.average_rating_as_seller.as_deref()).filter(|_| account.rating_count_as_seller > 0);
    let trust = match seller {
        Some(r) => t.page_reputation_rating(&format!("{r:.1}"), account.rating_count_as_seller).to_string(),
        None => t.page_verified_account().to_owned(),
    };
    let item = listing.catalog_item_slug.as_deref().filter(|s| !s.is_empty()).unwrap_or(&listing.catalog_catalog_item_id);
    let feedback = crate::accounts::feedback(&account.account_slug);
    html! {
        <li class={Listing}>
            <img
                class={Media}
                src={&on_marketplace(CARD_BACK)}
                alt={&alt}
                loading={if index < 2 { "eager" } else { "lazy" }}
                decoding="async"
            >
            <div class={ListingBody}>
                <div class={Inline}>
                    if chips.is_empty() {
                        <span class={Chip}>{t.page_standard_product()}</span>
                    } else {
                        <span class={Chip}>{&chips.join(" \u{2022} ")}</span>
                    }
                    <span class={Faint}>{&available}</span>
                </div>
                <h3 class={ListingTitle}>{title}</h3>
                <p class={Muted}>{t.page_price_quantity_and_account_visible()}</p>
                <p class={Price}>{&price(t, listing)}</p>
                <p class={Faint}>{&detail}</p>
                <div class={Inline}>
                    <a class={Strong} href={&feedback}>{name}</a>
                    if let Some(value) = seller {
                        <Stars value={value} count={Some(account.rating_count_as_seller)} />
                    }
                    <span class={Badge} data-tone="trust">{&trust}</span>
                </div>
                <p class={Muted}>{&fulfillment(t, listing.ship_from_code.as_deref())}</p>
                <span class={Badge} data-tone="success">{t.page_buyer_protected()}</span>
                <div class={Inline}>
                    <a
                        class={Secondary}
                        href={&url::PublicListing { slug: &listing.listing_slug, reported: Default::default() }.href()}
                    >
                        {t.page_view_listing()}
                    </a>
                    <a
                        class={Secondary}
                        href={&url::Item { slug: item, state: Address::default(), after: Default::default() }.href()}
                    >
                        {t.page_compare()}
                    </a>
                </div>
            </div>
        </li>
    }
}

#[cfg(test)]
mod tests {
    use super::{page_range, percent};

    #[test]
    fn pages_and_shares_are_counted_as_marketplace_counts_them() {
        assert_eq!(page_range(1, 3), [Some(1), Some(2), Some(3)]);
        assert_eq!(page_range(1, 9), [Some(1), Some(2), None, Some(9)]);
        assert_eq!(page_range(5, 9), [Some(1), None, Some(4), Some(5), Some(6), None, Some(9)]);
        assert_eq!(page_range(9, 9), [Some(1), None, Some(8), Some(9)]);
        assert_eq!((percent(1, 3), percent(2, 3), percent(0, 0)), (33, 67, 0));
    }
}
