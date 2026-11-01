//! The item page's parts, after marketplace's: the layout (`MarketplaceProductDetailLayout`), the
//! summary and the picture, the product selector (`ProductSelector`), the market summary
//! (`MarketplaceMarketSummary`), the rail with the listing or offer chosen, and the market book
//! (`ItemDetailMarketBook`). Every choice is a link to the same page with the choice in its
//! address (`items::Address`); a dimension with more than five options is a GET form.
use corten::prelude::*;
use platform::chart::{self, Chart, TimeSeries};
use serde_json::{Value, json};

use super::on_marketplace;
use crate::{
    api::{FieldValue, Item, Listing, MarketAggregate, MarketState, Offer, Reference, RollupPoint, SimilarItem},
    app::url,
    buying::{BuyFields, BuyNotice, Intent as BuyIntent, RailForm, field},
    items::{
        Address, Book, History, ItemScreen, ListingSetup, Market, OptionMarket, Picks, Range, active_dimensions, available,
        normalize, option_label, ordered_options,
    },
    listing::{self, ListFields},
    saving::{self, SaveInput, SaveState},
    selling::{self, SellForm, SellIntent},
    text::{ItemMsg, Pilot},
    watching::{self, Side},
};

// The item page's and search's analytics (marketplace-web's `trackItemDetailRailEvent`).
corten::script::script!(pub mod analytics = "rail_analytics.js");

/// A rail form with one set of analytics labels, whichever button sends it.
const ONE_WAY: [&str; 0] = [];

/// The product selector, where Select options and the rail's choose-options link go.
#[derive(Id)]
pub struct SelectOptionsId;

/// The host Chase Sets' production marketplace answers on: only its pages get structured data
/// (`isProductionMarketplaceUrl`).
const PRODUCTION_HOST: &str = "marketplace.chasesets.com";

/// An amount in the request's locale (`formatMoney`): "Unavailable" without an amount or a
/// currency, `<amount> <CODE>` when it is not money.
pub fn money(t: ItemMsg, amount: Option<&str>, currency: Option<&str>) -> String {
    let (Some(amount), Some(currency)) = (amount.filter(|a| !a.is_empty()), currency) else {
        return t.page_unavailable().to_owned();
    };
    match (platform::money::decimal(amount), corten::i18n::Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

fn listing_price(t: ItemMsg, l: &Listing) -> String {
    money(t, Some(&l.price_amount), l.price_currency_code.as_deref())
}

fn offer_price(t: ItemMsg, o: &Offer) -> String {
    money(t, Some(&o.price_amount), o.price_currency_code.as_deref())
}

/// The item's picture.
pub struct Image {
    pub src: String,
    pub srcset: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// One of the gallery's pictures: the picture, its thumbnail and its words.
pub struct Shot {
    pub image: Image,
    pub thumb: String,
    pub alt: String,
}

/// The gallery's pictures (`buildItemDetailImages`, then `ImageGallery`'s): the catalog-detail
/// rendition, else every image URL, then the fallback when it stays (`permanent`), which
/// marketplace shows as one more picture.
pub fn item_shots(t: ItemMsg, item: &Item) -> Vec<Shot> {
    let mut shots = Vec::new();
    let detail = item_image(item)
        .filter(|_| item.product_asset_sets.iter().any(|s| s.variants.iter().any(|v| v.role == "catalog-detail")));
    if let Some(image) = detail {
        let thumb = item
            .product_asset_sets
            .iter()
            .flat_map(|s| &s.variants)
            .filter(|v| v.role == "thumbnail")
            .min_by_key(|v| (v.density != 1, v.width))
            .map_or_else(|| image.src.clone(), |v| on_marketplace(&v.public_url));
        shots.push(Shot { image, thumb, alt: t.page_image_alt(&item.title, 1).to_string() });
    } else {
        for (i, url) in item.image_urls.iter().enumerate() {
            let src = on_marketplace(url);
            let image = Image { src: src.clone(), srcset: None, width: None, height: None };
            shots.push(Shot { image, thumb: src, alt: t.page_image_alt(&item.title, i + 1).to_string() });
        }
    }
    if let Some(fallback) = item.image_fallback.as_ref().filter(|f| f.usage == "permanent") {
        let src = on_marketplace(&fallback.url);
        let thumb =
            fallback.variants.get("thumbnail").and_then(|v| v.one_x.as_deref()).map_or_else(|| src.clone(), on_marketplace);
        let image = Image { src, srcset: None, width: None, height: None };
        shots.push(Shot { image, thumb, alt: fallback.alt.clone() });
    }
    shots
}

/// The item's main picture (`selectItemImage`): its catalog-detail rendition, else its first
/// image, else the fallback when it stays (`permanent`).
pub fn item_image(item: &Item) -> Option<Image> {
    for set in &item.product_asset_sets {
        let mut variants: Vec<_> = set.variants.iter().filter(|v| v.role == "catalog-detail").collect();
        variants.sort_by_key(|v| v.width);
        if let Some(one) = variants.iter().find(|v| v.density == 1).or(variants.first()) {
            let srcset = variants.iter().map(|v| format!("{} {}w", on_marketplace(&v.public_url), v.width)).collect::<Vec<_>>();
            return Some(Image {
                src: on_marketplace(&one.public_url),
                srcset: Some(srcset.join(", ")),
                width: Some(one.width),
                height: Some(one.height),
            });
        }
    }
    if let Some(url) = item.image_urls.first() {
        return Some(Image { src: on_marketplace(url), srcset: None, width: None, height: None });
    }
    item.image_fallback.as_ref().filter(|f| f.usage == "permanent").map(|f| Image {
        src: on_marketplace(&f.url),
        srcset: None,
        width: None,
        height: None,
    })
}

fn production(canonical: &str) -> bool {
    canonical.strip_prefix("https://").and_then(|rest| rest.split('/').next()) == Some(PRODUCTION_HOST)
}

/// The item as a schema.org Product (`buildItemDetailProductJsonLd`): only an active item with a
/// description, a picture and a price, on the production marketplace.
pub fn product_json_ld(item: &Item, canonical: &str) -> Option<Value> {
    let description = item.description.as_deref().map(str::trim).filter(|d| !d.is_empty())?;
    let image = item_image(item)?;
    let summary = item.market_summary.as_ref()?;
    let lowest = summary.lowest_price_amount.as_deref()?;
    if item.status != "active" || !production(canonical) || summary.active_listing_count == 0 {
        return None;
    }
    let mut product = json!({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": item.title,
        "description": description,
        "image": image.src,
        "sku": item.catalog_item_id,
        "offers": {
            "@type": "AggregateOffer",
            "url": canonical,
            "priceCurrency": "USD",
            "lowPrice": lowest,
            "offerCount": summary.active_listing_count,
            "availability": if summary.total_visible_quantity > 0 { "https://schema.org/InStock" } else { "https://schema.org/OutOfStock" },
        },
    });
    if let Some(category) = item.categories.first() {
        product["category"] = json!(category.name);
    }
    Some(product)
}

/// Home, the item's first category and the item, as a schema.org BreadcrumbList, on the
/// production marketplace (`buildItemDetailBreadcrumbListJsonLd`).
pub fn breadcrumb_json_ld(t: ItemMsg, item: &Item, canonical: &str) -> Option<Value> {
    if !production(canonical) {
        return None;
    }
    let origin = format!("https://{PRODUCTION_HOST}");
    let mut trail = vec![(t.page_home().to_owned(), format!("{origin}/"))];
    if let Some(category) = item.categories.first() {
        trail.push((category.name.clone(), format!("{origin}/categories/{}", category.slug)));
    }
    trail.push((item.title.clone(), canonical.to_owned()));
    let items: Vec<Value> = trail
        .iter()
        .enumerate()
        .map(|(i, (name, url))| json!({ "@type": "ListItem", "position": i + 1, "name": name, "item": url }))
        .collect();
    Some(json!({ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items }))
}

/// A listing's or offer's product in a few words (`formatCompactProductSummary`).
fn compact(summary: Option<&str>, described: &[(&str, &str)], fallback: &str) -> String {
    let values: Vec<&str> = described.iter().map(|(_, v)| v.trim()).filter(|v| !v.is_empty()).collect();
    let source = if values.is_empty() {
        summary.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback).to_owned()
    } else {
        values.join(" \u{b7} ")
    };
    source.split(['/', '|', '\u{b7}']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")
}

/// The purchase limit a listing shows (`formatListingPurchaseLimit`; marketplace's own English).
pub fn purchase_limit(l: &Listing) -> Option<String> {
    if let Some(n) = l.max_units_per_customer_account.filter(|n| *n > 0) {
        return Some(format!("Limit {n} per customer"));
    }
    if let Some(n) = l.max_units_per_day.filter(|n| *n > 0) {
        return Some(format!("Limit {n} per day"));
    }
    l.max_units_per_order.filter(|n| *n > 0).map(|n| format!("Limit {n} per order"))
}

/// A language code's name (`formatLanguageCodeLabel`).
fn language(t: ItemMsg, code: &str) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => t.language_en().to_owned(),
        "ja" => t.language_ja().to_owned(),
        _ => code.trim().to_owned(),
    }
}

/// A field's value as text (`formatFieldValue`): text, a number, localized text in English.
fn field_text(value: &Value) -> String {
    match value {
        Value::Null => "-".into(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Object(map) => match map.get("values").and_then(Value::as_object) {
            Some(values) => values.get("en").or(values.values().next()).and_then(Value::as_str).unwrap_or("-").to_owned(),
            None => value.to_string(),
        },
        Value::Array(_) => value.to_string(),
    }
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A reference type's name (`formatReferenceTypeLabel`): `trading_card_set` is Trading Card Set.
fn type_label(key: &str) -> String {
    key.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| if p == "tcg" { "TCG".to_owned() } else { capitalize(p) })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The details list's rows (`buildReferenceDetailRows`): each field, then each record its
/// references relate to (an expansion's series), four deep at most, each record once.
/// A details row: its label, its value, and the reference record it names, if any.
type DetailRow<'a> = (String, String, Option<&'a Reference>);

fn detail_rows(fields: &[FieldValue]) -> Vec<DetailRow<'_>> {
    let mut rows: Vec<DetailRow<'_>> = fields
        .iter()
        .map(|f| {
            let label = if f.field_name.starts_with("fld_") || f.field_name.starts_with("fld-") {
                f.field_name
                    .trim_start_matches("fld_")
                    .trim_start_matches("seed_")
                    .split(['-', '_'])
                    .filter(|p| !p.is_empty())
                    .map(capitalize)
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                f.field_name.clone()
            };
            let value = f.reference.as_ref().map_or_else(|| field_text(&f.value), |r| r.name.clone());
            (label, value, f.reference.as_ref())
        })
        .collect();
    let direct: std::collections::BTreeSet<&str> =
        fields.iter().filter_map(|f| f.reference.as_ref()).map(|r| r.reference_id.as_str()).collect();
    let mut inherited = std::collections::BTreeSet::new();
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    fn walk<'a>(
        reference: &'a Reference,
        path: &mut Vec<&'a str>,
        direct: &std::collections::BTreeSet<&str>,
        inherited: &mut std::collections::BTreeSet<&'a str>,
        counts: &mut std::collections::BTreeMap<String, usize>,
        rows: &mut Vec<DetailRow<'a>>,
    ) {
        if path.len() > 4 {
            return;
        }
        for relationship in &reference.relationships {
            let Some(related) = &relationship.reference else { continue };
            if path.contains(&related.reference_id.as_str()) {
                continue;
            }
            if !direct.contains(related.reference_id.as_str()) && inherited.insert(related.reference_id.as_str()) {
                let base = type_label(&related.type_key);
                let count = counts.entry(base.clone()).or_default();
                let label = if *count == 0 { base } else { format!("{base} ({})", type_label(&relationship.relationship_type)) };
                *count += 1;
                rows.push((label, related.name.clone(), Some(related)));
            }
            path.push(&related.reference_id);
            walk(related, path, direct, inherited, counts, rows);
            path.pop();
        }
    }
    for f in fields {
        if let Some(reference) = &f.reference {
            let mut path = vec![reference.reference_id.as_str()];
            walk(reference, &mut path, &direct, &mut inherited, &mut counts, &mut rows);
        }
    }
    rows
}

/// The page.
pub fn item_page<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    address: &'a Address,
    slug: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render + 'a {
    html! { <ItemDetail t={t} screen={screen} address={address} slug={slug} notice={notice} /> }
}

