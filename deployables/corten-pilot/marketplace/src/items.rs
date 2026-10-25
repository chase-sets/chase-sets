//! Marketplace's item page (`/items/{id}`, bounded-contexts/discovery/routes/item-detail.tsx): the
//! item, its product options, the market for the product chosen, and the market book of its
//! listings and offers. Anyone may read it; a session only says whose offers are theirs.
//!
//! What the buyer has chosen is in the address, so every choice is a link (or, for a long list
//! of options, a GET form) that works without JavaScript and can be shared:
//!
//! | Parameter | Means |
//! |---|---|
//! | `market=buy\|sell\|watch` | the side of the market (`buy` unless `sell` or `watch`) |
//! | `listing=<id>`, `offer=<id>` | the listing or offer chosen in the market book (one value) |
//! | `dimension.<dimensionId>=<optionId>` | a product option (kept only when given one value) |
//! | `book=listings\|offers\|details` | the market book's tab; the pilot's own, marketplace keeps it in state |
//!
//! Marketplace reads the same parameters (`readInitialSelectedOptions`, `readExplicitMarketSelectionId`)
//! and keeps later choices in React state; the pilot reads every choice from the address. The
//! rules that turn the address into a selection are marketplace's page model
//! (`use-item-detail-page-model.tsx`, `item-detail-market.ts`, `product-resolution.ts`), which
//! the scope decision on chase-sets/chase-sets#10558 (item-detail Listings and Offers in canonical
//! order) leaves in the web layer as presentation.
use std::collections::{BTreeMap, BTreeSet};

use corten::{
    axum::{
        extract::{Path, State},
        http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
        response::IntoResponse,
    },
    prelude::*,
    route::Params,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{Dimension, DimensionOption, Discovery, Item, Listing, Money, Offer, Schema, Selected, segment},
    app::{Shared, marketplace_origin, url},
    auth::Session,
    text::ItemMsg,
    views,
};

pub fn routes(area: Area<Session, url::ItemsArea>, shared: &Shared) -> Area<Session, url::ItemsArea> {
    area.route::<url::Item>(get(page).with_state(shared.clone()))
}

/// The side of the market the page shows (`MarketIntent`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Market {
    #[default]
    Buy,
    Sell,
    Watch,
}

impl Market {
    fn read(value: Option<&str>) -> Self {
        match value {
            Some("sell") => Market::Sell,
            Some("watch") => Market::Watch,
            _ => Market::Buy,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Market::Buy => "buy",
            Market::Sell => "sell",
            Market::Watch => "watch",
        }
    }
}

/// The market book's tab (`MarketBookTab`, without Sales: the market history is not ported).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Book {
    Listings,
    Offers,
    Details,
}

impl Book {
    fn read(value: Option<&str>) -> Option<Self> {
        match value {
            Some("listings") => Some(Book::Listings),
            Some("offers") => Some(Book::Offers),
            Some("details") => Some(Book::Details),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Book::Listings => "listings",
            Book::Offers => "offers",
            Book::Details => "details",
        }
    }
}

/// A query parameter's values, as Corten's `Query` reads a key into a map: one value, or every
/// value of a key sent more than once.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Values {
    One(String),
    Many(Vec<String>),
}

impl Values {
    fn all(&self) -> &[String] {
        match self {
            Values::One(one) => std::slice::from_ref(one),
            Values::Many(many) => many,
        }
    }
}

/// The parameters as sent: a map, because `dimension.<id>` keys are data.
pub type Raw = BTreeMap<String, Values>;

/// The value that clears a product option the page would otherwise choose by itself: a
/// `dimension.*` filter that names no option, so marketplace's `hasInitialSelectedOptionFilters`
/// holds and the normalized selection is empty.
const ANY: &str = "any";

/// What the address says the buyer chose.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Address {
    pub market: Market,
    pub listing: Option<String>,
    pub offer: Option<String>,
    pub book: Option<Book>,
    /// `dimension.<id>=<option>`, each dimension given exactly one option, in key order.
    pub options: Vec<(String, String)>,
    /// A `dimension.*` parameter had a value (`hasInitialSelectedOptionFilters`).
    pub filtered: bool,
}

