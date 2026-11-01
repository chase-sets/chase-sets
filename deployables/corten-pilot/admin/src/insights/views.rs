//! Insights' views. Each page's stylesheet is next to it in `views/`.
use corten::{
    Component,
    i18n::{Currency, DateStyle},
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

/// A calendar date (`YYYY-MM-DD`, the first ten characters of what the API sends) as admin-web's
/// `formatDate` writes it: a day, which no zone shifts, or the API's text.
fn date(o: Ops, value: &str) -> String {
    let day = value.get(..10).and_then(|d| d.parse::<corten::i18n::Day>().ok());
    day.map_or_else(|| value.to_owned(), |day| o.date(day, DateStyle::Medium).to_string())
}
