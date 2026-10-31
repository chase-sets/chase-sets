//! Create listing (marketplace's `account-listings-new` route): a product (one of the seller's
//! inventory items, or a catalog item and its options, whose Listing stock the create ensures),
//! a price, a quantity, purchase limits, photos, and Save as draft or Create and publish.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/listings/new?<form>` | the form, as the address and the API say: the catalog search's matches, the chosen item's options, the evidence the inventory item needs, the fee preview |
//! | `POST /account/listings/new` | create the listing with its photos (multipart), publish it if asked, then marketplace's listing page |
//!
//! Every step before the write is a `GET` of the page with the form's fields (the form's buttons
//! that ask for nothing to change are `formmethod="get"`): Find, Choose, another item, Update
//! options, Use this inventory and Preview fees. The address keeps marketplace's names, so its
//! links work here (`catalogItemId`, `selectedOptions`, `inventoryItemId`, `recommendedPrice`,
//! `claimListingIntent`); a product's options are `option.<dimension>`. With JavaScript the same
//! `GET`s answer the form's parts as a patch, so the photos chosen stay chosen, and a changed
//! option or inventory item draws them at once.
//!
//! The create is one attempt (the form's `SubmitKey`): the Listing stock's ensure applies once
//! per attempt and the listing's id is made from it (`listingIdOverride`), so the same form sent
//! again is the same listing, where marketplace's creates another. The form posts its photos as
//! `multipart/form-data`, read with Corten's `Upload` (`uploads::read`), with the purchase limits as
//! their own fields, as marketplace's form sends them since chase-sets/chase-sets#10650.
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
    security::cookie,
};
use serde::Deserialize;

use crate::{
    api::{
        ApiError, CatalogItem, ClaimedDraft, CreatedListing, EvidenceReadiness, ListingCreate as _, Listings as _, Photo, Schema,
        Selected, Suggestion, SupplyItem, TermsPreview,
    },
    app::{LISTINGS_VIEW, Shared, read_failed, sign_in},
    auth::{ListingSeller, Viewer},
    items::{self, Picks, Raw},
    listing::{ANONYMOUS_LISTING_DRAFT_COOKIE, listing_id},
    recovery::valid_attempt,
    text::{ListingNewMsg, Pilot},
    uploads::{self, Limits, Over},
    views::{self, Layout},
};

/// The Listing stock location a quick listing ships from (`LISTING_STOCK_LOCATION_NAME`).
const STOCK_NAME: &str = "Listing stock";
/// A product option's parameter: `option.<dimension id>=<option id>`.
pub const OPTION: &str = "option.";
/// What the platform API takes of a listing's photos (`LISTING_PHOTO_UPLOAD_CONTENT_TYPES`, the
/// launch gate policy's 10 MB each, 24 at most, 60 MB in all).
pub const PICTURES: &str = "image/jpeg,image/png,image/webp";
pub const LIMITS: Limits = Limits { file: 10 * 1024 * 1024, files: 24, whole: 60 * 1024 * 1024 + 64 * 1024 };
/// How long a create with photos may take, here and at the API.
pub const DEADLINE: Duration = Duration::from_secs(150);

/// The form's fields, for their names: marketplace's, so its links and the form agree.
#[derive(Deserialize, Fields)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ListingFields {
    pub attempt: String,
    pub intent: String,
    pub q: String,
    /// A search result's Choose.
    pub choose: String,
    /// Choose another item.
    pub change: String,
    pub catalog_item_id: String,
    pub selected_options: String,
    pub recommended_price: String,
    pub claim_listing_intent: String,
    pub inventory_item_id: String,
    pub price_amount: String,
    pub price_currency_code: String,
    pub quantity_cap: String,
    pub max_units_per_order: String,
    pub max_units_per_day: String,
    pub max_units_per_customer_account: String,
    pub ship_from_name: String,
    pub ship_from_line1: String,
    pub ship_from_city: String,
    pub ship_from_state: String,
    pub ship_from_postal_code: String,
    pub ship_from_country: String,
    pub evidence: String,
    pub preview: String,
    pub redraw: String,
}

/// The two buttons that write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Draft,
    Publish,
}

impl Intent {
    pub fn as_str(self) -> &'static str {
        match self {
            Intent::Draft => "create-listing",
            Intent::Publish => "create-and-publish-listing",
        }
    }

    fn read(text: &str) -> Option<Self> {
        match text {
            "create-listing" => Some(Intent::Draft),
            "create-and-publish-listing" => Some(Intent::Publish),
            _ => None,
        }
    }
}

/// A ship-from address typed for an account without its Listing stock (`shipFromAddressFromForm`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShipFrom {
    pub name: String,
    pub line1: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
}

