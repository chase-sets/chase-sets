//! Platform > Insights: Offer Economics (admin-web's `/platform/insights/offer-economics`,
//! Platform Operations' `OfferEconomicsAdminPage`): the founders' locked-fee cohort's listings,
//! GMV and share of the platform, the fee it forgoes against the standard schedule, its weekly
//! sell-through and the order protection reserve. Read from
//! `GET /api/platform/insights/offer-economics/summary` with `insights-dashboards.view`, which the
//! API asks for. Every figure is the API's; the page only writes them.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/insights/offer-economics?from&to` | the page, for the window `from` to `to` (the API's last 60 days when absent) |
use corten::{axum::http::HeaderMap, prelude::*};
use serde::{Deserialize, Serialize};

pub mod ops;
pub mod views;

use crate::{
    api::segment,
    app::{Shared, read_failed},
    auth::{InsightsView, Staff},
    text::Ops,
};

#[corten::routes(state = crate::app::Shared, area = crate::insights::url::OfferEconomics, caller = crate::auth::Staff<crate::auth::InsightsView>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// The reporting window, as dates (`YYYY-MM-DD`); the API's when absent.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct Window {
        pub from: Option<String>,
        pub to: Option<String>,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/platform/insights/offer-economics", get = offer_economics)]
    pub struct OfferEconomics {
        #[route(query)]
        pub window: Window,
    }
}

/// The area: its route and the page's stylesheet.
pub fn area(area: Area<url::OfferEconomics>, shared: Shared) -> Area<url::OfferEconomics> {
    url::area(area, shared).components(views::COMPONENTS)
}

/// A week of the cohort's sell-through.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Week {
    pub week_start: String,
    pub listings_created_count: u64,
    pub cumulative_listings_created_count: u64,
    pub cumulative_trade_count: u64,
    #[serde(default)]
    pub sell_through_rate: Option<String>,
}

/// The order protection reserve, or why it is not available.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Reserve {
    pub available: bool,
    pub reason: Option<String>,
    pub contribution_amount: String,
    pub allowance_amount: String,
    pub overage_amount: String,
    pub reversal_amount: String,
    pub covered_order_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScheduleSource {
    pub schedule_id: Option<String>,
    pub schedule_label: Option<String>,
}

/// The monitor's figures (`OfferEconomicsSnapshot`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub from: String,
    pub to: String,
    pub listings_created_count: u64,
    pub locked_seller_account_count: u64,
    pub locked_gmv_amount: String,
    pub platform_gmv_amount: String,
    #[serde(default)]
    pub locked_gmv_share_ratio: Option<String>,
    pub standard_fee_percentage_bps: i64,
    pub standard_fee_fixed_amount: String,
    #[serde(default)]
    pub standard_schedule_source: ScheduleSource,
    pub foregone_fee_estimate_amount: String,
    #[serde(default)]
    pub weekly_sell_through: Vec<Week>,
    #[serde(default)]
    pub protection_reserve: Reserve,
}

#[derive(Deserialize)]
struct Summary {
    snapshot: Snapshot,
}

/// A ratio as a percentage with one decimal (admin-web's `(ratio * 100).toFixed(1)%`), or none.
pub fn ratio_percent(ratio: Option<&str>) -> Option<String> {
    let ratio: f64 = ratio?.trim().parse().ok()?;
    Some(format!("{:.1}%", ratio * 100.0))
}

/// The window as the API's query: a date it can read, or nothing.
fn query(window: &url::Window) -> String {
    let date =
        |d: &Option<String>| d.as_deref().map(str::trim).filter(|d| d.parse::<jiff::civil::Date>().is_ok()).map(str::to_owned);
    let parts: Vec<String> = [("from", date(&window.from)), ("to", date(&window.to))]
        .into_iter()
        .filter_map(|(k, v)| v.map(|v| format!("{k}={}", segment(&v))))
        .collect();
    if parts.is_empty() { String::new() } else { format!("?{}", parts.join("&")) }
}

async fn offer_economics(
    req: Req,
    Caller(staff): Caller<Staff<InsightsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::OfferEconomics>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let path = format!("/api/platform/insights/offer-economics/summary{}", query(&route.window));
    let snapshot = match caller.read::<Summary>(&path, "platform-operations").await {
        Ok(summary) => summary.snapshot,
        Err(error) => return read_failed(&req, error, false),
    };
    let o: Ops = req.t();
    let view = html! { <views::OfferEconomicsPage o={o} snapshot={&snapshot} /> };
    req.screen(
        &snapshot,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={o.oe_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_and_ratios_read_as_admin_webs() {
        assert_eq!(ratio_percent(Some("0.1234")), Some("12.3%".into()));
        assert_eq!(ratio_percent(None), None);
        let window = url::Window { from: Some("2026-09-01".into()), to: Some("soon".into()) };
        assert_eq!(query(&window), "?from=2026-09-01", "a date the API cannot read is not sent");
        assert_eq!(query(&url::Window::default()), "");
    }
}
