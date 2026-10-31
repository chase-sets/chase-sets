//! The reference types list and a reference type's page (`ReferenceTypeListPage`,
//! `ReferenceTypeDetailPage`), from the area's shared parts: the list's filters (search, status,
//! attribute key), rows, bulk bar and create dialog, and the page's values, status change and
//! edit dialog.
use corten::prelude::*;

use super::{
    ActionBar, Bar, Bulk, BulkRows, DetailPage, Dialog, Draft, Empty, Filters, KeyValues, LifecycleForm, ListPage, ListScreen,
    Pager, Pick, RefTypeForm, RefTypeRow, Search, Table, TextFilter, Toasts, Transition, Trigger, bulk_dialogs, ids,
    pages_around, statuses, value,
};
use crate::{
    catalog::{api::ReferenceType, form::RefTypeInput, reference_types::url},
    text::{Cat, Pilot},
};

/// The lifecycle actions the list's bulk bar offers (`lifecycleActions`): a reference type is
/// published.
pub fn ref_type_actions(t: Cat) -> [(&'static str, &'static str); 3] {
    [("publish", t.ref_type_publish()), ("deprecate", t.ref_type_deprecate()), ("archive", t.ref_type_archive())]
}

/// The transitions a reference type's status allows (`getTransitions`).
pub fn ref_type_transitions(t: Cat, status: &str) -> Vec<Transition> {
    match status {
        "draft" => vec![Transition { action: "publish", label: t.ref_type_publish(), confirm: false }],
        "active" => vec![Transition { action: "deprecate", label: t.ref_type_deprecate(), confirm: true }],
        "deprecated" => vec![Transition { action: "archive", label: t.ref_type_archive(), confirm: true }],
        _ => Vec::new(),
    }
}

/// A reference type page's forms that came back from a submit, drawn in their open dialog.
#[derive(Default)]
pub struct RefTypeForms {
    pub edit: Option<Draft<RefTypeInput>>,
    pub lifecycle: Option<Errors>,
}

/// The list, its filters and the create dialog.
pub fn ref_type_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::RefTypeQuery,
    screen: &'a ListScreen<ReferenceType>,
    create: Option<Draft<RefTypeInput>>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(RefTypeInput::blank()));
    let title = t.ref_type_list_reference_types();
    let create_action = url::RefTypes::of(query).href();
    let live = url::RefTypesLive { query: query.clone() }.href();
    let filters = url::RefTypes::default().href();
    let states = statuses(t);
    let f = url::RefTypeQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.ref_type_list_new_reference_type()} secondary={false} />
        </ListPage>
        <Filters t={t} action={&filters}>
            <Search t={t} name={f.search} title={title} value={value(&query.search)} />
            <Pick
                label={t.list_status()}
                name={f.status}
                all={t.list_all_statuses()}
                options={&states}
                value={value(&query.status)}
            />
            <TextFilter
                label={t.ref_type_list_attribute_key()}
                name={f.attribute_key}
                value={value(&query.attribute_key)}
                placeholder=""
            />
        </Filters>
        <corten-live src={&live}>{ref_type_rows(t, p, query, screen, bulk.manage)}</corten-live>
        <Dialog
            id={ids::CREATE_DIALOG}
            title={t.ref_type_list_create_reference_type()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <RefTypeForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </Dialog>
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn ref_type_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::RefTypeQuery,
    screen: &'a ListScreen<ReferenceType>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.ref_type_list_reference_types();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.ref_type_list_reference_type()).to_string()
    };
    let head = [t.ref_type_list_key(), t.ref_type_list_name(), t.ref_type_list_attributes(), t.ref_type_list_status(), ""];
    let (previous, next) = pages_around(screen, |page| {
        url::RefTypes::of(&url::RefTypeQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::RefTypesBulk { query: query.clone() }.href();
    let actions = ref_type_actions(t);
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <RefTypeRow t={t} row={row} select={select} />
                    }
                </Table>
                <Pager
                    t={t}
                    p={p}
                    page={screen.page}
                    pages={screen.pages}
                    previous={previous.as_deref()}
                    next={next.as_deref()}
                />
            }
        };
        if manage {
            let bar = Bar { entity: title, action: &preview, total: screen.total, actions: &actions };
            <BulkRows t={t} p={p} bar={bar} fields={()} more={()}>{body}</BulkRows>
        } else {
            <div id={ids::ROWS}>{body}</div>
        }
    }
}

/// A reference type: its values, its status change and edit dialog (not for an archived one).
pub fn ref_type_page<'a>(
    t: Cat,
    p: Pilot,
    ref_type: &'a ReferenceType,
    notice: Option<String>,
    forms: RefTypeForms,
) -> impl Render + 'a {
    let RefTypeForms { edit, lifecycle } = forms;
    let id = ref_type.reference_type_id.as_str();
    let editable = ref_type.status != "archived";
    let edit_open = edit.is_some();
    let edit = edit.unwrap_or_else(|| Draft::new(RefTypeInput::of(ref_type)));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = ref_type_transitions(t, &ref_type.status);
    let dash = || "\u{2014}".to_owned();
    let keys = ref_type.attribute_keys.join(", ");
    let items = [
        (t.ref_type_key(), ref_type.key.clone()),
        (t.ref_type_name(), ref_type.name.clone()),
        (t.ref_type_description(), ref_type.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(dash)),
        (t.ref_type_attribute_keys(), if keys.is_empty() { dash() } else { keys }),
        (t.ref_type_status(), ref_type.status.clone()),
        (t.ref_type_updated(), ref_type.updated_at.clone()),
    ];
    let list = url::RefTypes::default().href();
    let (edit_action, lifecycle_action) = (url::RefTypeEdit { id }.href(), url::RefTypeLifecycle { id }.href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.ref_type_reference_types()} name={&ref_type.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&ref_type.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.ref_type_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
        </DetailPage>
        if editable {
            <Dialog
                id={ids::EDIT_DIALOG}
                title={t.ref_type_edit_reference_type()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <RefTypeForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </Dialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}
