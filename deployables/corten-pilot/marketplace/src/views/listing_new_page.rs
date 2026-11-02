//! Create listing's page (marketplace's `MarketplaceListingCreatePage`): the header with Back to
//! listings, then one form. Its left column is the product (the catalog search and its matches,
//! or the chosen item and its options), the price, the quantity and, for an account without its
//! Listing stock, the ship-from address; the right is the photos and the evidence the inventory
//! item needs. Advanced inventory and limits fold under them, then the fee preview and the three
//! buttons.
//!
//! The form posts `multipart/form-data` with its photos; every other button is a `GET` of the
//! page with the form's fields. Its first button is Update, hidden, so Enter in a field draws
//! the form again rather than choosing a match or writing. With JavaScript the parts that change
//! (`NewListingParts`) are patched, and the photo input, outside them, keeps its files.
use corten::{i18n::Currency, prelude::*};

use super::on_marketplace;
use crate::{
    api::{EvidenceReadiness, SupplyItem, TermsPreview},
    app::url,
    items,
    listing_new::{Catalog, Intent, ListingFields, NewListingScreen, OPTION, PICTURES},
    text::{ListingNewMsg, Pilot},
};

corten::script::script!(pub mod handlers = "listing_new.js");

/// The form.
#[derive(Id, Clone, Copy)]
pub struct ListingFormId;
/// What the form says about itself: a refusal, a draft saved, a notice.
#[derive(Id)]
pub struct NoticeId;

/// The photo input's hint, which describes the input ahead of its error.
#[derive(Id)]
pub struct ListingPhotosHintId;
/// The product, price, quantity, ship-from and advanced parts.
#[derive(Id)]
pub struct ProductId;
/// The evidence the inventory item needs.
#[derive(Id)]
pub struct ReadinessId;
/// The fee preview.
#[derive(Id)]
pub struct FeesId;
/// The three buttons, which the product turns on and off.
#[derive(Id)]
pub struct ActionsId;
/// The photos' fieldset: patched with its input, which keeps its files through a refusal.
#[derive(Id)]
pub struct PhotosId;

/// An amount in its currency, or "Not set" (`formatMoney`).
fn money(t: ListingNewMsg, amount: Option<&str>, currency: &str) -> String {
    match (amount.and_then(platform::money::decimal), Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => t.page_not_set().to_owned(),
    }
}

/// An inventory item as the select shows it (`inventoryLabel`).
fn inventory_label(t: ListingNewMsg, item: &SupplyItem) -> String {
    let summary = item.product_summary.as_ref().map(|s| s.replace(" | ", ", "));
    let measure = item.product_measure_snapshot.is_none().then(|| t.page_shipping_measure_missing().to_owned());
    let available = Some(t.page_quantity_available(item.available_quantity).to_string());
    [
        Some(item.item_title.clone().unwrap_or_else(|| item.catalog_catalog_item_id.clone())),
        item.item_subtitle.clone(),
        summary,
        measure,
        available,
        item.storage_location_name.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" - ")
}

/// The page: the header, then the form.
#[component(css)]
pub fn NewListingPage<'a>(t: ListingNewMsg, p: Pilot, screen: &'a NewListingScreen) -> impl Render {
    let f = ListingFields::FIELDS;
    let back = url::SellerListings::default().href();
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.page_seller()}</p>
                <h1 class={Title}>{t.page_create_listing()}</h1>
                <p class={Muted}>{t.page_choose_a_product_price_and_quantity()}</p>
            </div>
            <a class={(Button, Secondary)} href={&back}>{t.page_back_to_listings()}</a>
        </header>
        <form
            id={ListingFormId}
            class={Form}
            method="post"
            action={url::NewListing}
            enctype="multipart/form-data"
            data-patch
            on:change={handlers::redraw(event)}
            on:input={handlers::find(event)}
        >
            <button
                class={Unseen}
                type="submit"
                name={f.redraw}
                value="1"
                formmethod="get"
                formnovalidate
                tabindex="-1"
                aria-hidden="true"
            >
                {p.listing_new_update_options()}
            </button>
            {SubmitKey::field(f.attempt)}
            <NoticePart t={t} p={p} screen={screen} />
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.page_list_without_managing_inventory()}</p>
                <p>{t.page_choose_a_product_price_and_quantity()}</p>
            </div>
            <div class={Columns}>
                <ProductPart t={t} p={p} screen={screen} />
                <div class={Column}>
                    <PhotosPart t={t} screen={screen} />
                    <ReadinessPart t={t} screen={screen} />
                </div>
            </div>
            <div class={Guidance}>
                <p class={Muted}>{t.guidance_description()}</p>
                <p class={Links}>
                    <a href={&on_marketplace("/help/buying/community-guidelines-and-enforcement")}>
                        {t.guidance_community_guidelines()}
                    </a>
                    <a href={&on_marketplace("/contact")}>{t.guidance_contact_support()}</a>
                </p>
            </div>
            <ActionsPart t={t} screen={screen} />
            <FeesPart t={t} screen={screen} />
        </form>
    }
}

