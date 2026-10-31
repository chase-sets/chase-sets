//! Insights' views. Each page's stylesheet is next to it in `views/`.
use corten::{
    Component,
    i18n::{Currency, DateStyle, parse_timestamp},
};

use crate::text::Ops;

mod offer_economics_page;
mod ops_dashboard_page;

pub use offer_economics_page::OfferEconomicsPage;
pub use ops_dashboard_page::OpsDashboardPage;

/// Offer Economics' components: its stylesheet.
pub const COMPONENTS: &[Component] = &[OfferEconomicsPage];
/// The Ops Dashboard's components: its stylesheet.
pub const OPS: &[Component] = &[OpsDashboardPage];

/// An amount in US dollars, as every amount on these pages is (admin-web's USD-only launch), or the
/// API's text.
fn usd(o: Ops, amount: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse("USD")) {
        (Some(amount), Some(usd)) => o.money(amount, usd).to_string(),
        _ => amount.to_owned(),
    }
}

/// A calendar date (`YYYY-MM-DD`) as admin-web's `formatDate` writes it (in UTC), or the API's text.
/// `t.date` takes an instant, so the day is its midnight in UTC, which `t.date` writes in UTC
/// (todd-skelton/corten#502).
fn date(o: Ops, value: &str) -> String {
    let day = value.get(..10).filter(|d| d.parse::<jiff::civil::Date>().is_ok());
    day.and_then(|d| parse_timestamp(&format!("{d}T00:00:00Z")))
        .map_or_else(|| value.to_owned(), |at| o.date(at, DateStyle::Medium).to_string())
}