/// The page: breadcrumbs; the summary, the picture, the options and the market; the rail with
/// the listing or offer chosen; and the market book. Stacked on a phone; the picture beside the
/// rest from 48rem.
#[component(css)]
pub fn ItemDetail<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    address: &'a Address,
    slug: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render {
    let item = &screen.item;
    let category = item.categories.first();
    let image = item_image(item);
    let shots = item_shots(t, item);
    let fallback_alt = item.image_fallback.as_ref().map_or(t.page_default_product_image(), |f| f.alt.as_str());
    let alt = if item.image_fallback.is_some() && item.product_asset_sets.is_empty() && item.image_urls.is_empty() {
        fallback_alt.to_owned()
    } else {
        t.page_image_alt(&item.title, 1).to_string()
    };
    html! {
        <nav class={Crumbs} aria-label="Breadcrumb">
            <ol>
                <li><a href={&on_marketplace("/")}>{t.page_home()}</a></li>
                match category {
                    Some(c) => { <li><a href={&on_marketplace(&format!("/categories/{}", c.slug))}>{&c.name}</a></li> }
                    None => { <li><a href={&on_marketplace("/search")}>{t.page_search()}</a></li> }
                }
                <li aria-current="page">{&item.title}</li>
            </ol>
        </nav>
        <div class={Detail}>
            <div class={Summary}>
                if let Some(blueprint) = &item.blueprint {
                    <p class={Eyebrow}>{&blueprint.name}</p>
                }
                <h1 class={Title}>{&item.title}</h1>
                if let Some(subtitle) = &item.subtitle {
                    <p class={Subtitle}>{subtitle}</p>
                }
            </div>
            <div class={Media}>
                if shots.len() > 1 {
                    <Gallery shots={&shots} />
                } else {
                    match &image {
                        Some(image) => {
                            <img
                                src={&image.src}
                                srcset={image.srcset.as_deref()}
                                sizes={image.srcset.as_ref().map(|_| "(min-width: 768px) 308px, min(100vw, 276px)")}
                                width={image.width}
                                height={image.height}
                                fetchpriority="high"
                                alt={&alt}
                            >
                        }
                        None => {
                            <div class={NoImage}>
                                <p class={Strong}>{t.page_image_coming_soon()}</p>
                                <p class={Muted}>{t.page_catalog_imagery_has_not_been_added()}</p>
                            </div>
                        }
                    }
                }
            </div>
            <div class={MarketCol}>
                if screen.stale_listing {
                    <Stale
                        title={t.page_selected_listing_unavailable()}
                        text={t.page_selected_listing_unavailable_description()}
                    />
                } else if screen.stale_offer {
                    <Stale title={t.page_selected_offer_unavailable()} text={t.page_selected_offer_unavailable_description()} />
                }
                if screen.product_id.is_some() {
                    <SaveToList t={t} screen={screen} address={address} slug={slug} notice={notice} />
                }
                <Intent t={t} screen={screen} address={address} slug={slug} />
                <Selector t={t} screen={screen} address={address} slug={slug} />
                <MarketSummary t={t} screen={screen} />
                <Rail t={t} screen={screen} address={address} slug={slug} notice={notice} />
            </div>
            <div class={Below}>
                <MarketBook t={t} screen={screen} address={address} slug={slug} />
                if !screen.similar.is_empty() {
                    <Similar t={t} items={&screen.similar} />
                }
            </div>
        </div>
        <Dock t={t} screen={screen} address={address} slug={slug} />
        // The market parts again on each change to the item (`items::live`).
        <corten-live src={&url::ItemLive { id: &item.catalog_item_id, state: address.clone() }.href()}></corten-live>
    }
}

/// The parts of the page `<corten-live>` draws again on a change to the item: the market
/// summary, the market book and the mobile dock, each by its id.
pub fn item_live_parts<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render + 'a {
    html! {
        <MarketSummary t={t} screen={screen} />
        <MarketBook t={t} screen={screen} address={address} slug={slug} />
        <Dock t={t} screen={screen} address={address} slug={slug} />
    }
}

/// Marketplace's mobile action dock (`CommerceActionBar` in `MarketplaceProductMobileActionDock`),
/// held at the bottom of the screen below 80rem: the price, then Buy, Sell and Watch, or one
/// Select options while the options name no product. Marketplace's buttons open the rail's card in
/// a bottom sheet, which needs its script. The pilot's are links to the rail on that side
/// (`#rail-title`), so they work without JavaScript, and the rail is the one form.
#[component(css = ItemDetail)]
fn Dock<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let to_rail = move |market: Market| {
        format!("{}#rail-title", url::Item { slug, state: address.with_market(market), after: Default::default() }.href())
    };
    let track = move |market: Market| {
        let (workflow, selection) = screen.rail_labels(market);
        analytics::railIntent(true, market.as_str(), workflow, selection, screen.rail_viewer(), "mobile_action_bar")
    };
    let summary = &screen.summary;
    let price = match screen.market {
        Market::Buy if screen.selected_listing().is_some() => screen.selected_listing().map(|l| listing_price(t, l)),
        Market::Sell => screen.offers.first().map(|o| offer_price(t, o)),
        _ => summary
            .lowest_price_currency_code
            .as_ref()
            .map(|_| money(t, summary.lowest_price_amount.as_deref(), summary.lowest_price_currency_code.as_deref())),
    };
    let price = price.unwrap_or_else(|| t.view_market_price_unavailable().to_owned());
    html! {
        <div class={Dock} id="item-dock">
            <nav class={DockBar} aria-label={t.page_choose_market_intent()}>
                if screen.product_id.is_some() {
                    <p class={DockPrice}>{&price}</p>
                    <div class={DockActions}>
                        <a class={(Button, Primary)} href={&to_rail(Market::Buy)} on:click={track(Market::Buy)}>
                            {t.page_buy_2()}
                        </a>
                        <a class={Button} href={&to_rail(Market::Sell)} on:click={track(Market::Sell)}>{t.route_sell_2()}</a>
                        <a class={Button} href={&to_rail(Market::Watch)} on:click={track(Market::Watch)}>{t.route_watch()}</a>
                    </div>
                } else {
                    <a class={(Button, Primary, Wide)} href={SelectOptionsId.fragment()}>{t.page_select_options()}</a>
                }
            </nav>
        </div>
    }
}

/// Marketplace's `ImageGallery` with its thumbnails on the left: one picture at a time, picked by
/// its thumbnail. Each thumbnail is a radio button (no form: it posts nothing) drawn before its
/// picture, and the stylesheet shows the picture after the checked one, so it needs no script, and
/// arrow keys move through them. A picture not shown is `loading="lazy"`, so the browser does not
/// fetch it until it is picked.
#[component(css = ItemDetail)]
fn Gallery<'a>(shots: &'a [Shot]) -> impl Render {
    html! {
        <div class={Gallery}>
            for (i, shot) in shots.iter().enumerate() {
                <label class={Thumb}>
                    <input type="radio" name="item-gallery" checked={i == 0} aria-label={&shot.alt}>
                    <img src={&shot.thumb} alt="" width="64" height="64" loading="lazy" decoding="async">
                </label>
                <img
                    class={Shot}
                    src={&shot.image.src}
                    srcset={shot.image.srcset.as_deref()}
                    sizes={shot.image.srcset.as_ref().map(|_| "(min-width: 768px) 308px, min(100vw, 276px)")}
                    width={shot.image.width}
                    height={shot.image.height}
                    loading={if i == 0 { "eager" } else { "lazy" }}
                    fetchpriority={(i == 0).then_some("high")}
                    alt={&shot.alt}
                >
            }
        </div>
    }
}

/// Marketplace's similar items (`ItemDetailSimilarItems`): a card for each, one column, two from
/// 64rem. Each card is the search result's `ListingCard` without its parts that do nothing here:
/// its Save button has no action in marketplace, and the card back drawn behind a picture is
/// decoration. Below the market book, so each picture is `loading="lazy"`.
#[component(css = ItemDetail)]
fn Similar<'a>(t: ItemMsg, items: &'a [SimilarItem]) -> impl Render {
    html! {
        <section class={SimilarSection} aria-labelledby="similar-items">
            <h2 class={CardTitle} id="similar-items">{t.similar_title()}</h2>
            <ul class={SimilarGrid}>
                for item in items {
                    <SimilarCard t={t} item={item} />
                }
            </ul>
        </section>
    }
}

/// A similar item's card: its picture (`similar_image`), its title and subtitle, and View item,
/// which names the card it is in.
#[component(css = ItemDetail)]
fn SimilarCard<'a>(t: ItemMsg, item: &'a SimilarItem) -> impl Render {
    let slug = if item.slug.is_empty() { item.catalog_item_id.as_str() } else { item.slug.as_str() };
    let href = url::Item { slug, state: Address::default(), after: Default::default() }.href();
    let alt = match item.subtitle.as_deref().filter(|s| !s.is_empty()) {
        Some(subtitle) => t.identity_title_and_subtitle(&item.title, subtitle).to_string(),
        None => t.identity_title(&item.title).to_string(),
    };
    let title_id = format!("similar-{}", item.catalog_item_id);
    let image = similar_image(item);
    html! {
        <li class={SimilarCard}>
            <div class={SimilarMedia}>
                match &image {
                    Some(image) => {
                        <img
                            src={&image.src}
                            srcset={image.srcset.as_deref()}
                            sizes={image.srcset.as_ref().filter(|s| s.ends_with('w')).map(|_| "(min-width: 768px) 164px, 124px")}
                            width={image.width}
                            height={image.height}
                            loading="lazy"
                            decoding="async"
                            alt={&alt}
                        >
                    }
                    None => { <span class={SimilarNoImage} role="img" aria-label={&alt}></span> }
                }
            </div>
            <div class={SimilarText}>
                <h3 class={SimilarTitle} id={&title_id}>{&item.title}</h3>
                if let Some(subtitle) = item.subtitle.as_deref().filter(|s| !s.is_empty()) {
                    <p class={SimilarSubtitle}>{subtitle}</p>
                }
                <a class={Button} href={&href} aria-describedby={&title_id} on:click={analytics::similarItem()}>
                    {t.similar_view_item()}
                </a>
            </div>
        </li>
    }
}

/// A similar item's card picture (`buildDiscoveryProductAssetImage(.., "search-card", ..)`, then
/// the first image, then the card back when it stays, at its card size).
pub fn similar_image(item: &SimilarItem) -> Option<Image> {
    for set in &item.product_asset_sets {
        let mut variants: Vec<_> = set.variants.iter().filter(|v| v.role == "search-card").collect();
        variants.sort_by_key(|v| v.width);
        if let Some(one) = variants.iter().find(|v| v.density == 1).or(variants.first()) {
            let srcset = variants.iter().map(|v| format!("{} {}w", on_marketplace(&v.public_url), v.width)).collect::<Vec<_>>();
            return Some(Image {
                src: on_marketplace(&one.public_url),
                srcset: Some(srcset.join(", ")),
                width: Some(one.width),
                height: Some(one.height),
            });
        }
    }
    if let Some(url) = item.image_urls.first() {
        return Some(Image { src: on_marketplace(url), srcset: None, width: None, height: None });
    }
    let fallback = item.image_fallback.as_ref().filter(|f| f.usage == "permanent")?;
    let card = fallback.variants.get("card");
    let srcset = card.map(|v| {
        [(v.one_x.as_deref(), "1x"), (v.two_x.as_deref(), "2x")]
            .into_iter()
            .filter_map(|(url, density)| url.map(|url| format!("{} {density}", on_marketplace(url))))
            .collect::<Vec<_>>()
            .join(", ")
    });
    Some(Image { src: on_marketplace(&fallback.url), srcset: srcset.filter(|s| !s.is_empty()), width: None, height: None })
}

/// The Sales tab (`ItemDetailMarketPanel`): the spread, then for each currency the product has
/// sold in its last sale, its 30- and 90-day medians and its sale prices over the range, which are
/// links. Neutral words only, as marketplace's: counts, prices and dates.
#[component(css = ItemDetail)]
fn Sales<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let p = Pilot::default();
    let again = url::Item { slug, state: address.clone(), after: Default::default() }.href();
    html! {
        <div class={Panel}>
            match &screen.history {
                Some(History::NoProduct) => {
                    <div class={Empty}>
                        <p class={Strong}>{t.panel_select_condition_title()}</p>
                        <p class={Muted}>{t.panel_select_condition_description()}</p>
                    </div>
                }
                Some(History::Failed) => {
                    <div class={Empty}>
                        <p class={Strong}>{t.panel_error_title()}</p>
                        <p class={Muted}>{t.panel_error_description()}</p>
                    </div>
                }
                Some(History::Read { stats, series }) => {
                    <SalesRead t={t} stats={stats} series={series} title={&screen.item.title} address={address} slug={slug} />
                }
                // A refused form's page does not read the history again: the page itself does.
                None => {
                    <p class={Count}><a href={&again}>{p.item_sales_again()}</a></p>
                }
            }
        </div>
    }
}

/// One currency's numbers and chart on the Sales tab.
struct CurrencySales {
    heading: Option<String>,
    sold: (String, Option<String>),
    m30: (String, String),
    m90: (String, String),
    chart: SalesChart,
    /// The chart summary's id, one for each currency.
    summary_id: String,
}

