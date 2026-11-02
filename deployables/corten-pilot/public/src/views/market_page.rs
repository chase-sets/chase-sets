//! The market page, after Pricing's `market-price-history-page.tsx`: the breadcrumb, the item's
//! title, then for each currency it has traded in its price history (the median, or last, price
//! of each day, with the day's low to high as a band) and its market stats (last sold, the 30-
//! and 90-day medians and their trades, active listings and the lowest asks, the 30-day
//! sell-through), then links to buy or sell it on marketplace. An item with no trades yet shows
//! one empty chart and empty stats, as public-web does. No script.
use corten::{
    i18n::{Currency, DateStyle, parse_timestamp},
    prelude::*,
};
use platform::chart::{Chart, Point, TimeSeries};

use crate::{
    api::{Aggregate, MarketPage as Page},
    text::{MarketMsg, Pilot},
};

/// What the page draws: Pricing's page data, public-web's home and the item's page on
/// marketplace (every Buy or sell link).
pub struct Screen {
    pub page: Page,
    pub home: String,
    pub item: String,
}

/// An amount in the request's locale (`formatMoney`), or "No data yet" without one.
fn money(t: MarketMsg, amount: Option<&str>, currency: Option<&str>) -> String {
    let (Some(amount), Some(currency)) = (amount.map(str::trim).filter(|a| !a.is_empty()), currency) else {
        return t.page_no_data().to_owned();
    };
    match (platform::money::decimal(amount), Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()),
    }
}

/// A ratio as a whole percentage (`percent`): `0.4567` is 46%.
fn percent(ratio: Option<&str>) -> Option<String> {
    let value = ratio?.trim().parse::<f64>().ok().filter(|v| v.is_finite())?;
    Some(format!("{}%", (value * 100.0).round()))
}

/// One currency's chart and stats (public-web's `Fragment` per aggregate).
struct Group {
    currency: Option<String>,
    history: String,
    stats: String,
    chart: Chart,
    summary: String,
    summary_id: String,
    last_sold: String,
    last_sold_on: Option<String>,
    median30: String,
    trades30: String,
    median90: String,
    trades90: String,
    sell_through: Option<String>,
}

impl Group {
    fn of(t: MarketMsg, p: Pilot, page: &Page, aggregate: Option<&Aggregate>, several: bool) -> Self {
        let currency = aggregate.map(|a| a.currency_code.clone());
        let code = currency.as_deref();
        let amount = |a: &Option<String>| a.as_deref().and_then(|a| a.trim().parse::<f64>().ok());
        let points = page
            .series
            .iter()
            .filter(|point| point.currency_code.as_deref() == code)
            .map(|point| Point {
                day: &point.day,
                value: amount(&point.median_price_amount).or(amount(&point.last_price_amount)),
                band: amount(&point.min_price_amount).zip(amount(&point.max_price_amount)),
                mark: None,
            })
            .collect();
        let chart = Chart::of(points);
        let price = |v: f64| money(t, Some(&format!("{v:.2}")), code);
        let summary = match &chart {
            Chart::Plot(plot) => p.chart_summary(&page.title, plot.count, &price(plot.min), &price(plot.max)).to_string(),
            Chart::Empty | Chart::Insufficient => String::new(),
        };
        let (history, stats) = match code.filter(|_| several) {
            Some(c) => (t.page_price_history_currency(c).to_string(), t.page_market_stats_currency(c).to_string()),
            None => (t.page_price_history().to_owned(), t.page_market_stats().to_owned()),
        };
        let a = aggregate;
        Group {
            summary_id: format!("price-history-{}", code.unwrap_or("none").to_ascii_lowercase()),
            history,
            stats,
            chart,
            summary,
            last_sold: money(t, a.and_then(|a| a.last_sold_price_amount.as_deref()), code),
            last_sold_on: a
                .and_then(|a| a.last_sold_at.as_deref())
                .and_then(parse_timestamp)
                .map(|at| t.date(at, DateStyle::Medium).to_string()),
            median30: money(t, a.and_then(|a| a.median_price30d.as_deref()), code),
            trades30: t.page_trades_count(a.map_or(0, |a| a.trade_count30d)).to_string(),
            median90: money(t, a.and_then(|a| a.median_price90d.as_deref()), code),
            trades90: t.page_trades_count(a.map_or(0, |a| a.trade_count90d)).to_string(),
            sell_through: percent(a.and_then(|a| a.sell_through_rate.as_deref()))
                .map(|rate| t.page_sell_through(&rate).to_string()),
            currency,
        }
    }
}

