use corten::prelude::*;

use super::StatusPill;
use crate::{
    catalog::{
        api::{Dimension, Field},
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
pub fn Search<'a>(t: Cat, title: &'a str, value: &'a str) -> impl Render {
    let placeholder = t.list_search_placeholder(title.to_lowercase()).to_string();
    html! {
        <label class={Filter}>
            <span class={Label}>{t.list_search()}</span>
            <input type="search" name="search" value={value} placeholder={&placeholder}>
        </label>
    }
}

/// A filter with a fixed set of values; `all` (the empty value) leaves it out.
#[component(css = ListPage)]
pub fn Pick<'a>(label: &'a str, name: &'a str, all: &'a str, options: &'a [(&'a str, &'a str)], value: &'a str) -> impl Render {
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

/// A table with these column headings.
#[component(css = ListPage)]
pub fn Table<'a, C: Render>(label: &'a str, head: &'a [&'a str], children: C) -> impl Render {
    html! {
        <div class={Scroll}>
            <table class={Table} aria-label={label}>
                <thead>
                    <tr>
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

/// A dimension's row.
#[component(css = ListPage)]
pub fn DimensionRow<'a>(t: Cat, row: &'a Dimension) -> impl Render {
    html! {
        <tr>
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

/// A field's row.
#[component(css = ListPage)]
pub fn FieldRow<'a>(t: Cat, row: &'a Field) -> impl Render {
    html! {
        <tr>
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
