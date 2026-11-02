use corten::prelude::*;

use crate::app::url;

/// The header's action: back to the inventory list, in the screen's words.
#[component(css)]
pub fn PageActions<'a>(label: &'a str) -> impl Render {
    let back = url::Inventory::default().href();
    html! {
        <p class={Actions}><a class={Back} href={back}>{label}</a></p>
    }
}