/// The Sales tab's numbers and chart, once read.
#[component(css = ItemDetail)]
fn SalesRead<'a>(
    t: ItemMsg,
    stats: &'a crate::api::MarketStats,
    series: &'a [(String, Vec<RollupPoint>)],
    title: &'a str,
    address: &'a Address,
    slug: &'a str,
) -> impl Render {
    let minimum = stats.stat_hygiene.as_ref().map_or(3, |h| h.minimum_trade_sample);
    let markers = stats.display_policy.as_ref().is_none_or(|d| d.show_verified_markers);
    let (spread, spread_note) = spread(t, stats.market_state.as_ref());
    let aggregates: Vec<Option<&MarketAggregate>> =
        if stats.aggregates.is_empty() { vec![None] } else { stats.aggregates.iter().map(Some).collect() };
    let several = stats.aggregates.len() > 1;
    let groups: Vec<CurrencySales> = aggregates
        .into_iter()
        .map(|aggregate| {
            let currency = aggregate.map(|a| a.currency_code.as_str());
            let points: &[RollupPoint] =
                series.iter().find(|(c, _)| Some(c.as_str()) == currency).map_or(&[], |(_, points)| points.as_slice());
            CurrencySales {
                heading: currency.filter(|_| several).map(|c| t.panel_currency_group(c).to_string()),
                sold: last_sold(t, aggregate),
                m30: median(t, aggregate, 30, minimum),
                m90: median(t, aggregate, 90, minimum),
                chart: SalesChart::of(t, points, currency, markers),
                summary_id: format!("sales-summary-{}", currency.unwrap_or("none").to_ascii_lowercase()),
            }
        })
        .collect();
    let label = t.panel_chart_label(title).to_string();
    html! {
        <dl class={Stats}>
            <div class={Stat}>
                <dt>{t.panel_spread_label()}</dt>
                <dd class={StatValue}>{&spread}</dd>
                if let Some(note) = &spread_note {
                    <dd class={Muted}>{note}</dd>
                }
            </div>
        </dl>
        for group in &groups {
            <section class={SalesGroup}>
                if let Some(heading) = &group.heading {
                    <h3 class={Label}>{heading}</h3>
                }
                <dl class={(Stats, Three)}>
                    <div class={Stat}>
                        <dt>{t.panel_last_sold_label()}</dt>
                        <dd class={StatValue}>{&group.sold.0}</dd>
                        if let Some(note) = &group.sold.1 {
                            <dd class={Muted}>{note}</dd>
                        }
                    </div>
                    <div class={Stat}>
                        <dt>{t.panel_median30d_label()}</dt>
                        <dd class={StatValue}>{&group.m30.0}</dd>
                        <dd class={Muted}>{&group.m30.1}</dd>
                    </div>
                    <div class={Stat}>
                        <dt>{t.panel_median90d_label()}</dt>
                        <dd class={StatValue}>{&group.m90.0}</dd>
                        <dd class={Muted}>{&group.m90.1}</dd>
                    </div>
                </dl>
                <Ranges t={t} address={address} slug={slug} />
                match &group.chart.chart {
                    Chart::Plot(plot) => {
                        <TimeSeries plot={plot} label={&label} summary={&group.chart.summary} summary_id={&group.summary_id} />
                    }
                    Chart::Empty => {
                        <div class={Empty}>
                            <p class={Strong}>{t.panel_chart_empty_title()}</p>
                            <p class={Muted}>{t.panel_chart_empty_description()}</p>
                        </div>
                    }
                    Chart::Insufficient => {
                        <div class={Empty}>
                            <p class={Strong}>{t.panel_chart_insufficient_title()}</p>
                            <p class={Muted}>{t.panel_chart_insufficient_description()}</p>
                        </div>
                    }
                }
            </section>
        }
    }
}

/// The chart's time range, each a link to the page with it (`SegmentedControl`). Marketplace
/// draws it only above a plot; the pilot draws it above an empty chart too, since a wider range
/// may have the sales a narrow one lacks.
#[component(css = ItemDetail)]
fn Ranges<'a>(t: ItemMsg, address: &'a Address, slug: &'a str) -> impl Render {
    let range = move |r: Range| url::Item { slug, state: address.with_range(r), after: Default::default() }.href();
    let current = move |r: Range| (address.range == r).then_some("true");
    html! {
        <nav class={(Segmented, ChartRanges)} aria-label={t.panel_range_selector_label()}>
            for r in Range::EVERY {
                <a class={Segment} href={&range(r)} aria-current={current(r)}>{range_label(t, r)}</a>
            }
        </nav>
    }
}

fn range_label(t: ItemMsg, range: Range) -> &'static str {
    match range {
        Range::Days30 => t.panel_range_30d(),
        Range::Days90 => t.panel_range_90d(),
        Range::Year => t.panel_range_1y(),
        Range::All => t.panel_range_all(),
    }
}

/// The spread and what it is between (`formatSpread`): ask and bid, or only one of them.
fn spread(t: ItemMsg, state: Option<&MarketState>) -> (String, Option<String>) {
    // Marketplace formats these without a currency, which it reads as dollars.
    let usd = |amount: &str| money(t, Some(amount), Some("USD"));
    let unavailable = || t.panel_unavailable().to_owned();
    let Some(state) = state else { return (unavailable(), None) };
    let ask = state.min_ask_amount.as_deref().filter(|a| !a.is_empty());
    let bid = state.max_bid_amount.as_deref().filter(|a| !a.is_empty());
    match (ask, bid) {
        (Some(ask), Some(bid)) => (
            state.spread_amount.as_deref().filter(|a| !a.is_empty()).map_or_else(unavailable, usd),
            Some(t.panel_ask_and_bid(&usd(ask), &usd(bid)).to_string()),
        ),
        (Some(ask), None) => (usd(ask), Some(t.panel_ask_only().to_owned())),
        (None, Some(bid)) => (usd(bid), Some(t.panel_bid_only().to_owned())),
        (None, None) => (unavailable(), None),
    }
}

/// The last sale and when (`formatLastSold`).
fn last_sold(t: ItemMsg, aggregate: Option<&MarketAggregate>) -> (String, Option<String>) {
    let Some((aggregate, at)) = aggregate.and_then(|a| a.last_sold_at.as_deref().map(|at| (a, at))) else {
        return (t.panel_no_sales_yet().to_owned(), None);
    };
    let date = corten::i18n::parse_timestamp(at)
        .map(|at| t.date_time(at, corten::i18n::DateStyle::Medium, corten::i18n::TimeStyle::Short).to_string())
        .unwrap_or_else(|| at.to_owned());
    (
        money(t, aggregate.last_sold_price_amount.as_deref(), Some(&aggregate.currency_code)),
        Some(t.panel_sold_on(&date).to_string()),
    )
}

/// A window's median, or why it is not shown (`formatMedianWindow`): no sales, or fewer than
/// the minimum sample.
fn median(t: ItemMsg, aggregate: Option<&MarketAggregate>, days: u32, minimum: u64) -> (String, String) {
    let (amount, volume, trades) = match (aggregate, days) {
        (Some(a), 30) => (a.median_price30d.as_deref(), a.volume30d, a.trade_count30d),
        (Some(a), _) => (a.median_price90d.as_deref(), a.volume90d, a.trade_count90d),
        (None, _) => (None, 0, 0),
    };
    if let (Some(a), Some(amount)) = (aggregate, amount.filter(|m| !m.is_empty())) {
        let sold = if volume == 1 {
            t.panel_units_sold_singular(volume).to_string()
        } else {
            t.panel_units_sold_plural(volume).to_string()
        };
        return (money(t, Some(amount), Some(&a.currency_code)), sold);
    }
    let unavailable = t.panel_unavailable().to_owned();
    if trades == 0 {
        return (unavailable, t.panel_no_sales_in_window(days).to_string());
    }
    let note = if trades == 1 {
        t.panel_median_suppressed_singular(trades, days, minimum).to_string()
    } else {
        t.panel_median_suppressed_plural(trades, days, minimum).to_string()
    };
    (unavailable, note)
}

/// A currency's sale prices as a chart (`TimeSeriesChart`, drawn by `platform::chart`): the line
/// of each period's last price, the band from its lowest to its highest, a mark on each period
/// with a verified sale, and the summary a screen reader reads.
struct SalesChart {
    chart: Chart,
    summary: String,
}

impl SalesChart {
    fn of(t: ItemMsg, points: &[RollupPoint], currency: Option<&str>, markers: bool) -> Self {
        let p = Pilot::default();
        let price = |v: f64| money(t, Some(&format!("{v:.2}")), currency);
        let amount = |a: &Option<String>| a.as_deref().and_then(|a| a.parse::<f64>().ok());
        let mut sorted: Vec<&RollupPoint> = points.iter().collect();
        sorted.sort_by(|a, b| a.day.cmp(&b.day));
        let mut marks = Vec::new();
        let chart = Chart::of(
            sorted
                .iter()
                .map(|point| {
                    let value = amount(&point.last_price_amount);
                    let mark = value.filter(|_| markers && point.verified_trade_count > 0).map(|v| {
                        let label = t.panel_verified_sale_marker(&price(v), &point.day).to_string();
                        marks.push(label.clone());
                        label
                    });
                    // A period without a price is left out, its band too.
                    let band = value.and(amount(&point.min_price_amount).zip(amount(&point.max_price_amount)));
                    chart::Point { day: &point.day, value, band, mark }
                })
                .collect(),
        );
        let name = t.panel_chart_series_name();
        let mut summary = match &chart {
            Chart::Plot(plot) => p.item_chart_summary(name, plot.count, &price(plot.min), &price(plot.max)).to_string(),
            Chart::Empty | Chart::Insufficient => String::new(),
        };
        for label in &marks {
            summary.push(' ');
            summary.push_str(&p.item_chart_marker(name, label).to_string());
        }
        SalesChart { chart, summary }
    }
}

/// A listing or offer the address chose that the market no longer has.
#[component(css = ItemDetail)]
fn Stale<'a>(title: &'a str, text: &'a str) -> impl Render {
    html! {
        <div class={Banner} role="status">
            <p class={Strong}>{title}</p>
            <p>{text}</p>
        </div>
    }
}

/// Buy, Sell or Watch (`SegmentedControl` "Choose market intent"), each a link to the same page
/// on that side.
#[component(css = ItemDetail)]
fn Intent<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let link = move |market: Market| url::Item { slug, state: address.with_market(market), after: Default::default() }.href();
    let current = move |market: Market| (screen.market == market).then_some("true");
    let track = move |market: Market| {
        let (workflow, selection) = screen.rail_labels(market);
        let changed = screen.market != market;
        analytics::railIntent(changed, market.as_str(), workflow, selection, screen.rail_viewer(), "desktop_rail")
    };
    html! {
        <nav class={Segmented} aria-label={t.page_choose_market_intent()}>
            <a class={Segment} href={&link(Market::Buy)} aria-current={current(Market::Buy)} on:click={track(Market::Buy)}>
                {t.page_buy()}
            </a>
            <a class={Segment} href={&link(Market::Sell)} aria-current={current(Market::Sell)} on:click={track(Market::Sell)}>
                {t.page_sell()}
            </a>
            <a class={Segment} href={&link(Market::Watch)} aria-current={current(Market::Watch)} on:click={track(Market::Watch)}>
                {t.page_watch()}
            </a>
        </nav>
    }
}

/// What an option's market is, after its name: "2 from $389.00", "1 requested from $380.00", or
/// "none".
fn option_note(t: ItemMsg, market: Market, summary: Option<&OptionMarket>) -> String {
    let Some(summary) = summary else { return t.page_none().to_owned() };
    let price = summary.price.as_ref().map_or_else(|| money(t, None, None), |p| money(t, Some(&p.amount), Some(&p.currency)));
    if market == Market::Sell {
        t.page_offer_option_summary(summary.count, &price).to_string()
    } else {
        t.page_option_summary(summary.count, &price).to_string()
    }
}

/// The product's options (`ProductSelector`): each dimension that applies, five options or fewer
/// as links, more as a GET form; "Any" takes the dimension's option away.
#[component(css = ItemDetail)]
fn Selector<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let schema = screen.item.product_schema.as_ref().filter(|s| !s.dimensions.is_empty());
    let picks = &screen.picks;
    let chosen = screen.chosen();
    let current = if chosen.is_empty() {
        if picks.is_empty() { t.page_all_listings() } else { t.page_filtered_active_listings() }
    } else {
        ""
    };
    html! {
        if let Some(schema) = schema {
            <section class={Card} id={SelectOptionsId} aria-labelledby="choose-options">
                <h2 class={CardTitle} id="choose-options">{t.page_choose_options()}</h2>
                for dimension in active_dimensions(schema, picks) {
                    <DimensionChoice t={t} screen={screen} address={address} slug={slug} dimension={dimension} />
                }
                <h3 class={Label}>{t.page_chosen_options()}</h3>
                if chosen.is_empty() {
                    <p class={Muted}>{current}</p>
                } else {
                    <ul class={Chips}>
                        for (dimension, option) in &chosen {
                            <li class={Chip}><span class={Muted}>{*dimension}</span> " " {*option}</li>
                        }
                    </ul>
                }
            </section>
        }
    }
}

