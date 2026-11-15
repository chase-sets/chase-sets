//! The design system's `SearchInput`: the search glyph inside the box. A search field is the kit's
//! `InputGroup` around this glyph and its `<input type="search">`, the input right after the glyph
//! so the kit's spacing applies:
//!
//! ```rust,ignore
//! <span class={InputGroup {}}>
//!     <SearchGlyph />
//!     <input class={Input {}} type="search" name={f.q} value={&q}>
//! </span>
//! ```
//!
//! The glyph is hidden from a screen reader (an `Adornment`), so the field's label names it. An app
//! lists the kit's `InputGroup` and `Icon` in the components of every page with a search field.
use corten::prelude::*;

use crate::{
    glyphs,
    ui::{icon::Icon, input_group::Adornment},
};

#[component]
pub fn SearchGlyph() -> impl Render {
    html! { <Adornment><Icon glyph={glyphs::SEARCH} /></Adornment> }
}
