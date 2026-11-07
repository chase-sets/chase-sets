//! Inventory (marketplace's `InventoryItemListPage`): the header with Manage locations, what the last
//! write and the last sale did, Create inventory item, and the items, a table from 48rem and a
//! card each on a phone, with Open, Create listing and Record sale.
//!
//! Every action works without JavaScript. The catalog picker's steps are GETs of the page (Create
//! listing's script, `listing_new.js`, asks for them as the seller types or picks an option, and
//! the form is drawn again in place). Record sale is a link to the page with the item's dialog
//! open; the dialog is modal once it joins the page (corten-ui's `dialog::modal`).
use corten::{i18n::Currency, prelude::*, view::AttrValue};

use super::{WriteForm, cart_item::options, listing_new_page::handlers as picker};
use crate::{
    api::{InventoryItem, segment},
    app::url,
    auth::Viewer,
    inventory_list::{CHANNELS, CreateItem, InventoryScreen, ItemFields, Outcome, SaleDraft, SaleInput, Verified},
    items,
    listing_new::{Catalog, Draft, OPTION},
    recovery::{Family, Status},
    text::{InventoryMsg, Msg, Pilot},
};

/// Create inventory item's form: a refused create's patch replaces it.
#[derive(Id, Clone, Copy)]
pub struct CreateItemFormId;
/// Record sale's dialog and its form.
#[derive(Id, Clone, Copy)]
pub struct SaleDialogId;
#[derive(Id, Clone, Copy)]
pub struct SaleFormId;
/// The outcome of the last sale, which takes focus.
#[derive(Id)]
pub struct SaleOutcomeId;

fn label(item: &InventoryItem) -> &str {
    item.item_title.as_deref().unwrap_or(&item.catalog_catalog_item_id)
}

/// A language code's name (`formatLanguageCodeLabel`).
pub(super) fn language(t: InventoryMsg, code: &str) -> String {
    match code {
        "en" => t.language_en().to_owned(),
        "ja" => t.language_ja().to_owned(),
        other => other.to_owned(),
    }
}

/// The acquisition cost (`displayCost`).
fn cost(t: InventoryMsg, item: &InventoryItem) -> String {
    let Some(amount) = item.acquisition_cost_amount.as_deref().filter(|a| !a.is_empty()) else {
        return t.list_not_set().to_owned();
    };
    let currency = item.acquisition_cost_currency_code.as_deref().and_then(|c| Currency::parse(c.trim()));
    match (platform::money::decimal(amount), currency) {
        (Some(decimal), Some(currency)) => t.money(decimal, currency).to_string(),
        (_, Some(_)) => amount.to_owned(),
        _ => t.list_acquisition_cost_currency_not_recorded(amount).to_string(),
    }
}

/// The page.
#[component(css)]
pub fn InventoryPage<'a>(
    t: InventoryMsg,
    p: Pilot,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a InventoryScreen,
    create: &'a CreateItem,
    sale: Option<&'a SaleDraft>,
    again: &'a url::Inventory,
) -> impl Render {
    let list = url::Inventory::default().href();
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.list_seller()}</p>
                <h1 class={Title}>{t.list_inventory()}</h1>
                <p class={Muted}>{t.list_manage_private_seller_stock_availability_and()}</p>
            </div>
            <a class={(Button, Secondary)} href={url::Locations::default()}>{t.list_manage_locations()}</a>
        </header>
        <super::Recovery t={m} viewer={viewer} status={&screen.status} check={&again.check} again={&again.href()} list={&list} />
        if let Some(message) = &screen.load_error {
            <p class={Notice} role="status">{message}</p>
        }
        if let Some(outcome) = &screen.outcome {
            <SaleOutcome t={t} outcome={outcome} verified={screen.verified} />
        }
        <section class={Section} aria-labelledby="create-item-title">
            <h2 id="create-item-title" class={PartTitle}>{t.list_create_inventory_item()}</h2>
            <div class={Card}>
                <CreateItemForm t={t} p={p} m={m} viewer={viewer} screen={screen} create={create} />
            </div>
        </section>
        <section class={Section} aria-labelledby="inventory-items-title">
            <h2 id="inventory-items-title" class={PartTitle}>{t.list_current_inventory_items()}</h2>
            <Items t={t} p={p} screen={screen} />
        </section>
        if let (Some(item), Some(draft)) = (screen.selling(), sale) {
            <SaleDialog t={t} p={p} item={item} screen={screen} draft={draft} />
        }
    }
}

