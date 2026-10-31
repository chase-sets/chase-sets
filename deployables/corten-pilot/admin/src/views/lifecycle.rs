use corten::prelude::*;

use super::{
    Draft,
    policy_fields::{Field, Kind},
};
use crate::{
    api::Policy,
    app::url,
    form::{ActivateInput, CloneInput, RetireInput},
    text::Msg,
};

#[derive(Id, Clone, Copy)]
pub struct ActivateFormId;

#[derive(Id, Clone, Copy)]
pub struct RetireFormId;

#[derive(Id, Clone, Copy)]
pub struct CloneFormId;

#[derive(Id)]
pub struct ActivateDialogId;

#[derive(Id)]
pub struct RetireDialogId;

/// Activate, retire and clone, side by side.
#[component(css)]
pub fn Lifecycle<'a>(
    t: Msg,
    policy: &'a Policy,
    activate: &'a Draft<ActivateInput>,
    retire: &'a Draft<RetireInput>,
    clone: &'a Draft<CloneInput>,
) -> impl Render {
    let id = policy.policy_id.as_str();
    let status = policy.status.as_str();
    html! {
        <div class={Lifecycle}>
            <ActivateForm t={t} id={id} enabled={status != "active" && status != "retired"} form={activate} />
            <RetireForm t={t} id={id} enabled={status != "retired"} form={retire} />
            <CloneForm t={t} id={id} form={clone} />
        </div>
    }
}

/// The reason and a button that asks before it activates (a `<dialog>` the button opens with
/// `command`, no script; its confirm button submits the form).
#[component(css = Lifecycle)]
pub fn ActivateForm<'a>(t: Msg, id: &'a str, enabled: bool, form: &'a Draft<ActivateInput>) -> impl Patch {
    let f = ActivateInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(ActivateFormId));
    let title = t.detail_activate_confirm_title(&i.label).to_string();
    html! {
        <form class={Card} id={ActivateFormId} method="post" action={url::Activate { id }} data-patch>
            {form.errors.form_message()}
            <input type="hidden" name={f.label} value={&i.label}>
            <Field
                label={t.detail_activation_reason_label()}
                name={f.activation_reason}
                value={&i.activation_reason}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <button type="button" command="show-modal" commandfor={ActivateDialogId} disabled={!enabled}>
                {t.detail_activate()}
            </button>
            <dialog class={Confirm} id={ActivateDialogId} aria-label={&title}>
                <h3>{&title}</h3>
                <p>{t.detail_activate_confirm_description()}</p>
                <div class={Buttons}>
                    <button type="button" class={Cancel} command="close" commandfor={ActivateDialogId}>
                        {t.detail_confirm_cancel()}
                    </button>
                    <button type="submit" class={Warning}>{t.detail_activate()}</button>
                </div>
            </dialog>
        </form>
    }
}

/// The reason and a button that asks before it retires.
#[component(css = Lifecycle)]
pub fn RetireForm<'a>(t: Msg, id: &'a str, enabled: bool, form: &'a Draft<RetireInput>) -> impl Patch {
    let f = RetireInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(RetireFormId));
    let title = t.detail_retire_confirm_title(&i.label).to_string();
    html! {
        <form class={Card} id={RetireFormId} method="post" action={url::Retire { id }} data-patch>
            {form.errors.form_message()}
            <input type="hidden" name={f.label} value={&i.label}>
            <Field
                label={t.detail_retirement_reason_label()}
                name={f.retirement_reason}
                value={&i.retirement_reason}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <button type="button" class={Danger} command="show-modal" commandfor={RetireDialogId} disabled={!enabled}>
                {t.detail_retire()}
            </button>
            <dialog class={Confirm} id={RetireDialogId} aria-label={&title}>
                <h3>{&title}</h3>
                <p>{t.detail_retire_confirm_description()}</p>
                <div class={Buttons}>
                    <button type="button" class={Cancel} command="close" commandfor={RetireDialogId}>
                        {t.detail_confirm_cancel()}
                    </button>
                    <button type="submit" class={Danger}>{t.detail_retire()}</button>
                </div>
            </dialog>
        </form>
    }
}

/// A rollback draft: a copy of the policy under a new label and dates.
#[component(css = Lifecycle)]
pub fn CloneForm<'a>(t: Msg, id: &'a str, form: &'a Draft<CloneInput>) -> impl Patch {
    let f = CloneInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(CloneFormId));
    html! {
        <form class={Card} id={CloneFormId} method="post" action={url::Clone { id }} data-patch>
            {form.errors.form_message()}
            <Field
                label={t.detail_draft_label()}
                name={f.clone_label}
                value={&i.clone_label}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.common_effective_from()}
                name={f.clone_effective_from}
                value={&i.clone_effective_from}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.common_effective_until()}
                name={f.clone_effective_until}
                value={&i.clone_effective_until}
                kind={Kind::Text}
                required={false}
                errors={&e}
            />
            <button type="submit" class={Cancel}>{t.detail_clone_rollback_draft()}</button>
        </form>
    }
}
