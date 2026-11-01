//! The recommendations' page (marketplace's `PricingRecommendationListPage`): the header with
//! Repricing policies, Refresh, Listings, Bulk reprice and Import; the market signals (how many
//! recommendations, the seller's stock, active listings and offers); the running job's notice; what a
//! write was refused for; and the recommendations as one form, each with its box, item, action,
//! market, recommended price and signals, and Apply selected and Dismiss selected. Every action is
//! a form or a link. One column on a phone, where the table is a card per row; the signals two to
//! a row, four from 48rem.
use corten::prelude::*;

use crate::{
    api::{Recommendation, RecommendationJob},
    app::url,
    recommendations::{RecommendationsForm, RecommendationsScreen},
    text::{Pilot, RepricingMsg},
};

/// The part a running job's relay draws again once it finished.
#[derive(Id)]
pub struct RecommendationsPartId;
/// The job's notice, drawn again on each of its events.
#[derive(Id)]
pub struct RecommendationsNoticeId;

/// An amount to two places in the market's currency, or Not set (`money`).
fn money(t: RepricingMsg, amount: Option<f64>, currency: &str) -> String {
    let Some(amount) = amount else { return t.recs_not_set().to_owned() };
    let fixed = format!("{amount:.2}");
    match (platform::money::decimal(&fixed), corten::i18n::Currency::parse(currency.trim())) {
        (Some(value), Some(currency)) => t.money(value, currency).to_string(),
        _ => fixed,
    }
}

/// What applying a recommendation does (`actionLabel`).
fn action(t: RepricingMsg, row: &Recommendation) -> String {
    match row.action_type.as_str() {
        "active-listing-price-update" => t.recs_update_active().to_owned(),
        "draft-listing-price-update" => t.recs_update_draft().to_owned(),
        "draft-listing-create" => t.recs_create_draft().to_owned(),
        other => other.to_owned(),
    }
}

/// The status badge's tone (`statusTone`).
fn tone(status: &str) -> &'static str {
    match status {
        "applied" => "success",
        "failed" => "danger",
        "dismissed" => "neutral",
        _ => "info",
    }
}

/// A language code's name (`formatLanguageCodeLabel`): English, Japanese, or the code.
fn language(t: RepricingMsg, code: &str) -> &str {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => t.language_en(),
        "ja" => t.language_ja(),
        _ => code.trim(),
    }
}

/// The page: its part, relayed live while a job runs.
#[component(css)]
pub fn RecommendationsPage<'a>(t: RepricingMsg, p: Pilot, screen: &'a RecommendationsScreen) -> impl Render {
    let live = screen.job.as_ref().filter(|_| screen.active()).map(|job| url::RecommendationsLive { id: &job.job_id }.href());
    html! {
        if let Some(src) = live {
            <corten-live class={Live} src={&src}>
                <Part t={t} p={p} screen={screen} />
            </corten-live>
        } else {
            <Part t={t} p={p} screen={screen} />
        }
    }
}

/// The part drawn on the page and again by the job's relay once it finished.
pub fn recommendations_part<'a>(t: RepricingMsg, p: Pilot, screen: &'a RecommendationsScreen) -> impl Render + 'a {
    html! { <Part t={t} p={p} screen={screen} /> }
}

/// The job's notice, drawn again on each of its events.
pub fn recommendations_notice<'a>(t: RepricingMsg, job: &'a RecommendationJob) -> impl Render + 'a {
    html! { <Notice t={t} job={Some(job)} /> }
}

/// The running or finished job's notice (`MarketplaceNotice`): its progress message or error.
#[component(css = RecommendationsPage)]
fn Notice<'a>(t: RepricingMsg, job: Option<&'a RecommendationJob>) -> impl Render {
    let message = job.and_then(|job| job.error_message.as_deref().or(job.progress.message.as_deref()));
    let failed = job.is_some_and(|job| job.status == "failed");
    html! {
        <div id={RecommendationsNoticeId} data-recommendations-job={job.map(|job| job.status.as_str()).unwrap_or("none")}>
            if let Some(message) = message {
                <div class={Banner} data-tone={if failed { "danger" } else { "success" }} role="status">
                    <p class={Strong}>{t.recs_pricing()}</p>
                    <p>{message}</p>
                </div>
            }
        </div>
    }
}

