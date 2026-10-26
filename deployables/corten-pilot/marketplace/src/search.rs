//! Marketplace search (discovery's `routes/search.tsx`): `/search` and `/categories/{slug}`, to
//! anyone. Every choice is in the address: the words (`q`), the category (the path), the
//! filters and the sort are one GET form, each filter chip is a link without its filter, and Load
//! more is a link that shows more of the same results. The page works without a script; with
//! one, a filter applies as soon as it changes (`search.js`).
//!
//! As marketplace's loader does, the page moves an old address for good: `page` is dropped, and
//! `category=..` or a category's id, key, name or old slug moves to `/categories/{slug}`. Words
//! the API reads filters from (`charizard psa 10`) redirect to the address with those filters
//! applied and the words left, marked `interpreted` so they are not read again.
//!
//! The home page (`/`) is the same route, as marketplace's index route is: with nothing asked it
//! shows the four featured categories and the three newest items in place of the results.
//!
//! Not ported: Add to List and the bulk add to the buy cart
//! from a result, the realtime market patches, the facet option search and the automatic load on
//! scroll. Load more shows the address's results again with a page more, as Corten cannot add rows
//! to a list (todd-skelton/corten#90), up to the 192 the API reads at once.
use std::collections::BTreeMap;

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};

use crate::{
    api::{Interpretation, Search, SearchCategory, SearchResults, segment},
    app::{Shared, marketplace_origin, url},
    auth::Session,
    items::Raw,
    text::{Pilot, SearchMsg},
    views,
};

/// Results a page shows, and each Load more adds (`PAGE_SIZE`).
pub const PAGE_SIZE: usize = 24;
/// The most results one address shows: the API answers 200 at most, so Load more stops at the
/// last whole page under it.
pub const MOST_SHOWN: usize = 192;

/// A dynamic filter's kind, which names its parameter (`field.<id>`, `reference.<id>`,
/// `dimension.<id>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Field,
    Reference,
    Dimension,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Field => "field",
            Kind::Reference => "reference",
            Kind::Dimension => "dimension",
        }
    }

    pub fn read(text: &str) -> Option<Self> {
        match text {
            "field" => Some(Kind::Field),
            "reference" => Some(Kind::Reference),
            "dimension" => Some(Kind::Dimension),
            _ => None,
        }
    }
}

/// One value of a dynamic filter (`DynamicSearchFilterSelection`).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Filter {
    pub kind: Kind,
    pub id: String,
    pub value: String,
}

impl Filter {
    /// Its parameter's name.
    pub fn key(&self) -> String {
        format!("{}.{}", self.kind.as_str(), self.id)
    }
}

/// Results with market activity of a kind (`marketActivity`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Activity {
    #[default]
    Any,
    ListingsOrOffers,
    Listings,
    Offers,
}

impl Activity {
    fn read(text: &str) -> Self {
        match text {
            "any" => Activity::ListingsOrOffers,
            "listings" => Activity::Listings,
            "offers" => Activity::Offers,
            _ => Activity::Any,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Activity::Any => "",
            Activity::ListingsOrOffers => "any",
            Activity::Listings => "listings",
            Activity::Offers => "offers",
        }
    }
}

/// What the address asks for: everything but the category's path.
#[derive(Clone, Debug, PartialEq)]
pub struct Terms {
    /// The words (`q`, else `search`).
    pub q: String,
    /// `category=..` on `/search`, which the page moves to the category's path.
    pub category: String,
    pub tag: String,
    pub language: String,
    pub activity: Activity,
    /// A price in dollars (`0`, `12` or `12.50`); anything else is no price.
    pub price_min: String,
    pub price_max: String,
    pub in_stock: bool,
    pub sort: String,
    pub filters: Vec<Filter>,
    /// The filter parameters applied from the words (`interpreted=..`; empty is still marked).
    pub interpreted: Option<String>,
    /// How many results the page shows beyond the first page's (Load more), a whole number of pages.
    pub more: usize,
}

impl Default for Terms {
    fn default() -> Self {
        Terms {
            q: String::new(),
            category: String::new(),
            tag: String::new(),
            language: String::new(),
            activity: Activity::Any,
            price_min: String::new(),
            price_max: String::new(),
            in_stock: false,
            sort: RELEVANCE.to_owned(),
            filters: Vec::new(),
            interpreted: None,
            more: 0,
        }
    }
}

