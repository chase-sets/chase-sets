//! The catalog items list (admin-web's `CatalogItemListPage`): the items, their filters (the
//! extra ones folded under More filters), the create dialog, and the bulk bar, whose operations
//! are the API's three bulk changes (publish, archive, the edits). A change to the items is not
//! drawn into the rows: as in admin-web (manual mode) the page says how many items changed, and
//! Reload draws the rows again.
use corten::{
    prelude::*,
    view::{AttrValue, Id},
};

use super::{
    Bar, BulkRows, Candidates, CatalogDialog, Empty, Filters, Followed, Input, JobDialog, ListPage, ListScreen, MoreFilters,
    Pager, Pick, Search, SelectRow, StatusPill, Table, TextFilter, Toasts, Trigger, ids, pages_around, value,
};
use crate::{
    catalog::{
        api::{EditCandidate, EditOutcome, EditPreview, ItemRow, Job, Preview, PublishCandidate, PublishOutcome, PublishPreview},
        form::{ItemBulkInput, ItemInput},
        url,
    },
    text::{Cat, Pilot},
    views::{Draft, LiveStatus, LiveWords},
};

/// How many records a preview or a result lists (admin-web's dialogs show the first 20).
const SHOWN: usize = 20;

/// What a bulk preview of the items answered, by the API's route it came from.
#[derive(Clone, Debug, serde::Serialize, ToJson)]
#[serde(untagged)]
pub enum ItemPreview {
    Publish(PublishPreview),
    Lifecycle(Preview),
    Edit(EditPreview),
}

/// A dialog the items page answers with, drawn open: a bulk preview (or its refusal), or the
/// removal of the checked drafts.
#[derive(Clone, Copy)]
pub enum ItemDialog<'a> {
    Preview { input: &'a ItemBulkInput, preview: Option<&'a ItemPreview>, errors: &'a Errors, confirm: &'a str, label: &'a str },
    Drafts { ids: &'a [String], errors: &'a Errors, confirm: &'a str },
}

/// How many items changed since the page was drawn, and whether the stream asked for a full
/// read (`sync.required`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pending {
    pub count: u32,
    pub sync: bool,
}

/// The operations of the bulk bar, with their labels (`catalogItemBulkOperationOptions`).
pub fn item_operations(t: Cat) -> [(&'static str, &'static str); 8] {
    [
        ("publish", t.item_list_operation_publish()),
        ("archive", t.item_list_operation_archive()),
        ("assignBlueprint", t.item_list_bulk_edit_assign_blueprint()),
        ("assignCategory", t.item_list_bulk_edit_assign_category()),
        ("removeCategory", t.item_list_bulk_edit_remove_category()),
        ("setTags", t.item_list_bulk_edit_set_tags()),
        ("mergeTags", t.item_list_bulk_edit_merge_tags()),
        ("clearTags", t.item_list_bulk_edit_clear_tags()),
    ]
}

/// `formatLanguageCodeLabel`: the language's name, or its code.
pub(super) fn language(t: Cat, code: &str) -> &str {
    match code.trim().to_lowercase().as_str() {
        "en" => t.item_list_english(),
        "ja" => t.item_list_japanese(),
        _ => code,
    }
}

/// What the items page draws besides its rows: a create form that came back (drawn open), the
/// toast, whether the viewer may change the items, a dialog that answers (drawn open), and the
/// job the page follows.
pub struct ItemParts<'a> {
    pub create: Option<Draft<ItemInput>>,
    pub notice: Option<String>,
    pub manage: bool,
    pub dialog: Option<ItemDialog<'a>>,
    pub job: Option<Followed<'a>>,
}

