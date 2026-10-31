use corten::{prelude::*, view::AttrValue};

use super::{
    Draft, StatusPill,
    dialog::{Dialog, OptionForm, Trigger},
    ids,
    list_page::{Empty, Table},
};
use crate::{
    catalog::{
        api::{DimensionDetail, DimensionOption},
        form::{ActionInput, OptionInput},
        url,
    },
    text::{Cat, Pilot},
};

/// A record's page: breadcrumbs back to its list, its name, and what follows.
#[component(css)]
pub fn DetailPage<'a, C: Render>(p: Pilot, list: &'a str, list_label: &'a str, name: &'a str, children: C) -> impl Render {
    html! {
        <nav class={Crumbs} aria-label={p.catalog_breadcrumbs()}>
            <ol>
                <li><a href={list}>{list_label}</a></li>
                <li aria-current="page">{name}</li>
            </ol>
        </nav>
        <h1 class={Title}>{name}</h1>
        {children}
    }
}

/// A row of actions.
#[component(css = DetailPage)]
pub fn ActionBar<C: Render>(children: C) -> impl Render {
    html! { <div class={ActionBar}>{children}</div> }
}

/// A record's values, as `KeyValueList` shows them.
#[component(css = DetailPage)]
pub fn KeyValues<'a>(items: &'a [(&'a str, String)]) -> impl Render {
    html! {
        <dl class={KeyValues}>
            for (key, value) in items {
                <div class={Pair}>
                    <dt>{*key}</dt>
                    <dd>{value}</dd>
                </div>
            }
        </dl>
    }
}

/// A titled part of the page (`PageSection`).
#[component(css = DetailPage)]
pub fn Part<'a, C: Render>(title: &'a str, description: &'a str, children: C) -> impl Render {
    html! {
        <section class={Part}>
            <h2 class={PartTitle}>{title}</h2>
            <p class={Muted}>{description}</p>
            {children}
        </section>
    }
}

/// A status change the record's status allows (`Transition` in lifecycle-controls.tsx).
#[derive(Clone, Copy)]
pub struct Transition {
    pub action: &'static str,
    pub label: &'static str,
    /// Asks first (deprecate, archive).
    pub confirm: bool,
}

/// The status and the changes it allows, as `LifecycleControls` draws them. Each button posts
/// its action; one that asks first opens a dialog whose button posts it.
#[component(css = DetailPage)]
pub fn LifecycleForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    status: &'a str,
    transitions: &'a [Transition],
    errors: &'a Errors,
) -> impl Patch {
    let f = ActionInput::FIELDS;
    html! {
        <form class={Lifecycle} id={id} method="post" action={action} data-patch>
            {errors.form_message()}
            <input type="hidden" name={f.status} value={status}>
            <StatusPill status={status} toned />
            for step in transitions {
                if step.confirm {
                    let dialog = super::id_with(&id, &format!("-{}", step.action));
                    let title = t.lifecycle_confirm_action_title(step.label).to_string();
                    <button type="button" class={(Small, Danger)} command="show-modal" commandfor={&dialog}>{step.label}</button>
                    <dialog class={Confirm} id={&dialog} aria-label={&title}>
                        <h3>{&title}</h3>
                        <p>{t.lifecycle_confirm_action_description(step.label.to_lowercase())}</p>
                        <div class={Buttons}>
                            <button type="button" class={(Small, Secondary)} command="close" commandfor={&dialog}>
                                {t.lifecycle_cancel()}
                            </button>
                            <button type="submit" class={(Small, Danger)} name={f.action} value={step.action}>
                                {step.label}
                            </button>
                        </div>
                    </dialog>
                } else {
                    <button type="submit" class={Small} name={f.action} value={step.action}>{step.label}</button>
                }
            }
        </form>
    }
}

/// An option's deprecate or reactivate button, as its status allows.
#[component(css = DetailPage)]
pub fn OptionLifecycleForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    status: &'a str,
    errors: &'a Errors,
) -> impl Patch {
    let f = ActionInput::FIELDS;
    html! {
        <form class={Inline} id={id} method="post" action={action} data-patch>
            {errors.form_message()}
            <input type="hidden" name={f.status} value={status}>
            if status == "active" {
                <button type="submit" class={(Small, Secondary)} name={f.action} value="deprecate">
                    {t.dimension_deprecate_2()}
                </button>
            }
            if status == "deprecated" {
                <button type="submit" class={(Small, Secondary)} name={f.action} value="reactivate">
                    {t.dimension_reactivate()}
                </button>
            }
        </form>
    }
}

