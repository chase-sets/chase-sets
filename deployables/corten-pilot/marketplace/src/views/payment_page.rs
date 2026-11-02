//! A buyer's payment (Payments' `AccountPaymentPage`, its `StripeConfirmationCard` and
//! `account-payment-display`): the header with Back to purchases, the payment summary (folded
//! above the page on a phone, beside it from 64rem), a failed or closed payment's notice with Retry
//! payment, the deadline while it waits, the secure payment step, the status, the event timeline,
//! staff's support details, the wallet's cover, and the purchases. A guest checkout's page has no
//! Back to purchases or Open purchase; its Retry payment is a form (see `payment`), and a paid
//! guest order offers Save this order, marketplace's page at the same address.
//!
//! The secure payment step is Stripe's: the step's script (`payment_entry.js`) loads Stripe.js,
//! mounts the payment fields in the step and turns Confirm payment on once they are ready; Confirm
//! is Stripe's confirm in the browser. Without a script the step says Stripe can only load in the
//! browser. On a phone Confirm payment is also in a bar at the bottom with the total.
//!
//! While the payment waits for the buyer, the page's watch (an empty part and its `ReadAgain`) reads
//! the status part (see `payment`), which redraws the page's content once the status changes.
use std::time::Duration;

use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::on_marketplace;
use crate::{
    api::{AccountPayment, PaymentOrder},
    app::url,
    payment::{PaymentScreen, RetryForm, WatchRoute},
    text::PaymentMsg,
};

// Stripe.js and the theme in Stripe's terms, which both secure steps' scripts import
// (`payment_entry.js` here, `payment_setup.js` on the saved payment methods page).
corten::script::script!(pub mod stripe = "stripe.js");

/// The page's content, which the status part redraws.
#[derive(Id)]
pub struct PaymentContentId;
/// The page's watch over the payment's status.
#[derive(Id)]
pub struct PaymentWatchId;

/// An amount the API sent, in the request's locale (`formatMoney`), or as sent when it is not money.
fn money(t: PaymentMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

/// A moment the API sent, in the request's locale (`formatPaymentTimestamp`): Unknown without one.
fn date_time(t: PaymentMsg, at: Option<&str>) -> String {
    match at.filter(|at| !at.is_empty()) {
        Some(at) => parse_timestamp(at)
            .map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string()),
        None => "Unknown".to_owned(),
    }
}

/// A payment's status, its description and its badge's tone (`paymentStatusCopy`, `statusTone`).
fn status_copy(t: PaymentMsg, status: &str) -> (&'static str, &'static str, &'static str) {
    match status {
        "pending-confirmation" => (t.ready_for_payment(), t.your_checkout_is_ready_confirm_payment(), "accent"),
        "captured" => (t.paid(), t.payment_is_complete_and_the_covered(), "success"),
        "failed" => (t.payment_needs_attention(), t.the_secure_processor_could_not_complete(), "danger"),
        "cancelled" => (t.payment_cancelled(), t.this_payment_session_is_closed_start(), "danger"),
        _ => (t.payment_in_progress(), t.the_payment_is_being_updated_by(), "accent"),
    }
}

/// What the provider told Payments, in the page's words (`providerEventLabel`).
fn provider_event(t: PaymentMsg, kind: &str) -> String {
    match kind {
        "payment-authorized" => t.provider_authorized_payment().to_owned(),
        "payment-captured" => t.provider_captured_payment().to_owned(),
        "payment-failed" => t.provider_reported_failure().to_owned(),
        "payment-cancelled" => t.provider_closed_payment_session().to_owned(),
        other => other.replace('-', " "),
    }
}

/// A label the catalog ends with `": "`, as a term.
fn term(label: &str) -> &str {
    label.trim_end_matches(": ")
}

/// The page (`AccountPaymentPage`): its content, which the status part redraws.
#[component(css)]
pub fn PaymentPage<'a>(t: PaymentMsg, screen: &'a PaymentScreen) -> impl Render {
    html! { <PaymentContent t={t} screen={screen} /> }
}

