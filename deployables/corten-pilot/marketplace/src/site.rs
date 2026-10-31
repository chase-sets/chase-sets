//! marketplace-web's host files (`app/routes.ts`): `robots.txt`, the sitemap index and its pages
//! (`sitemap.ts`, `sitemap-entity.ts`: the static pages, then Discovery's public pages of each kind
//! in pages of 5,000), the favicon at both addresses (`favicon-svg.ts`, `favicon.ts`, the design
//! system's `chaseSetsLogoSvg`, compiled in from `favicon.svg`, which scripts/export.mjs writes),
//! Chrome's devtools probe, and the offline page the service worker keeps (`offline.tsx`). The web
//! app manifest and the service worker are Corten's (`App::pwa`, see `app::pwa`); `/health/live`
//! and `/health/ready` are Corten's own.
//!
//! Each is the same for everyone (`Public`): the handlers read no session, and call the API with
//! none, for marketplace's own host.
//!
//! Where the pilot differs: a sitemap whose read failed is a 502, which no cache keeps, where
//! marketplace answers as if Discovery had no pages (the index with the static pages alone, a page
//! with no URLs), which a crawler takes for pages that are gone; and while the site may not be
//! indexed, the index and its pages list nothing and read nothing, as the public pilot's sitemap
//! does (marketplace's `robots.txt` closes the site then, but its sitemaps still list it).
//!
//! Not ported: `POST /analytics/item-detail-rail`, which counts the rail and search events
//! marketplace-web's scripts send (`trackItemDetailRailEvent`) in an OpenTelemetry metric. No pilot
//! page sends them, and the pilot has no metrics.
use std::time::Duration;

use corten::{Media, NoStore, axum::http::StatusCode, prelude::*, seo};

use crate::{
    api::Sitemaps as _,
    app::{Shared, marketplace_origin, url},
    text::SiteMsg,
    views,
};

/// The design system's logo, which marketplace-web serves as its favicon.
const FAVICON: &str = include_str!("../favicon.svg");

/// How long a browser keeps the favicon (`public, max-age=86400`).
const FAVICON_LIFE: Duration = Duration::from_secs(86_400);

/// Discovery's page size for the sitemaps (`DISCOVERY_SITEMAP_PAGE_SIZE`).
const PAGE_SIZE: u64 = 5000;

/// The kinds of public page Discovery lists, in the index's order (`DISCOVERY_SITEMAP_ENTITY_KINDS`).
pub const KINDS: [&str; 5] = ["items", "categories", "sellers", "listings", "sets"];

/// The static sitemap's kind, whose one page lists the home page and search.
const STATIC: &str = "static";

/// `robots.txt` (`buildRobotsTxt`): everything, and the sitemap index, when the site may be
/// indexed; nothing otherwise.
pub(crate) async fn robots(State(config): State<Shared>) -> Public<seo::File> {
    if config.indexing {
        let sitemap = format!("{}{}", marketplace_origin(), url::Sitemap.href());
        seo::robots(&[], Some(&sitemap))
    } else {
        seo::robots(&["/"], None)
    }
}

/// The sitemap index: the static page, then as many pages of each kind as Discovery's counts need.
pub(crate) async fn sitemap(State(config): State<Shared>) -> Result<Public<seo::File>, corten::Error> {
    if !config.indexing {
        return Ok(seo::sitemap_index([]));
    }
    let counts = config.anonymous().sitemap_counts().await.map_err(failed)?;
    let pages: Vec<String> = std::iter::once((STATIC, 1))
        .chain(KINDS.into_iter().flat_map(|kind| {
            let pages = counts.get(kind).copied().unwrap_or(0).div_ceil(PAGE_SIZE);
            (1..=pages).map(move |page| (kind, page))
        }))
        .map(|(kind, page)| format!("{}{}", marketplace_origin(), page_href(kind, page)))
        .collect();
    Ok(seo::sitemap_index(pages.iter().map(String::as_str)))
}

/// A sitemap page's address, `/sitemap/{kind}/{page}.xml`.
pub fn page_href(kind: &str, page: u64) -> String {
    url::SitemapPage { kind, file: &format!("{page}.xml") }.href()
}