/// One dimension's options.
#[component(css = ItemDetail)]
fn DimensionChoice<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    address: &'a Address,
    slug: &'a str,
    dimension: &'a crate::api::Dimension,
) -> impl Render {
    let schema = screen.item.product_schema.as_ref();
    let picks = &screen.picks;
    let id = dimension.dimension_id.as_str();
    let selected = picks.get(id);
    let options = ordered_options(dimension);
    let summaries = screen.option_summaries.get(id);
    let note = move |option: &str| option_note(t, screen.market, summaries.and_then(|s| s.get(option)).and_then(Option::as_ref));
    let with = move |option: Option<&str>| -> String {
        let Some(schema) = schema else { return String::new() };
        let mut next: Picks = picks.clone();
        match option {
            Some(option) => {
                next.insert(id.to_owned(), option.to_owned());
            }
            None => {
                next.remove(id);
            }
        }
        let next = normalize(schema, &next);
        url::Item { slug, state: address.with_picks(schema, &next, option.is_none().then_some(id)), after: Default::default() }
            .href()
    };
    // The other options, which the form sends along with this one.
    let others: Vec<(String, &String)> =
        picks.iter().filter(|(d, _)| d.as_str() != id).map(|(d, o)| (format!("dimension.{d}"), o)).collect();
    let name = format!("dimension.{id}");
    html! {
        <div class={DimensionBlock}>
            if options.len() <= 5 {
                <p class={Label} id={&format!("dim-{id}")}>{&dimension.dimension_name}</p>
                <ul class={Options} aria-labelledby={&format!("dim-{id}")}>
                    <li>
                        <a class={OptionLink} href={&with(None)} aria-current={selected.is_none().then_some("true")}>
                            {t.selector_any()}
                        </a>
                    </li>
                    for option in &options {
                        <li>
                            <a
                                class={OptionLink}
                                href={&with(Some(&option.option_id))}
                                aria-current={(selected == Some(&option.option_id)).then_some("true")}
                            >
                                <span class={Strong}>{option_label(option)}</span>
                                <span class={Note}>{note(&option.option_id)}</span>
                            </a>
                        </li>
                    }
                </ul>
            } else {
                <form class={Pick} method="get">
                    if address.market != Market::Buy {
                        <input type="hidden" name="market" value={match address.market { Market::Sell => "sell", _ => "watch" }}>
                    }
                    for (key, value) in &others {
                        <input type="hidden" name={key} value={*value}>
                    }
                    <label class={Label} for={&format!("dim-{id}")}>{&dimension.dimension_name}</label>
                    <div class={PickRow}>
                        <select id={&format!("dim-{id}")} name={&name}>
                            <option value="any" selected={selected.is_none()}>{t.selector_any()}</option>
                            for option in &options {
                                <option value={&option.option_id} selected={selected == Some(&option.option_id)}>
                                    {format!("{} \u{b7} {}", option_label(option), note(&option.option_id))}
                                </option>
                            }
                        </select>
                        <button type="submit">{t.page_select()}</button>
                    </div>
                </form>
            }
        </div>
    }
}

/// The market for the options chosen (`MarketplaceMarketSummary`): the lowest ask or the best
/// offer, what it covers, and three facts.
#[component(css = ItemDetail)]
fn MarketSummary<'a>(t: ItemMsg, screen: &'a ItemScreen) -> impl Render {
    let sell = screen.market == Market::Sell;
    let s = &screen.summary;
    let price = if sell {
        let currency = {
            let mut currencies = screen.offers.iter().map(|o| o.price_currency_code.as_deref());
            match currencies.next().flatten() {
                Some(first) if currencies.all(|c| c == Some(first)) => Some(first),
                _ => None,
            }
        };
        let best = screen.offers.first().filter(|o| platform::money::cents(&o.price_amount).is_some());
        money(t, best.map(|o| o.price_amount.as_str()), currency)
    } else if s.lowest_price_currency_code.is_some() {
        money(t, s.lowest_price_amount.as_deref(), s.lowest_price_currency_code.as_deref())
    } else {
        t.view_market_price_unavailable().to_owned()
    };
    let chosen = screen.chosen();
    let note = match (chosen.is_empty(), sell, screen.picks.is_empty()) {
        (false, ..) => String::new(),
        (true, true, true) => t.page_all_offers().to_owned(),
        (true, true, false) => t.page_filtered_offers().to_owned(),
        (true, false, true) => t.page_all_active_listings().to_owned(),
        (true, false, false) => t.page_filtered_active_listings().to_owned(),
    };
    let count = |n: usize, one: fn(ItemMsg, u64) -> String, many: fn(ItemMsg, u64) -> String| {
        if n == 1 { one(t, 1) } else { many(t, n as u64) }
    };
    let facts: Vec<(&str, String)> = if sell {
        vec![
            (t.page_requested(), t.number(screen.offers.iter().map(|o| o.quantity_requested).sum::<u64>()).to_string()),
            (
                t.page_offers(),
                count(
                    screen.offers.len(),
                    |t, n| t.page_offer_count_singular(n).to_string(),
                    |t, n| t.page_offer_count_plural(n).to_string(),
                ),
            ),
            (
                t.page_buyers(),
                count(
                    s.buyers,
                    |t, n| t.page_buyer_count_singular(n).to_string(),
                    |t, n| t.page_buyer_count_plural(n).to_string(),
                ),
            ),
        ]
    } else {
        vec![
            (t.page_available(), t.number(s.total_visible_quantity).to_string()),
            (
                t.page_listings(),
                count(
                    s.active_listing_count,
                    |t, n| t.page_listing_count_singular(n).to_string(),
                    |t, n| t.page_listing_count_plural(n).to_string(),
                ),
            ),
            (
                t.page_sellers(),
                count(
                    s.sellers,
                    |t, n| t.page_seller_count_singular(n).to_string(),
                    |t, n| t.page_seller_count_plural(n).to_string(),
                ),
            ),
        ]
    };
    html! {
        <section class={Card} id="market-summary" aria-labelledby="market-price">
            <p class={Label} id="market-price">{if sell { t.page_best_offer() } else { t.page_lowest_ask() }}</p>
            <p class={Price}>{&price}</p>
            if chosen.is_empty() {
                <p class={Muted}>{&note}</p>
            } else {
                <ul class={Chips}>
                    for (dimension, option) in &chosen {
                        <li class={Chip}><span class={Muted}>{*dimension}</span> " " {*option}</li>
                    }
                </ul>
            }
            <dl class={Facts}>
                for (label, value) in &facts {
                    <div>
                        <dt>{*label}</dt>
                        <dd>{value}</dd>
                    </div>
                }
            </dl>
        </section>
    }
}

/// What the buyer would act on, and the buy forms (marketplace's purchase section): for the listing
/// shown, Buy this listing and Add listing to Buy Cart; for the product chosen (folded under the
/// listing when there is one), Add product to Buy Cart and Buy best match. Each is a plain form,
/// so it works without JavaScript (`buying`). A write that is not known to have applied holds the
/// adds until the buyer sends it again or looks at the cart. On the Sell tab, the sell forms
/// (`SellForms`). Listing at a price and watching are marketplace's page until the pilot ports
/// them.
#[component(css = ItemDetail)]
fn Rail<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    address: &'a Address,
    slug: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render {
    let p = Pilot::default();
    let sell = screen.market == Market::Sell;
    let watch = screen.market == Market::Watch;
    let listing = (screen.market == Market::Buy).then(|| screen.selected_listing()).flatten();
    let offer = sell.then(|| screen.selected_offer()).flatten();
    let title = match (listing, offer) {
        _ if watch => t.route_watch(),
        (Some(_), _) if screen.listing_explicit => t.page_selected_listing(),
        (Some(_), _) => t.route_best_available_listing(),
        (_, Some(_)) if screen.offer_explicit => t.route_selected_offer_heading(),
        (_, Some(_)) => t.route_best_offer_heading(),
        _ => t.route_selected_product(),
    };
    let here = url::Item { slug, state: address.clone(), after: Default::default() }.href();
    let continue_on = on_marketplace(&here);
    let buying = screen.market == Market::Buy;
    let product = screen.product_id.as_deref().filter(|_| buying);
    let refused = match notice {
        Some(BuyNotice::Refused { message, input }) => Some((message.as_str(), input)),
        _ => None,
    };
    let held = matches!(notice, Some(BuyNotice::Ambiguous { .. }));
    let resend = match notice {
        Some(BuyNotice::Ambiguous { resend, .. }) => resend.pairs(),
        _ => Vec::new(),
    };
    let from = move |form: RailForm| refused.filter(|(_, i)| i.intent.form() == form);
    let typed = move |form: RailForm| from(form).map_or("1", |(_, i)| i.quantity.as_str());
    let error = move |form: RailForm| from(form).map(|(m, _)| m);
    let offered = from(RailForm::Offer).map(|(_, i)| i);
    // An offer's currency starts as the listings' (marketplace's field starts empty).
    let currency = offered.map(|i| i.currency.as_str()).or(screen.summary.lowest_price_currency_code.as_deref()).unwrap_or("USD");
    let lowest = screen.listings.first().map(|l| listing_price(t, l));
    let at_capacity = listing.is_some_and(|l| l.seller_at_capacity);
    let page = address.pairs();
    let cart = url::ItemCart { slug }.href();
    let buy_now = url::ItemBuy { slug }.href();
    let open_product = listing.is_none() || from(RailForm::Product).is_some();
    let offer_path = url::ItemOffer { slug }.href();
    let matches = screen.listings.len();
    let match_label = if matches == 1 { t.route_listing_matches_singular() } else { t.route_listing_matches_plural() };
    // The rail analytics' labels (marketplace's `PurchaseSection` and `OfferSection`).
    let viewer = screen.rail_viewer();
    let (listing_workflow, listing_selection) = screen.rail_labels(Market::Buy);
    let checkout_labels = [listing_workflow, listing_selection, "listing_checkout", ""];
    let cart_labels = ["listing_buy_cart", listing_selection, "listing_buy_cart", ""];
    let listing_refused_workflow = match from(RailForm::Listing) {
        Some((_, input)) if input.intent == BuyIntent::AddListing => "listing_buy_cart",
        _ => listing_workflow,
    };
    html! {
        <section class={(Card, RailCard)} aria-labelledby="rail-title">
            <h2 class={CardTitle} id="rail-title">{title}</h2>
            if let Some(l) = listing {
                <p class={Price}>{&listing_price(t, l)}</p>
                <p class={Muted}>
                    {l.seller_display_name.as_deref().unwrap_or(t.page_seller())} " \u{b7} "
                    {t.page_listing_available_count(available(l))}
                </p>
            } else if let Some(o) = offer {
                <p class={Price}>{&offer_price(t, o)}</p>
                <p class={Muted}>
                    {o.buyer_display_name.as_deref().unwrap_or(&o.buyer_account_id)} " \u{b7} "
                    {t.page_offer_requested_count(o.quantity_requested)}
                </p>
            }
            if let Some(BuyNotice::Added(to)) = notice {
                // The nav's badge reads the count again (a client navigation keeps the layout).
                <div class={(Banner, Added)} role="status" on:connect={super::market_nav::badge::stale()}>
                    <p class={Strong}>{t.route_added_to_cart()}</p>
                    <p>{t.route_added_to_cart_description(&screen.item.title)}</p>
                    <p><a class={Button} href={to}>{t.route_view_cart()}</a></p>
                </div>
            }
            if let Some(BuyNotice::Ambiguous { cart: to, .. }) = notice {
                <div class={Banner} role="status">
                    <p class={Strong}>{t.route_add_to_cart_ambiguous_title()}</p>
                    <p>{t.route_add_to_cart_ambiguous_description()}</p>
                    <form class={Resend} method="post" action={&cart}>
                        <Hidden pairs={&resend} />
                        <button type="submit" class={Button}>{t.route_add_to_cart_resend()}</button>
                        <a class={Button} href={to}>{t.route_view_cart()}</a>
                    </form>
                </div>
            }
            if buying && product.is_none() {
                <p class={Muted}>{t.route_product_intent_choose_options_guidance()}</p>
            }
            if let (Some(product), Some(l)) = (product, listing) {
                <form
                    class={Buy}
                    method="post"
                    action={&cart}
                    on:submit={analytics::submitted(event, "buy", checkout_labels, cart_labels, BuyIntent::AddListing.as_str())}
                >
                    {SubmitKey::field(BuyFields::FIELDS.attempt)}
                    <Hidden pairs={&page} />
                    <input type="hidden" name={field::PRODUCT} value={product}>
                    <input type="hidden" name={field::LOCK} value={&l.listing_id}>
                    if at_capacity {
                        <div class={Banner} role="status">
                            <p class={Strong}>{t.route_seller_at_capacity()}</p>
                            <p>{t.route_seller_at_capacity_description()}</p>
                        </div>
                    }
                    if let Some(message) = error(RailForm::Listing) {
                        <p
                            class={Error}
                            role="alert"
                            on:connect={analytics::refused("buy", listing_refused_workflow, listing_selection, "")}
                        >
                            {message}
                        </p>
                    }
                    <Quantity t={t} id="buy-listing-quantity" value={typed(RailForm::Listing)} />
                    <fieldset class={BuyActions} disabled={held}>
                        <button type="submit" class={(Button, Primary)} formaction={&buy_now} disabled={at_capacity}>
                            if at_capacity {
                                {t.route_seller_at_capacity()}
                            } else if screen.listing_explicit {
                                {t.route_buy_now()}
                            } else {
                                {t.route_buy_best_available_listing()}
                            }
                        </button>
                        <button type="submit" class={Button} name={field::INTENT} value="add-listing" disabled={at_capacity}>
                            {t.route_add_listing_to_cart()}
                        </button>
                    </fieldset>
                </form>
            }
            if let Some(product) = product {
                <details class={ProductBuy} open={open_product}>
                    <summary on:click={analytics::workflow(target, "buy", "selected_product", "", viewer)}>
                        <span class={Strong}>{t.route_selected_product()}</span>
                        <span class={Muted}>{t.route_add_to_cart_workflow_helper()}</span>
                    </summary>
                    <form
                        class={Buy}
                        method="post"
                        action={&cart}
                        on:submit={analytics::submitted(event, "buy", ["product_buy_cart", "none", "product_buy_cart", ""], ONE_WAY, "")}
                    >
                        {SubmitKey::field(BuyFields::FIELDS.attempt)}
                        <Hidden pairs={&page} />
                        <input type="hidden" name={field::PRODUCT} value={product}>
                        if matches > 0 {
                            <p class={Muted}>{t.route_listing_match_count(matches, match_label)}</p>
                        } else {
                            <p class={Muted}>{t.route_add_to_cart_saves_buyer_intent()}</p>
                        }
                        if let Some(message) = error(RailForm::Product) {
                            <p class={Error} role="alert" on:connect={analytics::refused("buy", "product_buy_cart", "none", "")}>
                                {message}
                            </p>
                        }
                        <Quantity t={t} id="buy-product-quantity" value={typed(RailForm::Product)} />
                        <fieldset class={BuyActions} disabled={held}>
                            <button
                                type="submit"
                                class={(Button, listing.is_none().then_some(Primary))}
                                name={field::INTENT}
                                value="add-product"
                            >
                                {t.route_add_to_cart()}
                            </button>
                            if matches > 0 {
                                <button type="submit" class={Button} name={field::INTENT} value="buy-best-match">
                                    {t.route_buy_best_match()}
                                </button>
                            }
                        </fieldset>
                    </form>
                </details>
                <details class={ProductBuy} open={offered.is_some()}>
                    <summary on:click={analytics::workflow(target, "buy", "make_offer", "", viewer)}>
                        <span class={Strong}>{t.route_make_an_offer()}</span>
                        <span class={Muted}>{t.route_make_offer_action_description()}</span>
                    </summary>
                    <form
                        class={Buy}
                        method="post"
                        action={&offer_path}
                        on:submit={analytics::submitted(event, "buy", ["make_offer", "", "make_offer", ""], ONE_WAY, "")}
                    >
                        <Hidden pairs={&page} />
                        <input type="hidden" name={field::PRODUCT} value={product}>
                        if let Some(lowest) = &lowest {
                            <p class={Muted}>{t.route_current_lowest_listing_summary(lowest)}</p>
                        }
                        if let Some(message) = error(RailForm::Offer) {
                            <p class={Error} role="alert" on:connect={analytics::refused("buy", "make_offer", "", "make_offer")}>
                                {message}
                            </p>
                        }
                        <div class={OfferFields}>
                            <div class={QuantityField}>
                                <label class={Label} for="offer-price">{t.route_offer_price()}</label>
                                <input
                                    id="offer-price"
                                    type="number"
                                    name={field::PRICE}
                                    min="0.01"
                                    step="0.01"
                                    inputmode="decimal"
                                    placeholder="24.99"
                                    required
                                    value={offered.map(|i| i.price.as_str())}
                                >
                            </div>
                            <div class={QuantityField}>
                                <label class={Label} for="offer-currency">{t.route_listing_price_currency_code()}</label>
                                <input
                                    id="offer-currency"
                                    type="text"
                                    name={field::CURRENCY}
                                    minlength="3"
                                    maxlength="3"
                                    autocapitalize="characters"
                                    placeholder={t.route_listing_price_currency_code_placeholder()}
                                    required
                                    value={currency}
                                >
                            </div>
                        </div>
                        <Quantity t={t} id="offer-quantity" value={typed(RailForm::Offer)} />
                        <button type="submit" class={Button}>{t.route_make_offer_action()}</button>
                    </form>
                </details>
            }
            if sell {
                <SellForms t={t} screen={screen} page={&page} slug={slug} here={&here} notice={notice} />
            }
            if watch {
                <WatchForms t={t} screen={screen} page={&page} slug={slug} notice={notice} />
            }
            <p><a class={(Button, Wide)} href={&continue_on}>{p.item_continue_on_marketplace()}</a></p>
        </section>
    }
}

