//! The blueprints list and a blueprint's page (`BlueprintListPage`, `BlueprintDetailPage`), from
//! the area's shared parts: the list's filters, rows, bulk bar and create dialog, and the page's
//! values, status change, edit dialog, its components (attach, detach), and its field, dimension
//! and product resolution rules, each folded with a Set dialog.
//!
//! A Set dialog replaces all of its rules with the rows it sends, so the server draws it when it
//! is opened, from the rules the list has (the blueprint's own table): the page's read can miss a
//! change (chase-sets/chase-sets#10823), and a rule the dialog did not show would be deleted.
use corten::prelude::*;

use super::{
    ActionBar, AttachForm, Bar, BlueprintForm, BlueprintRow, Bulk, BulkRows, CatalogDialog, DetailPage, DimensionRulesForm,
    Draft, Empty, FieldRulesForm, Filters, KeyValues, LifecycleForm, ListPage, ListScreen, OrderForm, Pager, Part, Pick,
    RemoveForm, Search, Table, Toasts, Transition, Trigger, bulk_dialogs,
    components::{applicability, refused, unlisted},
    detail_page::Opener,
    ids,
    item_page::Disclosure,
    pages_around, statuses, value,
};
use crate::{
    catalog::{
        api::{Blueprint, BlueprintDetail},
        blueprints::url,
        form::{AttachInput, BlueprintInput, DimensionRulesInput, FieldRulesInput, OrderInput},
    },
    text::{Cat, Pilot},
};

/// The lifecycle actions the list's bulk bar offers (`lifecycleActions`): a blueprint is
/// published where a component is activated.
pub fn blueprint_actions(t: Cat) -> [(&'static str, &'static str); 3] {
    [("publish", t.blueprint_publish()), ("deprecate", t.blueprint_deprecate()), ("archive", t.blueprint_archive())]
}

/// The transitions a blueprint's status allows (`getTransitions`).
pub fn blueprint_transitions(t: Cat, status: &str) -> Vec<Transition> {
    match status {
        "draft" => vec![Transition { action: "publish", label: t.blueprint_publish(), confirm: false }],
        "active" => vec![Transition { action: "deprecate", label: t.blueprint_deprecate(), confirm: true }],
        "deprecated" => vec![Transition { action: "archive", label: t.blueprint_archive(), confirm: true }],
        _ => Vec::new(),
    }
}

/// A Set dialog the page shows open: its form, or that the rules it starts from were not read.
pub enum SetRules {
    Fields(Draft<FieldRulesInput>),
    Dimensions(Draft<DimensionRulesInput>),
    Order(Draft<OrderInput>),
    Unread(Set),
}

/// Which Set dialog.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Set {
    Fields,
    Dimensions,
    Order,
}

/// A blueprint page's forms that came back from a submit, or a Set dialog opened, drawn in their
/// open dialog; a refused Detach is keyed by its form (`ids::rule`).
#[derive(Default)]
pub struct BlueprintForms {
    pub edit: Option<Draft<BlueprintInput>>,
    pub lifecycle: Option<Errors>,
    pub attach: Option<Draft<AttachInput>>,
    pub set: Option<SetRules>,
    pub removal: Option<(String, Errors)>,
}

