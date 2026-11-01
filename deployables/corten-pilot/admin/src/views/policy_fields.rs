use corten::{form::Within, prelude::*, view::Id};

use super::Draft;
use crate::{app::url, form::PolicyInput, text::Msg};

/// The create form's id: a submit that fails replaces it.
#[derive(Id, Clone, Copy)]
pub struct CreateFormId;

/// The revise form's id (the preview posts it too).
#[derive(Id, Clone, Copy)]
pub struct ReviseFormId;

/// How an input reads its value.
#[derive(Clone, Copy)]
pub enum Kind {
    Text,
    Number { min: f64, step: f64 },
}

fn shipping_options(t: Msg) -> [(&'static str, &'static str); 3] {
    [("standard", t.form_standard()), ("expedited", t.form_expedited()), ("priority", t.form_priority())]
}

fn physical_flags(t: Msg) -> [(&'static str, &'static str); 8] {
    [
        ("raw-card", t.form_raw_card()),
        ("slab", t.form_slab()),
        ("sealed", t.form_sealed()),
        ("rigid", t.form_rigid()),
        ("bendable", t.form_bendable()),
        ("metal", t.form_metal()),
        ("jumbo", t.form_jumbo()),
        ("irregular", t.form_irregular()),
    ]
}

/// A labelled input, its error next to it. The error is outside the label, so it is not part of
/// the input's name (it describes it).
#[component(css = PolicyFields)]
pub fn Field<'a, I: Id>(
    label: &'a str,
    name: FieldName<String>,
    value: &'a str,
    kind: Kind,
    required: bool,
    errors: &'a Within<'a, I>,
) -> impl Render {
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                match kind {
                    Kind::Text => {
                        <input type="text" name={name} value={value} required={required} {..errors.aria(name)}>
                    }
                    Kind::Number { min, step } => {
                        <input
                            type="number"
                            name={name}
                            value={value}
                            min={min}
                            step={step}
                            inputmode="decimal"
                            required={required}
                            {..errors.aria(name)}
                        >
                    }
                }
            </label>
            {errors.message(name)}
        </div>
    }
}

/// Checkboxes sharing a name, one per option.
#[component(css = PolicyFields)]
pub fn Choices<'a>(name: FieldName<String>, options: &'a [(&'a str, &'a str)], checked: &'a [String]) -> impl Render {
    html! {
        <div class={Choices}>
            for (value, label) in options {
                <label class={Choice}>
                    <input type="checkbox" name={name} value={*value} checked={checked.iter().any(|c| c == value)}>
                    {*label}
                </label>
            }
        </div>
    }
}

/// The label, the dates and the policy's rules: what the create and revise forms share.
#[component(css)]
pub fn PolicyFields<'a, I: Id + Copy>(t: Msg, form_id: I, form: &'a Draft<PolicyInput>) -> impl Render {
    let f = PolicyInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(form_id));
    let num = |min, step| Kind::Number { min, step };
    let shipping = shipping_options(t);
    let flags = physical_flags(t);
    html! {
        <div class={Fields}>
            <Field label={t.common_label()} name={f.label} value={&i.label} kind={Kind::Text} required errors={&e} />
            <Field
                label={t.common_effective_from()}
                name={f.effective_from}
                value={&i.effective_from}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.common_effective_until()}
                name={f.effective_until}
                value={&i.effective_until}
                kind={Kind::Text}
                required={false}
                errors={&e}
            />
            <Field
                label={t.form_policy_version()}
                name={f.policy_version}
                value={&i.policy_version}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <div class={Grid}>
                <Field
                    label={t.form_max_letter_units()}
                    name={f.max_letter_units}
                    value={&i.max_letter_units}
                    kind={num(1.0, 1.0)}
                    required
                    errors={&e}
                />
                <Field
                    label={t.form_max_letter_weight_oz()}
                    name={f.max_letter_weight_ounces}
                    value={&i.max_letter_weight_ounces}
                    kind={num(0.01, 0.01)}
                    required
                    errors={&e}
                />
                <Field
                    label={t.form_max_letter_thickness_in()}
                    name={f.max_letter_thickness_inches}
                    value={&i.max_letter_thickness_inches}
                    kind={num(0.01, 0.001)}
                    required
                    errors={&e}
                />
                <Field
                    label={t.form_max_letter_declared_value()}
                    name={f.max_letter_declared_value_amount}
                    value={&i.max_letter_declared_value_amount}
                    kind={num(0.0, 0.01)}
                    required
                    errors={&e}
                />
                <Field
                    label={t.form_letter_envelope_weight_oz()}
                    name={f.letter_envelope_weight_ounces}
                    value={&i.letter_envelope_weight_ounces}
                    kind={num(0.0, 0.01)}
                    required
                    errors={&e}
                />
                <Field
                    label={t.form_parcel_packaging_weight_oz()}
                    name={f.parcel_packaging_weight_ounces}
                    value={&i.parcel_packaging_weight_ounces}
                    kind={num(0.0, 0.01)}
                    required
                    errors={&e}
                />
                <Field
                    label={t.form_signature_declared_value()}
                    name={f.signature_required_declared_value_amount}
                    value={&i.signature_required_declared_value_amount}
                    kind={num(0.0, 0.01)}
                    required={false}
                    errors={&e}
                />
                <Field
                    label={t.form_insurance_declared_value()}
                    name={f.insurance_required_declared_value_amount}
                    value={&i.insurance_required_declared_value_amount}
                    kind={num(0.0, 0.01)}
                    required={false}
                    errors={&e}
                />
            </div>
            <fieldset class={Group}>
                <legend>{t.form_parcel_requirements()}</legend>
                <Choices
                    name={f.parcel_required_shipping_options}
                    options={&shipping}
                    checked={&i.parcel_required_shipping_options}
                />
                <Choices name={f.parcel_required_physical_flags} options={&flags} checked={&i.parcel_required_physical_flags} />
            </fieldset>
            <fieldset class={Group}>
                <legend>{t.form_letter_eligibility()}</legend>
                <Choices name={f.letter_required_physical_flags} options={&flags} checked={&i.letter_required_physical_flags} />
            </fieldset>
            <fieldset class={Group}>
                <legend>{t.form_signature_requirements()}</legend>
                <Choices
                    name={f.signature_required_shipping_options}
                    options={&shipping}
                    checked={&i.signature_required_shipping_options}
                />
                <Choices
                    name={f.signature_required_physical_flags}
                    options={&flags}
                    checked={&i.signature_required_physical_flags}
                />
            </fieldset>
        </div>
    }
}