impl ShipFrom {
    /// The address the ensure sends, or `None` when nothing was typed.
    fn body(&self) -> Option<serde_json::Value> {
        let typed = [&self.name, &self.line1, &self.city, &self.state, &self.postal_code];
        if typed.iter().all(|v| v.is_empty()) {
            return None;
        }
        let country = if self.country.is_empty() { "US" } else { &self.country };
        Some(serde_json::json!({
            "name": self.name, "line1": self.line1, "city": self.city, "state": self.state,
            "postalCode": self.postal_code, "country": country,
        }))
    }
}

/// What the form holds, from the address or the post.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub q: String,
    pub catalog_item_id: String,
    /// The options as given (`option.<id>`, else marketplace's `selectedOptions` JSON).
    pub options: Picks,
    /// The item was just chosen: its options start at their defaults.
    pub chosen: bool,
    pub inventory_item_id: String,
    pub price_amount: String,
    pub price_currency_code: String,
    pub quantity_cap: String,
    pub max_units_per_order: String,
    pub max_units_per_day: String,
    pub max_units_per_customer_account: String,
    pub ship_from: ShipFrom,
    pub claim: String,
    pub preview: bool,
    /// The form asked for its parts again (a patch, with JavaScript).
    pub redraw: bool,
}

impl Default for Draft {
    fn default() -> Self {
        Draft {
            q: String::new(),
            catalog_item_id: String::new(),
            options: Picks::new(),
            chosen: false,
            inventory_item_id: String::new(),
            price_amount: String::new(),
            price_currency_code: String::new(),
            quantity_cap: "1".into(),
            max_units_per_order: String::new(),
            max_units_per_day: String::new(),
            max_units_per_customer_account: String::new(),
            ship_from: ShipFrom { country: "US".into(), ..ShipFrom::default() },
            claim: String::new(),
            preview: false,
            redraw: false,
        }
    }
}

/// A field's first value, trimmed.
pub(crate) fn first(raw: &Raw, key: &str) -> String {
    raw.get(key).and_then(|v| v.all().first()).map(|v| v.trim().to_owned()).unwrap_or_default()
}

/// marketplace's `selectedOptions` parameter: a JSON list of `{dimensionId, optionId}`.
fn selected_options(text: &str) -> Picks {
    serde_json::from_str::<Vec<Selected>>(text)
        .map(|list| {
            list.into_iter()
                .filter(|s| !s.dimension_id.is_empty() && !s.option_id.is_empty())
                .map(|s| (s.dimension_id, s.option_id))
                .collect()
        })
        .unwrap_or_default()
}

impl Draft {
    pub fn read(raw: &Raw) -> Self {
        let f = ListingFields::FIELDS;
        let get = |name: FieldName| first(raw, name.as_str());
        let chosen = get(f.choose);
        let change = !get(f.change).is_empty();
        let mut options: Picks = raw
            .iter()
            .filter_map(|(key, values)| {
                let dimension = key.strip_prefix(OPTION)?.trim();
                let option = values.all().first()?.trim();
                (!dimension.is_empty() && !option.is_empty()).then(|| (dimension.to_owned(), option.to_owned()))
            })
            .collect();
        if options.is_empty() {
            options = selected_options(&get(f.selected_options));
        }
        let catalog_item_id = match (change, chosen.is_empty()) {
            (true, _) => String::new(),
            (false, false) => chosen.clone(),
            (false, true) => get(f.catalog_item_id),
        };
        if change || !chosen.is_empty() {
            options.clear();
        }
        let price = Some(get(f.price_amount)).filter(|p| !p.is_empty()).unwrap_or_else(|| get(f.recommended_price));
        let given = |name: FieldName, or: &str| Some(get(name)).filter(|v| !v.is_empty()).unwrap_or_else(|| or.to_owned());
        Draft {
            q: get(f.q),
            catalog_item_id,
            options,
            chosen: !chosen.is_empty() && !change,
            inventory_item_id: get(f.inventory_item_id),
            price_amount: price,
            price_currency_code: get(f.price_currency_code),
            quantity_cap: given(f.quantity_cap, "1"),
            max_units_per_order: get(f.max_units_per_order),
            max_units_per_day: get(f.max_units_per_day),
            max_units_per_customer_account: get(f.max_units_per_customer_account),
            ship_from: ShipFrom {
                name: get(f.ship_from_name),
                line1: get(f.ship_from_line1),
                city: get(f.ship_from_city),
                state: get(f.ship_from_state),
                postal_code: get(f.ship_from_postal_code),
                country: given(f.ship_from_country, "US"),
            },
            claim: get(f.claim_listing_intent),
            preview: !get(f.preview).is_empty(),
            redraw: !get(f.redraw).is_empty() || !get(f.choose).is_empty() || change || !get(f.preview).is_empty(),
        }
    }

