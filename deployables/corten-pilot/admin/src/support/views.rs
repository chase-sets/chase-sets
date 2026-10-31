//! Support's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod csat_page;
mod lookup_page;

pub use csat_page::CsatPage;
pub use lookup_page::LookupPage;

/// Reference Lookup's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[LookupPage];
/// The CSAT dashboard's components: its stylesheet.
pub const CSAT: &[Component] = &[CsatPage];
