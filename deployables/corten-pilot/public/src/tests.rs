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

/// What the stand-in's cohort-quality saves received: each body and the address it was sent for.
static COHORTS: Mutex<Vec<(serde_json::Value, Option<String>)>> = Mutex::new(Vec::new());

/// Public Presence: live fee terms (card 3.25% + $0.30, bank 0%), two titled promo messages and an
/// untitled one, a counter of 1200, and a waitlist that refuses `refused@`, limits `limited@`
/// and fails `down@`; `wls_01`'s referral summary (12th of 40, one of three referrals) and
/// cohort-quality saves, and `wls_goal`'s summary (the goal reached, the place not caught up);
/// any other signup's reads fail.
fn presence(path: &str, headers: &HeaderMap, body: &[u8]) -> Response {
    match path {
        "/api/public-presence/policy-values" => Json(policy_values()).into_response(),
        "/api/public-presence/promo-bar-messages" => Json(json!({ "items": [
            { "id": "a", "title": "Earn 5% toward shipping on all orders.", "description": "Shipping credit stays visible.", "href": "/order-protection", "link_label": "Order protection", "tone": "success" },
            { "id": "b", "title": "", "tone": "info" },
            { "id": "c", "title": "0% seller fees on beta listings.", "description": null, "href": null, "link_label": null, "tone": "danger" },
        ] }))
        .into_response(),
        "/api/public-presence/waitlist/count" => Json(json!({ "displayCount": 1200 })).into_response(),
        "/api/public-presence/waitlist/wls_01/referral-summary" => Json(json!({
            "referralCount": 1, "referralGoal": 3, "queuePosition": 12, "totalSignups": 40, "positionsAdvanced": 2,
        }))
        .into_response(),
        "/api/public-presence/waitlist/wls_goal/referral-summary" => {
            Json(json!({ "referralCount": 4, "referralGoal": 3, "queuePosition": null, "totalSignups": 40, "positionsAdvanced": 0 }))
                .into_response()
        }
        "/api/public-presence/waitlist/wls_01/cohort-quality" => {
            let client = headers.get("x-forwarded-for").map(|v| v.to_str().unwrap().to_owned());
            COHORTS.lock().unwrap().push((serde_json::from_slice(body).unwrap(), client));
            Json(json!({ "id": "wls_01", "version": 2, "status": "saved" })).into_response()
        }
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

/// The policy values envelope: every whitelisted value but the high-value clearance threshold, and
/// the standard sales fee dropping to 7.5% on November 15 (within the 30-day callout).
fn policy_values() -> serde_json::Value {
    let plain =
        |kind: &str, value: serde_json::Value| json!({ "type": kind, "value": value, "effectiveFrom": null, "upcoming": [] });
    let usd = |amount: &str| json!({ "type": "money", "value": amount, "currency": "USD", "effectiveFrom": "2026-01-01T00:00:00.000Z", "upcoming": [] });
    let mut values = serde_json::Map::new();
    values.insert(
        "marketplace-sales-fee.standard.bps".into(),
        json!({ "type": "bps", "value": 800, "effectiveFrom": null, "upcoming": [{ "value": 750, "effectiveFrom": "2026-11-15T00:00:00.000Z" }] }),
    );
    for (key, value) in [
        ("marketplace-sales-fee.standard.fixed", usd("0.30")),
        ("marketplace-sales-fee.standard.cap", usd("50.00")),
        ("marketplace-sales-fee.shipping-allowance.bps", plain("bps", json!(500))),
        ("checkout-processing-fee.card.bps", plain("bps", json!(325))),
        ("checkout-processing-fee.card.fixed", usd("0.30")),
        ("checkout-processing-fee.bank-account.bps", plain("bps", json!(0))),
        ("checkout-processing-fee.bank-account.fixed", usd("0.00")),
        ("checkout-processing-fee.platform-credit.bps", plain("bps", json!(0))),
        ("checkout-processing-fee.platform-credit.fixed", usd("0.00")),
        ("settlement.clearance.base.days", plain("days", json!(3))),
        ("settlement.clearance.extended.days", plain("days", json!(14))),
        ("settlement.payout.minimum", usd("1.00")),
        ("settlement.payout.maximum", usd("25000.00")),
        ("settlement.payout-fee.bps", plain("bps", json!(25))),
        ("settlement.payout-fee.fixed", usd("0.25")),
        ("settlement.payout-fee.monthly", usd("2.00")),
        ("support-deadlines.product-not-received.seller-response.hours", plain("hours", json!(48))),
        ("support-deadlines.product-not-received.support-review.hours", plain("hours", json!(72))),
        ("support-deadlines.item-problem.post-delivery-open.days", plain("days", json!(30))),
        ("support-deadlines.product-not-as-described.seller-response.hours", plain("hours", json!(48))),
        ("support-deadlines.product-damaged.seller-response.hours", plain("hours", json!(48))),
        ("support-deadlines.wrong-product-received.seller-response.hours", plain("hours", json!(48))),
        ("support-deadlines.missing-products.seller-response.hours", plain("hours", json!(48))),
        ("support-deadlines.return-request.seller-response.hours", plain("hours", json!(48))),
        ("support-deadlines.buyer-cancel-request.seller-response.hours", plain("hours", json!(24))),
    ] {
        values.insert(key.into(), value);
    }
    json!({ "values": values, "resolvedAt": "2026-10-28T12:00:00.000Z", "propagationSeconds": 60, "changeCalloutDays": 30 })
}

struct Site {
    router: Router,
    calls: Calls,
}

impl Site {
    async fn new(indexing: bool, origin: &str) -> Self {
        Site::with(indexing, origin, false).await
    }

    /// A site whose developer portal is open or not.
    async fn with(indexing: bool, origin: &str, developers: bool) -> Self {
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
            developers,
            home: Default::default(),
        };
        Site { router: app(config).router(), calls }
    }

    /// A form post; `from` is the connection's address and the `X-Forwarded-For` it sends (a
    /// `oneshot` request has no address of its own).
    async fn post(&self, path: &str, form: &str, from: Option<(&str, &str)>) -> (StatusCode, HeaderMap, String) {
        let mut req = Request::post(path)
            .header(header::HOST, "localhost:7797")
            .header(header::ORIGIN, "http://localhost:7797")
            .header("sec-fetch-site", "same-origin")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        if let Some((_, forwarded)) = from {
            req = req.header("x-forwarded-for", forwarded);
        }
        let mut req = req.body(Body::from(form.to_owned())).unwrap();
        if let Some((peer, _)) = from {
            let peer: std::net::SocketAddr = format!("{peer}:50000").parse().unwrap();
            req.extensions_mut().insert(corten::axum::extract::ConnectInfo(peer));
        }
        let res = self.router.clone().oneshot(req).await.unwrap();
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
    assert!(page.contains(r#"href="/order-protection""#), "{page}");
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
    assert_eq!(headers[header::LOCATION], format!("/compare/tcgplayer?{query}#fee-calculator"));
    assert!(site.calls.lock().unwrap().is_empty(), "no read for a move");
}

#[tokio::test]
async fn joining_sends_the_signup_and_goes_to_the_welcome_page() {
    let site = Site::new(true, "https://chasesets.com").await;
    let form = "panel=hero&email=ada%40example.com&role=buy&games=pokemon&games=pokemon&website=&page_path=%2F%3Fref%3Dwls_9&referrer=https%3A%2F%2Fexample.com%2F&utm_source=&utm_medium=&utm_campaign=x&utm_content=&utm_term=&referred_by_signup_id=wls_9";
    let (status, headers, page) = site.post("/?ref=wls_9", form, None).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{page}");
    assert_eq!(
        headers[header::LOCATION],
        "/welcome?signup=wls_01&fresh=1&role=buy&variant=seller_first_v2&game=pokemon&attributed=1"
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
        assert_eq!(*client, None, "no address when the connection's is not known");
    }

    let form = "panel=final&email=grace%40example.com&role=both&interests=bulk-listing&page_path=%2F";
    let (status, headers, _) = site.post("/", form, Some(("203.0.113.7", "198.51.100.1"))).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/welcome?signup=wls_01&fresh=1&role=both&variant=seller_first_v1");
    let signups = SIGNUPS.lock().unwrap();
    let (signup, client) = signups.iter().find(|(s, _)| s["email"] == "grace@example.com").unwrap();
    assert_eq!(signup["interests"], json!(["bulk-listing"]));
    assert_eq!(signup["marketingConsent"], false);
    assert_eq!(
        client.as_deref(),
        Some("203.0.113.7"),
        "the connection's address, not what the browser wrote: no proxy is listed (PROXIES), so the header is not read"
    );
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

#[tokio::test]
async fn a_policy_page_draws_its_document_and_says_counsel_review_is_pending() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/terms", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    // The promo bar was read: a cache in front keeps it as long as the home page.
    assert_eq!(cache(&headers), "public, max-age=60, s-maxage=240, stale-while-revalidate=60");
    assert!(page.contains("<title>Terms | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/terms""#), "{page}");
    // The terms stay indexable while counsel reviews them; their posture is in the metadata.
    assert!(!page.contains("noindex"), "{page}");
    assert!(page.contains(r#"<meta name="chase-sets:policy-key" content="terms-of-service""#), "{page}");
    assert!(page.contains(r#"<meta name="chase-sets:policy-publication-status" content="counsel-review-required""#), "{page}");
    assert!(!page.contains("chase-sets:policy-effective-at"), "{page}");
    assert!(page.contains(r#"data-policy-publication-status="counsel-review-required" data-policy-effective-at="""#), "{page}");
    assert_eq!(page.matches("<h1").count(), 1, "{page}");
    assert!(page.contains(">Terms of service</h1>"), "{page}");
    // The terms' own words; Print waits for the script.
    assert!(page.contains("Counsel review required before these terms take effect"), "{page}");
    assert!(page.contains(r#"role="alert""#), "{page}");
    assert!(page.contains(r#"type="button" hidden"#) && page.contains(">Print terms</button>"), "{page}");
    assert!(
        page.contains("/scripts/home.js") && !page.contains("policy_page"),
        "Print's handlers are in the shell's script: {page}"
    );
    assert!(
        page.contains("Version v1") && page.contains("Effective date pending counsel approval") && page.contains("Locale en"),
        "{page}"
    );
    // The contents link each section, whose heading carries the id; a pending section has its badge.
    assert!(page.contains(r##"<a href="#wallet-nature-custody-interest">Wallet nature, custody, and interest</a>"##), "{page}");
    assert!(page.contains(r#"aria-labelledby="wallet-nature-custody-interest""#), "{page}");
    assert!(page.contains(r#"id="wallet-nature-custody-interest">Wallet nature, custody, and interest</h2>"#), "{page}");
    assert_eq!(page.matches("Counsel-approved language required").count(), 22, "every section of the draft");
    // A mention of a sibling document links to its page here; an unresolved claim says what the
    // registry says.
    assert!(page.contains(r#"<a href="/seller-agreement">chasesets.com/seller-agreement</a>"#), "{page}");
    assert!(page.contains("Whether Wallet balances are treated as a bank deposit"), "{page}");
    // The shell: the promo bar, and the footer's links, all here now.
    assert_eq!(page.matches("data-promo=").count(), 2, "{page}");
    assert!(page.contains(r#"<li><a href="/privacy">"#), "{page}");
    assert!(page.contains(r#"<li><a href="/help">"#), "{page}");
    assert!(page.contains(r#"<li><a href="/contact">"#), "{page}");

    // Another document: the corpus's words, and out of search while counsel reviews it.
    let (status, _, page) = site.get("/seller-agreement", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains(r#"<meta name="robots" content="noindex, nofollow""#), "{page}");
    assert!(page.contains("Counsel review required before this document takes effect"), "{page}");
    assert!(page.contains(">Print document</button>") && page.contains("Seller agreement"), "{page}");

    // The founders' terms are shared: indexable, with the founders' social card.
    let (_, _, page) = site.get("/founders", None).await;
    assert!(!page.contains("noindex"), "{page}");
    assert!(page.contains(r#"<meta property="og:url" content="https://chasesets.com/founders""#), "{page}");
    assert!(
        page.contains(r#"<meta property="og:image" content="https://chasesets.com/assets/"#)
            && page.contains("chase-sets-og-founders"),
        "{page}"
    );
    assert!(page.contains(">Founders offer terms</h1>"), "{page}");

    for path in ["/privacy", "/payments-terms", "/agent-terms", "/authenticity-terms"] {
        let (status, _, page) = site.get(path, None).await;
        assert_eq!(status, StatusCode::OK, "{path}: {page}");
        assert_eq!(page.matches("<h1").count(), 1, "{path}");
    }
    // Nothing about the visitor reached the API.
    assert!(
        site.calls
            .lock()
            .unwrap()
            .iter()
            .all(|(path, h)| path.starts_with("/api/public-presence/") && h.get(header::COOKIE).is_none())
    );
}

#[tokio::test]
async fn a_policy_page_on_a_site_that_is_not_indexed_says_so() {
    let site = Site::new(false, "https://chasesets.com").await;
    let (_, _, page) = site.get("/terms", None).await;
    assert!(page.contains(r#"<meta name="robots" content="noindex,nofollow""#), "{page}");
}

#[tokio::test]
async fn the_sitemap_lists_the_home_page_and_the_public_policy_pages_first() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (_, _, sitemap) = site.get("/sitemap.xml", None).await;
    for loc in [
        "https://chasesets.com/",
        "https://chasesets.com/terms",
        "https://chasesets.com/privacy",
        "https://chasesets.com/founders",
    ] {
        assert!(sitemap.contains(&format!("<loc>{loc}</loc>")), "{loc}: {sitemap}");
    }
    assert!(!sitemap.contains("/seller-agreement"), "a document out of search is not in the sitemap: {sitemap}");
    for loc in
        ["https://chasesets.com/help", "https://chasesets.com/help/selling", "https://chasesets.com/help/selling/getting-paid"]
    {
        assert!(sitemap.contains(&format!("<loc>{loc}</loc>")), "{loc}: {sitemap}");
    }
    assert!(!sitemap.contains("/faq<"), "a moved address is not listed: {sitemap}");
    let (_, _, home) = site.get("/", None).await;
    assert!(home.contains(r#"href="/founders""#), "the home page's founders links are here now: {home}");
}

#[tokio::test]
async fn the_welcome_page_says_where_the_signup_stands_and_asks_a_seller_the_wave_questions() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site
        .get("/welcome?signup=wls_01&fresh=1&role=sell&variant=seller_first_v2&game=pokemon&game=zzz&attributed=1", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(!cache(&headers).starts_with("public"), "about one signup: {headers:?}");
    assert!(page.contains("<title>You&#39;re on the list | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<meta name="robots" content="noindex, nofollow""#), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/welcome""#), "{page}");
    assert!(page.contains(">You are on the list</h1>"), "{page}");
    // The summary is read with the page: the place, the advance and the progress.
    assert!(page.contains("You&#39;re #12 of 40 in the beta invite line."), "{page}");
    assert!(page.contains("Up 2 in line thanks to your referrals."), "{page}");
    assert!(page.contains(r#"max="3" value="1""#) && page.contains("1 of 3"), "{page}");
    assert!(page.contains("Invite 3 sellers or buyers"), "{page}");
    // The referral link on the site's origin, with Copy only for a script, and the share links.
    assert!(
        page.contains(r#"value="https://chasesets.com/?ref=wls_01&amp;utm_source=referral&amp;utm_medium=waitlist_share""#),
        "{page}"
    );
    // Copy is corten-ui's CopyButton on the link's field, counted when it reports a copy.
    assert!(page.contains(r#"<input class="#) && page.contains(r#"id="welcome-referral-link" type="url" readonly"#), "{page}");
    assert!(page.contains(r#"data-scope="ui-copy-button" type="button" hidden"#), "{page}");
    assert!(page.contains("&quot;welcome-referral-link&quot;"), "Copy names the field: {page}");
    assert!(page.contains("ui-copied:"), "the copy is counted: {page}");
    assert!(page.contains(r#"href="https://twitter.com/intent/tweet?text=Chase%20Sets%20founders"#), "{page}");
    // A seller is asked: the signup's games checked (an unknown one left out), Save without a script.
    assert!(page.contains(r#"<input type="checkbox" name="games" value="pokemon" checked>"#), "{page}");
    assert!(page.contains(r#"<input type="checkbox" name="games" value="yu-gi-oh">"#), "{page}");
    assert!(
        page.contains(r#"action="/welcome?signup=wls_01&amp;fresh=1&amp;role=sell&amp;variant=seller_first_v2&amp;game=pokemon&amp;game=zzz&amp;attributed=1" data-patch"#),
        "{page}"
    );
    assert!(page.contains(r#"data-attributed="1""#) && page.contains(r#"data-variant="seller_first_v2""#), "{page}");
    assert!(page.contains(r#"href="/founders""#), "{page}");

    // A buyer is not asked; nor is a bookmark without its role.
    let (_, _, page) = site.get("/welcome?signup=wls_01&role=buy", None).await;
    assert!(!page.contains(r#"name="games""#), "{page}");
    let (_, _, page) = site.get("/welcome?signup=wls_01", None).await;
    assert!(!page.contains(r#"name="games""#), "{page}");
    // The goal reached; a place not caught up says it is updating; a failed read is the same.
    let (_, _, page) = site.get("/welcome?signup=wls_goal", None).await;
    assert!(page.contains("Referral goal reached.") && page.contains(r#"max="3" value="3""#), "{page}");
    assert!(page.contains("Your place in line is updating."), "{page}");
    let (status, _, page) = site.get("/welcome?signup=wls_gone", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("Your place in line is updating.") && page.contains("0 of 3"), "{page}");
    // No signup, or one that is not a signup's id, is not found.
    for path in ["/welcome", "/welcome?signup=", "/welcome?signup=wls_A!", "/welcome?signup=abc"] {
        let (status, _, _) = site.get(path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn a_wave_answer_saves_one_field_with_a_script_and_every_answered_field_without_one() {
    let site = Site::new(true, "https://chasesets.com").await;
    let path = "/welcome?signup=wls_01&role=sell";
    // With a script: the field the form names, a cleared size sent as cleared, and the status in place.
    let req = Request::post(path)
        .header(header::HOST, "localhost:7797")
        .header(header::ORIGIN, "http://localhost:7797")
        .header("sec-fetch-site", "same-origin")
        .header("corten", "action")
        .header("x-forwarded-for", "203.0.113.9")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("field=inventory_size&games=pokemon&inventory_size=&store_url=https%3A%2F%2Fshop.example"))
        .unwrap();
    let mut req = req;
    req.extensions_mut().insert(corten::axum::extract::ConnectInfo("203.0.113.9:50000".parse::<std::net::SocketAddr>().unwrap()));
    let res = site.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains(">Saved</p>") && body.contains(r#"role="status""#), "{body}");
    let (sent, client) = COHORTS.lock().unwrap().pop().unwrap();
    assert_eq!(sent, json!({ "inventorySize": null }), "only the field that changed");
    assert_eq!(client.as_deref(), Some("203.0.113.9"), "the visitor's address, which the limiter keys on");

    // Without one: Save sends the answered fields, and the page says so.
    let (status, headers, _) = site
        .post(
            path,
            "field=all&games=pokemon&games=yu-gi-oh&inventory_size=100_to_500&store_url=",
            Some(("203.0.113.9", "203.0.113.9")),
        )
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/welcome?signup=wls_01&role=sell&saved=1");
    let (sent, _) = COHORTS.lock().unwrap().pop().unwrap();
    assert_eq!(
        sent,
        json!({ "games": ["pokemon", "yu-gi-oh"], "inventorySize": "100_to_500" }),
        "an empty store link is not cleared"
    );
    let (_, _, page) = site.get("/welcome?signup=wls_01&role=sell&saved=1", None).await;
    assert!(page.contains(">Saved</p>"), "{page}");

    // A save that fails says so; a signup that is not one is not found.
    let (status, headers, _) = site.post("/welcome?signup=wls_other&role=sell", "field=all&games=pokemon", None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().ends_with("&saved=0"));
    let (_, _, page) = site.get("/welcome?signup=wls_other&role=sell&saved=0", None).await;
    assert!(page.contains("That didn&#39;t save."), "{page}");
    let (status, _, _) = site.post("/welcome?signup=nope", "field=all", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_help_hub_lists_each_audiences_categories_and_any_cache_may_keep_it() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/help", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(cache(&headers).contains("s-maxage"), "{headers:?}");
    assert!(page.contains("<title>Help Center | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/help""#), "{page}");
    assert!(page.contains(r#"<meta property="og:url" content="https://chasesets.com/help""#), "{page}");
    assert!(page.contains(">How can we help?</h1>"), "{page}");
    assert!(page.contains(">For buyers</h2>") && page.contains(">For sellers</h2>"), "{page}");
    assert!(!page.contains(">For developers</h2>"), "no developer article yet: {page}");
    assert!(page.contains(r#"href="/help/selling""#) && page.contains("Browse Selling"), "{page}");
    // No value is cited on the hub, so the values are not read.
    assert!(site.calls.lock().unwrap().iter().all(|(path, _)| !path.ends_with("/policy-values")));
}

#[tokio::test]
async fn a_help_category_lists_its_articles_and_an_unknown_one_is_not_found() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, _, page) = site.get("/help/selling", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("<title>Selling | Chase Sets Help</title>"), "{page}");
    assert!(page.contains(r#"<li aria-current="page">Selling</li>"#), "{page}");
    assert!(page.contains(">Getting paid</h2>") && page.contains(r#"href="/help/selling/getting-paid""#), "{page}");
    assert!(!page.contains(">Order protection</h2>"), "a buying article: {page}");
    for path in ["/help/nope", "/help/developers", "/help/buying/getting-paid", "/help/selling/nope"] {
        let (status, _, _) = site.get(path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn an_article_cites_the_live_values_and_marks_one_it_cannot_show_so_only_the_browser_keeps_it() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/help/selling/getting-paid", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("<title>Getting paid | Chase Sets Help</title>"), "{page}");
    assert!(page.contains("a standard window of 3 days after delivery and an extended window of 14 days"), "{page}");
    // The threshold is missing from the answer: marked, and no shared cache keeps the page.
    assert!(
        page.contains(
            r#"data-policy-value-state="unavailable" data-policy-value-key="settlement.clearance.high-value-threshold""#
        ),
        "{page}"
    );
    assert!(page.contains("Temporarily unavailable"), "{page}");
    assert!(
        page.contains(
            r#"data-policy-values-state="degraded" data-policy-value-keys="settlement.clearance.high-value-threshold""#
        ),
        "{page}"
    );
    assert!(cache(&headers).starts_with("public") && !cache(&headers).contains("s-maxage"), "{headers:?}");
    // The trail, the contents beside the body, and the related articles.
    assert!(page.contains(r#"<li><a href="/help/selling">Selling</a></li>"#), "{page}");
    assert!(page.contains(">On this page</h2>") && page.contains(r##"href="#the-clearance-window""##), "{page}");
    assert!(page.contains(">Related articles</h2>"), "{page}");
    // Links to this app's pages stay here.
    assert!(page.contains(r#"href="/help/selling/shipping-requirements""#) && page.contains(r#"href="/sales-fees""#), "{page}");
    // No change is on the way for its values.
    assert!(!page.contains("Changing on"), "{page}");
}

#[tokio::test]
async fn the_fees_page_shows_the_schedule_and_its_coming_change_and_any_cache_may_keep_it() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/sales-fees", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(cache(&headers).contains("s-maxage"), "every value shown: {headers:?}");
    assert!(page.contains("<title>Marketplace sales, payout, and checkout fees | Chase Sets</title>"), "{page}");
    assert!(page.contains("the same standard schedule: 8% of the item price plus $0.30, capped at $50.00 per item."), "{page}");
    assert!(page.contains("Changing on November 15, 2026"), "{page}");
    assert!(!page.contains("data-policy-value-state"), "{page}");
    // Not under /help: no trail, and public-web shows no related articles here.
    assert!(!page.contains(r#"aria-current="page""#) && !page.contains(">Related articles</h2>"), "{page}");
    assert!(!page.contains(r#"property="og:url""#), "{page}");

    let (status, _, page) = site.get("/press", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("<title>Creator and press fact sheet | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<meta property="og:url" content="https://chasesets.com/press""#), "{page}");
    assert!(page.contains(r#"href="/founders""#), "{page}");
}

#[tokio::test]
async fn an_articles_account_links_go_to_marketplace_and_its_public_links_stay_here() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (_, _, page) = site.get("/help/selling/inventory-csv-import", None).await;
    assert!(page.contains(r#"href="https://marketplace.chasesets.com/account/inventory/imports""#), "{page}");
    assert!(page.contains(r#"href="https://marketplace.chasesets.com/account/listings""#), "{page}");
    assert!(page.contains(r#"href="/help/selling/seller-migration-tcgplayer-ebay""#), "{page}");
    let (_, _, page) = site.get("/help/selling/prohibited-and-restricted-items", None).await;
    assert!(page.contains(r#"href="/contact""#), "{page}");
}

#[tokio::test]
async fn public_webs_old_help_addresses_move_for_good() {
    let site = Site::new(true, "https://chasesets.com").await;
    for (from, to) in [
        ("/faq", "/help/getting-started/frequently-asked-questions"),
        ("/order-protection", "/help/buying/order-protection"),
        ("/refunds-and-returns", "/help/buying/refunds-and-returns"),
        ("/buyer-protection", "/order-protection"),
        ("/seller-fees", "/sales-fees"),
    ] {
        let (status, headers, _) = site.get(from, None).await;
        assert_eq!(status, StatusCode::MOVED_PERMANENTLY, "{from}");
        assert_eq!(headers[header::LOCATION], to, "{from}");
    }
    // The footer's help links are this app's.
    let (_, _, home) = site.get("/", None).await;
    // The help center's stylesheet is linked from its three addresses only.
    let sheet = |page: &str| page.split('"').find(|part| part.contains("sections/") && part.ends_with(".css")).map(str::to_owned);
    assert_eq!(sheet(&home), None, "{home}");
    let (_, _, hub) = site.get("/help", None).await;
    let shared = sheet(&hub).expect("the hub links the help sheet");
    for path in ["/sales-fees", "/press", "/help/selling/getting-paid"] {
        let (_, _, page) = site.get(path, None).await;
        assert_eq!(sheet(&page).as_deref(), Some(shared.as_str()), "{path}");
    }
    for href in ["/help", "/sales-fees", "/press", "/order-protection", "/refunds-and-returns"] {
        assert!(home.contains(&format!(r#"href="{href}""#)), "{href}: {home}");
    }
}

#[tokio::test]
async fn a_compare_page_sets_the_live_schedule_beside_the_competitors_and_works_out_a_sale() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/compare/tcgplayer", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(cache(&headers).contains("s-maxage"), "{headers:?}");
    assert!(page.contains("<title>TCGplayer Seller Fees vs Chase Sets | 2026 Comparison</title>"), "{page}");
    assert!(page.contains(r#"<meta property="og:url" content="https://chasesets.com/compare/tcgplayer""#), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/compare/tcgplayer""#), "{page}");
    assert!(
        page.contains(r#""@type":"FAQPage""#) && page.contains("How much does TCGplayer charge to sell trading cards?"),
        "{page}"
    );
    assert!(page.contains(">Chase Sets vs TCGplayer for selling trading cards</h1>"), "{page}");
    // The table: the live schedule, and TCGplayer's dated facts.
    assert!(page.contains("8% of the item price plus $0.30, never more than $50.00 per item"), "{page}");
    assert!(page.contains("10.75% marketplace commission, capped at $75.00 per item, for standard marketplace sellers, per TCGplayer&#39;s published fee schedule as of July 12, 2026."), "{page}");
    assert!(page.contains("Sellers pay 2.5% + $0.30 payment processing per order"), "{page}");
    assert!(page.contains(">Where TCGplayer is ahead today</h2>"), "{page}");
    // The calculator at $50.00 and one card: $4.30 here, TCGplayer $5.37 and $1.55, eBay $6.62 and $0.40.
    assert!(page.contains(r#"id="fee-calculator""#) && page.contains(r#"value="50.00""#), "{page}");
    for kept in ["$45.70", "$43.08", "$42.98", "$4.30", "$5.37", "$1.55", "$6.62", "$0.40"] {
        assert!(page.contains(kept), "{kept}: {page}");
    }
    assert!(!page.contains("fee-calculator-cap-note"), "under the cap: {page}");
    assert!(
        page.contains(r#"data-value="https://chasesets.com/compare/tcgplayer?price=50.00&amp;cards=1&amp;utm_source=fee-calculator&amp;utm_medium=share&amp;utm_campaign=what-you-keep#fee-calculator""#),
        "{page}"
    );
    assert!(page.contains(r#"action="/compare/tcgplayer#fee-calculator" data-patch"#), "{page}");
    assert!(page.contains(r#"href="/compare/ebay""#) && page.contains("Compare Chase Sets vs eBay"), "{page}");
    assert!(page.contains(r#"href="/sales-fees""#), "{page}");
    // eBay's page, and a competitor that is not one.
    let (status, _, page) = site.get("/compare/ebay", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        page.contains("13.25% trading-cards final value fee on the portion of a sale up to $7,500.00, plus 2.35% above it."),
        "{page}"
    );
    let (status, _, _) = site.get("/compare/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_share_link_opens_its_comparison_and_the_calculator_answers_a_script_with_its_section() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/compare/ebay?price=1000&cards=2&utm_source=fee-calculator", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!cache(&headers).contains("s-maxage"), "one comparison is kept by the browser only: {headers:?}");
    assert!(page.contains(r#"value="1000""#) && page.contains(r#"value="2""#), "{page}");
    assert!(page.contains("2 cards at $1,000.00 each — $2,000.00 total."), "{page}");
    // 8% of $1,000 + $0.30 is $80.30, over the $50 cap.
    assert!(
        page.contains(
            "The per-item cap kicked in: 8% would be $80.30 per card, but Chase Sets never charges more than $50.00 per item."
        ),
        "{page}"
    );
    // A field that is not a price says so, with no results.
    let (_, _, page) = site.get("/compare/ebay?price=abc&cards=1", None).await;
    assert!(page.contains(r#"aria-invalid="true""#) && page.contains("Enter a price from $0.01 to $9,999.99."), "{page}");
    assert!(!page.contains("You keep"), "{page}");
    // With a script: the section alone.
    let req = Request::get("/compare/tcgplayer?price=10.01&cards=1")
        .header(header::HOST, "localhost:7797")
        .header("corten", "action")
        .body(Body::empty())
        .unwrap();
    let res = site.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.starts_with(r#"<section class=""#) && body.contains(r#"id="fee-calculator""#), "{body}");
    assert!(!body.contains("<html") && !body.contains("<h1"), "{body}");
    // $10.01: here $0.81 + $0.30 rounded up; TCGplayer $1.07 and $0.55 rounded down.
    assert!(body.contains("$1.11") && body.contains("$1.07") && body.contains("$0.55"), "{body}");
    // The schedule was read once for all three pages.
    let reads = site.calls.lock().unwrap().iter().filter(|(path, _)| path.ends_with("/policy-values")).count();
    assert_eq!(reads, 1);
}

#[tokio::test]
async fn contact_says_where_to_write_and_the_shell_links_here() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, page) = site.get("/contact", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(cache(&headers).contains("s-maxage"), "{headers:?}");
    assert!(page.contains("<title>Contact | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<link rel="canonical" href="https://chasesets.com/contact""#), "{page}");
    assert!(page.contains(">Contact Chase Sets</h1>") && page.contains("Email support@chasesets.com"), "{page}");
    assert!(page.contains(">Current status</h2>"), "{page}");
    // The home page links here and to the compare page and the FAQ article, not to public-web.
    let (_, _, home) = site.get("/", None).await;
    for href in ["/contact", "/compare/tcgplayer", "/help/getting-started/frequently-asked-questions"] {
        assert!(home.contains(&format!(r#"href="{href}""#)), "{href}: {home}");
    }
    assert!(!home.contains("localhost:7754/compare"), "{home}");
    // The promo bar's link to the moved order-protection address is this app's too.
    assert!(home.contains(r#"href="/order-protection">Order protection"#), "{home}");
    let (_, _, sitemap) = site.get("/sitemap.xml", None).await;
    for loc in ["/contact", "/compare/tcgplayer", "/compare/ebay"] {
        assert!(sitemap.contains(&format!("<loc>https://chasesets.com{loc}</loc>")), "{loc}: {sitemap}");
    }
}

#[tokio::test]
async fn the_developer_portal_is_not_found_until_it_is_ready() {
    let site = Site::new(true, "https://chasesets.com").await;
    for path in ["/developers", "/developers/developer-quickstart", "/developers/manifest.json", "/llms.txt"] {
        let (status, _, _) = site.get(path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn the_open_developer_portal_lists_its_guides_out_of_search() {
    let site = Site::with(true, "https://chasesets.com", true).await;
    let (status, headers, page) = site.get("/developers", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(cache(&headers), "public, max-age=60, s-maxage=300, stale-while-revalidate=60");
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
    assert!(page.contains("<title>Developer Portal | Chase Sets</title>"), "{page}");
    assert!(page.contains(r#"<meta name="robots" content="noindex,nofollow""#), "{page}");
    assert!(page.contains(">Build with Chase Sets</h1>"), "{page}");
    assert!(page.contains(r#"href="/developers/developer-quickstart""#) && page.contains("Read guide"), "{page}");
    assert!(page.contains(r#"href="/agent-terms""#) && page.contains(r#"href="/developers/manifest.json""#), "{page}");
    assert!(page.contains(r#"href="/llms.txt""#), "{page}");

    // A guide, with its trail and contents; one that is not one is not found.
    let (status, headers, page) = site.get("/developers/developer-quickstart", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
    assert!(page.contains("<title>Developer quickstart | Chase Sets Developers</title>"), "{page}");
    assert!(page.contains(r#"<li><a href="/developers">Developers</a></li>"#), "{page}");
    assert!(page.contains(">On this page</h2>"), "{page}");
    assert!(!page.contains("Generated MCP tool descriptors"), "{page}");
    let (status, _, _) = site.get("/developers/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The tool catalog's guide lists every tool, available first.
    let (_, _, page) = site.get("/developers/mcp-tool-catalog", None).await;
    assert!(page.contains(">Generated MCP tool descriptors</h2>"), "{page}");
    assert!(page.contains("<code>checkout.add-cart-line</code>") && page.contains("<code>auth.resolve-actor</code>"), "{page}");
    assert!(page.find(">Available tools</h3>") < page.find(">Planned tools</h3>"), "{page}");
    assert!(page.contains("Input schema"), "{page}");
}

#[tokio::test]
async fn the_developer_manifest_and_llms_txt_describe_the_portal_for_agents() {
    let site = Site::with(true, "https://chasesets.com", true).await;
    let (status, headers, body) = site.get("/developers/manifest.json", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
    let manifest: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(manifest["schemaVersion"], 1);
    assert_eq!(manifest["indexing"], "disabled");
    assert_eq!(manifest["portalUrl"], "https://chasesets.com/developers");
    assert_eq!(
        manifest["policies"],
        json!([{ "policyKey": "agent-connector-terms", "title": "Agent Connector Terms", "url": "https://chasesets.com/agent-terms" }])
    );
    assert_eq!(manifest["articles"][1]["url"], "https://chasesets.com/developers/developer-quickstart");
    assert_eq!(manifest["mcp"]["endpoint"], "https://chasesets.com/mcp");
    assert!(manifest["mcp"]["tools"].as_array().unwrap().len() > 60);
    assert_eq!(manifest["mcp"]["tools"][0]["availability"], "available");

    let (status, headers, text) = site.get("/llms.txt", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
    assert!(text.starts_with("# Chase Sets Developer Portal\n\n> Gated, non-indexed documentation"), "{text}");
    assert!(text.contains("- [Agent Connector Terms](https://chasesets.com/agent-terms)\n- [Machine-readable developer manifest](https://chasesets.com/developers/manifest.json)"), "{text}");
    assert!(text.contains("Supported protocol versions: 2025-06-18, 2025-11-25, 2026-07-28"), "{text}");
}

/// The manifest is about 160 KB: a `Public<Json<..>>` with its robots header, which Corten
/// compresses (todd-skelton/corten#287; before it, the pilot's own answer type).
#[tokio::test]
async fn the_developer_manifest_is_compressed_with_its_robots_header() {
    let site = Site::with(true, "https://chasesets.com", true).await;
    let req = Request::get("/developers/manifest.json").header(header::ACCEPT_ENCODING, "br").body(Body::empty()).unwrap();
    let res = site.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_ENCODING], "br");
    assert_eq!(res.headers()["x-robots-tag"], "noindex, nofollow");
    let sent = res.into_body().collect().await.unwrap().to_bytes().len();
    assert!(sent < 40_000, "{sent} bytes");
}

/// public-web's own files (`app/routes.ts`): the manifest, the favicon at both addresses and
/// Chrome's probe, each with public-web's caching, and every page links the first two.
#[tokio::test]
async fn the_site_files_are_public_webs_manifest_favicon_and_devtools_probe() {
    let site = Site::new(true, "https://chasesets.com").await;
    let (status, headers, body) = site.get("/manifest.webmanifest", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/manifest+json; charset=utf-8");
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=3600");
    let manifest: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(manifest["name"], "Chase Sets");
    assert_eq!(manifest["start_url"], "/");
    assert_eq!(manifest["display"], "standalone");
    assert_eq!(manifest["theme_color"], "#4845c6");
    assert_eq!(manifest["background_color"], "#f7f5f1");
    assert_eq!(manifest["icons"], json!([]));
    assert!(manifest["description"].as_str().unwrap().starts_with("Request early access"), "{manifest}");

    for path in ["/favicon.svg", "/favicon.ico"] {
        let (status, headers, body) = site.get(path, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers[header::CONTENT_TYPE], "image/svg+xml; charset=utf-8", "{path}");
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=86400", "{path}");
        assert_eq!(headers["x-content-type-options"], "nosniff", "{path}");
        assert!(body.starts_with("<?xml") && body.contains("<svg"), "{path}: {body}");
    }

    let (status, headers, body) = site.get("/.well-known/appspecific/com.chrome.devtools.json", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(body.is_empty());

    // public-web's health routes are Corten's here.
    for path in ["/health/live", "/health/ready"] {
        let (status, _, body) = site.get(path, None).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
    }

    for path in ["/", "/terms"] {
        let (_, _, page) = site.get(path, None).await;
        assert!(page.contains(r#"<link rel="manifest" href="/manifest.webmanifest">"#), "{path}: {page}");
        assert!(page.contains(r#"<link rel="icon" href="/favicon.svg" type="image/svg+xml">"#), "{path}: {page}");
        assert!(page.contains(r#"<link rel="alternate icon" href="/favicon.ico" sizes="any">"#), "{path}: {page}");
    }
}
