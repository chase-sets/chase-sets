//! Router tests against a stand-in Pricing API: what each page draws, what caches may keep, and
//! that nothing about the visitor reaches the API.
use std::sync::{Arc, Mutex};

use corten::axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use crate::{
    api::Platform,
    app::{Config, app},
};

/// What the stand-in received: each call's path and headers.
type Calls = Arc<Mutex<Vec<(String, HeaderMap)>>>;

/// Pricing's public market pages: `twilight` has a last sale and asks, `charizard` a series in
/// two currencies, `down` fails, anything else is not found.
async fn pricing(State(calls): State<Calls>, uri: Uri, headers: HeaderMap) -> Response {
    calls.lock().unwrap().push((uri.path().to_owned(), headers));
    let point = |currency: &str, day: &str, median: Option<&str>, last: &str, low: &str, high: &str| json!({ "currencyCode": currency, "day": day, "firstPriceAmount": last, "lastPriceAmount": last, "minPriceAmount": low, "maxPriceAmount": high, "medianPriceAmount": median, "unitVolume": 1 });
    let aggregate = |currency: &str, last: &str, median: Option<&str>, trades: u64, rate: &str| json!({ "currencyCode": currency, "lastSoldAt": "2026-03-20T11:35:00.000Z", "lastSoldPriceAmount": last, "medianPrice30d": median, "volume30d": trades, "tradeCount30d": trades, "medianPrice90d": median, "volume90d": trades, "tradeCount90d": trades, "sellThroughRate": rate });
    match uri.path() {
        "/api/marketplace/public/market-pages/twilight" => Json(json!({
            "catalogItemId": "cat_twilight", "title": "Twilight Masquerade Elite Trainer Box", "subtitle": "Sealed Elite Trainer Box",
            "slug": "twilight", "productId": "cat_twilight::", "series": [],
            "aggregates": [aggregate("USD", "44.50", None, 0, "0.0000")],
            "marketState": { "day": "2026-10-26", "activeListingCount": 3, "minAskAmount": "43.25", "openOfferCount": 2, "maxBidAmount": "42.25", "spreadAmount": "1.00" },
            "liveAsks": [{ "currencyCode": "USD", "minAskAmount": "43.25", "buyableListingCount": 3 }],
            "unpricedBuyableListingCount": 0,
        }))
        .into_response(),
        "/api/marketplace/public/market-pages/charizard" => Json(json!({
            "catalogItemId": "cat_charizard", "title": "Charizard", "subtitle": null, "slug": "charizard", "productId": "p",
            "series": [
                point("USD", "2026-09-02", Some("390.00"), "395.00", "380.00", "400.00"),
                point("USD", "2026-09-01", None, "380.00", "380.00", "380.00"),
                point("CAD", "2026-09-01", Some("520.00"), "520.00", "520.00", "520.00"),
            ],
            "aggregates": [aggregate("USD", "395.00", Some("390.00"), 3, "0.4567"), aggregate("CAD", "520.00", None, 1, "0.1000")],
            "marketState": { "day": "2026-10-26", "activeListingCount": 0, "minAskAmount": null, "openOfferCount": 0, "maxBidAmount": null, "spreadAmount": null },
            "liveAsks": [], "unpricedBuyableListingCount": 1,
        }))
        .into_response(),
        "/api/marketplace/public/market-pages/down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "/api/marketplace/public/market-pages" => Json(json!({ "items": [
            { "slug": "twilight", "updatedAt": "2026-10-26T17:18:39.931Z" },
            { "slug": "a&b", "updatedAt": "2026-10-01T00:00:00.000Z" },
        ], "count": 2 }))
        .into_response(),
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": { "code": "not_found", "message": "Market page not found." } }))).into_response(),
    }
}

struct Site {
    router: Router,
    calls: Calls,
}

impl Site {
    async fn new(indexing: bool, origin: &str) -> Self {
        let calls = Calls::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let stand_in = Router::new().fallback(pricing).with_state(calls.clone());
        tokio::spawn(async move { corten::axum::serve(listener, stand_in).await.unwrap() });
        let config = Config {
            platform: Platform::new(&api),
            origin: origin.into(),
            marketplace: "https://marketplace.chasesets.com".into(),
            indexing,
        };
        Site { router: app(config).router(), calls }
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> (StatusCode, HeaderMap, String) {
        let mut req = Request::get(path).header(header::HOST, "localhost:7797");
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        let res = self.router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8(body.to_vec()).unwrap())
    }
}

fn cache(headers: &HeaderMap) -> &str {
    headers.get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).unwrap_or("")
}

