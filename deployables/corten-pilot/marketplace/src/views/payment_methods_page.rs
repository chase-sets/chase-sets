//! The account's saved payment methods (Payments' `AccountPaymentMethodsRoute`): the heading
//! with Refresh and Add; what the last attempt did and what a setup saved; Add's secure step
//! (marketplace's `StripeSetupCard`) when Add has started a setup; then each payment method, a
//! card with its readiness, whether it is the default, its label, kind and when it changed, and
//! Set default and Remove; or, with none that is not removed, the empty state with Add; and Back to
//! Buy Cart. Each write is its own form with its attempt: an unconfirmed one holds the same attempt
//! and says Check again, one that needs a fresh page offers only Reload.
//!
//! One column on a phone, every control at least --control-height tall and the secure step's Save
//! as wide as the screen; from 40rem the cards are as many across as fit 18rem each, and the
//! heading's buttons sit beside its words from 48rem.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::account_home_page::humanized;
use crate::{
    api::{PaymentMethod, SetupSession},
    app::url,
    payment_methods::{AttemptState, FormKey, MethodInput, MethodsScreen, after_setup},
    text::PaymentMethodsMsg,
};

/// A payment method's kind (`paymentMethodCategoryLabel`): anything else is a card.
fn category(t: PaymentMethodsMsg, value: &str) -> &'static str {
    match value {
        "bank-account" => t.bank_account(),
        "platform-credit" => t.platform_credit(),
        _ => t.card(),
    }
}

/// A readiness's tone (`readinessTone`).
fn tone(value: &str) -> &'static str {
    match value {
        "ready" => "success",
        "removed" => "danger",
        "setup-required" => "warning",
        _ => "neutral",
    }
}

/// What an attempt's state says (`AttemptStatus`).
fn said(t: PaymentMethodsMsg, state: AttemptState) -> &'static str {
    match state {
        AttemptState::Succeeded => t.attempt_succeeded(),
        AttemptState::Refused => t.attempt_refused(),
        AttemptState::Unconfirmed => t.attempt_unconfirmed(),
        AttemptState::Conflict => t.attempt_conflict(),
        AttemptState::AccountChanged => t.attempt_account_changed(),
        AttemptState::ReauthRequired => t.attempt_reauth_required(),
    }
}

/// The page.
#[component(css)]
pub fn PaymentMethodsPage<'a>(t: PaymentMethodsMsg, screen: &'a MethodsScreen) -> impl Render {
    let empty = screen.active().next().is_none();
    let add = screen.outcome_of(&FormKey::Add);
    html! {
        <div class={Page}>
            <header class={Header}>
                <div class={Tight}>
                    <p class={Eyebrow}>{t.payments()}</p>
                    <h1 class={Title}>{t.saved_payment_methods()}</h1>
                    <p class={Muted}>{t.manage_payment_methods()}</p>
                </div>
                if screen.may_manage {
                    <div class={Actions}>
                        <form method="post" action={url::PaymentMethods::default()}>
                            <input type="hidden" name={MethodInput::FIELDS.intent} value="reconcile">
                            <button type="submit" class={Button} data-tone="secondary">{t.refresh()}</button>
                        </form>
                        <AttemptForm t={t} screen={screen} form={FormKey::Add} label={t.add()} tone="primary" />
                    </div>
                }
            </header>
            <div class={Status} role="status" aria-live="polite">
                if let Some(outcome) = add {
                    <p class={Said} data-tone={if outcome.state == AttemptState::Succeeded { "neutral" } else { "danger" }}>
                        {said(t, outcome.state)}
                    </p>
                }
                if let Some(failed) = screen.failed {
                    <div class={Banner} data-tone="danger" tabindex="-1" autofocus>
                        <p class={Strong}>{t.payment_method_update_failed()}</p>
                        if failed != t.payment_method_update_failed() {
                            <p>{failed}</p>
                        }
                    </div>
                }
                match screen.setup_result {
                    Some(crate::payment_methods::SetupResult::Saved) => {
                        <div class={Banner} data-tone="success" tabindex="-1" autofocus>
                            <p class={Strong}>{t.payment_method_saved()}</p>
                            <p>{t.payment_method_saved_description()}</p>
                        </div>
                    }
                    Some(crate::payment_methods::SetupResult::Pending) => {
                        <div class={Banner} data-tone="warning">
                            <p class={Strong}>{t.setup_pending()}</p>
                            <p>{t.setup_pending_description()}</p>
                        </div>
                    }
                    None => {}
                }
            </div>
            if let Some(setup) = &screen.setup {
                <PaymentSetup t={t} setup={setup} />
            }
            if empty {
                <section class={(Card, Empty)} aria-labelledby="payment-methods-empty">
                    <h2 id="payment-methods-empty" class={PartTitle}>{t.no_saved_payment_methods()}</h2>
                    <p class={Muted}>{t.no_saved_payment_methods_description()}</p>
                    if screen.may_manage {
                        <AttemptForm t={t} screen={screen} form={FormKey::Add} label={t.add_payment_method()} tone="primary" />
                    }
                </section>
            } else {
                <ul class={Grid}>
                    for method in &screen.methods {
                        <MethodCard t={t} screen={screen} method={method} />
                    }
                </ul>
            }
            <section class={Section} aria-labelledby="payment-methods-checkout">
                <h2 id="payment-methods-checkout" class={PartTitle}>{t.checkout()}</h2>
                <p><a class={Button} data-tone="secondary" href={url::Cart::default()}>{t.back_to_buy_cart()}</a></p>
            </section>
        </div>
    }
}