    /// The form a claimed guest draft starts (`createFormFromClaimedDraft`).
    fn claimed(claim: ClaimedDraft) -> Self {
        let limit = |n: Option<u64>| n.map(|n| n.to_string()).unwrap_or_default();
        Draft {
            catalog_item_id: claim.catalog_item_id,
            options: claim.selected_options.into_iter().map(|s| (s.dimension_id, s.option_id)).collect(),
            price_amount: claim.price_amount,
            price_currency_code: claim.price_currency_code.unwrap_or_default(),
            quantity_cap: claim.quantity_cap.to_string(),
            max_units_per_order: limit(claim.max_units_per_order),
            max_units_per_day: limit(claim.max_units_per_day),
            max_units_per_customer_account: limit(claim.max_units_per_customer_account),
            ..Draft::default()
        }
    }
}

/// `picks` as `normalizeProductSelection` makes them: each dimension that applies keeps an
/// option it allows, and a required one without takes its first; the rest are dropped.
pub fn with_defaults(schema: &Schema, picks: &Picks) -> Picks {
    let mut next = picks.clone();
    for dimension in items::ordered_dimensions(schema) {
        let applies = dimension
            .applies_when
            .iter()
            .all(|clause| next.get(&clause.dimension_id).is_some_and(|o| clause.option_ids.contains(o)));
        let allowed = |o: &String| dimension.allowed_options.iter().any(|a| &a.option_id == o);
        match (applies, next.get(&dimension.dimension_id).is_some_and(allowed), dimension.allowed_options.first()) {
            (false, ..) => {
                next.remove(&dimension.dimension_id);
            }
            (true, true, _) => {}
            (true, false, Some(option)) if dimension.required => {
                next.insert(dimension.dimension_id.clone(), option.option_id.clone());
            }
            (true, false, _) => {
                next.remove(&dimension.dimension_id);
            }
        }
    }
    next
}

/// The options a chosen item shows, and whether some given ones are no longer offered
/// (`restoreListingOptions`): those are dropped and the rest kept as they are, so the seller
/// chooses again; otherwise each required option is filled.
pub fn resolve(schema: &Schema, given: &Picks, chosen: bool) -> (Picks, bool) {
    if chosen {
        return (with_defaults(schema, &Picks::new()), false);
    }
    let kept = items::normalize(schema, given);
    if given.iter().any(|(d, o)| kept.get(d) != Some(o)) { (kept, true) } else { (with_defaults(schema, given), false) }
}

/// Every required option that applies is chosen (`listingOptionsComplete`).
pub fn complete(schema: &Schema, picks: &Picks) -> bool {
    items::active_dimensions(schema, picks)
        .iter()
        .all(|d| !d.required || picks.get(&d.dimension_id).is_some_and(|o| d.allowed_options.iter().any(|a| &a.option_id == o)))
}

/// The options as the API takes them, in the order a product id names them
/// (`recordToProductSelectionEntries`).
pub fn entries(schema: &Schema, picks: &Picks) -> Vec<Selected> {
    items::ordered_dimensions(schema)
        .filter_map(|d| {
            picks.get(&d.dimension_id).map(|o| Selected { dimension_id: d.dimension_id.clone(), option_id: o.clone() })
        })
        .collect()
}

/// The catalog picker (`ListingCatalogPickerState`), as the address leaves it.
#[derive(Clone, Debug)]
pub enum Catalog {
    /// Nothing asked yet (`idle`).
    Idle,
    /// Matches to choose from (`populated`).
    Matches(Vec<Suggestion>),
    /// None matched (`empty`).
    NoMatch,
    /// The lookup failed (`error`).
    Failed,
    /// An item chosen, its options, and whether some given ones are no longer offered.
    Chosen { item: CatalogItem, picks: Picks, reset: bool },
}

impl Catalog {
    /// The chosen item, with every option it needs.
    pub fn ready(&self) -> Option<(&CatalogItem, &Picks)> {
        match self {
            Catalog::Chosen { item, picks, .. } if item.product_schema.as_ref().is_none_or(|s| complete(s, picks)) => {
                Some((item, picks))
            }
            _ => None,
        }
    }
}

/// The page.
pub struct NewListingScreen {
    pub draft: Draft,
    pub catalog: Catalog,
    pub supply: Vec<SupplyItem>,
    pub has_stock_location: bool,
    /// Why the page started without what its address asked for (a guest draft, an inventory item).
    pub notice: Option<String>,
    pub readiness: Option<EvidenceReadiness>,
    pub preview: Option<TermsPreview>,
    pub errors: Errors,
    /// A refused form drawn as a page: its photos are not kept.
    pub photos_lost: bool,
    /// A listing saved as a draft whose publication was refused.
    pub draft_saved: Option<String>,
}