pub const RELEVANCE: &str = "relevance";
/// The parameter Load more adds: how many more results than a page to show.
pub const MORE: &str = "more";

/// A price filter's value (`readPriceFilter`): a whole number without leading zeros, with at most
/// two decimals.
fn price(text: &str) -> String {
    let text = text.trim();
    let (whole, cents) = text.split_once('.').map_or((text, None), |(w, c)| (w, Some(c)));
    let whole_ok = whole == "0" || (!whole.is_empty() && !whole.starts_with('0') && whole.bytes().all(|b| b.is_ascii_digit()));
    let cents_ok = cents.is_none_or(|c| (1..=2).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_digit()));
    if whole_ok && cents_ok { text.to_owned() } else { String::new() }
}

impl Terms {
    /// The address's parameters, as marketplace's loader reads them.
    pub fn read(raw: &Raw) -> Self {
        let first = |key: &str| raw.get(key).and_then(|v| v.all().first()).map(String::as_str);
        let mut filters = Vec::new();
        for (key, values) in raw {
            let Some((kind, id)) = key.split_once('.') else { continue };
            let Some(kind) = Kind::read(kind) else { continue };
            if id.is_empty() {
                continue;
            }
            for value in values.all().iter().filter(|v| !v.is_empty()) {
                filters.push(Filter { kind, id: id.to_owned(), value: value.clone() });
            }
        }
        let more = first(MORE).and_then(|n| n.parse::<usize>().ok()).unwrap_or(0) / PAGE_SIZE * PAGE_SIZE;
        Terms {
            q: first("q").or_else(|| first("search")).unwrap_or("").to_owned(),
            category: first("category").unwrap_or("").to_owned(),
            tag: first("tag").unwrap_or("").to_owned(),
            language: first("language").unwrap_or("").to_owned(),
            activity: Activity::read(first("marketActivity").unwrap_or("")),
            price_min: price(first("priceMin").unwrap_or("")),
            price_max: price(first("priceMax").unwrap_or("")),
            in_stock: first("inStock") == Some("true"),
            sort: first("sort").filter(|s| !s.is_empty()).unwrap_or(RELEVANCE).to_owned(),
            filters,
            interpreted: first("interpreted").map(str::to_owned),
            more: more.min(MOST_SHOWN - PAGE_SIZE),
        }
    }

    /// The parameters, in a fixed order, as the page writes them into its links.
    pub fn pairs(&self) -> Vec<(String, String)> {
        let mut pairs = Vec::new();
        let mut put = |key: &str, value: &str| {
            if !value.is_empty() {
                pairs.push((key.to_owned(), value.to_owned()));
            }
        };
        put("q", &self.q);
        put("category", &self.category);
        put("tag", &self.tag);
        put("language", &self.language);
        put("marketActivity", self.activity.as_str());
        put("priceMin", &self.price_min);
        put("priceMax", &self.price_max);
        put("inStock", if self.in_stock { "true" } else { "" });
        put("sort", if self.sort == RELEVANCE { "" } else { &self.sort });
        for filter in &self.filters {
            put(&filter.key(), &filter.value);
        }
        if let Some(keys) = &self.interpreted {
            pairs.push(("interpreted".to_owned(), keys.clone()));
        }
        if self.more > 0 {
            pairs.push((MORE.to_owned(), self.more.to_string()));
        }
        pairs
    }

    /// The API's query string for the first `limit` results (`buildSearchQuery`), in `category`.
    pub fn api_query(&self, category: &str, limit: usize) -> String {
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut put = |key: &str, value: &str| {
            if !value.is_empty() {
                pairs.push((key.to_owned(), value.to_owned()));
            }
        };
        put("search", &self.q);
        put("category", category);
        put("tag", &self.tag);
        put("language", &self.language);
        put("marketActivity", self.activity.as_str());
        put("priceMin", &self.price_min);
        put("priceMax", &self.price_max);
        put("inStock", if self.in_stock { "true" } else { "" });
        put("sort", &self.sort);
        put("limit", &limit.to_string());
        put("includeTotal", "true");
        for filter in &self.filters {
            put(&filter.key(), &filter.value);
        }
        if let Some(keys) = &self.interpreted {
            pairs.push(("interpreted".to_owned(), keys.clone()));
        }
        encode(&pairs)
    }

