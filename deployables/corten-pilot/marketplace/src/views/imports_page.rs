//! Inventory import, after Inventory's `import-batch-page.tsx`: the header with Inventory, Listings
//! and Pricing; what the last import said (its refusal, a batch still updating, a running job);
//! Resume an import, and Import expired for an expired batch; a batch's summary; Upload CSV (the
//! source, the quantity mode, the default location, a file or pasted rows); then a batch's review
//! (the rows that need the seller, Commit accepted rows, the rows and their pages) or the recent
//! imports.
//!
//! One column on a phone, where each row and each batch is a card with its facts labelled; from
//! 64rem a table. The summary's figures are two across on a phone, three from 40rem and six from
//! 64rem. Every control is at least 2.75rem tall.
use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::{inventory_page::Picker, listing_new_page::handlers as picker};
use crate::{
    api::{ImportBatch, ImportRow, segment},
    app::url,
    imports::{
        CommitFields, FixFields, Fixing, ImportFields, ImportsScreen, MODES, SOURCES, batch_href, commit_ready, resolve_href,
        unresolved,
    },
    text::{ImportsMsg, InventoryMsg, Pilot},
};

/// A source's name (`localizedImportSourceLabel`).
fn source(t: ImportsMsg, key: &str) -> &'static str {
    match key {
        "saved-list" => t.page_saved_list(),
        "tcgplayer-csv" => t.page_tcgplayer_csv(),
        "ebay-csv" => t.page_ebay_csv(),
        "shopify-csv" => t.page_shopify_csv(),
        "whatnot-csv" => t.page_whatnot_csv(),
        "cardtrader-csv" => t.page_cardtrader_csv(),
        _ => t.page_chase_sets_csv(),
    }
}

fn mode(t: ImportsMsg, key: &str) -> &'static str {
    if key == "replace" { t.page_replace_stock() } else { t.page_add_stock() }
}

/// A row's status tone (`statusTone`).
fn tone(status: &str) -> &'static str {
    match status {
        "accepted" | "committed" => "success",
        "rejected" => "danger",
        _ => "neutral",
    }
}

/// A listing price (`money`): the amount in its currency, Incomplete without a currency.
fn money(t: ImportsMsg, amount: Option<&str>, currency: Option<&str>) -> String {
    match (amount.filter(|a| !a.is_empty()), currency.filter(|c| !c.is_empty())) {
        (Some(_), None) => t.page_listing_price_incomplete().to_owned(),
        (Some(amount), Some(code)) => match (platform::money::decimal(amount), Currency::parse(code.trim())) {
            (Some(decimal), Some(currency)) => t.money(decimal, currency).to_string(),
            _ => format!("{amount} {code}"),
        },
        _ => t.page_not_set().to_owned(),
    }
}

/// The page.
#[component(css)]
pub fn ImportsPage<'a>(t: ImportsMsg, p: Pilot, m: InventoryMsg, screen: &'a ImportsScreen) -> impl Render {
    let detail = screen.detail.as_ref();
    let expired = detail.is_some_and(|d| d.batch.status == "expired");
    html! {
        <div class={Page}>
            <header class={Header}>
                <div class={Heading}>
                    <p class={Eyebrow}>{t.page_seller()}</p>
                    <h1 class={Title}>{t.page_inventory_import()}</h1>
                    <p class={Muted}>{t.page_upload_review_and_commit_csv()}</p>
                </div>
                <nav class={Actions} aria-label={t.page_inventory_import()}>
                    <a class={(Button, Secondary)} href={url::Inventory::default()}>{t.page_inventory()}</a>
                    <a class={(Button, Secondary)} href={url::SellerListings::default()}>{t.page_listings()}</a>
                    <a class={(Button, Ghost)} href={url::Recommendations::default()}>{t.page_pricing()}</a>
                </nav>
            </header>
            <div class={Notices} role="status" aria-live="polite">
                if let Some(error) = &screen.upload.error {
                    <div class={Notice} data-tone="danger" role="alert">
                        <p class={Strong}>{t.page_import_failed()}</p>
                        <p class={Muted}>{error}</p>
                    </div>
                }
                if screen.pending {
                    <div class={Notice} data-tone="info">
                        <p class={Strong}>{t.page_import_still_updating()}</p>
                        <p class={Muted}>{t.route_import_batch_still_updating()}</p>
                    </div>
                }
                if let Some(job) = &screen.job {
                    <div class={Notice} data-tone={if job.failed { "danger" } else { "info" }}>
                        <p class={Strong}>{t.page_import_job_running()}</p>
                        <p class={Muted}>{job.message.as_deref().unwrap_or(t.page_import_job_waiting())}</p>
                    </div>
                }
            </div>
            <div class={Notice} data-tone="info">
                <p class={Strong}>{t.import_resume_title()}</p>
                <p class={Muted}>{t.import_resume_description()}</p>
            </div>
            if expired {
                <div class={Notice} data-tone="warning">
                    <p class={Strong}>{t.import_expired_title()}</p>
                    <p class={Muted}>{t.import_expired_description()}</p>
                </div>
            }
            if let Some(detail) = detail {
                <Summary t={t} batch={&detail.batch} />
            }
            <UploadForm t={t} p={p} screen={screen} />
            match detail {
                Some(detail) => {
                    <Review t={t} p={p} screen={screen} detail={detail} />
                    if let Some(fixing) = &screen.fixing {
                        <FixDialog t={t} p={p} m={m} screen={screen} batch={&detail.batch.batch_id} fixing={fixing} />
                    }
                }
                None => {
                    <Recent t={t} batches={&screen.batches} />
                }
            }
        </div>
    }
}