impl NewListingScreen {
    pub fn selected(&self) -> Option<&SupplyItem> {
        self.supply.iter().find(|i| !self.draft.inventory_item_id.is_empty() && i.item_id == self.draft.inventory_item_id)
    }

    /// A selected inventory item without a shipping measure cannot be published.
    pub fn blocks_publication(&self) -> bool {
        self.selected().is_some_and(|i| i.product_measure_snapshot.is_none())
    }

    /// Neither an inventory item nor a complete catalog choice: nothing can be written.
    pub fn blocks_writes(&self) -> bool {
        self.draft.inventory_item_id.is_empty() && self.catalog.ready().is_none()
    }

    /// Create and publish is on once the evidence is complete (`!evidenceReadiness?.coverage.complete`).
    pub fn can_publish(&self) -> bool {
        !self.blocks_writes() && !self.blocks_publication() && self.readiness.as_ref().is_some_and(|r| r.coverage.complete)
    }
}

/// The catalog picker for the draft: the chosen item, or the search's matches.
pub(crate) async fn catalog(caller: &crate::api::Caller<'_>, draft: &Draft) -> Catalog {
    let exact = |words: &str| words.starts_with("cat_") && !words.contains(char::is_whitespace);
    if !draft.catalog_item_id.is_empty() {
        return match caller.catalog_item(&draft.catalog_item_id).await {
            Ok(Some(item)) => {
                let (picks, reset) = match &item.product_schema {
                    Some(schema) => resolve(schema, &draft.options, draft.chosen),
                    None => (Picks::new(), false),
                };
                Catalog::Chosen { item, picks, reset }
            }
            Ok(None) => Catalog::NoMatch,
            Err(error) => {
                tracing::warn!("the catalog item read failed: {error}");
                Catalog::Failed
            }
        };
    }
    let words = draft.q.as_str();
    if exact(words) {
        return match caller.catalog_item(words).await {
            Ok(Some(item)) => Catalog::Matches(vec![Suggestion {
                catalog_item_id: item.catalog_item_id,
                title: item.title,
                subtitle: item.subtitle,
                category: None,
            }]),
            Ok(None) => Catalog::NoMatch,
            Err(_) => Catalog::Failed,
        };
    }
    if words.chars().count() < 2 {
        return Catalog::Idle;
    }
    match caller.suggest(words).await {
        Ok(found) if found.is_empty() => Catalog::NoMatch,
        Ok(found) => Catalog::Matches(found),
        Err(error) => {
            tracing::warn!("the catalog search failed: {error}");
            Catalog::Failed
        }
    }
}

/// What the page reads besides the catalog: the seller's inventory (and the one the address
/// names, when it is past the first 100) and whether it has its Listing stock.
async fn supply(caller: &crate::api::Caller<'_>, draft: &Draft) -> Result<(Vec<SupplyItem>, bool), ApiError> {
    let (items, has) = tokio::join!(caller.supply_items(None), caller.has_location_named(STOCK_NAME));
    let (mut items, has) = (items?, has?);
    let id = draft.inventory_item_id.as_str();
    if !id.is_empty()
        && !items.iter().any(|i| i.item_id == id)
        && let Some(item) = caller.supply_items(Some(id)).await?.into_iter().find(|i| i.item_id == id)
    {
        items.insert(0, item);
    }
    Ok((items, has))
}

/// Builds the page for `draft`.
async fn screen(
    req: &Req,
    viewer: &Viewer,
    caller: &crate::api::Caller<'_>,
    draft: Draft,
    errors: Errors,
) -> Result<NewListingScreen, Box<HtmlResult>> {
    let t: ListingNewMsg = req.t();
    let ((items, has), catalog) = match tokio::join!(supply(caller, &draft), catalog(caller, &draft)) {
        (Ok(read), catalog) => (read, catalog),
        (Err(error), _) => return Err(Box::new(read_failed(req, Some(viewer), error, None))),
    };
    let notice = (!draft.inventory_item_id.is_empty() && !items.iter().any(|i| i.item_id == draft.inventory_item_id))
        .then(|| t.route_inventory_item_preparing().to_owned());
    let readiness = match draft.inventory_item_id.as_str() {
        "" => None,
        id => caller.evidence_readiness(id, &draft.price_amount).await.ok(),
    };
    let mut errors = errors;
    let preview = match draft.preview {
        false => None,
        true => match caller.preview_terms(&draft.price_amount).await {
            Ok(preview) => Some(preview),
            Err(error) => {
                match error.refusal() {
                    Some(message) => errors.add_form(message),
                    None => tracing::warn!("the fee preview failed: {error}"),
                }
                None
            }
        },
    };
    Ok(NewListingScreen {
        draft,
        catalog,
        supply: items,
        has_stock_location: has,
        notice,
        readiness,
        preview,
        errors,
        photos_lost: false,
        draft_saved: None,
    })
}

