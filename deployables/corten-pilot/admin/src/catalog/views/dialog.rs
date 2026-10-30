use corten::{
    form::Within,
    prelude::*,
    view::{AttrValue, Id},
};
use corten_ui::{Toast, Toaster};

use crate::{
    catalog::form::{
        AttachInput, BlueprintInput, CategoryInput, ComponentInput, DimensionInput, DimensionRuleInput, DimensionRulesInput,
        FieldInput, FieldRuleInput, FieldRulesInput, OptionInput, OrderInput, ReorderInput, TemplateInput,
    },
    text::{Cat, Pilot},
    views::Draft,
};

/// A dialog around a form, opened by its [`Trigger`] (`command="show-modal"`, no script). It is
/// drawn `open` when its form came back (refused without JavaScript, or a label row added or
/// removed), or when it is an answer (a bulk preview, a bulk job), so it is in front of the user
/// either way; `corten_ui::dialog::modal` makes a dialog drawn open modal when it joins the page.
#[component(css)]
pub fn Dialog<'a, I: Id + AttrValue + Copy, C: Render>(
    id: I,
    title: &'a str,
    description: Option<&'a str>,
    open: bool,
    close: &'a str,
    children: C,
) -> impl Patch {
    let heading = super::id_with(&id, "-title");
    html! {
        <dialog class={Dialog} id={id} aria-labelledby={&heading} open={open} on:connect={corten_ui::dialog::modal(target)}>
            <header class={Head}>
                <h2 class={Title} id={&heading}>{title}</h2>
                <button type="button" class={(Small, Secondary)} command="close" commandfor={id}>{close}</button>
            </header>
            if let Some(description) = description {
                <p class={Description}>{description}</p>
            }
            {children}
        </dialog>
    }
}

/// The button that opens a dialog.
#[component(css = Dialog)]
pub fn Trigger<'a, I: Id + AttrValue + Copy>(dialog: I, label: &'a str, secondary: bool) -> impl Render {
    html! {
        if secondary {
            <button type="button" class={(Small, Secondary)} command="show-modal" commandfor={dialog}>{label}</button>
        } else {
            <button type="button" class={Small} command="show-modal" commandfor={dialog}>{label}</button>
        }
    }
}

/// A labelled text input, its error next to it. The error is outside the label, so it is not
/// part of the input's name (it describes it).
#[component(css = Dialog)]
pub fn Input<'a, I: Id>(label: &'a str, name: FieldName, value: &'a str, errors: &'a Within<'a, I>) -> impl Render {
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                <input type="text" name={name} value={value} {..errors.aria(name)}>
            </label>
            {errors.message(name)}
        </div>
    }
}

/// A labelled text area (three rows), its error next to it.
#[component(css = Dialog)]
pub fn TextArea<'a, I: Id>(label: &'a str, name: FieldName, value: &'a str, errors: &'a Within<'a, I>) -> impl Render {
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                <textarea name={name} rows="3" {..errors.aria(name)}>{value}</textarea>
            </label>
            {errors.message(name)}
        </div>
    }
}
/// A labelled select.
#[component(css = Dialog)]
pub fn Choice<'a, I: Id>(
    label: &'a str,
    name: FieldName,
    options: &'a [(&'a str, &'a str)],
    value: &'a str,
    errors: &'a Within<'a, I>,
) -> impl Render {
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                <select name={name} {..errors.aria(name)}>
                    for (option, text) in options {
                        <option value={*option} selected={*option == value}>{*text}</option>
                    }
                </select>
            </label>
            {errors.message(name)}
        </div>
    }
}

/// A labelled checkbox.
#[component(css = Dialog)]
pub fn Check<'a>(label: &'a str, name: FieldName, checked: bool) -> impl Render {
    html! {
        <label class={Check}>
            <input type="checkbox" name={name} checked={checked}>
            {label}
        </label>
    }
}

/// The value kinds a dimension takes, as the dimension pages list them.
pub fn value_kinds(t: Cat) -> [(&'static str, &'static str); 3] {
    [("unordered", t.dimension_unordered()), ("ordered", t.dimension_ordered()), ("numeric", t.dimension_numeric())]
}

