//! The search page, after marketplace's `SearchPage`: the landing's hero or the control bar (the
//! words, the sort, the applied filters as chips), the filters, and the results as cards. The
//! filters are one GET form: a rail beside the results from 64rem, and below that a dialog the
//! Filters button opens. The words box and the sort are in the form by its id, so changing any
//! of them sends every choice.
use corten::prelude::*;

use super::{
    item_detail::{analytics, similar_image},
    on_marketplace,
};
use crate::{
    api::{Facet, SearchCategory, SearchItem, SearchResults},
    app::url,
    items::{Address, Market},
    search::{
        Activity, CURSOR, Filter, HomeShelf, Kind, MOST_SHOWN, PAGE_SIZE, Place, SearchScreen, Terms, TermsQuery, category_href,
    },
    text::{Pilot, SearchMsg},
};

corten::script::script!(pub mod handlers = "search.js");

/// The form every choice is in.
#[derive(Id)]
pub struct SearchFormId;

/// The filters: the rail, or the dialog on a phone.
#[derive(Id)]
pub struct SearchFiltersId;

#[derive(Id)]
pub struct FiltersTitleId;

/// A result, so Load more without JavaScript can bring the browser to the first one it adds.
#[derive(Id)]
pub struct ResultId<'a>(pub &'a str);

/// The results' list, which Load more adds rows to.
#[derive(Id)]
pub struct ResultsId;

/// Load more's form, which each page it loads replaces.
#[derive(Id)]
pub struct LoadMoreId;

/// Results the landing shows a priority picture for (`PRIORITY_SEARCH_RESULT_IMAGE_COUNT`).
const PRIORITY_IMAGES: usize = 3;
/// Categories the landing offers as chips (`featuredCategories`).
const FEATURED: usize = 5;
/// The one word the landing's headline treats in gold (`HERO_FOIL_WORD`).
const FOIL_WORD: &str = "chasing";
/// A price filter's value (`readPriceFilter`), which the browser checks before sending it.
const PRICE_PATTERN: &str = r"(0|[1-9][0-9]*)(\.[0-9]{1,2})?";
/// Marketplace's saved-search settings (`productAlertSettingsHref`).
const SAVED_SEARCH: &str = "/search?notifications=settings&notificationSection=product-alerts";

/// A failed read's results: none. A page with no read shows the filters, an error banner and a
/// 502, as marketplace's does since chase-sets/chase-sets#10610.
static NO_RESULTS: SearchResults = SearchResults {
    items: Vec::new(),
    facets: Vec::new(),
    category_counts: Vec::new(),
    total: None,
    next_cursor: None,
    retrieval_mode: None,
    lexical_count: None,
    interpretation: None,
    cursor_restarted: false,
    query_hash: None,
    result_set_key: None,
};

/// The sorts the page offers, by value.
fn sorts(t: SearchMsg) -> [(&'static str, &'static str); 6] {
    [
        ("relevance", t.page_relevance()),
        ("title_asc", t.page_title_a_z()),
        ("title_desc", t.page_title_z_a()),
        ("newest", t.page_newest()),
        ("price_asc", t.page_price_low_to_high()),
        ("price_desc", t.page_price_high_to_low()),
    ]
}

fn languages(t: SearchMsg) -> [(&'static str, &'static str); 2] {
    [("en", t.page_english()), ("ja", t.page_japanese())]
}

fn activities(t: SearchMsg) -> [(Activity, &'static str); 3] {
    [
        (Activity::ListingsOrOffers, t.page_listings_or_offers()),
        (Activity::Listings, t.page_listings()),
        (Activity::Offers, t.page_offers()),
    ]
}

/// An amount in dollars as money (`formatMoney`), or as it is.
fn money(t: SearchMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), corten::i18n::Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

/// A language code's name (`formatLanguageCodeLabel`).
fn language(t: SearchMsg, code: &str) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => t.language_en().to_owned(),
        "ja" => t.language_ja().to_owned(),
        _ => code.trim().to_owned(),
    }
}

/// A dynamic filter's chip (`dynamicFilterLabel`): the facet's and the value's labels, else their ids.
fn filter_label(t: SearchMsg, facets: &[Facet], filter: &Filter) -> String {
    let facet = facets.iter().find(|f| Kind::read(&f.kind) == Some(filter.kind) && f.id == filter.id);
    match facet.and_then(|f| f.values.iter().find(|v| v.id == filter.value).map(|v| (f, v))) {
        Some((facet, value)) => t.page_dynamic_filter_label(&facet.label, &value.label).to_string(),
        None => t.page_dynamic_filter_label(&filter.id, &filter.value).to_string(),
    }
}

/// An applied filter: its words and the address without it.
struct Chip {
    label: String,
    href: String,
}

