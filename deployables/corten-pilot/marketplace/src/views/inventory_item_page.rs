//! An inventory item's page (marketplace's `InventoryItemDetailPage`): the header with Create
//! listing and Back to inventory, what the last write and the last sale did, the item, Record
//! sale, Adjust Quantity, Create Hold, the hold history (a manual hold's Release) and the stock
//! ledger with its filter as links.
//!
//! Every action works without JavaScript; each form is a `data-patch` form, so with a script a
//! refused one is drawn again in place. One column on a phone; from 64rem the writes are a column
//! beside the item, its holds and its ledger.
use std::time::{Duration, SystemTime};

use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
    view::Id,
};

use super::{
    WriteForm,
    cart_item::options,
    inventory_page::{SaleForm, SaleOutcome, language},
};
use crate::{
    api::{Hold, LedgerEntry, segment, source_order},
    app::url,
    auth::Viewer,
    inventory_item::{AdjustInput, Drafts, HoldInput, ItemScreen, REASONS, ReleaseInput},
    recovery::{Check, Family},
    text::{InventoryMsg, Msg, Pilot},
};

/// Adjust Quantity's form: a refused adjustment's patch replaces it.
#[derive(Id, Clone, Copy)]
pub struct AdjustFormId;
/// Create Hold's form.
#[derive(Id, Clone, Copy)]
pub struct HoldFormId;
/// A manual hold's Release form.
#[derive(Id, Clone, Copy)]
pub struct ReleaseFormId<'a>(pub &'a str);
/// Record sale's section: a refused sale's patch replaces its form inside.
#[derive(Id)]
pub struct ItemSaleId;

/// A hold's purpose (`holdPurposeLabel`).
fn purpose(t: InventoryMsg, purpose: &str) -> String {
    match purpose {
        "order" => t.item_hold_purpose_order().to_owned(),
        "manual" => t.item_hold_purpose_manual().to_owned(),
        "checkout" => t.item_hold_purpose_checkout().to_owned(),
        "pos" => t.item_hold_purpose_pos().to_owned(),
        "channel" => t.item_hold_purpose_channel().to_owned(),
        "transfer" => t.item_hold_purpose_transfer().to_owned(),
        other => other.to_owned(),
    }
}

/// An adjustment's reason (`adjustmentReasonLabel`).
fn reason(t: InventoryMsg, code: &str) -> String {
    match code {
        "sold-offline" => t.item_adjustment_reason_sold_offline().to_owned(),
        "sold-external-channel" => t.item_adjustment_reason_sold_external_channel().to_owned(),
        "damaged" => t.item_adjustment_reason_damaged().to_owned(),
        "lost" => t.item_adjustment_reason_lost().to_owned(),
        "found" => t.item_adjustment_reason_found().to_owned(),
        "correction" => t.item_adjustment_reason_correction().to_owned(),
        "intake" => t.item_adjustment_reason_intake().to_owned(),
        "return-restocked" => t.item_adjustment_reason_return_restocked().to_owned(),
        other => other.to_owned(),
    }
}

/// A movement's kind (`ledgerKindLabel`). Marketplace has no words for an offline sale and shows
/// its code (chase-sets/chase-sets#10673); the pilot says the adjustment reason's "Sold offline".
fn kind(t: InventoryMsg, p: Pilot, kind: &str) -> String {
    match kind {
        "created" => t.item_ledger_created().to_owned(),
        "adjusted" => t.item_ledger_adjusted().to_owned(),
        "offline-sale" => p.inventory_ledger_offline_sale().to_owned(),
        "hold-placed" => t.item_ledger_hold_placed().to_owned(),
        "hold-converted" => t.item_ledger_hold_converted().to_owned(),
        "hold-consumed" => t.item_ledger_hold_consumed().to_owned(),
        "hold-released" => t.item_ledger_hold_released().to_owned(),
        "hold-expired" => t.item_ledger_hold_expired().to_owned(),
        "restock-decision" => t.item_ledger_restock_decision().to_owned(),
        other => other.to_owned(),
    }
}

