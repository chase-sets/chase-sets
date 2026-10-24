use corten::prelude::*;

use super::marketplace;
use crate::text::Msg;

/// The header's action: back to marketplace's inventory.
#[component(css)]
pub fn PageActions(t: Msg) -> impl Render {
    let back = marketplace("/account/inventory").map(|u| u.to_string()).unwrap_or_default();
    html! {
        <p class={Actions}><a class={Back} href={back}>{t.page_back_to_inventory()}</a></p>
    }
}
