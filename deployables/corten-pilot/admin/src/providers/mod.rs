//! Platform > Provider Connections (admin-web's `/platform/provider-connections`, Platform
//! Operations' `ProviderConnectionsPage`): Catalog's providers and Channels' connections, each
//! with its credential readiness, health and how old its last observation is. Read from
//! `GET /api/platform/provider-connections`, which, like admin-web's loader, answers only a
//! `platform-admin` with `provider-connections.view`.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/provider-connections` | the page |
//!
//! An observation's freshness (fresh, aging, stale, too old) is worked out here from the limits the
//! API returns and the time it evaluated them, as admin-web's page does
//! (chase-sets/chase-sets#10873).
use corten::{axum::http::HeaderMap, prelude::*};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};

pub mod views;

use crate::{
    app::{Shared, read_failed},
    auth::{ProviderConnectionsView, Staff},
    text::Ops,
};

#[corten::routes(state = crate::app::Shared, area = crate::providers::url::Providers, caller = crate::auth::Staff<crate::auth::ProviderConnectionsView>)]
pub mod url {
    #[route("/platform/provider-connections", get = page)]
    pub struct Providers;
}

/// The area: its route and the page's stylesheet.
pub fn area(area: Area<url::Providers>, shared: Shared) -> Area<url::Providers> {
    url::area(area, shared).components(views::COMPONENTS)
}

/// The limits an observation's age is read against, in seconds.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    pub fresh_within_seconds: f64,
    pub stale_after_seconds: f64,
    pub unavailable_after_seconds: f64,
}

/// Where a connection is managed.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub route_id: String,
    pub href: String,
}

/// A connection (`ProviderConnectionRow`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub provider: String,
    pub capability: String,
    pub owner: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    pub credential_readiness: String,
    pub health: String,
    #[serde(default)]
    pub observed_at: Option<String>,
    #[serde(default)]
    pub freshness: Option<Freshness>,
    #[serde(default)]
    pub destination: Option<Destination>,
}

/// One owner's connections, and whether the API could read them all.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
pub struct Section {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub rows: Vec<Connection>,
}

/// The page as drawn (`ProviderConnectionsSnapshot`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub evaluated_at: String,
    #[serde(default)]
    pub catalog: Section,
    #[serde(default)]
    pub channels: Section,
}

/// How old an observation is against its limits (`providerConnectionAge`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Age {
    /// No observation time, or one after the evaluation.
    Unknown,
    /// An age, but no limits to read it against.
    Unlimited(f64),
    Fresh(f64),
    Aging(f64),
    Stale(f64),
    Unavailable(f64),
}

/// An RFC 3339 time with a zone (admin-web's pattern: `Z` or `+hh:mm`), or none.
fn instant(text: Option<&str>) -> Option<Timestamp> {
    let text = text?;
    let zoned = text.ends_with('Z')
        || text.get(text.len().saturating_sub(6)..).is_some_and(|t| t.starts_with(['+', '-']) && t.as_bytes()[3] == b':');
    if !zoned || !text.contains('T') {
        return None;
    }
    text.parse().ok()
}

impl Connection {
    pub fn age(&self, evaluated_at: &str) -> Age {
        let (Some(now), Some(seen)) = (instant(Some(evaluated_at)), instant(self.observed_at.as_deref())) else {
            return Age::Unknown;
        };
        let seconds = (now.as_millisecond() - seen.as_millisecond()) as f64 / 1000.0;
        if seconds < 0.0 {
            return Age::Unknown;
        }
        match self.freshness {
            None => Age::Unlimited(seconds),
            Some(limits) if seconds > limits.unavailable_after_seconds => Age::Unavailable(seconds),
            Some(limits) if seconds > limits.stale_after_seconds => Age::Stale(seconds),
            Some(limits) if seconds > limits.fresh_within_seconds => Age::Aging(seconds),
            Some(_) => Age::Fresh(seconds),
        }
    }
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<ProviderConnectionsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let snapshot = match caller.read::<Snapshot>("/api/platform/provider-connections", "platform-operations").await {
        Ok(snapshot) => snapshot,
        Err(error) => return read_failed(&req, error, false),
    };
    let o: Ops = req.t();
    let view = html! { <views::ProvidersPage o={o} snapshot={&snapshot} /> };
    req.screen(
        &snapshot,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={o.pc_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(observed: Option<&str>, limits: bool) -> Connection {
        Connection {
            id: "c".into(),
            provider: "p".into(),
            capability: "catalog-integration".into(),
            owner: "catalog".into(),
            account_id: None,
            status: None,
            credential_readiness: "configured".into(),
            health: "ready".into(),
            observed_at: observed.map(Into::into),
            freshness: limits.then_some(Freshness {
                fresh_within_seconds: 15.0,
                stale_after_seconds: 60.0,
                unavailable_after_seconds: 300.0,
            }),
            destination: None,
        }
    }

    #[test]
    fn an_observations_age_is_read_as_admin_webs() {
        let now = "2026-10-31T07:05:00Z";
        assert_eq!(row(Some("2026-10-31T07:04:50Z"), true).age(now), Age::Fresh(10.0));
        assert_eq!(row(Some("2026-10-31T07:04:30Z"), true).age(now), Age::Aging(30.0));
        assert_eq!(row(Some("2026-10-31T07:03:00Z"), true).age(now), Age::Stale(120.0));
        assert_eq!(row(Some("2026-10-31T06:00:00+00:00"), true).age(now), Age::Unavailable(3900.0));
        assert_eq!(row(Some("2026-10-31T07:00:00Z"), false).age(now), Age::Unlimited(300.0));
        assert_eq!(row(Some("2026-10-31T07:06:00Z"), true).age(now), Age::Unknown, "after the evaluation");
        assert_eq!(row(Some("2026-10-31 07:00:00+00"), true).age(now), Age::Unknown, "not admin-web's form");
        assert_eq!(row(None, true).age(now), Age::Unknown);
    }
}
