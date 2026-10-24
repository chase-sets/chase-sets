use corten::prelude::*;

/// A policy's status, toned as admin-web tones it: active is success, retired neutral, any
/// other status (a draft) a warning.
#[component(css)]
pub fn Badge<'a>(status: &'a str) -> impl Render {
    let tone = match status {
        "active" => Success,
        "retired" => Neutral,
        _ => Warning,
    };
    html! { <span class={(Pill, tone)}>{status}</span> }
}
