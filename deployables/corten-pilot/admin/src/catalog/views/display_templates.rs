//! The display templates list and a display template's page (`DisplayTemplateListPage`,
//! `DisplayTemplateDetailPage`), from the area's shared parts: the list's filters (search,
//! status, target kind), rows and create dialog, and the page's values, status change and edit
//! dialog. admin-web offers no bulk changes here.
use corten::prelude::*;

use super::{
    ActionBar, DetailPage, Dialog, Draft, Empty, Filters, KeyValues, LifecycleForm, ListPage, ListScreen, Pager, Pick, Search,
    Table, TemplateForm, TemplateRow, Toasts, Transition, Trigger,
    dialog::{format_target, target_kinds},
    ids, pages_around, statuses, value,
};
use crate::{
    catalog::{api::DisplayTemplate, display_templates::url, form::TemplateInput},
    text::{Cat, Pilot},
};

/// The transitions a display template's status allows (`getTransitions`).
pub fn template_transitions(t: Cat, status: &str) -> Vec<Transition> {
    match status {
        "draft" => vec![Transition { action: "publish", label: t.template_publish(), confirm: false }],
        "active" => vec![Transition { action: "deprecate", label: t.template_deprecate(), confirm: true }],
        "deprecated" => vec![Transition { action: "archive", label: t.template_archive(), confirm: true }],
        _ => Vec::new(),
    }
}

/// A display template page's forms that came back from a submit, drawn in their open dialog.
#[derive(Default)]
pub struct TemplateForms {
    pub edit: Option<Draft<TemplateInput>>,
    pub lifecycle: Option<Errors>,
}

/// The list, its filters and the create dialog.
pub fn template_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::TemplateQuery,
    screen: &'a ListScreen<DisplayTemplate>,
    create: Option<Draft<TemplateInput>>,
    notice: Option<String>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(TemplateInput::blank()));
    let title = t.template_list_display_templates();
    let create_action = url::Templates::of(query).href();
    let live = url::TemplatesLive { query: query.clone() }.href();
    let filters = url::Templates::default().href();
    let states = statuses(t);
    let kinds = target_kinds(t);
    let f = url::TemplateQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.template_list_new_display_template()} secondary={false} />
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
                label={t.template_list_target_kind()}
                name={f.target_kind}
                all={t.template_list_all_target_kinds()}
                options={&kinds}
                value={value(&query.target_kind)}
            />
        </Filters>
        <corten-live src={&live}>{template_rows(t, p, query, screen)}</corten-live>
        <Dialog
            id={ids::CREATE_DIALOG}
            title={t.template_list_create_display_template()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <TemplateForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </Dialog>
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn template_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::TemplateQuery,
    screen: &'a ListScreen<DisplayTemplate>,
) -> impl Render + 'a {
    let title = t.template_list_display_templates();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.template_list_display_template()).to_string()
    };
    let head = [
        t.template_list_key(),
        t.template_list_name(),
        t.template_list_target(),
        t.template_list_priority(),
        t.template_list_title_template(),
        t.template_list_status(),
        "",
    ];
    let (previous, next) = pages_around(screen, |page| {
        url::Templates::of(&url::TemplateQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    html! {
        <div id={ids::ROWS}>
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={None}>
                    for row in &screen.items {
                        <TemplateRow t={t} row={row} />
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
        </div>
    }
}

/// A display template: its values, its status change and edit dialog (not for an archived one).
pub fn template_page<'a>(
    t: Cat,
    p: Pilot,
    template: &'a DisplayTemplate,
    notice: Option<String>,
    forms: TemplateForms,
) -> impl Render + 'a {
    let TemplateForms { edit, lifecycle } = forms;
    let id = template.display_template_id.as_str();
    let editable = template.status != "archived";
    let edit_open = edit.is_some();
    let edit = edit.unwrap_or_else(|| Draft::new(TemplateInput::of(template)));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = template_transitions(t, &template.status);
    let dash = || "\u{2014}".to_owned();
    let keys = template.required_field_keys().join(", ");
    let items = [
        (t.template_key(), template.key.clone()),
        (t.template_name(), template.name.clone()),
        (t.template_description(), template.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(dash)),
        (t.template_target(), format_target(t, &template.target_kind, template.target_id.as_deref())),
        (t.template_priority(), crate::catalog::form::display_order(template.priority)),
        (t.template_title_template(), template.title_template.clone()),
        (t.template_subtitle_template(), template.subtitle_template.clone().unwrap_or_else(dash)),
        (t.template_required_field_keys(), if keys.is_empty() { dash() } else { keys }),
        (t.template_status(), template.status.clone()),
        (t.template_updated(), template.updated_at.clone()),
    ];
    let list = url::Templates::default().href();
    let (edit_action, lifecycle_action) = (url::TemplateEdit { id }.href(), url::TemplateLifecycle { id }.href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.template_display_templates()} name={&template.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&template.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.template_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
        </DetailPage>
        if editable {
            <Dialog
                id={ids::EDIT_DIALOG}
                title={t.template_edit_display_template()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <TemplateForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </Dialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}