/// The value types a field takes.
pub fn value_types(t: Cat) -> [(&'static str, &'static str); 7] {
    [
        ("string", t.field_string()),
        ("number", t.field_number()),
        ("boolean", t.field_boolean()),
        ("date", t.field_date()),
        ("json", t.field_json()),
        ("localized_text", t.field_localized_text()),
        ("reference", t.field_reference()),
    ]
}

/// A dimension's create form (with the id it was drawn with) or its edit form.
#[component(css = Dialog)]
pub fn DimensionForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    create: bool,
    form: &'a Draft<DimensionInput>,
) -> impl Patch {
    let f = DimensionInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    let kinds = value_kinds(t);
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if create {
                <input type="hidden" name={f.dimension_id} value={&i.dimension_id}>
            }
            <Input label={t.dimension_key()} name={f.key} value={&i.key} errors={&e} />
            <Input label={t.dimension_name()} name={f.name} value={&i.name} errors={&e} />
            <Input label={t.dimension_description()} name={f.description} value={&i.description} errors={&e} />
            <Choice label={t.dimension_value_kind()} name={f.value_kind} options={&kinds} value={&i.value_kind} errors={&e} />
            <div class={Footer}>
                <button type="submit">{if create { t.dimension_list_create() } else { t.dimension_save_3() }}</button>
            </div>
        </form>
    }
}

/// A field's create form or its configure form.
#[component(css = Dialog)]
pub fn FieldForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    create: bool,
    form: &'a Draft<FieldInput>,
) -> impl Patch {
    let f = FieldInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    let types = value_types(t);
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if create {
                <input type="hidden" name={f.field_id} value={&i.field_id}>
            }
            <Input label={t.field_key()} name={f.key} value={&i.key} errors={&e} />
            <Input label={t.field_name()} name={f.name} value={&i.name} errors={&e} />
            <Input label={t.field_description()} name={f.description} value={&i.description} errors={&e} />
            <Choice label={t.field_value_type()} name={f.value_type} options={&types} value={&i.value_type} errors={&e} />
            <div class={Checks}>
                <Check label={t.field_filterable()} name={f.filterable} checked={i.filterable} />
                <Check label={t.field_searchable()} name={f.searchable} checked={i.searchable} />
                <Check label={t.field_sortable()} name={f.sortable} checked={i.sortable} />
            </div>
            <div class={Footer}>
                <button type="submit">{if create { t.field_list_create() } else { t.field_save() }}</button>
            </div>
        </form>
    }
}

/// A category's create form or its edit form (`CategoryListPage`'s and `CategoryDetailPage`'s
/// dialogs): the parent is an id, optional on create.
#[component(css = Dialog)]
pub fn CategoryForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    create: bool,
    form: &'a Draft<CategoryInput>,
) -> impl Patch {
    let f = CategoryInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    let (parent, save) = if create {
        (t.category_list_parent_category_id_optional(), t.category_list_create())
    } else {
        (t.category_parent_category_id(), t.category_save())
    };
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if create {
                <input type="hidden" name={f.category_id} value={&i.category_id}>
            }
            <Input label={t.category_key()} name={f.key} value={&i.key} errors={&e} />
            <Input label={t.category_name()} name={f.name} value={&i.name} errors={&e} />
            <Input label={t.category_description()} name={f.description} value={&i.description} errors={&e} />
            <Input label={parent} name={f.parent_category_id} value={&i.parent_category_id} errors={&e} />
            <Input label={t.category_display_order()} name={f.display_order} value={&i.display_order} errors={&e} />
            <div class={Footer}>
                <button type="submit">{save}</button>
            </div>
        </form>
    }
}

/// A component's create form or its edit form (`ComponentListPage`'s and `ComponentDetailPage`'s
/// dialogs): its key, name and description.
#[component(css = Dialog)]
pub fn ComponentForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    create: bool,
    form: &'a Draft<ComponentInput>,
) -> impl Patch {
    let f = ComponentInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if create {
                <input type="hidden" name={f.component_id} value={&i.component_id}>
            }
            <Input label={t.component_key()} name={f.key} value={&i.key} errors={&e} />
            <Input label={t.component_name()} name={f.name} value={&i.name} errors={&e} />
            <Input label={t.component_description()} name={f.description} value={&i.description} errors={&e} />
            <div class={Footer}>
                <button type="submit">{if create { t.component_list_create() } else { t.component_save() }}</button>
            </div>
        </form>
    }
}