fn chips(t: SearchMsg, screen: &SearchScreen, facets: &[Facet]) -> Vec<Chip> {
    let terms = &screen.terms;
    let place = screen.place();
    let without = |edit: &dyn Fn(&mut Terms)| place.href(&terms.change(|next| edit(next)));
    let mut chips = Vec::new();
    if !terms.q.trim().is_empty() {
        chips.push(Chip { label: t.page_search_filter_label(&terms.q).to_string(), href: without(&|n| n.q.clear()) });
    }
    if !screen.category.is_empty() {
        let href = category_href("", &terms.change(|_| {}));
        chips.push(Chip { label: t.page_category_filter_label(screen.category_label(t)).to_string(), href });
    }
    if !terms.language.is_empty() {
        let label = language(t, &terms.language);
        chips.push(Chip { label: t.page_language_filter_label(&label).to_string(), href: without(&|n| n.language.clear()) });
    }
    if terms.activity != Activity::Any {
        let label = activities(t).iter().find(|(a, _)| *a == terms.activity).map_or("", |(_, l)| l);
        chips.push(Chip {
            label: t.page_market_activity_filter_label(label).to_string(),
            href: without(&|n| n.activity = Activity::Any),
        });
    }
    if !terms.price_min.is_empty() {
        let price = money(t, &terms.price_min, "USD");
        chips
            .push(Chip { label: t.page_minimum_price_filter_label(&price).to_string(), href: without(&|n| n.price_min.clear()) });
    }
    if !terms.price_max.is_empty() {
        let price = money(t, &terms.price_max, "USD");
        chips
            .push(Chip { label: t.page_maximum_price_filter_label(&price).to_string(), href: without(&|n| n.price_max.clear()) });
    }
    if terms.in_stock {
        chips.push(Chip { label: t.page_in_stock().to_owned(), href: without(&|n| n.in_stock = false) });
    }
    if !terms.tag.is_empty() {
        chips.push(Chip { label: t.page_tag_filter_label(&terms.tag).to_string(), href: without(&|n| n.tag.clear()) });
    }
    if terms.sort != crate::search::RELEVANCE {
        let label = sorts(t).iter().find(|(v, _)| *v == terms.sort).map_or(terms.sort.as_str(), |(_, l)| l).to_owned();
        chips.push(Chip {
            label: t.page_sort_filter_label(&label).to_string(),
            href: without(&|n| n.sort = crate::search::RELEVANCE.to_owned()),
        });
    }
    for filter in &terms.filters {
        let href = without(&|n| n.filters.retain(|f| f != filter));
        chips.push(Chip { label: filter_label(t, facets, filter), href });
    }
    chips
}