/// A time the API sent, as `formatDateTime` writes it; as sent when it is not one.
fn when(t: InventoryMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// How long an active hold has left (`countdownLabel`), as of this answer.
fn countdown(t: InventoryMsg, expires: &str) -> Option<String> {
    let at = parse_timestamp(expires)?;
    let left = at.duration_since(SystemTime::now()).unwrap_or(Duration::ZERO);
    if left.is_zero() {
        return Some(t.item_expired().to_owned());
    }
    let minutes = left.as_secs().div_ceil(60);
    Some(if minutes < 60 {
        t.item_expires_in_minutes(minutes).to_string()
    } else {
        t.item_expires_in_hours(minutes.div_ceil(60)).to_string()
    })
}

/// A movement's facts (`ledgerDescription`), joined as marketplace joins them.
fn facts(t: InventoryMsg, entry: &LedgerEntry) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(delta) = entry.quantity_delta {
        parts.push(t.item_quantity_delta_summary(delta).to_string());
    }
    if let Some(held) = entry.hold_quantity {
        parts.push(t.item_hold_quantity_summary(held).to_string());
    }
    if let Some(p) = entry.purpose.as_deref().filter(|p| !p.is_empty()) {
        parts.push(purpose(t, p));
    }
    if let Some(code) = entry.reason_code.as_deref().filter(|c| !c.is_empty()) {
        parts.push(reason(t, code));
    }
    for text in [Some(entry.reason.as_str()), entry.note.as_deref()].into_iter().flatten() {
        if !text.trim().is_empty() {
            parts.push(text.to_owned());
        }
    }
    parts.push(if entry.actor == "seller" { t.item_actor_seller() } else { t.item_actor_system() }.to_owned());
    parts.push(when(t, &entry.occurred_at));
    parts.join(" | ")
}