/// The items list, its filters, the changes since it was drawn, and its dialogs.
pub fn item_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::ItemQuery,
    screen: &'a ListScreen<ItemRow, ItemPreview>,
    parts: ItemParts<'a>,
) -> impl Render + 'a {
    let ItemParts { create, notice, manage, dialog, job } = parts;
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(ItemInput::blank()));
    let title = t.item_list_catalog_items();
    let create_action = url::Items::of(query).href();
    let filters = url::Items::default().href();
    let statuses = [
        ("draft", t.item_list_draft()),
        ("active", t.item_list_active()),
        ("retired", t.item_list_retired()),
        ("archived", t.item_list_archived()),
    ];
    let languages = [("en", t.item_list_english()), ("ja", t.item_list_japanese())];
    let flags = [("true", t.list_yes()), ("false", t.list_no())];
    let blueprint_states = [("assigned", t.item_list_blueprint_assigned()), ("missing", t.item_list_blueprint_missing())];
    let more = query.language.is_some()
        || query.source.is_some()
        || query.blueprint_id.is_some()
        || query.tag.is_some()
        || query.blueprint_state.is_some()
        || query.has_images.is_some()
        || query.has_source_references.is_some()
        || query.missing_required_fields.is_some();
    let total = t.item_list_matching_items(screen.total).to_string();
    let f = url::ItemQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <span>{&total}</span>
            if manage {
                <Trigger dialog={ids::CREATE_DIALOG} label={t.item_list_new_catalog_item()} secondary={false} />
            }
        </ListPage>
        <Filters t={t} action={&filters}>
            <Search t={t} name={f.search} title={title} value={value(&query.search)} />
            <Pick
                label={t.list_status()}
                name={f.status}
                all={t.list_all_statuses()}
                options={&statuses}
                value={value(&query.status)}
            />
            <MoreFilters t={t} open={more}>
                <Pick
                    label={t.item_list_language()}
                    name={f.language}
                    all={t.item_list_all_languages()}
                    options={&languages}
                    value={value(&query.language)}
                />
                <TextFilter
                    label={t.item_list_source()}
                    name={f.source}
                    value={value(&query.source)}
                    placeholder={t.item_list_source_placeholder()}
                />
                <TextFilter
                    label={t.item_list_blueprint_id()}
                    name={f.blueprint_id}
                    value={value(&query.blueprint_id)}
                    placeholder={t.item_list_blueprint_id_placeholder()}
                />
                <TextFilter
                    label={t.item_list_tag()}
                    name={f.tag}
                    value={value(&query.tag)}
                    placeholder={t.item_list_tag_placeholder()}
                />
                <Pick
                    label={t.item_list_blueprint()}
                    name={f.blueprint_state}
                    all={t.list_all()}
                    options={&blueprint_states}
                    value={value(&query.blueprint_state)}
                />
                <Pick
                    label={t.item_list_has_images()}
                    name={f.has_images}
                    all={t.list_all()}
                    options={&flags}
                    value={value(&query.has_images)}
                />
                <Pick
                    label={t.item_list_has_source_references()}
                    name={f.has_source_references}
                    all={t.list_all()}
                    options={&flags}
                    value={value(&query.has_source_references)}
                />
                <Pick
                    label={t.item_list_missing_required_fields()}
                    name={f.missing_required_fields}
                    all={t.list_all()}
                    options={&flags}
                    value={value(&query.missing_required_fields)}
                />
            </MoreFilters>
        </Filters>
        {item_live(t, query)}
        {item_rows(t, p, query, screen, manage)}
        if manage {
            <CatalogDialog
                id={ids::CREATE_DIALOG}
                title={t.item_list_create_catalog_item()}
                description={None}
                open={open}
                close={p.catalog_close()}
            >
                <ItemForm t={t} id={ids::CREATE} action={&create_action} form={&create} />
            </CatalogDialog>
        }
        match dialog {
            Some(ItemDialog::Preview { input, preview, errors, confirm, label }) => {
                <ItemPreviewDialog t={t} p={p} input={input} preview={preview} errors={errors} confirm={confirm} label={label} />
            }
            Some(ItemDialog::Drafts { ids, errors, confirm }) => <DraftsDialog t={t} p={p} ids={ids} errors={errors} confirm={confirm} />,
            None => <dialog id={ids::PREVIEW_DIALOG}></dialog>,
        }
        if let Some(followed) = job {
            <JobDialog t={t} p={p} job={followed.job} label={followed.label} live={followed.live.as_deref()} />
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The changes since the page was drawn (`ids::CHANGES`), in the element that streams them
/// (`ids::LIVE`). Reload draws both again, so the count starts over with a new stream.
pub fn item_live<'a>(t: Cat, query: &'a url::ItemQuery) -> impl Patch + 'a {
    html! {
        let live = url::ItemsLive { query: query.clone() }.href();
        let list = url::Items::default().href();
        let kept = query.kept();
        let words = live_words(t);
        <LiveStatus words={&words} id={ids::LIVE} src={&live} reload={&list} kept={&kept}>
            {item_changes(t, query, Pending::default())}
        </LiveStatus>
    }
}

