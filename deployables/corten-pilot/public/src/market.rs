//! The market page and the crawler files. Each is the same for everyone (`Public`): the handler
//! reads no session, cookie or header, and calls the API with none.
//!
//! The page is `public, max-age=60, s-maxage={ttl}, stale-while-revalidate=3600`: a browser keeps
//! it a minute, a shared cache (a CDN) for the `s-maxage` Pricing's own answer carries (its display
//! policy's `publicPageCacheTtlSeconds`, a day by default), and either may serve it stale for up to
//! an hour while it fetches a new one. public-web writes the default day as a literal, so a revised
//! policy reaches its JSON API but not its page; here it reaches both.
use std::time::Duration;

use corten::{axum::http::StatusCode, prelude::*, seo};
use serde_json::{Value, json};

use crate::{
    api::{MarketPage, Pricing},
    app::{Shared, url},
    text::{MarketMsg, Pilot},
    views::{self, Layout, Screen},
};

/// How long the browser keeps a market page.
const FRESH: Duration = Duration::from_secs(60);
/// How long a shared cache keeps one when Pricing's answer sets no `s-maxage` (a not-found page,
/// a read that failed): the display policy's default, as public-web writes it.
const SHARED: Duration = Duration::from_secs(86_400);
/// How long after that a shared cache may serve it while it fetches a new one.
const STALE: Duration = Duration::from_secs(3600);
/// The host Chase Sets' production public site answers on: only its pages get structured data.
const PRODUCTION_HOST: &str = "chasesets.com";

/// An item's market page. Pricing's 404 is the not-found page; a failed read is a 502, which no
/// cache keeps.
pub(crate) async fn page(
    req: Req,
    State(config): State<Shared>,
    Params(route): Params<crate::app::url::market::MarketPage<'_>>,
) -> Public<HtmlResult> {
    let slug = route.slug;
    let (page, shared) = match read(&config, slug.trim()).await {
        Ok(page) => {
            let shared = page.shared.unwrap_or(SHARED);
            (render(req, &config, page), shared)
        }
        Err(error) => (Err(error), SHARED),
    };
    Public::new(FRESH, page).shared(shared).stale_while_revalidate(STALE)
}

