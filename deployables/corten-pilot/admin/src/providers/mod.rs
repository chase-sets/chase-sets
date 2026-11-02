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
//! An observation's freshness (fresh, aging, stale, too old) and age are the API's, worked out
//! against its limits when it evaluated them.
use corten::{axum::http::HeaderMap, prelude::*};
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
    /// `unknown`, `ageOnly` (no limits), `fresh`, `aging`, `stale` or `unavailable`.
    #[serde(default)]
    pub freshness_state: Option<String>,
    /// How old the observation was when the API evaluated it; none when unknown.
    #[serde(default)]
    pub age_seconds: Option<f64>,
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
