//! The pages' views. Each component's stylesheet is next to it in `views/`; `static/style.css` has
//! the element defaults and the fonts.
use corten::{Component, prelude::*};
use platform::{chart::TimeSeries, theme};

use crate::{app, text::MarketMsg};

mod market_page;

pub use market_page::{MarketPage, Screen};

/// Every page's components: the design system's tokens and the error page's.
pub const COMPONENTS: &[Component] = &[theme::TOKENS, NotFound];

/// The market pages' components (`/market`): the page and its chart.
pub const MARKET: &[Component] = &[MarketPage, TimeSeries];

/// The document around every page (public-web's root `Layout`): the theme color, `title`, the
/// page's own `head` tags (description, social, canonical, robots, JSON-LD) and the page. No
/// shell: public-web's pages draw their own. A client navigation gets only the title, the head
/// tags and `<main>`'s children.
#[component]
pub fn Layout<'a, T: Render, H: Render, C: Render>(req: &'a Req, title: T, head: H, children: C) -> impl Document + 'a {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="theme-color" content="#0e0c15">
                <link
                    rel="preload"
                    as="font"
                    type="font/woff2"
                    crossorigin
                    href={req.asset("fonts/space-grotesk-latin-600-normal.woff2")}
                >
                <link rel="stylesheet" href={req.asset("style.css")}>
                <title>{title}</title>
                {head}
                <Corten />
                <script type="module" src={req.asset("app.js")}></script>
            </head>
            <body>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The page for a failed request (`App::error_page`, public-web's `ErrorBoundary` and its
/// not-found route): what happened, that nothing was changed, and Home. Corten sends it with
/// `X-Robots-Tag: noindex` and never to a shared cache.
pub async fn error_page(failure: Failure, req: Req) -> HtmlResult {
    let t: MarketMsg = req.t();
    let p: crate::text::Pilot = req.t();
    // Each case is named, so a case Corten adds stops this compiling.
    let (title, text) = match &failure {
        Failure::NotFound => (t.root_page_not_found(), t.root_page_not_found_description()),
        Failure::WrongMethod
        | Failure::Refused { .. }
        | Failure::CrossSite
        | Failure::Unidentified { .. }
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. }
        | Failure::TimedOut
        | Failure::Offline => (t.root_public_error(), p.error_failed()),
    };
    let head_title = format!("{title} | {}", p.shell_site());
    let detail = failure.detail().map(str::to_owned);
    req.page(html! {
        <Layout req={&req} title={head_title} head="">
            <NotFound t={t} title={title} text={text} detail={detail.as_deref()} />
        </Layout>
    })
}

/// public-web's `MarketplaceEmptyState` on an error: the title, what to do, the trust cue and
/// Go home.
#[component(css)]
fn NotFound<'a>(t: MarketMsg, title: &'a str, text: &'a str, detail: Option<&'a str>) -> impl Render {
    let home = format!("{}/", app::public_web());
    html! {
        <div class={Narrow}>
            <div class={Empty}>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{text}</p>
                if let Some(detail) = detail {
                    <pre class={Detail}>{detail}</pre>
                }
                <p class={Cue}>{t.root_error_trust_cue()}</p>
                <a class={Button} href={&home}>{t.root_go_home()}</a>
            </div>
        </div>
    }
}