/// An amount of cents as the API writes one (`12.30`); never negative here.
fn cents_text(cents: i128) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

/// Basis points as a percent in the request's locale, to at most two decimals (`formatBpsPercent`).
fn bps_percent(t: ItemMsg, bps: i64) -> String {
    format!("{}%", t.number(percent_of(bps)))
}

/// Basis points as a percent, with no trailing zero decimals (`maximumFractionDigits: 2`).
fn percent_of(bps: i64) -> corten::i18n::Decimal {
    let bps = i128::from(bps);
    match (bps % 100, bps % 10) {
        (0, _) => corten::i18n::Decimal::new(bps / 100, 0),
        (_, 0) => corten::i18n::Decimal::new(bps / 10, 1),
        _ => corten::i18n::Decimal::new(bps, 2),
    }
}

/// What accepting `offer` pays under `terms` (`MarketplaceOfferMatchSection`'s payout list): the
/// requested quantity, the payout after the fee, and the shipping allowance, each for the whole
/// quantity. Marketplace writes these in USD whatever the offer's currency; the pilot writes the
/// offer's.
fn payout(t: ItemMsg, offer: &Offer, terms: &crate::api::StandardTerms) -> Option<Vec<(String, String)>> {
    let quantity = i128::from(offer.quantity_requested);
    let cents = |amount: &str| platform::money::cents(amount).map(i128::from);
    let total = cents(&offer.price_amount)? * quantity;
    let fee = cents(&terms.marketplace_sales_fee_unit_amount)? * quantity;
    let net = cents(&terms.seller_net_unit_amount)? * quantity;
    let allowance = (total * i128::from(terms.shipping_allowance_percentage_bps) + 5_000) / 10_000;
    let currency = offer.price_currency_code.as_deref();
    let write = |c: i128| money(t, Some(&cents_text(c)), currency);
    Some(vec![
        (t.route_requested().to_owned(), t.route_requested_count(offer.quantity_requested).to_string()),
        (t.route_seller_payout().to_owned(), t.route_seller_payout_after_fee(&write(net), &write(fee)).to_string()),
        (
            t.route_shipping_allowance().to_owned(),
            t.route_shipping_allowance_amount(&write(allowance), &bps_percent(t, terms.shipping_allowance_percentage_bps))
                .to_string(),
        ),
    ])
}

/// The Sell tab's forms (marketplace's sell action card): for the offer shown, its total and what
/// accepting it pays, Accept offer and Add offer to Sell List; for the product chosen (folded
/// under the offer when there is one), Add product to Sell List. Plain forms (`selling`).
#[component(css = ItemDetail)]
fn SellForms<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    page: &'a [(String, String)],
    slug: &'a str,
    here: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render {
    let offer = screen.selected_offer();
    let product = screen.product_id.as_deref();
    let refused = match notice {
        Some(BuyNotice::SellRefused { message, form, quantity }) => Some((message.as_str(), *form, quantity.as_str())),
        _ => None,
    };
    let error = move |form: SellForm| refused.filter(|(_, f, _)| *f == form).map(|(m, _, _)| m);
    let typed = refused.filter(|(_, f, _)| *f == SellForm::Product).map_or("1", |(_, _, q)| q);
    let action = url::ItemSellList { slug }.href();
    let accept = if screen.seller_features { SellIntent::SellNow } else { SellIntent::AddOffer };
    let total = offer.and_then(|o| {
        let cents = platform::money::cents(&o.price_amount)? as i128 * i128::from(o.quantity_requested);
        Some(money(t, Some(&cents_text(cents)), o.price_currency_code.as_deref()))
    });
    let rows = offer.zip(screen.offer_terms.as_ref()).and_then(|(o, terms)| payout(t, o, terms));
    let open_product = offer.is_none() || error(SellForm::Product).is_some();
    // The rail analytics' labels (marketplace's `OfferMatchSection` and `ProductSellListSection`).
    let viewer = screen.rail_viewer();
    let (offer_workflow, offer_selection) = screen.rail_labels(Market::Sell);
    let accept_labels = [offer_workflow, offer_selection, "accept_offer", "commit"];
    let sell_list_labels = [offer_workflow, offer_selection, "offer_sell_list", "sell_list"];
    html! {
        if let Some(o) = offer {
            <form
                class={Buy}
                method="post"
                action={&action}
                on:submit={analytics::submitted(event, "sell", accept_labels, sell_list_labels, SellIntent::AddOffer.as_str())}
            >
                <Hidden pairs={page} />
                <input type="hidden" name={selling::field::OFFER} value={&o.offer_id}>
                if let Some(total) = &total {
                    <p class={Strong}>{t.route_offer_total(total)}</p>
                }
                if let Some(rows) = &rows {
                    <dl class={Pairs} on:connect={analytics::payout(true, offer_workflow, offer_selection)}>
                        for (label, value) in rows {
                            <div>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                            </div>
                        }
                    </dl>
                } else {
                    <p class={Muted} on:connect={analytics::payout(false, offer_workflow, offer_selection)}>
                        {t.route_offer_terms_calculated_before_acceptance()}
                    </p>
                }
                if let Some(message) = error(SellForm::Offer) {
                    <p class={Error} role="alert" on:connect={analytics::refused("sell", offer_workflow, offer_selection, "")}>
                        {message}
                    </p>
                }
                <fieldset class={BuyActions}>
                    <button type="submit" class={(Button, Primary)} name={selling::field::INTENT} value={accept.as_str()}>
                        {t.route_sell_now()}
                    </button>
                    <button type="submit" class={Button} name={selling::field::INTENT} value={SellIntent::AddOffer.as_str()}>
                        {t.route_add_to_sell_list()}
                    </button>
                </fieldset>
            </form>
        } else if product.is_none() {
            <p class={Muted}>{t.route_choose_options_to_review_matching_offers()}</p>
        } else {
            <p class={Muted}>{t.route_no_offers_match_this_product_yet()}</p>
        }
        if let Some(product) = product {
            <details class={ProductBuy} open={open_product}>
                <summary on:click={analytics::workflow(target, "sell", "selected_product", "", viewer)}>
                    <span class={Strong}>{t.route_add_product_to_sell_list()}</span>
                    <span class={Muted}>{t.route_add_product_to_sell_list_action_description()}</span>
                </summary>
                <form
                    class={Buy}
                    method="post"
                    action={&action}
                    on:submit={analytics::submitted(event, "sell", ["selected_product", "", "product_sell_list", ""], ONE_WAY, "")}
                >
                    <Hidden pairs={page} />
                    <input type="hidden" name={selling::field::PRODUCT} value={product}>
                    if let Some(message) = error(SellForm::Product) {
                        <p
                            class={Error}
                            role="alert"
                            on:connect={analytics::refused("sell", "selected_product", "", "product_sell_list")}
                        >
                            {message}
                        </p>
                    }
                    <Quantity t={t} id="sell-product-quantity" value={typed} />
                    <button
                        type="submit"
                        class={(Button, offer.is_none().then_some(Primary))}
                        name={selling::field::INTENT}
                        value={SellIntent::AddProduct.as_str()}
                    >
                        {t.route_add_product_to_sell_list()}
                    </button>
                </form>
            </details>
            <ListForms t={t} screen={screen} page={page} slug={slug} here={here} product={product} notice={notice} />
        }
    }
}

