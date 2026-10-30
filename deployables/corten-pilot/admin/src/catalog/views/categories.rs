//! The categories list and a category's page (`CategoryListPage`, `CategoryDetailPage`), from the
//! area's shared parts: the list's filters, rows, bulk bar and create dialog, and the page's
//! values, status change and edit dialog.
use corten::prelude::*;

use super::{
    ActionBar, Bar, Bulk, BulkRows, CategoryForm, CategoryRow, DetailPage, Dialog, Draft, Empty, Filters, KeyValues,
    LifecycleForm, ListPage, ListScreen, Pager, Pick, Search, Table, TextFilter, Toasts, Transition, Trigger, bulk_dialogs, ids,
    pages_around, statuses, value,
};
use crate::{
    catalog::{
        api::Category,
        categories::url,
        form::{CategoryInput, display_order},
    },
    text::{Cat, Pilot},
};

/// The lifecycle actions the list's bulk bar offers (`lifecycleActions`): a category is
/// published, not activated.
pub fn category_actions(t: Cat) -> [(&'static str, &'static str); 3] {
    [("publish", t.category_publish()), ("deprecate", t.category_deprecate()), ("archive", t.category_archive())]
}

/// The transitions a category's status allows (`getTransitions`).
pub fn category_transitions(t: Cat, status: &str) -> Vec<Transition> {
    match status {
        "draft" => vec![Transition { action: "publish", label: t.category_publish(), confirm: false }],
        "active" => vec![Transition { action: "deprecate", label: t.category_deprecate(), confirm: true }],
        "deprecated" => vec![Transition { action: "archive", label: t.category_archive(), confirm: true }],
        _ => Vec::new(),
    }
}

/// A category page's forms that came back from a submit, drawn in their open dialog.
#[derive(Default)]
pub struct CategoryForms {
    pub edit: Option<Draft<CategoryInput>>,
    pub lifecycle: Option<Errors>,
}

/// The list, its filters (search, status, hierarchy and parent id), and the create dialog.
pub fn category_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::CategoryQuery,
    screen: &'a ListScreen<Category>,
    create: Option<Draft<CategoryInput>>,
    notice: Option<String>,
    bulk: Bulk<'a>,
) -> impl Render + 'a {
    let open = create.is_some();
    let create = create.unwrap_or_else(|| Draft::new(CategoryInput::blank()));
    let title = t.category_list_categories();
    let create_action = url::Categories::of(query).href();
    let live = url::CategoriesLive { query: query.clone() }.href();
    let filters = url::Categories::default().href();
    let states = statuses(t);
    let hierarchies = [("root", t.category_list_root_categories()), ("child", t.category_list_child_categories())];
    let f = url::CategoryQuery::FIELDS;
    html! {
        <ListPage title={title}>
            <Trigger dialog={ids::CREATE_DIALOG} label={t.category_list_new_category()} secondary={false} />
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
                label={t.category_list_hierarchy()}
                name={f.hierarchy}
                all={t.list_all()}
                options={&hierarchies}
                value={value(&query.hierarchy)}
            />
            <TextFilter
                label={t.category_list_parent_category_id_optional()}
                name={f.parent_category_id}
                value={value(&query.parent_category_id)}
                placeholder=""
            />
        </Filters>
        <corten-live src={&live}>{category_rows(t, p, query, screen, bulk.manage)}</corten-live>
        <Dialog
            id={ids::CREATE_DIALOG}
            title={t.category_list_create_category()}
            description={None}
            open={open}
            close={p.catalog_close()}
        >
            <CategoryForm t={t} id={ids::CREATE} action={&create_action} create form={&create} />
        </Dialog>
        {bulk_dialogs(t, p, bulk.preview, bulk.job)}
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

/// The list's rows and pager, by `ids::ROWS` (see `dimension_rows`).
pub fn category_rows<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::CategoryQuery,
    screen: &'a ListScreen<Category>,
    manage: bool,
) -> impl Render + 'a {
    let title = t.category_list_categories();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if query.filtered() {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.category_category().to_lowercase()).to_string()
    };
    let head = [
        t.category_list_key(),
        t.category_list_name(),
        t.category_list_parent(),
        t.category_list_order(),
        t.category_list_status(),
        "",
    ];
    let (previous, next) = pages_around(screen, |page| {
        url::Categories::of(&url::CategoryQuery { page: (page > 1).then_some(page), ..query.clone() }).href()
    });
    let preview = url::CategoriesBulk { query: query.clone() }.href();
    let actions = category_actions(t);
    let select = manage.then_some(p);
    html! {
        let body = html! {
            if screen.items.is_empty() {
                <Empty title={&empty_title} description={&empty_description} />
            } else {
                <Table label={title} head={&head} all={select}>
                    for row in &screen.items {
                        <CategoryRow t={t} row={row} select={select} />
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

/// A category: its values, its status change, and its edit dialog (not for an archived one).
pub fn category_page<'a>(
    t: Cat,
    p: Pilot,
    category: &'a Category,
    notice: Option<String>,
    forms: CategoryForms,
) -> impl Render + 'a {
    let CategoryForms { edit, lifecycle } = forms;
    let id = category.category_id.as_str();
    let editable = category.status != "archived";
    let edit_open = edit.is_some();
    let edit = edit.unwrap_or_else(|| Draft::new(CategoryInput::of(category)));
    let lifecycle = lifecycle.unwrap_or_default();
    let steps = category_transitions(t, &category.status);
    let parent = category.parent_category.as_ref().map_or_else(|| t.category_none_root().to_owned(), |c| c.name.clone());
    let items = [
        (t.category_key(), category.key.clone()),
        (t.category_name(), category.name.clone()),
        (t.category_description(), category.description.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "\u{2014}".into())),
        (t.category_parent_category(), parent),
        (t.category_display_order(), display_order(category.display_order)),
        (t.category_status(), category.status.clone()),
        (t.category_updated(), category.updated_at.clone()),
    ];
    let list = url::Categories::default().href();
    let (edit_action, lifecycle_action) = (url::CategoryEdit { id }.href(), url::CategoryLifecycle { id }.href());
    html! {
        <DetailPage p={p} list={&list} list_label={t.category_categories()} name={&category.name}>
            <ActionBar>
                <LifecycleForm
                    t={t}
                    id={ids::LIFECYCLE}
                    action={&lifecycle_action}
                    status={&category.status}
                    transitions={&steps}
                    errors={&lifecycle}
                />
                if editable {
                    <Trigger dialog={ids::EDIT_DIALOG} label={t.category_edit()} secondary />
                }
            </ActionBar>
            <KeyValues items={&items} />
        </DetailPage>
        if editable {
            <Dialog
                id={ids::EDIT_DIALOG}
                title={t.category_edit_category()}
                description={None}
                open={edit_open}
                close={p.catalog_close()}
            >
                <CategoryForm t={t} id={ids::EDIT} action={&edit_action} create={false} form={&edit} />
            </Dialog>
        }
        <Toasts p={p} notice={notice.as_ref()} />
    }
}
