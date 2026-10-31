//! The reference records list and a reference record's page (`ReferenceRecordListPage`,
//! `ReferenceRecordDetailPage`), from the area's shared parts: the list's filters (search,
//! status, type, relationship, attribute key and value), rows, bulk bar and create dialog, and
//! the page's values, relationships, status change and edit dialog.
//!
//! The create and edit dialogs are drawn by the server when they are opened ([`Opens`]), with
//! the active types and the records a relationship may name: the list and the page do not read
//! those (up to 500 records each, as admin-web reads them) until the dialog is wanted.
use corten::prelude::*;

use super::{
    ActionBar, Bar, Bulk, BulkRows, DetailPage, Dialog, Draft, Empty, Filters, KeyValues, LifecycleForm, ListPage, ListScreen,
    Opens, Pager, Part, Pick, RefRecordForm, RefRecordRow, Search, Table, TextFilter, Toasts, Transition, bulk_dialogs, ids,
    pages_around, statuses, value,
};
use crate::{
    catalog::{
        api::{ReferenceRecord, ReferenceRow, ReferenceType},
        blueprints::url::Opened,
        form::RefRecordInput,
        reference_records::url,
        reference_types::url as ref_types,
    },
    text::{Cat, Pilot},
};

/// The lifecycle actions the list's bulk bar offers (`lifecycleActions`): a reference record is
/// published.
pub fn ref_record_actions(t: Cat) -> [(&'static str, &'static str); 3] {
    [("publish", t.ref_record_publish()), ("deprecate", t.ref_record_deprecate()), ("archive", t.ref_record_archive())]
}

/// The transitions a reference record's status allows (`getTransitions`).
pub fn ref_record_transitions(t: Cat, status: &str) -> Vec<Transition> {
    match status {
        "draft" => vec![Transition { action: "publish", label: t.ref_record_publish(), confirm: false }],
        "active" => vec![Transition { action: "deprecate", label: t.ref_record_deprecate(), confirm: true }],
        "deprecated" => vec![Transition { action: "archive", label: t.ref_record_archive(), confirm: true }],
        _ => Vec::new(),
    }
}

/// What a reference record's form picks from: the active types and the records (500 of each,
/// as admin-web's loaders read them).
#[derive(Clone, Default)]
pub struct RefChoices {
    pub types: Vec<ReferenceType>,
    pub records: Vec<ReferenceRow>,
}

/// A reference record's form, opened or come back, with what it picks from.
#[derive(Clone)]
pub struct RecordDraft {
    pub form: Draft<RefRecordInput>,
    pub choices: RefChoices,
}

/// A reference record page's forms that came back from a submit (or were opened), drawn open.
#[derive(Default)]
pub struct RefRecordForms {
    pub edit: Option<RecordDraft>,
    pub lifecycle: Option<Errors>,
}

/// The create dialog, drawn open; `action` keeps the list's filters.
#[component]
pub fn RefRecordCreateDialog<'a>(t: Cat, p: Pilot, action: &'a str, draft: &'a RecordDraft) -> impl Patch {
    let RecordDraft { form, choices } = draft;
    html! {
        <Dialog
            id={ids::CREATE_DIALOG}
            title={t.ref_record_list_create_reference_record()}
            description={None}
            open
            close={p.catalog_close()}
        >
            <RefRecordForm
                t={t}
                id={ids::CREATE}
                action={action}
                create
                form={form}
                types={&choices.types}
                records={&choices.records}
                own=""
            />
        </Dialog>
    }
}

/// The edit dialog of record `id`, drawn open.
#[component]
pub fn RefRecordEditDialog<'a>(t: Cat, p: Pilot, id: &'a str, draft: &'a RecordDraft) -> impl Patch {
    let RecordDraft { form, choices } = draft;
    let action = url::RefRecordEdit::of(id).href();
    html! {
        <Dialog
            id={ids::EDIT_DIALOG}
            title={t.ref_record_edit_reference_record()}
            description={None}
            open
            close={p.catalog_close()}
        >
            <RefRecordForm
                t={t}
                id={ids::EDIT}
                action={&action}
                create={false}
                form={form}
                types={&choices.types}
                records={&choices.records}
                own={id}
            />
        </Dialog>
    }
}