/// The page, or with JavaScript after one of the form's own `GET`s, its parts.
fn answer(req: &Req, viewer: &Viewer, screen: &NewListingScreen, status: StatusCode) -> HtmlResult {
    let (t, p): (ListingNewMsg, Pilot) = (req.t(), req.t());
    if req.mode == corten::Mode::Action && (screen.draft.redraw || status != StatusCode::OK) {
        return req.patch_with_status(status, html! { <views::NewListingParts t={t} p={p} screen={screen} /> });
    }
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_create_listing()} head={()}>
            <views::NewListingPage t={t} p={p} screen={screen} />
        </Layout>
    };
    req.page_with_status(status, page)
}

/// The account may not manage listings: marketplace's "Account access required" page.
fn access_required(req: &Req, viewer: &Viewer) -> HtmlResult {
    let t: ListingNewMsg = req.t();
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_create_listing()} head={()}>
            <views::ListingAccessRequired t={t} back={&crate::app::url::NewListing.href()} />
        </Layout>
    };
    req.page_with_status(StatusCode::FORBIDDEN, page)
}

pub(crate) async fn page(
    req: Req,
    Caller(ListingSeller(viewer)): Caller<ListingSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    if !viewer.actor.can(LISTINGS_VIEW) {
        return access_required(&req, &viewer);
    }
    let t: ListingNewMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let mut draft = Draft::read(&raw);
    draft.price_amount = typed_money(req.t(), &draft.price_amount);
    // A guest's listing draft, claimed after registering (`claimAnonymousListingDraftIntent`).
    let mut claim_failed = None;
    if !draft.claim.is_empty() {
        let owner = cookie::get(&headers, ANONYMOUS_LISTING_DRAFT_COOKIE).filter(|id| id.starts_with("anon_"));
        match owner {
            None => claim_failed = Some(t.route_listing_draft_not_found().to_owned()),
            Some(owner) => match caller.claim_draft(owner, &draft.claim).await {
                Ok(claim) => draft = Draft::claimed(claim),
                Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
                Err(error) => {
                    claim_failed = Some(error.refusal().unwrap_or(t.route_listing_draft_not_found()).to_owned());
                }
            },
        }
    }
    let mut screen = match screen(&req, &viewer, &caller, draft, Errors::new()).await {
        Ok(screen) => screen,
        Err(answer) => return *answer,
    };
    if claim_failed.is_some() {
        screen.notice = claim_failed;
    }
    answer(&req, &viewer, &screen, StatusCode::OK)
}

/// How a write's failure is answered.
enum Failed {
    SignIn,
    /// The API said why: the form shows it.
    Refused(String),
    Error(corten::Error),
}

fn failed(error: ApiError) -> Failed {
    match (error.status(), error.refusal()) {
        (Some(StatusCode::UNAUTHORIZED), _) => Failed::SignIn,
        (Some(StatusCode::FORBIDDEN), _) => Failed::Error(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
        (_, Some(message)) => Failed::Refused(message.to_owned()),
        _ => Failed::Error(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// A price as the page writes money (`t.parse_money`, todd-skelton/corten#208: `$1,299.50` in en) as
/// the API takes an amount (`1299.50`); text that is not money is sent as typed, for the API to
/// refuse in its own words.
fn typed_money(p: Pilot, text: &str) -> String {
    match p.parse_money(text.trim(), corten::i18n::Currency::new("USD")) {
        Some(cents) => format!("{}.{:02}", cents.0 / 100, cents.0 % 100),
        None => text.to_owned(),
    }
}

/// The create's fields as the API's multipart create takes them: the purchase limits as their
/// own fields, only those given, as marketplace's form sends them (chase-sets/chase-sets#10650).
fn create_fields(draft: &Draft, snapshot: Option<&serde_json::Value>, id: &str) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        // Empty for a catalog product: the create takes its Listing stock's snapshot instead.
        ("inventoryItemId", draft.inventory_item_id.clone()),
        ("priceAmount", draft.price_amount.clone()),
        ("priceCurrencyCode", draft.price_currency_code.clone()),
        ("quantityCap", draft.quantity_cap.clone()),
        ("listingIdOverride", id.to_owned()),
    ];
    let limits = [
        ("maxUnitsPerOrder", &draft.max_units_per_order),
        ("maxUnitsPerDay", &draft.max_units_per_day),
        ("maxUnitsPerCustomerAccount", &draft.max_units_per_customer_account),
    ];
    fields.extend(limits.into_iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k, v.clone())));
    if let Some(snapshot) = snapshot {
        fields.push(("inventorySnapshot", snapshot.to_string()));
    }
    fields
}

