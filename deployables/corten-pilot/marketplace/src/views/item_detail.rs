//! The item page's parts, after marketplace's: the layout (`MarketplaceProductDetailLayout`), the
//! summary and the picture, the product selector (`ProductSelector`), the market summary
//! (`MarketplaceMarketSummary`), the rail with the listing or offer chosen, and the market book
//! (`ItemDetailMarketBook`). Every choice is a link to the same page with the choice in its
//! address (`items::Address`); a dimension with more than five options is a GET form.
use corten::prelude::*;
use serde_json::{Value, json};

use super::marketplace;
use crate::{
    api::{FieldValue, Item, Listing, Offer, Reference},
    app::url,
    items::{
        Address, Book, ItemScreen, Market, OptionMarket, Picks, active_dimensions, available, normalize, option_label,
        ordered_options,
    },
    text::{ItemMsg, Pilot},
};

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

/// A path on marketplace's origin, absolute (the item's pictures are on it).
fn on_marketplace(path: &str) -> String {
    if path.starts_with('/') { marketplace(path).map(|u| u.to_string()).unwrap_or_default() } else { path.to_owned() }
}

/// The item's picture.
pub struct Image {
    pub src: String,
    pub srcset: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
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
fn purchase_limit(l: &Listing) -> Option<String> {
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
fn detail_rows(fields: &[FieldValue]) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = fields
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
            (label, f.reference.as_ref().map_or_else(|| field_text(&f.value), |r| r.name.clone()))
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
        rows: &mut Vec<(String, String)>,
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
                rows.push((label, related.name.clone()));
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
pub fn item_page<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render + 'a {
    html! { <ItemDetail t={t} screen={screen} address={address} slug={slug} /> }
}

/// The page: breadcrumbs; the summary, the picture, the options and the market; the rail with
/// the listing or offer chosen; and the market book. Stacked on a phone; the picture beside the
/// rest from 48rem.
#[component(css)]
pub fn ItemDetail<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let item = &screen.item;
    let category = item.categories.first();
    let image = item_image(item);
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
                <Intent t={t} screen={screen} address={address} slug={slug} />
                <Selector t={t} screen={screen} address={address} slug={slug} />
                <MarketSummary t={t} screen={screen} />
                <Rail t={t} screen={screen} address={address} slug={slug} />
            </div>
            <div class={Below}>
                <MarketBook t={t} screen={screen} address={address} slug={slug} />
            </div>
        </div>
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

/// Buy, Sell or Watch (`SegmentedControl` "Choose market intent"). Watching is a product alert,
/// which the pilot has not ported, so Watch is marketplace's page.
#[component(css = ItemDetail)]
fn Intent<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let link = move |market: Market| url::Item { slug, state: address.with_market(market) }.href();
    let watch = on_marketplace(&url::Item { slug, state: address.with_market(Market::Watch) }.href());
    let current = move |market: Market| (screen.market == market).then_some("true");
    html! {
        <nav class={Segmented} aria-label={t.page_choose_market_intent()}>
            <a class={Segment} href={&link(Market::Buy)} aria-current={current(Market::Buy)}>{t.page_buy()}</a>
            <a class={Segment} href={&link(Market::Sell)} aria-current={current(Market::Sell)}>{t.page_sell()}</a>
            <a class={Segment} href={&watch}>{t.page_watch()}</a>
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
            <section class={Card} id="select-options" aria-labelledby="choose-options">
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
        url::Item { slug, state: address.with_picks(schema, &next, option.is_none().then_some(id)) }.href()
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
        <section class={Card} aria-labelledby="market-price">
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

/// What the buyer would act on: the listing chosen (or the best available one), or when selling
/// the offer chosen (or the best one). Buying, offering and selling are marketplace's page until
/// the pilot ports them.
#[component(css = ItemDetail)]
fn Rail<'a>(t: ItemMsg, screen: &'a ItemScreen, address: &'a Address, slug: &'a str) -> impl Render {
    let p = Pilot::default();
    let sell = screen.market == Market::Sell;
    let listing = (!sell).then(|| screen.selected_listing()).flatten();
    let offer = sell.then(|| screen.selected_offer()).flatten();
    let title = match (listing, offer) {
        (Some(_), _) if screen.listing_explicit => t.page_selected_listing(),
        (Some(_), _) => t.route_best_available_listing(),
        (_, Some(_)) if screen.offer_explicit => t.route_selected_offer_heading(),
        (_, Some(_)) => t.route_best_offer_heading(),
        _ => t.route_selected_product(),
    };
    let continue_on = on_marketplace(&url::Item { slug, state: address.clone() }.href());
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
            <p><a class={Action} href={&continue_on}>{p.item_continue_on_marketplace()}</a></p>
        </section>
    }
}

/// A seller's or buyer's name, its feedback link and rating (`AccountReputationSummary`).
#[component(css = ItemDetail)]
fn Reputation<'a>(t: ItemMsg, name: &'a str, slug: Option<&'a str>, rating: Option<&'a str>, reviews: u64) -> impl Render {
    let rating = rating.and_then(|r| r.parse::<f64>().ok()).filter(|r| r.is_finite());
    let href = slug.map(|s| on_marketplace(&format!("/accounts/{s}#feedback")));
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
    let tab = move |b: Book| url::Item { slug, state: address.with_book(b) }.href();
    let current = move |b: Book| (book == b).then_some("page");
    let schema = screen.item.product_schema.as_ref();
    let filtered = !screen.picks.is_empty();
    let clear = schema.map(|schema| {
        url::Item { slug, state: address.with_picks(schema, &Picks::new(), screen.picks.keys().next().map(String::as_str)) }
            .href()
    });
    html! {
        <section class={BookSection} aria-labelledby="market-book">
            <h2 class={CardTitle} id="market-book">{t.page_market_book()}</h2>
            <nav class={Tabs} aria-label={t.page_market_book()}>
                <a class={Tab} href={&tab(Book::Listings)} aria-current={current(Book::Listings)}>{t.page_listings_2()}</a>
                <a class={Tab} href={&tab(Book::Offers)} aria-current={current(Book::Offers)}>{t.page_offers_2()}</a>
                <a class={Tab} href={&tab(Book::Details)} aria-current={current(Book::Details)}>{t.page_details()}</a>
            </nav>
            match book {
                Book::Listings => {
                    <Listings t={t} screen={screen} address={address} slug={slug} clear={clear.as_deref().filter(|_| filtered)} />
                }
                Book::Offers => {
                    <Offers t={t} screen={screen} address={address} slug={slug} clear={clear.as_deref().filter(|_| filtered)} />
                }
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
                    <p><a href="#select-options">{t.page_choose_options_2()}</a></p>
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
                            select={&url::Item { slug, state: address.with_listing(&l.listing_id) }.href()}
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
                            select={&url::Item { slug, state: address.with_offer(&o.offer_id) }.href()}
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
                for (label, value) in &rows {
                    <div>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
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
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::compact;

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