/// A row's Remove button, its own form (a component's field or dimension rule), with the API's
/// refusal above it.
#[component(css = DetailPage)]
pub fn RemoveForm<'a, I: Id + AttrValue + Copy>(id: I, action: &'a str, label: &'a str, errors: &'a Errors) -> impl Patch {
    html! {
        <form class={Inline} id={id} method="post" action={action} data-patch>
            {errors.form_message()}
            <button type="submit" class={(Small, Danger)}>{label}</button>
        </form>
    }
}
/// The button that opens a dialog the server draws (a blueprint's Set dialogs): a `GET` answered
/// with the dialog (no script needed; without JavaScript it is the page with the dialog open).
/// `after_write` is the page's receipt, so what the dialog starts from includes the write the
/// page shows.
#[component(css = DetailPage)]
pub fn Opener<'a>(action: &'a str, after_write: Option<&'a str>, label: &'a str) -> impl Render {
    let f = crate::catalog::blueprints::url::Opened::FIELDS;
    html! {
        <form class={Inline} method="get" action={action} data-patch>
            if let Some(after_write) = after_write {
                <input type="hidden" name={f.after_write} value={after_write}>
            }
            <button type="submit" class={Small}>{label}</button>
        </form>
    }
}
/// A dimension's options: each row's values, its edit dialog and its status change.
#[component(css = DetailPage)]
pub fn OptionTable<'a>(
    t: Cat,
    p: Pilot,
    dimension: &'a DimensionDetail,
    editing: Option<&'a (String, Draft<OptionInput>)>,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let head = [
        t.dimension_code(),
        t.dimension_label(),
        t.dimension_numeric_value(),
        t.dimension_order(),
        t.dimension_status(),
        t.dimension_actions(),
    ];
    let label = p.catalog_options_label(&dimension.dimension.name).to_string();
    html! {
        if dimension.options.is_empty() {
            <Empty title={t.dimension_no_options()} description={t.dimension_add_an_option_to_this_dimension()} />
        } else {
            <Table label={&label} head={&head} all={None}>
                for option in &dimension.options {
                    <OptionRow t={t} p={p} dimension={dimension} option={option} editing={editing} refused={refused} />
                }
            </Table>
        }
    }
}

/// One option's row.
#[component(css = DetailPage)]
pub fn OptionRow<'a>(
    t: Cat,
    p: Pilot,
    dimension: &'a DimensionDetail,
    option: &'a DimensionOption,
    editing: Option<&'a (String, Draft<OptionInput>)>,
    refused: Option<&'a (String, Errors)>,
) -> impl Render {
    let id = dimension.dimension.dimension_id.as_str();
    let option_id = option.option_id.as_str();
    let came_back = editing.filter(|(of, _)| of == option_id).map(|(_, draft)| draft);
    let draft = came_back.cloned().unwrap_or_else(|| Draft::new(OptionInput::of(option)));
    let errors = refused.filter(|(of, _)| of == option_id).map(|(_, e)| e.clone()).unwrap_or_default();
    let edit = url::OptionEdit { id, option_id }.href();
    let lifecycle = url::OptionLifecycle { id, option_id }.href();
    let dialog = ids::option_dialog(option_id);
    let title = p.catalog_edit_option(&option.code).to_string();
    let dash = "\u{2014}";
    html! {
        <tr>
            <td>{&option.code}</td>
            <td>{if option.label.is_empty() { dash } else { &option.label }}</td>
            <td>{option.numeric_value.map(|n| n.to_string()).unwrap_or_else(|| dash.to_owned())}</td>
            <td>{option.display_order}</td>
            <td><StatusPill status={&option.status} toned={false} /></td>
            <td>
                <div class={RowActions}>
                    if dimension.dimension.status != "archived" {
                        <Trigger dialog={&dialog} label={t.dimension_edit_2()} secondary />
                        <Dialog
                            id={&dialog}
                            title={&title}
                            description={None}
                            open={came_back.is_some()}
                            close={p.catalog_close()}
                        >
                            <OptionForm t={t} id={&ids::option_form(option_id)} action={&edit} add={false} form={&draft} />
                        </Dialog>
                    }
                    <OptionLifecycleForm
                        t={t}
                        id={ids::option_lifecycle(option_id)}
                        action={&lifecycle}
                        status={&option.status}
                        errors={&errors}
                    />
                </div>
            </td>
        </tr>
    }
}