/// The list, its filters (search, status, and whether it has components, field rules or
/// dimension rules), and the create dialog.
pub fn blueprint_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::BlueprintQuery,
    screen: &'a ListScreen<Blueprint>,
    create: Option<Draft<BlueprintInput>>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(BlueprintInput::blank()));
    let title = t.blueprint_list_blueprints();
    let create_action = url::Blueprints::of(query).href();
    let live = url::BlueprintsLive { query: query.clone() }.href();
    let filters = url::Blueprints::default().href();
    let states = statuses(t);
    let flags = [("true", t.list_yes()), ("false", t.list_no())];
    let f = url::BlueprintQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.blueprint_list_new_blueprint()} secondary={false} />
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
                label={t.blueprint_components()}
                name={f.has_components}
                all={t.list_all()}
                options={&flags}
                value={value(&query.has_components)}
            />
            <Pick
                label={t.blueprint_field_rules()}
                name={f.has_field_rules}
                all={t.list_all()}
                options={&flags}
                value={value(&query.has_field_rules)}
            />
            <Pick
                label={t.blueprint_dimension_rules()}
                name={f.has_dimension_rules}
                all={t.list_all()}
                options={&flags}
                value={value(&query.has_dimension_rules)}
            />
        </Filters>
        <corten-live src={&live}>{blueprint_rows(t, p, query, screen, bulk.manage)}</corten-live>
        <CatalogDialog
            id={ids::CREATE_DIALOG}
            title={t.blueprint_list_create_blueprint()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <BlueprintForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </CatalogDialog>
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn blueprint_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::BlueprintQuery,
    screen: &'a ListScreen<Blueprint>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.blueprint_list_blueprints();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.blueprint_blueprint().to_lowercase()).to_string()
    };
    let head = [t.blueprint_list_key(), t.blueprint_list_name(), t.blueprint_list_status(), ""];
    let (previous, next) = pages_around(screen, |page| {
        url::Blueprints::of(&url::BlueprintQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::BlueprintsBulk { query: query.clone() }.href();
    let actions = blueprint_actions(t);
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <BlueprintRow t={t} row={row} select={select} />
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

/// A blueprint: its values, its status change and edit dialog, its components, and its rules.
/// Only a draft's components and rules change (admin-web shows their buttons for a draft); an
/// archived one is not edited.
pub fn blueprint_page<'a>(
    t: Cat,
    p: Pilot,
    blueprint: &'a BlueprintDetail,
    after_write: Option<&'a str>,
    notice: Option<String>,
    forms: BlueprintForms,
) -> impl Render + 'a {
    let BlueprintForms { edit, lifecycle, attach, set, removal } = forms;
    let id = blueprint.blueprint_id.as_str();
    let (editable, draft) = (blueprint.status != "archived", blueprint.status == "draft");
    let (edit_open, attach_open) = (edit.is_some(), attach.is_some());
    let edit = edit.unwrap_or_else(|| Draft::new(BlueprintInput::of(blueprint)));
    let attach = attach.unwrap_or_else(|| Draft::new(AttachInput::default()));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = blueprint_transitions(t, &blueprint.status);
    let not_set = || t.blueprint_not_set().to_owned();
    let items = [
        (t.blueprint_key(), blueprint.key.clone()),
        (t.blueprint_name(), blueprint.name.clone()),
        (t.blueprint_description(), blueprint.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "\u{2014}".into())),
        (t.blueprint_status(), blueprint.status.clone()),
        (t.blueprint_updated(), blueprint.updated_at.clone()),
    ];
    let order = blueprint.canonical_dimension_order.iter().map(|d| d.dimension_name.as_str()).collect::<Vec<_>>().join(", ");
    let order = if order.is_empty() { not_set() } else { order };
    let order_items = [(t.blueprint_canonical_dimension_order(), order.clone())];
    let field_tone = if blueprint.field_rules.iter().any(|r| r.required) { "warning" } else { "info" };
    let dimension_tone = if blueprint.dimension_rules.iter().any(|r| r.required) { "warning" } else { "info" };
    let order_tone = if blueprint.canonical_dimension_order.is_empty() { "warning" } else { "info" };
    let field_summary = t.blueprint_field_rules_summary(blueprint.field_rules.len()).to_string();
    let dimension_summary = t.blueprint_dimension_rules_summary(blueprint.dimension_rules.len()).to_string();
    let list = url::Blueprints::default().href();
    let (edit_action, lifecycle_action) = (url::BlueprintEdit { id }.href(), url::BlueprintLifecycle { id }.href());
    let attach_action = url::Attach { id }.href();
    let (fields_at, dimensions_at, order_at) =
        (url::FieldRules::of(id).href(), url::DimensionRules::of(id).href(), url::ProductResolutionRules::of(id).href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.blueprint_blueprints()} name={&blueprint.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&blueprint.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.blueprint_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
            <Part title={t.blueprint_components()} description="">
                if draft {
                    <ActionBar>
                        <Trigger dialog={ids::ATTACH_DIALOG} label={t.blueprint_attach_component()} secondary={false} />
                    </ActionBar>
                }
                {components(t, blueprint, draft, removal)}
            </Part>
            <Part title={t.blueprint_field_rules()} description="">
                <Disclosure title={t.blueprint_field_rules()} summary={&field_summary} tone={field_tone} open={false}>
                    if draft {
                        <Opener action={&fields_at} after_write={after_write} label={t.blueprint_set_field_rules()} />
                    }
                    {field_rules(t, blueprint)}
                </Disclosure>
            </Part>
            <Part title={t.blueprint_dimension_rules()} description="">
                <Disclosure title={t.blueprint_dimension_rules()} summary={&dimension_summary} tone={dimension_tone} open={false}>
                    if draft {
                        <Opener action={&dimensions_at} after_write={after_write} label={t.blueprint_set_dimension_rules()} />
                    }
                    {dimension_rules(t, blueprint)}
                </Disclosure>
            </Part>
            <Part title={t.blueprint_product_resolution_rules()} description="">
                <Disclosure title={t.blueprint_product_resolution_rules()} summary={&order} tone={order_tone} open={false}>
                    <KeyValues items={&order_items} />
                    if draft {
                        <Opener
                            action={&order_at}
                            after_write={after_write}
                            label={t.blueprint_set_product_resolution_rules()}
                        />
                    }
                </Disclosure>
            </Part>
        </DetailPage>
        if editable {
            <CatalogDialog
                id={ids::EDIT_DIALOG}
                title={t.blueprint_edit_blueprint()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <BlueprintForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </CatalogDialog>
        }
        if draft {
            <CatalogDialog
                id={ids::ATTACH_DIALOG}
                title={t.blueprint_attach_component_2()}
                description={None}
                open={attach_open}
                close={p.catalog_close()}
            >
                <AttachForm t={t} id={ids::ATTACH} action={&attach_action} form={&attach} />
            </CatalogDialog>
            {set_dialogs(t, p, id, set)}
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The three Set dialogs: the one opened, drawn open, and an empty one for each of the others
/// for the server's dialog to replace.
fn set_dialogs<'a>(t: Cat, p: Pilot, id: &'a str, set: Option<SetRules>) -> impl Render + 'a {
    let unread = |which: Set| matches!(&set, Some(SetRules::Unread(of)) if *of == which);
    let (fields_unread, dimensions_unread, order_unread) = (unread(Set::Fields), unread(Set::Dimensions), unread(Set::Order));
    let (fields, dimensions, order) = match set {
        Some(SetRules::Fields(draft)) => (Some(draft), None, None),
        Some(SetRules::Dimensions(draft)) => (None, Some(draft), None),
        Some(SetRules::Order(draft)) => (None, None, Some(draft)),
        _ => (None, None, None),
    };
    html! {
        if fields.is_some() || fields_unread {
            <FieldRulesDialog t={t} p={p} id={id} form={fields.as_ref()} />
        } else {
            <dialog id={ids::SET_FIELDS_DIALOG}></dialog>
        }
        if dimensions.is_some() || dimensions_unread {
            <DimensionRulesDialog t={t} p={p} id={id} form={dimensions.as_ref()} />
        } else {
            <dialog id={ids::SET_DIMENSIONS_DIALOG}></dialog>
        }
        if order.is_some() || order_unread {
            <OrderDialog t={t} p={p} id={id} form={order.as_ref()} />
        } else {
            <dialog id={ids::SET_ORDER_DIALOG}></dialog>
        }
    }
}

/// Why a Set dialog has no form: the list did not have the blueprint, so its rules are not known,
/// and a save would replace them with what the dialog did not show.
fn unread_message(p: Pilot) -> Errors {
    let mut errors = Errors::new();
    errors.add_form(p.catalog_blueprint_rules_unread());
    errors
}

/// Set Field Rules, drawn open: its form, or why there is none.
#[component]
pub fn FieldRulesDialog<'a>(t: Cat, p: Pilot, id: &'a str, form: Option<&'a Draft<FieldRulesInput>>) -> impl Patch {
    let action = url::FieldRules::of(id).href();
    html! {
        <CatalogDialog
            id={ids::SET_FIELDS_DIALOG}
            title={t.blueprint_set_field_rules_2()}
            description={Some(t.blueprint_configure_which_fields_apply_to_this())}
            open
            close={p.catalog_close()}
        >
            if let Some(form) = form {
                <FieldRulesForm t={t} id={ids::SET_FIELDS} action={&action} form={form} />
            } else {
                {unread_message(p).form_message()}
            }
        </CatalogDialog>
    }
}

/// Set Dimension Rules, drawn open: its form, or why there is none.
#[component]
pub fn DimensionRulesDialog<'a>(t: Cat, p: Pilot, id: &'a str, form: Option<&'a Draft<DimensionRulesInput>>) -> impl Patch {
    let action = url::DimensionRules::of(id).href();
    html! {
        <CatalogDialog
            id={ids::SET_DIMENSIONS_DIALOG}
            title={t.blueprint_set_dimension_rules_2()}
            description={Some(t.blueprint_configure_which_dimensions_apply_to_this())}
            open
            close={p.catalog_close()}
        >
            if let Some(form) = form {
                <DimensionRulesForm t={t} id={ids::SET_DIMENSIONS} action={&action} form={form} />
            } else {
                {unread_message(p).form_message()}
            }
        </CatalogDialog>
    }
}

