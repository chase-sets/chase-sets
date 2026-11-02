//! The CSAT dashboard (`CsatAdminPage`): four rate cards (one column on a phone, two from 40rem,
//! four from 64rem) and two volume cards, the filter form (its fields two to a row from 40rem,
//! four from 64rem), the trend, the rating distribution and the invitation queue as tables that
//! scroll on their own on a phone, the queue's pages, and the projection's freshness.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use serde_json::Value;

use crate::{
    support::csat::{CONSENTS, CsatScreen, OUTCOMES, RATINGS, ROLES, STATES, SURVEY, Slice, url},
    text::{Pilot, Sup},
};

/// A rate as admin-web shows it: a whole percent, else why there is none.
fn rate(t: Sup, value: Option<f64>, availability: &str) -> String {
    match value {
        Some(value) => format!("{}%", (value * 100.0 + 0.5).floor()),
        None => match availability {
            "insufficient-sample" => t.csat_insufficient_sample(),
            "zero-denominator" => t.csat_zero_denominator(),
            "available" => t.csat_available(),
            "incomplete" => t.csat_incomplete(),
            "stale" => t.csat_stale(),
            other => return other.to_owned(),
        }
        .to_owned(),
    }
}

fn state(t: Sup, value: &str) -> String {
    match value {
        "eligible" => t.csat_eligible(),
        "issued" => t.csat_issued(),
        "presented" => t.csat_presented(),
        "submitted" => t.csat_submitted(),
        "dismissed" => t.csat_dismissed(),
        "expired" => t.csat_expired(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn role(t: Sup, value: &str) -> &'static str {
    match value {
        "buyer" => t.csat_buyer(),
        "seller" => t.csat_seller(),
        "account" => t.csat_account_role(),
        _ => t.csat_visitor(),
    }
}

fn consent(t: Sup, value: &str) -> &'static str {
    if value == "granted" { t.csat_granted() } else { t.csat_not_granted() }
}

fn outcome(t: Sup, value: &str) -> String {
    match value {
        "checkout.completed" => t.csat_outcome_checkout_completed(),
        "checkout.recovered" => t.csat_outcome_checkout_recovered(),
        "order.delivered" => t.csat_outcome_order_delivered(),
        "return.resolved" => t.csat_outcome_return_resolved(),
        "support.request-resolved" => t.csat_outcome_support_resolved(),
        "reputation.review-received" => t.csat_outcome_review_received(),
        "listing.published" => t.csat_outcome_listing_published(),
        "offer.accepted" => t.csat_outcome_offer_accepted(),
        "inventory.item-adjusted" => t.csat_outcome_inventory_adjusted(),
        "payout.completed" => t.csat_outcome_payout_completed(),
        "discovery.search-completed" => t.csat_outcome_discovery_completed(),
        "registration.completed" => t.csat_outcome_registration_completed(),
        "authentication.completed" => t.csat_outcome_authentication_completed(),
        "onboarding.completed" => t.csat_outcome_onboarding_completed(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn version(t: Sup, value: &str) -> String {
    if value == SURVEY { t.csat_version_v1().to_owned() } else { value.to_owned() }
}

fn when(t: Sup, at: Option<&str>) -> Option<String> {
    at.and_then(parse_timestamp).map(|at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// A trend bucket's start: its day (buckets are days or weeks in the dashboard's timezone).
fn day(t: Sup, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
}

fn count(value: &Value) -> String {
    value.as_u64().map_or_else(|| value.to_string(), |n| n.to_string())
}

/// A filter's select: All, then the values admin-web offers.
#[component(css = CsatPage)]
fn Choice<'a>(
    t: Sup,
    label: &'a str,
    name: corten::FieldName<String>,
    now: Option<&'a str>,
    values: &'a [&'a str],
    words: &'a dyn Fn(&str) -> String,
) -> impl Render {
    html! {
        <label class={Field}>
            <span>{label}</span>
            <select name={name}>
                <option value="" selected={now.is_none()}>{t.csat_all()}</option>
                for value in values {
                    <option value={*value} selected={now == Some(*value)}>{words(value)}</option>
                }
            </select>
        </label>
    }
}

#[component(css = CsatPage)]
fn Rate<'a>(label: &'a str, value: &'a str) -> impl Render {
    html! {
        <div class={Stat}>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    }
}

#[component(css)]
pub fn CsatPage<'a>(t: Sup, p: Pilot, screen: &'a CsatScreen) -> impl Render {
    let f = url::Filters::FIELDS;
    let chosen = &screen.filters;
    let outcome_words = |v: &str| outcome(t, v);
    let role_words = |v: &str| role(t, v).to_owned();
    let state_words = |v: &str| state(t, v);
    let rating_words = |v: &str| v.to_owned();
    let consent_words = |v: &str| consent(t, v).to_owned();
    let version_words = |v: &str| version(t, v);
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.csat_eyebrow()}</p>
            <h1>{t.csat_title()}</h1>
            <p class={Muted}>{t.csat_description()}</p>
        </header>
        if let Some(data) = &screen.dashboard {
            let (seven, thirty) = (&data.analytics.windows.seven, &data.analytics.windows.thirty);
            <dl class={Rates}>
                <Rate label={t.csat_csat7()} value={&rate(t, seven.csat, &seven.csat_availability)} />
                <Rate label={t.csat_csat30()} value={&rate(t, thirty.csat, &thirty.csat_availability)} />
                <Rate label={t.csat_response7()} value={&rate(t, seven.response_rate, &seven.response_rate_availability)} />
                <Rate label={t.csat_response30()} value={&rate(t, thirty.response_rate, &thirty.response_rate_availability)} />
            </dl>
            <dl class={Volumes}>
                <Rate label={t.csat_submitted()} value={&thirty.volume.submitted.to_string()} />
                <Rate label={t.csat_presented()} value={&thirty.volume.presented.to_string()} />
            </dl>
        }
        <section class={Part}>
            <h2 class={Heading}>{t.csat_filters()}</h2>
            <form class={Filters} method="get" action={url::Csat::default()}>
                <div class={Fields}>
                    <label class={Field}>
                        <span>{t.csat_from()}</span>
                        <input type="date" name={f.from} value={chosen.from.as_deref().unwrap_or_default()} />
                    </label>
                    <label class={Field}>
                        <span>{t.csat_to()}</span>
                        <input type="date" name={f.to} value={chosen.to.as_deref().unwrap_or_default()} />
                    </label>
                    <Choice
                        t={t}
                        label={t.csat_survey_version()}
                        name={f.survey_version}
                        now={chosen.survey_version.as_deref()}
                        values={&[SURVEY]}
                        words={&version_words}
                    />
                    <Choice
                        t={t}
                        label={t.csat_outcome()}
                        name={f.outcome_codes}
                        now={chosen.outcome.as_deref()}
                        values={&OUTCOMES}
                        words={&outcome_words}
                    />
                    <Choice
                        t={t}
                        label={t.csat_role()}
                        name={f.customer_roles}
                        now={chosen.role.as_deref()}
                        values={&ROLES}
                        words={&role_words}
                    />
                    <Choice
                        t={t}
                        label={t.csat_state()}
                        name={f.states}
                        now={chosen.state.as_deref()}
                        values={&STATES}
                        words={&state_words}
                    />
                    <Choice
                        t={t}
                        label={t.csat_rating()}
                        name={f.ratings}
                        now={chosen.rating.as_deref()}
                        values={&RATINGS}
                        words={&rating_words}
                    />
                    <Choice
                        t={t}
                        label={t.csat_consent()}
                        name={f.follow_up_consent}
                        now={chosen.consent.as_deref()}
                        values={&CONSENTS}
                        words={&consent_words}
                    />
                </div>
                <button type="submit" class={Button}>{t.csat_apply()}</button>
            </form>
        </section>
        if let Some(data) = &screen.dashboard {
            <section class={Part}>
                <h2 class={Heading}>{t.csat_trend()}</h2>
                if data.analytics.trend.items.is_empty() {
                    <Empty t={t} />
                } else {
                    <div class={Scroll}>
                        <table class={Table} aria-label={t.csat_trend()}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.csat_bucket()}</th>
                                    <th scope="col">{t.csat_csat()}</th>
                                    <th scope="col">{t.csat_response_rate()}</th>
                                    <th scope="col">{t.csat_submitted()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for bucket in &data.analytics.trend.items {
                                    <tr>
                                        <td class={Nowrap}>{day(t, &bucket.bucket_start)}</td>
                                        <td class={Nowrap}>{rate(t, bucket.slice.csat, &bucket.slice.csat_availability)}</td>
                                        <td class={Nowrap}>
                                            {rate(t, bucket.slice.response_rate, &bucket.slice.response_rate_availability)}
                                        </td>
                                        <td>{bucket.slice.volume.submitted}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Part}>
                <h2 class={Heading}>{t.csat_distribution()}</h2>
                <Distribution t={t} slice={&data.analytics.windows.thirty} />
            </section>
            <section class={Part}>
                <h2 class={Heading}>{t.csat_queue()}</h2>
                if data.queue.items.is_empty() {
                    <Empty t={t} />
                } else {
                    <div class={Scroll}>
                        <table class={Table} aria-label={t.csat_queue()}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.csat_invitation()}</th>
                                    <th scope="col">{t.csat_state()}</th>
                                    <th scope="col">{t.csat_version()}</th>
                                    <th scope="col">{t.csat_outcome()}</th>
                                    <th scope="col">{t.csat_rating()}</th>
                                    <th scope="col">{t.csat_submission()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for item in &data.queue.items {
                                    <tr>
                                        <td class={Words}>{&item.invitation_id}</td>
                                        <td><span class={Pill}>{state(t, &item.state)}</span></td>
                                        <td>{version(t, &item.survey_version.survey_version)}</td>
                                        <td>{outcome(t, &item.outcome_code)}</td>
                                        <td>
                                            {item.rating.map_or_else(|| t.csat_not_available().to_owned(), |r| r.to_string())}
                                        </td>
                                        <td>
                                            {when(t, item.submitted_at.as_deref()).unwrap_or_else(|| t.csat_not_available().to_owned())}
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
                if data.queue.previous_cursor.is_some() || data.queue.next_cursor.is_some() {
                    <nav class={Pages} aria-label={t.csat_queue()}>
                        if let Some(cursor) = &data.queue.previous_cursor {
                            <a class={(Button, Secondary)} href={chosen.at(Some((cursor, "previous")))}>{t.csat_previous()}</a>
                        }
                        if let Some(cursor) = &data.queue.next_cursor {
                            <a class={Button} href={chosen.at(Some((cursor, "next")))}>{t.csat_next()}</a>
                        }
                    </nav>
                }
            </section>
            <section class={Part}>
                <h2 class={Heading}>{t.csat_data_quality()}</h2>
                <p class={Muted}>
                    {t.csat_last_projected()}
                    {": "}
                    {when(t, data.analytics.health.last_projected_at.as_deref()).unwrap_or_else(|| t.csat_incomplete().to_owned())}
                </p>
                <p class={Muted}>{t.csat_safe_export()}</p>
            </section>
        } else {
            <p class={Alert} role="alert">{p.error_failed()}</p>
        }
    }
}

#[component(css = CsatPage)]
fn Empty(t: Sup) -> impl Render {
    html! {
        <div class={EmptyBox}>
            <p class={EmptyTitle}>{t.csat_empty_title()}</p>
            <p class={Muted}>{t.csat_empty_description()}</p>
        </div>
    }
}

/// The 30-day rating distribution: each rating and its count.
#[component(css = CsatPage)]
fn Distribution<'a>(t: Sup, slice: &'a Slice) -> impl Render {
    html! {
        <div class={Scroll}>
            <table class={Table} aria-label={t.csat_distribution()}>
                <thead>
                    <tr>
                        <th scope="col">{t.csat_rating()}</th>
                        <th scope="col">{t.csat_count()}</th>
                    </tr>
                </thead>
                <tbody>
                    for (rating, n) in &slice.rating_distribution {
                        <tr>
                            <td>{rating}</td>
                            <td>{count(n)}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
    }
}
