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
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use corten::{
    LiveResponse,
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode, Uri},
    },
    prelude::*,
    route::Params,
};
use futures_util::StreamExt;
use platform::{realtime::Tick, receipt::Receipt};
use serde::{Deserialize, Serialize};

use crate::{
    api::{
        ApiError, Caller, Dimension, DimensionOption, Discovery, Item, Listing, MarketHistory as _, MarketStats,
        Marketplace as _, Money, Offer, RollupPoint, Schema, Selected, SellerOverlay, SeriesWindow, SimilarItem, StandardTerms,
    },
    app::{Shared, marketplace_origin, url},
    auth::Session,
    buying::{self, ADDED, BuyNotice},
    listing, saving, selling,
    text::ItemMsg,
    views, watching,
};

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

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Market::Buy => "buy",
            Market::Sell => "sell",
            Market::Watch => "watch",
        }
    }
}

/// The market book's tab (`MarketBookTab`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Book {
    Listings,
    Offers,
    /// The chosen product's market history (`ItemDetailMarketPanel`).
    Sales,
    Details,
}

impl Book {
    fn read(value: Option<&str>) -> Option<Self> {
        match value {
            Some("listings") => Some(Book::Listings),
            Some("offers") => Some(Book::Offers),
            Some("sales") => Some(Book::Sales),
            Some("details") => Some(Book::Details),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Book::Listings => "listings",
            Book::Offers => "offers",
            Book::Sales => "sales",
            Book::Details => "details",
        }
    }
}

/// The Sales tab's time range (`MarketHistoryRangeKey`), 90 days unless the address says
/// otherwise. Each is a lookback and a point a day, a week or a month: a year of days would be a
/// lot of chart for little more to read, and "all" stops at five years.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum Range {
    #[serde(rename = "30d")]
    Days30,
    #[default]
    #[serde(rename = "90d")]
    Days90,
    #[serde(rename = "1y")]
    Year,
    #[serde(rename = "all")]
    All,
}

impl Range {
    pub const EVERY: [Range; 4] = [Range::Days30, Range::Days90, Range::Year, Range::All];

    fn read(value: Option<&str>) -> Self {
        Range::EVERY.into_iter().find(|r| Some(r.as_str()) == value).unwrap_or_default()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Range::Days30 => "30d",
            Range::Days90 => "90d",
            Range::Year => "1y",
            Range::All => "all",
        }
    }

    /// The days from `today` back that the range covers, and its points' granularity
    /// (`resolveMarketHistoryRangeWindow`).
    pub fn window(self, today: time::Date) -> SeriesWindow {
        let (days, granularity) = match self {
            Range::Days30 => (30, "daily"),
            Range::Days90 => (90, "daily"),
            Range::Year => (365, "weekly"),
            Range::All => (1825, "monthly"),
        };
        SeriesWindow { from: (today - time::Duration::days(days)).to_string(), to: today.to_string(), granularity }
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
    pub fn all(&self) -> &[String] {
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
    /// The Sales tab's range (`range=30d|90d|1y|all`); marketplace keeps it in React state.
    pub range: Range,
    /// `dimension.<id>=<option>`, each dimension given exactly one option, in key order.
    pub options: Vec<(String, String)>,
    /// A `dimension.*` parameter had a value (`hasInitialSelectedOptionFilters`).
    pub filtered: bool,
}

/// What a write on the item page left for the page to say, each the write's receipt (empty for
/// none): a seller's write (`after_write`, `listing::WRITTEN`), Set alert (`watched`), Add to List's
/// Add Product (`saved` with the list, the quantity added and the line's status) and Add to cart
/// (`added`). The page reads them from its query; a redirect after the write writes them.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct After {
    pub after_write: Option<String>,
    pub watched: Option<String>,
    pub saved: Option<String>,
    pub saved_list: Option<String>,
    pub saved_quantity: Option<String>,
    pub saved_line: Option<String>,
    pub added: Option<String>,
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
            range: Range::read(first("range")),
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

    pub fn with_range(&self, range: Range) -> Self {
        Address { range, ..self.clone() }
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

/// The address as query parameters, in a fixed order: `buy` and the side's own tab left out,
/// then `dimension.<id>=<option>` in the schema's order.
#[derive(Route)]
#[route(query)]
struct AddressQuery<'a> {
    market: Option<&'a str>,
    listing: Option<&'a str>,
    offer: Option<&'a str>,
    book: Option<&'a str>,
    range: Option<&'a str>,
    #[route(prefix = "dimension.")]
    dimensions: &'a [(String, String)],
}

/// The address read from the whole query, as `read` reads it, so the route's `Params` take it.
impl<'de> Deserialize<'de> for Address {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Raw::deserialize(deserializer).map(|raw| Address::read(&raw))
    }
}