/// The catalog's words for a stream's status (`CatalogRealtimeConnectionStatus`).
fn live_words(t: Cat) -> LiveWords {
    use corten::i18n::{DateStyle, TimeStyle};
    LiveWords {
        live: t.live_status_live(),
        connecting: t.live_status_connecting(),
        stale_since: t.js().live_status_stale_since(),
        stale: t.live_status_stale_since("").to_string(),
        stale_description: t.live_status_stale_description(),
        reload: Some(t.realtime_reload()),
        date: t.js().date_time(DateStyle::Medium, TimeStyle::Short),
    }
}

/// admin-web's `CatalogRealtimeReloadActionBar`: how many items changed, and Reload, which draws
/// the rows again (a patch with the script; the page without). Empty while nothing changed.
pub fn item_changes<'a>(t: Cat, query: &'a url::ItemQuery, pending: Pending) -> impl Render + 'a {
    html! {
        <ItemChanges t={t} query={query} pending={pending} />
    }
}

#[component(css = ItemForm)]
fn ItemChanges<'a>(t: Cat, query: &'a url::ItemQuery, pending: Pending) -> impl Render {
    let entity = t.item_list_catalog_items();
    let text = if pending.count > 0 {
        t.realtime_changed(pending.count, entity).to_string()
    } else {
        t.realtime_sync_required(entity).to_string()
    };
    let list = url::Items::default().href();
    let kept = query.kept();
    html! {
        <div id={ids::CHANGES} class={Changes} role="status">
            if pending.count > 0 || pending.sync {
                <div class={Pending}>
                    <span>{&text}</span>
                    <form method="get" action={&list} data-patch>
                        for (name, value) in &kept {
                            <input type="hidden" name={*name} value={value.as_str()}>
                        }
                        <button type="submit" class={Small}>{t.realtime_reload()}</button>
                    </form>
                </div>
            }
        </div>
    }
}

/// The items' rows (or the empty state) and pager, by `ids::ROWS`, with the bulk bar for staff
/// who may change them: drawn in the page, and again by Reload.
pub fn item_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::ItemQuery,
    screen: &'a ListScreen<ItemRow, ItemPreview>,
    manage: bool,
) -> impl Patch + 'a {
    let title = t.item_list_catalog_items();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.item_list_catalog_item()).to_string()
    };
    let head = [
        t.item_list_title(),
        t.item_list_subtitle(),
        t.item_list_language(),
        t.item_list_blueprint(),
        t.item_list_source(),
        t.item_list_status(),
        "",
    ];
    let (previous, next) =
        pages_around(screen, |page| url::Items::of(&url::ItemQuery { page: (page > 1).then_some(page), ..query.clone() }).href());
    let preview = url::ItemsBulk { query: query.clone() }.href();
    let drafts = url::ItemsDrafts { query: query.clone() }.href();
    let operations = item_operations(t);
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <ItemTableRow t={t} row={row} select={select} />
                    }
                </Table>
                <Pager t={t} p={p} page={screen.page} pages={screen.pages} previous={previous.as_deref()} next={next.as_deref()} />
            }
        };
        if manage {
            let bar = Bar { entity: title, action: &preview, total: screen.total, actions: &operations };
            let fields = html! { <ItemBulkFields t={t} /> };
            let more = html! { <DraftsButton t={t} action={&drafts} /> };
            <BulkRows t={t} p={p} bar={bar} fields={fields} more={more}>{body}</BulkRows>
        } else {
            <div id={ids::ROWS}>{body}</div>
        }
    }
}

/// Remove drafts from selected: a submit of the bulk form to the drafts' dialog, enabled while
/// only drafts are checked.
#[component(css = ItemForm)]
fn DraftsButton<'a>(t: Cat, action: &'a str) -> impl Render {
    let f = ItemBulkInput::FIELDS;
    html! {
        <button type="submit" class={(Small, Danger)} name={f.mode} value="ids" formaction={action} data-requires="draft">
            {t.item_list_remove_drafts_from_selected()}
        </button>
    }
}

/// An item's row, which links its page.
#[component(css = ItemForm)]
fn ItemTableRow<'a>(t: Cat, row: &'a ItemRow, select: Option<Pilot>) -> impl Render {
    let dash = "\u{2014}";
    let page = url::item::Item::of(&row.catalog_item_id).href();
    let sources = row.source_providers.join(", ");
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.catalog_item_id} status={Some(row.status.as_str())} /></td>
            }
            <td>{&row.title}</td>
            <td>{row.subtitle.as_deref().unwrap_or(dash)}</td>
            <td>{language(t, &row.language_code)}</td>
            <td>{row.blueprint.as_ref().map_or(dash, |b| b.name.as_str())}</td>
            <td>{if sources.is_empty() { dash } else { sources.as_str() }}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td><a class={View} href={&page}>{t.list_view()}</a></td>
        </tr>
    }
}

