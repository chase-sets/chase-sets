//! Support's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod csat_page;
mod ebay_page;
mod feedback_attention_page;
mod feedback_page;
mod lookup_page;
mod requests_page;

pub use csat_page::CsatPage;
pub use ebay_page::EbayPage;
pub use feedback_attention_page::FeedbackAttentionPage;
pub use feedback_page::{FeedbackItemPage, FeedbackPage};
pub use lookup_page::LookupPage;
pub use requests_page::RequestsPage;

/// Reference Lookup's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[LookupPage];
/// The CSAT dashboard's components: its stylesheet.
pub const CSAT: &[Component] = &[CsatPage];
/// Platform Feedback's components: its stylesheet.
pub const FEEDBACK: &[Component] = &[FeedbackPage];
/// Customer Feedback's attention queue's components: its stylesheet.
pub const ATTENTION: &[Component] = &[FeedbackAttentionPage];
/// eBay Deletion Lookup's components: its stylesheet.
pub const EBAY: &[Component] = &[EbayPage];
/// Support requests' components: its stylesheet and the sheet's dialog script.
pub const REQUESTS: &[Component] = &[RequestsPage, corten_ui::dialog::COMPONENT];