/// The page.
#[component(css)]
pub fn SearchPage<'a>(t: SearchMsg, p: Pilot, screen: &'a SearchScreen, failed: bool) -> impl Render {
    let terms = &screen.terms;
    let focused = terms.focused(&screen.category);
    let results = screen.results.as_ref().unwrap_or(&NO_RESULTS);
    let facets = results.facets.as_slice();
    let category = screen.category_label(t);
    let total = results.total.unwrap_or(results.items.len() as u64);
    let summary = (!failed).then(|| {
        if results.items.len() as u64 != total {
            t.page_results_summary_showing(results.items.len(), total, category).to_string()
        } else {
            t.page_results_summary(total, category).to_string()
        }
    });
    let heading = if !terms.q.trim().is_empty() {
        t.page_results_heading_search(terms.q.trim()).to_string()
    } else if !screen.category.is_empty() {
        t.page_results_heading_category(category).to_string()
    } else {
        t.page_results_heading().to_owned()
    };
    let chips = chips(t, screen, facets);
    let marked: Vec<String> = {
        let marked: Vec<&str> = terms.marked().collect();
        let mut labels: Vec<String> =
            terms.filters.iter().filter(|f| marked.contains(&f.key().as_str())).map(|f| filter_label(t, facets, f)).collect();
        if !terms.language.is_empty() && marked.contains(&"language") {
            labels.push(language(t, &terms.language));
        }
        labels
    };
    let form = SearchFormId;
    let f = TermsQuery::FIELDS;
    html! {
        <div class={Page} on:change={handlers::apply(event)}>
            if focused {
                <h1 class={VisuallyHidden}>{&heading}</h1>
                <div class={Controls}>
                    <WordsBox t={t} terms={terms} placeholder={t.page_search_catalog_items()} />
                    <label class={Sort}>
                        <span class={VisuallyHidden}>{t.page_sort()}</span>
                        <select name={f.sort} form={form}>
                            for (value, label) in sorts(t) {
                                <option value={value} selected={terms.sort == value}>{label}</option>
                            }
                        </select>
                    </label>
                    <a class={Secondary} href={&url::Search { terms: Terms::default() }.href()}>{t.page_clear_all_filters()}</a>
                </div>
                if !chips.is_empty() {
                    <ul class={Chips} aria-label={t.page_filters()}>
                        for chip in &chips {
                            <li>
                                <a class={Chip} href={&chip.href} aria-label={&t.page_remove_filter(&chip.label).to_string()}>
                                    {&chip.label}<span class={Remove} aria-hidden="true">"×"</span>
                                </a>
                            </li>
                        }
                    </ul>
                }
                <div class={FilterBar}>
                    <button type="button" class={Secondary} commandfor={SearchFiltersId} command="show-modal">
                        {t.page_filters()}
                        if !chips.is_empty() {
                            <span class={Count}>{t.page_active_filter_count(chips.len())}</span>
                        }
                    </button>
                    if let Some(summary) = &summary {
                        <p class={Summary}>{summary}</p>
                    }
                </div>
                if let Some(summary) = &summary {
                    <p class={SummaryWide}>{summary}</p>
                }
            } else {
                <Hero t={t} screen={screen} summary={summary.as_deref()} />
            }
            <div class={Body}>
                <Filters t={t} screen={screen} facets={facets} summary={summary.as_deref()} />
                <section class={Results} aria-labelledby={screen.shelf.is_none().then_some("search-results-heading")}>
                    if failed {
                        <div class={Banner} data-tone="danger" role="alert">
                            <p class={BannerTitle}>{t.page_error()}</p>
                            <p>{t.page_results_error_description()}</p>
                        </div>
                    }
                    if !marked.is_empty() {
                        <div class={Banner} data-tone="info">
                            <p class={BannerTitle}>{t.page_interpretation_applied(&marked.join(", "))}</p>
                            <button type="button" class={Secondary} on:click={handlers::dismiss(target)}>
                                {t.page_interpretation_dismiss()}
                            </button>
                        </div>
                    }
                    if let Some(shelf) = &screen.shelf {
                        <Shelf t={t} shelf={shelf} />
                    } else if !failed && results.items.is_empty() {
                        <NoResults t={t} screen={screen} />
                    } else if !failed {
                        <Found t={t} screen={screen} results={results} />
                    }
                </section>
            </div>
        </div>
    }
}

/// The words box: in the form by its id, so Enter sends every choice.
#[component(css = SearchPage)]
fn WordsBox<'a>(t: SearchMsg, terms: &'a Terms, placeholder: &'a str) -> impl Render {
    let f = TermsQuery::FIELDS;
    html! {
        <search class={Words}>
            <label>
                <span class={VisuallyHidden}>{t.page_marketplace_search()}</span>
                <input
                    type="search"
                    name={f.q}
                    form={SearchFormId}
                    value={&terms.q}
                    placeholder={placeholder}
                    enterkeyhint="search"
                >
            </label>
            <button type="submit" form={SearchFormId} class={Primary}>{t.page_marketplace_search()}</button>
        </search>
    }
}

/// The landing (no words, category or filter): the headline, the words box, the featured
/// categories and the promise.
#[component(css = SearchPage)]
fn Hero<'a>(t: SearchMsg, screen: &'a SearchScreen, summary: Option<&'a str>) -> impl Render {
    let headline = t.page_find_cards_comics_figures_sneakers_and();
    let (before, after) = match headline.match_indices(FOIL_WORD).count() {
        1 => headline.split_once(FOIL_WORD).unwrap_or((headline, "")),
        _ => (headline, ""),
    };
    let foil = headline.match_indices(FOIL_WORD).count() == 1;
    let terms = &screen.terms;
    html! {
        <div class={Hero}>
            <p class={Badges}>
                <span class={Badge} data-tone="accent">{t.page_marketplace()}</span>
                <span class={Badge} data-tone="success">{t.page_verified_supply()}</span>
            </p>
            <h1 class={Headline}>
                {before}
                if foil { <span class={Foil}>{FOIL_WORD}</span> }
                {after}
            </h1>
            <p class={Lead}>{t.page_search_live_supply_compare_active_markets()}</p>
            <WordsBox t={t} terms={terms} placeholder={t.page_search_pikachu_spider_man_jordan_vintage()} />
            <ul class={Chips}>
                <li>
                    <a class={Chip} href={&category_href("", terms)} aria-current={screen.category.is_empty().then_some("true")}>
                        {t.page_all()}
                    </a>
                </li>
                for category in screen.categories.iter().take(FEATURED) {
                    <li><a class={Chip} href={&category_href(&category.slug, terms)}>{&category.name}</a></li>
                }
            </ul>
            if let Some(summary) = summary {
                <p class={Summary}>{summary}</p>
            }
            <div class={Promo}>
                <p class={BannerTitle}>{t.page_buyer_confidence_is_built_into_discovery()}</p>
                <p>{t.page_verified_supply_transparent_pricing_and_item()}</p>
            </div>
        </div>
    }
}

