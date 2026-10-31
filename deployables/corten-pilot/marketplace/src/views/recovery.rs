use corten::{prelude::*, view::AttrValue};

use crate::{
    auth::Viewer,
    recovery::{Check, Family, Status},
    text::Msg,
};

corten::script::script!(pub mod handlers = "recovery.js");

/// The status's id: a refused write's patch replaces it.
#[derive(Id)]
pub struct RecoveryId;

/// What the last write did, as marketplace's status line says it, and the controls of a write
/// the page could not confirm: check again (`again`, the page with the same check), or forget it
/// (with the script, which then loads `list`, the page without one).
#[component(css)]
pub fn Recovery<'a>(
    t: Msg,
    viewer: &'a Viewer,
    status: &'a Status,
    check: &'a Check,
    again: &'a str,
    list: &'a str,
) -> impl Patch {
    let (check_form, check_attempt, check_family, check_target, check_user) = refs();
    let f = Check::FIELDS;
    let account = viewer.actor.account_id.as_str();
    let text = match status {
        Status::Ready | Status::Refused(_) => t.recovery_editing(),
        Status::Confirmed(_) => t.recovery_succeeded(),
        Status::Uncertain(_) => t.recovery_ambiguous(),
        Status::Reauth(_) => t.recovery_reauth(),
    };
    let family = check.family.unwrap_or(Family::Create);
    let check = handlers::Check {
        form: check_form,
        attempt: check_attempt,
        family: check_family,
        target: check_target,
        user: check_user,
    };
    html! {
        <div
            id={RecoveryId}
            class={Recovery}
            on:connect={handlers::restore(check, account, status.settles().unwrap_or(""), status.unsettled().unwrap_or(""))}
        >
            <p class={Status} role="status" aria-live="polite" tabindex="-1" autofocus={status.announces()}>{text}</p>
            if status.unsettled().is_some() {
                <div class={Uncertain}>
                    <a class={Check} href={again}>{t.recovery_check()}</a>
                    <button
                        type="button"
                        class={Discard}
                        hidden
                        on:connect={handlers::reveal(target)}
                        on:click={handlers::discard(
                            account,
                            family.as_str(),
                            t.recovery_discard_confirmation(),
                            list,
                        )}
                    >
                        {t.recovery_discard()}
                    </button>
                </div>
            }
            <form ref={check_form} method="get" action={list} hidden>
                <input type="hidden" ref={check_attempt} name={f.attempt} value="">
                <input type="hidden" ref={check_family} name={f.family} value="">
                <input type="hidden" ref={check_target} name={f.target} value="">
                <input type="hidden" ref={check_user} name={f.user} value="">
            </form>
        </div>
    }
}

/// A write form: it carries the attempt the pilot issued, remembers it before it is sent (the
/// script), and is off while a write is uncertain.
#[component(css = Recovery)]
pub fn WriteForm<'a, I: Id + AttrValue, A: AttrValue, C: Render>(
    t: Msg,
    id: I,
    action: A,
    viewer: &'a Viewer,
    family: Family,
    target: &'a str,
    attempt: FieldName,
    errors: &'a Errors,
    enabled: bool,
    children: C,
) -> impl Patch {
    let unavailable = refs();
    let (account, user) = (viewer.actor.account_id.as_str(), viewer.actor.user_id.as_str());
    // `target` in a handler call is the event's target, so the record's id goes by another name.
    let record = target;
    html! {
        <form
            id={id}
            class={Write}
            method="post"
            action={action}
            data-patch
            on:submit={handlers::remember(event, account, user, family.as_str(), record, unavailable)}
        >
            {SubmitKey::field(attempt)}
            {errors.form_message()}
            <p ref={unavailable} class={Unavailable} role="alert" tabindex="-1" hidden>{t.recovery_failed_safe()}</p>
            <fieldset class={Controls} disabled={!enabled}>{children}</fieldset>
        </form>
    }
}

/// A message about the list (marketplace's tinted card).
#[component(css = Recovery)]
pub fn Notice<'a>(text: &'a str) -> impl Render {
    html! { <p class={Notice}>{text}</p> }
}
