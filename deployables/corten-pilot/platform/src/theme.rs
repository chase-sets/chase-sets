//! The design system's tokens (`tokens/`, W3C Design Tokens files exported from packages/design-system): custom
//! properties, the dark theme (chosen, or the system's), and the `gap` utility. Each app lists
//! [`TOKENS`] first in `App::components`.
corten::style::tokens!("tokens/tokens.resolver.json");

use corten::prelude::*;

/// The design-system background underneath the page's surfaces.
#[component(css)]
pub fn PageCanvas() -> impl ClassList {
    Canvas
}

/// The one signature word in a hero headline, never a control or a surface fill.
#[component(css)]
pub fn BrandFoilText() -> impl ClassList {
    Foil
}