/// The filters: the categories (links, each its own path), then price and availability,
/// language, market activity and the results' own facets, in the one form.
#[component(css = SearchPage)]
fn Filters<'a>(t: SearchMsg, screen: &'a SearchScreen, facets: &'a [Facet], summary: Option<&'a str>) -> impl Render {
    let terms = &screen.terms;
    let counts = |slug: &str| {
        screen.results.as_ref().and_then(|r| r.category_counts.iter().find(|c| c.slug == slug)).map_or(0, |c| c.count)
    };
    let action = screen.place().href(&Terms::default());
    let price_summary = [
        (!terms.price_min.is_empty()).then(|| format!("{}: {}", t.page_minimum_price(), money(t, &terms.price_min, "USD"))),
        (!terms.price_max.is_empty()).then(|| format!("{}: {}", t.page_maximum_price(), money(t, &terms.price_max, "USD"))),
        terms.in_stock.then(|| t.page_in_stock().to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    let f = TermsQuery::FIELDS;
    html! {
        <dialog id={SearchFiltersId} class={Filters} aria-labelledby={FiltersTitleId}>
            <form
                id={SearchFormId}
                class={FilterForm}
                method="get"
                action={&action}
                data-keep-place
                on:formdata={handlers::tidy(event)}
            >
                <div class={FiltersHead}>
                    <h2 id={FiltersTitleId} class={FiltersTitle}>{t.page_filters()}</h2>
                    <p class={Muted}>{t.page_mobile_filters_description()}</p>
                    if let Some(summary) = summary {
                        <p class={Muted}>{summary}</p>
                    }
                    <button type="button" class={Close} commandfor={SearchFiltersId} command="close">
                        {t.page_close_filters()}
                    </button>
                </div>
                if !terms.tag.is_empty() {
                    <input type="hidden" name={f.tag} value={&terms.tag}>
                }
                <details class={Facet} open>
                    <summary>
                        <span class={FacetTitle}>{t.page_browse_categories()}</span>
                        if !screen.category.is_empty() {
                            <span class={Muted}>{screen.category_label(t)}</span>
                        }
                    </summary>
                    <p class={Muted}>{t.page_mobile_categories_description()}</p>
                    <ul class={Choices}>
                        <li>
                            <a href={&category_href("", terms)} aria-current={screen.category.is_empty().then_some("page")}>
                                {t.page_all_categories()}
                            </a>
                        </li>
                        for category in &screen.categories {
                            <CategoryChoice
                                t={t}
                                category={category}
                                terms={terms}
                                current={category.slug == screen.category}
                                count={counts(&category.slug)}
                            />
                        }
                    </ul>
                </details>
                <details class={Facet} open>
                    <summary>
                        <span class={FacetTitle}>{t.page_price_and_availability()}</span>
                        if !price_summary.is_empty() {
                            <span class={Muted}>{&price_summary}</span>
                        }
                    </summary>
                    <p class={Muted}>{t.page_price_and_availability_description()}</p>
                    <div class={Prices}>
                        <label class={Field}>
                            <span>{t.page_minimum_price()}</span>
                            <span class={Money}>
                                <span aria-hidden="true">"$"</span>
                                <input
                                    name={f.price_min}
                                    inputmode="decimal"
                                    value={&terms.price_min}
                                    pattern={PRICE_PATTERN}
                                    aria-description={t.page_minimum_price_accessible_description()}
                                >
                            </span>
                        </label>
                        <label class={Field}>
                            <span>{t.page_maximum_price()}</span>
                            <span class={Money}>
                                <span aria-hidden="true">"$"</span>
                                <input
                                    name={f.price_max}
                                    inputmode="decimal"
                                    value={&terms.price_max}
                                    pattern={PRICE_PATTERN}
                                    aria-description={t.page_maximum_price_accessible_description()}
                                >
                            </span>
                        </label>
                    </div>
                    <label class={Check}>
                        <input type="checkbox" name={f.in_stock} value="true" checked={terms.in_stock}>
                        <span>
                            <span class={Strong}>{t.page_in_stock()}</span>
                            <span class={Muted}>{t.page_in_stock_description()}</span>
                        </span>
                    </label>
                </details>
                <details class={Facet} open={!terms.language.is_empty()}>
                    <summary>
                        <span class={FacetTitle}>{t.page_language()}</span>
                        if !terms.language.is_empty() {
                            <span class={Muted}>{language(t, &terms.language)}</span>
                        }
                    </summary>
                    <fieldset class={Choices}>
                        <legend class={VisuallyHidden}>{t.page_language()}</legend>
                        <p class={Muted}>{t.page_mobile_language_description()}</p>
                        <label class={Check}>
                            <input type="radio" name={f.language} value="" checked={terms.language.is_empty()}>
                            {t.page_all_languages()}
                        </label>
                        for (value, label) in languages(t) {
                            <label class={Check}>
                                <input type="radio" name={f.language} value={value} checked={terms.language == value}>{label}
                            </label>
                        }
                    </fieldset>
                </details>
                <details class={Facet} open={terms.activity != Activity::Any}>
                    <summary>
                        <span class={FacetTitle}>{t.page_market_activity()}</span>
                    </summary>
                    <fieldset class={Choices}>
                        <legend class={VisuallyHidden}>{t.page_market_activity()}</legend>
                        <p class={Muted}>{t.page_market_activity_description()}</p>
                        <label class={Check}>
                            <input type="radio" name={f.market_activity} value="" checked={terms.activity == Activity::Any}>
                            {t.page_any_market_activity()}
                        </label>
                        for (activity, label) in activities(t) {
                            <label class={Check}>
                                <input
                                    type="radio"
                                    name={f.market_activity}
                                    value={activity.as_str()}
                                    checked={terms.activity == activity}
                                >
                                {label}
                            </label>
                        }
                    </fieldset>
                </details>
                for facet in facets {
                    <FacetChoices t={t} facet={facet} />
                }
                <div class={FiltersFoot}>
                    <a class={Secondary} href={&url::Search { terms: Terms::default() }.href()}>{t.page_clear_all()}</a>
                    <button type="submit" class={Primary}>{t.page_show_results()}</button>
                </div>
            </form>
        </dialog>
    }
}

#[component(css = SearchPage)]
fn CategoryChoice<'a>(t: SearchMsg, category: &'a SearchCategory, terms: &'a Terms, current: bool, count: u64) -> impl Render {
    html! {
        <li>
            <a href={&category_href(&category.slug, terms)} aria-current={current.then_some("page")}>
                {t.page_category_count_label(&category.name, count)}
            </a>
        </li>
    }
}

/// A facet of the results (a field, a reference or a product dimension): a checkbox a value,
/// any number chosen.
#[component(css = SearchPage)]
fn FacetChoices<'a>(t: SearchMsg, facet: &'a Facet) -> impl Render {
    // A kind the page does not know is not offered.
    let kind = Kind::read(&facet.kind).unwrap_or(Kind::Field);
    let known = Kind::read(&facet.kind).is_some();
    let name = format!("{}.{}", kind.as_str(), facet.id);
    let chosen: Vec<&str> = facet.values.iter().filter(|v| v.selected).map(|v| v.label.as_str()).collect();
    let description = match kind {
        Kind::Dimension => t.page_dimension_facet_description(),
        Kind::Reference => t.page_reference_facet_description(),
        Kind::Field => t.page_field_facet_description(),
    };
    html! {
        <details class={Facet} open={!chosen.is_empty()} hidden={!known}>
            <summary>
                <span class={FacetTitle}>{&facet.label}</span>
                if !chosen.is_empty() {
                    <span class={Muted}>{&chosen.join(", ")}</span>
                }
            </summary>
            <fieldset class={Choices}>
                <legend class={VisuallyHidden}>{&t.page_facet_choices(&facet.label).to_string()}</legend>
                <p class={Muted}>{description}</p>
                for value in &facet.values {
                    <label class={Check}>
                        <input type="checkbox" name={&name} value={&value.id} checked={value.selected}>
                        <span>{&value.label}</span>
                        <span class={Muted}>{value.count}</span>
                    </label>
                }
            </fieldset>
        </details>
    }
}