/// The page.
#[component(css)]
pub fn InventoryItemPage<'a>(
    t: InventoryMsg,
    p: Pilot,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a ItemScreen,
    drafts: &'a Drafts,
    again: &'a url::StockItem<'a>,
) -> impl Render {
    let item = &screen.item.item;
    let id = item.item_id.as_str();
    let here = url::StockItem { id, place: Default::default(), check: Default::default() }.href();
    let listing = format!("{}?inventoryItemId={}", url::NewListing.href(), segment(id));
    let title = item.item_title.as_deref().unwrap_or(&item.catalog_catalog_item_id);
    let sale = drafts.sale();
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.item_seller()}</p>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{item.item_subtitle.as_deref().unwrap_or(t.item_inventory_item_detail())}</p>
                if let Some(code) = &item.language_code {
                    <p class={Row}><span class={Badge}>{language(t, code)}</span></p>
                }
            </div>
            <p class={Row}>
                if screen.can_manage && item.available_quantity > 0 {
                    <a class={Button} href={&listing}>{t.list_create_listing()}</a>
                }
                <a class={(Button, Secondary)} href={url::Inventory::default()}>{t.item_back_to_inventory()}</a>
            </p>
        </header>
        <super::Recovery t={m} viewer={viewer} status={&screen.status} check={&again.check} again={&again.href()} list={&here} />
        if let Some(notice) = &screen.notice {
            <p class={Notice} role="alert" tabindex="-1" autofocus>{notice}</p>
        }
        if let Some(outcome) = &screen.outcome {
            <SaleOutcome t={t} outcome={outcome} verified={screen.verified} />
        }
        <div class={Layout}>
            <div class={Main}>
                <section class={Section} aria-labelledby="item-summary-title">
                    <h2 id="item-summary-title" class={PartTitle}>{t.item_inventory_item_summary()}</h2>
                    <dl class={(Card, Facts)}>
                        <div>
                            <dt>{t.item_catalog_item()}</dt>
                            <dd>{&item.catalog_catalog_item_id}</dd>
                        </div>
                        if item.product_summary.is_some() {
                            <div>
                                <dt>{t.item_product()}</dt>
                                <dd class={Chips}>
                                    for option in options(item.product_summary.as_deref()) {
                                        <span class={Chip}>{option}</span>
                                    }
                                </dd>
                            </div>
                        }
                        <div>
                            <dt>{t.item_location()}</dt>
                            <dd>{format!("{} ({})", item.storage_location_name, screen.item.ship_from_code)}</dd>
                        </div>
                        <div>
                            <dt>{t.item_total_quantity()}</dt>
                            <dd class={Number}>{item.total_quantity}</dd>
                        </div>
                        <div>
                            <dt>{t.item_held_quantity()}</dt>
                            <dd class={Number}>{item.held_quantity}</dd>
                        </div>
                        <div>
                            <dt>{t.item_available_quantity()}</dt>
                            <dd class={Number}>{item.available_quantity}</dd>
                        </div>
                    </dl>
                </section>
                <section class={Section} aria-labelledby="item-holds-title">
                    <h2 id="item-holds-title" class={PartTitle}>{t.item_hold_history()}</h2>
                    if screen.item.holds.is_empty() {
                        <p class={Card}>{t.item_no_holds_have_been_created_for()}</p>
                    } else {
                        <ul class={Holds}>
                            for hold in &screen.item.holds {
                                <HoldCard t={t} m={m} viewer={viewer} screen={screen} hold={hold} drafts={drafts} />
                            }
                        </ul>
                    }
                </section>
                <Ledger t={t} p={p} screen={screen} />
            </div>
            if screen.can_manage {
                <div class={Aside}>
                    <section id={ItemSaleId} class={Section} aria-labelledby="item-sale-title">
                        <h2 id="item-sale-title" class={PartTitle}>{t.sale_title()}</h2>
                        <div class={Card}>
                            <SaleForm
                                t={t}
                                p={p}
                                action={url::StockSale { id }}
                                draft={sale}
                                can_honor={screen.can_honor}
                                autofocus={false}
                            />
                        </div>
                    </section>
                    <section class={Section} aria-labelledby="item-adjust-title">
                        <h2 id="item-adjust-title" class={PartTitle}>{t.item_adjust_quantity()}</h2>
                        <div class={Card}>
                            <AdjustForm t={t} m={m} viewer={viewer} screen={screen} drafts={drafts} />
                        </div>
                    </section>
                    <section class={Section} aria-labelledby="item-hold-title">
                        <h2 id="item-hold-title" class={PartTitle}>{t.item_create_hold()}</h2>
                        <div class={Card}>
                            <HoldForm t={t} m={m} viewer={viewer} screen={screen} drafts={drafts} />
                        </div>
                    </section>
                </div>
            }
        </div>
    }
}

/// Adjust Quantity: a signed whole number, a reason code, the reason and a note.
#[component(css = InventoryItemPage)]
pub fn AdjustForm<'a>(t: InventoryMsg, m: Msg, viewer: &'a Viewer, screen: &'a ItemScreen, drafts: &'a Drafts) -> impl Patch {
    let f = AdjustInput::FIELDS;
    let id = screen.item.item.item_id.as_str();
    let (input, errors) = drafts.adjust();
    let e = errors.within(AdjustFormId);
    html! {
        <WriteForm
            t={m}
            id={AdjustFormId}
            action={url::StockAdjust { id }}
            viewer={viewer}
            family={Family::ItemAdjust}
            target={id}
            attempt={f.inventory_mutation_attempt_id}
            errors={errors}
            enabled={screen.status.writes()}
        >
            <div class={Form}>
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{t.item_quantity_delta()}</span>
                        <input
                            type="number"
                            name={f.quantity_delta}
                            value={&input.quantity_delta}
                            step="1"
                            required
                            placeholder={t.item_1_or_5()}
                            {..e.aria(f.quantity_delta)}
                        >
                    </label>
                    {e.message(f.quantity_delta)}
                </div>
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{t.item_adjustment_reason_code()}</span>
                        <select name={f.reason_code} required {..e.aria(f.reason_code)}>
                            <option value="" selected={input.reason_code.is_empty()}>
                                {t.item_adjustment_reason_placeholder()}
                            </option>
                            for code in REASONS {
                                <option value={code} selected={input.reason_code == code}>{reason(t, code)}</option>
                            }
                        </select>
                    </label>
                    {e.message(f.reason_code)}
                </div>
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{t.item_reason()}</span>
                        <input type="text" name={f.reason} value={&input.reason} required {..e.aria(f.reason)}>
                    </label>
                    {e.message(f.reason)}
                </div>
                <label class={Field}>
                    <span class={Label}>{t.item_adjustment_note()}</span>
                    <textarea name={f.note} rows="3">{&input.note}</textarea>
                </label>
                <p class={Row}><button class={Button} type="submit">{t.item_apply_adjustment()}</button></p>
            </div>
        </WriteForm>
    }
}