/// What an edit takes: the blueprint, the category, or the tags. Each shows only for the
/// operations that take it (CSS `:has`, no script); a browser without `:has` shows them all.
#[component(css = ItemForm)]
fn ItemBulkFields(t: Cat) -> impl Render {
    let f = ItemBulkInput::FIELDS;
    html! {
        <label class={(Value, Blueprint)}>
            <span class={Label}>{t.item_list_blueprint_id_or_slug()}</span>
            <input type="text" name={f.blueprint_id} placeholder={t.item_list_blueprint_id_placeholder()}>
        </label>
        <label class={(Value, Category)}>
            <span class={Label}>{t.item_list_category_id()}</span>
            <input type="text" name={f.category_id}>
        </label>
        <label class={(Value, Tags)}>
            <span class={Label}>{t.item_list_tags()}</span>
            <input type="text" name={f.tags} placeholder={t.item_list_tags_placeholder()}>
        </label>
    }
}

/// The create form (`ids::CREATE`), what a refused create is patched with. Its stylesheet is
/// the page's.
#[component(css)]
pub fn ItemForm<'a, I: Id + AttrValue + Copy>(t: Cat, id: I, action: &'a str, form: &'a Draft<ItemInput>) -> impl Patch {
    let f = ItemInput::FIELDS;
    let e = form.errors.within(id);
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <input type="hidden" name={f.item_id} value={&form.input.item_id}>
            <Input label={t.item_list_language_code()} name={f.language_code} value={&form.input.language_code} errors={&e} />
            <Input label={t.item_list_description()} name={f.description} value={&form.input.description} errors={&e} />
            <div class={Footer}>
                <button type="submit" class={Small}>{t.item_list_create()}</button>
            </div>
        </form>
    }
}

