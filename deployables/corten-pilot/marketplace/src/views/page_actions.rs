use corten::prelude::*;

use super::marketplace;
/// The header's action: back to marketplace's inventory, in the screen's words.
#[component(css)]
pub fn PageActions<'a>(label: &'a str) -> impl Render {
    let back = marketplace("/account/inventory").map(|u| u.to_string()).unwrap_or_default();
    html! {
        <p class={Actions}><a class={Back} href={back}>{label}</a></p>
    }
}