#[tokio::test]
async fn a_market_page_draws_the_items_stats_and_links_and_any_cache_may_keep_it() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/market/twilight", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(cache(&headers), "public, max-age=60, stale-while-revalidate=3600");
    assert!(headers.get_all(header::VARY).iter().any(|v| v.to_str().unwrap().contains("cookie")), "{headers:?}");
    assert!(page.contains("<title>Twilight Masquerade Elite Trainer Box Price History | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/market/twilight""#), "{page}");
    assert!(page.contains(r#"<meta property="og:url" content="https://chasesets.com/market/twilight""#), "{page}");
    assert!(!page.contains("noindex"), "{page}");
    assert!(page.contains(r#"<h1 class="market-page__title">Twilight Masquerade Elite Trainer Box</h1>"#), "{page}");
    assert_eq!(page.matches("<h1").count(), 1, "{page}");
    // The stats are a list, not headings, and say what public-web says.
    for text in [
        "Last sold",
        "$44.50",
        "Mar 20, 2026",
        "Median (30 days)",
        "No data yet",
        "0 trades",
        "Active listings",
        ">3<",
        "Starting at $43.25",
        "0% sell-through (30 days)",
    ] {
        assert!(page.contains(text), "{text} in {page}");
    }
    // Price history, Market stats and Buy or sell: public-web's stat values are headings too.
    assert_eq!(page.matches("<h2").count(), 3, "{page}");
    // No trades in the series: the empty chart.
    assert!(page.contains("Data will appear here once activity accumulates."), "{page}");
    assert!(!page.contains("<svg viewBox=\"0 0 640 220\""), "{page}");
    assert_eq!(page.matches(r#"href="https://marketplace.chasesets.com/items/twilight""#).count(), 3, "{page}");
    // The lowest ask as a Product, on the production site.
    assert!(page.contains(r#""lowPrice":"43.25""#), "{page}");
    // The API was asked for the page with nothing of the visitor's.
    let calls = site.calls.lock().unwrap();
    let (path, sent) = &calls[0];
    assert_eq!(path, "/api/marketplace/public/market-pages/twilight");
    assert!(sent.get(header::COOKIE).is_none());
    assert_eq!(sent["x-forwarded-host"], "chasesets.com");
    assert_eq!(sent["chase-sets-read-target-context"], "pricing");
}

#[tokio::test]
async fn a_visitor_with_a_cookie_gets_the_same_page_kept_by_their_browser_only() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/market/twilight", Some("chase_sets_session=s")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache(&headers), "private, no-cache");
    assert!(page.contains("Starting at $43.25"));
    assert!(site.calls.lock().unwrap().iter().all(|(_, sent)| sent.get(header::COOKIE).is_none()));
}

#[tokio::test]
async fn each_currency_has_its_chart_and_stats_and_a_single_day_is_not_a_trend() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, _, page) = site.get("/market/charizard", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    for text in [
        "Price history (USD)",
        "Market stats (USD)",
        "Price history (CAD)",
        "Market stats (CAD)",
        "46% sell-through (30 days)",
        "10% sell-through (30 days)",
        "Price unavailable",
    ] {
        assert!(page.contains(text), "{text} in {page}");
    }
    // USD: two days, the median or else the last price, a band from each day's low to high.
    assert_eq!(
        page.matches(r#"<svg viewBox="0 0 640 220" role="img" aria-label="Price history for Charizard""#).count(),
        1,
        "{page}"
    );
    assert!(page.contains("Charizard: 2 points, from $380.00 to $390.00."), "{page}");
    assert_eq!(page.matches("time-series__chart-band").count(), 1, "{page}");
    // CAD: one day.
    assert!(page.contains("Not enough data yet"), "{page}");
    // The asks are shown once, under the first currency; there are none, and a listing has no price.
    assert_eq!(page.matches("Price unavailable").count(), 1, "{page}");
    // No priced listing: no structured data.
    assert!(!page.contains("application/ld+json"), "{page}");
}

#[tokio::test]
async fn an_unknown_page_is_not_found_and_a_failed_read_is_a_502_no_cache_keeps() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/market/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{page}");
    assert_eq!(cache(&headers), "private, no-cache");
    assert!(
        page.contains("Page not found") && page.contains("This public page does not exist or is no longer available."),
        "{page}"
    );
    assert!(page.contains(r#"href="http://localhost:7754/""#), "{page}");
    let (status, headers, page) = site.get("/market/down", None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{page}");
    assert_eq!(cache(&headers), "private, no-cache");
    assert!(page.contains("Public page error"), "{page}");
}

#[tokio::test]
async fn off_the_production_site_or_without_indexing_there_is_no_structured_data() {
    let site = Site::new(true, "http://localhost:7797").await;
    let (_, _, page) = site.get("/market/twilight", None).await;
    assert!(page.contains(r#"<link rel="canonical" href="http://localhost:7797/market/twilight""#), "{page}");
    assert!(!page.contains("application/ld+json"), "{page}");
    let site = Site::new(false, "https://chasesets.com").await;
    let (_, _, page) = site.get("/market/twilight", None).await;
    assert!(page.contains(r#"<meta name="robots" content="noindex,nofollow""#), "{page}");
    assert!(!page.contains("application/ld+json"), "{page}");
}

#[tokio::test]
async fn robots_and_the_sitemap_follow_indexing() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, robots) = site.get("/robots.txt", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(cache(&headers).starts_with("public, max-age="), "{headers:?}");
    assert_eq!(robots, "User-agent: *\nAllow: /\nSitemap: https://chasesets.com/sitemap.xml\n");
    let (status, headers, sitemap) = site.get("/sitemap.xml", None).await;
    assert_eq!(status, StatusCode::OK, "{sitemap}");
    assert!(headers[header::CONTENT_TYPE].to_str().unwrap().contains("xml"));
    assert!(
        sitemap.contains("<loc>https://chasesets.com/market/twilight</loc><lastmod>2026-10-26T17:18:39.931Z</lastmod>"),
        "{sitemap}"
    );
    assert!(
        sitemap.contains("<loc>https://chasesets.com/market/a&amp;b</loc>") || sitemap.contains("/market/a%26b</loc>"),
        "{sitemap}"
    );

    let site = Site::new(false, "https://chasesets.com").await;
    let (_, _, robots) = site.get("/robots.txt", None).await;
    assert_eq!(robots, "User-agent: *\nDisallow: /\n");
    let (status, _, sitemap) = site.get("/sitemap.xml", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!sitemap.contains("<url>"), "{sitemap}");
    assert!(site.calls.lock().unwrap().is_empty(), "no read when the site is not indexed");
}

#[test]
fn indexing_is_on_unless_the_variable_says_off() {
    use crate::app::indexing;
    assert!(indexing(None));
    assert!(indexing(Some("true")));
    assert!(indexing(Some("1")));
    for off in ["0", "false", "No", "OFF"] {
        assert!(!indexing(Some(off)), "{off}");
    }
}