/// List this product, the Sell tab's third action (marketplace's `MarketplaceListingSubmissionSection`
/// and `ListingStockShipFromSetupSection`, or its listing registration panel), folded like the
/// others and open when the address chose the seller's own listing or a listing form was refused.
///
/// A seller who may list sees their own listing of the product and Manage listing, or the form:
/// the price (the best listing's to start), the currency and the quantity. Without a Listing
/// stock location the form says the ship-from setup comes first, its button is disabled, and the
/// setup's form follows. A guest drafts the listing without a ship-from and registers to publish
/// it. Any other account is sent to marketplace's registration, as marketplace sends it. Plain
/// forms (`listing`).
#[component(css = ItemDetail)]
fn ListForms<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    page: &'a [(String, String)],
    slug: &'a str,
    here: &'a str,
    product: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render {
    let own = screen.own_listing();
    let may_list = screen.listing_features || screen.guest_listing_draft;
    let (refused, typed, draft) = match notice {
        Some(BuyNotice::ListRefused { message, input, draft }) => (Some(message.as_str()), Some(input), draft.as_deref()),
        _ => (None, None, None),
    };
    let ship = match notice {
        Some(BuyNotice::ShipFromRefused { message, input }) => Some((message.as_str(), input)),
        _ => None,
    };
    let needs_setup = screen.listing_features && screen.listing_setup != ListingSetup::Ready;
    let setup_note = match &screen.listing_setup {
        ListingSetup::Recovering => t.route_ship_from_setup_pending_fresh_write(),
        ListingSetup::Failed(message) => message.as_str(),
        _ => t.route_ship_from_setup_required(),
    };
    let pending = screen.listing_pending.as_deref();
    let open = refused.is_some() || ship.is_some() || pending.is_some() || (own.is_some() && screen.listing_explicit);
    let p = Pilot::default();
    let best = screen.listings.first();
    let price = typed.map(|i| i.price.as_str()).or(best.map(|l| l.price_amount.as_str()));
    // A listing's currency starts as the listings' (marketplace's field starts empty).
    let currency = typed.map(|i| i.currency.as_str()).or(screen.summary.lowest_price_currency_code.as_deref()).unwrap_or("USD");
    let quantity = typed.map_or("1", |i| i.quantity.as_str());
    let manage = |id: &str| crate::seller_listing::at(id, None, None).href();
    let register = crate::register::href(here);
    let register_label =
        if screen.selected_offer().is_some() { t.route_sign_in_or_register_to_list() } else { t.route_register_to_sell() };
    let action = url::ItemList { slug }.href();
    let ship_action = url::ItemShipFrom { slug }.href();
    let typed_ship = move |pick: fn(&listing::ShipFromInput) -> &str| ship.map(|(_, i)| pick(i));
    let f = ListFields::FIELDS;
    // The rail analytics' labels (marketplace's `MarketplaceListingSubmissionSection` and its
    // registration gate, `create_listing`).
    let viewer = screen.rail_viewer();
    let gate = if may_list { "" } else { "create_listing" };
    html! {
        <details class={ProductBuy} open={open}>
            <summary on:click={analytics::workflow(target, "sell", "create_listing", gate, viewer)}>
                <span class={Strong}>{t.route_sell_on_chase_sets()}</span>
                <span class={Muted}>{t.route_list_for_sale_action_description()}</span>
            </summary>
            if !may_list {
                <dl class={Pairs}>
                    <div>
                        <dt>{t.route_asking_price()}</dt>
                        <dd>{t.route_set_after_registration()}</dd>
                    </div>
                    <div>
                        <dt>{t.route_inventory()}</dt>
                        <dd>{t.route_confirm_after_registration()}</dd>
                    </div>
                </dl>
                <p class={Muted}>{t.route_reference_info_create_listing_summary()}</p>
                <a
                    class={(Button, Primary)}
                    href={&register}
                    on:connect={analytics::gateShown(target, "sell", "create_listing", "create_listing", viewer)}
                    on:click={analytics::registering("sell", "create_listing", "create_listing", viewer)}
                >
                    {register_label}
                </a>
            } else if let Some(id) = pending {
                <div role="status">
                    <p class={Strong}>{p.item_listing_published()}</p>
                    <p class={Muted}>{p.item_listing_published_description()}</p>
                </div>
                <a class={Button} href={&manage(id)}>{t.route_manage_listing()}</a>
            } else if let Some(l) = own {
                <p class={Muted}>{t.route_your_listing_summary(&l.status, &listing_price(t, l))}</p>
                <a class={Button} href={&manage(&l.listing_id)}>{t.route_manage_listing()}</a>
            } else {
                <form
                    class={Buy}
                    method="post"
                    action={&action}
                    on:submit={analytics::submitted(event, "sell", ["create_listing", "", "create_listing", ""], ONE_WAY, "")}
                >
                    {SubmitKey::field(f.attempt)}
                    <Hidden pairs={page} />
                    <input type="hidden" name={listing::field::PRODUCT} value={product}>
                    if let Some(l) = best {
                        <p class={Muted}>{t.route_current_best_listing_summary(&listing_price(t, l))}</p>
                    }
                    <p class={Muted}>
                        {if screen.guest_listing_draft {
                            t.route_reference_info_create_listing_line1()
                        } else {
                            t.route_reference_info_create_listing_summary()
                        }}
                    </p>
                    if let Some(message) = refused {
                        <p
                            class={Error}
                            role="alert"
                            on:connect={analytics::refused("sell", "create_listing", "", "create_listing")}
                        >
                            {message}
                        </p>
                    }
                    if let Some(id) = draft {
                        <a class={Button} href={&manage(id)}>{t.route_manage_listing()}</a>
                    }
                    <div class={OfferFields}>
                        <div class={QuantityField}>
                            <label class={Label} for="list-price">{t.route_listing_price()}</label>
                            <input
                                id="list-price"
                                type="number"
                                name={listing::field::PRICE}
                                min="0"
                                step="0.01"
                                inputmode="decimal"
                                placeholder="24.99"
                                required
                                value={price}
                            >
                        </div>
                        <div class={QuantityField}>
                            <label class={Label} for="list-currency">{t.route_listing_price_currency_code()}</label>
                            <input
                                id="list-currency"
                                type="text"
                                name={listing::field::CURRENCY}
                                minlength="3"
                                maxlength="3"
                                autocapitalize="characters"
                                placeholder={t.route_listing_price_currency_code_placeholder()}
                                required
                                value={currency}
                            >
                        </div>
                    </div>
                    <Quantity t={t} id="list-quantity" value={quantity} />
                    if needs_setup {
                        <p class={Muted}>{setup_note}</p>
                    }
                    <button type="submit" class={(Button, Primary)} disabled={needs_setup}>{t.route_list_for_sale()}</button>
                </form>
                if screen.listing_features && screen.listing_setup == ListingSetup::Missing {
                    <form class={Buy} method="post" action={&ship_action}>
                        {SubmitKey::field(f.attempt)}
                        <Hidden pairs={page} />
                        <p class={Strong}>{t.route_ship_from_setup()}</p>
                        <p class={Muted}>{t.route_ship_from_setup_description()}</p>
                        if let Some((message, _)) = ship {
                            <p class={Error} role="alert">{message}</p>
                        }
                        <div class={AddressFields}>
                            <div class={(TextField, Full)}>
                                <label class={Label} for="ship-from-name">{t.route_ship_from_name()}</label>
                                <input
                                    id="ship-from-name"
                                    type="text"
                                    name={listing::field::NAME}
                                    autocomplete="name"
                                    required
                                    value={typed_ship(|i| &i.name)}
                                >
                            </div>
                            <div class={(TextField, Full)}>
                                <label class={Label} for="ship-from-line1">{t.route_ship_from_line1()}</label>
                                <input
                                    id="ship-from-line1"
                                    type="text"
                                    name={listing::field::LINE1}
                                    autocomplete="address-line1"
                                    required
                                    value={typed_ship(|i| &i.line1)}
                                >
                            </div>
                            <div class={TextField}>
                                <label class={Label} for="ship-from-city">{t.route_ship_from_city()}</label>
                                <input
                                    id="ship-from-city"
                                    type="text"
                                    name={listing::field::CITY}
                                    autocomplete="address-level2"
                                    required
                                    value={typed_ship(|i| &i.city)}
                                >
                            </div>
                            <div class={TextField}>
                                <label class={Label} for="ship-from-state">{t.route_ship_from_state()}</label>
                                <input
                                    id="ship-from-state"
                                    type="text"
                                    name={listing::field::STATE}
                                    autocomplete="address-level1"
                                    required
                                    value={typed_ship(|i| &i.state)}
                                >
                            </div>
                            <div class={TextField}>
                                <label class={Label} for="ship-from-postal-code">{t.route_ship_from_postal_code()}</label>
                                <input
                                    id="ship-from-postal-code"
                                    type="text"
                                    name={listing::field::POSTAL_CODE}
                                    autocomplete="postal-code"
                                    required
                                    value={typed_ship(|i| &i.postal_code)}
                                >
                            </div>
                            <div class={TextField}>
                                <label class={Label} for="ship-from-country">{t.route_ship_from_country()}</label>
                                <input
                                    id="ship-from-country"
                                    type="text"
                                    name={listing::field::COUNTRY}
                                    autocomplete="country"
                                    required
                                    value={typed_ship(|i| &i.country).unwrap_or("US")}
                                >
                            </div>
                        </div>
                        <button type="submit" class={Button}>{t.route_save_ship_from_setup()}</button>
                    </form>
                }
            }
        </details>
    }
}

/// The Watch tab's forms (marketplace's `WatchActionCard`): Watch listings (a maximum listing
/// price) and Watch offers (a minimum offer price), each folded in a `<details>` (listings open),
/// for the product chosen. A guest registers to save the alert. Plain forms (`watching`).
#[component(css = ItemDetail)]
fn WatchForms<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    page: &'a [(String, String)],
    slug: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render {
    let p = Pilot::default();
    let product = screen.product_id.as_deref();
    let refused = match notice {
        Some(BuyNotice::WatchRefused { message, input }) => Some((message.as_str(), input)),
        _ => None,
    };
    let from = move |side: Side| refused.filter(|(_, i)| i.side == side);
    let currency = screen.summary.lowest_price_currency_code.as_deref().unwrap_or("USD");
    let action = url::ItemWatch { slug }.href();
    let open_offers = from(Side::Offer).is_some();
    // The rail analytics' labels (marketplace's `ProductAlertSection`).
    let viewer = screen.rail_viewer();
    let labels = |side: Side| match side {
        Side::Listing => ("watch_listings", "listing_alert"),
        Side::Offer => ("watch_offers", "offer_alert"),
    };
    let sides = [
        (
            Side::Listing,
            t.route_watch_listings(),
            t.route_watch_listings_description(),
            t.route_alert_maximum_listing_price(),
            t.route_set_listing_alert(),
            "25.00",
            !open_offers,
        ),
        (
            Side::Offer,
            t.route_watch_offers(),
            t.route_watch_offers_description(),
            t.route_alert_minimum_offer_price(),
            t.route_set_offer_alert(),
            "15.00",
            open_offers,
        ),
    ];
    html! {
        <p class={Muted}>{t.route_watch_card_description()}</p>
        if let Some(BuyNotice::Watched(alerts)) = notice {
            <div class={(Banner, Added)} role="status">
                <p class={Strong}>{p.item_watch_saved()}</p>
                <p>{p.item_watch_saved_description()}</p>
                <p><a class={Button} href={alerts}>{p.item_manage_alerts()}</a></p>
            </div>
        }
        if let Some(product) = product {
            for (side, title, help, label, set, placeholder, open) in sides {
                <details class={ProductBuy} open={open}>
                    <summary on:click={analytics::workflow(target, "watch", labels(side).0, "", viewer)}>
                        <span class={Strong}>{title}</span>
                        <span class={Muted}>{help}</span>
                    </summary>
                    <form
                        class={Buy}
                        method="post"
                        action={&action}
                        on:submit={analytics::submitted(event, "watch", [labels(side).0, "", labels(side).1, ""], ONE_WAY, "")}
                    >
                        <Hidden pairs={page} />
                        <input type="hidden" name={watching::field::PRODUCT} value={product}>
                        <input type="hidden" name={watching::field::SIDE} value={side.as_str()}>
                        if screen.viewer_account_id.is_none() {
                            <p class={Muted}>{t.route_reference_info_watch_listings_line1()}</p>
                        }
                        if let Some((message, _)) = from(side) {
                            <p
                                class={Error}
                                role="alert"
                                on:connect={analytics::refused("watch", labels(side).0, "", labels(side).1)}
                            >
                                {message}
                            </p>
                        }
                        <div class={OfferFields}>
                            <div class={QuantityField}>
                                <label class={Label} for={&format!("watch-{}-price", side.as_str())}>{label}</label>
                                <input
                                    id={&format!("watch-{}-price", side.as_str())}
                                    type="number"
                                    name={watching::field::THRESHOLD}
                                    min="0"
                                    step="0.01"
                                    inputmode="decimal"
                                    placeholder={placeholder}
                                    value={from(side).map(|(_, i)| i.threshold.as_str())}
                                >
                            </div>
                            <div class={QuantityField}>
                                <label class={Label} for={&format!("watch-{}-currency", side.as_str())}>
                                    {t.route_listing_price_currency_code()}
                                </label>
                                <input
                                    id={&format!("watch-{}-currency", side.as_str())}
                                    type="text"
                                    name={watching::field::CURRENCY}
                                    minlength="3"
                                    maxlength="3"
                                    autocapitalize="characters"
                                    placeholder={t.route_listing_price_currency_code_placeholder()}
                                    value={from(side).map_or(currency, |(_, i)| i.currency.as_str())}
                                >
                            </div>
                        </div>
                        <button type="submit" class={(Button, (side == Side::Listing).then_some(Primary))}>{set}</button>
                    </form>
                </details>
            }
        } else {
            <p class={Muted}>{t.route_product_intent_choose_options_guidance()}</p>
        }
    }
}