/// Create Hold: a manual hold of some of the item's stock.
#[component(css = InventoryItemPage)]
pub fn HoldForm<'a>(t: InventoryMsg, m: Msg, viewer: &'a Viewer, screen: &'a ItemScreen, drafts: &'a Drafts) -> impl Patch {
    let f = HoldInput::FIELDS;
    let id = screen.item.item.item_id.as_str();
    let (input, errors) = drafts.hold();
    let e = errors.within(HoldFormId);
    html! {
        <WriteForm
            t={m}
            id={HoldFormId}
            action={url::StockHold { id }}
            viewer={viewer}
            family={Family::HoldCreate}
            target={id}
            attempt={f.inventory_mutation_attempt_id}
            errors={errors}
            enabled={screen.status.writes()}
        >
            <div class={Form}>
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{t.item_hold_quantity()}</span>
                        <input
                            type="number"
                            name={f.quantity}
                            value={&input.quantity}
                            min="1"
                            step="1"
                            inputmode="numeric"
                            required
                            {..e.aria(f.quantity)}
                        >
                    </label>
                    {e.message(f.quantity)}
                </div>
                <div class={Field}>
                    <label class={Field}>
                        <span class={Label}>{t.item_reason_2()}</span>
                        <input type="text" name={f.reason} value={&input.reason} required {..e.aria(f.reason)}>
                    </label>
                    {e.message(f.reason)}
                </div>
                <label class={Field}>
                    <span class={Label}>{t.item_notes()}</span>
                    <textarea name={f.notes} rows="3">{&input.notes}</textarea>
                </label>
                <p class={Row}><button class={Button} type="submit">{t.item_create_hold_2()}</button></p>
            </div>
        </WriteForm>
    }
}

/// A hold: its reason and quantity, purpose, time left, order, status and notes, and Release
/// for an active manual hold.
#[component(css = InventoryItemPage)]
fn HoldCard<'a>(
    t: InventoryMsg,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a ItemScreen,
    hold: &'a Hold,
    drafts: &'a Drafts,
) -> impl Render {
    let active = hold.status == "active";
    let order = source_order(hold.source_ref.as_ref());
    let left = if active { hold.expires_at.as_deref().and_then(|at| countdown(t, at)) } else { None };
    html! {
        <li class={(Card, HoldCard)}>
            <p class={Strong}>{format!("{} ({})", hold.reason, hold.quantity)}</p>
            <p class={Row}>
                <span class={Badge} data-tone={if hold.purpose == "manual" { "neutral" } else { "info" }}>
                    {purpose(t, &hold.purpose)}
                </span>
                if let Some(left) = &left {
                    <span class={Badge} data-tone="warning">{left}</span>
                }
                if let Some(order) = order {
                    <a class={(Button, Secondary, Small)} href={url::Sale { id: order, after: Default::default() }}>
                        {t.item_view_order(order)}
                    </a>
                }
            </p>
            <p class={Muted}>{if active { t.item_active_hold() } else { t.item_released_hold() }}</p>
            if let Some(notes) = hold.notes.as_deref().filter(|n| !n.trim().is_empty()) {
                <p>{notes}</p>
            }
            <p class={Hint}>{format!("{}{}", t.item_created(), when(t, &hold.created_at))}</p>
            if active && hold.purpose == "manual" && screen.can_manage {
                <ReleaseForm t={t} m={m} viewer={viewer} screen={screen} hold={&hold.hold_id} drafts={drafts} />
            }
        </li>
    }
}