impl Address {
    /// The address's parameters, as marketplace reads them.
    pub fn read(raw: &Raw) -> Self {
        let first = |key: &str| raw.get(key).and_then(|v| v.all().first()).map(String::as_str);
        // `readExplicitMarketSelectionId`: the id when every non-blank value names the same one.
        let one = |key: &str| {
            let ids: BTreeSet<&str> =
                raw.get(key).map(|v| v.all().iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
            (ids.len() == 1).then(|| ids.into_iter().next().unwrap_or_default().to_owned())
        };
        let mut options = Vec::new();
        let mut filtered = false;
        for (key, values) in raw {
            let Some(dimension) = key.strip_prefix("dimension.") else { continue };
            let given: BTreeSet<&str> = values.all().iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            filtered |= !given.is_empty();
            let dimension = dimension.trim();
            if !dimension.is_empty() && given.len() == 1 {
                options.push((dimension.to_owned(), given.into_iter().next().unwrap_or_default().to_owned()));
            }
        }
        Address {
            market: Market::read(first("market")),
            listing: one("listing"),
            offer: one("offer"),
            book: Book::read(first("book")),
            options,
            filtered,
        }
    }

    /// The tab shown: the one chosen, else the side's own.
    pub fn book(&self) -> Book {
        self.book.unwrap_or(self.side_book())
    }

    /// The side's own tab: listings, or offers when selling.
    fn side_book(&self) -> Book {
        if self.market == Market::Sell { Book::Offers } else { Book::Listings }
    }

    /// The same page on another side of the market, on that side's tab (`setMarketBookTab`).
    pub fn with_market(&self, market: Market) -> Self {
        Address { market, book: None, ..self.clone() }
    }

    pub fn with_book(&self, book: Book) -> Self {
        Address { book: Some(book), ..self.clone() }
    }

    /// The product options `picks`, with no listing or offer chosen (`handleProductSelectionChange`
    /// clears them). `cleared` is the dimension whose option was taken away: when nothing is left
    /// chosen, the page must not choose one by itself again.
    pub fn with_picks(&self, schema: &Schema, picks: &Picks, cleared: Option<&str>) -> Self {
        let mut options: Vec<_> = ordered_dimensions(schema)
            .filter_map(|d| picks.get(&d.dimension_id).map(|o| (d.dimension_id.clone(), o.clone())))
            .collect();
        if options.is_empty()
            && let Some(dimension) = cleared
        {
            options.push((dimension.to_owned(), ANY.to_owned()));
        }
        Address { listing: None, offer: None, filtered: !options.is_empty(), options, ..self.clone() }
    }

    /// A listing chosen in the market book (`selectMarketListing`): its options are the selection.
    pub fn with_listing(&self, id: &str) -> Self {
        Address { listing: Some(id.to_owned()), offer: None, options: Vec::new(), filtered: false, ..self.clone() }
    }

    /// An offer chosen in the market book (`selectMarketOffer`).
    pub fn with_offer(&self, id: &str) -> Self {
        Address { offer: Some(id.to_owned()), listing: None, options: Vec::new(), filtered: false, ..self.clone() }
    }
}

/// Written in a fixed order, `buy` and the side's own tab left out. By hand, separators and
/// encoding included: a typed route cannot write keys that are data (todd-skelton/corten#71).
impl Params for Address {
    fn write_params(&self, first: &mut bool, html: bool, out: &mut String) {
        let mut pair = |key: &str, value: &str| {
            out.push_str(match (*first, html) {
                (true, _) => "?",
                (false, true) => "&amp;",
                (false, false) => "&",
            });
            *first = false;
            out.push_str(&segment(key));
            out.push('=');
            out.push_str(&segment(value));
        };
        if self.market != Market::Buy {
            pair("market", self.market.as_str());
        }
        if let Some(id) = &self.listing {
            pair("listing", id);
        }
        if let Some(id) = &self.offer {
            pair("offer", id);
        }
        if let Some(book) = self.book.filter(|b| *b != self.side_book()) {
            pair("book", book.as_str());
        }
        for (dimension, option) in &self.options {
            pair(&format!("dimension.{dimension}"), option);
        }
    }
}

/// A product's options: dimension id to option id.
pub type Picks = BTreeMap<String, String>;

/// The schema's dimensions in the order a product id names them (`getOrderedDimensions`).
pub fn ordered_dimensions(schema: &Schema) -> impl Iterator<Item = &Dimension> {
    schema
        .canonical_dimension_order
        .iter()
        .filter_map(|order| schema.dimensions.iter().find(|d| d.dimension_id == order.dimension_id))
}

/// Whether a dimension applies to `picks` (a grade only once the form is graded).
fn is_active(dimension: &Dimension, picks: &Picks) -> bool {
    dimension.applies_when.iter().all(|clause| picks.get(&clause.dimension_id).is_some_and(|o| clause.option_ids.contains(o)))
}

/// The dimensions that apply to `picks`, in order (`getOrderedActiveDimensions`).
pub fn active_dimensions<'a>(schema: &'a Schema, picks: &Picks) -> Vec<&'a Dimension> {
    ordered_dimensions(schema).filter(|d| is_active(d, picks)).collect()
}

