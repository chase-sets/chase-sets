use corten::prelude::*;

/// Chase Sets surface paint, independent of an element's layout, spacing, and semantics.
pub enum Elevation {
    Flush,
    Tinted,
    Outlined,
    Elevated,
}

#[component(css)]
pub fn Surface(elevation: Elevation) -> impl ClassList {
    match elevation {
        Elevation::Flush => Flush,
        Elevation::Tinted => Tinted,
        Elevation::Outlined => Outlined,
        Elevation::Elevated => Elevated,
    }
}