#[component(css = RecommendationsPage)]
fn Part<'a>(t: RepricingMsg, p: Pilot, screen: &'a RecommendationsScreen) -> impl Render {
    let busy = screen.active();
    let items = &screen.items;
    let stock: u64 = items.iter().map(|r| r.stock_on_hand_quantity).sum();
    let offers: u64 = items.iter().map(|r| r.active_offer_count).sum();
    let listings: u64 = items.iter().map(|r| r.active_listing_count).sum();
    let n = |v: u64| t.number(v).to_string();
    let f = RecommendationsForm::FIELDS;
    let action_url = url::Recommendations::default().href();
    let stats = [
        (t.recs_recommendations(), n(items.len() as u64), t.recs_items_with_feed_data()),
        (t.recs_seller_stock(), n(stock), t.recs_units_on_hand()),
        (t.recs_active_listings(), n(listings), t.recs_market_competition()),
        (t.recs_active_offers(), n(offers), t.recs_buyer_demand()),
    ];
    html! {
        <div id={RecommendationsPartId} class={Part} data-recommendations-busy={if busy { "true" } else { "false" }}>
            <header class={Header}>
                <p class={Eyebrow}>{t.recs_seller()}</p>
                <h1 class={Title}>{t.recs_recommendations()}</h1>
                <p class={Muted}>{t.recs_review_market_signals_and_copy()}</p>
                <nav class={Row} aria-label={p.recommendations_pages()}>
                    <a class={(Button, Secondary)} href={url::Repricing::default()}>{t.list_caption()}</a>
                    if screen.manage {
                        <form class={Inline} method="post" action={&action_url}>
                            <button type="submit" class={Button} name={f.intent} value="refresh-recommendations" disabled={busy}>
                                {t.recs_refresh()}
                            </button>
                        </form>
                    }
                    <a class={(Button, Secondary)} href={url::SellerListings::default()}>{t.recs_listings()}</a>
                    <a class={(Button, Secondary)} href={url::BulkReprice::default()}>{t.recs_bulk_reprice()}</a>
                    <a class={(Button, Ghost)} href={url::Imports::default()}>{t.recs_import()}</a>
                </nav>
            </header>
            <section class={(Card, Section)} aria-labelledby="recs-signals-title">
                <div class={Tight}>
                    <h2 id="recs-signals-title" class={PartTitle}>{t.recs_market_signals()}</h2>
                    <p class={Muted}>{t.recs_pricing_is_advisory()}</p>
                </div>
                <dl class={Stats}>
                    for (label, value, detail) in &stats {
                        <div class={Stat}>
                            <dt>{*label}</dt>
                            <dd>{value}</dd>
                            <dd class={Hint}>{*detail}</dd>
                        </div>
                    }
                </dl>
            </section>
            <Notice t={t} job={screen.job.as_ref()} />
            if let Some(error) = &screen.error {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.recs_pricing()}</p>
                    <p>{error}</p>
                </div>
            }
            <section class={Section} aria-labelledby="recs-list-title">
                <h2 id="recs-list-title" class={PartTitle}>{t.recs_recommendations()}</h2>
                <form class={Tight} method="post" action={&action_url}>
                    if screen.manage {
                        <div class={(Row, Batch)}>
                            <p class={Muted}>{t.recs_batch_notice()}</p>
                            <p class={Row}>
                                <button
                                    type="submit"
                                    class={Button}
                                    name={f.intent}
                                    value="apply-recommendations"
                                    disabled={busy}
                                >
                                    {t.recs_apply_selected()}
                                </button>
                                <button
                                    type="submit"
                                    class={(Button, Ghost)}
                                    name={f.intent}
                                    value="dismiss-recommendations"
                                    disabled={busy}
                                >
                                    {t.recs_dismiss_selected()}
                                </button>
                            </p>
                        </div>
                    }
                    if items.is_empty() {
                        <div class={(Card, Empty)} data-recommendations-empty="true">
                            <p class={Strong}>{t.recs_no_recommendations()}</p>
                            <p class={Muted}>{t.recs_feed_data_will_appear()}</p>
                        </div>
                    } else {
                        <table class={Table} data-recommendations="true">
                            <caption class={Hidden}>{t.recs_recommendations()}</caption>
                            <thead>
                                <tr>
                                    if screen.manage {
                                        <th scope="col"><span class={Hidden}>{t.recs_select()}</span></th>
                                    }
                                    <th scope="col">{t.recs_item()}</th>
                                    <th scope="col">{t.recs_action()}</th>
                                    <th scope="col" class={Number}>{t.recs_market()}</th>
                                    <th scope="col" class={Number}>{t.recs_recommended()}</th>
                                    <th scope="col">{t.recs_signals()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in items {
                                    <Row t={t} row={row} manage={screen.manage} busy={busy} field={f.recommendation_id} />
                                }
                            </tbody>
                        </table>
                    }
                </form>
            </section>
        </div>
    }
}

