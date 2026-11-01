//! Inventory (marketplace's `/account/inventory`): a page of the account's inventory items, Create
//! inventory item, and each item's Record sale.
//!
//! Create inventory item is an `item-create` write confirmed as the storage locations' are (see
//! `recovery`): its form carries the attempt and the browser remembers it. Its catalog picker is
//! Create listing's: searching, choosing and the options are GETs of the page with the form's
//! fields (the form's parts drawn again in place with JavaScript), so it works without a script.
//! An applied create goes where marketplace's does: the `returnTo` it was given, else the new item's
//! page, with the write's receipt.
//!
//! Record sale is the item's own dialog, drawn open by the list at `?sale=<item>` (one dialog, not
//! one per row). The sale is sent with an idempotency key (the form's `SubmitKey`); its outcome
//! goes back to the list in the address, and the item is read again after the write's receipt so
//! the page can say how many are available now.
use crate::recovery::attempt_text;
use corten::{axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{
        ApiError, GradedCard, Inventory as _, InventoryItems, InventoryList as _, ItemCommand, Location, SaleCommand, SaleResult,
    },
    app::{Config, Shared, read_failed, sign_in, url},
    auth::{Seller, Viewer},
    items::Raw,
    listing_new::{self, Catalog, Draft, first},
    recovery::{self, Check, Failed, Family, Status, failed, valid_attempt},
    text::{InventoryMsg, Pilot},
    views::{self, Layout},
};

const UNPROCESSABLE: corten::axum::http::StatusCode = corten::axum::http::StatusCode::UNPROCESSABLE_ENTITY;

/// A page's items unless the address asks for another count, and the most it may ask
/// (`inventoryItemPageQuery`).
pub const DEFAULT_LIMIT: u64 = 100;
pub const MAX_LIMIT: u64 = 250;

/// The sale channels (`inventoryOfflineSaleChannels`).
pub const CHANNELS: [&str; 3] = ["in-store", "card-show", "other"];

/// What the list's address carries besides a write to confirm: the page, the item whose Record
/// sale is open, and what the last sale did (marketplace keeps that in the history's state; the
/// pilot keeps it in the address, so a reload still says it).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub limit: Option<String>,
    pub offset: Option<String>,
    pub sale: Option<String>,
    pub offline_sale_item_id: Option<String>,
    pub requested: Option<u64>,
    pub applied: Option<u64>,
    pub refused: Option<u64>,
    /// The orders an honored sale affected, comma separated.
    pub orders: Option<String>,
}

impl Place {
    /// The page's count and start, as marketplace reads them: a number in range, else the default.
    pub fn bounds(&self) -> (u64, u64) {
        let number = |v: &Option<String>| v.as_deref().and_then(|v| v.trim().parse::<u64>().ok());
        let limit = number(&self.limit).filter(|l| *l > 0).unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        (limit, number(&self.offset).unwrap_or(0))
    }

    /// The same page, at `offset`, with nothing else.
    pub fn at(&self, offset: u64) -> url::Inventory {
        let (limit, _) = self.bounds();
        let limit = (limit != DEFAULT_LIMIT).then(|| limit.to_string());
        let offset = (offset > 0).then(|| offset.to_string());
        url::Inventory { place: Place { limit, offset, ..Place::default() }, check: Check::default() }
    }

    /// The same page with `item`'s Record sale open.
    pub fn selling(&self, item: &str) -> url::Inventory {
        let url::Inventory { place, check } = self.at(self.bounds().1);
        url::Inventory { place: Place { sale: Some(item.to_owned()), ..place }, check }
    }

    /// Where `item`'s Record sale posts from this page: the list comes back at the same page.
    pub fn sale_to<'a>(&self, item: &'a str) -> url::OfflineSale<'a> {
        url::OfflineSale { id: item, place: Place { sale: Some(item.to_owned()), ..self.at(self.bounds().1).place } }
    }

    /// What the last sale did, when the address says.
    pub fn outcome(&self) -> Option<Outcome> {
        Some(Outcome {
            item_id: self.offline_sale_item_id.clone().filter(|id| !id.is_empty())?,
            requested: self.requested?,
            applied: self.applied?,
            refused: self.refused?,
            orders: self.orders.as_deref().unwrap_or_default().split(',').filter(|o| !o.is_empty()).map(str::to_owned).collect(),
        })
    }
}