/// A sitemap page: the static one's home page and search, or a page of a kind's public pages, each
/// with when it last changed. Another kind, a page that is not a whole number from 1, or a static
/// page after the first is a 404.
pub(crate) async fn sitemap_page(
    State(config): State<Shared>,
    Params(route): Params<url::SitemapPage<'_>>,
) -> Result<Public<seo::File>, corten::Error> {
    let kind = route.kind.as_str();
    let page = page_number(&route.file).ok_or_else(|| corten::Error::status(StatusCode::NOT_FOUND))?;
    let known = (kind == STATIC && page == 1) || KINDS.contains(&kind);
    if !known {
        return Err(corten::Error::status(StatusCode::NOT_FOUND));
    }
    if !config.indexing {
        return Ok(seo::sitemap([]));
    }
    let origin = marketplace_origin();
    let urls: Vec<(String, Option<String>)> = if kind == STATIC {
        [url::Home::default().href(), url::Search::default().href()]
            .into_iter()
            .map(|path| (format!("{origin}{path}"), None))
            .collect()
    } else {
        let entries = config.anonymous().sitemap_entries(kind, page).await.map_err(failed)?;
        // Discovery's paths are marketplace's own; anything else is left out rather than listed
        // on another origin.
        entries
            .into_iter()
            .filter(|entry| entry.path.starts_with('/') && !entry.path.starts_with("//"))
            .map(|entry| (format!("{origin}{}", entry.path), entry.updated_at))
            .collect()
    };
    Ok(seo::sitemap(urls.iter().map(|(loc, lastmod)| seo::SitemapUrl { loc, lastmod: lastmod.as_deref() })))
}

/// `1.xml`'s page, 1; `None` for anything that is not a whole number from 1 followed by `.xml`
/// (marketplace's `Number.isInteger(page) && page >= 1`). The route's parameter is the whole
/// segment, since a Corten route's parameter cannot end in text (todd-skelton/corten#514).
fn page_number(file: &str) -> Option<u64> {
    let digits = file.strip_suffix(".xml")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|page| *page >= 1)
}

/// A read of Discovery that failed: a 502, which no cache keeps.
fn failed(error: crate::api::ApiError) -> corten::Error {
    corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)
}

/// `/favicon.svg` and `/favicon.ico`: the same SVG at both, as marketplace-web serves it.
pub(crate) async fn favicon() -> Public<Media> {
    Public::new(FAVICON_LIFE, Media::new("image/svg+xml; charset=utf-8", FAVICON))
}

/// `/.well-known/appspecific/com.chrome.devtools.json`: nothing, so Chrome stops asking and the
/// log has no 404 for it.
pub(crate) async fn devtools() -> NoStore<StatusCode> {
    NoStore(StatusCode::NO_CONTENT)
}

/// The offline page, the same for everyone: the service worker fetches it when it installs, with
/// the browser's cookies, and shows it later to whoever uses the browser, so it reads no session
/// (`Public`) and draws no account's nav. A cache revalidates it every time (`max-age=0`), so a new
/// deploy's worker keeps the page that names the deploy's stylesheet.
pub(crate) async fn offline(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::ZERO, offline_page(&req))
}

fn offline_page<For>(req: &Req) -> corten::Result<corten::HtmlResponse<For>> {
    let t: SiteMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page(html! {
        <views::Layout req={req} viewer={None} title={t.offline_title()} head={head}>
            <views::OfflinePage t={t} />
        </views::Layout>
    })
}

#[cfg(test)]
mod tests {
    use super::page_number;

    #[test]
    fn a_sitemap_page_is_a_whole_number_from_one() {
        assert_eq!(page_number("1.xml"), Some(1));
        assert_eq!(page_number("12.xml"), Some(12));
        for file in ["0.xml", "1", "1.json", ".xml", "-1.xml", "+1.xml", "1.5.xml", "a.xml", "1.xml.xml"] {
            assert_eq!(page_number(file), None, "{file}");
        }
    }
}