/// A component's Add Field Rule form: the field's id, typed as in admin-web, and Required.
#[component(css = Dialog)]
pub fn FieldRuleForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    form: &'a Draft<FieldRuleInput>,
) -> impl Patch {
    let f = FieldRuleInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <Input label={t.component_field_id()} name={f.field_id} value={&i.field_id} errors={&e} />
            <div class={Checks}>
                <Check label={t.component_required_3()} name={f.required} checked={i.required} />
            </div>
            <div class={Footer}>
                <button type="submit">{t.component_add()}</button>
            </div>
        </form>
    }
}

/// A component's Add Dimension Rule form: the dimension's id, Required, the option ids it
/// allows, and when it applies, typed as in admin-web.
#[component(css = Dialog)]
pub fn DimensionRuleForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    form: &'a Draft<DimensionRuleInput>,
) -> impl Patch {
    let f = DimensionRuleInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <Input label={t.component_dimension_id()} name={f.dimension_id} value={&i.dimension_id} errors={&e} />
            <div class={Checks}>
                <Check label={t.component_required_4()} name={f.required} checked={i.required} />
            </div>
            <Input
                label={t.component_allowed_option_ids_comma_separated_leave()}
                name={f.allowed_option_ids}
                value={&i.allowed_option_ids}
                errors={&e}
            />
            <Input
                label={t.component_applies_when_dimensionid_optionid_optionid_comma()}
                name={f.applies_when}
                value={&i.applies_when}
                errors={&e}
            />
            <div class={Footer}>
                <button type="submit">{t.component_add_2()}</button>
            </div>
        </form>
    }
}
/// What a display template targets (`targetKindOptions`).
pub fn target_kinds(t: Cat) -> [(&'static str, &'static str); 5] {
    [
        ("global", t.target_global()),
        ("blueprint", t.target_blueprint()),
        ("category", t.target_category()),
        ("reference-record", t.target_reference_record()),
        ("catalog-item", t.target_catalog_item()),
    ]
}

/// A display template's target as admin-web shows it (`formatTarget`): the kind, and the id
/// unless it is global.
pub fn format_target(t: Cat, kind: &str, id: Option<&str>) -> String {
    let label = target_kinds(t).into_iter().find(|(k, _)| *k == kind).map_or(kind, |(_, label)| label);
    if kind == "global" { label.to_owned() } else { format!("{label}: {}", id.unwrap_or("\u{2014}")) }
}

/// A display template's create form or its edit form. admin-web hides Target ID for a global
/// target; here the stylesheet does (`:has`), so it needs no script: a global target's id is
/// not sent either way.
#[component(css = Dialog)]
pub fn TemplateForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    create: bool,
    form: &'a Draft<TemplateInput>,
) -> impl Patch {
    let f = TemplateInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    let kinds = target_kinds(t);
    html! {
        <form class={(Form, Template)} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if create {
                <input type="hidden" name={f.display_template_id} value={&i.display_template_id}>
            }
            <Input label={t.template_key()} name={f.key} value={&i.key} errors={&e} />
            <Input label={t.template_name()} name={f.name} value={&i.name} errors={&e} />
            <Input label={t.template_description()} name={f.description} value={&i.description} errors={&e} />
            <Choice label={t.template_target_kind()} name={f.target_kind} options={&kinds} value={&i.target_kind} errors={&e} />
            <div class={TargetId}>
                <Input label={t.template_target_id()} name={f.target_id} value={&i.target_id} errors={&e} />
            </div>
            <Input label={t.template_priority()} name={f.priority} value={&i.priority} errors={&e} />
            <TextArea label={t.template_title_template()} name={f.title_template} value={&i.title_template} errors={&e} />
            <TextArea
                label={t.template_subtitle_template()}
                name={f.subtitle_template}
                value={&i.subtitle_template}
                errors={&e}
            />
            <div class={Footer}>
                <button type="submit">{if create { t.template_list_create() } else { t.template_save() }}</button>
            </div>
        </form>
    }
}
/// A blueprint's create form or its edit form.
#[component(css = Dialog)]
pub fn BlueprintForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    create: bool,
    form: &'a Draft<BlueprintInput>,
) -> impl Patch {
    let f = BlueprintInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            if create {
                <input type="hidden" name={f.blueprint_id} value={&i.blueprint_id}>
            }
            <Input label={t.blueprint_key()} name={f.key} value={&i.key} errors={&e} />
            <Input label={t.blueprint_name()} name={f.name} value={&i.name} errors={&e} />
            <Input label={t.blueprint_description()} name={f.description} value={&i.description} errors={&e} />
            <div class={Footer}>
                <button type="submit">{if create { t.blueprint_list_create() } else { t.blueprint_save() }}</button>
            </div>
        </form>
    }
}