    /// Whether the page shows results for something (`hasFocusedResults`); otherwise it is the
    /// marketplace's search landing.
    pub fn focused(&self, category: &str) -> bool {
        !self.q.trim().is_empty() || !category.is_empty() || self.narrowed()
    }

    /// Whether a filter or a sort is applied (`hasActiveFilters`, without the category).
    pub fn narrowed(&self) -> bool {
        !self.tag.is_empty()
            || !self.language.is_empty()
            || self.activity != Activity::Any
            || !self.price_min.is_empty()
            || !self.price_max.is_empty()
            || self.in_stock
            || !self.filters.is_empty()
            || self.sort != RELEVANCE
    }

    /// The same search after a change from the page (a chip removed, a facet toggled): from the
    /// first page, and still marked as interpreted only while the change just removes filters
    /// the words applied (`retainInterpretationMarker`).
    pub fn change(&self, edit: impl FnOnce(&mut Terms)) -> Terms {
        let mut next = self.clone();
        next.more = 0;
        edit(&mut next);
        if next.interpreted.is_some() && !self.keeps_marker(&next) {
            next.interpreted = None;
        }
        next
    }

    fn keeps_marker(&self, next: &Terms) -> bool {
        let marked: Vec<&str> = self.interpreted.as_deref().unwrap_or("").split(',').filter(|k| !k.is_empty()).collect();
        let by_key = |terms: &Terms| {
            let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for (key, value) in terms.pairs() {
                if !matches!(key.as_str(), "interpreted" | "sort" | MORE) {
                    map.entry(key).or_default().push(value);
                }
            }
            map
        };
        let (before, after) = (by_key(self), by_key(next));
        let keys: std::collections::BTreeSet<&String> = before.keys().chain(after.keys()).collect();
        keys.into_iter().all(|key| {
            let (b, a) = (before.get(key).cloned().unwrap_or_default(), after.get(key).cloned().unwrap_or_default());
            b == a || (marked.contains(&key.as_str()) && a.iter().all(|v| b.contains(v)) && a.len() < b.len())
        })
    }

    /// The canonical address for the API's reading of the words (`buildInterpretedSearchPath`):
    /// the words left as `q`, each applied filter added, and the marker naming their parameters.
    pub fn interpreted(&self, interpretation: &Interpretation) -> Terms {
        let mut next = self.clone();
        next.q = interpretation.remaining_query.clone();
        let mut keys: Vec<&str> = Vec::new();
        for applied in &interpretation.applied {
            if applied.param == "language" {
                next.language = applied.language.clone().unwrap_or_default();
            } else if let (Some((kind, id)), Some(value)) = (applied.param.split_once('.'), &applied.option_id)
                && let Some(kind) = Kind::read(kind)
            {
                next.filters.push(Filter { kind, id: id.to_owned(), value: value.clone() });
            }
            if !keys.contains(&applied.param.as_str()) {
                keys.push(&applied.param);
            }
        }
        next.interpreted = Some(keys.join(","));
        next
    }

    /// The marked filter parameters (`readInterpretedFilters`).
    pub fn marked(&self) -> impl Iterator<Item = &str> {
        self.interpreted.as_deref().unwrap_or("").split(',').filter(|k| !k.is_empty())
    }

    /// The dimension filters, which a result's link carries to its item page (`buildItemDetailHref`).
    pub fn dimensions(&self) -> Vec<(String, String)> {
        self.filters.iter().filter(|f| f.kind == Kind::Dimension).map(|f| (f.id.clone(), f.value.clone())).collect()
    }
}

