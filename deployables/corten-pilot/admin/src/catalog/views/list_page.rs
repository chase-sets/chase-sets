use corten::prelude::*;

use super::{SelectAll, SelectRow, StatusPill, dialog::format_target};
use crate::{
    catalog::{
        api::{Blueprint, Category, Component, Dimension, DisplayTemplate, Field, ReferenceRecord, ReferenceType},
        blueprints::url as blueprints,
        categories::url as categories,
        components::url as components,
        display_templates::url as templates,
        form::display_order,
        reference_records::url as ref_records,
        reference_types::url as ref_types,
        url,
    },
    text::{Cat, Pilot},
};

/// A list page's title and its actions (the create button).
#[component(css)]
pub fn ListPage<'a, C: Render>(title: &'a str, children: C) -> impl Render {
    html! {
        <header class={Header}>
            <h1 class={Title}>{title}</h1>
            <div class={Actions}>{children}</div>
        </header>
    }
}

/// The filters: a form that loads the list again (a `GET`, so the address keeps the filters,
/// and the page goes back to the first, as admin-web's controls do).
#[component(css = ListPage)]
pub fn Filters<'a, C: Render>(t: Cat, action: &'a str, children: C) -> impl Render {
    html! {
        <form class={Filters} role="search" method="get" action={action} aria-label={t.list_filters()}>
            {children}
            <button type="submit" class={Apply}>{t.list_apply_filters()}</button>
        </form>
    }
}

/// The search box.
#[component(css = ListPage)]
pub fn Search<'a>(t: Cat, name: FieldName<String>, title: &'a str, value: &'a str) -> impl Render {
    let placeholder = t.list_search_placeholder(title.to_lowercase()).to_string();
    html! {
        <label class={Filter}>
            <span class={Label}>{t.list_search()}</span>
            <input type="search" name={name} value={value} placeholder={&placeholder}>
        </label>
    }
}

/// A filter with a fixed set of values; `all` (the empty value) leaves it out.
#[component(css = ListPage)]
pub fn Pick<'a>(
    label: &'a str,
    name: FieldName<String>,
    all: &'a str,
    options: &'a [(&'a str, &'a str)],
    value: &'a str,
) -> impl Render {
    html! {
        <label class={Filter}>
            <span class={Label}>{label}</span>
            <select name={name}>
                <option value="" selected={value.is_empty()}>{all}</option>
                for (option, text) in options {
                    <option value={*option} selected={*option == value}>{*text}</option>
                }
            </select>
        </label>
    }
}

/// A filter typed in (a source, an id, a tag).
#[component(css = ListPage)]
pub fn TextFilter<'a>(label: &'a str, name: FieldName<String>, value: &'a str, placeholder: &'a str) -> impl Render {
    html! {
        <label class={Filter}>
            <span class={Label}>{label}</span>
            <input type="text" name={name} value={value} placeholder={placeholder}>
        </label>
    }
}

/// Filters folded away until opened (admin-web's More filters); open when one of them is set.
#[component(css = ListPage)]
pub fn MoreFilters<C: Render>(t: Cat, open: bool, children: C) -> impl Render {
    html! {
        <details class={More} open={open}>
            <summary>{t.list_more_filters()}</summary>
            <div class={MoreGrid}>{children}</div>
        </details>
    }
}

/// A table with these column headings; with `all`, a first column whose head is the bulk
/// form's select-all box (each row then starts with its own box).
#[component(css = ListPage)]
pub fn Table<'a, C: Render>(label: &'a str, head: &'a [&'a str], all: Option<Pilot>, children: C) -> impl Render {
    html! {
        <div class={Scroll}>
            <table class={Table} aria-label={label}>
                <thead>
                    <tr>
                        if let Some(p) = all {
                            <th scope="col"><SelectAll p={p} /></th>
                        }
                        for heading in head {
                            <th scope="col">{*heading}</th>
                        }
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    }
}

