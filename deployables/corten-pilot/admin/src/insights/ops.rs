//! Platform > Insights: Ops Dashboard (admin-web's `/platform/insights/ops-dashboard`, Platform
//! Operations' `OpsDashboardAdminPage`): platform GMV, volume and liquidity for a range of days,
//! GMV over time, the top catalog items by GMV, and the monthly tape-vs-ledger reconciliation runs.
//! Read from `/api/platform/insights/ops/{summary,series,reconciliation-runs}` with
//! `insights-dashboards.view`, which the API asks for. Every figure is the API's.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/insights/ops-dashboard?rangeDays&granularity` | the page: the last 7, 30 (when absent), 90 or 365 days, by day (when absent), week or month |
//!
//! admin-web's range form has no submit control, so its range cannot be applied
//! (chase-sets/chase-sets#10874); the pilot's has one.
use corten::{axum::http::HeaderMap, prelude::*};
use jiff::{Timestamp, ToSpan, civil::Date, tz::TimeZone};
use serde::{Deserialize, Serialize};

use super::views;
use crate::{
    api::segment,
    app::{Shared, read_failed},
    auth::{InsightsView, Staff},
    text::Ops,
};

const CONTEXT: &str = "platform-operations";
const API: &str = "/api/platform/insights/ops";
/// The ranges admin-web offers, in days; 30 when absent or anything else.
pub const RANGES: [&str; 4] = ["7", "30", "90", "365"];
/// The chart's granularities; daily when absent or anything else.
pub const GRANULARITIES: [&str; 3] = ["daily", "weekly", "monthly"];
/// The reconciliation runs shown (admin-web's `limit: "12"`).
const RUNS: u32 = 12;

#[corten::routes(state = crate::app::Shared, area = crate::insights::ops::url::OpsDashboard, caller = crate::auth::Staff<crate::auth::InsightsView>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The range and granularity, as admin-web's form sends them.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct View {
        pub range_days: Option<String>,
        pub granularity: Option<String>,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/platform/insights/ops-dashboard", get = ops_dashboard)]
    pub struct OpsDashboard {
        #[route(query)]
        pub view: View,
    }
}

/// The area: its route and the page's stylesheet.
pub fn area(area: Area<url::OpsDashboard>, shared: Shared) -> Area<url::OpsDashboard> {
    url::area(area, shared).components(views::OPS)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Kpis {
    pub gmv_amount: String,
    pub trade_count: u64,
    pub order_count: u64,
    pub unit_volume: u64,
    pub verified_trade_count: u64,
    pub active_buyer_count: u64,
    pub active_seller_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Liquidity {
    pub as_of_day: String,
    pub sell_through_rate: Option<String>,
    pub median_spread_amount: Option<String>,
    pub spread_sample_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct TopItem {
    pub catalog_item_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub gmv_amount: String,
    pub trade_count: u64,
    pub unit_volume: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub summary: Kpis,
    #[serde(default)]
    pub liquidity: Liquidity,
    #[serde(default)]
    pub top_catalog_items: Vec<TopItem>,
}

/// A bucket of the GMV series: its first day and its GMV.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub day: String,
    pub gmv_amount: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Series {
    #[serde(default)]
    pub series: Vec<Point>,
}

/// A month's tape-vs-ledger reconciliation run.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub reconciliation_run_id: String,
    pub year_month: String,
    pub tape_gmv_amount: String,
    pub ledger_sale_amount: String,
    pub delta_amount: String,
    #[serde(default)]
    pub delta_ratio: Option<String>,
    pub status: String,
    pub completed_at: String,
}

#[derive(Deserialize)]
struct Runs {
    #[serde(default)]
    items: Vec<Run>,
}

/// The page as drawn.
#[derive(Serialize, ToJson)]
pub struct OpsScreen {
    pub range_days: String,
    pub granularity: String,
    pub summary: Summary,
    pub series: Vec<Point>,
    pub runs: Vec<Run>,
}

/// The range asked for, or 30 days (admin-web's `normalizeRangeDays`).
pub fn range_days(asked: Option<&str>) -> &'static str {
    RANGES.into_iter().find(|r| Some(*r) == asked).unwrap_or("30")
}

/// The granularity asked for, or daily (admin-web's `normalizeGranularity`).
pub fn granularity(asked: Option<&str>) -> &'static str {
    GRANULARITIES.into_iter().find(|g| Some(*g) == asked).unwrap_or("daily")
}

/// The range's first and last day in UTC, today last (admin-web's loader).
pub fn window(today: Date, range_days: &str) -> (Date, Date) {
    let days: i64 = range_days.parse().unwrap_or(30);
    (today.checked_sub((days - 1).days()).unwrap_or(today), today)
}

async fn ops_dashboard(
    req: Req,
    Caller(staff): Caller<Staff<InsightsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::OpsDashboard>,
) -> HtmlResult {
    let range_days = range_days(route.view.range_days.as_deref());
    let granularity = granularity(route.view.granularity.as_deref());
    let (from, to) = window(Timestamp::now().to_zoned(TimeZone::UTC).date(), range_days);
    let (from, to) = (segment(&from.to_string()), segment(&to.to_string()));
    let caller = config.platform.caller(&headers, config.proto, None);
    let (summary_path, series_path, runs_path) = (
        format!("{API}/summary?from={from}&to={to}"),
        format!("{API}/series?from={from}&to={to}&granularity={granularity}"),
        format!("{API}/reconciliation-runs?limit={RUNS}"),
    );
    let read = tokio::try_join!(
        caller.read::<Summary>(&summary_path, CONTEXT),
        caller.read::<Series>(&series_path, CONTEXT),
        caller.read::<Runs>(&runs_path, CONTEXT),
    );
    let (summary, series, runs) = match read {
        Ok(read) => read,
        Err(error) => return read_failed(&req, error, false),
    };
    let screen = OpsScreen {
        range_days: range_days.to_owned(),
        granularity: granularity.to_owned(),
        summary,
        series: series.series,
        runs: runs.items,
    };
    let o: Ops = req.t();
    let view = html! { <views::OpsDashboardPage o={o} p={req.t()} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={o.od_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_range_and_granularity_read_as_admin_webs() {
        assert_eq!(range_days(Some("90")), "90");
        assert_eq!(range_days(Some("14")), "30");
        assert_eq!(range_days(None), "30");
        assert_eq!(granularity(Some("weekly")), "weekly");
        assert_eq!(granularity(Some("hourly")), "daily");
        let today = jiff::civil::date(2026, 10, 31);
        assert_eq!(window(today, "30"), (jiff::civil::date(2026, 10, 2), today), "30 days, today the last");
        assert_eq!(window(today, "7"), (jiff::civil::date(2026, 10, 25), today));
    }
}