/// A blueprint's Attach Component form: the component's id, typed as in admin-web.
#[component(css = Dialog)]
pub fn AttachForm<'a, I: Id + AttrValue + Copy>(t: Cat, id: I, action: &'a str, form: &'a Draft<AttachInput>) -> impl Patch {
    let f = AttachInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <Input label={t.blueprint_component_id()} name={f.component_id} value={&i.component_id} errors={&e} />
            <div class={Footer}>
                <button type="submit">{t.blueprint_attach()}</button>
            </div>
        </form>
    }
}

/// A blueprint's Set Product Resolution Rules form: the canonical dimension order as ids.
#[component(css = Dialog)]
pub fn OrderForm<'a, I: Id + AttrValue + Copy>(t: Cat, id: I, action: &'a str, form: &'a Draft<OrderInput>) -> impl Patch {
    let f = OrderInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <Input
                label={t.blueprint_canonical_dimension_order()}
                name={f.canonical_dimension_order}
                value={&i.canonical_dimension_order}
                errors={&e}
            />
            <div class={Footer}>
                <button type="submit">{t.blueprint_save_2()}</button>
            </div>
        </form>
    }
}

/// A blueprint's Set Field Rules form: a row per rule. Add Rule and Remove post the form back to
/// be drawn with a row more or less (nothing written); the hidden first button is the form's
/// default, so Enter saves.
#[component(css = Dialog)]
pub fn FieldRulesForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    form: &'a Draft<FieldRulesInput>,
) -> impl Patch {
    let f = FieldRulesInput::FIELDS;
    let rows = form.input.rows();
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            <button type="submit" class={Default} tabindex="-1" aria-hidden="true">{t.blueprint_save_3()}</button>
            {form.errors.form_message()}
            for (row, (field, required)) in rows.iter().enumerate() {
                <div class={(Row, RuleRow)}>
                    <label class={Field}>
                        <span class={Label}>{t.blueprint_field_id()}</span>
                        <input type="text" name={f.field_id} value={*field}>
                    </label>
                    <label class={Check}>
                        <input type="checkbox" name={f.required} value={row} checked={*required}>
                        {t.blueprint_required_3()}
                    </label>
                    <button type="submit" class={(Small, Danger)} name={f.rerow} value={row} formnovalidate>
                        {t.blueprint_remove()}
                    </button>
                </div>
            }
            <div>
                <button type="submit" class={(Small, Secondary)} name={f.rerow} value="add" formnovalidate>
                    {t.blueprint_add_rule()}
                </button>
            </div>
            <div class={Footer}>
                <button type="submit">{t.blueprint_save_3()}</button>
            </div>
        </form>
    }
}