/// `picks` without the options of dimensions that do not apply or do not have them
/// (`normalizeProductSearchOptionsForSchema`), dropped in order so a dropped form drops its grade.
pub fn normalize(schema: &Schema, picks: &Picks) -> Picks {
    let mut next = picks.clone();
    for dimension in ordered_dimensions(schema) {
        let keep = is_active(dimension, &next)
            && next.get(&dimension.dimension_id).is_some_and(|o| dimension.allowed_options.iter().any(|a| &a.option_id == o));
        if !keep {
            next.remove(&dimension.dimension_id);
        }
    }
    next
}

/// Every required dimension that applies has an option (`isProductSelectionComplete`).
fn is_complete(schema: &Schema, picks: &Picks) -> bool {
    let picks = normalize(schema, picks);
    active_dimensions(schema, &picks).iter().all(|d| !d.required || picks.contains_key(&d.dimension_id))
}

/// The product id the options name (`createDiscoveryProductDescriptor`):
/// `<item>::<dimension>:<option or ->|...` in canonical order, `<item>::` without dimensions.
fn product_id(item: &str, schema: Option<&Schema>, picks: &Picks) -> String {
    match schema.filter(|s| !s.dimensions.is_empty()) {
        None => format!("{item}::"),
        Some(schema) => {
            let picks = normalize(schema, picks);
            let parts: Vec<String> = schema
                .canonical_dimension_order
                .iter()
                .map(|d| format!("{}:{}", d.dimension_id, picks.get(&d.dimension_id).map_or("-", String::as_str)))
                .collect();
            format!("{item}::{}", parts.join("|"))
        }
    }
}

/// An option's name (`getOptionLabel`).
pub fn option_label(option: &DimensionOption) -> &str {
    option.label.as_deref().filter(|l| !l.is_empty()).unwrap_or(&option.code)
}

/// A dimension's options in the order the selector shows them (`getOrderedDimensionOptions`):
/// ordered by their order, numeric highest first, unordered as the schema lists them.
pub fn ordered_options(dimension: &Dimension) -> Vec<&DimensionOption> {
    let mut options: Vec<&DimensionOption> = dimension.allowed_options.iter().collect();
    let by_order = |a: &&DimensionOption, b: &&DimensionOption| {
        a.display_order
            .cmp(&b.display_order)
            .then_with(|| option_label(a).cmp(option_label(b)))
            .then_with(|| a.option_id.cmp(&b.option_id))
    };
    match dimension.value_kind.as_str() {
        "ordered" => options.sort_by(by_order),
        "numeric" => options.sort_by(|a, b| match (a.numeric_value, b.numeric_value) {
            (Some(x), Some(y)) if x != y => y.total_cmp(&x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => by_order(a, b),
        }),
        _ => {}
    }
    options
}

/// A listing's or an offer's product has every option in `picks` (`matchesSelectedOptions`).
fn matches(selected: &[Selected], picks: &Picks) -> bool {
    picks.iter().all(|(d, o)| selected.iter().any(|s| &s.dimension_id == d && &s.option_id == o))
}

fn picks_of(selected: &[Selected]) -> Picks {
    selected.iter().map(|s| (s.dimension_id.clone(), s.option_id.clone())).collect()
}

/// What the listing shows as available (`getListingAvailableQuantity`).
pub fn available(listing: &Listing) -> u64 {
    listing.visible_quantity.or(listing.quantity_cap).unwrap_or(0)
}

/// The prices of `entries` share one currency (`getCommonPriceCurrencyCode`).
fn common_currency<'a>(mut currencies: impl Iterator<Item = Option<&'a str>>) -> Option<&'a str> {
    let first = currencies.next()??;
    currencies.all(|c| c == Some(first)).then_some(first)
}