impl corten::route::QueryParams for Address {
    fn write_params(&self, first: &mut bool, html: bool, out: &mut String) {
        AddressQuery {
            market: (self.market != Market::Buy).then(|| self.market.as_str()),
            listing: self.listing.as_deref(),
            offer: self.offer.as_deref(),
            book: self.book.filter(|b| *b != self.side_book()).map(Book::as_str),
            range: (self.range != Range::default()).then(|| self.range.as_str()),
            dimensions: &self.options,
        }
        .write_params(first, html, out)
    }
}

impl Address {
    /// The address's parameters, in the order they are written; a form that posts the page's
    /// choices sends them as hidden fields.
    pub fn pairs(&self) -> Vec<(String, String)> {
        let mut pairs = Vec::new();
        if self.market != Market::Buy {
            pairs.push(("market".to_owned(), self.market.as_str().to_owned()));
        }
        if let Some(id) = &self.listing {
            pairs.push(("listing".to_owned(), id.clone()));
        }
        if let Some(id) = &self.offer {
            pairs.push(("offer".to_owned(), id.clone()));
        }
        if let Some(book) = self.book.filter(|b| *b != self.side_book()) {
            pairs.push(("book".to_owned(), book.as_str().to_owned()));
        }
        if self.range != Range::default() {
            pairs.push(("range".to_owned(), self.range.as_str().to_owned()));
        }
        for (dimension, option) in &self.options {
            pairs.push((format!("dimension.{dimension}"), option.clone()));
        }
        pairs
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
    /// The chosen product's options and their words (`selectedProductOptions`,
    /// `selectedProductSummary`), which a cart line keeps.
    pub product_options: Vec<Selected>,
    pub product_summary: Option<String>,
    /// What a guest would be paid for the offer shown, under the public standard seller terms
    /// (`attachPublicStandardOfferTerms`); none for an account or when the API has none.
    pub offer_terms: Option<StandardTerms>,
    /// The viewer sees the item as a seller (`canUseSellerFeatures`).
    pub seller_features: bool,
    /// The viewer may list at a price (`canUseListingFeatures`: `listings.view` and
    /// `listings.manage`).
    pub listing_features: bool,
    /// The viewer has no account sell list (a guest), so a listing is a draft they register to
    /// claim (`canUseGuestListingDraft`).
    pub guest_listing_draft: bool,
    /// The listing the address names was just published and the item's read is behind it: its id.
    pub listing_pending: Option<String>,
    /// Whether a seller who may list has their ship-from setup.
    pub listing_setup: ListingSetup,
    /// Items like this one, under the market book; none when the read failed.
    pub similar: Vec<SimilarItem>,
    /// The Sales tab's market history, read only when it is the tab shown.
    pub history: Option<History>,
    /// What Add to List can do for the viewer, with an account's recent lists.
    pub save: saving::SaveState,
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
        // The options the product is named by: the ones chosen when they are all there, else the
        // listing's or offer's the product came from.
        let chosen: Vec<(&Dimension, &DimensionOption)> = schema
            .map(|s| {
                active_dimensions(s, &picks)
                    .into_iter()
                    .filter_map(|d| {
                        let id = picks.get(&d.dimension_id)?;
                        Some((d, d.allowed_options.iter().find(|o| &o.option_id == id)?))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let explicit_options: Vec<Selected> = schema
            .map(|s| {
                active_dimensions(s, &picks)
                    .into_iter()
                    .filter_map(|d| {
                        picks
                            .get(&d.dimension_id)
                            .map(|o| Selected { dimension_id: d.dimension_id.clone(), option_id: o.clone() })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let explicit_summary =
            (!chosen.is_empty()).then(|| chosen.iter().map(|(_, o)| option_label(o)).collect::<Vec<_>>().join(" / "));
        let offer_for_product =
            (!suppress && address.market == Market::Sell && owned.is_none()).then_some(selected_offer).flatten();
        let listing_for_product =
            (!suppress && (address.market != Market::Sell || owned.is_some())).then(|| owned.or(selected_listing)).flatten();
        let single_for_product = (!suppress).then_some(single).flatten();
        let from = offer_for_product
            .map(|o| (&o.selected_options, &o.product_summary))
            .or(listing_for_product.map(|l| (&l.selected_options, &l.product_summary)))
            .or(single_for_product.map(|l| (&l.selected_options, &l.product_summary)));
        let product_options = match from {
            Some((options, _)) if !complete => options.clone(),
            _ => explicit_options,
        };
        let product_summary = explicit_summary.or_else(|| from.and_then(|(_, summary)| summary.clone()));
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
            product_options,
            product_summary,
            offer_terms: None,
            seller_features: false,
            listing_features: false,
            guest_listing_draft: false,
            listing_pending: None,
            listing_setup: ListingSetup::NotApplicable,
            similar: Vec::new(),
            history: None,
            save: saving::SaveState::Unread,
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

    /// The rail analytics' workflow and selection for `market` with the page's choices
    /// (`itemDetailRailAnalyticsWorkflow`, `itemDetailRailAnalyticsSelection`): the listing or
    /// offer chosen, from the address (`explicit`) or the best one (`implicit`), or the product.
    pub fn rail_labels(&self, market: Market) -> (&'static str, &'static str) {
        let source = |explicit: bool| if explicit { "explicit" } else { "implicit" };
        match market {
            Market::Watch => ("watch", "none"),
            Market::Sell if self.selected_offer().is_some() => {
                (if self.offer_explicit { "selected_offer" } else { "best_offer" }, source(self.offer_explicit))
            }
            Market::Buy if self.selected_listing().is_some() => {
                (if self.listing_explicit { "selected_listing" } else { "best_available_listing" }, source(self.listing_explicit))
            }
            Market::Sell | Market::Buy => ("selected_product", "none"),
        }
    }

    /// Who is looking, for the rail analytics: `signed_in` or `guest`.
    pub fn rail_viewer(&self) -> &'static str {
        if self.viewer_account_id.is_some() { "signed_in" } else { "guest" }
    }

    /// The viewer's own listing of the product shown (marketplace's `ownListing`): the listing
    /// the address chose when it is theirs, else their listing of the product among the buyable
    /// ones. Only for a viewer who may list.
    pub fn own_listing(&self) -> Option<&Listing> {
        let viewer = self.viewer_account_id.as_deref().filter(|_| self.listing_features)?;
        let product = self.product_id.as_deref()?;
        self.selected_listing()
            .filter(|l| self.listing_explicit && l.account_id == viewer)
            .or_else(|| self.listings.iter().find(|l| l.account_id == viewer && l.product_id == product))
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
    format!("{}{}", marketplace_origin(), url::Item { slug, state: Address::default(), after: Default::default() }.href())
}

pub(crate) async fn page(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Item<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let id = route.slug;
    let session = session.as_deref();
    let first = |key: &str| raw.get(key).and_then(|v| v.all().first());
    // After a seller's write (a listing, the ship-from setup), the page reads with its receipt, so
    // the listing or the setup is there. A read the write's projection has not caught up with yet
    // is the page as it is now, read again shortly until the receipt is too old to wait for.
    let receipt = first(listing::WRITTEN).and_then(|r| Receipt::from_param(Some(r)));
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let address = Address::read(&raw);
    // The item, the seller overlay and the similar items at once: with a receipt, the first two
    // may wait on the API for the write's projection (2.5 s at most), and one after the other
    // would wait twice. The similar items wait for no write, so they read without the receipt.
    let unwaited = config.platform.caller(&headers, config.proto, None);
    // Add to List's recent lists wait for Add Product's receipt only when its list is not there.
    let saved = first(saving::SAVED).and_then(|r| Receipt::from_param(Some(r)));
    let waited = config.platform.caller(&headers, config.proto, saved.as_ref());
    let saved_list = first(saving::SAVED_LIST).map_or("", String::as_str);
    let (read, overlay, similar, save) = tokio::join!(
        caller.item(&id),
        read_overlay(session, &caller, &id, &address),
        similar_items(&unwaited, &id),
        saving::state_after(session, &unwaited, &waited, saved_list)
    );
    let (item, behind) = match read {
        Ok(Some(item)) => (Some(item), false),
        Ok(None) if receipt.is_none() => (None, false),
        Err(error) if receipt.is_none() || !error.catching_up() => {
            return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY));
        }
        _ => (None, true),
    };
    let item = match item {
        Some(item) => item,
        None if !behind => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        None => match unwaited.item(&id).await {
            Ok(Some(item)) => item,
            Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
            Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    // An id or an old slug moves to the item's slug for good, its parameters kept as sent.
    if let Some(slug) = item.slug.as_deref().filter(|slug| *slug != id) {
        let mut to = url::Item { slug, state: Address::default(), after: Default::default() }.href();
        if let Some(query) = uri.query() {
            to.push('?');
            to.push_str(query);
        }
        let to: Uri = to.parse().map_err(corten::Error::new)?;
        return req.moved(&to);
    }
    // After Add to cart, the page says so; View buy cart waits for the write's receipt.
    // After Set alert, the page says so; the alerts' settings wait for the write's receipt.
    let notice = first(ADDED)
        .map(|receipt| BuyNotice::Added(buying::cart_href(receipt)))
        .or_else(|| first(watching::WATCHED).map(|receipt| BuyNotice::Watched(watching::alerts_href(receipt))))
        .or_else(|| saving::saved(|key| first(key).cloned(), &save).map(BuyNotice::Saved));
    let (terms, history) =
        tokio::join!(offer_terms(session, &caller, &item, &address), market_history(&unwaited, &item, &address));
    let setup = listing_setup(&req, overlay, receipt.is_some());
    // The listing the address names was just published and the item's read is behind it.
    let listing_pending = address.listing.clone().filter(|_| behind && receipt.is_some());
    let behind = behind || setup == ListingSetup::Recovering;
    let reads = PageReads { terms, behind, setup, listing_pending, similar, history, save };
    render(&req, session, item, &address, notice.as_ref(), StatusCode::OK, reads)
}

/// The Sales tab's market history (`market-history-loader.ts`), when it is the tab shown: the
/// product's market stats, then for each currency it has sold in, its sale prices over the
/// address's range. Marketplace's panel fetches it after the page loads; the pilot reads it with
/// the page, so the tab works without a script. Any read failing is the tab's error.
async fn market_history(caller: &Caller<'_>, item: &Item, address: &Address) -> Option<History> {
    if address.book() != Book::Sales {
        return None;
    }
    let Some(product) = ItemScreen::of(item.clone(), address, None).product_id else {
        return Some(History::NoProduct);
    };
    let id = &item.catalog_item_id;
    let stats = match caller.market_stats(id, &product).await {
        Ok(stats) => stats,
        Err(error) => {
            tracing::warn!("the market stats' read failed: {error}");
            return Some(History::Failed);
        }
    };
    let window = address.range.window(time::OffsetDateTime::now_utc().date());
    let mut series = Vec::with_capacity(stats.aggregates.len());
    for aggregate in &stats.aggregates {
        match caller.rollup_series(id, &product, &aggregate.currency_code, &window).await {
            Ok(points) => series.push((aggregate.currency_code.clone(), points)),
            Err(error) => {
                tracing::warn!("the market series' read failed: {error}");
                return Some(History::Failed);
            }
        }
    }
    Some(History::Read { stats, series })
}

/// What the Sales tab shows.
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum History {
    /// The options name no product: the tab asks for one.
    NoProduct,
    Failed,
    /// The stats, and each currency's sale prices.
    Read {
        stats: MarketStats,
        series: Vec<(String, Vec<RollupPoint>)>,
    },
}

/// Items like item `id` (a slug or an id). Marketplace's loader reads a failure as none, and so
/// does the pilot: the section is left out.
async fn similar_items(caller: &Caller<'_>, id: &str) -> Vec<SimilarItem> {
    caller.similar(id).await.unwrap_or_else(|error| {
        tracing::warn!("the similar items' read failed: {error}");
        Vec::new()
    })
}

/// What the page reads beyond the item: the Sell tab's, a guest's offer terms (`offer_terms`)
/// and for a seller who may list their ship-from setup (the seller overlay); and the similar
/// items, which only the page's own read has (a refused form's page leaves them out).
/// `after_write`: the read carries a write's receipt, so a read that is not caught up is the
/// setup still updating.
#[derive(Default)]
pub struct PageReads {
    pub terms: Option<StandardTerms>,
    pub setup: ListingSetup,
    /// A read is behind the write the address carries: the page asks to be read again.
    pub behind: bool,
    /// The listing the address names was just published and the item's read has not caught up:
    /// the page says so instead of offering to list again. Its id.
    pub listing_pending: Option<String>,
    pub similar: Vec<SimilarItem>,
    pub history: Option<History>,
    /// Add to List's state; a page that answers another form leaves it unread.
    pub save: saving::SaveState,
}

/// Whether a seller who may list can list now (marketplace's `ListingSetupLoadState`): their
/// quick listings ship from a Listing stock location, which the seller overlay says they have.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ListingSetup {
    /// The viewer may not list, or the page is not on its Sell tab.
    #[default]
    NotApplicable,
    Ready,
    /// No Listing stock location: the ship-from setup form is shown.
    Missing,
    /// The setup was just saved and its read has not caught up yet.
    Recovering,
    /// The overlay's read failed, for this reason; neither form can be used.
    Failed(String),
}

/// The Sell tab's reads for `item` at `address` (`sell_reads` without a receipt for a
/// refused form).
pub async fn sell_reads(
    req: &Req,
    session: Option<&Session>,
    caller: &Caller<'_>,
    item: &Item,
    address: &Address,
    after_write: bool,
) -> PageReads {
    let id = item.slug.as_deref().unwrap_or(&item.catalog_item_id);
    let (terms, overlay) = tokio::join!(offer_terms(session, caller, item, address), read_overlay(session, caller, id, address));
    let setup = listing_setup(req, overlay, after_write);
    PageReads {
        terms,
        behind: setup == ListingSetup::Recovering,
        setup,
        listing_pending: None,
        similar: Vec::new(),
        history: None,
        save: saving::SaveState::Unread,
    }
}

/// The seller overlay of item `id` (a slug or an id), when the page shows it: on the Sell tab,
/// to a seller who may list.
async fn read_overlay(
    session: Option<&Session>,
    caller: &Caller<'_>,
    id: &str,
    address: &Address,
) -> Option<Result<SellerOverlay, ApiError>> {
    if address.market != Market::Sell || !listing::listing_features(session) {
        return None;
    }
    Some(caller.seller_overlay(id).await)
}

/// The ship-from setup the overlay's read says (`after_write`: the read carries a write's
/// receipt, so one that is not caught up is the setup still updating).
fn listing_setup(req: &Req, overlay: Option<Result<SellerOverlay, ApiError>>, after_write: bool) -> ListingSetup {
    let t: ItemMsg = req.t();
    match overlay {
        None => ListingSetup::NotApplicable,
        Some(Ok(overlay)) if overlay.has_listing_stock_location => ListingSetup::Ready,
        Some(Ok(_)) => ListingSetup::Missing,
        Some(Err(error)) if after_write && error.catching_up() => ListingSetup::Recovering,
        Some(Err(error)) => {
            tracing::warn!("the seller overlay's read failed: {error}");
            ListingSetup::Failed(error.refusal().unwrap_or(t.route_ship_from_setup_required()).to_owned())
        }
    }
}

/// The standard terms for the offer a guest's Sell rail shows (marketplace reads them for every
/// offer of the item; the rail shows one). None when the API has none: the rail then says the
/// terms are worked out before acceptance, as marketplace does.
pub async fn offer_terms(
    session: Option<&Session>,
    caller: &Caller<'_>,
    item: &Item,
    address: &Address,
) -> Option<StandardTerms> {
    if address.market != Market::Sell || selling::account_sell_list(session) {
        return None;
    }
    let screen = ItemScreen::of(item.clone(), address, None);
    let price = screen.selected_offer()?.price_amount.clone();
    match caller.standard_terms(&price).await {
        Ok(terms) => Some(terms),
        Err(error) => {
            tracing::warn!("the standard terms preview failed: {error}");
            None
        }
    }
}

/// Who is looking at the page, as far as the page's parts differ for them.
#[derive(Clone)]
struct Viewing {
    viewer: Option<String>,
    seller_features: bool,
    listing_features: bool,
    guest_listing_draft: bool,
}

impl Viewing {
    fn of(session: Option<&Session>) -> Self {
        let viewer = session.and_then(Session::viewer).map(|viewer| viewer.actor.account_id.clone());
        Viewing {
            viewer,
            seller_features: selling::seller_features(session),
            listing_features: listing::listing_features(session),
            guest_listing_draft: !selling::account_sell_list(session),
        }
    }

    fn screen(&self, item: Item, address: &Address) -> ItemScreen {
        let mut screen = ItemScreen::of(item, address, self.viewer.clone());
        screen.seller_features = self.seller_features;
        screen.listing_features = self.listing_features;
        screen.guest_listing_draft = self.guest_listing_draft;
        screen
    }
}

/// The page's market parts for `<corten-live>` (marketplace's `useRealtimePatchedSnapshot` on
/// the item's topics): on each change to the item (`item:{id}`, which its listings', offers' and
/// Pricing's market stats' patches name), the item is read again, and its market summary, market
/// book (with the Sales tab's history when it is the tab shown) and the mobile dock are drawn
/// again. The rail and the options are not: they hold forms, and a redraw is a read the buyer
/// did not ask for. Each fragment carries the realtime stream's cursor, so a reconnect goes on
/// from there. Marketplace also listens to `public:market`, every change in the marketplace;
/// the item's own topic carries every change the page shows.
pub(crate) async fn live(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: corten::LiveSince,
    Params(route): Params<url::ItemLive<'_>>,
    Form(raw): Form<Raw>,
) -> LiveResponse {
    let id = route.id;
    let session = session.as_deref();
    let (t, viewing, address): (ItemMsg, _, _) = (req.t(), Viewing::of(session), Address::read(&raw));
    let topic = format!("item:{id}");
    let changes = config.platform.caller(&headers, config.proto, None).changes(&[&topic], since.0);
    let fragments = changes
        .take_while(|tick| std::future::ready(!matches!(tick, Tick::Refused(_))))
        .filter_map(|tick| {
            std::future::ready(match tick {
                Tick::Changed(cursor, _) => Some(cursor),
                // The page was drawn just now; a reconnect resumes from its last cursor.
                Tick::Opened(_) | Tick::Refused(_) => None,
            })
        })
        .then(move |cursor| {
            let (config, headers, id, address, viewing) =
                (config.clone(), headers.clone(), id.clone(), address.clone(), viewing.clone());
            async move {
                let caller = config.platform.caller(&headers, config.proto, None);
                let item = match caller.item(&id).await {
                    Ok(Some(item)) => item,
                    Ok(None) => return None,
                    Err(error) => {
                        tracing::warn!("the item's read for a change failed: {error}");
                        return None;
                    }
                };
                let history = market_history(&caller, &item, &address).await;
                let slug = item.slug.clone().unwrap_or_else(|| item.catalog_item_id.clone());
                let mut screen = viewing.screen(item, &address);
                screen.history = history;
                let html = views::item_live_parts(t, &screen, &address, &slug).to_html();
                Some(match cursor {
                    Some(cursor) => corten::Fragment::new(html).cursor(cursor),
                    None => corten::Fragment::new(html),
                })
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

/// The page for `item` at `address`, with what a buy or sell write came to, and what the Sell tab
/// read (`sell_reads`).
pub fn render(
    req: &Req,
    session: Option<&Session>,
    item: Item,
    address: &Address,
    notice: Option<&BuyNotice>,
    status: StatusCode,
    reads: PageReads,
) -> HtmlResult {
    let mut screen = Viewing::of(session).screen(item, address);
    screen.offer_terms = reads.terms;
    screen.listing_setup = reads.setup;
    // A listing still catching up is not "unavailable": the rail says it is on its way.
    screen.stale_listing &= reads.listing_pending.is_none();
    screen.listing_pending = reads.listing_pending;
    screen.similar = reads.similar;
    screen.history = reads.history;
    screen.save = reads.save;
    let behind = reads.behind;
    let t: ItemMsg = req.t();
    let item = &screen.item;
    let slug = item.slug.as_deref().unwrap_or(&item.catalog_item_id);
    let canonical = canonical(slug);
    let description =
        item.description.as_deref().filter(|d| !d.trim().is_empty()).unwrap_or(t.route_browse_the_chase_sets_marketplace_with());
    let title = t.route_meta_title(&item.title).to_string();
    let image = views::item_image(item).map(|image| image.src.clone());
    let product = views::product_json_ld(item, &canonical);
    let breadcrumb = views::breadcrumb_json_ld(t, item, &canonical);
    let og_title = title.as_str();
    let head = html! {
        <meta name="description" content={description}>
        <link rel="canonical" href={&canonical}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={description}>
        <meta property="og:type" content="product">
        if let Some(image) = &image {
            <meta property="og:image" content={image}>
        }
        if let Some(ld) = &product {
            <JsonLd value={ld} />
        }
        if let Some(ld) = &breadcrumb {
            <JsonLd value={ld} />
        }
        // Read again in 2 s while a read is behind the write the address carries, as the cart
        // does, until the receipt is too old to wait for.
        if behind {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let view = views::item_page(t, &screen, address, slug, notice);
    req.screen_with_status(
        status,
        &screen,
        html! {
            <views::Layout req={req} viewer={session.and_then(Session::viewer)} title={&title} head={head}>{view}</views::Layout>
        },
    )
}