/// A bulk preview of the items (`ids::PREVIEW_DIALOG`), by the API's route: a publish's, an
/// archive's (the shared lifecycle dialog), or an edit's. The confirm form carries the operation
/// again; a publish's carries the preview's items, which is what the API's confirm takes.
#[component(css = ItemForm)]
pub fn ItemPreviewDialog<'a>(
    t: Cat,
    p: Pilot,
    input: &'a ItemBulkInput,
    preview: Option<&'a ItemPreview>,
    errors: &'a Errors,
    confirm: &'a str,
    label: &'a str,
) -> impl Patch {
    let f = ItemBulkInput::FIELDS;
    let e = errors.within(ids::CONFIRM);
    let publish = input.action == "publish";
    let (title, description, note) = match preview {
        Some(ItemPreview::Publish(v)) => {
            let taken = if input.mode == "filter" { t.item_list_matching_drafts() } else { t.item_list_selected_items() };
            let description = t.item_list_bulk_preview_description(taken, v.ready_count, v.blocked_count).to_string();
            (t.item_list_bulk_publish_preview().to_owned(), Some(description), Some(t.item_list_bulk_partial_success_note()))
        }
        Some(ItemPreview::Edit(v)) => {
            let description = t.item_list_bulk_edit_preview_description(v.ready_count, v.blocked_count).to_string();
            (
                t.item_list_bulk_edit_preview_title(label).to_string(),
                Some(description),
                Some(t.item_list_bulk_edit_partial_success_note()),
            )
        }
        Some(ItemPreview::Lifecycle(v)) => (
            t.bulk_preview_title(label).to_string(),
            Some(t.bulk_preview_description(v.ready_count, v.blocked_count).to_string()),
            None,
        ),
        None if publish => (t.item_list_bulk_publish_preview().to_owned(), None, None),
        None if input.family() == Some(crate::catalog::form::Family::Edit) => {
            (t.item_list_bulk_edit_preview_title(label).to_string(), None, None)
        }
        None => (t.bulk_preview_title(label).to_string(), None, None),
    };
    let ready = match preview {
        Some(ItemPreview::Publish(v)) => v.ready_count > 0 || v.candidates.iter().any(|c| c.retryable),
        Some(ItemPreview::Edit(v)) => v.ready_count > 0,
        Some(ItemPreview::Lifecycle(v)) => v.ready_count > 0,
        None => false,
    };
    // What the confirm takes: a publish, the preview's items; a lifecycle change, the API's ids;
    // an edit, the checked rows (or the filter).
    let (mode, ids): (&str, &[String]) = match preview {
        Some(ItemPreview::Publish(v)) => ("ids", &v.item_ids),
        Some(ItemPreview::Lifecycle(v)) if input.mode != "filter" => ("ids", &v.ids),
        _ if input.mode != "filter" => ("ids", &input.ids),
        _ => ("filter", &[]),
    };
    let confirm_label = match preview {
        Some(ItemPreview::Publish(_)) => t.item_list_publish_ready_items(),
        Some(ItemPreview::Edit(_)) => t.item_list_bulk_edit_confirm(),
        _ if publish => t.item_list_publish_ready_items(),
        _ => t.bulk_confirm(),
    };
    // The view owns what its dialog borrows: the title and description move into the markup.
    html! {
        let (title, description) = (title, description);
        <CatalogDialog
            id={ids::PREVIEW_DIALOG}
            title={&title}
            description={description.as_deref()}
            open
            close={p.catalog_close()}
        >
            if let Some(note) = note {
                <p class={Note}>{note}</p>
            }
            if let Some(ItemPreview::Publish(v)) = preview {
                <PublishTable t={t} candidates={&v.candidates} />
            }
            if let Some(ItemPreview::Edit(v)) = preview {
                <EditTable t={t} candidates={&v.candidates} />
            }
            if let Some(ItemPreview::Lifecycle(v)) = preview {
                <Candidates t={t} candidates={&v.candidates} />
            }
            <form class={Confirm} id={ids::CONFIRM} method="post" action={confirm} data-patch>
                {errors.form_message()}
                {e.message(f.blueprint_id)}
                {e.message(f.category_id)}
                {e.message(f.tags)}
                <input type="hidden" name={f.action} value={&input.action}>
                <input type="hidden" name={f.mode} value={mode}>
                for id in ids {
                    <input type="hidden" name={f.ids} value={id}>
                }
                <input type="hidden" name={f.blueprint_id} value={&input.blueprint_id}>
                <input type="hidden" name={f.category_id} value={&input.category_id}>
                <input type="hidden" name={f.tags} value={&input.tags}>
                <div class={Footer}>
                    <button type="submit" class={Small} disabled={!ready}>{confirm_label}</button>
                    <button type="button" class={(Small, Secondary)} command="close" commandfor={ids::PREVIEW_DIALOG}>
                        {t.item_list_cancel()}
                    </button>
                </div>
            </form>
        </CatalogDialog>
    }
}

/// A publish's items: the first 20, and how many there are.
#[component(css = ItemForm)]
fn PublishTable<'a>(t: Cat, candidates: &'a [PublishCandidate]) -> impl Render {
    let head = [t.item_list_title(), t.item_list_source(), t.item_list_status(), t.item_list_result(), t.item_list_reason()];
    let shown = &candidates[..candidates.len().min(SHOWN)];
    let dash = "\u{2014}";
    html! {
        if candidates.is_empty() {
            <p class={Note}>{t.item_list_no_items_to_publish()}</p>
        } else {
            <Table label={t.item_list_bulk_publish_preview()} head={&head} all={None}>
                for c in shown {
                    let sources = c.source_providers.join(", ");
                    <tr>
                        <td>{&c.title}</td>
                        <td>{if sources.is_empty() { dash } else { sources.as_str() }}</td>
                        <td>{&c.status}</td>
                        <td><StatusPill status={&c.outcome} toned={false} /></td>
                        <td>{c.reason.as_deref().unwrap_or(dash)}</td>
                    </tr>
                }
            </Table>
            if candidates.len() > shown.len() {
                <p class={Note}>{t.item_list_bulk_preview_truncated(shown.len(), candidates.len())}</p>
            }
        }
    }
}