/// The parts a `GET` of the form or a refused create redraws in place, as a patch.
#[component(css = NewListingPage)]
pub fn NewListingParts<'a>(t: ListingNewMsg, p: Pilot, screen: &'a NewListingScreen) -> impl Patch {
    html! {
        <NoticePart t={t} p={p} screen={screen} />
        <ProductPart t={t} p={p} screen={screen} />
        <PhotosPart t={t} screen={screen} />
        <ReadinessPart t={t} screen={screen} />
        <ActionsPart t={t} screen={screen} />
        <FeesPart t={t} screen={screen} />
    }
}

/// The photos' fieldset: the file input, marked invalid with its message after a refusal. A
/// patch keeps the files chosen in it (Corten's `keep`), so a refused create redraws it in place.
#[component(css = NewListingPage)]
fn PhotosPart<'a>(t: ListingNewMsg, screen: &'a NewListingScreen) -> impl Patch {
    let f = ListingFields::FIELDS;
    let e = screen.errors.within(ListingFormId);
    html! {
        <fieldset id={PhotosId} class={Photos}>
            <legend class={Label}>{t.page_listing_photos()}</legend>
            <p class={Muted}>{t.page_listing_photos_description()}</p>
            <input
                type="file"
                name={f.evidence}
                accept={PICTURES}
                multiple
                capture="environment"
                {..e.aria(f.evidence).hint(&ListingPhotosHintId)}
            >
            <p id={ListingPhotosHintId} class={Hint}>{t.page_choose_photos()}</p>
            {e.message(f.evidence)}
        </fieldset>
    }
}

/// A refusal, a draft saved, why the page started without what its address asked, and the
/// selected inventory's own notices.
#[component(css = NewListingPage)]
fn NoticePart<'a>(t: ListingNewMsg, p: Pilot, screen: &'a NewListingScreen) -> impl Patch {
    let selected = screen.selected();
    let draft = screen.draft_saved.as_deref().map(|id| crate::seller_listing::at(id, None, None).href());
    html! {
        <div id={NoticeId} class={Notices} role="status" aria-live="polite">
            if !screen.errors.is_empty() {
                <div class={Banner} data-tone="danger" tabindex="-1">
                    <p class={Strong}>{t.page_create_listing()}</p>
                    {screen.errors.form_message()}
                    if let Some(draft) = &draft {
                        <p>{p.listing_new_draft_saved()} <a href={draft}>{p.listing_new_open_draft()}</a></p>
                    }
                    if screen.photos_lost {
                        <p>{p.listing_new_photos_again()}</p>
                    }
                </div>
            }
            if let Some(notice) = &screen.notice {
                <div class={Banner} data-tone="danger">
                    <p class={Strong}>{t.page_create_listing()}</p>
                    <p>{notice}</p>
                </div>
            }
            if let Some(item) = selected {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{t.page_advanced_inventory_selected()}</p>
                    <p>{inventory_label(t, item)}</p>
                    <p>{t.page_the_listing_will_use_this_inventory()}</p>
                </div>
            }
            if screen.blocks_publication() {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.page_shipping_measure_missing()}</p>
                    <p>{t.page_publish_requires_shipping_measure()}</p>
                </div>
            }
        </div>
    }
}

