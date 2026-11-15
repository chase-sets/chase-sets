//! The Policy Console's views. Each page's stylesheet is next to it in `views/`.
use corten::{
    Component,
    i18n::{DateStyle, TimeStyle, parse_timestamp},
};

use crate::{text::Ops, views::Here};

mod policy_console_page;
mod policy_detail_page;

pub use policy_console_page::PolicyConsolePage;
pub use policy_detail_page::PolicyDetailPage;

/// The console's components: its pages' stylesheets.
pub const COMPONENTS: &[Component] = &[PolicyConsolePage, PolicyDetailPage];

/// A time the API sent, in the operator's words and zone, or its text when it cannot be read.
fn when(o: Ops, here: &Here, at: &str) -> String {
    parse_timestamp(at)
        .map_or_else(|| at.to_owned(), |w| o.date_time(w, DateStyle::Medium, TimeStyle::Short).zone(here).to_string())
}

/// A policy status's words (admin-web's `statusLabel`) and its tone.
fn status(o: Ops, status: &str) -> (&'static str, &'static str) {
    match status {
        "active" => (o.policy_status_active(), "good"),
        "inactive" => (o.policy_status_inactive(), "warn"),
        _ => (o.policy_status_fallback(), "neutral"),
    }
}
