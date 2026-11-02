//! Reported Content's views. Each component's stylesheet is next to it in `views/`; together they
//! are the area's stylesheet.
use corten::Component;

mod reported_page;

pub use reported_page::{AlertPage, ItemPage, ReportedPage, RisksPage, alert_kind, target_type};

/// The area's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[ReportedPage];