/// The page.
#[component(css)]
pub fn MarketPage<'a>(t: MarketMsg, p: Pilot, screen: &'a Screen) -> impl Render {
    let page = &screen.page;
    let several = page.aggregates.len() > 1;
    let groups: Vec<Group> = if page.aggregates.is_empty() {
        vec![Group::of(t, p, page, None, false)]
    } else {
        page.aggregates.iter().map(|a| Group::of(t, p, page, Some(a), several)).collect()
    };
    let label = t.page_chart_label(&page.title).to_string();
    let listings = page.market_state.as_ref().map_or(0, |s| s.active_listing_count);
    let asks: Vec<String> = page
        .live_asks
        .iter()
        .map(|ask| t.page_starting_at(&money(t, Some(&ask.min_ask_amount), Some(&ask.currency_code))).to_string())
        .collect();
    html! {
        <div class={Wide}>
            <nav class={Crumbs} aria-label={p.shell_breadcrumb()}>
                <ol>
                    <li><a href={&screen.home}>{t.page_home()}</a></li>
                    <li aria-current="page">{&page.title}</li>
                </ol>
            </nav>
            <header class={Head}>
                <h1 class={Title}>{&page.title}</h1>
                if let Some(subtitle) = page.subtitle.as_deref().filter(|s| !s.is_empty()) {
                    <p class={Subtitle}>{subtitle}</p>
                }
            </header>
            for (index, group) in groups.iter().enumerate() {
                <section class={Section} aria-labelledby={format!("{}-heading", group.summary_id)}>
                    <h2 class={SectionTitle} id={format!("{}-heading", group.summary_id)}>{&group.history}</h2>
                    match &group.chart {
                        Chart::Plot(plot) => {
                            <TimeSeries plot={plot} label={&label} summary={&group.summary} summary_id={&group.summary_id} />
                        }
                        Chart::Empty => { <Empty title={p.chart_empty_title()} text={p.chart_empty_description()} /> }
                        Chart::Insufficient => {
                            <Empty title={p.chart_insufficient_title()} text={p.chart_insufficient_description()} />
                        }
                    }
                </section>
                <section
                    class={Section}
                    aria-labelledby={format!("{}-stats", group.summary_id)}
                    data-currency={group.currency.as_deref()}
                >
                    <h2 class={SectionTitle} id={format!("{}-stats", group.summary_id)}>{&group.stats}</h2>
                    <dl class={Stats}>
                        <div class={Stat}>
                            <dt>{t.page_last_sold()}</dt>
                            <dd class={Value}>{&group.last_sold}</dd>
                            if let Some(on) = &group.last_sold_on {
                                <dd>{on}</dd>
                            }
                        </div>
                        <div class={Stat}>
                            <dt>{t.page_median_30_day()}</dt>
                            <dd class={Value}>{&group.median30}</dd>
                            <dd>{&group.trades30}</dd>
                        </div>
                        <div class={Stat}>
                            <dt>{t.page_median_90_day()}</dt>
                            <dd class={Value}>{&group.median90}</dd>
                            <dd>{&group.trades90}</dd>
                        </div>
                        <div class={Stat}>
                            <dt>{t.page_active_listings()}</dt>
                            <dd class={Value}>{&listings.to_string()}</dd>
                            // The lowest asks are the market's, not a currency's: shown once.
                            if index == 0 {
                                if asks.is_empty() {
                                    <dd>
                                        {if page.unpriced_buyable_listing_count > 0 {
                                            t.page_price_unavailable()
                                        } else {
                                            t.page_no_live_asks()
                                        }}
                                    </dd>
                                }
                                for ask in &asks {
                                    <dd>{ask}</dd>
                                }
                            }
                        </div>
                    </dl>
                    if let Some(rate) = &group.sell_through {
                        <p class={Badge}>{rate}</p>
                    }
                </section>
            }
            <section class={Section} aria-labelledby="buy-or-sell">
                <h2 class={SectionTitle} id="buy-or-sell">{t.page_buy_or_sell()}</h2>
                <div class={Actions}>
                    <a class={Primary} href={&screen.item}>{t.page_view_active_listings()}</a>
                    <a class={Secondary} href={&screen.item}>{t.page_create_a_price_alert()}</a>
                    <a class={Secondary} href={&screen.item}>{t.page_sell_yours()}</a>
                </div>
            </section>
        </div>
    }
}

/// The design system's chart `EmptyState`: its chart icon, a title and what to expect.
#[component(css = MarketPage)]
fn Empty<'a>(title: &'a str, text: &'a str) -> impl Render {
    html! {
        <div class={EmptyChart}>
            <span class={Icon} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
                    <path
                        d="M4 20h16M7 16v-5M12 16V7M17 16v-8"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                    ></path>
                </svg>
            </span>
            <p class={EmptyTitle}>{title}</p>
            <p class={Muted}>{text}</p>
        </div>
    }
}