/// What an offline sale did (`OfflineSaleResult`), as the list's address carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub item_id: String,
    pub requested: u64,
    pub applied: u64,
    pub refused: u64,
    pub orders: Vec<String>,
}

/// Whether the outcome was checked against the item as it is now (`verificationState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verified {
    /// Read again after the sale's receipt: the available quantity now.
    Fresh(i64),
    Unverified,
}

/// Create inventory item's fields, in marketplace's names (the picker's are Create listing's:
/// `q`, `choose`, `change`, `catalogItemId`, `selectedOptions` and `option.<dimension>`). The attempt is not
/// named `attempt`, which the address keeps for a write to confirm.
#[derive(Deserialize, Fields)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ItemFields {
    pub inventory_mutation_attempt_id: Option<SubmitKey>,
    pub q: String,
    pub choose: String,
    pub change: String,
    pub redraw: String,
    pub catalog_item_id: String,
    pub storage_location_id: String,
    pub total_quantity: String,
    pub acquisition_cost_amount: String,
    pub acquisition_cost_currency_code: String,
    pub certification_number: String,
    pub return_to: String,
}

/// Create inventory item as the page draws it.
#[derive(Clone, Debug)]
pub struct CreateItem {
    pub draft: Draft,
    pub catalog: Catalog,
    pub storage_location_id: String,
    pub total_quantity: String,
    pub cost_amount: String,
    pub cost_currency: String,
    /// A graded card's certification number, optional.
    pub certification_number: String,
    /// Where an applied create goes instead of the item's page (`safeAccountReturnTo`).
    pub return_to: Option<String>,
    pub errors: Errors,
}

impl CreateItem {
    fn read(raw: &Raw) -> Self {
        let f = ItemFields::FIELDS;
        let get = |name: FieldName<String>| first(raw, name.as_str());
        CreateItem {
            draft: Draft::read(raw),
            catalog: Catalog::Idle,
            storage_location_id: get(f.storage_location_id),
            total_quantity: get(f.total_quantity),
            cost_amount: get(f.acquisition_cost_amount),
            cost_currency: get(f.acquisition_cost_currency_code),
            certification_number: get(f.certification_number),
            return_to: safe_return_to(&get(f.return_to)),
            errors: Errors::new(),
        }
    }

    /// The chosen catalog item, active, with every option it needs.
    pub fn ready(&self) -> Option<(&crate::api::CatalogItem, &crate::items::Picks)> {
        self.catalog.ready().filter(|(item, _)| item.status == "active")
    }

    /// The chosen product's grading company and grade, when it is a graded card.
    pub fn graded(&self) -> Option<(String, String)> {
        let (item, picks) = self.ready()?;
        graded(item.product_schema.as_ref()?, picks)
    }
}

/// Whether the options name a graded card, with its grading company and grade, as marketplace's
/// Create inventory item works them out: the active `Form` dimension's option is `Graded`, and the
/// company and grade are the `Grading Company` and `Grade` options' names, empty when unchosen.
/// The Inventory API should derive these itself (chase-sets/chase-sets#10789).
pub fn graded(schema: &crate::api::Schema, picks: &crate::items::Picks) -> Option<(String, String)> {
    let active = crate::items::active_dimensions(schema, picks);
    let label = |name: &str| {
        active
            .iter()
            .find(|d| d.dimension_name == name)
            .and_then(|d| d.allowed_options.iter().find(|o| picks.get(&d.dimension_id) == Some(&o.option_id)))
            .map(|o| crate::items::option_label(o).to_owned())
            .unwrap_or_default()
    };
    (label("Form") == "Graded").then(|| (label("Grading Company"), label("Grade")))
}