/// A payment method: its readiness and the default badge, its label, kind and when it changed,
/// and, unless it is removed, Set default (when it is not) and Remove, each with what its last
/// attempt did.
#[component(css = PaymentMethodsPage)]
fn MethodCard<'a>(t: PaymentMethodsMsg, screen: &'a MethodsScreen, method: &'a PaymentMethod) -> impl Render {
    let readiness = humanized(&method.readiness).unwrap_or_else(|| method.readiness.clone());
    let updated = parse_timestamp(&method.updated_at)
        .map_or_else(|| method.updated_at.clone(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string());
    let id = method.instrument_id.as_str();
    let (default, remove) = (FormKey::Default(id.to_owned()), FormKey::Remove(id.to_owned()));
    let statuses = [&default, &remove].into_iter().filter_map(|form| screen.outcome_of(form)).collect::<Vec<_>>();
    html! {
        <li class={Card} data-instrument={id}>
            <p class={Badges}>
                <span class={Badge} data-tone={tone(&method.readiness)}>{&readiness}</span>
                if method.is_default {
                    <span class={Badge} data-tone="accent">{t.default()}</span>
                }
            </p>
            <div class={Tight}>
                <h2 class={(PartTitle, Label)}>{&method.display_label}</h2>
                <p class={Muted}>{category(t, &method.payment_method_category)}</p>
                <p class={Muted}>{t.updated(&updated)}</p>
            </div>
            if method.readiness != "removed" && screen.may_manage {
                <div class={Controls}>
                    if !method.is_default {
                        <AttemptForm t={t} screen={screen} form={default.clone()} label={t.set_default()} tone="secondary" />
                    }
                    <AttemptForm t={t} screen={screen} form={remove.clone()} label={t.remove()} tone="danger" />
                </div>
                for outcome in &statuses {
                    <p
                        class={Said}
                        role="status"
                        data-tone={if outcome.state == AttemptState::Succeeded { "neutral" } else { "danger" }}
                    >
                        {said(t, outcome.state)}
                    </p>
                }
            }
        </li>
    }
}

