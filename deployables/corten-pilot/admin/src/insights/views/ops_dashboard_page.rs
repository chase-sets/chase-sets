//! The Ops Dashboard (`OpsDashboardAdminPage`). Top to bottom: the header, the range form (its
//! fields side by side from 40rem), the figures (one column on a phone, three from 40rem), GMV over
//! time (a line drawn on the server, its points listed for screen readers), liquidity, the top
//! catalog items and the reconciliation runs (tables that scroll on their own on a phone).
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::{date, usd};
use crate::{
    insights::{
        ops::{GRANULARITIES, OpsScreen, Point, RANGES, url},
        ratio_percent,
    },
    text::{Ops, Pilot},
};

/// The chart's box, as admin-web's `TimeSeriesChart` draws it: 640 by 220 with 12 of padding.
const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 220.0;
const PAD: f64 = 12.0;

/// The line through `points` (seconds, value) as an SVG path in the chart's box: time across, the
/// value up, the values' range padded by 8% each way (by 1 when they are all one value), as
/// admin-web's chart does. None under two points, which is not a trend.
pub fn trend(points: &[(i64, f64)]) -> Option<String> {
    let mut points = points.to_vec();
    points.sort_by_key(|(at, _)| *at);
    let (first, last) = (points.first()?.0, points.last()?.0);
    if points.len() < 2 {
        return None;
    }
    let (low, high) = points.iter().fold((f64::MAX, f64::MIN), |(lo, hi), (_, v)| (lo.min(*v), hi.max(*v)));
    let pad = if high > low { (high - low) * 0.08 } else { (high.abs() * 0.08).max(1.0) };
    let (low, high) = (low - pad, high + pad);
    let span = |at: i64| if last > first { (at - first) as f64 / (last - first) as f64 } else { 0.0 };
    let path: Vec<String> = points
        .iter()
        .enumerate()
        .map(|(i, (at, v))| {
            let x = PAD + span(*at) * (WIDTH - 2.0 * PAD);
            let y = PAD + (high - v) / (high - low) * (HEIGHT - 2.0 * PAD);
            format!("{}{x:.1},{y:.1}", if i == 0 { "M" } else { "L" })
        })
        .collect();
    Some(path.join(" "))
}

/// A bucket's first day as seconds, and its GMV, when both read.
fn sample(point: &Point) -> Option<(i64, f64)> {
    let day: jiff::civil::Date = point.day.get(..10)?.parse().ok()?;
    let at = day.to_zoned(jiff::tz::TimeZone::UTC).ok()?.timestamp().as_second();
    Some((at, point.gmv_amount.trim().parse().ok()?))
}

fn range_label(o: Ops, days: &str) -> &'static str {
    match days {
        "7" => o.od_range_last7_days(),
        "90" => o.od_range_last90_days(),
        "365" => o.od_range_last365_days(),
        _ => o.od_range_last30_days(),
    }
}

fn granularity_label(o: Ops, granularity: &str) -> &'static str {
    match granularity {
        "weekly" => o.od_granularity_weekly(),
        "monthly" => o.od_granularity_monthly(),
        _ => o.od_granularity_daily(),
    }
}

#[component(css = OpsDashboardPage)]
fn Figure<'a>(label: &'a str, value: String) -> impl Render {
    html! {
        <div class={Stat}>
            <p class={Muted}>{label}</p>
            <p class={Value}>{value}</p>
        </div>
    }
}

#[component(css = OpsDashboardPage)]
fn Nothing<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Empty}>
            <p class={Strong}>{title}</p>
            <p class={Muted}>{description}</p>
        </div>
    }
}

/// GMV over time: the line, and its points for screen readers; or why there is no line.
#[component(css = OpsDashboardPage)]
fn Trend<'a>(o: Ops, p: Pilot, series: &'a [Point]) -> impl Render {
    let samples: Vec<(i64, f64)> = series.iter().filter_map(sample).collect();
    let line = trend(&samples);
    html! {
        if samples.is_empty() {
            <Nothing title={p.chart_empty_title()} description={p.chart_empty_description()} />
        } else if let Some(line) = line {
            <svg
                class={Chart}
                viewBox="0 0 640 220"
                role="img"
                aria-label={o.od_trend_chart_label()}
                aria-describedby="od-trend-points"
                focusable="false"
            >
                <path
                    d={line}
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
            <ul class={Hidden} id="od-trend-points">
                for point in series {
                    <li>{o.od_chart_point_label(&date(o, &point.day), &usd(o, &point.gmv_amount)).to_string()}</li>
                }
            </ul>
        } else {
            <Nothing title={p.chart_insufficient_title()} description={p.chart_insufficient_description()} />
        }
    }
}

