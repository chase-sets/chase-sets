//! Growth's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod waitlist_page;

pub use waitlist_page::WaitlistPage;

/// Waitlist's components: its stylesheet.
pub const WAITLIST: &[Component] = &[WaitlistPage];