/// The batch's figures (`MarketplaceDashboardPanel`).
#[component(css = ImportsPage)]
fn Summary<'a>(t: ImportsMsg, batch: &'a ImportBatch) -> impl Render {
    let location = batch.default_storage_location_id.as_deref().unwrap_or(t.page_no_default_location());
    let figures: [(&str, String, String); 6] = [
        (t.page_total_rows(), batch.total_count.to_string(), t.page_csv_rows().to_owned()),
        (t.page_accepted(), batch.accepted_count.to_string(), t.page_ready_to_commit().to_owned()),
        (t.page_rejected(), batch.rejected_count.to_string(), t.page_needs_row_fixes().to_owned()),
        (t.page_committed(), batch.committed_count.to_string(), t.page_items_created().to_owned()),
        (t.page_source(), source(t, &batch.source_key).to_owned(), t.page_adapter_version(batch.adapter_version).to_string()),
        (t.page_mode(), mode(t, &batch.quantity_mode).to_owned(), location.to_owned()),
    ];
    html! {
        <section class={Section} aria-labelledby="import-summary-title">
            <h2 id="import-summary-title" class={PartTitle}>{t.page_batch_summary()}</h2>
            <p class={Muted}>{t.page_review_row_outcomes_before_creating()}</p>
            <dl class={Figures}>
                for (label, value, detail) in &figures {
                    <div class={Figure}>
                        <dt class={Label}>{*label}</dt>
                        <dd class={Value}>{value}</dd>
                        <dd class={Muted}>{detail}</dd>
                    </div>
                }
            </dl>
        </section>
    }
}