/// Release hold, for an active manual hold.
#[component(css = InventoryItemPage)]
pub fn ReleaseForm<'a>(
    t: InventoryMsg,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a ItemScreen,
    hold: &'a str,
    drafts: &'a Drafts,
) -> impl Patch {
    let f = ReleaseInput::FIELDS;
    let id = screen.item.item.item_id.as_str();
    let errors = drafts.release(hold);
    html! {
        <WriteForm
            t={m}
            id={ReleaseFormId(hold)}
            action={url::StockRelease { id, hold }}
            viewer={viewer}
            family={Family::HoldRelease}
            target={hold}
            attempt={f.inventory_mutation_attempt_id}
            errors={errors}
            enabled={screen.status.writes()}
        >
            <p class={Row}><button class={(Button, Secondary)} type="submit">{t.item_release_hold()}</button></p>
        </WriteForm>
    }
}

/// The stock ledger: its kinds as links (All movements first), and the movements.
#[component(css = InventoryItemPage)]
fn Ledger<'a>(t: InventoryMsg, p: Pilot, screen: &'a ItemScreen) -> impl Render {
    let id = screen.item.item.item_id.as_str();
    let selected = screen.place.kind();
    let link = |kind: Option<&str>| url::StockItem { id, place: screen.place.filtered(kind), check: Check::default() };
    let entries: Vec<&LedgerEntry> = screen.ledger().collect();
    html! {
        <section class={Section} aria-labelledby="item-ledger-title">
            <h2 id="item-ledger-title" class={PartTitle}>{t.item_stock_ledger()}</h2>
            <nav class={Row} aria-label={t.item_stock_ledger()}>
                <a
                    class={(Button, Secondary, Small)}
                    href={link(None)}
                    aria-current={selected.is_none().then_some("page")}
                >
                    {t.item_all_movements()}
                </a>
                for k in screen.kinds() {
                    <a
                        class={(Button, Secondary, Small)}
                        href={link(Some(k))}
                        aria-current={(selected == Some(k)).then_some("page")}
                    >
                        {kind(t, p, k)}
                    </a>
                }
            </nav>
            if entries.is_empty() {
                <p class={Card}>{t.item_no_stock_movements()}</p>
            } else {
                <ol class={Timeline}>
                    for entry in entries {
                        <li
                            class={Step}
                            data-status={if entry.kind == "hold-expired" || entry.reason == "written-off" { "issue" } else { "complete" }}
                        >
                            <p class={Strong}>{kind(t, p, &entry.kind)}</p>
                            <p class={Hint}>{facts(t, entry)}</p>
                            if let Some(order) = source_order(entry.source_ref.as_ref()) {
                                <a class={(Button, Secondary, Small)} href={url::Sale { id: order, after: Default::default() }}>
                                    {t.item_view_order(order)}
                                </a>
                            }
                        </li>
                    }
                </ol>
            }
        </section>
    }
}

/// A refused write's patch: the status that settles its attempt, and the form again.
pub fn refused_stock<'a>(
    t: InventoryMsg,
    p: Pilot,
    m: Msg,
    viewer: &'a Viewer,
    screen: &'a ItemScreen,
    drafts: &'a Drafts,
) -> impl Patch + 'a {
    let id = screen.item.item.item_id.as_str();
    let here = url::StockItem { id, place: Default::default(), check: Default::default() }.href();
    let check = Check::default();
    html! {
        <super::Recovery t={m} viewer={viewer} status={&screen.status} check={&check} again={&here} list={&here} />
        if let Some(draft) = &drafts.sale {
            <SaleForm t={t} p={p} action={url::StockSale { id }} draft={draft} can_honor={screen.can_honor} autofocus={false} />
        }
        if drafts.adjust.is_some() {
            <AdjustForm t={t} m={m} viewer={viewer} screen={screen} drafts={drafts} />
        }
        if drafts.hold.is_some() {
            <HoldForm t={t} m={m} viewer={viewer} screen={screen} drafts={drafts} />
        }
        if let Some((hold, _)) = &drafts.release {
            <ReleaseForm t={t} m={m} viewer={viewer} screen={screen} hold={hold.as_str()} drafts={drafts} />
        }
    }
}
