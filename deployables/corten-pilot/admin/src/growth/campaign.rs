//! Growth > Campaign Analytics (admin-web's `/growth/campaign-analytics`, Public Presence's
//! `CampaignAnalyticsPage`): the wave-1 admission bar and progress toward it, the cohort's quality,
//! game coverage, inventory sizes, channel attribution, and a link to the funnel dashboard. Read from
//! `/api/public-presence/admin/waitlist/campaign-analytics` with `public-presence.view`.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /growth/campaign-analytics` | the page |
use std::collections::BTreeMap;

use corten::{axum::http::HeaderMap, prelude::*};
use serde::{Deserialize, Serialize};

use super::views;
use crate::{
    app::{Shared, read_failed},
    auth::{GrowthView, Staff},
    text::Gro,
};

const CONTEXT: &str = "public-presence";
const PATH: &str = "/api/public-presence/admin/waitlist/campaign-analytics";
/// admin-web's Grafana funnel dashboard, on its own host (`FUNNEL_DASHBOARD_HREF`).
pub const FUNNEL_DASHBOARD: &str = "/grafana/d/chase-sets-public-presence-waitlist/public-presence-waitlist-funnel";
/// The inventory sizes, in admin-web's order (`WAITLIST_INVENTORY_SIZES`).
pub const INVENTORY_SIZES: [&str; 4] = ["under_100", "100_to_500", "500_to_2000", "2000_plus"];

#[corten::routes(state = crate::app::Shared, area = crate::growth::campaign::url::Campaign, caller = crate::auth::Staff<crate::auth::GrowthView>)]
pub mod url {
    #[route("/growth/campaign-analytics", get = page)]
    pub struct Campaign;
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Campaign>, shared: Shared) -> Area<url::Campaign> {
    url::area(area, shared).components(views::CAMPAIGN)
}

/// The wave-1 admission bar's goals, as the analytics read returns them.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Goals {
    pub min_total_signups: u64,
    pub min_qualified_sellers: u64,
    pub min_qualified_sellers_per_game: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub total_signups: u64,
    pub seller_signup_count: u64,
    pub qualified_seller_count: u64,
    pub store_link_percent: f64,
    #[serde(default)]
    pub inventory_size_distribution: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Channel {
    #[serde(default)]
    pub utm_source: Option<String>,
    #[serde(default)]
    pub utm_medium: Option<String>,
    #[serde(default)]
    pub utm_campaign: Option<String>,
    pub signup_count: u64,
    pub seller_signup_count: u64,
    pub qualified_seller_count: u64,
}

impl Channel {
    /// admin-web's `channelLabel`: the UTM source, medium and campaign it has, or none.
    pub fn label(&self) -> Option<String> {
        let parts: Vec<&str> = [&self.utm_source, &self.utm_medium, &self.utm_campaign]
            .into_iter()
            .filter_map(|p| p.as_deref())
            .filter(|p| !p.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join(" / "))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub game: String,
    pub qualified_seller_count: u64,
    pub covered: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub goals: Goals,
    pub total_signups: u64,
    pub qualified_seller_count: u64,
    pub total_signups_met: bool,
    pub qualified_sellers_met: bool,
    #[serde(default)]
    pub game_coverage: Vec<Coverage>,
    #[serde(default)]
    pub admitted: bool,
}

/// The page's one read.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    pub quality: Quality,
    #[serde(default)]
    pub channel_attribution: Vec<Channel>,
    pub admission_bar: Admission,
}

/// Progress toward `goal` as a percentage, at most 100 (admin-web's `progressPercent`).
pub fn progress(count: u64, goal: u64) -> u64 {
    count.saturating_mul(100).checked_div(goal).map_or(100, |percent| percent.min(100))
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<GrowthView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let analytics = match caller.read::<Analytics>(PATH, CONTEXT).await {
        Ok(found) => found,
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Gro = req.t();
    let view = html! { <views::CampaignPage t={t} analytics={&analytics} /> };
    req.screen(
        &analytics,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.route_campaign_analytics()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_and_channels_read_as_admin_webs() {
        assert_eq!((progress(250, 500), progress(600, 500), progress(1, 0)), (50, 100, 100));
        let channel = |s: Option<&str>, m: Option<&str>| Channel {
            utm_source: s.map(Into::into),
            utm_medium: m.map(Into::into),
            utm_campaign: None,
            signup_count: 1,
            seller_signup_count: 0,
            qualified_seller_count: 0,
        };
        assert_eq!(channel(Some("discord"), Some("social")).label().as_deref(), Some("discord / social"));
        assert_eq!(channel(None, None).label(), None);
    }
}