/// A buy form's quantity (`NumberField`), a whole number from 1.
#[component(css = ItemDetail)]
fn Quantity<'a>(t: ItemMsg, id: &'a str, value: &'a str) -> impl Render {
    html! {
        <div class={QuantityField}>
            <label class={Label} for={id}>{t.route_quantity()}</label>
            <input id={id} type="number" name={field::QUANTITY} min="1" step="1" inputmode="numeric" required value={value}>
        </div>
    }
}

/// Add to List's dialog's id.
const SAVE_DIALOG: &str = "save-to-list";

/// Add to List (marketplace's `AddToSavedListControl`), above the market's side, for the product
/// chosen. An account's button opens the dialog the page drew (`command="show-modal"`, no
/// script); a guest's posts the product, which goes to registration. After Add Product the page
/// says where the product went, with the list in the account's collection.
#[component(css = ItemDetail)]
fn SaveToList<'a>(
    t: ItemMsg,
    screen: &'a ItemScreen,
    address: &'a Address,
    slug: &'a str,
    notice: Option<&'a BuyNotice>,
) -> impl Render {
    let p = Pilot::default();
    let product = screen.product_id.as_deref().unwrap_or_default();
    let label = saving::product_label(screen);
    let accessible = t.saved_accessible(&label).to_string();
    let action = url::ItemSave { slug }.href();
    let page = address.pairs();
    let refused = match notice {
        Some(BuyNotice::SaveRefused { message, input }) => Some((message.as_str(), input)),
        _ => None,
    };
    let saved = match notice {
        Some(BuyNotice::Saved(saved)) => Some(saved),
        _ => None,
    };
    let guest = matches!(screen.save, SaveState::Guest);
    let opens = matches!(screen.save, SaveState::Forbidden | SaveState::Failed | SaveState::Ready { .. });
    html! {
        if guest {
            <form class={Save} method="post" action={&action}>
                <Hidden pairs={&page} />
                <input type="hidden" name={saving::field::PRODUCT} value={product}>
                if let Some((message, _)) = refused {
                    <p class={Error} role="alert">{message}</p>
                }
                <button type="submit" class={Button} aria-label={&accessible}>{t.saved_button()}</button>
            </form>
        } else if opens {
            <div class={Save}>
                <button type="button" class={Button} command="show-modal" commandfor={SAVE_DIALOG} aria-label={&accessible}>
                    {t.saved_button()}
                </button>
                <SaveDialog
                    t={t}
                    save={&screen.save}
                    label={&label}
                    product={product}
                    page={&page}
                    action={&action}
                    refused={refused}
                />
            </div>
        }
        if let Some(saved) = saved {
            <div class={(Banner, Added)} role="status">
                <p class={Strong}>
                    match &saved.title {
                        Some(title) => { {t.saved_success_title(title)} }
                        None => { {p.item_saved_to_list()} }
                    }
                </p>
                if saved.merged {
                    <p>{t.saved_success_merged(&saved.quantity)}</p>
                } else {
                    <p>{t.saved_success_added(&saved.quantity)}</p>
                }
                <p><a class={Button} href={&saved.collection}>{t.saved_view_collection()}</a></p>
            </div>
        }
    }
}

/// Add to List's dialog (marketplace's sheet): the product, a recent list or a new one (its title
/// shown only while it is chosen, by CSS), and the tracked quantity, with the ids the addition is
/// made with. Drawn `open` when its form came back refused, so it is in front of the buyer
/// without JavaScript; `corten_ui::dialog::modal` makes it modal when it joins the page.
#[component(css = ItemDetail)]
pub fn SaveDialog<'a>(
    t: ItemMsg,
    save: &'a SaveState,
    label: &'a str,
    product: &'a str,
    page: &'a [(String, String)],
    action: &'a str,
    refused: Option<(&'a str, &'a SaveInput)>,
) -> impl Render {
    let title_id = format!("{SAVE_DIALOG}-title");
    let lists = match save {
        SaveState::Ready { lists } => Some(lists.as_slice()),
        _ => None,
    };
    let tokens = refused.map_or_else(saving::Tokens::new, |(_, i)| i.tokens.clone());
    let chosen = refused
        .map(|(_, i)| i.list.clone())
        .unwrap_or_else(|| lists.and_then(|l| l.first()).map_or_else(|| saving::NEW_LIST.to_owned(), |l| l.list_id.clone()));
    let typed_title = refused.map_or("", |(_, i)| i.title.as_str());
    let typed_quantity = refused.map_or("1", |(_, i)| i.quantity.as_str());
    html! {
        <dialog
            class={(RefDialog, SaveSheet)}
            id={SAVE_DIALOG}
            aria-labelledby={&title_id}
            open={refused.is_some()}
            on:connect={corten_ui::dialog::modal(target)}
        >
            <div class={RefHead}>
                <div>
                    <h2 class={CardTitle} id={&title_id}>{t.saved_sheet_title()}</h2>
                    <p class={Muted}>{t.saved_sheet_description()}</p>
                </div>
            </div>
            match save {
                SaveState::Forbidden => {
                    <p class={Error} role="alert">{t.saved_api_account_forbidden()}</p>
                }
                SaveState::Ready { .. } => {
                    <form class={(Buy, SaveForm)} method="post" action={action}>
                        <Hidden pairs={page} />
                        <input type="hidden" name={saving::field::PRODUCT} value={product}>
                        <input type="hidden" name={saving::field::ADD_COMMAND} value={&tokens.add_command}>
                        <input type="hidden" name={saving::field::LINE} value={&tokens.line}>
                        <input type="hidden" name={saving::field::NEW_LIST} value={&tokens.new_list}>
                        <input type="hidden" name={saving::field::NEW_LIST_COMMAND} value={&tokens.new_list_command}>
                        if let Some((message, _)) = refused {
                            <div class={Banner} role="alert">
                                <p class={(Strong, Error)}>{t.saved_error_title()}</p>
                                <p>{message}</p>
                            </div>
                        }
                        <p class={Strong}>{label}</p>
                        if lists.is_some_and(<[_]>::is_empty) {
                            <p class={Muted}>{t.saved_no_lists()}</p>
                        }
                        <fieldset class={SaveLists}>
                            <legend class={Label}>{t.saved_destination_label()}</legend>
                            for list in lists.unwrap_or_default() {
                                <label class={SaveChoice}>
                                    <input
                                        type="radio"
                                        name={saving::field::LIST}
                                        value={&list.list_id}
                                        checked={chosen == list.list_id}
                                    >
                                    <span>
                                        <span class={Strong}>{&list.title}</span>
                                        <span class={Muted}>
                                            {t.saved_list_summary(list.line_count, list.tracked_unit_count)}
                                        </span>
                                    </span>
                                </label>
                            }
                            <label class={SaveChoice}>
                                <input
                                    type="radio"
                                    name={saving::field::LIST}
                                    value={saving::NEW_LIST}
                                    checked={chosen == saving::NEW_LIST}
                                >
                                <span>
                                    <span class={Strong}>{t.saved_create_new()}</span>
                                    <span class={Muted}>{t.saved_create_new_description()}</span>
                                </span>
                            </label>
                        </fieldset>
                        <div class={(QuantityField, SaveTitle)}>
                            <label class={Label} for="save-title">{t.saved_title_label()}</label>
                            <input
                                id="save-title"
                                type="text"
                                name={saving::field::TITLE}
                                maxlength="120"
                                placeholder={t.saved_title_placeholder()}
                                value={typed_title}
                            >
                        </div>
                        <div class={QuantityField}>
                            <label class={Label} for="save-quantity">{t.saved_quantity_label()}</label>
                            <input
                                id="save-quantity"
                                type="number"
                                name={saving::field::QUANTITY}
                                min="1"
                                max="1000000"
                                step="1"
                                inputmode="numeric"
                                required
                                aria-describedby="save-quantity-help"
                                value={typed_quantity}
                            >
                            <p class={Muted} id="save-quantity-help">{t.saved_quantity_description()}</p>
                        </div>
                        <div class={SaveActions}>
                            <button type="button" class={Button} command="close" commandfor={SAVE_DIALOG}>
                                {t.saved_cancel()}
                            </button>
                            <button type="submit" class={(Button, Primary)}>{t.saved_submit()}</button>
                        </div>
                    </form>
                }
                _ => {
                    <div class={Banner} role="alert">
                        <p class={(Strong, Error)}>{t.saved_error_title()}</p>
                        <p>{t.saved_error_description()}</p>
                    </div>
                }
            }
            if !matches!(save, SaveState::Ready { .. }) {
                <div class={SaveActions}>
                    <button type="button" class={Button} command="close" commandfor={SAVE_DIALOG}>{t.saved_cancel()}</button>
                </div>
            }
        </dialog>
    }
}

/// Fields a form posts as they are: the page's address, or a write sent again.
#[component(css = ItemDetail)]
fn Hidden<'a>(pairs: &'a [(String, String)]) -> impl Render {
    html! {
        for (name, value) in pairs {
            <input type="hidden" name={name} value={value}>
        }
    }
}

/// A seller's or buyer's name, its feedback link and rating (`AccountReputationSummary`).
#[component(css = ItemDetail)]
fn Reputation<'a>(t: ItemMsg, name: &'a str, slug: Option<&'a str>, rating: Option<&'a str>, reviews: u64) -> impl Render {
    let rating = rating.and_then(|r| r.parse::<f64>().ok()).filter(|r| r.is_finite());
    let href = slug.map(crate::accounts::feedback);
    html! {
        <span class={Who}>
            match &href {
                Some(href) => { <a class={Strong} href={href}>{name}</a> }
                None => { <span class={Strong}>{name}</span> }
            }
            match rating {
                Some(r) => {
                    <span class={Note}>
                        <span aria-hidden="true">"\u{2605}"</span> " " {format!("{r:.1}")} " " {format!("({reviews})")}
                    </span>
                }
                None => { <span class={Note}>{t.page_no_feedback_yet()}</span> }
            }
        </span>
    }
}

/// The market book (`ItemDetailMarketBook`): the listings, the offers and the details, a tab
/// each, as links. The Sales tab (the market's history) is not ported.
#[component(css = ItemDetail)]
fn MarketBook<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let book = address.book();
    let tab = move |b: Book| url::Item { slug, state: address.with_book(b), after: Default::default() }.href();
    let current = move |b: Book| (book == b).then_some("page");
    let schema = screen.item.product_schema.as_ref();
    let filtered = !screen.picks.is_empty();
    let clear = schema.map(|schema| {
        url::Item {
            slug,
            state: address.with_picks(schema, &Picks::new(), screen.picks.keys().next().map(String::as_str)),
            after: Default::default(),
        }
        .href()
    });
    html! {
        <section class={BookSection} id="market-book-section" aria-labelledby="market-book">
            <h2 class={CardTitle} id="market-book">{t.page_market_book()}</h2>
            <nav class={Tabs} aria-label={t.page_market_book()}>
                <a class={Tab} href={&tab(Book::Listings)} aria-current={current(Book::Listings)}>{t.page_listings_2()}</a>
                <a class={Tab} href={&tab(Book::Offers)} aria-current={current(Book::Offers)}>{t.page_offers_2()}</a>
                <a class={Tab} href={&tab(Book::Sales)} aria-current={current(Book::Sales)}>{t.page_sales()}</a>
                <a class={Tab} href={&tab(Book::Details)} aria-current={current(Book::Details)}>{t.page_details()}</a>
            </nav>
            match book {
                Book::Listings => {
                    <Listings t={t} screen={screen} address={address} slug={slug} clear={clear.as_deref().filter(|_| filtered)} />
                }
                Book::Offers => {
                    <Offers t={t} screen={screen} address={address} slug={slug} clear={clear.as_deref().filter(|_| filtered)} />
                }
                Book::Sales => { <Sales t={t} screen={screen} address={address} slug={slug} /> }
                Book::Details => { <Details t={t} item={&screen.item} /> }
            }
        </section>
    }
}

