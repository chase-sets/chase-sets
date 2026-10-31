//! admin-web's host files (`app/routes.ts`): the favicon at both addresses (`favicon-svg.ts`,
//! `favicon.ts`, the design system's `chaseSetsLogoSvg`, compiled in from `favicon.svg`, which
//! scripts/export.mjs writes) and the offline page the service worker keeps (`offline.tsx`). The
//! web app manifest and the service worker are Corten's (`App::pwa`, see `pwa`); `/health/live` and
//! `/health/ready` are Corten's own. Each is the same for everyone (`Public`): it reads no session.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /favicon.svg`, `/favicon.ico` | the design system's logo (`Public`, a day) |
//! | `GET /manifest.webmanifest`, `/service-worker.js` | the web app manifest and the service worker (Corten's) |
//! | `GET /offline` | the page the service worker shows for a navigation it cannot make |
use std::time::Duration;

use corten::{Media, prelude::*};

use crate::{app::Static, text::SiteMsg, views};

/// The design system's logo, which admin-web serves as its favicon.
const FAVICON: &str = include_str!("../favicon.svg");

/// How long a browser keeps the favicon (`public, max-age=86400`).
const FAVICON_LIFE: Duration = Duration::from_secs(86_400);

/// What admin-web's service worker leaves to the network (`adminServiceWorkerPolicy`'s excluded
/// paths and prefixes): its sign-in and account selection, the API and the health checks. Its exact
/// paths are prefixes here, which reach only their own sub-paths.
const NETWORK_ONLY: [&str; 8] = [
    "/sign-in",
    "/sign-out",
    "/account-select",
    "/access/sign-in",
    "/access/sign-out",
    "/access/account-select",
    "/api/",
    "/health/",
];

/// The site's own files.
#[corten::routes(state = crate::app::Shared)]
pub mod files {
    #[route("/favicon.svg", get = crate::site::favicon)]
    pub struct FaviconSvg;

    #[route("/favicon.ico", get = crate::site::favicon)]
    pub struct FaviconIco;
}

/// The offline page, an area for its stylesheet, which no other page loads. Public.
#[corten::routes(state = crate::app::Shared, area = Offline)]
pub mod offline_page {
    #[route("/offline", get = crate::site::offline)]
    pub struct Offline;
}

/// admin-web's web app manifest (`routes/manifest.ts`), and its service worker as Corten's
/// (`corten::pwa`): pages from the network, the offline page when there is none, and the static
/// files from the cache. admin-web's `orientation` (`any`, the default) and `categories`
/// (`business`, `productivity`) are not written: Corten's manifest has neither
/// (todd-skelton/corten#515). The description is in English, as admin-web's is.
pub fn pwa() -> corten::pwa::Pwa {
    use corten::{
        i18n::Messages as _,
        pwa::{Manifest, Pwa},
    };
    let t = SiteMsg::for_locale("en");
    let manifest = Manifest::new("Chase Sets Admin", "CS Admin")
        .description(t.manifest_description())
        .theme_color("#0f766e")
        .background_color("#f7f5f1")
        .icon(Static::ICONS_CHASE_SETS_ADMIN_192_PNG, "192x192")
        .icon(Static::ICONS_CHASE_SETS_ADMIN_512_PNG, "512x512")
        .maskable_icon(Static::ICONS_CHASE_SETS_ADMIN_MASKABLE_192_PNG, "192x192")
        .maskable_icon(Static::ICONS_CHASE_SETS_ADMIN_MASKABLE_512_PNG, "512x512");
    NETWORK_ONLY.into_iter().fold(Pwa::new(manifest), Pwa::network_only)
}

/// `/favicon.svg` and `/favicon.ico`: the same SVG at both, as admin-web serves it.
pub(crate) async fn favicon() -> Public<Media> {
    Public::new(FAVICON_LIFE, Media::new("image/svg+xml; charset=utf-8", FAVICON))
}

/// The offline page, the same for everyone: the service worker fetches it when it installs, with
/// the browser's cookies, and shows it later to whoever uses the browser, so it reads no session
/// (`Public`) and draws no staff member's nav. A cache revalidates it every time (`max-age=0`), so
/// a new deploy's worker keeps the page that names the deploy's stylesheet.
pub(crate) async fn offline(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::ZERO, offline_view(&req))
}

fn offline_view<For>(req: &Req) -> corten::Result<corten::HtmlResponse<For>> {
    let t: SiteMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page(html! {
        <views::Layout req={req} viewer={None} title={t.offline_title()} head={head}>
            <views::OfflinePage t={t} />
        </views::Layout>
    })
}