/// The page's content, a part of its own.
#[component(css = PaymentPage)]
pub fn PaymentContent<'a>(t: PaymentMsg, screen: &'a PaymentScreen) -> impl Patch {
    let payment = &screen.payment;
    let (label, says, tone) = status_copy(t, &payment.status);
    let total = money(t, &payment.amount, &payment.currency_code);
    let closed = matches!(payment.status.as_str(), "failed" | "cancelled");
    let deadline = if screen.pending() { screen.deadline() } else { None };
    let watching = screen.watch.as_ref().map(crate::payment::Watching::route);
    let retry = url::BuyerPaymentNew { place: crate::payment_start::StartPlace::of(&payment.order_ids) };
    let finished = if payment.captured_at.is_some() {
        (t.payment_captured(), "success", date_time(t, payment.captured_at.as_deref()))
    } else if payment.failed_at.is_some() {
        (t.payment_failed(), tone, date_time(t, payment.failed_at.as_deref()))
    } else if payment.cancelled_at.is_some() {
        (t.payment_cancelled_2(), tone, date_time(t, payment.cancelled_at.as_deref()))
    } else {
        (t.waiting_for_provider_event(), tone, payment.processor_status.clone())
    };
    html! {
        <div id={PaymentContentId} class={Page} data-payment={&payment.payment_id} data-status={&payment.status}>
            <header class={Header}>
                <div class={Tight}>
                    <p class={Eyebrow}>{t.secure_checkout()}</p>
                    <h1 class={Title}>{t.payment_title(&payment.payment_id)}</h1>
                    <p class={Muted}>{t.track_payment_state_purchase_coverage_marketplace()}</p>
                </div>
                if !screen.guest {
                    <a class={(Button, Secondary)} href={url::Purchases::default()}>{t.back_to_purchases()}</a>
                }
            </header>
            <details class={MobileSummary}>
                <summary class={MobileSummaryBar}>
                    <span class={Strong}>{t.payment_summary()}</span>
                    <span class={Muted}>{label}</span>
                    <span class={Amount}>{&total}</span>
                </summary>
                <Summary t={t} payment={payment} />
            </details>
            <div class={Flow}>
                <div class={Main}>
                    // Why Retry payment did not start one, even when the payment is no longer one to
                    // retry (a form drawn before it changed).
                    if let Some(error) = &screen.retry_error {
                        <div class={Banner} data-tone="danger" role="alert">
                            <p class={Strong}>{t.could_not_retry_payment()}</p>
                            <p>{error}</p>
                        </div>
                    }
                    if closed {
                        <div class={Banner} data-tone="warning" role="status">
                            <p class={Strong}>
                                {if payment.status == "cancelled" { t.payment_session_closed() } else { t.payment_issue() }}
                            </p>
                            <p>
                                {payment.failure_message.as_deref().unwrap_or(if payment.status == "cancelled" {
                                    t.this_secure_payment_session_is_no()
                                } else {
                                    t.the_secure_processor_could_not_complete()
                                })}
                            </p>
                        </div>
                        if screen.guest {
                            <form method="post" action={url::GuestPayment { id: &payment.payment_id, place: Default::default() }}>
                                <button type="submit" class={Button} name={RetryForm::FIELDS.intent} value="retry-payment">
                                    {t.retry_payment()}
                                </button>
                            </form>
                        } else {
                            <p><a class={Button} href={&retry}>{t.retry_payment()}</a></p>
                        }
                    }
                    if let Some(deadline) = deadline {
                        <div class={Banner} data-tone="info" role="status">
                            <p class={Strong}>{t.payment_deadline_title()}</p>
                            <p>{t.payment_deadline_description(&date_time(t, Some(deadline)))}</p>
                        </div>
                    }
                    if screen.pending() {
                        <PaymentEntry t={t} screen={screen} total={&total} />
                    }
                    <section class={Section} aria-labelledby="payment-status-title">
                        <h2 id="payment-status-title" class={PartTitle}>{t.payment_status()}</h2>
                        <div class={Card}>
                            <p><span class={Badge} data-tone={tone}>{label}</span></p>
                            <p>{says}</p>
                        </div>
                    </section>
                    if screen.guest && payment.status == "captured" {
                        <SaveOrder t={t} id={&payment.payment_id} />
                    }
                    <section class={Section} aria-labelledby="payment-timeline-title">
                        <h2 id="payment-timeline-title" class={PartTitle}>{t.event_timeline()}</h2>
                        <ol class={(Card, Timeline)}>
                            <li class={Step} data-tone="success">
                                <p class={Strong}>{t.payment_created()}</p>
                                <p class={Muted}>{date_time(t, Some(&payment.created_at))}</p>
                            </li>
                            for event in &payment.provider_events {
                                <li class={Step} data-tone="accent">
                                    <p class={Strong}>{provider_event(t, &event.event_kind)}</p>
                                    <p class={Muted}>{date_time(t, Some(&event.received_at))}</p>
                                </li>
                            }
                            <li class={Step} data-tone={finished.1}>
                                <p class={Strong}>{finished.0}</p>
                                <p class={Muted}>{&finished.2}</p>
                            </li>
                        </ol>
                    </section>
                    if screen.support_details {
                        <SupportDetails t={t} payment={payment} />
                    }
                    if !screen.pending() && payment.processor_amount == "0.00" {
                        <section class={Section} aria-labelledby="payment-wallet-title">
                            <h2 id="payment-wallet-title" class={PartTitle}>{t.wallet_balance()}</h2>
                            <div class={Card}>
                                <p><span class={Badge} data-tone="success">{t.paid_with_balance()}</span></p>
                                <p>{t.this_purchase_was_covered_by_available()}</p>
                            </div>
                        </section>
                    }
                    <section class={Section} aria-labelledby="payment-purchases-title">
                        <h2 id="payment-purchases-title" class={PartTitle}>{t.purchases()}</h2>
                        <ul class={Rows}>
                            for order in &screen.orders {
                                <Purchase t={t} order={order} currency={&payment.currency_code} guest={screen.guest} />
                            }
                        </ul>
                    </section>
                </div>
                <aside class={Aside} aria-label={t.payment_summary()}>
                    <Summary t={t} payment={payment} />
                </aside>
            </div>
            if let Some(from) = &watching {
                <PaymentWatch again={Some(from)} />
            }
        </div>
    }
}