/// One attempt's form (`AttemptForm`): a new attempt; the same one, saying Check again, after an
/// unconfirmed answer; only Reload after a conflict or a changed account, which draws new ones.
#[component(css = PaymentMethodsPage)]
fn AttemptForm<'a>(t: PaymentMethodsMsg, screen: &'a MethodsScreen, form: FormKey, label: &'a str, tone: &'a str) -> impl Render {
    let f = MethodInput::FIELDS;
    let outcome = screen.outcome_of(form);
    let state = outcome.map(|o| o.state);
    let (intent, instrument) = match &form {
        FormKey::Add => ("add", None),
        FormKey::Default(id) => ("default", Some(id.as_str())),
        FormKey::Remove(id) => ("remove", Some(id.as_str())),
    };
    html! {
        match state {
            Some(AttemptState::Conflict | AttemptState::AccountChanged | AttemptState::ReauthRequired) => {
                <a class={Button} data-tone="secondary" href={url::PaymentMethods::default()}>{t.reload()}</a>
            }
            _ => {
                <form class={Inline} method="post" action={url::PaymentMethods::default()}>
                    <input type="hidden" name={f.intent} value={intent}>
                    <input type="hidden" name={f.account_id} value={&screen.account_id}>
                    if let Some(id) = instrument {
                        <input type="hidden" name={f.instrument_id} value={id}>
                    }
                    match outcome.filter(|o| o.state == AttemptState::Unconfirmed) {
                        Some(unconfirmed) => {
                            <input type="hidden" name={f.attempt} value={&unconfirmed.attempt}>
                            <button type="submit" class={Button} data-tone={tone}>{t.check_again()}</button>
                        }
                        None => {
                            {SubmitKey::field(f.attempt)}
                            <button type="submit" class={Button} data-tone={tone}>{label}</button>
                        }
                    }
                </form>
            }
        }
    }
}

/// Add's secure step (`StripeSetupCard`): Stripe's fields, mounted by the script with the setup's
/// secret, and Save payment method (off until they are ready); a provider's own page is a link.
#[component(css = PaymentMethodsPage, js)]
pub fn PaymentSetup<'a>(t: PaymentMethodsMsg, setup: &'a SetupSession) -> impl Render {
    let stripe = setup.processor_client_secret.as_deref().zip(setup.processor_publishable_key.as_deref());
    let (fields, skeleton, error, error_text, processing, save) = refs();
    let parts = js::Parts { fields, skeleton, error, error_text, processing, save };
    let after = after_setup(setup);
    html! {
        <section class={Section} aria-labelledby="payment-setup-title">
            <h2 id="payment-setup-title" class={PartTitle}>{t.add_payment_method()}</h2>
            <div class={Card}>
                <p><span class={Badge} data-tone="accent">{t.step_secure_payment()}</span></p>
                <p>{t.manage_payment_methods()}</p>
                match stripe {
                    Some((secret, key)) => {
                        <div class={Provider} aria-busy="true">
                            <div ref={skeleton} class={Skeleton} aria-hidden="true"></div>
                            <div
                                ref={fields}
                                class={Fields}
                                on:connect={js::mount(target, parts, key, secret, t.step_stripe_could_not_load(), signal)}
                            ></div>
                        </div>
                        <noscript><p class={Muted}>{t.step_stripe_can_only_load_in_the()}</p></noscript>
                        <div ref={error} class={Banner} data-tone="danger" role="alert" hidden>
                            <p class={Strong}>{t.step_payment_issue()}</p>
                            <p ref={error_text}></p>
                        </div>
                        <div ref={processing} class={Banner} data-tone="info" role="status" hidden>
                            <p class={Strong}>{t.step_payment_in_progress()}</p>
                            <p>{t.step_the_payment_is_being_updated_by()}</p>
                        </div>
                        <button
                            ref={save}
                            type="button"
                            class={(Button, Wide)}
                            disabled
                            on:click={js::save(parts, &after, t.step_the_secure_processor_could_not_complete(), t.step_stripe_is_still_loading(), t.step_confirming_payment(), t.step_processing_payment())}
                        >
                            {t.save()}
                        </button>
                    }
                    None => {
                        if let Some(redirect) = &setup.processor_redirect_url {
                            <p><a class={(Button, Wide)} href={redirect.as_str()}>{t.step_continue_to_secure_checkout()}</a></p>
                        } else {
                            <div class={Banner} data-tone="danger" role="alert">
                                <p class={Strong}>{t.step_payment_issue()}</p>
                                <p>{t.step_stripe_could_not_load()}</p>
                            </div>
                        }
                    }
                }
            </div>
        </section>
    }
}