/// The product, price, quantity, ship-from, and the advanced inventory and limits.
#[component(css = NewListingPage)]
fn ProductPart<'a>(t: ListingNewMsg, p: Pilot, screen: &'a NewListingScreen) -> impl Patch {
    let f = ListingFields::FIELDS;
    let e = screen.errors.within(ListingFormId);
    let d = &screen.draft;
    html! {
        <div id={ProductId} class={Column}>
            <CatalogPicker t={t} p={p} screen={screen} />
            <div class={Grid}>
                <label class={Field}>
                    <span class={Label}>{t.page_price()}</span>
                    <input
                        type="text"
                        name={f.price_amount}
                        value={&d.price_amount}
                        inputmode="decimal"
                        placeholder="24.99"
                        required
                        {..e.aria(f.price_amount)}
                    >
                    {e.message(f.price_amount)}
                </label>
                <label class={Field}>
                    <span class={Label}>{t.page_price_currency_code()}</span>
                    <input
                        type="text"
                        name={f.price_currency_code}
                        value={&d.price_currency_code}
                        placeholder={t.page_price_currency_code_placeholder()}
                        minlength="3"
                        maxlength="3"
                        autocapitalize="characters"
                        required
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.page_quantity_cap()}</span>
                    <input
                        type="number"
                        name={f.quantity_cap}
                        value={&d.quantity_cap}
                        min="1"
                        step="1"
                        inputmode="numeric"
                        required
                    >
                </label>
            </div>
            <p class={Hint}>{t.page_quantity_cap_exposure_copy()}</p>
            if !screen.has_stock_location {
                <fieldset class={Group}>
                    <legend class={Label}>{t.page_ship_from()}</legend>
                    <div class={Grid}>
                        <label class={Field}>
                            <span class={Label}>{t.page_ship_from_name()}</span>
                            <input type="text" name={f.ship_from_name} value={&d.ship_from.name} autocomplete="name">
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_ship_from_line1()}</span>
                            <input type="text" name={f.ship_from_line1} value={&d.ship_from.line1} autocomplete="address-line1">
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_ship_from_city()}</span>
                            <input type="text" name={f.ship_from_city} value={&d.ship_from.city} autocomplete="address-level2">
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_ship_from_state()}</span>
                            <input type="text" name={f.ship_from_state} value={&d.ship_from.state} autocomplete="address-level1">
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_ship_from_postal_code()}</span>
                            <input
                                type="text"
                                name={f.ship_from_postal_code}
                                value={&d.ship_from.postal_code}
                                autocomplete="postal-code"
                            >
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_ship_from_country()}</span>
                            <input type="text" name={f.ship_from_country} value={&d.ship_from.country} autocomplete="country">
                        </label>
                    </div>
                </fieldset>
            }
            <details class={Advanced} open={!d.inventory_item_id.is_empty()}>
                <summary class={Strong}>{t.page_advanced_inventory_and_limits()}</summary>
                <div class={Column}>
                    <p class={Links}>
                        <a href={url::Inventory::default()}>{t.page_inventory()}</a>
                        <a href={url::Imports::default()}>{t.page_import()}</a>
                        <a href={url::Locations::default()}>{t.page_locations()}</a>
                    </p>
                    if screen.supply.is_empty() {
                        <p class={Hint}>{t.page_no_advanced_inventory_available()}</p>
                    } else {
                        <div class={Inline}>
                            <label class={Field}>
                                <span class={Label}>{t.page_use_existing_inventory()}</span>
                                <select name={f.inventory_item_id} data-redraw>
                                    <option value="" selected={d.inventory_item_id.is_empty()}>
                                        {t.page_automatic_listing_stock()}
                                    </option>
                                    for item in &screen.supply {
                                        <option value={&item.item_id} selected={item.item_id == d.inventory_item_id}>
                                            {inventory_label(t, item)}
                                        </option>
                                    }
                                </select>
                            </label>
                            <button
                                class={(Button, Secondary)}
                                type="submit"
                                name={f.redraw}
                                value="1"
                                formmethod="get"
                                formnovalidate
                            >
                                {p.listing_new_use_inventory()}
                            </button>
                        </div>
                    }
                    <div class={Grid}>
                        <label class={Field}>
                            <span class={Label}>{t.page_limit_per_order()}</span>
                            <input
                                type="number"
                                name={f.max_units_per_order}
                                value={&d.max_units_per_order}
                                min="1"
                                step="1"
                                inputmode="numeric"
                            >
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_limit_per_day()}</span>
                            <input
                                type="number"
                                name={f.max_units_per_day}
                                value={&d.max_units_per_day}
                                min="1"
                                step="1"
                                inputmode="numeric"
                            >
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_limit_per_customer()}</span>
                            <input
                                type="number"
                                name={f.max_units_per_customer_account}
                                value={&d.max_units_per_customer_account}
                                min="1"
                                step="1"
                                inputmode="numeric"
                            >
                        </label>
                    </div>
                    <p class={Hint}>{t.page_purchase_limits_copy()}</p>
                </div>
            </details>
        </div>
    }
}