/// Set Product Resolution Rules, drawn open: its form, or why there is none.
#[component]
pub fn OrderDialog<'a>(t: Cat, p: Pilot, id: &'a str, form: Option<&'a Draft<OrderInput>>) -> impl Patch {
    let action = url::ProductResolutionRules::of(id).href();
    html! {
        <CatalogDialog
            id={ids::SET_ORDER_DIALOG}
            title={t.blueprint_set_product_resolution_rules_2()}
            description={Some(t.blueprint_enter_dimension_ids_separated_by_commas())}
            open
            close={p.catalog_close()}
        >
            if let Some(form) = form {
                <OrderForm t={t} id={ids::SET_ORDER} action={&action} form={form} />
            } else {
                {unread_message(p).form_message()}
            }
        </CatalogDialog>
    }
}

fn components<'a>(t: Cat, blueprint: &'a BlueprintDetail, draft: bool, removal: Option<(String, Errors)>) -> impl Render + 'a {
    let id = blueprint.blueprint_id.as_str();
    let head = [t.blueprint_component(), ""];
    let unlisted =
        unlisted(removal.as_ref(), "component", blueprint.components.iter().map(|c| ids::rule("component", &c.component_id)));
    let rows: Vec<_> = blueprint
        .components
        .iter()
        .map(|component| {
            let key = ids::rule("component", &component.component_id);
            let errors = refused(removal.as_ref(), &key);
            let action = url::Detach { id, component_id: &component.component_id }.href();
            html! {
                <tr>
                    <td>{&component.name}</td>
                    <td>
                        if draft {
                            <RemoveForm id={ids::RuleId(&key)} action={&action} label={t.blueprint_detach()} errors={&errors} />
                        }
                    </td>
                </tr>
            }
        })
        .collect();
    html! {
        {unlisted.form_message()}
        if blueprint.components.is_empty() {
            <Empty title={t.blueprint_no_components_attached()} description="" />
        } else {
            <Table label={t.blueprint_components()} head={&head} all={None}>
                for row in rows {
                    {row}
                }
            </Table>
        }
    }
}