/// A recommendation's row.
#[component(css = RecommendationsPage)]
fn Row<'a>(t: RepricingMsg, row: &'a Recommendation, manage: bool, busy: bool, field: FieldName<String>) -> impl Render {
    let title = row.catalog_item_title.as_deref().unwrap_or(&row.catalog_catalog_item_id);
    let cur = row.market_currency.as_str();
    let done = matches!(row.status.as_str(), "applied" | "dismissed");
    let anchor = if row.market_signal_type == "offer" { t.recs_offer_anchor() } else { t.recs_competition_anchor() };
    let item_status = row.catalog_item_status.as_deref().unwrap_or(t.recs_unknown());
    html! {
        <tr data-recommendation={&row.recommendation_id}>
            if manage {
                <td class={Pick}>
                    <input
                        type="checkbox"
                        name={field}
                        value={&row.recommendation_id}
                        aria-label={t.recs_select_recommendation(title).to_string()}
                        disabled={busy || done}
                    >
                </td>
            }
            <th scope="row" data-label={t.recs_item()}>
                <span class={Strong}>{title}</span>
                if let Some(subtitle) = &row.catalog_item_subtitle {
                    <span class={Hint}>{subtitle}</span>
                }
                <span class={Badges}>
                    if let Some(code) = &row.catalog_item_language_code {
                        <span class={Badge} data-tone="neutral">{language(t, code)}</span>
                    }
                    <span
                        class={Badge}
                        data-tone={if row.catalog_item_status.as_deref() == Some("active") { "success" } else { "neutral" }}
                    >
                        {item_status}
                    </span>
                    <span class={Badge} data-tone={tone(&row.status)}>{&row.status}</span>
                </span>
            </th>
            <td data-label={t.recs_action()}>
                <span>{action(t, row)}</span>
                <span class={Hint}>{anchor}</span>
            </td>
            <td class={Number} data-label={t.recs_market()}>
                <span class={Strong}>{money(t, row.market_price_amount, cur)}</span>
                <span class={Hint}>{t.recs_lowest_active(&money(t, row.lowest_listing_price_amount, cur)).to_string()}</span>
            </td>
            <td class={Number} data-label={t.recs_recommended()}>
                <span class={Strong}>{money(t, row.recommended_list_amount, cur)}</span>
                <span class={Hint}>{t.recs_current_price(&money(t, row.current_price_amount, cur)).to_string()}</span>
                <span class={Hint}>{row.recommendation_reason.as_deref().unwrap_or(t.recs_no_reason())}</span>
            </td>
            <td data-label={t.recs_signals()}>
                <span>
                    {t.recs_offer_signal(&row.active_offer_count.to_string(), &money(t, row.highest_offer_price_amount, cur)).to_string()}
                </span>
                <span class={Hint}>
                    {t.recs_fulfillment_signal(&row.delivered_quantity.to_string(), &row.returned_quantity.to_string()).to_string()}
                </span>
                if let Some(error) = &row.last_error {
                    <span class={Hint} data-tone="danger">{error}</span>
                }
            </td>
        </tr>
    }
}