/// The options the page starts with (`getInitialSelections`): the address's, else the chosen
/// listing's or offer's, else the only listing's (or offer's, when selling).
fn initial_picks(item: &Item, address: &Address) -> Picks {
    let Some(schema) = &item.product_schema else { return Picks::new() };
    if address.filtered || !address.options.is_empty() {
        return normalize(schema, &address.options.iter().cloned().collect());
    }
    let listing = address.listing.as_ref().and_then(|id| item.market_listings.iter().find(|l| &l.listing_id == id));
    let offer = address.offer.as_ref().and_then(|id| item.offer_demand_matches.iter().find(|o| &o.offer_id == id));
    let explicit = match address.market {
        Market::Sell => offer.map(|o| &o.selected_options).or(listing.map(|l| &l.selected_options)),
        _ => listing.map(|l| &l.selected_options).or(offer.map(|o| &o.selected_options)),
    };
    if let Some(selected) = explicit {
        return normalize(schema, &picks_of(selected));
    }
    let only = match address.market {
        Market::Sell => match item.offer_demand_matches.as_slice() {
            [one] => picks_of(&one.selected_options),
            _ => Picks::new(),
        },
        _ => match item.market_listings.as_slice() {
            [one] => picks_of(&one.selected_options),
            _ => Picks::new(),
        },
    };
    normalize(schema, &only)
}

/// The market for the options chosen (`selectedMarketSummary`).
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Summary {
    pub lowest_price_amount: Option<String>,
    pub lowest_price_currency_code: Option<String>,
    pub active_listing_count: usize,
    pub total_visible_quantity: u64,
    pub sellers: usize,
    pub buyers: usize,
}

/// An option's market, the other options kept: its listings (or, when selling, the units its
/// offers request) and the lowest listing price (or highest offer), when they share a currency.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct OptionMarket {
    pub count: u64,
    pub price: Option<Money>,
}

/// Each dimension's options' markets, `None` for an option nothing has.
pub type OptionMarkets = BTreeMap<String, BTreeMap<String, Option<OptionMarket>>>;

/// The page's view model: the item, and what the address chose of it. A data client gets it.
#[derive(Serialize, ToJson)]
pub struct ItemScreen {
    pub item: Item,
    pub market: Market,
    pub picks: Picks,
    /// The product the options name, when they name one, or the chosen listing's or offer's.
    pub product_id: Option<String>,
    pub complete: bool,
    /// The listings a buyer can buy that match the options, best first.
    pub listings: Vec<Listing>,
    /// Every listing of the item, to count what the options hide.
    pub all_listings: usize,
    pub offers: Vec<Offer>,
    pub all_offers: usize,
    pub listing_id: Option<String>,
    /// The listing chosen was in the address (not the best available one).
    pub listing_explicit: bool,
    pub offer_id: Option<String>,
    pub offer_explicit: bool,
    /// The address chose a listing or an offer the options do not show any more.
    pub stale_listing: bool,
    pub stale_offer: bool,
    pub summary: Summary,
    /// For each dimension that applies and each of its options: how many entries and from what
    /// price, with the other options kept (`buildProductOptionSummaries`).
    pub option_summaries: OptionMarkets,
    /// The signed-in account, whose offers say so.
    pub viewer_account_id: Option<String>,
}