/// The catalog search and its matches, or the chosen item and its options.
#[component(css = NewListingPage)]
fn CatalogPicker<'a>(t: ListingNewMsg, p: Pilot, screen: &'a NewListingScreen) -> impl Render {
    let f = ListingFields::FIELDS;
    let d = &screen.draft;
    let status = match &screen.catalog {
        Catalog::Idle => Some(t.page_select_a_catalog_item()),
        Catalog::Matches(_) => Some(t.page_choose_the_visible_catalog_item()),
        Catalog::NoMatch => Some(t.page_no_active_catalog_items_matched()),
        Catalog::Failed => Some(t.page_catalog_item_lookup_failed()),
        Catalog::Chosen { .. } => None,
    };
    html! {
        <div class={Picker}>
            if let Catalog::Chosen { item, picks, reset } = &screen.catalog {
                <input type="hidden" name={f.catalog_item_id} value={&item.catalog_item_id}>
                <div class={Chosen}>
                    <div>
                        <p class={Strong}>{&item.title}</p>
                        if let Some(subtitle) = &item.subtitle {
                            <p class={Muted}>{subtitle}</p>
                        }
                    </div>
                    <button class={(Button, Ghost)} type="submit" name={f.change} value="1" formmethod="get" formnovalidate>
                        {p.listing_new_change_item()}
                    </button>
                </div>
                if *reset {
                    <div class={Banner} data-tone="warning"><p>{t.page_product_options_changed()}</p></div>
                }
                if let Some(schema) = &item.product_schema {
                    <div class={Grid}>
                        for dimension in items::active_dimensions(schema, picks) {
                            <label class={Field}>
                                <span class={Label}>{&dimension.dimension_name}</span>
                                <select
                                    name={format!("{OPTION}{}", dimension.dimension_id)}
                                    data-redraw
                                    required={dimension.required}
                                >
                                    if !picks.contains_key(&dimension.dimension_id) {
                                        <option value="" selected>{t.page_choose_product_option()}</option>
                                    }
                                    for option in items::ordered_options(dimension) {
                                        <option
                                            value={&option.option_id}
                                            selected={picks.get(&dimension.dimension_id) == Some(&option.option_id)}
                                        >
                                            {items::option_label(option)}
                                        </option>
                                    }
                                </select>
                            </label>
                        }
                    </div>
                    <p>
                        <button
                            class={(Button, Secondary)}
                            type="submit"
                            name={f.redraw}
                            value="1"
                            formmethod="get"
                            formnovalidate
                        >
                            {p.listing_new_update_options()}
                        </button>
                    </p>
                }
            } else {
                <label class={Field}>
                    <span class={Label}>{t.page_search_catalog()}</span>
                    <input
                        type="search"
                        name={f.q}
                        value={&d.q}
                        placeholder={t.page_search_or_paste_catalog_item()}
                        aria-describedby="catalog-search-hint catalog-search-status"
                        autocomplete="off"
                        data-find
                    >
                </label>
                <p id="catalog-search-hint" class={Hint}>{t.page_search_by_title_or_paste_catalog()}</p>
                <div class={Inline}>
                    <button
                        class={(Button, Secondary)}
                        type="submit"
                        name={f.redraw}
                        value="1"
                        formmethod="get"
                        formnovalidate
                        data-find
                    >
                        {p.listing_new_find()}
                    </button>
                    if let Some(status) = status {
                        <p id="catalog-search-status" class={Hint}>{status}</p>
                    }
                </div>
                if let Catalog::Matches(found) = &screen.catalog {
                    <ul class={Matches}>
                        for item in found {
                            <li class={Match}>
                                <div>
                                    <p class={Strong}>{&item.title}</p>
                                    if let Some(about) = item.subtitle.as_ref().filter(|s| !s.trim().is_empty()).or(item.category.as_ref()) {
                                        <p class={Muted}>{about}</p>
                                    }
                                </div>
                                <button
                                    class={(Button, Secondary)}
                                    type="submit"
                                    name={f.choose}
                                    value={&item.catalog_item_id}
                                    formmethod="get"
                                    formnovalidate
                                >
                                    {p.listing_new_choose()}
                                </button>
                            </li>
                        }
                    </ul>
                }
            }
        </div>
    }
}

