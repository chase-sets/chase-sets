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

/// Pricing's public market pages: `twilight` has a last sale and asks, and a revised display
/// policy's `s-maxage` (an hour), `charizard` a series in two currencies and no cache header,
/// `down` fails, anything else is not found.
async fn pricing(State(calls): State<Calls>, uri: Uri, headers: HeaderMap, body: corten::axum::body::Bytes) -> Response {
    calls.lock().unwrap().push((uri.path().to_owned(), headers.clone()));
    if uri.path().starts_with("/api/public-presence/") {
        return presence(uri.path(), &headers, &body);
    }
    let point = |currency: &str, day: &str, median: Option<&str>, last: &str, low: &str, high: &str| json!({ "currencyCode": currency, "day": day, "firstPriceAmount": last, "lastPriceAmount": last, "minPriceAmount": low, "maxPriceAmount": high, "medianPriceAmount": median, "unitVolume": 1 });
    let aggregate = |currency: &str, last: &str, median: Option<&str>, trades: u64, rate: &str| json!({ "currencyCode": currency, "lastSoldAt": "2026-03-20T11:35:00.000Z", "lastSoldPriceAmount": last, "medianPrice30d": median, "volume30d": trades, "tradeCount30d": trades, "medianPrice90d": median, "volume90d": trades, "tradeCount90d": trades, "sellThroughRate": rate });
    match uri.path() {
        "/api/marketplace/public/market-pages/twilight" => (
            [(header::CACHE_CONTROL, "public, max-age=60, s-maxage=3600, stale-while-revalidate=3600")],
            Json(json!({
            "catalogItemId": "cat_twilight", "title": "Twilight Masquerade Elite Trainer Box", "subtitle": "Sealed Elite Trainer Box",
            "slug": "twilight", "productId": "cat_twilight::", "series": [],
            "aggregates": [aggregate("USD", "44.50", None, 0, "0.0000")],
            "marketState": { "day": "2026-10-26", "activeListingCount": 3, "minAskAmount": "43.25", "openOfferCount": 2, "maxBidAmount": "42.25", "spreadAmount": "1.00" },
            "liveAsks": [{ "currencyCode": "USD", "minAskAmount": "43.25", "buyableListingCount": 3 }],
            "unpricedBuyableListingCount": 0,
            })),
        )
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

/// What the stand-in's waitlist received: each signup's body and the address it was sent for.
static SIGNUPS: Mutex<Vec<(serde_json::Value, Option<String>)>> = Mutex::new(Vec::new());

/// Public Presence: live fee terms (card 3.25% + $0.30, bank 0%), two titled promo messages and an
/// untitled one, a counter of 1200, and a waitlist that refuses `refused@`, limits `limited@`
/// and fails `down@`.
fn presence(path: &str, headers: &HeaderMap, body: &[u8]) -> Response {
    match path {
        "/api/public-presence/policy-values" => Json(json!({ "values": {
            "checkout-processing-fee.card.bps": { "type": "bps", "value": 325 },
            "checkout-processing-fee.card.fixed": { "type": "money", "value": "0.30" },
            "checkout-processing-fee.bank-account.bps": { "type": "bps", "value": 0 },
            "checkout-processing-fee.bank-account.fixed": { "type": "money", "value": "0.00" },
        } }))
        .into_response(),
        "/api/public-presence/promo-bar-messages" => Json(json!({ "items": [
            { "id": "a", "title": "Earn 5% toward shipping on all orders.", "description": "Shipping credit stays visible.", "href": "/order-protection", "link_label": "Order protection", "tone": "success" },
            { "id": "b", "title": "", "tone": "info" },
            { "id": "c", "title": "0% seller fees on beta listings.", "description": null, "href": null, "link_label": null, "tone": "danger" },
        ] }))
        .into_response(),
        "/api/public-presence/waitlist/count" => Json(json!({ "displayCount": 1200 })).into_response(),
        "/api/public-presence/waitlist" => {
            let signup: serde_json::Value = serde_json::from_slice(body).unwrap();
            let client = headers.get("x-forwarded-for").map(|v| v.to_str().unwrap().to_owned());
            let email = signup["email"].as_str().unwrap_or("").to_owned();
            SIGNUPS.lock().unwrap().push((signup, client));
            if email.starts_with("refused@") {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": { "code": "validation_failed", "message": "Enter a valid email." } }))).into_response()
            } else if email.starts_with("limited@") {
                (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": { "code": "rate_limited", "message": "Too many requests." } }))).into_response()
            } else if email.starts_with("down@") {
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            } else {
                (StatusCode::CREATED, Json(json!({ "id": "wls_01", "version": 1, "status": "joined" }))).into_response()
            }
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": { "code": "not_found", "message": "Not found." } }))).into_response(),
    }
}

struct Site {
    router: Router,
    calls: Calls,
}

impl Site {
    async fn new(indexing: bool, origin: &str) -> Self {
        Site::with(indexing, origin, false).await
    }

    /// A site whose deployment trusts its proxy's forwarded headers, or not.
    async fn with(indexing: bool, origin: &str, trust_forwarded: bool) -> Self {
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
            discord: None,
            trust_forwarded,
            home: Default::default(),
        };
        Site { router: app(config).router(), calls }
    }

    async fn post(&self, path: &str, form: &str, forwarded: Option<&str>) -> (StatusCode, HeaderMap, String) {
        let mut req = Request::post(path)
            .header(header::HOST, "localhost:7797")
            .header(header::ORIGIN, "http://localhost:7797")
            .header("sec-fetch-site", "same-origin")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        if let Some(forwarded) = forwarded {
            req = req.header("x-forwarded-for", forwarded);
        }
        let res = self.router.clone().oneshot(req.body(Body::from(form.to_owned())).unwrap()).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8(body.to_vec()).unwrap())
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
    // A browser keeps it a minute; a shared cache for the s-maxage Pricing's answer carries.
    assert_eq!(cache(&headers), "public, max-age=60, s-maxage=3600, stale-while-revalidate=3600");
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
    let (status, headers, page) = site.get("/market/charizard", None).await;
    // Pricing set no s-maxage: a shared cache keeps the display policy's default day.
    assert_eq!(cache(&headers), "public, max-age=60, s-maxage=86400, stale-while-revalidate=3600");
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
    assert!(page.contains(r#"href="/">"#), "the home page is this app's, in the other layout: {page}");
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

#[tokio::test]
async fn the_home_page_draws_the_waitlists_landing_and_any_cache_may_keep_it() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    // The fee terms are live: a browser keeps it a minute, a shared cache four.
    assert_eq!(cache(&headers), "public, max-age=60, s-maxage=240, stale-while-revalidate=60");
    assert!(page.contains("<title>Chase Sets Early Access | Trading Card Marketplace</title>"), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/""#), "{page}");
    assert!(page.contains(r#"<meta name="twitter:card" content="summary_large_image""#), "{page}");
    assert!(
        page.contains(r#"<meta property="og:image" content="https://chasesets.com/assets/"#)
            && page.contains(r#"/home/chase-sets-og-default.png""#),
        "the social card is absolute: {page}"
    );
    // The seller's hero is shown and the buyer's is hidden; the foil word is one span.
    assert!(page.contains(r#"The <span class="home-page__foil">marketplace</span> that works both ways."#), "{page}");
    assert!(page.contains(r#"data-variant-copy="seller_first_v2" hidden"#), "{page}");
    // Both forms post to the address, with the hero's role as radios and the source fields.
    assert_eq!(page.matches(r#"<form class="home-page__form" method="post" action="/""#).count(), 2, "{page}");
    assert!(page.contains(r#"<input type="radio" name="role" value="both" checked>"#), "{page}");
    assert!(page.contains(r#"name="website" tabindex="-1""#), "the honeypot: {page}");
    // The live terms reach the FAQ and its structured data; the counter and the titled promos are drawn.
    assert!(page.contains("3.25% + $0.30 by card, 0% by bank account"), "{page}");
    assert!(
        page.contains(r#""@type":"FAQPage""#) && page.contains(r#""target":"https://chasesets.com/#waitlist-form""#),
        "{page}"
    );
    assert!(page.contains("Join 1200+ collectors and sellers already on the list"), "{page}");
    assert!(
        page.contains("Earn 5% toward shipping on all orders.") && page.contains("0% seller fees on beta listings."),
        "{page}"
    );
    assert_eq!(page.matches("data-promo=").count(), 2, "the untitled message is left out: {page}");
    assert!(page.contains(r#"href="http://localhost:7754/order-protection""#), "{page}");
    // The roster keeps the address's query and lands on the hero's form.
    assert!(page.contains(r#"href="/?game=pokemon#waitlist-form""#), "{page}");
    // Nothing about the visitor reached the API.
    assert!(site.calls.lock().unwrap().iter().all(|(_, h)| h.get(header::COOKIE).is_none()));

    // A buyer's campaign gets the buyer's hero and Buy; a game gets its title and card.
    let (_, _, page) = site.get("/?utm_campaign=collectors&game=yu-gi-oh", None).await;
    assert!(page.contains(r#"data-variant-copy="seller_first_v1" hidden"#), "{page}");
    assert!(page.contains(r#"<input type="radio" name="role" value="buy" checked>"#), "{page}");
    assert!(page.contains("Yu-Gi-Oh! Singles | Chase Sets Early Access"), "{page}");
    assert!(page.contains("chase-sets-og-yu-gi-oh"), "{page}");
    assert!(page.contains(r#"<input type="hidden" name="games" value="yu-gi-oh">"#), "{page}");
    assert!(page.contains(r#"href="/?utm_campaign=collectors&amp;game=pokemon#waitlist-form""#), "{page}");
    // The reads are kept: a second visit reads nothing again.
    let reads = site.calls.lock().unwrap().len();
    site.get("/", None).await;
    assert_eq!(site.calls.lock().unwrap().len(), reads, "kept for the next visitor");
}

#[tokio::test]
async fn an_old_fee_calculator_share_link_moves_to_the_compare_page() {
    let site = Site::new(true, "https://chasesets.com").await;
    let query = "price=12.50&utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep";
    let (status, headers, _) = site.get(&format!("/?{query}"), None).await;
    assert_eq!(status, StatusCode::MOVED_PERMANENTLY);
    assert_eq!(headers[header::LOCATION], format!("http://localhost:7754/compare/tcgplayer?{query}#fee-calculator"));
    assert!(site.calls.lock().unwrap().is_empty(), "no read for a move");
}

#[tokio::test]
async fn joining_sends_the_signup_and_goes_to_the_welcome_page() {
    let site = Site::new(true, "https://chasesets.com").await;
    let form = "panel=hero&email=ada%40example.com&role=buy&games=pokemon&games=pokemon&website=&page_path=%2F%3Fref%3Dwls_9&referrer=https%3A%2F%2Fexample.com%2F&utm_source=&utm_medium=&utm_campaign=x&utm_content=&utm_term=&referred_by_signup_id=wls_9";
    let (status, headers, page) = site.post("/?ref=wls_9", form, Some("198.51.100.1, 203.0.113.7, 10.0.0.2")).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    assert_eq!(
        headers[header::LOCATION],
        "http://localhost:7754/welcome?signup=wls_01&fresh=1&role=buy&variant=seller_first_v2&game=pokemon&attributed=1"
    );
    {
        let signups = SIGNUPS.lock().unwrap();
        let (signup, client) = signups.iter().find(|(s, _)| s["email"] == "ada@example.com").unwrap();
        assert_eq!(signup["role"], "buy");
        assert_eq!(signup["interests"], json!(["set-completion"]), "the hero's buyer stands for set completion");
        assert_eq!(signup["referredBySignupId"], "wls_9");
        assert_eq!(signup["website"], serde_json::Value::Null);
        assert_eq!(signup["source"]["pagePath"], "/?ref=wls_9");
        assert_eq!(signup["source"]["referrer"], "https://example.com/");
        assert_eq!(signup["source"]["utmCampaign"], "x");
        assert_eq!(signup["source"]["utmSource"], serde_json::Value::Null);
        assert_eq!(*client, None, "no address unless the deployment trusts its proxy");
    }

    let site = Site::with(true, "https://chasesets.com", true).await;
    let form = "panel=final&email=grace%40example.com&role=both&interests=bulk-listing&page_path=%2F";
    let (status, headers, _) = site.post("/", form, Some("198.51.100.1, 203.0.113.7, 10.0.0.2")).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(
        headers[header::LOCATION],
        "http://localhost:7754/welcome?signup=wls_01&fresh=1&role=both&variant=seller_first_v1"
    );
    let signups = SIGNUPS.lock().unwrap();
    let (signup, client) = signups.iter().find(|(s, _)| s["email"] == "grace@example.com").unwrap();
    assert_eq!(signup["interests"], json!(["bulk-listing"]));
    assert_eq!(signup["marketingConsent"], false);
    assert_eq!(client.as_deref(), Some("203.0.113.7"), "the nearest public hop, so each visitor has their own limit");
}

#[tokio::test]
async fn a_refused_signup_draws_the_page_again_with_the_apis_message() {
    let site = Site::new(true, "https://chasesets.com").await;
    let form = "panel=final&email=refused%40example.com&role=sell&interests=pricing-tools&marketing_consent=yes&page_path=%2F";
    let (status, headers, page) = site.post("/", form, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{page}");
    assert_eq!(cache(&headers), "private, no-cache", "{headers:?}");
    assert!(page.contains("Enter a valid email."), "{page}");
    assert!(page.contains(r#"value="refused@example.com""#), "what was sent stays in its form: {page}");
    assert!(page.contains(r#"<option value="pricing-tools" selected>"#), "{page}");
    assert!(page.contains(r#"name="marketing_consent" value="yes" checked"#), "{page}");
    assert!(page.contains("data-failed"), "{page}");
    let (status, _, page) = site.post("/", "panel=hero&email=limited%40example.com&role=both&page_path=%2F", None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{page}");
    assert!(page.contains("Too many requests."), "{page}");
    let (status, _, page) = site.post("/", "panel=hero&email=down%40example.com&role=both&page_path=%2F", None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{page}");
    assert!(page.contains("We could not request early access. Please check the form and try again."), "{page}");
}