/// Upload CSV: a file, or rows pasted, validated as a new batch.
#[component(css = ImportsPage)]
fn UploadForm<'a>(t: ImportsMsg, p: Pilot, screen: &'a ImportsScreen) -> impl Render {
    let f = ImportFields::FIELDS;
    let u = &screen.upload;
    html! {
        <section class={Section} aria-labelledby="import-upload-title">
            <h2 id="import-upload-title" class={PartTitle}>{t.page_upload_csv()}</h2>
            <form class={Card} method="post" action={url::Imports::default()} enctype="multipart/form-data">
                {SubmitKey::field(f.attempt)}
                <div class={Pair}>
                    <label class={Field}>
                        <span class={Label}>{t.page_import_source()}</span>
                        <select name={f.source_key}>
                            for key in SOURCES {
                                <option value={key} selected={u.source_key == key}>{source(t, key)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span class={Label}>{t.page_quantity_mode()}</span>
                        <select name={f.quantity_mode}>
                            for key in MODES {
                                <option value={key} selected={u.quantity_mode == key}>{mode(t, key)}</option>
                            }
                        </select>
                    </label>
                </div>
                <label class={Field}>
                    <span class={Label}>{t.page_default_storage_location()}</span>
                    <select name={f.default_storage_location_id}>
                        <option value="" selected={u.default_storage_location_id.is_empty()}>{t.page_choose_location()}</option>
                        for location in &screen.locations {
                            <option
                                value={&location.storage_location_id}
                                selected={location.storage_location_id == u.default_storage_location_id}
                            >
                                {&location.name}
                            </option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.page_csv_file()}</span>
                    <input type="file" name={f.file} accept=".csv,text/csv">
                </label>
                <label class={Field}>
                    <span class={Label}>{t.page_csv_rows_input()}</span>
                    <textarea
                        name={f.csv_text}
                        rows="8"
                        placeholder={t.page_csv_placeholder()}
                        aria-describedby="import-csv-hint"
                        spellcheck="false"
                    >
                        {&u.csv_text}
                    </textarea>
                </label>
                <p id="import-csv-hint" class={Hint}>{t.page_csv_description()}</p>
                <div class={Actions}>
                    <button type="submit" class={Button}>{t.page_validate_import()}</button>
                    if let Some(latest) = screen.latest() {
                        <a class={(Button, Ghost)} href={batch_href(latest, 0)}>{t.page_latest_batch()}</a>
                    }
                    <a class={(Button, Ghost)} href={url::ImportTemplate} download>{t.page_download_native_template()}</a>
                    <a class={(Button, Ghost)} href={url::ImportExport} download>{t.page_export_current_inventory()}</a>
                </div>
                <p class={Hint}>{p.imports_file_or_rows()}</p>
            </form>
        </section>
    }
}

/// A batch's review: the rows that need the seller, Commit, the rows and their pages.
#[component(css = ImportsPage)]
fn Review<'a>(t: ImportsMsg, p: Pilot, screen: &'a ImportsScreen, detail: &'a crate::api::ImportBatchDetail) -> impl Render {
    let batch = &detail.batch;
    let open = unresolved(detail);
    let ready = commit_ready(detail);
    let shown = detail.rows.len() as u64;
    let previous = (screen.offset > 0).then(|| batch_href(&batch.batch_id, screen.offset.saturating_sub(100)));
    let next = (screen.offset + shown < batch.total_count).then(|| batch_href(&batch.batch_id, screen.offset + 100));
    html! {
        <section class={Section} aria-labelledby="import-review-title">
            <h2 id="import-review-title" class={PartTitle}>{t.page_review_batch()}</h2>
            if let Some(first) = open.first() {
                <div class={Notice} data-tone="warning">
                    <p class={Strong}>{t.page_rows_need_you(open.len())}</p>
                    <p class={Muted}>{t.page_resolve_rows_in_place()}</p>
                    <p>
                        <a class={Button} href={resolve_href(&batch.batch_id, screen.offset, Some(&first.row_id))}>
                            {t.page_resolve_rows()}
                        </a>
                    </p>
                </div>
            }
            if let Some(count) = ready {
                <form class={(Card, Commit)} method="post" action={url::ImportCommit { batch: &batch.batch_id }}>
                    {SubmitKey::field(CommitFields::FIELDS.attempt)}
                    <p class={Strong}>{t.page_accepted_rows_ready(count)}</p>
                    <button type="submit" class={Button}>{t.page_commit_accepted_rows()}</button>
                </form>
            }
            if detail.rows.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.page_no_rows()}</p>
                    <p class={Muted}>{t.page_upload_csv_to_review_rows()}</p>
                </div>
            } else {
                <table class={Table}>
                    <thead>
                        <tr>
                            <th scope="col">{t.page_row()}</th>
                            <th scope="col">{t.page_status()}</th>
                            <th scope="col">{t.page_source()}</th>
                            <th scope="col">{t.page_catalog_item()}</th>
                            <th scope="col" class={End}>{t.page_quantity()}</th>
                            <th scope="col">{t.page_listing_draft()}</th>
                            <th scope="col">{t.page_errors_and_outcomes()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for row in &detail.rows {
                            <Row
                                t={t}
                                row={row}
                                batch={&batch.batch_id}
                                offset={screen.offset}
                                resolve={row.needs_seller}
                            />
                        }
                    </tbody>
                </table>
            }
            if previous.is_some() || next.is_some() {
                <nav class={Actions} aria-label={p.imports_rows()}>
                    if let Some(href) = &previous {
                        <a class={(Button, Secondary)} href={href}>{t.import_rows_previous()}</a>
                    }
                    if let Some(href) = &next {
                        <a class={(Button, Secondary)} href={href}>{t.import_rows_next()}</a>
                    }
                </nav>
            }
        </section>
    }
}