impl ItemScreen {
    pub fn of(item: Item, address: &Address, viewer_account_id: Option<String>) -> Self {
        let schema = item.product_schema.as_ref();
        let picks = initial_picks(&item, address);
        let complete = schema.is_none_or(|s| is_complete(s, &picks));
        let suppress = address.filtered && address.options.is_empty();
        let item_listings: Vec<&Listing> =
            item.market_listings.iter().filter(|l| l.catalog_catalog_item_id == item.catalog_item_id).collect();
        let item_offers: Vec<&Offer> =
            item.offer_demand_matches.iter().filter(|o| o.catalog_catalog_item_id == item.catalog_item_id).collect();
        let buyable: Vec<&Listing> = item_listings.iter().copied().filter(|l| available(l) > 0).collect();
        let visible: Vec<&Listing> =
            buyable.iter().copied().filter(|l| schema.is_none() || matches(&l.selected_options, &picks)).collect();
        let explicit_listing = address.listing.as_ref().and_then(|id| visible.iter().copied().find(|l| &l.listing_id == id));
        let selected_listing = explicit_listing.or(visible.first().copied());
        let single = (!complete && visible.len() == 1).then(|| visible[0]);
        let explicit_product = complete.then(|| product_id(&item.catalog_item_id, schema, &picks));
        let offers: Vec<&Offer> = item_offers
            .iter()
            .copied()
            .filter(|o| match &explicit_product {
                Some(id) => &o.product_id == id,
                None => schema.is_none() || matches(&o.selected_options, &picks),
            })
            .collect();
        let explicit_offer = address.offer.as_ref().and_then(|id| offers.iter().copied().find(|o| &o.offer_id == id));
        // The seller overlay (an account's own offers it can fill) is not ported, so the default
        // offer is the best one.
        let selected_offer = explicit_offer.or(offers.first().copied());
        let owned = explicit_listing.filter(|l| viewer_account_id.as_deref() == Some(l.account_id.as_str()));
        let product_id = explicit_product.clone().or_else(|| {
            if suppress {
                return None;
            }
            match address.market {
                Market::Sell => owned.map(|l| l.product_id.clone()).or(selected_offer.map(|o| o.product_id.clone())),
                _ => selected_listing.or(single).map(|l| l.product_id.clone()),
            }
        });
        let currency = common_currency(visible.iter().map(|l| l.price_currency_code.as_deref()));
        let first_priced = visible.first().filter(|l| platform::money::cents(&l.price_amount).is_some());
        let summary = Summary {
            lowest_price_amount: currency.and(first_priced).map(|l| l.price_amount.clone()),
            lowest_price_currency_code: first_priced.and(currency).map(str::to_owned),
            active_listing_count: visible.len(),
            total_visible_quantity: visible.iter().map(|l| available(l)).sum(),
            sellers: visible.iter().map(|l| &l.account_id).collect::<BTreeSet<_>>().len(),
            buyers: offers.iter().map(|o| &o.buyer_account_id).collect::<BTreeSet<_>>().len(),
        };
        let option_summaries = match schema {
            Some(schema) => option_summaries(schema, &picks, address.market, &buyable, &item_offers),
            None => BTreeMap::new(),
        };
        ItemScreen {
            market: address.market,
            complete,
            product_id,
            listings: visible.iter().map(|l| (*l).clone()).collect(),
            all_listings: item_listings.len(),
            offers: offers.iter().map(|o| (*o).clone()).collect(),
            all_offers: item_offers.len(),
            listing_id: selected_listing.map(|l| l.listing_id.clone()),
            listing_explicit: explicit_listing.is_some(),
            offer_id: selected_offer.map(|o| o.offer_id.clone()),
            offer_explicit: explicit_offer.is_some(),
            stale_listing: address.listing.is_some() && explicit_listing.is_none(),
            stale_offer: address.offer.is_some() && explicit_offer.is_none(),
            summary,
            option_summaries,
            viewer_account_id,
            picks,
            item,
        }
    }

    pub fn selected_listing(&self) -> Option<&Listing> {
        self.listing_id.as_ref().and_then(|id| self.listings.iter().find(|l| &l.listing_id == id))
    }

    pub fn selected_offer(&self) -> Option<&Offer> {
        self.offer_id.as_ref().and_then(|id| self.offers.iter().find(|o| &o.offer_id == id))
    }

    /// The options a listing or an offer names, as "Dimension: Option" pairs in order
    /// (`summarizeSelections`).
    pub fn describe<'a>(&'a self, selected: &[Selected]) -> Vec<(&'a str, &'a str)> {
        let Some(schema) = &self.item.product_schema else { return Vec::new() };
        let picks = picks_of(selected);
        active_dimensions(schema, &picks)
            .into_iter()
            .filter_map(|d| {
                let id = picks.get(&d.dimension_id)?;
                let option = d.allowed_options.iter().find(|o| &o.option_id == id)?;
                Some((d.dimension_name.as_str(), option_label(option)))
            })
            .collect()
    }

    /// The options chosen, described.
    pub fn chosen(&self) -> Vec<(&str, &str)> {
        let selected: Vec<Selected> =
            self.picks.iter().map(|(d, o)| Selected { dimension_id: d.clone(), option_id: o.clone() }).collect();
        self.describe(&selected)
    }
}

