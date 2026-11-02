//! Provider Connections' views. The page's stylesheet is next to it in `views/`.
use corten::Component;

mod providers_page;

pub use providers_page::ProvidersPage;

/// The page's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[ProvidersPage];