/// The evidence the selected inventory item needs (`EvidenceReadinessChecklist`), or what to do
/// to see it.
#[component(css = NewListingPage)]
fn ReadinessPart<'a>(t: ListingNewMsg, screen: &'a NewListingScreen) -> impl Patch {
    html! {
        <div id={ReadinessId} class={Column}>
            if let Some(readiness) = &screen.readiness {
                <Checklist t={t} readiness={readiness} />
            } else {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{t.evidence_readiness_pending_title()}</p>
                    <p>{t.evidence_readiness_select_inventory()}</p>
                </div>
            }
        </div>
    }
}

/// An unmet code's words.
fn coverage(t: ListingNewMsg, code: &str) -> &'static str {
    match code {
        "min-photo-count-unmet" => t.coverage_min_photo_count_unmet(),
        "slot-view-mismatch" => t.coverage_slot_view_mismatch(),
        "slot-dimensions-too-small" => t.coverage_slot_dimensions_too_small(),
        "slot-expired" => t.coverage_slot_expired(),
        "duplicate-source" => t.coverage_duplicate_source(),
        _ => t.coverage_slot_missing(),
    }
}

#[component(css = NewListingPage)]
fn Checklist<'a>(t: ListingNewMsg, readiness: &'a EvidenceReadiness) -> impl Render {
    let c = &readiness.coverage;
    let enough = c.active_photo_count >= c.minimum_photo_count;
    let state = |done: bool| if done { t.evidence_complete() } else { t.evidence_action_required() };
    let slot = |id: &str| readiness.requirements.required_slots.iter().find(|s| s.slot_id == id);
    html! {
        <div class={Banner} data-tone={if readiness.ready { "success" } else { "warning" }}>
            if readiness.ready {
                <p class={Strong}>{t.evidence_ready_title()}</p>
                <p>{t.evidence_ready_description()}</p>
            } else {
                <p class={Strong}>{t.evidence_required_title()}</p>
                <p>{t.evidence_required_description()}</p>
            }
        </div>
        <ul class={Checks}>
            <li class={Check}>
                <p class={Strong}>{t.evidence_minimum_photo_count(c.minimum_photo_count)}</p>
                <span class={State} data-done={enough}>{state(enough)}</span>
                <p class={Muted}>{t.evidence_photo_count_progress(c.active_photo_count, c.minimum_photo_count)}</p>
                if !enough {
                    <p>{t.coverage_min_photo_count_unmet()}</p>
                }
            </li>
            for s in &c.slots {
                <li class={Check}>
                    <p class={Strong}>{t.evidence_required_view(&s.view_kind)}</p>
                    <span class={State} data-done={s.satisfied}>{state(s.satisfied)}</span>
                    <p class={Muted}>
                        {match &s.unmet_code { Some(code) => coverage(t, code), None => t.evidence_view_ready() }}
                    </p>
                    if let Some(required) = slot(&s.slot_id) {
                        <p class={Tags}>
                            <span class={Tag}>{&required.slot_id}</span>
                            if let (Some(w), Some(h)) = (required.minimum_width_pixels, required.minimum_height_pixels) {
                                <span class={Tag}>{t.evidence_minimum_dimensions(w, h)}</span>
                            }
                        </p>
                    }
                </li>
            }
        </ul>
    }
}