/// The payment summary (`PriceBreakdown` and `OrderProtectionModule`).
#[component(css = PaymentPage)]
fn Summary<'a>(t: PaymentMsg, payment: &'a AccountPayment) -> impl Render {
    let (label, _, tone) = status_copy(t, &payment.status);
    let currency = payment.currency_code.as_str();
    let count = payment.order_ids.len();
    let purchases = if count == 1 { t.purchase_singular() } else { t.purchase_plural() };
    html! {
        <section class={(Card, SummaryCard)} aria-label={t.payment_summary()}>
            <dl class={Breakdown}>
                <div>
                    <dt>{t.status()}</dt>
                    <dd><span class={Badge} data-tone={tone}>{label}</span></dd>
                </div>
                <div>
                    <dt>{t.wallet_balance_used()}</dt>
                    <dd>{money(t, &payment.balance_credit_amount, currency)}</dd>
                </div>
                <div>
                    <dt>{t.external_payment()}</dt>
                    <dd>{money(t, &payment.processor_amount, currency)}</dd>
                </div>
                <div>
                    <dt>{t.marketplace_checkout_fee()}</dt>
                    <dd>{money(t, &payment.marketplace_checkout_fee_amount, currency)}</dd>
                </div>
                <div>
                    <dt>{t.payment_method()}</dt>
                    <dd>{payment.payment_method_category.as_deref().unwrap_or("card")}</dd>
                </div>
                <div>
                    <dt>{t.processor()}</dt>
                    <dd>{&payment.processor_name}</dd>
                </div>
                <div class={Total}>
                    <dt>{t.payment_summary()}</dt>
                    <dd>{money(t, &payment.amount, currency)}</dd>
                </div>
            </dl>
            <p class={Muted}>{t.secure_payment()}</p>
            <h3 class={Strong}>{t.checkout_confidence()}</h3>
            <ul class={Protections}>
                <li>
                    <p class={Strong}>{t.secure_payment_flow()}</p>
                    <p class={Muted}>{t.payment_details_stay_inside_the_secure()}</p>
                </li>
                <li>
                    <p class={Strong}>{t.purchase_coverage()}</p>
                    <p class={Muted}>{t.covers_purchases(&count.to_string(), purchases)}</p>
                </li>
                <li>
                    <p class={Strong}>{t.fee_transparency()}</p>
                    <p class={Muted}>{t.marketplace_and_processor_fees_stay_visible()}</p>
                </li>
            </ul>
        </section>
    }
}