/// A row: a table row from 64rem, a card on a phone, each cell labelled there.
#[component(css = ImportsPage)]
fn Row<'a>(t: ImportsMsg, row: &'a ImportRow, batch: &'a str, offset: u64, resolve: bool) -> impl Render {
    let reference = row.external_reference.as_ref();
    let name = reference.and_then(|r| r.display_name.as_deref().or(Some(r.external_key.as_str()))).unwrap_or(t.page_native_row());
    let detail = match reference {
        Some(r) => t.page_external_reference(&r.provider_key, &r.external_key).to_string(),
        None => row.row_fingerprint.clone(),
    };
    let quantity = row
        .set_quantity
        .or(row.quantity_delta)
        .or(row.total_quantity)
        .map_or_else(|| t.page_not_set().to_owned(), |q| q.to_string());
    let cap = match row.listing_quantity_cap {
        Some(cap) => t.page_cap_quantity(cap).to_string(),
        None => t.page_no_draft().to_owned(),
    };
    let listing = row.committed_inventory_item_id.as_deref().filter(|_| row.committed_listing_id.is_none());
    html! {
        <tr class={Line}>
            <td data-label={t.page_row()}>{row.row_number}</td>
            <td data-label={t.page_status()}>
                <span class={Badge} data-tone={tone(&row.status)}>{&row.status}</span>
                <span class={Small}>{&row.resolution_status}</span>
            </td>
            <td data-label={t.page_source()}>
                <span class={Strong}>{name}</span>
                <span class={Small}>{detail}</span>
            </td>
            <td data-label={t.page_catalog_item()}>
                <span class={Strong}>{row.catalog_item_id.as_deref().unwrap_or(t.page_not_set())}</span>
                <span class={Small}>{row.product_id.as_deref().unwrap_or(t.page_product_unresolved())}</span>
            </td>
            <td data-label={t.page_quantity()} class={End}>
                <span>{quantity}</span>
                <span class={Small}>{&row.quantity_mode}</span>
            </td>
            <td data-label={t.page_listing_draft()}>
                <span>{money(t, row.listing_price_amount.as_deref(), row.listing_price_currency_code.as_deref())}</span>
                <span class={Small}>{cap}</span>
            </td>
            <td data-label={t.page_errors_and_outcomes()}>
                if resolve {
                    <a class={(Button, Small)} href={resolve_href(batch, offset, Some(&row.row_id))}>{t.page_resolve_row()}</a>
                }
                if !row.validation_errors.is_empty() {
                    for message in &row.validation_errors {
                        <span class={Small}>{message}</span>
                    }
                } else if row.committed_inventory_item_id.is_none() && row.committed_listing_id.is_none() {
                    <span class={Small}>{t.page_no_outcome_yet()}</span>
                } else {
                    if let Some(item) = &row.committed_inventory_item_id {
                        <span class={Small}>{t.page_inventory_item_created(item)}</span>
                    }
                    if let Some(item) = listing {
                        <a
                            class={(Button, Ghost, Small)}
                            href={format!("{}?inventoryItemId={}", url::NewListing.href(), segment(item))}
                        >
                            {t.list_create_listing()}
                        </a>
                    }
                    if let Some(listing) = &row.committed_listing_id {
                        <span class={Small}>{t.page_draft_listing_created(listing)}</span>
                    }
                }
            </td>
        </tr>
    }
}

