//! Checkout start (`CheckoutStartPage`, `CheckoutStartSummary`): the entry, what stops the cart,
//! a refused start's recovery, and Continue to checkout or Sign in (Register for an offer); then
//! the checkout's summary and what protects the buyer. One column on a phone, the summary below;
//! from 60rem the summary sits beside the page.
use corten::prelude::*;

use crate::{
    checkout_start::{Kind, Recovery, Said, Source, StartScreen, Who},
    text::CheckoutMsg,
};

fn money(t: CheckoutMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), corten::i18n::Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

fn quantity(q: f64) -> String {
    if q.fract() == 0.0 { format!("{}", q as u64) } else { q.to_string() }
}

/// The entry's price (`checkoutStartSourcePrice`).
fn price(t: CheckoutMsg, source: &Source) -> String {
    match source.price() {
        Some((amount, currency)) => money(t, amount, currency),
        None => t.start_price_confirmed_before_payment().to_owned(),
    }
}

fn title(t: CheckoutMsg, source: &Source) -> &str {
    if source.title().is_empty() { t.start_buy_now() } else { source.title() }
}

/// The page's title and description (`checkoutStartHeaderCopy`).
fn header(t: CheckoutMsg, screen: &StartScreen) -> (&'static str, &'static str) {
    let signed_in = screen.who == Who::Account;
    match (screen.offer(), signed_in) {
        (true, true) => (t.start_place_purchase_intent(), t.start_confirm_shipping_so_the_seller_can_review()),
        (true, false) => (t.start_register_to_place_purchase_intent(), t.start_register_or_sign_in_purchase_intent_copy()),
        (false, true) => (t.start_continue_checkout(), t.start_continue_with_your_account_so_purchases_payments()),
        (false, false) => (t.start_sign_in_or_continue_as_guest(), t.start_sign_in_to_keep_orders_with_your_account()),
    }
}