#[component(css)]
pub fn OpsDashboardPage<'a>(o: Ops, p: Pilot, screen: &'a OpsScreen) -> impl Render {
    let f = url::View::FIELDS;
    let s = &screen.summary;
    let n = |v: u64| o.number(v).to_string();
    let na = || o.od_not_available().to_owned();
    let when = |at: &str| {
        parse_timestamp(at).map_or_else(|| at.to_owned(), |w| o.date_time(w, DateStyle::Medium, TimeStyle::Short).to_string())
    };
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{o.od_eyebrow()}</p>
                <h1>{o.od_title()}</h1>
                <p class={Muted}>{o.od_description()}</p>
            </header>
            <section class={Card} aria-labelledby="od-range">
                <h2 class={Heading} id="od-range">{o.od_range()}</h2>
                <form class={Range} method="get" action={url::OpsDashboard::default()}>
                    <label class={Field}>
                        <span>{o.od_range_label()}</span>
                        <select name={f.range_days}>
                            for days in RANGES {
                                <option value={days} selected={screen.range_days == days}>{range_label(o, days)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{o.od_granularity_label()}</span>
                        <select name={f.granularity}>
                            for g in GRANULARITIES {
                                <option value={g} selected={screen.granularity == g}>{granularity_label(o, g)}</option>
                            }
                        </select>
                    </label>
                    <button class={Button} type="submit">{o.projections_apply_filters()}</button>
                </form>
                <p class={Muted}>{o.oe_window_range(&date(o, &s.from), &date(o, &s.to)).to_string()}</p>
            </section>
            <div class={Stats}>
                <Figure label={o.od_gmv()} value={usd(o, &s.summary.gmv_amount)} />
                <Figure label={o.od_trade_count()} value={n(s.summary.trade_count)} />
                <Figure label={o.od_order_count()} value={n(s.summary.order_count)} />
                <Figure label={o.od_active_buyers()} value={n(s.summary.active_buyer_count)} />
                <Figure label={o.od_active_sellers()} value={n(s.summary.active_seller_count)} />
                <Figure label={o.od_verified_trade_count()} value={n(s.summary.verified_trade_count)} />
            </div>
            <section class={Card} aria-labelledby="od-trend">
                <h2 class={Heading} id="od-trend">{o.od_trend()}</h2>
                <Trend o={o} p={p} series={&screen.series} />
            </section>
            <section class={Card} aria-labelledby="od-liquidity">
                <h2 class={Heading} id="od-liquidity">{o.od_liquidity()}</h2>
                <div class={Stats}>
                    <Figure
                        label={o.od_sell_through_rate()}
                        value={ratio_percent(s.liquidity.sell_through_rate.as_deref()).unwrap_or_else(na)}
                    />
                    <Figure
                        label={o.od_median_spread()}
                        value={s.liquidity.median_spread_amount.as_deref().map_or_else(na, |a| usd(o, a))}
                    />
                    <Figure label={o.od_spread_sample_count()} value={n(s.liquidity.spread_sample_count)} />
                </div>
                <p class={Muted}>{o.od_time_to_sale_unavailable()}</p>
            </section>
            <section class={Card} aria-labelledby="od-top">
                <h2 class={Heading} id="od-top">{o.od_top_catalog_items()}</h2>
                if s.top_catalog_items.is_empty() {
                    <Nothing
                        title={o.od_top_catalog_items_empty_title()}
                        description={o.od_top_catalog_items_empty_description()}
                    />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.od_catalog_item()}</th>
                                    <th scope="col">{o.od_gmv()}</th>
                                    <th scope="col">{o.od_trade_count()}</th>
                                    <th scope="col">{o.od_unit_volume()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for item in &s.top_catalog_items {
                                    <tr>
                                        <td class={Words}>{item.title.as_deref().unwrap_or(&item.catalog_item_id)}</td>
                                        <td>{usd(o, &item.gmv_amount)}</td>
                                        <td>{n(item.trade_count)}</td>
                                        <td>{n(item.unit_volume)}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="od-reconciliation">
                <h2 class={Heading} id="od-reconciliation">{o.od_reconciliation()}</h2>
                <p class={Muted}>{o.od_reconciliation_description()}</p>
                if screen.runs.is_empty() {
                    <Nothing title={o.od_reconciliation_empty_title()} description={o.od_reconciliation_empty_description()} />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.od_month()}</th>
                                    <th scope="col">{o.od_status()}</th>
                                    <th scope="col">{o.od_tape_gmv()}</th>
                                    <th scope="col">{o.od_ledger_sale_total()}</th>
                                    <th scope="col">{o.od_delta()}</th>
                                    <th scope="col">{o.od_completed_at()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for run in &screen.runs {
                                    <tr>
                                        <td>{&run.year_month}</td>
                                        <td>
                                            if run.status == "drift-alarm" {
                                                <span class={(Pill, Bad)}>{o.od_status_drift_alarm()}</span>
                                            } else {
                                                <span class={(Pill, Good)}>{o.od_status_ok()}</span>
                                            }
                                        </td>
                                        <td>{usd(o, &run.tape_gmv_amount)}</td>
                                        <td>{usd(o, &run.ledger_sale_amount)}</td>
                                        <td>
                                            {match ratio_percent(run.delta_ratio.as_deref()) {
                                                Some(ratio) => format!("{} ({ratio})", usd(o, &run.delta_amount)),
                                                None => usd(o, &run.delta_amount),
                                            }}
                                        </td>
                                        <td>{when(&run.completed_at)}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::trend;

    #[test]
    fn the_trend_is_drawn_in_admin_webs_box() {
        assert_eq!(trend(&[]), None);
        assert_eq!(trend(&[(0, 5.0)]), None, "one point is not a trend");
        // Two days, 10 then 20: the range 10..20 padded by 0.8 each way.
        assert_eq!(trend(&[(86_400, 20.0), (0, 10.0)]).as_deref(), Some("M12.0,194.5 L628.0,25.5"));
        // A flat line sits in the middle of its padded range.
        assert_eq!(trend(&[(0, 0.0), (86_400, 0.0)]).as_deref(), Some("M12.0,110.0 L628.0,110.0"));
    }
}
