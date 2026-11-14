use corten::prelude::*;

/// A pill's tone, as the design system's `Badge` tones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Success,
    Neutral,
    Warning,
    Danger,
    Info,
}

/// A status, as the catalog's `StatusPill` shows it. `toned` is the lifecycle controls' tone
/// (active is success, deprecated a warning, archived danger); the tables show it untoned.
#[component(css)]
pub fn StatusPill<'a>(status: &'a str, toned: bool) -> impl Render {
    let tone = match (toned, status) {
        (true, "active" | "published") => Tone::Success,
        (true, "deprecated" | "retired") => Tone::Warning,
        (true, "archived") => Tone::Danger,
        _ => Tone::Neutral,
    };
    html! { <TonePill text={status} tone={tone} /> }
}

/// Text in a pill of `tone`.
#[component(css = StatusPill)]
pub fn TonePill<'a>(text: &'a str, tone: Tone) -> impl Render {
    let class = match tone {
        Tone::Success => Success,
        Tone::Neutral => Neutral,
        Tone::Warning => Warning,
        Tone::Danger => Danger,
        Tone::Info => Info,
    };
    html! { <span class={(Pill, class)}>{text}</span> }
}