/// Create inventory item (marketplace's create card): the catalog picker, then the location,
/// quantity and cost.
#[component(css = InventoryPage)]
pub fn CreateItemForm<'a>(
    t: InventoryMsg,
    p: Pilot,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a InventoryScreen,
    create: &'a CreateItem,
) -> impl Patch {
    let f = ItemFields::FIELDS;
    let e = create.errors.within(CreateItemFormId);
    html! {
        <WriteForm
            t={m}
            id={CreateItemFormId}
            action={url::Inventory::default()}
            viewer={viewer}
            family={Family::ItemCreate}
            target="draft"
            attempt={f.inventory_mutation_attempt_id}
            errors={&create.errors}
            enabled={screen.status.writes()}
        >
            <div class={Create} on:change={picker::redraw(event)} on:input={picker::find(event)}>
                if let Some(back) = &create.return_to {
                    <input type="hidden" name={f.return_to} value={back}>
                }
                <div class={Column}>
                    <Picker t={t} p={p} draft={&create.draft} catalog={&create.catalog} />
                    if create.graded() {
                        <label class={Field}>
                            <span class={Label}>{t.list_certification_number()}</span>
                            <input type="text" name={f.certification_number} value={&create.certification_number}>
                        </label>
                    }
                    {e.message(f.q)}
                </div>
                <div class={Column}>
                    <div class={Field}>
                        <label class={Field}>
                            <span class={Label}>{t.list_storage_location()}</span>
                            <select name={f.storage_location_id} required {..e.aria(f.storage_location_id)}>
                                <option value="" selected={create.storage_location_id.is_empty()}>
                                    {t.list_select_a_location()}
                                </option>
                                for location in &screen.locations {
                                    <option
                                        value={&location.storage_location_id}
                                        selected={location.storage_location_id == create.storage_location_id}
                                    >
                                        {&location.name}
                                    </option>
                                }
                            </select>
                        </label>
                        {e.message(f.storage_location_id)}
                    </div>
                    <div class={Three}>
                        <div class={Field}>
                            <label class={Field}>
                                <span class={Label}>{t.list_total_quantity()}</span>
                                <input
                                    type="number"
                                    name={f.total_quantity}
                                    value={&create.total_quantity}
                                    min="1"
                                    step="1"
                                    inputmode="numeric"
                                    required
                                    {..e.aria(f.total_quantity)}
                                >
                            </label>
                            {e.message(f.total_quantity)}
                        </div>
                        <label class={Field}>
                            <span class={Label}>{t.list_acquisition_cost()}</span>
                            <input
                                type="text"
                                name={f.acquisition_cost_amount}
                                value={&create.cost_amount}
                                placeholder="4.25"
                                inputmode="decimal"
                            >
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.list_acquisition_cost_currency_code()}</span>
                            <input
                                type="text"
                                name={f.acquisition_cost_currency_code}
                                value={&create.cost_currency}
                                placeholder="USD"
                                maxlength="3"
                                autocapitalize="characters"
                            >
                        </label>
                    </div>
                    <p class={Row}>
                        <button class={Button} type="submit" disabled={create.ready().is_none()}>
                            {t.list_create_inventory_item_2()}
                        </button>
                        <a class={(Button, Ghost)} href={url::Locations::default()}>{t.list_need_a_location_first()}</a>
                    </p>
                </div>
            </div>
        </WriteForm>
    }
}

