use corten::prelude::*;

/// A policy's status, toned as admin-web tones it: active is success, retired neutral, any
/// other status (a draft) a warning. (Not `Badge`: the UI kit's `Badge` would share its style
/// symbol, todd-skelton/corten#550.)
#[component(css)]
pub fn StatusBadge<'a>(status: &'a str) -> impl Render {
    let tone = match status {
        "active" => Success,
        "retired" => Neutral,
        _ => Warning,
    };
    html! { <span class={(Pill, tone)}>{status}</span> }
}