/// An account page to go back to (`safeAccountReturnTo`): a path under `/account/`, nothing else.
pub fn safe_return_to(text: &str) -> Option<String> {
    let text = text.trim();
    let path = text.split(['?', '#']).next().unwrap_or_default();
    let ok = text.starts_with("/account/") && !text.starts_with("//") && !path.contains("/../") && !path.contains('\\');
    ok.then(|| text.to_owned())
}

/// Record sale's fields (`OfflineSaleForm`), in marketplace's names.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct SaleInput {
    pub idempotency_key: Option<SubmitKey>,
    pub quantity: String,
    pub sale_price_amount: String,
    pub channel: String,
    pub note: String,
    pub collision_mode: String,
    pub confirm_seller_cannot_fulfill: String,
}

/// May the seller honor an offline sale over its orders (`canHonorOffline`).
pub fn can_honor(viewer: &Viewer) -> bool {
    matches!(viewer.actor.role_key.as_str(), "owner" | "manager")
}

impl SaleInput {
    /// The request, or what is wrong with the form. The rules are Inventory's; the pilot checks
    /// what the inputs ask of the browser, a price the API would refuse to read, and who may
    /// honor a sale.
    pub fn command(&self, p: Pilot, honor_allowed: bool) -> Result<SaleCommand, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        if !valid_attempt(attempt_text(&self.idempotency_key)) {
            errors.add_form(p.check_attempt());
        }
        let quantity = self.quantity.trim().parse::<u64>().ok().filter(|q| *q >= 1);
        if quantity.is_none() {
            errors.add(f.quantity, p.inventory_quantity());
        }
        // Money as the page writes it (`t.parse_money`, todd-skelton/corten#208): `12.5` or `$1,299.50` in en.
        let price = self.sale_price_amount.trim();
        let price = match p.parse_money(price, corten::i18n::Currency::new("USD")) {
            _ if price.is_empty() => None,
            Some(cents) => Some(format!("{}.{:02}", cents.0 / 100, cents.0 % 100)),
            None => {
                errors.add(f.sale_price_amount, p.inventory_price());
                None
            }
        };
        if !CHANNELS.contains(&self.channel.as_str()) {
            errors.add(f.channel, p.check_required());
        }
        let honor = self.collision_mode == "honor-offline";
        // Only an owner or manager is drawn the choice, so another seller's refusal is the form's.
        if honor && !honor_allowed {
            errors.add_form(p.inventory_honor_role());
        }
        let confirmed = self.confirm_seller_cannot_fulfill == "true";
        if honor && honor_allowed && !confirmed {
            errors.add(f.confirm_seller_cannot_fulfill, p.inventory_honor_confirm());
        }
        let note = self.note.trim();
        errors.into_result(SaleCommand {
            quantity: quantity.unwrap_or_default(),
            sale_price_amount: price,
            channel: self.channel.clone(),
            note: (!note.is_empty()).then(|| note.to_owned()),
            collision_mode: if honor { "honor-offline" } else { "protect-orders" }.into(),
            confirm_seller_cannot_fulfill: honor.then_some(confirmed),
            idempotency_key: attempt_text(&self.idempotency_key).to_owned(),
        })
    }
}

