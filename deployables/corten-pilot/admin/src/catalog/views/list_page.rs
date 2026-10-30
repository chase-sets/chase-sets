use corten::prelude::*;

use super::{SelectAll, SelectRow, StatusPill};
use crate::{
    catalog::{
        api::{Blueprint, Category, Component, Dimension, Field},
        blueprints::url as blueprints,
        categories::url as categories,
        components::url as components,
        form::display_order,
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
pub fn Search<'a>(t: Cat, name: FieldName, title: &'a str, value: &'a str) -> impl Render {
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
pub fn Pick<'a>(label: &'a str, name: FieldName, all: &'a str, options: &'a [(&'a str, &'a str)], value: &'a str) -> impl Render {
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
pub fn TextFilter<'a>(label: &'a str, name: FieldName, value: &'a str, placeholder: &'a str) -> impl Render {
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