/// An edit's items: the first 20, and how many there are.
#[component(css = ItemForm)]
fn EditTable<'a>(t: Cat, candidates: &'a [EditCandidate]) -> impl Render {
    let head = [
        t.item_list_title(),
        t.item_list_status(),
        t.item_list_blueprint_id(),
        t.item_list_category_ids(),
        t.item_list_tags(),
        t.item_list_result(),
        t.item_list_reason(),
    ];
    let shown = &candidates[..candidates.len().min(SHOWN)];
    let dash = "\u{2014}";
    html! {
        if candidates.is_empty() {
            <p class={Note}>{t.item_list_bulk_edit_no_items()}</p>
        } else {
            <Table label={t.item_list_bulk_edit_action()} head={&head} all={None}>
                for c in shown {
                    let (categories, tags) = (c.category_ids.join(", "), c.tags.join(", "));
                    <tr>
                        <td>{&c.title}</td>
                        <td>{&c.status}</td>
                        <td>{c.blueprint_id.as_deref().unwrap_or(dash)}</td>
                        <td>{if categories.is_empty() { dash } else { categories.as_str() }}</td>
                        <td>{if tags.is_empty() { dash } else { tags.as_str() }}</td>
                        <td><StatusPill status={&c.outcome} toned={false} /></td>
                        <td>{c.reason.as_deref().unwrap_or(dash)}</td>
                    </tr>
                }
            </Table>
            if candidates.len() > shown.len() {
                <p class={Note}>{t.item_list_bulk_preview_truncated(shown.len(), candidates.len())}</p>
            }
        }
    }
}

/// The removal of the checked drafts (admin-web's Remove Draft Catalog Items): how many, and the
/// confirm, which removes each.
#[component(css = ItemForm)]
pub fn DraftsDialog<'a>(t: Cat, p: Pilot, ids: &'a [String], errors: &'a Errors, confirm: &'a str) -> impl Patch {
    let f = ItemBulkInput::FIELDS;
    let ready = !ids.is_empty() && errors.is_empty();
    html! {
        let description = t.item_list_remove_draft_catalog_items_description(ids.len()).to_string();
        <CatalogDialog
            id={ids::PREVIEW_DIALOG}
            title={t.item_list_remove_draft_catalog_items()}
            description={ready.then_some(description.as_str())}
            open
            close={p.catalog_close()}
        >
            <form class={Confirm} id={ids::CONFIRM} method="post" action={confirm} data-patch>
                {errors.form_message()}
                for id in ids {
                    <input type="hidden" name={f.ids} value={id}>
                }
                <div class={Footer}>
                    <button type="submit" class={(Small, Danger)} disabled={!ready}>
                        {t.item_list_remove_drafts_from_selected()}
                    </button>
                    <button type="button" class={(Small, Secondary)} command="close" commandfor={ids::PREVIEW_DIALOG}>
                        {t.item_list_cancel()}
                    </button>
                </div>
            </form>
        </CatalogDialog>
    }
}

/// A catalog item publish's or edit's status, once done: what it did, and for a publish, a retry
/// of the items that may publish now (`retryable`), which previews them again.
#[component(css = ItemForm)]
pub fn ItemJobOutcome<'a>(t: Cat, job: &'a Job<serde_json::Value>) -> impl Render {
    html! {
        match job.kind.as_str() {
            crate::catalog::api::ITEMS_PUBLISH => {
                if let Some(outcome) = job.read::<PublishOutcome>().result {
                    let retry: Vec<String> = outcome
                        .candidates
                        .iter()
                        .filter(|c| c.retryable && c.outcome != "published")
                        .map(|c| c.catalog_item_id.clone())
                        .collect();
                    let f = ItemBulkInput::FIELDS;
                    let action = url::ItemsBulk { query: Default::default() }.href();
                    <p class={Note}>
                        {t.item_list_bulk_result_description(outcome.published_count, outcome.failed_count, outcome.skipped_count)}
                    </p>
                    <PublishTable t={t} candidates={&outcome.candidates} />
                    if !retry.is_empty() {
                        <form class={Confirm} method="post" action={&action} data-patch>
                            <input type="hidden" name={f.action} value="publish">
                            <input type="hidden" name={f.mode} value="ids">
                            for id in &retry {
                                <input type="hidden" name={f.ids} value={id}>
                            }
                            <div class={Footer}>
                                <button type="submit" class={Small}>{t.item_list_retry_failed_items()}</button>
                            </div>
                        </form>
                    }
                }
            }
            _ => {
                if let Some(outcome) = job.read::<EditOutcome>().result {
                    <p class={Note}>
                        {t.item_list_bulk_edit_result_description(outcome.succeeded_count, outcome.skipped_count, outcome.failed_count)}
                    </p>
                    <EditTable t={t} candidates={&outcome.candidates} />
                }
            }
        }
    }
}
