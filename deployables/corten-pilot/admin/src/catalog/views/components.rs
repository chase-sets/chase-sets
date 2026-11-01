//! The components list and a component's page (`ComponentListPage`, `ComponentDetailPage`), from
//! the area's shared parts: the list's filters, rows, bulk bar and create dialog, and the page's
//! values, status change, edit dialog, and its field and dimension rules with their add dialogs
//! and Remove buttons.
use corten::prelude::*;

use super::{
    ActionBar, Bar, Bulk, BulkRows, CatalogDialog, ComponentForm, ComponentRow, DetailPage, DimensionRuleForm, Draft, Empty,
    FieldRuleForm, Filters, KeyValues, LifecycleForm, ListPage, ListScreen, Pager, Part, Pick, RemoveForm, Search, Table, Toasts,
    Trigger, bulk_actions, bulk_dialogs, ids, pages_around, statuses, transitions, value,
};
use crate::{
    catalog::{
        api::{Applies, Component, ComponentDetail, DimensionRule, FieldRule},
        components::url,
        form::{ComponentInput, DimensionRuleInput, FieldRuleInput},
    },
    text::{Cat, Pilot},
};

/// A component page's forms that came back from a submit, drawn in their open dialog; a rule's
/// refused Remove is keyed by its form (`ids::rule`).
#[derive(Default)]
pub struct ComponentForms {
    pub edit: Option<Draft<ComponentInput>>,
    pub lifecycle: Option<Errors>,
    pub field_rule: Option<Draft<FieldRuleInput>>,
    pub dimension_rule: Option<Draft<DimensionRuleInput>>,
    pub removal: Option<(String, Errors)>,
}