pub(crate) async fn create(
    req: Req,
    Caller(ListingSeller(viewer)): Caller<ListingSeller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    upload: Upload<Raw>,
) -> HtmlResult {
    let (t, p): (ListingNewMsg, Pilot) = (req.t(), req.t());
    let f = ListingFields::FIELDS;
    let caller = config.platform.caller(&headers, config.proto, None);
    let mut errors = Errors::new();
    let posted = match uploads::read(upload, LIMITS).await {
        Ok(posted) => posted,
        Err(UploadError::TooLarge { .. }) => {
            // What came after the limit is lost, the fields too: the form starts again.
            errors.add(f.evidence, p.listing_new_photos_too_large());
            return refuse(&req, &viewer, &caller, Draft::default(), errors, false, StatusCode::PAYLOAD_TOO_LARGE).await;
        }
        Err(other) => return Err(other.into()),
    };
    // Only the photo input's files are photos.
    let mut posted = posted;
    posted.files.retain(|upload| upload.field == f.evidence.as_str());
    let raw = &posted.fields;
    let mut draft = Draft { redraw: false, preview: false, ..Draft::read(raw) };
    draft.price_amount = typed_money(p, &draft.price_amount);
    let Some(intent) = Intent::read(&first(raw, f.intent.as_str())) else {
        return Err(corten::Error::status(StatusCode::BAD_REQUEST));
    };
    let attempt = first(raw, f.attempt.as_str());
    let sent_photos = !posted.files.is_empty() || posted.over.is_some();
    if !valid_attempt(&attempt) {
        errors.add_form(p.check_attempt());
    }
    match posted.over {
        Some(Over::FileTooLarge) => errors.add(f.evidence, p.listing_new_photo_size()),
        Some(Over::TooManyFiles) => errors.add(f.evidence, p.listing_new_photo_count()),
        None if posted.files.iter().any(|u| !uploads::is_picture(&u.content_type, &u.bytes)) => {
            errors.add(f.evidence, p.listing_new_photo_type());
        }
        None => {}
    }
    // The product: the inventory item, or the catalog item read again with every option chosen.
    let product = match draft.inventory_item_id.is_empty() {
        false => None,
        true => match caller.catalog_item(&draft.catalog_item_id).await {
            Ok(Some(item)) => {
                let picks = item.product_schema.as_ref().map(|s| items::normalize(s, &draft.options)).unwrap_or_default();
                match &item.product_schema {
                    Some(schema) if !complete(schema, &picks) => {
                        errors.add_form(p.listing_new_choose_options());
                        None
                    }
                    schema => {
                        Some((item.catalog_item_id.clone(), schema.as_ref().map(|s| entries(s, &picks)).unwrap_or_default()))
                    }
                }
            }
            Ok(None) => {
                errors.add_form(t.page_select_a_catalog_item());
                None
            }
            Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    if !errors.is_empty() {
        return refuse(&req, &viewer, &caller, draft, errors, sent_photos, StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let id = listing_id(&attempt).expect("a valid attempt");
    let photos: Vec<Photo> =
        posted.files.into_iter().map(|u| Photo { filename: u.filename, content_type: u.content_type, bytes: u.bytes }).collect();
    let refused = |message: String| {
        let mut errors = Errors::new();
        errors.add_form(message);
        errors
    };
    // The Listing stock for a catalog product: one inventory attempt, the form's.
    let snapshot = match &product {
        None => None,
        Some((catalog_item_id, options)) => {
            let quantity = draft.quantity_cap.parse::<u64>().unwrap_or(0);
            let mut stock =
                serde_json::json!({ "catalogItemId": catalog_item_id, "selectedOptions": options, "quantity": quantity });
            if let Some(address) = draft.ship_from.body() {
                stock["shipFromAddress"] = address;
            }
            match caller.ensure_listing_stock(&attempt, &stock).await {
                Ok(stock) => Some(stock.snapshot),
                Err(error) => {
                    return match failed(error) {
                        Failed::SignIn => sign_in(&req),
                        Failed::Error(error) => Err(error),
                        Failed::Refused(message) => {
                            refuse(&req, &viewer, &caller, draft, refused(message), sent_photos, StatusCode::UNPROCESSABLE_ENTITY)
                                .await
                        }
                    };
                }
            }
        }
    };
    let created = match caller.create_listing_with(&create_fields(&draft, snapshot.as_ref(), &id), &photos).await {
        Ok(created) => Ok(created),
        // Marketplace's supply read is ahead of Inventory's: create from its snapshot
        // (`createListingFromMarketplaceSupplySnapshot`).
        Err(error) if snapshot.is_none() && error.code() == Some("inventory_item_not_found") => {
            match caller.supply_items(Some(&draft.inventory_item_id)).await {
                Ok(found) => match found.into_iter().find(|i| i.item_id == draft.inventory_item_id) {
                    Some(item) => caller.create_listing_with(&create_fields(&draft, Some(&item.snapshot()), &id), &photos).await,
                    None => {
                        let message = t.route_inventory_item_preparing().to_owned();
                        return refuse(
                            &req,
                            &viewer,
                            &caller,
                            draft,
                            refused(message),
                            sent_photos,
                            StatusCode::UNPROCESSABLE_ENTITY,
                        )
                        .await;
                    }
                },
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    let (created, created_receipt): (CreatedListing, _) = match created {
        Ok(created) => created,
        // A photo the API cannot decode is a 500 (chase-sets/chase-sets#10649).
        Err(error) if !photos.is_empty() && error.status().is_some_and(|s| s.is_server_error()) => {
            tracing::warn!("a create with photos failed: {error}");
            let mut errors = Errors::new();
            errors.add(f.evidence, p.listing_new_photos_unprocessed());
            return refuse(&req, &viewer, &caller, draft, errors, sent_photos, StatusCode::UNPROCESSABLE_ENTITY).await;
        }
        Err(error) => {
            return match failed(error) {
                Failed::SignIn => sign_in(&req),
                Failed::Error(error) => Err(error),
                Failed::Refused(message) => {
                    refuse(&req, &viewer, &caller, draft, refused(message), sent_photos, StatusCode::UNPROCESSABLE_ENTITY).await
                }
            };
        }
    };
    // Publish, unless the same form sent again finds it published already.
    let (event, receipt) = match intent {
        Intent::Publish if created.is_active() => (Some("publication_succeeded"), created_receipt),
        Intent::Publish => match caller.publish_listing(&created.id, created.fee_quote_fingerprint.as_deref()).await {
            Ok(receipt) => (Some("publication_succeeded"), receipt.or(created_receipt)),
            Err(error) if error.code() == Some("listing_evidence_incomplete") => (Some("publication_blocked"), created_receipt),
            Err(error) => {
                return match failed(error) {
                    Failed::SignIn => sign_in(&req),
                    Failed::Error(error) => Err(error),
                    Failed::Refused(message) => {
                        let mut screen = match screen(&req, &viewer, &caller, draft, refused(message)).await {
                            Ok(screen) => screen,
                            Err(answer) => return *answer,
                        };
                        screen.draft_saved = Some(created.id);
                        screen.photos_lost = sent_photos && req.mode != corten::Mode::Action;
                        answer(&req, &viewer, &screen, StatusCode::UNPROCESSABLE_ENTITY)
                    }
                };
            }
        },
        Intent::Draft => ((!photos.is_empty()).then_some("upload_completed"), created_receipt),
    };
    req.redirect(&crate::seller_listing::at(&created.id, receipt.as_ref(), event))
}

/// The form again, saying why nothing was written.
#[allow(clippy::too_many_arguments)]
async fn refuse(
    req: &Req,
    viewer: &Viewer,
    caller: &crate::api::Caller<'_>,
    draft: Draft,
    errors: Errors,
    sent_photos: bool,
    status: StatusCode,
) -> HtmlResult {
    let mut screen = match screen(req, viewer, caller, draft, errors).await {
        Ok(screen) => screen,
        Err(answer) => return *answer,
    };
    // Drawn as a page, the file input is new: the photos must be chosen again. As a patch the
    // input is not replaced, so they stay chosen.
    screen.photos_lost = sent_photos && req.mode != corten::Mode::Action;
    answer(req, viewer, &screen, status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Clause, Dimension, DimensionOption, DimensionRef};
    use crate::items::Values;

    fn raw(pairs: &[(&str, &str)]) -> Raw {
        let mut raw = Raw::new();
        for (k, v) in pairs {
            raw.insert((*k).to_owned(), Values::One((*v).to_owned()));
        }
        raw
    }

    fn option(id: &str) -> DimensionOption {
        DimensionOption { option_id: id.into(), code: id.into(), label: None, display_order: 0, numeric_value: None }
    }

    /// A card: its form (graded first, as the sandbox's schema lists it), a raw card's condition
    /// and a graded card's grade.
    fn schema() -> Schema {
        let dimension = |id: &str, options: &[&str], when: Option<&str>| Dimension {
            dimension_id: id.into(),
            dimension_name: id.into(),
            value_kind: "unordered".into(),
            required: true,
            applies_when: when
                .map(|o| vec![Clause { dimension_id: "form".into(), option_ids: vec![o.into()] }])
                .unwrap_or_default(),
            allowed_options: options.iter().map(|o| option(o)).collect(),
        };
        Schema {
            dimensions: vec![
                dimension("condition", &["nm", "lp"], Some("raw")),
                dimension("form", &["graded", "raw"], None),
                dimension("grade", &["10", "9"], Some("graded")),
            ],
            canonical_dimension_order: ["form", "condition", "grade"].map(|d| DimensionRef { dimension_id: d.into() }).to_vec(),
        }
    }

    fn picks(pairs: &[(&str, &str)]) -> Picks {
        pairs.iter().map(|(d, o)| ((*d).to_owned(), (*o).to_owned())).collect()
    }

    #[test]
    fn the_address_keeps_marketplaces_names_and_options_are_their_own_parameters() {
        let draft = Draft::read(&raw(&[
            ("catalogItemId", "cat_1"),
            ("option.form", "raw"),
            ("option.condition", "nm"),
            ("recommendedPrice", "12.50"),
            ("inventoryItemId", "inv_1"),
        ]));
        assert_eq!(draft.catalog_item_id, "cat_1");
        assert_eq!(draft.options, picks(&[("form", "raw"), ("condition", "nm")]));
        assert_eq!((draft.price_amount.as_str(), draft.quantity_cap.as_str()), ("12.50", "1"));
        assert!(!draft.redraw && !draft.chosen);
        let json = r#"[{"dimensionId":"form","optionId":"graded"},{"dimensionId":"grade","optionId":"10"}]"#;
        let draft = Draft::read(&raw(&[("catalogItemId", "cat_1"), ("selectedOptions", json), ("priceAmount", "3")]));
        assert_eq!(draft.options, picks(&[("form", "graded"), ("grade", "10")]));
        assert_eq!(draft.price_amount, "3", "a typed price wins over the recommended one");
    }

    #[test]
    fn choose_starts_an_item_fresh_and_another_item_clears_it() {
        let draft = Draft::read(&raw(&[("catalogItemId", "cat_1"), ("option.form", "raw"), ("choose", "cat_2")]));
        assert_eq!((draft.catalog_item_id.as_str(), draft.chosen, draft.redraw), ("cat_2", true, true));
        assert!(draft.options.is_empty());
        let draft = Draft::read(&raw(&[("catalogItemId", "cat_1"), ("option.form", "raw"), ("change", "1")]));
        assert_eq!((draft.catalog_item_id.as_str(), draft.options.len()), ("", 0));
    }

    #[test]
    fn options_are_filled_dropped_or_reset_as_marketplace_does() {
        let s = schema();
        assert_eq!(resolve(&s, &Picks::new(), true), (picks(&[("form", "graded"), ("grade", "10")]), false));
        assert_eq!(resolve(&s, &picks(&[("form", "raw")]), false), (picks(&[("form", "raw"), ("condition", "nm")]), false));
        // A given option no longer offered: the rest kept as they are, nothing filled.
        assert_eq!(resolve(&s, &picks(&[("form", "raw"), ("condition", "mint")]), false), (picks(&[("form", "raw")]), true));
        assert!(!complete(&s, &picks(&[("form", "raw")])));
        assert!(complete(&s, &picks(&[("form", "raw"), ("condition", "lp")])));
        let sent = entries(&s, &picks(&[("condition", "lp"), ("form", "raw")]));
        assert_eq!(sent.iter().map(|e| e.dimension_id.as_str()).collect::<Vec<_>>(), ["form", "condition"]);
    }

    #[test]
    fn the_limits_go_as_their_own_fields_only_when_given() {
        let draft = Draft { price_amount: "5".into(), max_units_per_day: "2".into(), ..Draft::default() };
        let names: Vec<&str> = create_fields(&draft, None, "lst_1").iter().map(|(k, _)| *k).collect();
        assert_eq!(
            names,
            ["inventoryItemId", "priceAmount", "priceCurrencyCode", "quantityCap", "listingIdOverride", "maxUnitsPerDay"]
        );
        let with = create_fields(&draft, Some(&serde_json::json!({ "inventoryItemId": "inv_stock" })), "lst_1");
        assert_eq!(with.last().map(|(k, _)| *k), Some("inventorySnapshot"));
    }

    #[test]
    fn a_ship_from_is_sent_only_when_typed() {
        assert_eq!(ShipFrom::default().body(), None);
        let typed = ShipFrom { line1: "1 Test Way".into(), ..ShipFrom::default() };
        assert_eq!(typed.body().unwrap()["country"], "US");
    }
}
