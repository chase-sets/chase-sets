//! Insights' views. The page's stylesheet is next to it in `views/`.
use corten::Component;

mod offer_economics_page;

pub use offer_economics_page::OfferEconomicsPage;

/// Offer Economics' components: its stylesheet.
pub const COMPONENTS: &[Component] = &[OfferEconomicsPage];