/// The list, its filters (search, status, and whether it has field or dimension rules), and the
/// create dialog.
pub fn component_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::ComponentQuery,
    screen: &'a ListScreen<Component>,
    create: Option<Draft<ComponentInput>>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(ComponentInput::blank()));
    let title = t.component_list_components();
    let create_action = url::Components::of(query).href();
    let live = url::ComponentsLive { query: query.clone() }.href();
    let filters = url::Components::default().href();
    let states = statuses(t);
    let flags = [("true", t.list_yes()), ("false", t.list_no())];
    let f = url::ComponentQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.component_list_new_component()} secondary={false} />
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
                label={t.component_field_rules()}
                name={f.has_field_rules}
                all={t.list_all()}
                options={&flags}
                value={value(&query.has_field_rules)}
            />
            <Pick
                label={t.component_dimension_rules()}
                name={f.has_dimension_rules}
                all={t.list_all()}
                options={&flags}
                value={value(&query.has_dimension_rules)}
            />
        </Filters>
        <corten-live src={&live}>{component_rows(t, p, query, screen, bulk.manage)}</corten-live>
        <CatalogDialog
            id={ids::CREATE_DIALOG}
            title={t.component_list_create_component()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <ComponentForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </CatalogDialog>
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn component_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::ComponentQuery,
    screen: &'a ListScreen<Component>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.component_list_components();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.component_component().to_lowercase()).to_string()
    };
    let head = [t.component_list_key(), t.component_list_name(), t.component_list_status(), ""];
    let (previous, next) = pages_around(screen, |page| {
        url::Components::of(&url::ComponentQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::ComponentsBulk { query: query.clone() }.href();
    let actions = bulk_actions(t.component_activate(), t.component_deprecate(), t.component_archive());
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <ComponentRow t={t} row={row} select={select} />
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

/// When a dimension rule applies (`formatApplicability`): Always, or each clause as
/// `dimension = code | code`.
pub fn applicability(t: Cat, clauses: &[Applies]) -> String {
    if clauses.is_empty() {
        return t.component_always().to_owned();
    }
    clauses
        .iter()
        .map(|clause| {
            let options = if clause.options.is_empty() {
                clause.option_ids.join(" | ")
            } else {
                clause.options.iter().map(|o| o.code.as_str()).collect::<Vec<_>>().join(" | ")
            };
            format!("{} = {options}", clause.dimension_name.as_deref().unwrap_or(&clause.dimension_id))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// A component: its values, its status change and edit dialog, and its rules (none of the
/// writes for an archived one).
pub fn component_page<'a>(
    t: Cat,
    p: Pilot,
    component: &'a ComponentDetail,
    notice: Option<String>,
    forms: ComponentForms,
) -> impl Render + 'a {
    let ComponentForms { edit, lifecycle, field_rule, dimension_rule, removal } = forms;
    let id = component.component_id.as_str();
    let editable = component.status != "archived";
    let (edit_open, field_open, dimension_open) = (edit.is_some(), field_rule.is_some(), dimension_rule.is_some());
    let edit = edit.unwrap_or_else(|| Draft::new(ComponentInput::of(component)));
    let field_rule = field_rule.unwrap_or_else(|| Draft::new(FieldRuleInput::default()));
    let dimension_rule = dimension_rule.unwrap_or_else(|| Draft::new(DimensionRuleInput::default()));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = transitions(&component.status, t.component_activate(), t.component_deprecate(), t.component_archive());
    let items = [
        (t.component_key(), component.key.clone()),
        (t.component_name(), component.name.clone()),
        (t.component_description(), component.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "\u{2014}".into())),
        (t.component_status(), component.status.clone()),
        (t.component_updated(), component.updated_at.clone()),
    ];
    let list = url::Components::default().href();
    let (edit_action, lifecycle_action) = (url::ComponentEdit { id }.href(), url::ComponentLifecycle { id }.href());
    let (field_action, dimension_action) = (url::FieldRules { id }.href(), url::DimensionRules { id }.href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.component_components()} name={&component.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&component.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.component_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
            <Part title={t.component_field_rules()} description="">
                if editable {
                    <ActionBar>
                        <Trigger dialog={ids::ADD_FIELD_RULE_DIALOG} label={t.component_add_field_rule()} secondary={false} />
                    </ActionBar>
                }
                {field_rules(t, component, editable, removal.clone())}
            </Part>
            <Part title={t.component_dimension_rules()} description="">
                if editable {
                    <ActionBar>
                        <Trigger
                            dialog={ids::ADD_DIMENSION_RULE_DIALOG}
                            label={t.component_add_dimension_rule()}
                            secondary={false}
                        />
                    </ActionBar>
                }
                {dimension_rules(t, component, editable, removal)}
            </Part>
        </DetailPage>
        if editable {
            <CatalogDialog
                id={ids::EDIT_DIALOG}
                title={t.component_edit_component()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <ComponentForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </CatalogDialog>
            <CatalogDialog
                id={ids::ADD_FIELD_RULE_DIALOG}
                title={t.component_add_field_rule_2()}
                description={None}
                open={field_open}
                close={p.catalog_close()}
            >
                <FieldRuleForm t={t} id={ids::ADD_FIELD_RULE} action={&field_action} form={&field_rule} />
            </CatalogDialog>
            <CatalogDialog
                id={ids::ADD_DIMENSION_RULE_DIALOG}
                title={t.component_add_dimension_rule_2()}
                description={None}
                open={dimension_open}
                close={p.catalog_close()}
            >
                <DimensionRuleForm t={t} id={ids::ADD_DIMENSION_RULE} action={&dimension_action} form={&dimension_rule} />
            </CatalogDialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The refusal of the rule form keyed `key`, if it came back.
pub(super) fn refused(removal: Option<&(String, Errors)>, key: &str) -> Errors {
    removal.filter(|(of, _)| of == key).map(|(_, errors)| errors.clone()).unwrap_or_default()
}

/// A refused Remove of a `kind` rule the page no longer lists (the read after the refusal no
/// longer has it): its message goes above the table, since there is no row to hold it.
pub(super) fn unlisted(removal: Option<&(String, Errors)>, kind: &str, mut keys: impl Iterator<Item = String>) -> Errors {
    removal
        .filter(|(of, _)| of.strip_prefix(kind).is_some_and(|rest| rest.starts_with('-')) && !keys.any(|key| key == *of))
        .map(|(_, errors)| errors.clone())
        .unwrap_or_default()
}

fn field_rules<'a>(
    t: Cat,
    component: &'a ComponentDetail,
    editable: bool,
    removal: Option<(String, Errors)>,
) -> impl Render + 'a {
    let head = [t.component_field(), t.component_required(), ""];
    let id = component.component_id.as_str();
    let unlisted = unlisted(removal.as_ref(), "field", component.field_rules.iter().map(|r| ids::rule("field", &r.field_id)));
    let rows: Vec<_> = component
        .field_rules
        .iter()
        .map(|rule| {
            let errors = refused(removal.as_ref(), &ids::rule("field", &rule.field_id));
            field_rule_row(t, id, rule, editable, errors)
        })
        .collect();
    html! {
        {unlisted.form_message()}
        if component.field_rules.is_empty() {
            <Empty title={t.component_no_field_rules()} description="" />
        } else {
            <Table label={t.component_field_rules()} head={&head} all={None}>
                for row in rows {
                    {row}
                }
            </Table>
        }
    }
}

fn field_rule_row<'a>(t: Cat, id: &'a str, rule: &'a FieldRule, editable: bool, errors: Errors) -> impl Render + 'a {
    let key = ids::rule("field", &rule.field_id);
    let action = url::FieldRuleRemove { id, field_id: &rule.field_id }.href();
    let name = if rule.field_name.is_empty() { &rule.field_id } else { &rule.field_name };
    html! {
        <tr>
            <td>{name}</td>
            <td>{if rule.required { t.component_yes() } else { t.component_no() }}</td>
            <td>
                if editable {
                    <RemoveForm id={ids::RuleId(&key)} action={&action} label={t.component_remove()} errors={&errors} />
                }
            </td>
        </tr>
    }
}

fn dimension_rules<'a>(
    t: Cat,
    component: &'a ComponentDetail,
    editable: bool,
    removal: Option<(String, Errors)>,
) -> impl Render + 'a {
    let head = [t.component_dimension(), t.component_required_2(), t.component_allowed_options(), t.component_applies_when(), ""];
    let id = component.component_id.as_str();
    let unlisted = unlisted(
        removal.as_ref(),
        "dimension",
        component.dimension_rules.iter().map(|r| ids::rule("dimension", &r.dimension_id)),
    );
    let rows: Vec<_> = component
        .dimension_rules
        .iter()
        .map(|rule| {
            let errors = refused(removal.as_ref(), &ids::rule("dimension", &rule.dimension_id));
            dimension_rule_row(t, id, rule, editable, errors)
        })
        .collect();
    html! {
        {unlisted.form_message()}
        if component.dimension_rules.is_empty() {
            <Empty title={t.component_no_dimension_rules()} description="" />
        } else {
            <Table label={t.component_dimension_rules()} head={&head} all={None}>
                for row in rows {
                    {row}
                }
            </Table>
        }
    }
}

fn dimension_rule_row<'a>(t: Cat, id: &'a str, rule: &'a DimensionRule, editable: bool, errors: Errors) -> impl Render + 'a {
    let key = ids::rule("dimension", &rule.dimension_id);
    let action = url::DimensionRuleRemove { id, dimension_id: &rule.dimension_id }.href();
    let name = if rule.dimension_name.is_empty() { &rule.dimension_id } else { &rule.dimension_name };
    let allowed = if rule.allowed_options.is_empty() {
        t.component_all().to_owned()
    } else {
        rule.allowed_options.iter().map(|o| o.code.as_str()).collect::<Vec<_>>().join(", ")
    };
    html! {
        <tr>
            <td>{name}</td>
            <td>{if rule.required { t.component_yes_2() } else { t.component_no_2() }}</td>
            <td>{allowed}</td>
            <td>{applicability(t, &rule.applies_when)}</td>
            <td>
                if editable {
                    <RemoveForm id={ids::RuleId(&key)} action={&action} label={t.component_remove_2()} errors={&errors} />
                }
            </td>
        </tr>
    }
}