/// Pricing's page for `slug`: not found when it has none, 502 when the read failed.
async fn read(config: &Shared, slug: &str) -> Result<MarketPage, corten::Error> {
    if slug.is_empty() {
        return Err(corten::Error::status(StatusCode::NOT_FOUND));
    }
    match config.api().market_page(slug).await {
        Ok(Some(page)) => Ok(page),
        Ok(None) => Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// The page, made for everyone (the handler's `Public`).
fn render(req: Req, config: &Shared, page: MarketPage) -> corten::Result<corten::HtmlResponse<corten::ForAll>> {
    let t: MarketMsg = req.t();
    let p: Pilot = req.t();
    let canonical = format!("{}{}", config.origin, url::MarketPage { slug: &page.slug }.href());
    let item = format!("{}/items/{}", config.marketplace, crate::api::segment(&page.slug));
    let title = t.route_meta_title(&page.title).to_string();
    let description = t.route_meta_description(&page.title).to_string();
    let product = config.indexing.then(|| product_json_ld(&page, &canonical, &item)).flatten();
    // A view renders once and moves what it captures: the head borrows these.
    let (og_title, description, canonical) = (title.as_str(), description.as_str(), canonical.as_str());
    let head = html! {
        <meta name="description" content={description}>
        <meta property="og:site_name" content={p.shell_site()}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={description}>
        <meta property="og:type" content="website">
        <meta name="twitter:card" content="summary">
        <meta property="og:url" content={canonical}>
        <link rel="canonical" href={canonical}>
        if !config.indexing {
            <meta name="robots" content="noindex,nofollow">
        }
        if let Some(ld) = &product {
            <JsonLd value={ld} />
        }
    };
    let screen = Screen { page, home: "/".to_owned(), item };
    req.page(html! {
        <Layout req={&req} title={&title} head={head}>
            <views::MarketPage t={t} p={p} screen={&screen} />
        </Layout>
    })
}

/// The item as a schema.org Product with its lowest ask (`buildMarketPageProductJsonLd`): only on
/// the production site, and only while it has a priced listing.
fn product_json_ld(page: &MarketPage, canonical: &str, item: &str) -> Option<Value> {
    let production = canonical.strip_prefix("https://").and_then(|rest| rest.split('/').next()) == Some(PRODUCTION_HOST);
    let state = page.market_state.as_ref()?;
    let low = state.min_ask_amount.as_deref().filter(|a| !a.is_empty())?;
    if !production || state.active_listing_count == 0 {
        return None;
    }
    let mut product = json!({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": page.title,
        "offers": {
            "@type": "AggregateOffer",
            "url": item,
            "priceCurrency": "USD",
            "lowPrice": low,
            "offerCount": state.active_listing_count,
            "availability": "https://schema.org/InStock",
        },
    });
    if let Some(subtitle) = page.subtitle.as_deref().filter(|s| !s.is_empty()) {
        product["description"] = json!(subtitle);
    }
    Some(product)
}

/// `robots.txt` (`buildRobotsTxt`): everything, and the sitemap, when the site may be indexed;
/// nothing otherwise.
pub(crate) async fn robots(State(config): State<Shared>) -> Public<seo::File> {
    if config.indexing {
        let sitemap = format!("{}{}", config.origin, url::Sitemap.href());
        seo::robots(&[], Some(&sitemap))
    } else {
        seo::robots(&["/"], None)
    }
}

/// The sitemap of the pages this app serves, when the site may be indexed, and none otherwise:
/// the ones public-web lists among its stable pages (the home page, the terms, the privacy notice
/// and the founders' terms; its other policy documents stay out of search while counsel reviews
/// them), Contact, the compare pages, the help center, then the market pages Pricing says are worth indexing, each with when it last traded. A failed read
/// is a 502, which no cache keeps, rather than a sitemap without them.
pub(crate) async fn sitemap(State(config): State<Shared>) -> Result<Public<seo::File>, corten::Error> {
    if !config.indexing {
        return Ok(seo::sitemap([]));
    }
    let indexed = config.api().indexed().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    let stable = [
        url::files::Home.href(),
        url::contact::Contact.href(),
        url::files::Terms.href(),
        url::files::Privacy.href(),
        url::Founders.href(),
        crate::compare::Competitor::Tcgplayer.path(),
        crate::compare::Competitor::Ebay.path(),
    ];
    let urls: Vec<(String, Option<&str>)> = stable
        .into_iter()
        .chain(crate::help::indexed())
        .map(|path| (format!("{}{path}", config.origin), None))
        .chain(indexed.iter().map(|entry| {
            (format!("{}{}", config.origin, url::MarketPage { slug: &entry.slug }.href()), entry.updated_at.as_deref())
        }))
        .collect();
    Ok(seo::sitemap(urls.iter().map(|(loc, lastmod)| seo::SitemapUrl { loc, lastmod: *lastmod })))
}

#[cfg(test)]
mod tests {
    use super::product_json_ld;
    use crate::api::{MarketPage, MarketState};

    fn page(low: Option<&str>, count: u64) -> MarketPage {
        MarketPage {
            title: "Charizard".into(),
            subtitle: Some("Base Set 4/102".into()),
            slug: "charizard".into(),
            series: vec![],
            aggregates: vec![],
            market_state: Some(MarketState { active_listing_count: count, min_ask_amount: low.map(Into::into) }),
            live_asks: vec![],
            unpriced_buyable_listing_count: 0,
            shared: None,
        }
    }

    #[test]
    fn structured_data_is_only_for_the_production_site_and_a_priced_listing() {
        let live = "https://chasesets.com/market/charizard";
        let ld = product_json_ld(&page(Some("43.25"), 3), live, "https://marketplace.chasesets.com/items/charizard").unwrap();
        assert_eq!(ld["offers"]["lowPrice"], "43.25");
        assert_eq!(ld["offers"]["offerCount"], 3);
        assert_eq!(ld["description"], "Base Set 4/102");
        assert!(product_json_ld(&page(Some("43.25"), 3), "http://localhost:7797/market/charizard", "x").is_none());
        assert!(product_json_ld(&page(Some("43.25"), 3), "https://chasesets.com.evil/market/charizard", "x").is_none());
        assert!(product_json_ld(&page(None, 3), live, "x").is_none());
        assert!(product_json_ld(&page(Some("43.25"), 0), live, "x").is_none());
    }
}
