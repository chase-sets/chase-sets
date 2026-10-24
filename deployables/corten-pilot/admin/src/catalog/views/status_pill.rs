use corten::prelude::*;

/// A status, as the catalog's `StatusPill` shows it. `toned` is the lifecycle controls' tone
/// (active is success, deprecated a warning, archived danger); the tables show it untoned.
#[component(css)]
pub fn StatusPill<'a>(status: &'a str, toned: bool) -> impl Render {
    let tone = match (toned, status) {
        (true, "active" | "published") => Success,
        (true, "deprecated" | "retired") => Warning,
        (true, "archived") => Danger,
        _ => Neutral,
    };
    html! { <span class={(Pill, tone)}>{status}</span> }
}