/// `key=value&..`, each percent-encoded.
fn encode(pairs: &[(String, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", segment(k), segment(v))).collect::<Vec<_>>().join("&")
}

/// Written by hand: `#[route(query)]` names a parameter by its field, and marketplace's are
/// camelCase (`marketActivity`, `priceMin`) (todd-skelton/corten#91).
impl corten::route::Params for Terms {
    fn write_params(&self, first: &mut bool, html: bool, out: &mut String) {
        for (key, value) in self.pairs() {
            out.push_str(if *first {
                "?"
            } else if html {
                "&amp;"
            } else {
                "&"
            });
            *first = false;
            out.push_str(&segment(&key));
            out.push('=');
            out.push_str(&segment(&value));
        }
    }
}

/// Where the search is: `/search`, a category's page, or the home page (marketplace's index
/// route is the search route).
#[derive(Clone, Copy, Debug)]
pub enum Place<'a> {
    Search,
    Category(&'a str),
    Home,
}

impl Place<'_> {
    /// The address of `terms` here.
    pub fn href(&self, terms: &Terms) -> String {
        match self {
            Place::Search => url::Search { terms: terms.clone() }.href(),
            Place::Category(slug) => url::Category { slug, terms: terms.clone() }.href(),
            Place::Home => url::Home { terms: terms.clone() }.href(),
        }
    }
}

/// Featured categories the home page shows (`HOME_FEATURED_CATEGORY_LIMIT`).
const HOME_CATEGORIES: usize = 4;
/// New arrivals the home page shows (`HOME_NEW_ARRIVALS_LIMIT`).
const HOME_ARRIVALS: usize = 3;

/// The home page's merchandising, in place of the results: the first categories by their order
/// and the newest items.
pub struct HomeShelf {
    pub featured: Vec<SearchCategory>,
    pub arrivals: Vec<crate::api::SearchItem>,
}

/// `/categories/{slug}`, or `/search` for none, with `terms` but its category and page
/// (`buildCategoryPath`).
pub fn category_href(slug: &str, terms: &Terms) -> String {
    let terms = Terms { category: String::new(), more: 0, ..terms.clone() };
    if slug.is_empty() { Place::Search.href(&terms) } else { Place::Category(slug).href(&terms) }
}

/// What the page shows.
pub struct SearchScreen {
    pub terms: Terms,
    /// The category's slug, or none.
    pub category: String,
    pub categories: Vec<SearchCategory>,
    /// `None` when the read failed.
    pub results: Option<SearchResults>,
    /// On the home page with nothing asked (`isHomeLanding`), when there is something to show.
    pub shelf: Option<HomeShelf>,
    pub home: bool,
}

impl SearchScreen {
    pub fn place(&self) -> Place<'_> {
        if !self.category.is_empty() {
            Place::Category(&self.category)
        } else if self.home {
            Place::Home
        } else {
            Place::Search
        }
    }

    /// The category's name (`activeCategoryLabel`), else "All Categories".
    pub fn category_label(&self, t: SearchMsg) -> &str {
        self.categories.iter().find(|c| c.slug == self.category).map_or(t.page_all_categories(), |c| c.name.as_str())
    }
}

pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Query(raw): Query<Raw>,
) -> HtmlResult {
    show(req, session, config, headers, uri, raw, None).await
}

pub(crate) async fn category(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Path(slug): Path<String>,
    Query(raw): Query<Raw>,
) -> HtmlResult {
    show(req, session, config, headers, uri, raw, Some(slug)).await
}