/// The secure payment step (`StripeConfirmationCard`, or the provider's own page by address):
/// Stripe's fields, mounted by the script, Confirm payment (off until they are ready), and on a
/// phone the bar with the total and Confirm payment.
#[component(css = PaymentPage, js)]
pub fn PaymentEntry<'a>(t: PaymentMsg, screen: &'a PaymentScreen, total: &'a str) -> impl Render {
    let payment = &screen.payment;
    let stripe = payment.processor_client_secret.as_deref().zip(payment.processor_publishable_key.as_deref());
    let (fields, skeleton, error, error_text, processing) = refs();
    let parts = js::Parts { fields, skeleton, error, error_text, processing };
    let watch = screen.watch.as_ref().map_or("", |w| w.href.as_str());
    html! {
        <section class={Section} aria-labelledby="payment-entry-title" data-payment-entry>
            <h2 id="payment-entry-title" class={PartTitle}>{t.secure_payment_2()}</h2>
            match stripe {
                Some((secret, key)) => {
                    <div class={Card}>
                        <p><span class={Badge} data-tone="accent">{t.secure_payment()}</span></p>
                        <p>{t.payment_is_ready_enter_your_payment()}</p>
                        if let Some(defaults) = &screen.defaults {
                            <div class={Provider} aria-busy="true">
                                <div ref={skeleton} class={Skeleton} aria-hidden="true"></div>
                                <div
                                    ref={fields}
                                    class={Fields}
                                    on:connect={js::mount(target, parts, key, secret, defaults, t.stripe_could_not_load(), signal)}
                                ></div>
                            </div>
                            <noscript><p class={Muted}>{t.stripe_can_only_load_in_the()}</p></noscript>
                            <div ref={error} class={Banner} data-tone="danger" role="alert" hidden>
                                <p class={Strong}>{t.payment_issue()}</p>
                                <p ref={error_text}></p>
                            </div>
                            <div ref={processing} class={Banner} data-tone="info" role="status" hidden>
                                <p class={Strong}>{t.payment_in_progress()}</p>
                                <p>{t.the_payment_is_being_updated_by()}</p>
                            </div>
                            <button
                                type="button"
                                class={(Button, Wide)}
                                data-payment-confirm
                                disabled
                                on:click={js::confirm(scope, parts, watch, t.the_secure_processor_could_not_complete(), t.stripe_is_still_loading(), t.confirming_payment(), t.processing_payment())}
                            >
                                {t.confirm_payment()}
                            </button>
                            <div class={Bar} role="group" aria-label={t.payment_actions()}>
                                <p class={BarTotal}>
                                    <span class={Muted}>{t.total()}</span>
                                    <span class={Strong}>{total}</span>
                                </p>
                                <button
                                    type="button"
                                    class={(Button, Wide)}
                                    data-payment-confirm
                                    disabled
                                    on:click={js::confirm(scope, parts, watch, t.the_secure_processor_could_not_complete(), t.stripe_is_still_loading(), t.confirming_payment(), t.processing_payment())}
                                >
                                    {t.confirm_payment()}
                                </button>
                            </div>
                        } else {
                            <div class={Banner} data-tone="danger" role="alert">
                                <p class={Strong}>{t.payment_issue()}</p>
                                <p>{t.stripe_buyer_email_is_required()}</p>
                            </div>
                        }
                    </div>
                }
                None => {
                    if let Some(redirect) = &payment.processor_redirect_url {
                        <div class={Card}>
                            <p><span class={Badge} data-tone="accent">{t.secure_payment_3()}</span></p>
                            <p>{t.payment_is_ready_continue_to_the()}</p>
                            <p><a class={(Button, Wide)} href={redirect.as_str()}>{t.continue_to_secure_checkout()}</a></p>
                        </div>
                    } else {
                        <div class={Card}>
                            <p class={Muted}>{t.secure_payment_confirmation_is_not_configured()}</p>
                        </div>
                    }
                }
            }
        </section>
    }
}