/// No results: why, the first categories to try, and the ways back.
#[component(css = SearchPage)]
fn NoResults<'a>(t: SearchMsg, screen: &'a SearchScreen) -> impl Render {
    let terms = &screen.terms;
    let searched = !terms.q.is_empty() || !screen.category.is_empty() || terms.narrowed();
    let words = terms.q.trim();
    let clear_filters = if words.is_empty() {
        url::Search { terms: Terms::default() }.href()
    } else {
        url::Search { terms: Terms { q: words.to_owned(), ..Terms::default() } }.href()
    };
    let clear_words = screen.place().href(&terms.change(|n| n.q.clear()));
    html! {
        <div class={Empty}>
            <h2 class={EmptyTitle}>{t.page_no_items_found()}</h2>
            <p class={Muted}>
                if searched {
                    {t.page_try_adjusting_your_search_or_filters()}
                } else {
                    {t.page_no_catalog_items_are_available_yet()}
                }
            </p>
            if !screen.categories.is_empty() {
                <ul class={Chips}>
                    for category in screen.categories.iter().take(FEATURED).take(3) {
                        <li>
                            <a class={Chip} href={&url::Category { slug: &category.slug, terms: Terms::default() }.href()}>
                                {&category.name}
                            </a>
                        </li>
                    }
                </ul>
            }
            <div class={Promo}>
                <p class={BannerTitle}>{t.page_saved_search_recovery_title()}</p>
                <p>{t.page_saved_search_recovery_description()}</p>
            </div>
            <p class={Actions}>
                if !words.is_empty() {
                    <a class={Secondary} href={&clear_words}>{t.page_clear_search()}</a>
                }
                if terms.narrowed() || !screen.category.is_empty() {
                    <a class={Secondary} href={&clear_filters}>{t.page_clear_all_filters()}</a>
                }
                <a class={Secondary} href={&on_marketplace(SAVED_SEARCH)}>{t.page_save_search()}</a>
            </p>
        </div>
    }
}