/// A recovery's words and its links (`checkoutRecoveryForKind`): (title, description, primary,
/// secondary), each link (href, label).
type Link = (String, &'static str);

fn recovery(t: CheckoutMsg, kind: Recovery, screen: &StartScreen) -> (&'static str, &'static str, Link, Option<Link>) {
    let browse = || ("/search".to_owned(), t.recovery_browse_marketplace());
    let cart = || ("/account/cart".to_owned(), t.recovery_view_buy_cart());
    let sign_in = || (screen.sign_in.clone(), t.route_sign_in_to_continue());
    match kind {
        Recovery::Closed => (t.recovery_checkout_closed(), t.recovery_checkout_closed_description(), cart(), None),
        Recovery::AttemptChanged => (
            t.recovery_checkout_attempt_changed(),
            t.recovery_checkout_attempt_changed_description(),
            (screen.here.clone(), t.recovery_refresh_checkout()),
            Some(cart()),
        ),
        Recovery::AccessRequired => {
            (t.route_checkout_access_required(), t.route_checkout_access_required_description(), browse(), Some(sign_in()))
        }
        Recovery::CartEmpty => (t.recovery_buy_cart_empty(), t.recovery_buy_cart_empty_description(), cart(), Some(browse())),
        Recovery::Preparing => (
            t.recovery_checkout_preparing(),
            t.recovery_checkout_preparing_description(),
            (screen.here.clone(), t.recovery_refresh_checkout()),
            Some(browse()),
        ),
        Recovery::GuestExpired => (
            t.route_guest_checkout_access_expired(),
            t.route_guest_checkout_access_expired_description(),
            browse(),
            Some(sign_in()),
        ),
        Recovery::Validation => {
            (t.recovery_checkout_needs_attention(), t.recovery_checkout_needs_attention_description(), cart(), Some(browse()))
        }
        Recovery::NotFound => {
            (t.route_checkout_session_not_found(), t.route_checkout_session_not_found_description(), browse(), Some(sign_in()))
        }
        Recovery::WrongAccount => (
            t.route_checkout_belongs_to_another_account(),
            t.route_checkout_belongs_to_another_account_description(),
            sign_in(),
            Some(browse()),
        ),
    }
}

/// The checkout start page.
#[component(css)]
pub fn CheckoutStartPage<'a>(t: CheckoutMsg, screen: &'a StartScreen) -> impl Render {
    let (heading, description) = header(t, screen);
    let source = screen.source.as_ref();
    let cart_review = screen.who == Who::Account && source.is_none() && screen.cart.as_ref().is_some_and(|c| !c.ready);
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.start_secure_checkout()}</p>
                <h1 class={Title}>{heading}</h1>
                <p class={Muted}>{description}</p>
            </header>
            <div class={Flow}>
                <div class={Main}>
                    if let Some(source) = source {
                        <EntrySummary t={t} source={source} />
                    }
                    if cart_review {
                        <div class={Banner} data-tone="warning" role="status">
                            <p class={Strong}>{t.start_cart_needs_review()}</p>
                            <p>
                                {screen.cart.as_ref().and_then(|c| c.fact.as_deref()).unwrap_or(t.start_cart_needs_review_description())}
                            </p>
                            <p class={Row}><a class={(Button, Secondary)} href="/account/cart">{t.start_review_buy_cart()}</a></p>
                        </div>
                    }
                    match screen.said {
                        Some(Said::Recovery(kind)) => {
                            <RecoveryBanner t={t} kind={kind} screen={screen} />
                        }
                        Some(Said::EntryAmbiguous) => {
                            <section class={Banner} data-tone="warning" aria-labelledby="checkout-start-entry-result">
                                <h2 class={Strong} id="checkout-start-entry-result">{t.start_entry_ambiguous_title()}</h2>
                                <p role="status">{t.start_entry_ambiguous_description()}</p>
                                <p class={Row}>
                                    <a class={(Button, Secondary)} href="/account/cart">{t.start_review_buy_cart()}</a>
                                </p>
                            </section>
                        }
                        Some(Said::SignInRequired) => {
                            <div class={Banner} data-tone="warning" role="alert">
                                <p class={Strong}>{t.start_sign_in_required()}</p>
                                <p>{t.start_register_or_sign_in_to_place_purchase_intent()}</p>
                                <p class={Row}><a class={(Button, Secondary)} href={&screen.sign_in}>{t.start_sign_in()}</a></p>
                            </div>
                        }
                        None => {}
                    }
                    if screen.can_continue() {
                        <section class={Card} aria-labelledby="start-continue">
                            <h2 id="start-continue" class={PartTitle}>
                                if screen.who == Who::Guest {
                                    {t.start_guest_checkout_active()}
                                } else {
                                    {t.start_account_checkout()}
                                }
                            </h2>
                            <form class={Form} method="post" action={&screen.here}>
                                <p class={Muted}>
                                    if screen.who == Who::Guest {
                                        {t.start_continue_with_guest_checkout()}
                                    } else {
                                        {t.start_continue_with_your_account_any_saved_guest()}
                                    }
                                </p>
                                <input type="hidden" name="entryAttemptKey" value={&screen.entry_key}>
                                match source {
                                    Some(source) => {
                                        for (name, value) in source.fields() {
                                            <input type="hidden" name={name} value={value}>
                                        }
                                    }
                                    None => { <input type="hidden" name="source" value="cart"> }
                                }
                                <p class={Row}>
                                    <button type="submit" class={(Button, Large)} disabled={screen.entry_ambiguous()}>
                                        {t.start_continue_to_checkout()}
                                    </button>
                                </p>
                            </form>
                        </section>
                    } else if screen.offer() {
                        <section class={Card} aria-labelledby="start-register">
                            <h2 id="start-register" class={PartTitle}>{t.start_register_to_place_purchase_intent()}</h2>
                            <p class={Muted}>{t.start_registration_purchase_intent_copy()}</p>
                            <p class={Stack}>
                                <a class={(Button, Large)} href={&screen.register}>{t.start_register_with_passkey()}</a>
                                <a class={(Button, Secondary, Large)} href={&screen.sign_in}>{t.start_sign_in()}</a>
                            </p>
                        </section>
                    } else {
                        <section class={Card} aria-labelledby="start-account">
                            <h2 id="start-account" class={PartTitle}>{t.start_account()}</h2>
                            <p class={Muted}>{t.start_sign_in_to_keep_purchases_payments()}</p>
                            <p class={Stack}>
                                <a class={(Button, Secondary, Large)} href={&screen.sign_in}>{t.start_sign_in()}</a>
                            </p>
                        </section>
                    }
                </div>
                <Summary t={t} screen={screen} />
            </div>
        </div>
    }
}

#[component(css = CheckoutStartPage)]
fn RecoveryBanner<'a>(t: CheckoutMsg, kind: Recovery, screen: &'a StartScreen) -> impl Render {
    let (heading, words, (first_href, first_label), second) = recovery(t, kind, screen);
    html! {
        <div class={Banner} data-tone="warning" role="alert">
            <p class={Strong}>{heading}</p>
            <p>{words}</p>
            <p class={Row}>
                <a class={Button} href={first_href}>{first_label}</a>
                if let Some((href, label)) = second {
                    <a class={(Button, Secondary)} href={href}>{label}</a>
                }
            </p>
        </div>
    }
}