/// Staff's view of the provider's side (`showSupportDetails`), folded unless the payment failed.
#[component(css = PaymentPage)]
fn SupportDetails<'a>(t: PaymentMsg, payment: &'a AccountPayment) -> impl Render {
    let count = payment.provider_events.len().to_string();
    html! {
        <section class={Section} aria-labelledby="payment-support-title">
            <h2 id="payment-support-title" class={PartTitle}>{t.support_details()}</h2>
            <details class={Fold} open={payment.failure_code.is_some()}>
                <summary>
                    <span class={Strong}>{t.support_details()}</span>
                    <span class={Muted}>{t.provider_events_status_summary(&count, &payment.processor_status)}</span>
                </summary>
                <dl class={Facts}>
                    <div>
                        <dt>{term(t.internal_payment())}</dt>
                        <dd>{&payment.payment_id}</dd>
                    </div>
                    <div>
                        <dt>{term(t.account())}</dt>
                        <dd>{&payment.buyer_account_id}</dd>
                    </div>
                    <div>
                        <dt>{term(t.processor_reference())}</dt>
                        <dd>{&payment.processor_payment_reference}</dd>
                    </div>
                    <div>
                        <dt>{term(t.processor_status())}</dt>
                        <dd>{&payment.processor_status}</dd>
                    </div>
                    <div>
                        <dt>{term(t.source())}</dt>
                        <dd>
                            {payment.source_context.as_deref().unwrap_or("direct")} " / "
                            {payment.source_reference_id.as_deref().unwrap_or("none")}
                        </dd>
                    </div>
                    <div>
                        <dt>{term(t.updated())}</dt>
                        <dd>{date_time(t, Some(&payment.updated_at))}</dd>
                    </div>
                    <div>
                        <dt>{term(t.provider_events())}</dt>
                        <dd>{&count}</dd>
                    </div>
                    for event in &payment.provider_events {
                        <div>
                            <dt>{term(t.provider_event())}</dt>
                            <dd>{&event.provider_event_id} ": " {provider_event(t, &event.event_kind)}</dd>
                        </div>
                    }
                    if let Some(code) = &payment.failure_code {
                        <div>
                            <dt>{term(t.failure_code())}</dt>
                            <dd>{code}</dd>
                        </div>
                    }
                </dl>
            </details>
        </section>
    }
}

/// One of the payment's purchases: its reference and status, its total, and Open purchase (the
/// pilot's purchase page).
#[component(css = PaymentPage)]
fn Purchase<'a>(t: PaymentMsg, order: &'a PaymentOrder, currency: &'a str, guest: bool) -> impl Render {
    html! {
        <li class={(Card, Line)}>
            <div class={Tight}>
                <p class={Strong}>{t.purchase()}{&order.order_id}</p>
                <p><span class={Badge} data-tone="accent">{&order.status}</span></p>
            </div>
            <div class={Tight}>
                <p class={Muted}>{t.total()}</p>
                <p class={Strong}>{money(t, &order.total_amount, currency)}</p>
            </div>
            if !guest {
                <p>
                    <a class={(Button, Secondary)} href={url::Purchase { id: &order.order_id, after: Default::default() }}>
                        {t.open_purchase()}
                    </a>
                </p>
            }
        </li>
    }
}

/// The status part while the status is unchanged: the watch, empty, and while it has time left a
/// read of the part again in two seconds.
#[component]
pub fn PaymentWatch<'a>(again: Option<&'a WatchRoute<'a>>) -> impl Patch {
    let read = ReadAgain { after: Duration::from_secs(2) };
    html! {
        <p id={PaymentWatchId} hidden></p>
        match again {
            Some(WatchRoute::Account(from)) => { {read.from(from)} }
            Some(WatchRoute::Guest(from)) => { {read.from(from)} }
            None => {}
        }
    }
}

/// A paid guest order's Save this order (`GuestClaimPrompt`): marketplace's page at the same
/// address, which saves it with a passkey or an emailed claim link (see `payment`).
#[component(css = PaymentPage)]
fn SaveOrder<'a>(t: PaymentMsg, id: &'a str) -> impl Render {
    let save = on_marketplace(&url::GuestPayment { id, place: Default::default() }.href());
    html! {
        <section class={Section} aria-labelledby="payment-save-title">
            <h2 id="payment-save-title" class={PartTitle}>{t.save_this_order()}</h2>
            <div class={Card}>
                <p><span class={Badge} data-tone="accent">{t.recommended()}</span></p>
                <p class={Muted}>{t.save_this_order_after_payment_with_a_passkey()}</p>
                <p><a class={Button} href={&save}>{t.save_this_order()}</a></p>
            </div>
        </section>
    }
}

/// A payment the page cannot show: not found, or still being prepared.
#[component(css = PaymentPage)]
pub fn PaymentNotice(t: PaymentMsg, title: &'static str, says: &'static str, guest: bool) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <div class={Tight}>
                    <p class={Eyebrow}>{t.secure_checkout()}</p>
                    <h1 class={Title}>{title}</h1>
                </div>
                if !guest {
                    <a class={(Button, Secondary)} href={url::Purchases::default()}>{t.back_to_purchases()}</a>
                }
            </header>
            <div class={Banner} data-tone="info" role="status">
                <p class={Strong}>{title}</p>
                <p>{says}</p>
            </div>
        </div>
    }
}