async fn show(
    req: Req,
    session: Option<corten::Caller<Session>>,
    config: Shared,
    headers: HeaderMap,
    uri: Uri,
    raw: Raw,
    slug: Option<String>,
) -> HtmlResult {
    // `page` is gone for good: the same address without it, as sent.
    if raw.contains_key("page") {
        let kept: Vec<&str> =
            uri.query().unwrap_or("").split('&').filter(|p| !p.is_empty() && p.split('=').next() != Some("page")).collect();
        let to = if kept.is_empty() { uri.path().to_owned() } else { format!("{}?{}", uri.path(), kept.join("&")) };
        let to: Uri = to.parse().map_err(corten::Error::new)?;
        return req.moved(&to);
    }
    let terms = Terms::read(&raw);
    let caller = config.platform.caller(&headers, config.proto, None);
    let asked = slug.clone().unwrap_or_else(|| terms.category.clone());
    let (by_slug, all) = tokio::join!(
        async {
            if asked.is_empty() {
                return None;
            }
            caller.category(&asked).await.unwrap_or_else(|error| {
                tracing::warn!("the category's read failed: {error}");
                None
            })
        },
        caller.categories()
    );
    let categories = all.unwrap_or_else(|error| {
        tracing::warn!("the categories' read failed: {error}");
        Vec::new()
    });
    let resolved = by_slug.or_else(|| {
        categories.iter().find(|c| c.name == asked || c.key.as_deref() == Some(&asked) || c.category_id == asked).cloned()
    });
    let category = resolved.as_ref().map_or_else(|| asked.clone(), |c| c.slug.clone());
    // A category by its id, key, name or old slug, or asked for as `category=..`, is at its
    // slug's path for good.
    if let Some(resolved) = &resolved {
        let moves = match &slug {
            Some(slug) => *slug != resolved.slug,
            None => !terms.category.is_empty(),
        };
        if moves {
            let to: Uri = category_href(&resolved.slug, &terms).parse().map_err(corten::Error::new)?;
            return req.moved(&to);
        }
    }
    let home = uri.path() == "/";
    let landing = home && !terms.focused(&category);
    let limit = PAGE_SIZE + terms.more;
    let query = terms.api_query(&category, limit);
    let newest = Terms { sort: "newest".to_owned(), ..Terms::default() }.api_query("", HOME_ARRIVALS);
    let (results, arrivals) = tokio::join!(caller.search(&query), async {
        if !landing {
            return Vec::new();
        }
        match caller.search(&newest).await {
            Ok(newest) => newest.items,
            Err(error) => {
                tracing::warn!("the new arrivals' read failed: {error}");
                Vec::new()
            }
        }
    });
    let results = match results {
        Ok(results) => Some(results),
        Err(error) => {
            tracing::warn!("the search's read failed: {error}");
            None
        }
    };
    // Filters the API read from the words: the address with them applied, which is not read again.
    if let Some(interpretation) = results.as_ref().and_then(|r| r.interpretation.as_ref())
        && terms.interpreted.is_none()
    {
        let next = terms.interpreted(interpretation);
        let place = match (&slug, home) {
            (Some(_), _) => Place::Category(&category),
            (None, true) => Place::Home,
            (None, false) => Place::Search,
        };
        let to: Uri = place.href(&next).parse().map_err(corten::Error::new)?;
        return req.redirect(&to);
    }
    let session = session.as_ref().map(|corten::Caller(s)| s);
    let viewer = session.and_then(Session::viewer);
    let failed = results.is_none();
    // A category the path names that does not exist shows no results, as marketplace's does.
    let category = if slug.is_some() { category } else { String::new() };
    let shelf = landing.then(|| {
        let mut featured = categories.clone();
        featured.sort_by_key(|c| c.display_order);
        featured.truncate(HOME_CATEGORIES);
        HomeShelf { featured, arrivals }
    });
    let shelf = shelf.filter(|s| !s.featured.is_empty() || !s.arrivals.is_empty());
    let screen = SearchScreen { terms, category, categories, results, shelf, home };
    render(&req, viewer, &screen, failed)
}

fn render(req: &Req, viewer: Option<&crate::auth::Viewer>, screen: &SearchScreen, failed: bool) -> HtmlResult {
    let t: SearchMsg = req.t();
    let terms = &screen.terms;
    let title = if terms.q.is_empty() {
        t.route_marketplace_search().to_owned()
    } else {
        t.route_search_meta_title(&terms.q).to_string()
    };
    let description = t.route_browse_the_chase_sets_marketplace_with();
    // The canonical address: the category's path or `/search`, with the parameters but Load more.
    let canonical = format!("{}{}", marketplace_origin(), category_href(&screen.category, &Terms { more: 0, ..terms.clone() }));
    let og_title = title.as_str();
    let head = html! {
        <meta name="description" content={description}>
        <link rel="canonical" href={&canonical}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={description}>
        <meta property="og:type" content="website">
    };
    let p: Pilot = req.t();
    let status = if failed { StatusCode::BAD_GATEWAY } else { StatusCode::OK };
    req.page_with_status(
        status,
        html! {
            <views::Layout req={req} viewer={viewer} title={&title} head={head}>
                <views::SearchPage t={t} p={p} screen={screen} failed={failed} />
            </views::Layout>
        },
    )
}
