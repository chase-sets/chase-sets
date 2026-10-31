//! Support's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod csat_page;
mod feedback_page;
mod lookup_page;

pub use csat_page::CsatPage;
pub use feedback_page::{FeedbackItemPage, FeedbackPage};
pub use lookup_page::LookupPage;

/// Reference Lookup's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[LookupPage];
/// The CSAT dashboard's components: its stylesheet.
pub const CSAT: &[Component] = &[CsatPage];
/// Platform Feedback's components: its stylesheet.
pub const FEEDBACK: &[Component] = &[FeedbackPage];
