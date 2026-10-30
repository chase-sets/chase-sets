//! Support's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod lookup_page;

pub use lookup_page::LookupPage;

/// The area's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[LookupPage];