/// The recent imports, each with Open.
#[component(css = ImportsPage)]
fn Recent<'a>(t: ImportsMsg, batches: &'a [ImportBatch]) -> impl Render {
    html! {
        <section class={Section} aria-labelledby="import-recent-title">
            <h2 id="import-recent-title" class={PartTitle}>{t.page_recent_imports()}</h2>
            if batches.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.page_no_imports_yet()}</p>
                    <p class={Muted}>{t.page_upload_csv_to_start()}</p>
                </div>
            } else {
                <table class={Table}>
                    <thead>
                        <tr>
                            <th scope="col">{t.page_batch()}</th>
                            <th scope="col">{t.page_status()}</th>
                            <th scope="col" class={End}>{t.page_accepted()}</th>
                            <th scope="col" class={End}>{t.page_rejected()}</th>
                            <th scope="col">{t.page_actions()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for batch in batches {
                            <tr class={Line}>
                                <td data-label={t.page_batch()}>
                                    <span class={Strong}>{&batch.batch_id}</span>
                                    <span class={Small}>{when(t, &batch.updated_at)}</span>
                                </td>
                                <td data-label={t.page_status()}>
                                    <span
                                        class={Badge}
                                        data-tone={if batch.status == "committed" { "success" } else { "neutral" }}
                                    >
                                        {&batch.status}
                                    </span>
                                </td>
                                <td data-label={t.page_accepted()} class={End}>{batch.accepted_count}</td>
                                <td data-label={t.page_rejected()} class={End}>{batch.rejected_count}</td>
                                <td data-label={t.page_actions()}>
                                    <a class={(Button, Secondary, Small)} href={batch_href(&batch.batch_id, 0)}>
                                        {t.page_open()}
                                    </a>
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            }
        </section>
    }
}

fn when(t: ImportsMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// The row resolution drawer (`SideSheet` with `ImportRowResolutionForm`), drawn open on the batch
/// page and modal once it joins the page; Close and Escape go back to the batch. One form whose
/// action is the batch page with the drawer open on the row: the picker's steps (its buttons are
/// `formmethod="get"`) read it again, as a page without a script and in place with one, and Apply
/// alone posts, to the resolve route (its `formaction`).
#[component(css = ImportsPage)]
fn FixDialog<'a>(
    t: ImportsMsg,
    p: Pilot,
    /// The picker's words: the inventory page's.
    m: InventoryMsg,
    screen: &'a ImportsScreen,
    batch: &'a str,
    fixing: &'a Fixing,
) -> impl Render {
    let f = FixFields::FIELDS;
    let row = &fixing.row;
    let close = resolve_href(batch, screen.offset, None);
    let here = resolve_href(batch, screen.offset, Some(&row.row_id));
    let back = refs();
    let ready = fixing.ready().is_some();
    html! {
        <dialog
            id={FixDialogId}
            class={Dialog}
            aria-labelledby="import-fix-title"
            aria-describedby="import-fix-progress"
            open
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <div class={DialogHead}>
                <h2 id="import-fix-title" class={PartTitle}>{t.page_resolve_import_row(row.row_number)}</h2>
                <a ref={back} class={(Button, Ghost, Small)} href={&close}>{t.page_close()}</a>
            </div>
            <p id="import-fix-progress" class={Muted}>{t.page_resolve_progress(fixing.position, fixing.total)}</p>
            if !row.validation_errors.is_empty() {
                <ul class={Errors}>
                    for message in &row.validation_errors {
                        <li class={Small}>{message}</li>
                    }
                </ul>
            }
            if let Some(error) = &fixing.error {
                <p class={ErrorText} role="alert">{error}</p>
            }
            <form
                id={FixFormId}
                class={Fix}
                method="post"
                action={&here}
                data-patch
                on:change={picker::redraw(event)}
                on:input={picker::find(event)}
            >
                <input type="hidden" name={f.offset} value={screen.offset.to_string()}>
                <input type="hidden" name="resolveRowId" value={&row.row_id}>
                <Picker t={m} p={p} draft={&fixing.draft} catalog={&fixing.catalog} />
                <label class={Field}>
                    <span class={Label}>{m.list_storage_location()}</span>
                    <select name={f.storage_location_id} required>
                        <option value="" selected={fixing.storage_location_id.is_empty()}>{t.page_choose_location()}</option>
                        for location in &screen.locations {
                            <option
                                value={&location.storage_location_id}
                                selected={location.storage_location_id == fixing.storage_location_id}
                            >
                                {&location.name}
                            </option>
                        }
                    </select>
                </label>
                <p class={Actions}>
                    <button
                        type="submit"
                        class={Button}
                        formaction={url::ImportResolve { batch, row: &row.row_id }}
                        disabled={!ready}
                    >
                        {t.page_apply_row_fix()}
                    </button>
                    <a class={(Button, Secondary)} href={&close}>{t.page_close()}</a>
                </p>
            </form>
        </dialog>
    }
}

#[derive(Id)]
pub struct FixDialogId;

#[derive(Id)]
pub struct FixFormId;