/// Create and publish, Preview fees and Save as draft.
#[component(css = NewListingPage)]
fn ActionsPart<'a>(t: ListingNewMsg, screen: &'a NewListingScreen) -> impl Patch {
    let f = ListingFields::FIELDS;
    let blocked = screen.blocks_writes();
    html! {
        <div id={ActionsId} class={Actions}>
            <button
                class={Button}
                type="submit"
                name={f.intent}
                value={Intent::Publish.as_str()}
                disabled={!screen.can_publish()}
            >
                {t.page_create_and_publish()}
            </button>
            <button
                class={(Button, Secondary)}
                type="submit"
                name={f.preview}
                value="1"
                formmethod="get"
                formnovalidate
                disabled={blocked}
            >
                {t.page_preview_fees()}
            </button>
            <button class={(Button, Ghost)} type="submit" name={f.intent} value={Intent::Draft.as_str()} disabled={blocked}>
                {t.page_save_as_draft()}
            </button>
        </div>
    }
}

/// The fee preview (`PriceBreakdown`), once asked for.
#[component(css = NewListingPage)]
fn FeesPart<'a>(t: ListingNewMsg, screen: &'a NewListingScreen) -> impl Patch {
    let currency = screen.draft.price_currency_code.as_str();
    html! {
        <div id={FeesId}>
            if let Some(preview) = &screen.preview {
                <Fees t={t} preview={preview} currency={currency} />
            }
        </div>
    }
}

#[component(css = NewListingPage)]
fn Fees<'a>(t: ListingNewMsg, preview: &'a TermsPreview, currency: &'a str) -> impl Render {
    let credit = preview
        .shipping_allowance_percentage_bps
        .map(|bps| t.percent(corten::i18n::Decimal::new(i128::from(bps), 4), 2).to_string())
        .unwrap_or_default();
    html! {
        <section class={Fees} aria-labelledby="fee-preview-title">
            <h2 id="fee-preview-title" class={PartTitle}>{t.page_listing_fee_preview()}</h2>
            <dl class={Lines}>
                <div>
                    <dt>{t.page_account_type()}</dt>
                    <dd>{&preview.account_type}</dd>
                </div>
                <div>
                    <dt>{t.page_basis_amount()}</dt>
                    <dd>{money(t, preview.basis_amount.as_deref(), currency)}</dd>
                </div>
                <div>
                    <dt>{t.page_locked_fee()}</dt>
                    <dd>{money(t, preview.marketplace_sales_fee_unit_amount.as_deref(), currency)}</dd>
                </div>
                <div>
                    <dt>{t.page_buyer_shipping_credit_summary(&credit)}</dt>
                    <dd>{t.page_if_you_create_the_listing_now()}</dd>
                </div>
                <div>
                    <dt>{t.page_terms_schedule()}</dt>
                    <dd>{preview.schedule_id.as_deref().unwrap_or(t.page_no_schedule_available())}</dd>
                </div>
                <div class={Total}>
                    <dt>{t.page_listing_fee_preview()}</dt>
                    <dd>{money(t, preview.seller_net_unit_amount.as_deref(), currency)}</dd>
                </div>
            </dl>
        </section>
    }
}

/// An account that may not manage listings (the routes' `AccountAccessRequiredPage`): sign in
/// with another, coming `back` to the page asked for.
#[component(css = NewListingPage)]
pub fn ListingAccessRequired<'a>(t: ListingNewMsg, back: &'a str) -> impl Render {
    let sign_in = url::SignIn { ask: crate::sign_in::Ask::back_to(back) };
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.route_account_access()}</p>
                <h1 class={Title}>{t.route_account_access_required_title()}</h1>
                <p class={Muted}>{t.route_account_access_required_description()}</p>
            </div>
        </header>
        <section class={Group} aria-labelledby="next-step-title">
            <h2 id="next-step-title" class={PartTitle}>{t.route_next_step()}</h2>
            <p>{t.route_use_an_account_with_listing_access()}</p>
            <p class={Actions}>
                <a class={Button} href={&sign_in}>{t.route_use_a_different_account()}</a>
                <a class={(Button, Secondary)} href={url::AccountHome::default()}>{t.route_view_account()}</a>
            </p>
        </section>
    }
}