/// A dimension's row; with `select`, its box in the bulk form first.
#[component(css = ListPage)]
pub fn DimensionRow<'a>(t: Cat, row: &'a Dimension, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.dimension_id} status={None} /></td>
            }
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td>{&row.value_kind}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={url::Dimension { id: &row.dimension_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A category's row: its key, name, parent (or a dash for a root category), display order and
/// status; with `select`, its box in the bulk form first.
#[component(css = ListPage)]
pub fn CategoryRow<'a>(t: Cat, row: &'a Category, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.category_id} status={None} /></td>
            }
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td>{row.parent_category.as_ref().map_or("\u{2014}", |parent| parent.name.as_str())}</td>
            <td class={Number}>{display_order(row.display_order)}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={categories::Category { id: &row.category_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A component's row: its key, name and status; with `select`, its box in the bulk form first.
#[component(css = ListPage)]
pub fn ComponentRow<'a>(t: Cat, row: &'a Component, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.component_id} status={None} /></td>
            }
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={components::Component { id: &row.component_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A reference type's row: its key, name, how many attribute keys it declares, and its status;
/// with `select`, its box in the bulk form first.
#[component(css = ListPage)]
pub fn RefTypeRow<'a>(t: Cat, row: &'a ReferenceType, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.reference_type_id} status={None} /></td>
            }
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td>{row.attribute_keys.len()}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={ref_types::RefType { id: &row.reference_type_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A reference record's row: its type, key, name and status; with `select`, its box in the bulk
/// form first.
#[component(css = ListPage)]
pub fn RefRecordRow<'a>(t: Cat, row: &'a ReferenceRecord, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.reference_record_id} status={None} /></td>
            }
            <td>{&row.type_key}</td>
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={ref_records::RefRecord { id: &row.reference_record_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A display template's row: its key, name, target, priority, title template and status (no
/// bulk changes in admin-web).
#[component(css = ListPage)]
pub fn TemplateRow<'a>(t: Cat, row: &'a DisplayTemplate) -> impl Render {
    html! {
        <tr>
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td>{format_target(t, &row.target_kind, row.target_id.as_deref())}</td>
            <td>{display_order(row.priority)}</td>
            <td>{&row.title_template}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={templates::Template { id: &row.display_template_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A blueprint's row: its key, name and status; with `select`, its box in the bulk form first.
#[component(css = ListPage)]
pub fn BlueprintRow<'a>(t: Cat, row: &'a Blueprint, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.blueprint_id} status={None} /></td>
            }
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={blueprints::Blueprint { id: &row.blueprint_id, after_write: None, done: None }}>
                    {t.list_view()}
                </a>
            </td>
        </tr>
    }
}

/// A field's row; with `select`, its box in the bulk form first.
#[component(css = ListPage)]
pub fn FieldRow<'a>(t: Cat, row: &'a Field, select: Option<Pilot>) -> impl Render {
    html! {
        <tr>
            if let Some(p) = select {
                <td><SelectRow p={p} id={&row.field_id} status={None} /></td>
            }
            <td>{&row.key}</td>
            <td>{&row.name}</td>
            <td>{&row.value_type}</td>
            <td><StatusPill status={&row.status} toned={false} /></td>
            <td>
                <a class={View} href={url::Field { id: &row.field_id, after_write: None, done: None }}>{t.list_view()}</a>
            </td>
        </tr>
    }
}

/// What a list or a table shows when it has no rows.
#[component(css = ListPage)]
pub fn Empty<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Empty}>
            <p class={EmptyTitle}>{title}</p>
            <p>{description}</p>
        </div>
    }
}

/// Previous and next pages, when the list has more than one.
#[component(css = ListPage)]
pub fn Pager<'a>(t: Cat, p: Pilot, page: u32, pages: u32, previous: Option<&'a str>, next: Option<&'a str>) -> impl Render {
    html! {
        if pages > 1 {
            <nav class={Pages} aria-label={p.pages_label()}>
                if let Some(href) = previous {
                    <a class={View} href={href} rel="prev">{t.list_previous()}</a>
                }
                <span>{p.pages_current(page, pages)}</span>
                if let Some(href) = next {
                    <a class={View} href={href} rel="next">{t.list_next()}</a>
                }
            </nav>
        }
    }
}