/// A Record sale the API or the pilot refused: its item, what was typed and why.
#[derive(Clone, Debug, Default)]
pub struct SaleDraft {
    pub item_id: String,
    pub input: SaleInput,
    pub errors: Errors,
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct InventoryScreen {
    pub items: InventoryItems,
    /// The account's storage locations, archived ones left out (Create inventory item's choice).
    pub locations: Vec<Location>,
    /// A read that is taking longer than expected: the page says so, with what it has.
    pub load_error: Option<String>,
    pub status: Status,
    pub outcome: Option<Outcome>,
    pub verified: Option<Verified>,
    pub can_record_sale: bool,
    pub can_honor: bool,
    #[serde(skip)]
    pub place: Place,
}

impl InventoryScreen {
    /// The item whose Record sale is open.
    pub fn selling(&self) -> Option<&crate::api::InventoryItem> {
        let id = self.place.sale.as_deref()?;
        self.can_record_sale.then(|| self.items.items.iter().find(|i| i.item_id == id)).flatten()
    }
}

/// A read the page can do without for now (`isTemporaryInventoryReadError`): a timeout, too many
/// requests, the API failing, or no answer.
fn temporary(error: &ApiError) -> bool {
    error.status().is_none_or(|s| s.as_u16() == 408 || s.as_u16() == 429 || s.is_server_error())
}

/// The page for its address, with a refused write's form in place of its default.
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    place: &Place,
    check: &Check,
    mut create: CreateItem,
    sale: Option<SaleDraft>,
    posted: Option<Status>,
) -> HtmlResult {
    let receipt = Receipt::from_param(check.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let plain = config.platform.caller(headers, config.proto, None);
    let status = async {
        if let Some(status) = &posted {
            return status.clone();
        }
        match &check.attempt {
            Some(attempt) => {
                let (family, target, user) = (check.family, check.target.as_deref(), check.user.as_deref());
                recovery::check(&plain, &viewer.actor, attempt, family, target, user).await
            }
            None => Status::Ready,
        }
    };
    let outcome = place.outcome();
    // The item a sale changed, read after the sale's receipt (`readFreshWriteToken`).
    let fresh = async {
        match (&outcome, &receipt) {
            (Some(outcome), Some(_)) => caller.inventory_item(&outcome.item_id).await.ok(),
            _ => None,
        }
    };
    let (limit, offset) = place.bounds();
    let (items, locations, status, catalog, fresh) = tokio::join!(
        caller.inventory_items(limit, offset),
        caller.locations(),
        status,
        listing_new::catalog(&plain, &create.draft),
        fresh,
    );
    create.catalog = catalog;
    let (t, p): (InventoryMsg, Pilot) = (req.t(), req.t());
    let mut slow = Vec::new();
    let mut items = match items {
        Ok(items) => items,
        Err(error) if temporary(&error) => {
            slow.push(p.inventory_items_slow());
            InventoryItems { limit, offset, ..InventoryItems::default() }
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let locations = match locations {
        Ok(list) => list.items.into_iter().filter(|l| !l.is_archived).collect(),
        Err(error) if temporary(&error) => {
            slow.push(p.inventory_locations_slow());
            Vec::new()
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    // The row the sale changed, as it is now (`reconcileFreshOfflineSaleItem`).
    if let Some(item) = &fresh
        && let Some(row) = items.items.iter_mut().find(|row| row.item_id == item.item_id)
    {
        *row = item.clone();
    }
    let verified =
        outcome.as_ref().map(|_| fresh.as_ref().map_or(Verified::Unverified, |i| Verified::Fresh(i.available_quantity)));
    let screen = InventoryScreen {
        items,
        locations,
        load_error: (!slow.is_empty()).then(|| slow.join(" ")),
        status,
        outcome,
        verified,
        can_record_sale: viewer.actor.can("inventory.manage"),
        can_honor: can_honor(viewer),
        place: Place { sale: sale.as_ref().map(|s| s.item_id.clone()).or_else(|| place.sale.clone()), ..place.clone() },
    };
    // A refused form, or the picker asking the page again: only that form is drawn again, in place.
    let m: crate::text::Msg = req.t();
    if req.mode == corten::Mode::Action {
        if let Some(status) = &posted {
            return req.patch_with_status(UNPROCESSABLE, views::refused_item(t, p, m, viewer, &screen, &create, status));
        }
        if let Some(draft) = &sale {
            let form = html! {
                <views::SaleForm
                    t={t}
                    p={p}
                    action={screen.place.sale_to(&draft.item_id)}
                    draft={draft}
                    can_honor={screen.can_honor}
                    autofocus={true}
                />
            };
            return req.patch_with_status(UNPROCESSABLE, form);
        }
        if create.draft.redraw {
            return req
                .patch(html! { <views::CreateItemForm t={t} p={p} m={m} viewer={viewer} screen={&screen} create={&create} /> });
        }
    }
    let code = if posted.is_some() || sale.is_some() { UNPROCESSABLE } else { corten::axum::http::StatusCode::OK };
    // Record sale's form, as typed after a refusal, else empty.
    let sale = sale.or_else(|| {
        screen.selling().map(|item| SaleDraft {
            item_id: item.item_id.clone(),
            input: SaleInput::default(),
            errors: Errors::new(),
        })
    });
    let (title, head) = (
        t.route_inventory_marketplace(),
        html! { <meta name="description" content={t.route_manage_inventory_items_stock_counts_and()}> },
    );
    let again = url::Inventory { place: place.clone(), check: check.again() };
    let view = html! {
        <views::InventoryPage
            t={t}
            p={p}
            m={m}
            viewer={viewer}
            screen={&screen}
            create={&create}
            sale={sale.as_ref()}
            again={&again}
        />
    };
    req.screen_with_status(
        code,
        &screen,
        html! { <Layout req={req} viewer={Some(viewer)} title={title} head={head}>{view}</Layout> },
    )
}

pub(crate) async fn list(
    req: Req,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Inventory>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let (place, check) = (route.place, route.check);
    render(&req, &viewer, &config, &headers, &place, &check, CreateItem::read(&raw), None, None).await
}

/// Create inventory item: the item's page (or where the form came from) after an applied write;
/// a refused one is the form again.
pub(crate) async fn create(
    req: Req,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::Inventory>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let place = route.place;
    let (t, p): (InventoryMsg, Pilot) = (req.t(), req.t());
    let f = ItemFields::FIELDS;
    let attempt = first(&raw, f.inventory_mutation_attempt_id.as_str());
    let mut create = CreateItem::read(&raw);
    let caller = config.platform.caller(&headers, config.proto, None);
    create.catalog = listing_new::catalog(&caller, &create.draft).await;
    let mut errors = Errors::new();
    if !valid_attempt(&attempt) {
        errors.add_form(p.check_attempt());
    }
    match (&create.catalog, create.ready()) {
        (_, Some(_)) => {}
        (Catalog::Chosen { .. }, None) => errors.add(f.q, p.listing_new_choose_options()),
        _ => errors.add(f.q, t.list_choose_the_visible_catalog_item()),
    }
    if create.storage_location_id.is_empty() {
        errors.add(f.storage_location_id, p.check_required());
    }
    let quantity = create.total_quantity.parse::<u64>().ok().filter(|q| *q >= 1);
    if quantity.is_none() {
        errors.add(f.total_quantity, p.inventory_quantity());
    }
    let graded = create.graded();
    if graded.as_ref().is_some_and(|(company, grade)| company.trim().is_empty() || grade.trim().is_empty()) {
        errors.add(f.q, t.list_graded_details_required());
    }
    if errors.is_empty()
        && let (Some((item, picks)), Some(quantity)) = (create.ready(), quantity)
    {
        let optional = |text: &str| (!text.trim().is_empty()).then(|| text.trim().to_owned());
        let command = ItemCommand {
            catalog_item_id: item.catalog_item_id.clone(),
            selected_options: item.product_schema.as_ref().map(|s| listing_new::entries(s, picks)).unwrap_or_default(),
            storage_location_id: create.storage_location_id.clone(),
            total_quantity: quantity,
            acquisition_cost_amount: optional(&create.cost_amount),
            acquisition_cost_currency_code: optional(&create.cost_currency),
            graded_card: graded.map(|(grading_company, grade)| GradedCard {
                grading_company,
                grade,
                certification_number: optional(&create.certification_number),
                population: None,
                condition_descriptors: [],
            }),
        };
        match caller.create_item(&attempt, &command).await {
            Ok((id, receipt)) => return created(&req, &create, &id, &attempt, receipt),
            Err(error) => match failed(&caller, Family::ItemCreate, "draft", &attempt, error).await {
                Failed::Refused(refused) => errors = refused,
                // The same attempt created the item before; the list confirms it.
                Failed::AppliedBefore => {
                    let check = Check::applied(Family::ItemCreate, "draft", &attempt, None);
                    return req.redirect(&url::Inventory { place: Place::default(), check });
                }
                Failed::SignIn => return sign_in(&req),
                Failed::Unknown(error) => return Err(error),
            },
        }
    }
    // Nothing was applied: the form again, with a new attempt, and a status that settles this one.
    create.errors = errors;
    let place = Place { sale: None, ..place };
    render(&req, &viewer, &config, &headers, &place, &Check::default(), create, None, Some(Status::Refused(attempt))).await
}

/// Where an applied create goes (`formActionRedirect`): the item's page, which confirms the
/// attempt and reads after the write's receipt; or the marketplace page `returnTo` names, with the
/// receipt as marketplace's `afterWrite`.
fn created(req: &Req, create: &CreateItem, id: &str, attempt: &str, receipt: Option<Receipt>) -> HtmlResult {
    let Some(path) = create.return_to.clone() else {
        let check = Check::applied(Family::ItemCreate, "draft", attempt, receipt.map(|r| r.param()));
        return req.redirect(&url::StockItem { id, place: crate::inventory_item::ItemPlace::default(), check });
    };
    let path = match receipt {
        Some(receipt) => {
            let join = if path.contains('?') { '&' } else { '?' };
            format!("{path}{join}afterWrite={}", crate::api::segment(&receipt.param()))
        }
        None => path,
    };
    match views::marketplace(&path) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(corten::axum::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// Record sale: the list with what the sale did, read after its receipt; a refused one is its
/// dialog again with what was typed.
pub(crate) async fn sale(
    req: Req,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::OfflineSale<'_>>,
    Form(input): Form<SaleInput>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match input.command(p, can_honor(&viewer)) {
        Ok(command) => match caller.offline_sale(&id, &command).await {
            Ok((result, receipt)) => return sold(&req, &place, &result, receipt),
            Err(error) if error.status().is_some_and(|s| s.as_u16() == 401) => return sign_in(&req),
            Err(error) => match error.refusal() {
                Some(message) => {
                    let mut errors = Errors::new();
                    errors.add_form(message);
                    errors
                }
                None => {
                    return Err(corten::Error::new(error).with_status(corten::axum::http::StatusCode::BAD_GATEWAY));
                }
            },
        },
        Err(errors) => errors,
    };
    let draft = SaleDraft { item_id: id, input, errors };
    render(&req, &viewer, &config, &headers, &place, &Check::default(), CreateItem::read(&Raw::new()), Some(draft), None).await
}

/// The list after a sale: the page it was on, what the sale did, and its receipt.
fn sold(req: &Req, place: &Place, result: &SaleResult, receipt: Option<Receipt>) -> HtmlResult {
    let url::Inventory { place: page, .. } = place.at(place.bounds().1);
    let orders: Vec<&str> = result.collision.iter().flat_map(|c| c.affected_orders.iter()).map(|o| o.order_id.as_str()).collect();
    let place = Place {
        offline_sale_item_id: Some(result.item_id.clone()),
        requested: Some(result.requested_quantity),
        applied: Some(result.applied_quantity),
        refused: Some(result.refused_quantity),
        orders: (!orders.is_empty()).then(|| orders.join(",")),
        ..page
    };
    let check = Check { after_write: receipt.map(|r| r.param()), ..Check::default() };
    req.redirect(&url::Inventory { place, check })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Clause, Dimension, DimensionOption, DimensionRef, Schema};

    /// A card as the catalog names it: its Form, and for a graded one its Grading Company and Grade.
    fn card() -> Schema {
        let option = |id: &str, label: &str| DimensionOption {
            option_id: id.into(),
            code: id.into(),
            label: Some(label.into()),
            display_order: 0,
            numeric_value: None,
        };
        let dimension = |id: &str, name: &str, options: Vec<DimensionOption>, graded: bool| Dimension {
            dimension_id: id.into(),
            dimension_name: name.into(),
            value_kind: "unordered".into(),
            required: true,
            applies_when: if graded {
                vec![Clause { dimension_id: "form".into(), option_ids: vec!["g".into()] }]
            } else {
                vec![]
            },
            allowed_options: options,
        };
        Schema {
            dimensions: vec![
                dimension("form", "Form", vec![option("r", "Raw"), option("g", "Graded")], false),
                dimension("company", "Grading Company", vec![option("psa", "PSA")], true),
                dimension("grade", "Grade", vec![option("10", "10")], true),
            ],
            canonical_dimension_order: ["form", "company", "grade"].map(|d| DimensionRef { dimension_id: d.into() }).to_vec(),
        }
    }

    #[test]
    fn a_graded_card_takes_its_company_and_grade_from_the_options_names() {
        let picks = |pairs: &[(&str, &str)]| pairs.iter().map(|(d, o)| ((*d).to_owned(), (*o).to_owned())).collect();
        let s = card();
        assert_eq!(graded(&s, &picks(&[("form", "g"), ("company", "psa"), ("grade", "10")])), Some(("PSA".into(), "10".into())));
        assert_eq!(graded(&s, &picks(&[("form", "g")])), Some((String::new(), String::new())), "unchosen: empty, refused");
        assert_eq!(graded(&s, &picks(&[("form", "r"), ("company", "psa")])), None, "a raw card sends no details");
    }

    #[test]
    fn a_sale_price_is_money_as_the_page_writes_it() {
        use corten::i18n::Messages as _;
        let p = Pilot::for_locale("en");
        let sale = |price: &str| SaleInput {
            idempotency_key: crate::recovery::submit_key("8f14e45f-ceea-467a-9b8e-1c2d3e4f5a6b"),
            quantity: "1".into(),
            sale_price_amount: price.into(),
            channel: CHANNELS[0].into(),
            ..SaleInput::default()
        };
        let price = |text: &str| sale(text).command(p, false).map(|c| c.sale_price_amount);
        assert_eq!(price("$1,299.50").ok().flatten().as_deref(), Some("1299.50"));
        assert_eq!(price("12.5").ok().flatten().as_deref(), Some("12.50"));
        assert_eq!(price("0").ok().flatten().as_deref(), Some("0.00"), "a gift is a sale");
        assert_eq!(price("").ok().flatten(), None, "no price is allowed");
        for bad in ["-1", "1.234", "12,50", "abc"] {
            assert!(price(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_page_is_read_as_marketplace_reads_it() {
        let at = |limit: Option<&str>, offset: Option<&str>| {
            Place { limit: limit.map(Into::into), offset: offset.map(Into::into), ..Place::default() }.bounds()
        };
        assert_eq!(at(None, None), (100, 0));
        assert_eq!(at(Some("25"), Some("50")), (25, 50));
        assert_eq!(at(Some("900"), Some("x")), (250, 0));
        assert_eq!(at(Some("0"), Some("-3")), (100, 0));
    }

    #[test]
    fn return_to_is_an_account_page_only() {
        assert_eq!(safe_return_to("/account/listings/new?x=1").as_deref(), Some("/account/listings/new?x=1"));
        for bad in ["", "/search", "//evil.example/account/", "https://evil.example/account/", "/account/../admin"] {
            assert_eq!(safe_return_to(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_outcome_needs_every_count() {
        let place = Place {
            offline_sale_item_id: Some("inv_1".into()),
            requested: Some(3),
            applied: Some(2),
            refused: Some(1),
            orders: Some("ord_1,ord_2".into()),
            ..Place::default()
        };
        let outcome = place.outcome().unwrap();
        assert_eq!((outcome.applied, outcome.orders.len()), (2, 2));
        assert!(Place { applied: None, ..place }.outcome().is_none());
    }
}