/// The entry (`CheckoutStartSourceSummary`, marketplace's `OrderIntentSummary`).
#[component(css = CheckoutStartPage)]
fn EntrySummary<'a>(t: CheckoutMsg, source: &'a Source) -> impl Render {
    let offer = source.kind == Kind::OfferIntent;
    html! {
        <section class={Card} aria-labelledby="start-entry">
            <h2 id="start-entry" class={PartTitle}>{title(t, source)}</h2>
            if let Some(subtitle) = source.subtitle() {
                <p class={Muted}>{subtitle}</p>
            }
            <dl class={Facts}>
                <div>
                    <dt>{t.start_price()}</dt>
                    <dd>{price(t, source)}</dd>
                </div>
                <div>
                    <dt>{t.start_quantity()}</dt>
                    <dd>{quantity(source.quantity())}</dd>
                </div>
                <div>
                    <dt>{t.start_seller()}</dt>
                    <dd>{source.seller().unwrap_or(t.start_marketplace_seller())}</dd>
                </div>
                <div>
                    <dt>{t.start_payment()}</dt>
                    <dd>if offer { {t.start_no_payment_today()} } else { {t.start_not_charged_yet()} }</dd>
                </div>
            </dl>
            <ul class={Notes} role="list">
                if offer {
                    <li>{t.start_waiting_for_seller_acceptance()}</li>
                    <li>{t.start_offer_submitted_after_registration()}</li>
                } else {
                    <li>{source.availability().unwrap_or(t.start_availability_confirmed_before_payment())}</li>
                    <li>{source.fulfillment().unwrap_or(t.start_fulfillment_confirmed_before_payment())}</li>
                }
                <li>{t.start_buyer_protection_included()}</li>
            </ul>
        </section>
    }
}

/// The checkout's summary and what protects the buyer (`CheckoutStartSummary`).
#[component(css = CheckoutStartPage)]
fn Summary<'a>(t: CheckoutMsg, screen: &'a StartScreen) -> impl Render {
    let source = screen.source.as_ref();
    let offer = screen.offer();
    let status = match &screen.cart {
        Some(cart) if source.is_none() && !cart.ready => t.start_needs_review(),
        _ => t.start_ready(),
    };
    let choice = match screen.who {
        Who::Guest => t.start_guest_checkout_active(),
        Who::Account => t.start_signed_in(),
        Who::Visitor if offer => t.start_register_or_sign_in(),
        Who::Visitor => t.start_sign_in_or_guest(),
    };
    let label = if screen.cart_count == 1 { t.start_item() } else { t.start_items() };
    let protection = if offer {
        [
            (t.start_transparent_next_step(), t.start_sellers_review_purchase_intent_before_payment()),
            (t.start_recoverable_checkout(), t.start_account_keeps_purchase_intent_traceable()),
            (t.start_protected_payment(), t.start_payment_collected_only_after_seller_accepts()),
        ]
    } else {
        [
            (t.start_transparent_next_step(), t.start_shipping_fees_and_final_totals_are_shown()),
            (t.start_recoverable_checkout(), t.start_guest_receipts_and_signed_in_order_history()),
            (t.start_protected_payment(), t.start_payment_begins_only_after_the_checkout_session()),
        ]
    };
    html! {
        <aside class={(Card, Aside)} aria-label={t.start_checkout_summary()}>
            <dl class={Lines}>
                match source {
                    Some(source) => {
                        <div>
                            <dt>{t.start_source()}</dt>
                            <dd>{title(t, source)}</dd>
                        </div>
                        <div>
                            <dt>{t.start_seller()}</dt>
                            <dd>{source.seller().unwrap_or(t.start_marketplace_seller())}</dd>
                        </div>
                        <div>
                            <dt>{t.start_price()}</dt>
                            <dd>{price(t, source)}</dd>
                        </div>
                        <div>
                            <dt>{t.start_quantity()}</dt>
                            <dd>{quantity(source.quantity())}</dd>
                        </div>
                    }
                    None => {
                        <div>
                            <dt>{t.start_cart()}</dt>
                            <dd>{t.start_item_count(screen.cart_count, label)}</dd>
                        </div>
                    }
                }
                <div>
                    <dt>{t.start_account_choice()}</dt>
                    <dd>{choice}</dd>
                </div>
                <div>
                    <dt>{t.start_payment()}</dt>
                    <dd>if offer { {t.start_no_payment_today()} } else { {t.start_not_charged_yet()} }</dd>
                </div>
                <div class={Total}>
                    <dt>{t.start_checkout_status()}</dt>
                    <dd>{status}</dd>
                </div>
            </dl>
            <p class={Muted}>if offer { {t.start_no_payment_today()} } else { {t.start_secure_payment()} }</p>
            <ul class={Protection} role="list">
                for (heading, words) in protection {
                    <li>
                        <p class={Strong}>{heading}</p>
                        <p class={Muted}>{words}</p>
                    </li>
                }
            </ul>
        </aside>
    }
}