/// `buildProductOptionSummaries`: for each option, the entries that have it among those that
/// match the other options, their count (or the units requested, when selling) and the lowest
/// listing price (or highest offer), when they share a currency.
fn option_summaries(schema: &Schema, picks: &Picks, market: Market, listings: &[&Listing], offers: &[&Offer]) -> OptionMarkets {
    active_dimensions(schema, picks)
        .into_iter()
        .map(|dimension| {
            let mut others = picks.clone();
            others.remove(&dimension.dimension_id);
            let has = |selected: &[Selected], option: &str| {
                matches(selected, &others)
                    && selected.iter().any(|s| s.dimension_id == dimension.dimension_id && s.option_id == option)
            };
            let options = dimension
                .allowed_options
                .iter()
                .map(|option| {
                    let summary = if market == Market::Sell {
                        let hit: Vec<&&Offer> = offers.iter().filter(|o| has(&o.selected_options, &option.option_id)).collect();
                        (!hit.is_empty()).then(|| {
                            let price = common_currency(hit.iter().map(|o| o.price_currency_code.as_deref())).and_then(|c| {
                                hit.iter()
                                    .filter_map(|o| platform::money::cents(&o.price_amount).map(|cents| (cents, &o.price_amount)))
                                    .max_by_key(|(cents, _)| *cents)
                                    .map(|(_, amount)| Money { amount: amount.clone(), currency: c.to_owned() })
                            });
                            OptionMarket { count: hit.iter().map(|o| o.quantity_requested).sum(), price }
                        })
                    } else {
                        let hit: Vec<&&Listing> =
                            listings.iter().filter(|l| has(&l.selected_options, &option.option_id)).collect();
                        (!hit.is_empty()).then(|| {
                            let price = common_currency(hit.iter().map(|l| l.price_currency_code.as_deref())).and_then(|c| {
                                hit.iter()
                                    .filter_map(|l| platform::money::cents(&l.price_amount).map(|cents| (cents, &l.price_amount)))
                                    .min_by_key(|(cents, _)| *cents)
                                    .map(|(_, amount)| Money { amount: amount.clone(), currency: c.to_owned() })
                            });
                            OptionMarket { count: hit.len() as u64, price }
                        })
                    };
                    (option.option_id.clone(), summary)
                })
                .collect();
            (dimension.dimension_id.clone(), options)
        })
        .collect()
}

/// The item's address on marketplace's origin, which the pilot serves the same paths as: the
/// canonical link.
pub fn canonical(slug: &str) -> String {
    format!("{}{}", marketplace_origin(), url::Item { slug, state: Address::default() }.href())
}

async fn page(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    Query(raw): Query<Raw>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = match caller.item(&id).await {
        Ok(Some(item)) => item,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    // An id or an old slug moves to the item's slug for good, its parameters kept as sent.
    if let Some(slug) = item.slug.as_deref().filter(|slug| *slug != id) {
        let mut to = url::Item { slug, state: Address::default() }.href();
        if let Some(query) = uri.query() {
            to.push('?');
            to.push_str(query);
        }
        // Corten's `Req::redirect` is a 303 after a write; a page that moved needs a 301
        // (todd-skelton/corten#72).
        let to = HeaderValue::try_from(to).map_err(corten::Error::new)?;
        return Ok((StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, to)]).into_response());
    }
    let address = Address::read(&raw);
    let viewer = match req.context::<Session>() {
        Some(Session::Account(viewer)) => Some(viewer.actor.account_id.clone()),
        _ => None,
    };
    let screen = ItemScreen::of(item, &address, viewer);
    let t: ItemMsg = req.t();
    let item = &screen.item;
    let slug = item.slug.as_deref().unwrap_or(&item.catalog_item_id);
    let canonical = canonical(slug);
    let description =
        item.description.as_deref().filter(|d| !d.trim().is_empty()).unwrap_or(t.route_browse_the_chase_sets_marketplace_with());
    let title = t.route_meta_title(&item.title).to_string();
    let mut meta = Meta::new(title.clone())
        .description(description)
        .canonical(&canonical)
        .property("og:title", &title)
        .property("og:description", description)
        .property("og:type", "product");
    if let Some(image) = views::item_image(item) {
        meta = meta.property("og:image", &image.src);
    }
    if let Some(ld) = views::product_json_ld(item, &canonical) {
        meta = meta.json_ld(&ld);
    }
    if let Some(ld) = views::breadcrumb_json_ld(t, item, &canonical) {
        meta = meta.json_ld(&ld);
    }
    let view = views::item_page(t, &screen, &address, slug);
    req.screen(meta, &screen, view)
}
