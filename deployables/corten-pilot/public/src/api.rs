//! The Pricing API's public market pages (`features/public-market-pages/api/route.ts`), called
//! with no session: an item's page data and the slugs of the pages worth indexing.
use serde::Deserialize;

pub use platform::api::{ApiError, Caller, Platform, segment};

/// `GET /api/marketplace/public/market-pages/{slug}` (`PublicMarketPageData`), the fields the page
/// draws.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPage {
    pub title: String,
    pub subtitle: Option<String>,
    pub slug: String,
    #[serde(default)]
    pub series: Vec<SeriesPoint>,
    #[serde(default)]
    pub aggregates: Vec<Aggregate>,
    pub market_state: Option<MarketState>,
    /// Each currency's lowest ask among the buyable listings.
    #[serde(default)]
    pub live_asks: Vec<LiveAsk>,
    #[serde(default)]
    pub unpriced_buyable_listing_count: u64,
}

/// A day of the product's trades (`ProductRollupSeriesPoint`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
    pub currency_code: Option<String>,
    pub day: String,
    pub last_price_amount: Option<String>,
    pub min_price_amount: Option<String>,
    pub max_price_amount: Option<String>,
    pub median_price_amount: Option<String>,
}

/// A currency's trade aggregate (`ProductMarketAggregate`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub currency_code: String,
    pub last_sold_at: Option<String>,
    pub last_sold_price_amount: Option<String>,
    pub median_price30d: Option<String>,
    #[serde(default)]
    pub trade_count30d: u64,
    pub median_price90d: Option<String>,
    #[serde(default)]
    pub trade_count90d: u64,
    pub sell_through_rate: Option<String>,
}

/// Today's market state (`MarketStateSnapshotPoint`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketState {
    #[serde(default)]
    pub active_listing_count: u64,
    pub min_ask_amount: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAsk {
    pub currency_code: String,
    pub min_ask_amount: String,
}

/// A market page worth indexing (`PublicMarketPageSitemapEntry`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Indexed {
    pub slug: String,
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
struct IndexedList {
    #[serde(default)]
    items: Vec<Indexed>,
}

/// The calls the pages make.
pub trait Pricing {
    /// An item's market page, or `None` when Pricing has no page for the slug (its 404).
    async fn market_page(&self, slug: &str) -> Result<Option<MarketPage>, ApiError>;
    /// The pages worth indexing, the most recently traded first.
    async fn indexed(&self) -> Result<Vec<Indexed>, ApiError>;
}

impl Pricing for Caller<'_> {
    async fn market_page(&self, slug: &str) -> Result<Option<MarketPage>, ApiError> {
        match self.read(&format!("/api/marketplace/public/market-pages/{}", segment(slug)), "pricing").await {
            Ok(page) => Ok(Some(page)),
            Err(error) if error.status() == Some(corten::axum::http::StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn indexed(&self) -> Result<Vec<Indexed>, ApiError> {
        Ok(self.read::<IndexedList>("/api/marketplace/public/market-pages", "pricing").await?.items)
    }
}