/// A blueprint's Set Dimension Rules form: a row per rule, as [`FieldRulesForm`].
#[component(css = Dialog)]
pub fn DimensionRulesForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    form: &'a Draft<DimensionRulesInput>,
) -> impl Patch {
    let f = DimensionRulesInput::FIELDS;
    let rows = form.input.rows();
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            <button type="submit" class={Default} tabindex="-1" aria-hidden="true">{t.blueprint_save_4()}</button>
            {form.errors.form_message()}
            for (row, rule) in rows.iter().enumerate() {
                <fieldset class={Labels}>
                    <div class={(Row, RuleRow)}>
                        <label class={Field}>
                            <span class={Label}>{t.blueprint_dimension_id()}</span>
                            <input type="text" name={f.dimension_id} value={&rule.dimension_id}>
                        </label>
                        <label class={Check}>
                            <input type="checkbox" name={f.required} value={row} checked={rule.required}>
                            {t.blueprint_required_4()}
                        </label>
                        <button type="submit" class={(Small, Danger)} name={f.rerow} value={row} formnovalidate>
                            {t.blueprint_remove_2()}
                        </button>
                    </div>
                    <label class={Field}>
                        <span class={Label}>{t.blueprint_allowed_option_ids_comma_separated_leave()}</span>
                        <input type="text" name={f.allowed_option_ids} value={&rule.allowed_option_ids}>
                    </label>
                    <label class={Field}>
                        <span class={Label}>{t.blueprint_applies_when_dimensionid_optionid_optionid_comma()}</span>
                        <input type="text" name={f.applies_when} value={&rule.applies_when}>
                    </label>
                </fieldset>
            }
            <div>
                <button type="submit" class={(Small, Secondary)} name={f.rerow} value="add" formnovalidate>
                    {t.blueprint_add_rule_2()}
                </button>
            </div>
            <div class={Footer}>
                <button type="submit">{t.blueprint_save_4()}</button>
            </div>
        </form>
    }
}
/// An option's add or edit form: its code, a number, and its labels, one row per locale. Add
/// Label and Remove post the form back to be drawn with a row more or less (no script, nothing
/// written); the hidden first button is the form's default, so Enter in a field submits it
/// rather than removing the first row.
#[component(css = Dialog)]
pub fn OptionForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    add: bool,
    form: &'a Draft<OptionInput>,
) -> impl Patch {
    let f = OptionInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    let labels = i.labels();
    let submit = if add { t.dimension_add() } else { t.dimension_save() };
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            <button type="submit" class={Default} tabindex="-1" aria-hidden="true">{submit}</button>
            {form.errors.form_message()}
            if add {
                <input type="hidden" name={f.option_id} value={&i.option_id}>
            }
            <Input label={t.dimension_code()} name={f.code} value={&i.code} errors={&e} />
            <Input label={t.dimension_numeric_value_optional()} name={f.numeric_value} value={&i.numeric_value} errors={&e} />
            <fieldset class={Labels}>
                <legend>{t.dimension_labels()}</legend>
                for (row, (locale, value)) in labels.iter().enumerate() {
                    <div class={Row}>
                        <label class={Field}>
                            <span class={Label}>{t.dimension_locale()}</span>
                            <input type="text" name={f.label_locale} value={*locale}>
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.dimension_label()}</span>
                            <input type="text" name={f.label_value} value={*value}>
                        </label>
                        <button type="submit" class={(Small, Danger)} name={f.relabel} value={row} formnovalidate>
                            {t.dimension_remove()}
                        </button>
                    </div>
                }
                <div>
                    <button type="submit" class={(Small, Secondary)} name={f.relabel} value="add" formnovalidate>
                        {t.dimension_add_label()}
                    </button>
                </div>
            </fieldset>
            <div class={Footer}>
                <button type="submit">{submit}</button>
            </div>
        </form>
    }
}

/// The order of a dimension's options, as ids separated by commas.
#[component(css = Dialog)]
pub fn ReorderForm<'a, I: Id + AttrValue + Copy>(t: Cat, id: I, action: &'a str, form: &'a Draft<ReorderInput>) -> impl Patch {
    let f = ReorderInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Form} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <Input label={t.dimension_option_ids()} name={f.option_ids} value={&i.option_ids} errors={&e} />
            <div class={Footer}>
                <button type="submit">{t.dimension_save_2()}</button>
            </div>
        </form>
    }
}

/// What a write did, after the page it sent the browser to (admin-web's toasts): corten-ui's
/// toaster, its message gone after five seconds, placed at the corner of the page.
#[component(css = Dialog)]
pub fn Toasts<'a>(p: Pilot, notice: Option<&'a String>) -> impl Render {
    let close = p.catalog_close();
    let message = notice.map(|n| n as &dyn Render);
    html! {
        <div class={Toasts}>
            <Toaster close={&close} seconds={5} toast={Toast { message }} />
        </div>
    }
}
