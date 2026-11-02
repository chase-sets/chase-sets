use corten::prelude::*;

use super::ids;
use crate::{
    catalog::form::BulkInput,
    text::{Cat, Pilot},
};

/// The bulk bar's part of a list's rows: what it changes, where it posts, and the action labels.
pub struct Bar<'a> {
    /// The plural name of the records (`Dimensions`).
    pub entity: &'a str,
    /// The preview's URL, with the list's filters.
    pub action: &'a str,
    /// Every record the filters match, on every page.
    pub total: u32,
    /// The actions it offers: value and label.
    pub actions: &'a [(&'a str, &'a str)],
}

/// A list's rows (`ids::ROWS`, what a change to the list draws again) for staff who may change
/// them, with the bulk bar above them. The rows' boxes and the select-all box belong to the
/// bar's form (`form="catalog-bulk"`), so it posts the checked ids without JavaScript, and
/// Clear Selection is the form's reset. With it, the script keeps the count, the select-all box
/// and the buttons in step with the boxes. It runs again when the rows are drawn again, so the
/// count follows a live change; a box the user checked keeps its mark through it.
///
/// The count's text for checked rows is the catalog's message, sent unfilled (`t.js()`), so the
/// script formats it in the page's locale.
///
/// `fields` are drawn after the action (what an action takes, such as the catalog items' tags)
/// and `more` after the preview buttons (another submit of the form, with its `formaction`).
/// A submit marked `data-requires="draft"` is enabled only while every checked row's box is
/// marked `data-status="draft"` (admin-web's Remove Drafts); without the script the server
/// checks it.
#[component(css, js)]
pub fn BulkRows<'a, F: Render, M: Render, C: Render>(
    t: Cat,
    p: Pilot,
    bar: Bar<'a>,
    fields: F,
    more: M,
    children: C,
) -> impl Patch {
    let (form, count, preview, clear) = refs();
    let f = BulkInput::FIELDS;
    let matching = t.bulk_matching(bar.total, bar.entity).to_string();
    let sel = js::Selection { form, count, preview, clear };
    html! {
        <div
            id={ids::ROWS}
            class={Rows}
            on:connect={js::drawn(sel, js::Count { matching: &matching, entity: bar.entity, selected: t.js().bulk_selected() })}
            on:change={js::changed(event, sel)}
            on:reset={js::cleared(event, sel)}
        >
            <form
                ref={form}
                id={ids::BULK}
                class={Bar}
                method="post"
                action={bar.action}
                data-patch
                aria-label={p.bulk_label()}
            >
                <output ref={count} class={Count}>{&matching}</output>
                <div class={Actions}>
                    <label class={Pick}>
                        <span class={Label}>{t.bulk_action()}</span>
                        <select name={f.action}>
                            for (value, label) in bar.actions {
                                <option value={*value}>{*label}</option>
                            }
                        </select>
                    </label>
                    {fields}
                    <button ref={preview} type="submit" class={Small} name={f.mode} value="ids">{t.bulk_preview()}</button>
                    <button type="submit" class={(Small, Secondary)} name={f.mode} value="filter">
                        {t.bulk_preview_matching()}
                    </button>
                    {more}
                    <button ref={clear} type="reset" class={(Small, Secondary)}>{t.bulk_clear_selection()}</button>
                </div>
            </form>
            {children}
        </div>
    }
}

/// The select-all box in a list's head, in the bulk form. Without JavaScript it is hidden (it
/// could do nothing); the bar's script shows it.
#[component(css = BulkRows)]
pub fn SelectAll(p: Pilot) -> impl Render {
    let f = BulkInput::FIELDS;
    html! {
        <input type="checkbox" class={Box} name={f.all} form={ids::BULK} aria-label={p.bulk_select_all()} hidden>
    }
}

/// A row's box, in the bulk form; `status`, the row's, for a submit that needs one.
#[component(css = BulkRows)]
pub fn SelectRow<'a>(p: Pilot, id: &'a str, status: Option<&'a str>) -> impl Render {
    let f = BulkInput::FIELDS;
    let label = p.bulk_select_row(id).to_string();
    html! {
        <input type="checkbox" class={Box} name={f.ids} value={id} form={ids::BULK} aria-label={&label} data-status={status}>
    }
}