/// The home page's merchandising in place of the results (`HomeMerchandising`): the featured
/// categories, each with its count and a link to its page, and the newest items, each with its
/// lowest price and a link to it.
#[component(css = SearchPage)]
fn Shelf<'a>(t: SearchMsg, shelf: &'a HomeShelf) -> impl Render {
    let newest = url::Search { terms: Terms { sort: "newest".to_owned(), ..Terms::default() } }.href();
    html! {
        if !shelf.featured.is_empty() {
            <section class={ShelfSection} aria-labelledby="home-featured-heading">
                <div class={ShelfHead}>
                    <div>
                        <h2 id="home-featured-heading" class={ResultsTitle}>{t.home_featured_categories()}</h2>
                        <p class={Muted}>{t.home_featured_categories_description()}</p>
                    </div>
                </div>
                <ul class={Featured}>
                    for category in &shelf.featured {
                        <li class={Feature}>
                            <h3 class={CardTitle}>{&category.name}</h3>
                            if let Some(description) = category.description.as_deref().filter(|d| !d.trim().is_empty()) {
                                <p class={Description}>{description}</p>
                            }
                            <p class={Muted}>{t.home_item_count(category.item_count)}</p>
                            <a class={Secondary} href={&url::Category { slug: &category.slug, terms: Terms::default() }.href()}>
                                {t.home_browse_category(&category.name)}
                            </a>
                        </li>
                    }
                </ul>
            </section>
        }
        if !shelf.arrivals.is_empty() {
            <section class={ShelfSection} aria-labelledby="home-arrivals-heading">
                <div class={ShelfHead}>
                    <div>
                        <h2 id="home-arrivals-heading" class={ResultsTitle}>{t.home_new_arrivals()}</h2>
                        <p class={Muted}>{t.home_new_arrivals_description()}</p>
                    </div>
                    <a class={Secondary} href={&newest}>{t.home_browse_all_new_arrivals()}</a>
                </div>
                <ItemCards t={t} items={&shelf.arrivals} action={t.home_view_item()} from={Some(t.home_from())} />
            </section>
        }
    }
}

/// Items as cards, one column, two from lg and three from 2xl (a `Grid` of `ListingCard`s): the
/// home page's new arrivals and a set's cards.
#[component(css = SearchPage)]
pub fn ItemCards<'a>(t: SearchMsg, items: &'a [SearchItem], action: &'a str, from: Option<&'a str>) -> impl Render {
    html! {
        <ol class={Arrivals}>
            for (index, item) in items.iter().enumerate() {
                <ItemCard t={t} item={item} index={index} action={action} from={from} />
            }
        </ol>
    }
}

/// An item's card: its picture and title link to the item, its subtitle, its lowest price (after
/// `from`, "From", when there is one), and `action` (View item, View card).
#[component(css = SearchPage)]
fn ItemCard<'a>(t: SearchMsg, item: &'a SearchItem, index: usize, action: &'a str, from: Option<&'a str>) -> impl Render {
    let card = &item.card;
    let slug = if card.slug.is_empty() { card.catalog_item_id.as_str() } else { card.slug.as_str() };
    let href = url::Item { slug, state: Address::default(), after: Default::default() }.href();
    let identity = match card.subtitle.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(subtitle) => t.identity_title_and_subtitle(&card.title, subtitle).to_string(),
        None => t.identity_title(&card.title).to_string(),
    };
    let image = similar_image(card);
    let price = item
        .market_summary
        .as_ref()
        .and_then(|m| Some(money(t, m.lowest_price_amount.as_deref()?, m.lowest_price_currency_code.as_deref()?)));
    let priority = index < PRIORITY_IMAGES;
    html! {
        <li class={Card}>
            <a class={CardMedia} href={&href} tabindex="-1" aria-hidden="true">
                match &image {
                    Some(image) => {
                        <img
                            src={&image.src}
                            srcset={image.srcset.as_deref()}
                            sizes={image.srcset.as_ref().filter(|s| s.ends_with('w')).map(|_| "(min-width: 768px) 164px, 124px")}
                            width={image.width.unwrap_or(224)}
                            height={image.height.unwrap_or(314)}
                            loading={if priority { "eager" } else { "lazy" }}
                            fetchpriority={if priority { "high" } else { "auto" }}
                            decoding="async"
                            alt=""
                        >
                    }
                    None => { <span class={NoImage}></span> }
                }
            </a>
            <div class={CardBody}>
                <h3 class={CardTitle}>
                    <a href={&href} aria-label={&t.card_view_details_for(&identity).to_string()}>{&card.title}</a>
                </h3>
                if let Some(subtitle) = card.subtitle.as_deref().filter(|s| !s.trim().is_empty()) {
                    <p class={Muted}>{subtitle}</p>
                }
                if let Some(price) = &price {
                    <p class={Price}>
                        if let Some(from) = from {
                            <span class={Muted}>{from}" "</span>
                        }
                        <span class={Strong}>{price}</span>
                    </p>
                }
                <p class={Intents}><a class={Primary} href={&href}>{action}</a></p>
            </div>
        </li>
    }
}

