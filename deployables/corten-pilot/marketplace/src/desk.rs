//! The Seller Desk home (marketplace's `account-desk` route, `/account/desk`): what needs the
//! seller, most important first, and the numbers that describe the business.
//!
//! Reads, at once and each best-effort, as marketplace's loader makes them: the attention queue
//! (Marketplace's `/account/seller-attention-queue`, which composes every context's source and
//! sorts them), the listings' counts by status, and Ordering's open order count. A queue the API
//! cannot answer is every source unavailable; a count that fails is its tile's "Unavailable".
//! Marketplace's loader also reads the first 100 offer matches and the first 100 listings; it uses
//! neither the offers nor the rows, so the pilot reads no offers and one listing (the counts are
//! the account's, whatever the page).
//!
//! The page has no writes and no script: every row is a link.
use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
    },
    prelude::*,
};
use serde::Serialize;

use crate::{
    api::{AttentionQueue, AttentionRollup, AttentionSource, DeskCalls as _, SellerListingList as _},
    app::{Shared, sign_in},
    auth::DeskSeller,
    text::DeskMsg,
    views::{self, Layout},
};

/// The queue's sources, in the order the contract lists them (`SELLER_ATTENTION_SOURCES`).
pub const SOURCES: [&str; 8] = [
    "fulfillment-ship-by",
    "settlement-blocked-payout",
    "inventory-resolution",
    "channel-action",
    "offer-response",
    "pricing-repricing",
    "listing-action",
    "dispute-response",
];

/// The KPI band (`SellerDeskKpis`): a value the page could not read is `None`, its tile
/// "Unavailable". The payout and wallet tiles are not wired on marketplace either.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Kpis {
    pub active_listings: Option<u64>,
    pub open_orders_to_ship: Option<u64>,
    pub next_payout_amount: Option<String>,
    pub wallet_balance_amount: Option<String>,
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct DeskScreen {
    pub queue: AttentionQueue,
    pub kpis: Kpis,
}

/// The queue when the API could not answer it (marketplace's `unavailableQueue`).
pub fn unavailable() -> AttentionQueue {
    AttentionQueue {
        items: Vec::new(),
        rollup: AttentionRollup::default(),
        sources: SOURCES
            .iter()
            .map(|id| AttentionSource {
                id: (*id).to_owned(),
                status: "unavailable".to_owned(),
                item_count: 0,
                reason: Some("seller attention queue unavailable".to_owned()),
            })
            .collect(),
        degraded: true,
    }
}

pub(crate) async fn page(
    req: Req,
    Caller(DeskSeller(viewer)): Caller<DeskSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let (queue, listings, open) =
        tokio::join!(caller.seller_attention_queue(), caller.seller_listing_page("limit=1&offset=0"), caller.open_order_count());
    let ended = |status: Option<StatusCode>| status == Some(StatusCode::UNAUTHORIZED);
    if [queue.as_ref().err(), listings.as_ref().err(), open.as_ref().err()].into_iter().flatten().any(|e| ended(e.status())) {
        return sign_in(&req);
    }
    let queue = queue.unwrap_or_else(|error| {
        tracing::warn!("the seller attention queue's read failed: {error}");
        unavailable()
    });
    let kpis = Kpis {
        active_listings: listings.ok().map(|page| page.status_counts.active),
        open_orders_to_ship: open.ok(),
        next_payout_amount: None,
        wallet_balance_amount: None,
    };
    let screen = DeskScreen { queue, kpis };
    let (req, shown) = (&req, &screen);
    let t: DeskMsg = req.t();
    let head = html! { <meta name="description" content={t.meta_description()}> };
    req.screen(
        &screen,
        html! {
            <Layout req={req} viewer={Some(&viewer)} title={t.title()} head={head}>
                <views::DeskPage t={t} screen={shown} />
            </Layout>
        },
    )
}
