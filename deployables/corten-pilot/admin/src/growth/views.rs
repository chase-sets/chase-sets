//! Growth's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod campaign_page;
mod google_shopping_page;
mod promo_page;
mod waitlist_page;

pub use campaign_page::CampaignPage;
pub use google_shopping_page::{GoogleShoppingPage, job_part};
pub use promo_page::PromoPage;
pub use waitlist_page::WaitlistPage;

/// Campaign Analytics' components: its stylesheet.
pub const CAMPAIGN: &[Component] = &[CampaignPage];
/// Google Shopping's components: its stylesheet.
pub const GOOGLE_SHOPPING: &[Component] = &[GoogleShoppingPage];
/// Promo Bar's components: its stylesheet, and the sheets' dialog.
pub const PROMO: &[Component] = &[PromoPage, corten_ui::dialog::COMPONENT];
/// Waitlist's components: its stylesheet.
pub const WAITLIST: &[Component] = &[WaitlistPage];