/// The results: close spellings or closest matches, the cards, Save this search and Load more.
#[component(css = SearchPage)]
fn Found<'a>(t: SearchMsg, screen: &'a SearchScreen, results: &'a SearchResults) -> impl Render {
    let terms = &screen.terms;
    let shown = results.items.len();
    // Load more, while the API has more and a page without JavaScript could still show them.
    let cursor = results.next_cursor.as_deref().filter(|_| shown >= PAGE_SIZE + terms.more && shown < MOST_SHOWN);
    html! {
        if results.retrieval_mode.as_deref() == Some("corrected") {
            <div class={Banner} data-tone="info"><p class={BannerTitle}>{t.page_close_spellings(&terms.q)}</p></div>
        }
        if results.retrieval_mode.as_deref() == Some("rescue") {
            <h2 id="search-results-heading" class={ResultsTitle}>{t.page_closest_matches()}</h2>
            <p class={Muted}>
                match results.lexical_count.filter(|n| *n > 0) {
                    Some(count) => { {t.page_closest_matches_with_lexical(count)} }
                    None => { {t.page_closest_matches_semantic_only()} }
                }
            </p>
        } else {
            <h2 id="search-results-heading" class={ResultsTitle}>{t.page_results()}</h2>
        }
        <ResultRows t={t} items={&results.items} terms={terms} first={0} keys={results.keys()} />
        if terms.focused(&screen.category) {
            <div class={Promo}>
                <p class={BannerTitle}>{t.page_save_this_search()}</p>
                <p>{t.page_get_alerts_when_supply_matches()}</p>
                <a class={Secondary} href={&on_marketplace(SAVED_SEARCH)}>{t.page_save_search()}</a>
            </div>
        }
        <LoadMore t={t} place={screen.place()} terms={terms} shown={shown} cursor={cursor} failed={false} />
    }
}

/// The results' cards, numbered from `first`, with the search's analytics keys.
#[component(css = SearchPage)]
pub fn ResultRows<'a>(
    t: SearchMsg,
    items: &'a [SearchItem],
    terms: &'a Terms,
    first: usize,
    keys: (&'a str, &'a str),
) -> impl Patch {
    html! {
        <ol id={ResultsId} class={Grid}>
            for (n, item) in items.iter().enumerate() {
                <ResultCard t={t} item={item} terms={terms} index={first + n} keys={keys} />
            }
        </ol>
    }
}

/// Load more, a GET form with every choice and the API's cursor. With JavaScript it is a patch
/// that adds the next page's rows and draws this form again for the page after (`search::more`);
/// without it, the address with a page more (`more=`), at the first result it adds. Hidden when
/// there is no more, so a patch can still replace it. After a failed load it says so, and its
/// button tries again.
#[component(css = SearchPage)]
pub fn LoadMore<'a>(
    t: SearchMsg,
    place: Place<'a>,
    terms: &'a Terms,
    shown: usize,
    cursor: Option<&'a str>,
    failed: bool,
) -> impl Patch {
    let next = Terms { more: shown, ..terms.clone() };
    let action = format!("{}#result-{}", place.href(&Terms::default()), shown + 1);
    let pairs = next.pairs();
    html! {
        <form id={LoadMoreId} class={More} method="get" action={&action} data-patch hidden={cursor.is_none()}>
            for (key, value) in &pairs {
                <input type="hidden" name={key} value={value}>
            }
            if let Some(cursor) = cursor {
                <input type="hidden" name={CURSOR} value={cursor}>
            }
            if failed {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={BannerTitle}>{t.page_load_more_error_title()}</p>
                    <p>{t.page_load_more_error_description()}</p>
                </div>
            }
            <button class={Secondary}>
                if failed { {t.page_retry_loading_results()} } else { {t.page_load_more_results()} }
            </button>
        </form>
    }
}