/// The listings that match the options, the lowest marked, each with a Select link.
#[component(css = ItemDetail)]
fn Listings<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str, clear: Option<&'a str>) -> impl Render {
    let label = |n: usize| if n == 1 { t.page_listing_singular() } else { t.page_listing_plural() };
    let count = if clear.is_some() {
        t.page_filtered_listing_count(screen.listings.len(), screen.all_listings, label(screen.all_listings)).to_string()
    } else {
        t.page_active_listing_count(screen.listings.len(), label(screen.listings.len())).to_string()
    };
    let lowest = screen
        .listings
        .iter()
        .filter_map(|l| Some((platform::money::cents(&l.price_amount)?, l.price_currency_code.as_deref()?)))
        .min();
    let lowest_in = |l: &Listing| {
        let Some(currency) = l.price_currency_code.as_deref() else { return false };
        let low = screen
            .listings
            .iter()
            .filter(|o| o.price_currency_code.as_deref() == Some(currency))
            .filter_map(|o| platform::money::cents(&o.price_amount))
            .min();
        low.is_some() && low == platform::money::cents(&l.price_amount)
    };
    let _ = lowest;
    html! {
        <div class={Panel}>
            <p class={Count}>
                <span class={Muted}>{&count}</span>
                if let Some(clear) = clear {
                    " " <a href={clear}>{t.page_clear_filters()}</a>
                }
            </p>
            if screen.listings.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.page_no_active_listings()}</p>
                    <p class={Muted}>
                        {if screen.all_listings > 0 { t.page_no_active_listings_match_these_filters() } else { t.page_sellers_have_not_published_inventory_for() }}
                    </p>
                    <p><a href={SelectOptionsId.fragment()}>{t.page_choose_options_2()}</a></p>
                </div>
            } else {
                <ul class={Rows}>
                    for l in &screen.listings {
                        <Row
                            t={t}
                            price={&listing_price(t, l)}
                            badge={lowest_in(l).then(|| t.page_lowest_price())}
                            mine={None}
                            who={html! { <Reputation t={t} name={l.seller_display_name.as_deref().unwrap_or(t.page_seller())} slug={l.seller_slug.as_deref()} rating={l.seller_average_rating.as_deref()} reviews={l.seller_review_count} /> }}
                            product={&compact(l.product_summary.as_deref(), &screen.describe(&l.selected_options), t.page_standard())}
                            quantity={&t.page_listing_available_count(available(l)).to_string()}
                            limit={purchase_limit(l)}
                            selected={screen.listing_id.as_deref() == Some(l.listing_id.as_str())}
                            select={&url::Item { slug, state: address.with_listing(&l.listing_id), after: Default::default() }.href()}
                            label={&t.page_listing_row_label(&listing_price(t, l), l.seller_display_name.as_deref().unwrap_or(t.page_seller())).to_string()}
                        />
                    }
                </ul>
            }
        </div>
    }
}

/// The offers that match the options, the best marked, the viewer's own said so.
#[component(css = ItemDetail)]
fn Offers<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str, clear: Option<&'a str>) -> impl Render {
    let label = if screen.offers.len() == 1 { t.page_offer_singular() } else { t.page_offer_plural() };
    let best_in = |o: &Offer| {
        let Some(currency) = o.price_currency_code.as_deref() else { return false };
        let high = screen
            .offers
            .iter()
            .filter(|x| x.price_currency_code.as_deref() == Some(currency))
            .filter_map(|x| platform::money::cents(&x.price_amount))
            .max();
        high.is_some() && high == platform::money::cents(&o.price_amount)
    };
    html! {
        <div class={Panel}>
            <p class={Count}>
                <span class={Muted}>{t.page_matching_offer_count(screen.offers.len(), label)}</span>
                if let Some(clear) = clear {
                    " " <a href={clear}>{t.page_clear_filters_3()}</a>
                }
            </p>
            if screen.offers.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.page_no_matching_offers()}</p>
                    <p class={Muted}>
                        {if screen.all_offers > 0 { t.page_no_offers_match_these_filters() } else { t.page_buyers_have_not_placed_offers_for() }}
                    </p>
                </div>
            } else {
                <ul class={Rows}>
                    for o in &screen.offers {
                        <Row
                            t={t}
                            price={&offer_price(t, o)}
                            badge={best_in(o).then(|| t.page_best_offer())}
                            mine={(screen.viewer_account_id.as_deref() == Some(o.buyer_account_id.as_str())).then(|| (t.page_your_offer(), t.page_own_offer_visibility()))}
                            who={html! { <Reputation t={t} name={o.buyer_display_name.as_deref().unwrap_or(&o.buyer_account_id)} slug={o.buyer_slug.as_deref()} rating={o.buyer_average_rating.as_deref()} reviews={o.buyer_review_count} /> }}
                            product={&compact(o.product_summary.as_deref(), &screen.describe(&o.selected_options), t.page_standard_2())}
                            quantity={&t.page_offer_requested_count(o.quantity_requested).to_string()}
                            limit={None}
                            selected={screen.offer_id.as_deref() == Some(o.offer_id.as_str())}
                            select={&url::Item { slug, state: address.with_offer(&o.offer_id), after: Default::default() }.href()}
                            label={&t.page_offer_row_label(&offer_price(t, o), o.buyer_display_name.as_deref().unwrap_or(&o.buyer_account_id)).to_string()}
                        />
                    }
                </ul>
            }
        </div>
    }
}

/// A listing or an offer (`ComparisonListRow`): price, who, product and quantity, Select.
#[component(css = ItemDetail)]
fn Row<'a, W: Render>(
    t: ItemMsg,
    price: &'a str,
    badge: Option<&'a str>,
    mine: Option<(&'a str, &'a str)>,
    who: W,
    product: &'a str,
    quantity: &'a str,
    limit: Option<String>,
    selected: bool,
    select: &'a str,
    label: &'a str,
) -> impl Render {
    html! {
        <li class={(RowItem, selected.then_some(Chosen))} aria-label={label}>
            <p class={Cell}>
                <span class={Price}>{price}</span>
                if let Some(badge) = badge {
                    " " <span class={(Pill, Good)}>{badge}</span>
                }
                if let Some((mine, _)) = mine {
                    " " <span class={(Pill, Accent)}>{mine}</span>
                }
            </p>
            <div class={Cell}>
                {who}
                if let Some((_, note)) = mine {
                    <p class={Note}>{note}</p>
                }
            </div>
            <p class={Cell}>
                <span>{product}</span>
                <span class={Note}>{quantity}</span>
                if let Some(limit) = &limit {
                    <span class={(Pill, Plain)}>{limit}</span>
                }
            </p>
            <p class={Cell}>
                <a class={(SelectLink, selected.then_some(On))} href={select} aria-current={selected.then_some("true")}>
                    {if selected { t.page_selected() } else { t.page_select() }}
                </a>
            </p>
        </li>
    }
}

/// The item's description and details: its fields, the records they relate to, its language,
/// categories, tags and when it changed.
#[component(css = ItemDetail)]
fn Details<'a>(t: ItemMsg, item: &'a Item) -> impl Render {
    let rows = detail_rows(&item.field_values);
    let categories: Vec<&str> = {
        let mut seen = std::collections::BTreeSet::new();
        item.categories.iter().filter(|c| seen.insert(c.category_id.as_str())).map(|c| c.name.as_str()).collect()
    };
    let tags: Vec<&str> = {
        let mut seen = std::collections::BTreeSet::new();
        item.tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty() && seen.insert(*t)).collect()
    };
    let updated = corten::i18n::parse_timestamp(&item.updated_at)
        .map(|at| t.date_time(at, corten::i18n::DateStyle::Medium, corten::i18n::TimeStyle::Short).to_string())
        .unwrap_or_else(|| item.updated_at.clone());
    html! {
        <div class={Panel}>
            if let Some(description) = item.description.as_deref().filter(|d| !d.is_empty()) {
                <h3 class={Label}>{t.page_description()}</h3>
                <p>{description}</p>
            }
            <dl class={Pairs}>
                for (label, value, reference) in &rows {
                    <div>
                        <dt>{label}</dt>
                        match reference {
                            Some(r) => {
                                <dd>
                                    <button
                                        type="button"
                                        class={RefTrigger}
                                        command="show-modal"
                                        commandfor={&reference_dialog_id(r)}
                                        aria-haspopup="dialog"
                                        aria-label={&t.page_reference_value_aria(label, value).to_string()}
                                    >
                                        {value}
                                    </button>
                                </dd>
                            }
                            None => { <dd>{value}</dd> }
                        }
                    </div>
                }
                <div>
                    <dt>{t.page_language()}</dt>
                    <dd>{language(t, item.language_code.as_deref().unwrap_or(""))}</dd>
                </div>
                if !categories.is_empty() {
                    <div>
                        <dt>{t.page_categories()}</dt>
                        <dd>{categories.join(", ")}</dd>
                    </div>
                }
                if !tags.is_empty() {
                    <div>
                        <dt>{t.page_tags()}</dt>
                        <dd><ul class={Tags}>for tag in &tags { <li class={(Pill, Plain)}>{*tag}</li> }</ul></dd>
                    </div>
                }
                <div>
                    <dt>{t.page_last_updated()}</dt>
                    <dd>{&updated}</dd>
                </div>
            </dl>
            <RefDialogs t={t} item={item} />
        </div>
    }
}

/// The Details tab's reference dialogs, one for each record its rows name, beside their
/// triggers in the market book. A change to the item draws the book again, and Corten keeps a
/// dialog the buyer opened open, and modal, through it.
#[component(css = ItemDetail)]
fn RefDialogs<'a>(t: ItemMsg, item: &'a Item) -> impl Render {
    let rows = detail_rows(&item.field_values);
    // Each record's dialog once, in the order its rows name it.
    let references: Vec<&Reference> = {
        let mut seen = std::collections::BTreeSet::new();
        rows.iter().filter_map(|(_, _, r)| *r).filter(|r| seen.insert(r.reference_id.as_str())).collect()
    };
    html! {
        for reference in &references {
            <RefDialog t={t} reference={*reference} />
        }
    }
}

/// A reference record's dialog's id: one for each record, however many rows name it.
fn reference_dialog_id(reference: &Reference) -> String {
    format!("reference-{}", reference.reference_id)
}

/// Marketplace's `ReferenceDetailDialog`: the record's type, status and key, its attributes and
/// what it relates to. A native `<dialog>` the row's button opens (`command="show-modal"`), so
/// it needs no script; Escape and its close button close it.
#[component(css = ItemDetail)]
fn RefDialog<'a>(t: ItemMsg, reference: &'a Reference) -> impl Render {
    let id = reference_dialog_id(reference);
    let title = format!("{id}-title");
    let kind = type_label(&reference.type_key);
    let attributes: Vec<(&str, String)> = reference.attributes.0.iter().map(|(k, v)| (k.as_str(), field_text(v))).collect();
    let relationships: Vec<(String, &str)> = reference
        .relationships
        .iter()
        .map(|r| {
            let name = r.reference.as_ref().map_or(r.reference_id.as_str(), |related| related.name.as_str());
            (relationship_label(&r.relationship_type), name)
        })
        .collect();
    html! {
        <dialog class={RefDialog} id={&id} aria-labelledby={&title}>
            <div class={RefHead}>
                <div>
                    <h2 class={CardTitle} id={&title}>{&reference.name}</h2>
                    <p class={Muted}>{&kind}</p>
                </div>
                <button type="button" class={(Button, RefClose)} command="close" commandfor={&id}>
                    {t.page_close_reference_detail()}
                </button>
            </div>
            <dl class={Pairs}>
                <div>
                    <dt>{t.page_reference_type()}</dt>
                    <dd>{&kind}</dd>
                </div>
                <div>
                    <dt>{t.page_reference_status()}</dt>
                    <dd>{&reference.status}</dd>
                </div>
                <div>
                    <dt>{t.page_reference_key()}</dt>
                    <dd>{&reference.key}</dd>
                </div>
            </dl>
            <h3 class={Label}>{t.page_reference_attributes()}</h3>
            if attributes.is_empty() {
                <p class={Muted}>{t.page_reference_no_attributes()}</p>
            } else {
                <dl class={Pairs}>
                    for (key, value) in &attributes {
                        <div>
                            <dt>{*key}</dt>
                            <dd>{value}</dd>
                        </div>
                    }
                </dl>
            }
            <h3 class={Label}>{t.page_reference_relationships()}</h3>
            if relationships.is_empty() {
                <p class={Muted}>{t.page_reference_no_relationships()}</p>
            } else {
                <dl class={Pairs}>
                    for (kind, name) in &relationships {
                        <div>
                            <dt>{kind}</dt>
                            <dd>{*name}</dd>
                        </div>
                    }
                </dl>
            }
        </dialog>
    }
}

/// A relationship's type as words (`formatRelationshipType`): `part-of` is "Part Of".
fn relationship_label(kind: &str) -> String {
    kind.split(['-', '_']).filter(|p| !p.is_empty()).map(capitalize).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::{compact, percent_of};

    #[test]
    fn a_percent_of_basis_points_has_at_most_two_decimals() {
        let percent = |bps| percent_of(bps).to_string();
        assert_eq!(
            (percent(500), percent(450), percent(1234), percent(0)),
            ("5".into(), "4.5".into(), "12.34".into(), "0".into())
        );
    }

    #[test]
    fn a_product_in_a_few_words_is_its_options_or_its_summary() {
        assert_eq!(
            compact(Some("Form: raw | Condition: near-mint"), &[("Form", "Raw"), ("Condition", "Near Mint")], "Standard"),
            "Raw \u{b7} Near Mint"
        );
        assert_eq!(compact(Some("Raw / NM"), &[], "Standard"), "Raw \u{b7} NM");
        assert_eq!(compact(None, &[], "Standard"), "Standard");
    }
}
