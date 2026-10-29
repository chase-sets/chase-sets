//! The pages' views. Each component's stylesheet is next to it in `views/`; `static/style.css` has
//! the element defaults and the fonts.
use corten::{Component, prelude::*};
use platform::{chart::TimeSeries, theme};

use crate::{app::url, text::MarketMsg};

/// The page's main content, where the skip link goes.
#[derive(Id)]
pub struct MainContentId;

mod compare_page;
mod help_page;
mod home_page;
mod market_page;
mod policy_page;
mod welcome_page;

pub use compare_page::{ComparePage, ContactPage, FeeCalculator, FeeCalculatorId};
pub use help_page::{DeveloperArticle, DeveloperPortal, HelpArticlePage, HelpCategoryPage, HelpHub};
pub use home_page::HomePage;
pub use market_page::{MarketPage, Screen};
pub use policy_page::PolicyPage;
pub use welcome_page::{WaveStatus, WelcomePage};

/// Every page's components: the design system's tokens, the error page's, the home page's and the
/// policy, welcome and help pages'. The home page is outside every area (it is `/`) and it is the page most
/// visitors open first, so its stylesheet is in `components.css`; the policy pages are seven
/// addresses at the root, which no area's prefix can cover (todd-skelton/corten#93), and their
/// stylesheet is small (README decision 79). The welcome page is where Join lands, so most of
/// the home page's visitors who act open it next.
pub const COMPONENTS: &[Component] = &[
    theme::TOKENS,
    NotFound,
    HomeLayout,
    HomePage,
    home_page::handlers::COMPONENT,
    PolicyPage,
    WelcomePage,
    corten_ui::CopyButton,
];

/// The help center's components (`/help`, `/sales-fees` and `/press`), in a stylesheet those
/// pages share.
pub const HELP: &[Component] = &[HelpHub];

/// The compare pages' and Contact's components (`/compare` and `/contact`), in a stylesheet
/// those pages share.
pub const COMPARE: &[Component] = &[ComparePage];

/// The market pages' components (`/market`): the page and its chart.
pub const MARKET: &[Component] = &[MarketPage, TimeSeries];

/// The document around every page (public-web's root `Layout`): the theme color, the manifest and
/// the favicon, `title`, the
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
                <link rel="manifest" href={url::files::WebManifest}>
                <link rel="icon" href={url::files::FaviconSvg} type="image/svg+xml">
                <link rel="alternate icon" href={url::files::FaviconIco} sizes="any">
                <link
                    rel="preload"
                    as="font"
                    type="font/woff2"
                    crossorigin
                    href={req.asset(crate::app::Static::FONTS_SPACE_GROTESK_LATIN_600_NORMAL_WOFF2)}
                >
                <link rel="stylesheet" href={req.asset(crate::app::Static::STYLE_CSS)}>
                <title>{title}</title>
                {head}
                <Corten />
                <script type="module" src={req.asset(crate::app::Static::APP_JS)}></script>
            </head>
            <body>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The public-presence shell (`PublicPresencePageShell`) around the home page: the skip link, the
/// promo bar, the nav, the page and the footer, on the design system's wide container. A client
/// navigation between it and a page in the other [`Layout`] loads the page in full, since Corten's
/// shell key names the layout.
#[component(css)]
pub fn HomeLayout<'a, T: Render, H: Render, C: Render>(
    req: &'a Req,
    t: crate::text::HomeMsg,
    p: crate::text::Pilot,
    promos: &'a [crate::presence::Promo],
    web: &'a str,
    title: T,
    head: H,
    children: C,
) -> impl Document + 'a {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="theme-color" content="#0e0c15">
                <link rel="manifest" href={url::files::WebManifest}>
                <link rel="icon" href={url::files::FaviconSvg} type="image/svg+xml">
                <link rel="alternate icon" href={url::files::FaviconIco} sizes="any">
                <link
                    rel="preload"
                    as="font"
                    type="font/woff2"
                    crossorigin
                    href={req.asset(crate::app::Static::FONTS_SPACE_GROTESK_LATIN_600_NORMAL_WOFF2)}
                >
                <link rel="stylesheet" href={req.asset(crate::app::Static::STYLE_CSS)}>
                <title>{title}</title>
                {head}
                <Corten />
                <script type="module" src={req.asset(crate::app::Static::APP_JS)}></script>
            </head>
            <body>
                <a class={Skip} href={MainContentId.fragment()}>{p.shell_skip()}</a>
                <div class={Shell}>
                    if !promos.is_empty() {
                        <home_page::PromoBar p={p} promos={promos} web={web} />
                    }
                    <home_page::HomeNav t={t} />
                    <main class={Main} id={MainContentId}>{children}</main>
                    <home_page::HomeFooter t={t} web={web} />
                </div>
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
    let home = "/";
    html! {
        <div class={Narrow}>
            <div class={Empty}>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{text}</p>
                if let Some(detail) = detail {
                    <pre class={Detail}>{detail}</pre>
                }
                <p class={Cue}>{t.root_error_trust_cue()}</p>
                <a class={Button} href={home}>{t.root_go_home()}</a>
            </div>
        </div>
    }
}
