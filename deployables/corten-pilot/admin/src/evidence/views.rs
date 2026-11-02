//! The Listing Evidence Policy's view. Its stylesheet is next to it in `views/`.
use corten::{
    Component,
    i18n::{DateStyle, TimeStyle, parse_timestamp},
};

use crate::{text::Ops, views::Here};

mod listing_evidence_page;

pub use listing_evidence_page::ListingEvidencePage;

/// The page's components: its stylesheet.
pub const COMPONENTS: &[Component] = &[ListingEvidencePage];

/// What admin-web shows for a value that is not there.
const NONE: &str = "\u{2014}";

/// A time the API sent, in the operator's words and zone, or its text when it cannot be read.
fn when(o: Ops, here: &Here, at: &str) -> String {
    parse_timestamp(at)
        .map_or_else(|| at.to_owned(), |w| o.date_time(w, DateStyle::Medium, TimeStyle::Short).zone(here).to_string())
}

/// A version's lifecycle in words (admin-web's `lifecycleLabel`, which calls anything else
/// rejected) and its tone.
fn lifecycle(o: Ops, lifecycle: &str) -> (&'static str, &'static str) {
    match lifecycle {
        "draft" => (o.lep_lifecycle_draft(), "neutral"),
        "validated" => (o.lep_lifecycle_validated(), "neutral"),
        "scheduled" => (o.lep_lifecycle_scheduled(), "neutral"),
        "active" => (o.lep_lifecycle_active(), "good"),
        "superseded" => (o.lep_lifecycle_superseded(), "neutral"),
        _ => (o.lep_lifecycle_rejected(), "bad"),
    }
}

/// A selector kind in words.
fn kind(o: Ops, kind: &str) -> &'static str {
    match kind {
        "catalog-item" => o.lep_selector_catalog_item(),
        "product" => o.lep_selector_product(),
        "blueprint" => o.lep_selector_blueprint(),
        "category" => o.lep_selector_category(),
        "option" => o.lep_selector_option(),
        "graded-item" => o.lep_selector_graded(),
        "price" => o.lep_selector_price(),
        "seller-reviews" => o.lep_selector_seller_reviews(),
        "seller-badge" => o.lep_selector_seller_badge(),
        "seller-risk" => o.lep_selector_seller_risk(),
        _ => o.lep_selector_all(),
    }
}

/// A named evidence slot set in words.
fn view_set(o: Ops, set: &str) -> &'static str {
    match set {
        "condition" => o.lep_view_condition(),
        "slab-front-back" => o.lep_view_slab_front_back(),
        _ => o.lep_view_none(),
    }
}

/// Rule ids as admin-web lists them in the diff.
fn ids(list: &[String]) -> String {
    if list.is_empty() { NONE.to_owned() } else { list.join(", ") }
}
