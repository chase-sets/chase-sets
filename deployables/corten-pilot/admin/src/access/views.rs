//! The access section's views. Each component's stylesheet is next to it in `views/`; together
//! they are the area's stylesheet.
use corten::Component;

mod access_page;

pub use access_page::{AccessPage, accounts, api_keys, invitations, memberships, users};

/// The area's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[AccessPage];