/// A new draft.
#[component(css = PolicyFields)]
pub fn CreateForm<'a>(t: Msg, form: &'a Draft<PolicyInput>) -> impl Patch {
    html! {
        <form class={Form} id={CreateFormId} method="post" action={url::Policies::default()} data-patch>
            {form.errors.form_message()}
            <PolicyFields t={t} form_id={CreateFormId} form={form} />
            <div class={Actions}><button type="submit">{t.list_create_draft_action()}</button></div>
        </form>
    }
}

/// A revision of the policy, and a preview of the package plan it makes: the preview button
/// posts the same fields to the preview route (`formaction`), so it previews what is typed.
#[component(css = PolicyFields)]
pub fn ReviseForm<'a>(t: Msg, id: &'a str, form: &'a Draft<PolicyInput>) -> impl Patch {
    let f = PolicyInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(ReviseFormId));
    let num = |min, step| Kind::Number { min, step };
    let shipping = shipping_options(t);
    let flags: Vec<(&str, &str)> = physical_flags(t).into_iter().filter(|(value, _)| *value != "bendable").collect();
    html! {
        <form class={Form} id={ReviseFormId} method="post" action={url::Revise { id }} data-patch>
            {form.errors.form_message()}
            <PolicyFields t={t} form_id={ReviseFormId} form={form} />
            <div class={Actions}><button type="submit">{t.detail_save_revision()}</button></div>
            <fieldset class={Group}>
                <legend>{t.detail_preview()}</legend>
                <div class={Grid}>
                    <label class={Field}>
                        <span class={Label}>{t.detail_shipping_option()}</span>
                        <select name={f.preview_shipping_option}>
                            for (value, label) in &shipping {
                                <option value={*value} selected={i.preview_shipping_option == *value}>{*label}</option>
                            }
                        </select>
                    </label>
                    <Field
                        label={t.detail_item_subtotal()}
                        name={f.preview_item_subtotal_amount}
                        value={&i.preview_item_subtotal_amount}
                        kind={Kind::Text}
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.detail_quantity()}
                        name={f.preview_quantity}
                        value={&i.preview_quantity}
                        kind={num(1.0, 1.0)}
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.detail_unit_length_in()}
                        name={f.preview_unit_length_inches}
                        value={&i.preview_unit_length_inches}
                        kind={num(0.01, 0.01)}
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.detail_unit_width_in()}
                        name={f.preview_unit_width_inches}
                        value={&i.preview_unit_width_inches}
                        kind={num(0.01, 0.01)}
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.detail_unit_thickness_in()}
                        name={f.preview_unit_height_inches}
                        value={&i.preview_unit_height_inches}
                        kind={num(0.001, 0.001)}
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.detail_unit_weight_oz()}
                        name={f.preview_unit_weight_ounces}
                        value={&i.preview_unit_weight_ounces}
                        kind={num(0.001, 0.001)}
                        required
                        errors={&e}
                    />
                </div>
                <Choices name={f.preview_physical_flags} options={&flags} checked={&i.preview_physical_flags} />
                <div class={Actions}>
                    <button type="submit" class={Secondary} formaction={url::Preview { id }}>
                        {t.detail_preview_result_action()}
                    </button>
                </div>
            </fieldset>
        </form>
    }
}