fn field_rules<'a>(t: Cat, blueprint: &'a BlueprintDetail) -> impl Render + 'a {
    let head = [t.blueprint_field(), t.blueprint_required()];
    html! {
        if blueprint.field_rules.is_empty() {
            <Empty title={t.blueprint_no_field_rules()} description="" />
        } else {
            <Table label={t.blueprint_field_rules()} head={&head} all={None}>
                for rule in &blueprint.field_rules {
                    <tr>
                        <td>{if rule.field_name.is_empty() { &rule.field_id } else { &rule.field_name }}</td>
                        <td>{if rule.required { t.blueprint_yes() } else { t.blueprint_no() }}</td>
                    </tr>
                }
            </Table>
        }
    }
}

fn dimension_rules<'a>(t: Cat, blueprint: &'a BlueprintDetail) -> impl Render + 'a {
    let head = [t.blueprint_dimension(), t.blueprint_required_2(), t.blueprint_allowed_options(), t.blueprint_applies_when()];
    let allowed = move |codes: Vec<&str>| if codes.is_empty() { t.blueprint_all().to_owned() } else { codes.join(", ") };
    html! {
        if blueprint.dimension_rules.is_empty() {
            <Empty title={t.blueprint_no_dimension_rules()} description="" />
        } else {
            <Table label={t.blueprint_dimension_rules()} head={&head} all={None}>
                for rule in &blueprint.dimension_rules {
                    <tr>
                        <td>{if rule.dimension_name.is_empty() { &rule.dimension_id } else { &rule.dimension_name }}</td>
                        <td>{if rule.required { t.blueprint_yes_2() } else { t.blueprint_no_2() }}</td>
                        <td>{allowed(rule.allowed_options.iter().map(|o| o.code.as_str()).collect())}</td>
                        <td>{applicability(t, &rule.applies_when)}</td>
                    </tr>
                }
            </Table>
        }
    }
}