/// A result's card (`ListingCard`, `search-result`): its picture and title link to the item, its
/// subtitle, badges and language, its lowest price when it has listings, and the market intents:
/// Buy first when it has listings, else Sell.
#[component(css = SearchPage)]
pub fn ResultCard<'a>(
    t: SearchMsg,
    item: &'a SearchItem,
    terms: &'a Terms,
    index: usize,
    keys: (&'a str, &'a str),
) -> impl Render {
    let card = &item.card;
    let slug = if card.slug.is_empty() { card.catalog_item_id.as_str() } else { card.slug.as_str() };
    let options = terms.dimensions();
    let at = |market: Market| {
        url::Item {
            slug,
            state: Address { market, options: options.clone(), filtered: !options.is_empty(), ..Address::default() },
            after: Default::default(),
        }
        .href()
    };
    let href = at(Market::Buy);
    let identity = match card.subtitle.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(subtitle) => t.identity_title_and_subtitle(&card.title, subtitle).to_string(),
        None => t.identity_title(&card.title).to_string(),
    };
    let image = similar_image(card);
    let listings = item.market_summary.as_ref().map_or(0, |m| m.active_listing_count);
    let price = item
        .market_summary
        .as_ref()
        .filter(|_| listings > 0)
        .and_then(|m| Some(money(t, m.lowest_price_amount.as_deref()?, m.lowest_price_currency_code.as_deref()?)));
    let cue = item.language_code.as_deref().filter(|c| !c.is_empty() && *c != "en").map(|c| language(t, c));
    let badges: Vec<&str> =
        item.display_badges.iter().filter(|b| b.kind == "variant" || b.kind == "rarity").map(|b| b.label.as_str()).collect();
    let priority = index < PRIORITY_IMAGES;
    let number = (index + 1).to_string();
    let (buy, sell, watch) = (at(Market::Buy), at(Market::Sell), at(Market::Watch));
    // Opening the item from its picture or its title (marketplace's card link), not its Buy, Sell
    // or Watch, which marketplace's card leaves uncounted.
    let (query_hash, result_set_key) = keys;
    let opened = analytics::searchResult(index + 1, query_hash, result_set_key);
    html! {
        <li id={ResultId(&number)} class={Card}>
            <a class={CardMedia} href={&href} tabindex="-1" aria-hidden="true" on:click={opened}>
                match &image {
                    Some(image) => {
                        <img
                            src={&image.src}
                            srcset={image.srcset.as_deref()}
                            sizes={image.srcset.as_ref().filter(|s| s.ends_with('w')).map(|_| "(min-width: 768px) 164px, 124px")}
                            width={image.width.unwrap_or(224)}
                            height={image.height.unwrap_or(314)}
                            loading={if priority { "eager" } else { "lazy" }}
                            fetchpriority={if priority { "high" } else { "auto" }}
                            decoding="async"
                            alt=""
                        >
                    }
                    None => { <span class={NoImage}></span> }
                }
            </a>
            <div class={CardBody}>
                <h3 class={CardTitle}>
                    <a href={&href} aria-label={&t.card_view_details_for(&identity).to_string()} on:click={opened}>
                        {&card.title}
                    </a>
                </h3>
                if let Some(subtitle) = card.subtitle.as_deref().filter(|s| !s.trim().is_empty()) {
                    <p class={Muted}>{subtitle}</p>
                }
                if !badges.is_empty() || cue.is_some() {
                    <p class={Badges}>
                        for badge in &badges {
                            <span class={Badge}>{*badge}</span>
                        }
                        if let Some(cue) = &cue {
                            <span class={Badge} data-tone="accent">{cue}</span>
                        }
                    </p>
                }
                if let Some(price) = &price {
                    <p class={Price}><span class={Muted}>{t.page_from()}" "</span><span class={Strong}>{price}</span></p>
                }
                <p class={Intents}>
                    if listings > 0 {
                        <a class={Primary} href={&buy} aria-label={t.page_buy()}>{t.page_buy_intent()}</a>
                        <a class={Ghost} href={&sell} aria-label={t.page_sell()}>{t.page_sell_intent()}</a>
                    } else {
                        <a class={Primary} href={&sell} aria-label={t.page_sell()}>{t.page_sell_intent()}</a>
                        <a class={Ghost} href={&buy} aria-label={t.page_buy()}>{t.page_buy_intent()}</a>
                    }
                    <a class={Ghost} href={&watch} aria-label={t.page_watch()}>{t.page_watch_intent()}</a>
                </p>
            </div>
        </li>
    }
}