/// The catalog picker (Create listing's, in the Inventory context's words): the chosen item with
/// its options, or the search and its matches. Each step is a GET of the page.
#[component(css = InventoryPage)]
pub fn Picker<'a>(t: InventoryMsg, p: Pilot, draft: &'a Draft, catalog: &'a Catalog) -> impl Render {
    let f = ItemFields::FIELDS;
    let status = match catalog {
        Catalog::Idle => None,
        Catalog::Matches(_) => Some(t.list_choose_the_visible_catalog_item()),
        Catalog::NoMatch => Some(t.list_no_active_catalog_items_matched()),
        Catalog::Failed => Some(t.list_catalog_item_lookup_failed()),
        Catalog::Chosen { .. } => None,
    };
    html! {
        if let Catalog::Chosen { item, picks, reset } = catalog {
            <div class={Chosen}>
                <input type="hidden" name={f.catalog_item_id} value={&item.catalog_item_id}>
                <p class={Label}>{t.list_catalog_item()}</p>
                <p class={Strong}>{&item.title}</p>
                if let Some(subtitle) = item.subtitle.as_ref().filter(|s| !s.trim().is_empty()) {
                    <p class={Muted}>{subtitle}</p>
                }
                if item.status != "active" {
                    <p class={Error} role="alert">{t.list_catalog_item_not_active()}</p>
                }
                if *reset {
                    <p class={Error} role="alert">{t.list_catalog_item_options_stale()}</p>
                }
                match &item.product_schema {
                    Some(schema) if !schema.dimensions.is_empty() => {
                        <fieldset class={Options}>
                            <legend class={Label}>{p.inventory_options()}</legend>
                            for dimension in items::active_dimensions(schema, picks) {
                                <label class={Field}>
                                    <span class={Label}>{&dimension.dimension_name}</span>
                                    <select
                                        name={format!("{OPTION}{}", dimension.dimension_id)}
                                        data-redraw
                                        required={dimension.required}
                                    >
                                        if !picks.contains_key(&dimension.dimension_id) {
                                            <option value="" selected>{p.inventory_choose_option()}</option>
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
                        </fieldset>
                    }
                    _ => {
                        <p class={Muted}>{t.list_this_catalog_item_does_not_require()}</p>
                    }
                }
                <p>
                    <button class={(Button, Ghost)} type="submit" name={f.change} value="1" formmethod="get" formnovalidate>
                        {p.listing_new_change_item()}
                    </button>
                </p>
            </div>
        } else {
            <label class={Field}>
                <span class={Label}>{t.list_catalog_item()}</span>
                <input
                    type="search"
                    name={f.q}
                    value={&draft.q}
                    placeholder={t.list_search_or_paste_catalog_item()}
                    aria-describedby="item-search-hint item-search-status"
                    autocomplete="off"
                    data-find
                >
            </label>
            <p id="item-search-hint" class={Hint}>{t.list_search_by_title_or_paste_catalog()}</p>
            <div class={Row}>
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
                <p id="item-search-status" class={Hint} role="status">
                    {status.unwrap_or(t.list_search_for_a_catalog_item_then())}
                </p>
            </div>
            if let Catalog::Matches(found) = catalog {
                <ul class={Matches}>
                    for item in found {
                        <li class={Match}>
                            <div>
                                <p class={Strong}>{&item.title}</p>
                                if let Some(about) = item.subtitle.as_ref().filter(|s| !s.trim().is_empty()) {
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
    }
}

/// The items: a table from 48rem, a card each below (the cells label themselves), and the pages.
#[component(css = InventoryPage)]
fn Items<'a>(t: InventoryMsg, p: Pilot, screen: &'a InventoryScreen) -> impl Render {
    let page = &screen.items;
    let (limit, offset) = screen.place.bounds();
    let (current, pages) = (offset / limit + 1, page.total.div_ceil(limit).max(1));
    let paged = page.total > limit || offset > 0;
    html! {
        if page.items.is_empty() {
            <div class={Card}>
                <p class={Strong}>{t.list_no_inventory_items_yet()}</p>
                <p class={Muted}>{t.list_create_your_first_inventory_item_to()}</p>
            </div>
        } else {
            <table class={Table}>
                <thead>
                    <tr>
                        <th scope="col">{t.list_inventory_item()}</th>
                        <th scope="col">{t.list_location()}</th>
                        <th scope="col" class={Number}>{t.list_total()}</th>
                        <th scope="col" class={Number}>{t.list_held()}</th>
                        <th scope="col" class={Number}>{t.list_available()}</th>
                        <th scope="col">{t.list_acquisition_cost_2()}</th>
                        <th scope="col">{t.list_actions()}</th>
                    </tr>
                </thead>
                <tbody>
                    for item in &page.items {
                        <ItemRow t={t} p={p} item={item} screen={screen} />
                    }
                </tbody>
            </table>
        }
        if paged {
            <nav class={Pages} aria-label={p.inventory_pages()}>
                if offset > 0 {
                    <a class={(Button, Secondary)} href={screen.place.at(offset.saturating_sub(limit))} rel="prev">
                        {p.inventory_previous()}
                    </a>
                }
                <span>{p.inventory_page_of(current, pages)}</span>
                if offset + limit < page.total {
                    <a class={(Button, Secondary)} href={screen.place.at(offset + limit)} rel="next">{p.inventory_next()}</a>
                }
            </nav>
        }
    }
}

#[component(css = InventoryPage)]
fn ItemRow<'a>(t: InventoryMsg, p: Pilot, item: &'a InventoryItem, screen: &'a InventoryScreen) -> impl Render {
    let id = item.item_id.as_str();
    let open = url::StockItem { id, place: Default::default(), check: Default::default() };
    let listing = format!("{}?inventoryItemId={}", url::NewListing.href(), segment(id));
    html! {
        <tr>
            <td class={Item}>
                <span class={Strong}>{label(item)}</span>
                if let Some(code) = &item.language_code {
                    <span class={Badge}>{language(t, code)}</span>
                }
                if let Some(subtitle) = &item.item_subtitle {
                    <span class={Muted}>{subtitle}</span>
                }
                if item.product_summary.is_some() {
                    <span class={Chips}>
                        for option in options(item.product_summary.as_deref()) {
                            <span class={Chip}>{option}</span>
                        }
                    </span>
                }
            </td>
            <td data-label={t.list_location()}>{&item.storage_location_name}</td>
            <td class={Number} data-label={t.list_total()}>{item.total_quantity}</td>
            <td class={Number} data-label={t.list_held()}>{item.held_quantity}</td>
            <td class={Number} data-label={t.list_available()}>{item.available_quantity}</td>
            <td data-label={t.list_acquisition_cost_2()}>{cost(t, item)}</td>
            <td class={Actions}>
                <a class={(Button, Secondary, Small)} href={&open}>{t.list_open()}</a>
                if item.available_quantity > 0 {
                    <a class={(Button, Ghost, Small)} href={&listing}>{t.list_create_listing()}</a>
                }
                if screen.can_record_sale {
                    <a
                        class={(Button, Secondary, Small)}
                        href={screen.place.selling(id)}
                        aria-label={p.inventory_record_sale_for(label(item)).to_string()}
                    >
                        {t.sale_trigger()}
                    </a>
                }
            </td>
        </tr>
    }
}

/// What the last sale did (`OfflineSaleResult`), with each order it affected.
#[component(css = InventoryPage)]
pub fn SaleOutcome<'a>(t: InventoryMsg, outcome: &'a Outcome, verified: Option<Verified>) -> impl Render {
    let complete = outcome.applied == outcome.requested;
    let fresh = match verified {
        Some(Verified::Fresh(available)) => Some(available),
        _ => None,
    };
    let verified_complete = complete && fresh.is_some();
    let message = if complete {
        fresh.map(|available| t.sale_completed(outcome.applied, available).to_string())
    } else if outcome.applied == 0 {
        Some(t.sale_refused(outcome.refused).to_string())
    } else {
        Some(t.sale_partial(outcome.applied, outcome.refused).to_string())
    };
    html! {
        <div
            id={SaleOutcomeId}
            class={Outcome}
            data-tone={if verified_complete { "success" } else { "warning" }}
            role={if verified_complete { "status" } else { "alert" }}
            tabindex="-1"
            autofocus
        >
            if fresh.is_none() {
                <p class={Strong}>{t.sale_result_unverified()}</p>
            }
            if let Some(message) = &message {
                <p class={Strong}>{message}</p>
            }
            if !outcome.orders.is_empty() {
                <p class={Row}>
                    for order in &outcome.orders {
                        <a class={(Button, Secondary, Small)} href={url::Sale { id: order, after: Default::default() }}>
                            {t.sale_affected_order(order)}
                        </a>
                    }
                </p>
            }
        </div>
    }
}

/// Record sale's dialog for `item`, drawn open; Close goes back to the list.
#[component(css = InventoryPage)]
fn SaleDialog<'a>(
    t: InventoryMsg,
    p: Pilot,
    item: &'a InventoryItem,
    screen: &'a InventoryScreen,
    draft: &'a SaleDraft,
) -> impl Render {
    let close = screen.place.at(screen.place.bounds().1);
    let back = refs();
    html! {
        <dialog
            id={SaleDialogId}
            class={Dialog}
            aria-labelledby="sale-title"
            aria-describedby="sale-description"
            open
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <div class={DialogHead}>
                <h2 id="sale-title" class={PartTitle}>{t.sale_title()}</h2>
                <a ref={back} class={(Button, Ghost, Small)} href={close}>{t.sale_close()}</a>
            </div>
            <p id="sale-description" class={Muted}>{t.sale_sheet_description(label(item))}</p>
            <SaleForm
                t={t}
                p={p}
                action={screen.place.sale_to(&item.item_id)}
                draft={draft}
                can_honor={screen.can_honor}
                autofocus={true}
            />
        </dialog>
    }
}

/// Record sale's form (`OfflineSaleForm`). Honoring a sale over the orders it would take stock
/// from asks for the confirmation, which the stylesheet shows once that is chosen.
#[component(css = InventoryPage)]
pub fn SaleForm<'a, A: AttrValue>(
    t: InventoryMsg,
    p: Pilot,
    action: A,
    draft: &'a SaleDraft,
    can_honor: bool,
    /// The dialog's first field takes focus as it opens; on a page it waits to be chosen.
    autofocus: bool,
) -> impl Patch {
    let f = SaleInput::FIELDS;
    let (input, errors) = (&draft.input, &draft.errors);
    let e = errors.within(SaleFormId);
    let honor = input.collision_mode == "honor-offline";
    let channel = |c: &str| match c {
        "in-store" => t.sale_channel_in_store(),
        "card-show" => t.sale_channel_card_show(),
        _ => t.sale_channel_other(),
    };
    html! {
        <form id={SaleFormId} class={Form} method="post" action={action} data-patch>
            {SubmitKey::field(f.idempotency_key)}
            {errors.form_message()}
            <div class={Field}>
                <label class={Field}>
                    <span class={Label}>{t.sale_quantity()}</span>
                    <input
                        type="number"
                        name={f.quantity}
                        value={&input.quantity}
                        min="1"
                        step="1"
                        inputmode="numeric"
                        required
                        autofocus={autofocus}
                        {..e.aria(f.quantity)}
                    >
                </label>
                {e.message(f.quantity)}
            </div>
            <div class={Field}>
                <label class={Field}>
                    <span class={Label}>{t.sale_price_per_item()}</span>
                    <span class={Money}>
                        <span aria-hidden="true">"$"</span>
                        <input
                            type="text"
                            name={f.sale_price_amount}
                            value={&input.sale_price_amount}
                            inputmode="decimal"
                            autocomplete="off"
                            {..e.aria(f.sale_price_amount)}
                        >
                        <span class={Muted}>"USD"</span>
                    </span>
                </label>
                {e.message(f.sale_price_amount)}
            </div>
            <div class={Field}>
                <label class={Field}>
                    <span class={Label}>{t.sale_channel()}</span>
                    <select name={f.channel} required {..e.aria(f.channel)}>
                        <option value="" selected={input.channel.is_empty()}>{t.sale_channel_placeholder()}</option>
                        for c in CHANNELS {
                            <option value={c} selected={input.channel == c}>{channel(c)}</option>
                        }
                    </select>
                </label>
                {e.message(f.channel)}
            </div>
            <label class={Field}>
                <span class={Label}>{t.sale_note()}</span>
                <textarea name={f.note} rows="3">{&input.note}</textarea>
            </label>
            if can_honor {
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{t.sale_order_commitments()}</span>
                        <select name={f.collision_mode} {..e.aria(f.collision_mode)}>
                            <option value="protect-orders" selected={!honor}>{t.sale_protect_orders()}</option>
                            <option value="honor-offline" selected={honor}>{t.sale_honor_offline()}</option>
                        </select>
                    </label>
                    {e.message(f.collision_mode)}
                </div>
                <div class={(Field, Confirm)}>
                    <label class={Check}>
                        <input
                            type="checkbox"
                            name={f.confirm_seller_cannot_fulfill}
                            value="true"
                            checked={input.confirm_seller_cannot_fulfill == "true"}
                            {..e.aria(f.confirm_seller_cannot_fulfill)}
                        >
                        <span>{t.sale_honor_confirmation()}</span>
                    </label>
                    {e.message(f.confirm_seller_cannot_fulfill)}
                </div>
            } else {
                <input type="hidden" name={f.collision_mode} value="protect-orders">
            }
            <p><button class={Button} type="submit">{t.sale_submit()}</button></p>
        </form>
    }
}

/// A refused create's patch: the status that settles its attempt, and the form again.
pub fn refused_item<'a>(
    t: InventoryMsg,
    p: Pilot,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a InventoryScreen,
    create: &'a CreateItem,
    status: &'a Status,
) -> impl Patch + 'a {
    let (list, check) = (url::Inventory::default().href(), crate::recovery::Check::default());
    html! {
        <super::Recovery t={m} viewer={viewer} status={status} check={&check} again={&list} list={&list} />
        <CreateItemForm t={t} p={p} m={m} viewer={viewer} screen={screen} create={create} />
    }
}