/// The list, its filters and the create dialog (drawn open when it was opened or came back).
#[expect(clippy::too_many_arguments, reason = "the list, its filters' choices, and the dialogs it may show open")]
pub fn ref_record_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::RefRecordQuery,
    screen: &'a ListScreen<ReferenceRecord>,
    types: &'a [ReferenceType],
    create: Option<RecordDraft>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let title = t.ref_record_list_reference_records();
    let create_action = url::RefRecords::of(query).href();
    let new_at = url::RefRecordNew::default().href();
    let live = url::RefRecordsLive { query: query.clone() }.href();
    let filters = url::RefRecords::default().href();
    let types_at = ref_types::RefTypes::default().href();
    let states = statuses(t);
    let f = url::RefRecordQuery::FIELDS;
    // The list's filters ride along to the create dialog, so a create returns to this list.
    let kept: Vec<(FieldName, &str)> = [
        (f.search, &query.search),
        (f.status, &query.status),
        (f.type_key, &query.type_key),
        (f.relationship_type, &query.relationship_type),
        (f.attribute_key, &query.attribute_key),
        (f.attribute_value, &query.attribute_value),
    ]
    .into_iter()
    .filter_map(|(name, set)| set.as_deref().map(|v| (name, v)))
    .collect();
    let type_labels: Vec<(String, String)> =
        types.iter().map(|ty| (ty.key.clone(), t.ref_record_list_reference_type_option(&ty.name, &ty.key).to_string())).collect();
    html! {
        let type_options: Vec<(&str, &str)> = type_labels.iter().map(|(k, l)| (k.as_str(), l.as_str())).collect();
        <ListPage title={title}>
            <a href={&types_at}>{t.ref_record_list_manage_reference_types()}</a>
            <Opens action={&new_at} fields={&kept} label={t.ref_record_list_new_reference_record()} secondary={false} />
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
            <Pick
                label={t.ref_record_list_reference_type()}
                name={f.type_key}
                all={t.ref_record_list_all_reference_types()}
                options={&type_options}
                value={value(&query.type_key)}
            />
            <TextFilter
                label={t.ref_record_list_relationship()}
                name={f.relationship_type}
                value={value(&query.relationship_type)}
                placeholder=""
            />
            <TextFilter
                label={t.ref_type_list_attribute_key()}
                name={f.attribute_key}
                value={value(&query.attribute_key)}
                placeholder=""
            />
            <TextFilter
                label={t.ref_record_list_attribute_value()}
                name={f.attribute_value}
                value={value(&query.attribute_value)}
                placeholder=""
            />
        </Filters>
        <corten-live src={&live}>{ref_record_rows(t, p, query, screen, bulk.manage)}</corten-live>
        if let Some(draft) = &create {
            <RefRecordCreateDialog t={t} p={p} action={&create_action} draft={draft} />
        } else {
            <dialog id={ids::CREATE_DIALOG}></dialog>
        }
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn ref_record_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::RefRecordQuery,
    screen: &'a ListScreen<ReferenceRecord>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.ref_record_list_reference_records();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.ref_record_list_reference_record()).to_string()
    };
    let head = [t.ref_record_list_type(), t.ref_record_list_key(), t.ref_record_list_name(), t.ref_record_list_status(), ""];
    let (previous, next) = pages_around(screen, |page| {
        url::RefRecords::of(&url::RefRecordQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::RefRecordsBulk { query: query.clone() }.href();
    let actions = ref_record_actions(t);
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <RefRecordRow t={t} row={row} select={select} />
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

/// A record's attributes as the page lists them (`formatAttributesSummary`), by key name: the
/// pilot's JSON objects do not keep the API's order (serde_json without `preserve_order`), which
/// admin-web lists them in.
fn attributes_summary(t: Cat, attributes: &serde_json::Value) -> String {
    use serde_json::Value;
    let entries: Vec<String> = attributes
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(key, value)| {
                    let value = match value {
                        Value::Null => "\u{2014}".to_owned(),
                        Value::String(text) => text.clone(),
                        Value::Number(_) | Value::Bool(_) => value.to_string(),
                        _ => serde_json::to_string(value).unwrap_or_default(),
                    };
                    t.ref_form_attribute_summary_entry(key, &value).to_string()
                })
                .collect()
        })
        .unwrap_or_default();
    if entries.is_empty() { "\u{2014}".to_owned() } else { entries.join(", ") }
}

/// A reference record: its values and relationships, its status change, and its edit dialog
/// (not for an archived one). `after_write` is the page's receipt, which opening Edit carries.
pub fn ref_record_page<'a>(
    t: Cat,
    p: Pilot,
    record: &'a ReferenceRecord,
    after_write: Option<&'a str>,
    notice: Option<String>,
    forms: RefRecordForms,
) -> impl Render + 'a {
    let RefRecordForms { edit, lifecycle } = forms;
    let id = record.reference_record_id.as_str();
    let editable = record.status != "archived";
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = ref_record_transitions(t, &record.status);
    let dash = || "\u{2014}".to_owned();
    let items = [
        (t.ref_record_type(), record.type_key.clone()),
        (t.ref_record_key(), record.key.clone()),
        (t.ref_record_name(), record.name.clone()),
        (t.ref_record_description(), record.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(dash)),
        (t.ref_record_attributes(), attributes_summary(t, &record.attributes)),
        (t.ref_record_status(), record.status.clone()),
        (t.ref_record_updated(), record.updated_at.clone()),
    ];
    let head = [t.ref_record_relationship(), t.ref_record_reference_record_id()];
    let list = url::RefRecords::default().href();
    let lifecycle_action = url::RefRecordLifecycle { id }.href();
    let edit_at = url::RefRecordEdit::of(id).href();
    let kept: Vec<(FieldName, &str)> = after_write.map(|receipt| (Opened::FIELDS.after_write, receipt)).into_iter().collect();
    html! {
        <DetailPage p={p} list={&list} list_label={t.ref_record_reference_records()} name={&record.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&record.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Opens action={&edit_at} fields={&kept} label={t.ref_record_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
            <Part title={t.ref_record_relationships()} description="">
                if record.relationships.is_empty() {
                    <Empty title={t.ref_record_no_relationships()} description="" />
                } else {
                    <Table label={t.ref_record_relationships()} head={&head} all={None}>
                        for relationship in &record.relationships {
                            <tr>
                                <td>{&relationship.relationship_type}</td>
                                <td>
                                    <a href={url::RefRecord { id: &relationship.reference_id, after_write: None, done: None }}>
                                        {relationship.reference.as_ref().map_or(relationship.reference_id.as_str(), |r| r.name.as_str())}
                                    </a>
                                </td>
                            </tr>
                        }
                    </Table>
                }
            </Part>
        </DetailPage>
        if let Some(draft) = &edit {
            <RefRecordEditDialog t={t} p={p} id={id} draft={draft} />
        } else {
            <dialog id={ids::EDIT_DIALOG}></dialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}
