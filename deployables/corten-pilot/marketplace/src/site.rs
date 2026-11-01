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
//! `POST /analytics/item-detail-rail` takes the item page's and search's analytics events
//! (`views/rail_analytics.js`, marketplace's `trackItemDetailRailEvent` and its root's bridge): it
//! refuses what marketplace's refuses, a name it does not know or a label that is not one, with a
//! 400, and logs the rest with marketplace's fields (`marketplace.item_detail_rail.analytics_event`,
//! leaving out the position and the keys, as its log does). Marketplace also counts them in an
//! OpenTelemetry metric (`chase_sets_marketplace_item_detail_rail_events_total`); the pilot has no
//! metrics, so the log is the record until it gets an OpenTelemetry layer (Corten leaves metrics to
//! the app's `tracing` subscriber). The endpoint and its vocabulary are Discovery's to own, not a
//! web host's (chase-sets/chase-sets#3494); the pilot keeps marketplace's copy until Discovery
//! contributes it.
use std::time::Duration;

use corten::{
    Media, NoStore,
    axum::{body::Bytes, http::StatusCode},
    prelude::*,
    seo,
};
use serde_json::{Map, Value};

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
    url::SitemapPage { kind, page: &page.to_string() }.href()
}

/// A sitemap page: the static one's home page and search, or a page of a kind's public pages, each
/// with when it last changed. Another kind, a page that is not a whole number from 1, or a static
/// page after the first is a 404.
pub(crate) async fn sitemap_page(
    State(config): State<Shared>,
    Params(route): Params<url::SitemapPage<'_>>,
) -> Result<Public<seo::File>, corten::Error> {
    let kind = route.kind.as_str();
    let page = page_number(&route.page).ok_or_else(|| corten::Error::status(StatusCode::NOT_FOUND))?;
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

/// `1.xml`'s page, 1; `None` for anything that is not a whole number from 1 (marketplace's
/// `Number.isInteger(page) && page >= 1`): digits only, so `+1` and `1.5` are not pages.
fn page_number(digits: &str) -> Option<u64> {
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

/// The rail and search events marketplace takes (`itemDetailRailAnalyticsEventNames`).
const RAIL_EVENTS: [&str; 15] = [
    "rail_intent_selected",
    "workflow_selected",
    "similar_item_selected",
    "search_result_selected",
    "reference_info_opened",
    "payout_preview_shown",
    "standard_preview_unavailable",
    "registration_gate_shown",
    "registration_started",
    "registration_return_completed",
    "term_delta_reviewed",
    "intent_persisted",
    "commit_gate_reached",
    "intent_submit_started",
    "validation_failed",
];

/// The labels an event may carry, each a bounded name or nothing.
const RAIL_LABELS: [&str; 8] = ["intent", "workflow", "selection", "topic", "outcome", "gate", "viewer", "surface"];

/// An analytics event marketplace's endpoint takes: its name and labels, the search result's
/// position and keys.
#[derive(Debug, PartialEq)]
pub struct RailEvent {
    pub event: String,
    pub labels: Vec<(&'static str, Option<String>)>,
    pub position: Option<u64>,
    pub query_hash: Option<String>,
    pub result_set_key: Option<String>,
}

/// `POST /analytics/item-detail-rail`: the event logged and a 204, or a 400 for one marketplace
/// would refuse (Corten's error answer, where marketplace's is a line of text no beacon reads). It
/// reads no session, and nothing keeps the answer.
pub(crate) async fn rail_analytics(body: Bytes) -> NoStore<Result<StatusCode, corten::Error>> {
    let Some(event) = rail_event(&body) else {
        return NoStore(Err(corten::Error::status(StatusCode::BAD_REQUEST)));
    };
    let label = |name: &str| event.labels.iter().find(|(key, _)| *key == name).and_then(|(_, value)| value.as_deref());
    tracing::info!(
        r#type = "marketplace.item_detail_rail.analytics_event",
        event = event.event,
        intent = label("intent"),
        workflow = label("workflow"),
        selection = label("selection"),
        topic = label("topic"),
        outcome = label("outcome"),
        gate = label("gate"),
        viewer = label("viewer"),
        surface = label("surface"),
        "Item detail rail analytics event captured."
    );
    NoStore(Ok(StatusCode::NO_CONTENT))
}

/// The event in `body`, as marketplace's `parsePayload` reads it: a JSON object whose `event` is
/// one it knows, each label missing, `null` or a name (ASCII letters, digits, `_`, `.` and `-`, 80
/// at most, trimmed), the position a whole number from 1 to 10,000, and each key a SHA-256 in hex.
/// Anything else is `None`.
pub fn rail_event(body: &[u8]) -> Option<RailEvent> {
    let Value::Object(body) = serde_json::from_slice::<Value>(body).ok()? else { return None };
    let event = body.get("event").and_then(Value::as_str).and_then(name)?;
    if !RAIL_EVENTS.contains(&event.as_str()) {
        return None;
    }
    let labels = RAIL_LABELS
        .iter()
        .map(|key| Some((*key, optional(&body, key, |v| v.as_str().and_then(name))?)))
        .collect::<Option<_>>()?;
    let position = optional(&body, "position", |v| v.as_u64().filter(|n| (1..=10_000).contains(n)))?;
    let query_hash = optional(&body, "queryHash", sha256)?;
    let result_set_key = optional(&body, "resultSetKey", sha256)?;
    Some(RailEvent { event, labels, position, query_hash, result_set_key })
}

/// A field that may be missing or `null` (`Some(None)`); otherwise `read`'s value, and `None` when
/// it reads nothing.
fn optional<T>(body: &Map<String, Value>, key: &str, read: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match body.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(value) => read(value).map(Some),
    }
}

/// A bounded name, trimmed (marketplace's `readBoundedString`).
fn name(text: &str) -> Option<String> {
    let text = text.trim();
    let fits = !text.is_empty()
        && text.len() <= 80
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    fits.then(|| text.to_owned())
}

/// A SHA-256 in lowercase hex, as it is (marketplace's `readOptionalSha256` does not trim).
fn sha256(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then(|| text.to_owned())
}

/// The offline page, the same for everyone: the service worker fetches it when it installs, with
/// the browser's cookies, and shows it later to whoever uses the browser, so it reads no session
/// (`Public`) and draws no account's nav. A cache revalidates it every time (`max-age=0`), so a new
/// deploy's worker keeps the page that names the deploy's stylesheet.
pub(crate) async fn offline(req: Req) -> Public<HtmlResult> {
    // The same page for everyone (the service worker keeps it), so no cart count.
    Public::new(Duration::ZERO, offline_page(&req, None))
}

fn offline_page<For>(req: &Req, cart: Option<u64>) -> corten::Result<corten::HtmlResponse<For>> {
    let t: SiteMsg = req.t();
    let head = html! { <meta name="robots" content="noindex"> };
    req.page(html! {
        <views::Frame req={req} viewer={None} cart={cart} shell={false} title={t.offline_title()} head={head}>
            <views::OfflinePage t={t} />
        </views::Frame>
    })
}

#[cfg(test)]
mod tests {
    use super::{page_number, rail_event};

    #[test]
    fn a_sitemap_page_is_a_whole_number_from_one() {
        assert_eq!(page_number("1"), Some(1));
        assert_eq!(page_number("12"), Some(12));
        for file in ["0", "", "-1", "+1", "1.5", "a", "1.xml"] {
            assert_eq!(page_number(file), None, "{file}");
        }
    }

    #[test]
    fn a_rail_event_is_one_marketplace_knows_with_bounded_labels() {
        let hash = "a".repeat(64);
        let body = format!(
            r#"{{"event":"search_result_selected","surface":" search_results ","intent":null,"position":3,"queryHash":"{hash}","resultSetKey":"{hash}"}}"#
        );
        let event = rail_event(body.as_bytes()).expect("taken");
        assert_eq!(event.event, "search_result_selected");
        assert_eq!(event.position, Some(3));
        assert_eq!(event.query_hash.as_deref(), Some(hash.as_str()));
        assert!(event.labels.contains(&("surface", Some("search_results".to_owned()))));
        assert!(event.labels.contains(&("intent", None)));

        let long = "a".repeat(81);
        for body in [
            "not json".to_owned(),
            "[]".to_owned(),
            r#"{"event":"page_view"}"#.to_owned(),
            r#"{"event":"workflow_selected","intent":"buy now"}"#.to_owned(),
            format!(r#"{{"event":"workflow_selected","topic":"{long}"}}"#),
            r#"{"event":"workflow_selected","viewer":7}"#.to_owned(),
            r#"{"event":"search_result_selected","position":0}"#.to_owned(),
            r#"{"event":"search_result_selected","position":10001}"#.to_owned(),
            r#"{"event":"search_result_selected","position":1.5}"#.to_owned(),
            r#"{"event":"search_result_selected","queryHash":"ABC"}"#.to_owned(),
            format!(r#"{{"event":"search_result_selected","resultSetKey":"{}"}}"#, "A".repeat(64)),
        ] {
            assert_eq!(rail_event(body.as_bytes()), None, "{body}");
        }
    }
}
