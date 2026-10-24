use corten::prelude::*;

/// A titled part of the page, its content on a tinted card (the design system's `PageSection`
/// and `Card elevation="tinted"`).
#[component(css)]
pub fn Section<'a, C: Render>(title: &'a str, children: C) -> impl Render {
    html! {
        <section class={Part}>
            <h2 class={Title}>{title}</h2>
            <div class={Card}>{children}</div>
        </section>
    }
}

/// The page's eyebrow, title and description.
#[component(css = Section)]
pub fn PageHeader<'a>(eyebrow: &'a str, title: &'a str, description: &'a str) -> impl Render {
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{eyebrow}</p>
            <h1>{title}</h1>
            <p class={Description}>{description}</p>
        </header>
    }
}

/// An information banner.
#[component(css = Section)]
pub fn Banner<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Info} role="note">
            <p class={InfoTitle}>{title}</p>
            <p>{description}</p>
        </div>
    }
}
