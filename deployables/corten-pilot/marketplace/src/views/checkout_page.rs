//! The buy checkout page's parts, after marketplace's `CheckoutSessionPage`: the header, the steps
//! (`PageStepper`), what a write was refused for and the page's one notice, then the checkout form
//! (`checkout-confirmation-form`) with a row per ready step and a section per step still to fill
//! in, or the payment's panel once Pay now started it; the order summary beside the form from
//! 64rem and in a disclosure above it on a phone; and on a phone the bar with the total and Pay now
//! (`CheckoutStickyActionBar`), which the in-form row replaces from 48rem.
//!
//! The form works without a script: Pay now writes the review again first when anything changed
//! since the totals were drawn, and the page says so. The page's script only says it sooner: a
//! change to a delivery, shipping or payment field marks the page, whose stylesheet then shows
//! "Totals need refresh" and Update totals in place of Pay now (marketplace's `markReviewStale`).
//!
//! A purchase intent's page has no payment step, totals to refresh or notices: its summary prices
//! each line at the offer and says No payment today, and its one control is Submit offer.
use corten::{i18n::Currency, prelude::*, view::AttrValue};

use super::{cart_item::options, on_marketplace, order_page::display_reference};
use crate::{
    api::{FulfillmentPreview, SessionLine},
    app::url,
    checkout::{
        CheckoutForm, ConfirmationScreen, Edit, MANUAL, Notice, Place, Recovery, SHIPPING, Screen, signature, support_reference,
    },
    text::CheckoutMsg,
};

corten::script::script!(pub mod handlers = "checkout_page.js");

/// The checkout form, which the bar's Pay now also submits.
#[derive(Id, Clone, Copy)]
pub struct CheckoutFormId;

/// An amount in dollars (`formatMoney(.., "USD")`), or the amount as sent when it is not money.
fn money(t: CheckoutMsg, amount: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse("USD")) {
        (Some(value), Some(usd)) => t.money(value, usd).to_string(),
        _ => amount.to_owned(),
    }
}

/// An amount, or Pending (`formatMoneyOrPending`).
fn money_or_pending(t: CheckoutMsg, amount: Option<&str>) -> String {
    amount.filter(|a| !a.trim().is_empty()).map_or_else(|| t.page_pending().to_owned(), |a| money(t, a))
}

fn method_label(t: CheckoutMsg, method: &str) -> &'static str {
    match method {
        "bank-account" => t.page_bank_account(),
        "platform-credit" => t.page_platform_credit_only(),
        _ => t.page_card(),
    }
}

fn shipping_label(t: CheckoutMsg, option: &str) -> &'static str {
    match option {
        "expedited" => t.page_expedited(),
        "priority" => t.page_priority(),
        _ => t.page_standard_insured(),
    }
}

/// The first seller's delivery estimate in words (`delivery.estimate.summary`).
fn estimate(t: CheckoutMsg, screen: &Screen) -> Option<String> {
    let group = screen.first_group()?;
    let e = &group.delivery_estimate;
    let option = shipping_label(t, screen.session.shipping_option.as_deref().unwrap_or("standard"));
    let window = format!("{} - {}", e.earliest_date, e.latest_date);
    Some(t.page_delivery_estimate_summary(option, &window, &e.package_count.to_string(), &e.service_level).to_string())
}

/// A line's price from the preview (`previewLineForSessionLine`): the cart line's, the listing's,
/// or the product's.
fn line_amount<'a>(line: &SessionLine, preview: Option<&'a FulfillmentPreview>) -> Option<&'a str> {
    let lines = || preview.into_iter().flat_map(|p| &p.seller_groups).flat_map(|g| &g.lines);
    let found = lines()
        .find(|p| line.cart_line_id.as_deref().is_some_and(|id| p.line_key == id))
        .or_else(|| lines().find(|p| line.listing_id.is_some() && p.listing_id == line.listing_id))
        .or_else(|| lines().find(|p| p.product_id == line.product_id));
    found.and_then(|p| p.estimated_line_total_amount.as_deref())
}

/// A line's price on the summary: a purchase intent's offer (`offerPriceAmount`), else the
/// preview's.
fn line_price(t: CheckoutMsg, screen: &Screen, line: &SessionLine) -> String {
    if screen.offer {
        money_or_pending(t, line.offer_price_amount.as_deref())
    } else {
        money_or_pending(t, line_amount(line, screen.preview.as_ref()))
    }
}

/// Each step's status (`buildCheckoutStepperItems`): complete once collected and collapsed,
/// current for the first still open, upcoming after it; Review is blocked while a line cannot be
/// bought.
fn steps(t: CheckoutMsg, screen: &Screen) -> Vec<(&'static str, &'static str, &'static str)> {
    let s = &screen.steps;
    let status = |ready: bool, open: bool, reached: bool| {
        if ready && !open {
            "complete"
        } else if reached {
            "current"
        } else {
            "upcoming"
        }
    };
    let contact = status(s.contact, s.show_contact, true);
    let delivery = status(s.delivery, s.show_delivery, contact == "complete");
    let shipping = status(s.shipping, s.show_shipping, delivery == "complete");
    // A purchase intent has no payment step (`buildCheckoutStepperItems`).
    let payment = if screen.offer { "complete" } else { status(s.payment, s.show_payment, shipping == "complete") };
    let all = [contact, delivery, shipping, payment].iter().all(|s| *s == "complete");
    let review = if screen.session.payment_id.is_some() {
        "complete"
    } else if !screen.can_confirm {
        "blocked"
    } else if all {
        "current"
    } else {
        "upcoming"
    };
    let mut steps = vec![
        (t.page_step_contact(), t.page_step_contact_description(), contact),
        (t.page_step_delivery(), t.page_step_delivery_description(), delivery),
        (t.page_step_shipping(), t.page_step_shipping_description(), shipping),
        (t.page_step_payment(), t.page_step_payment_description(), payment),
        (t.page_step_review(), t.page_step_review_description(), review),
    ];
    if screen.offer {
        steps.remove(3);
    }
    steps
}

/// A page that is not the checkout (marketplace's `CheckoutSessionRecoveryPage`).
#[component(css = CheckoutPage)]
pub fn CheckoutRecovery(t: CheckoutMsg, kind: Recovery) -> impl Render {
    let (title, description) = match kind {
        Recovery::NotFound => (t.route_checkout_session_not_found(), t.route_checkout_session_not_found_description()),
        Recovery::WrongAccount => {
            (t.route_checkout_belongs_to_another_account(), t.route_checkout_belongs_to_another_account_description())
        }
        Recovery::Preparing => (t.recovery_checkout_preparing(), t.recovery_checkout_preparing_auto_description()),
        Recovery::Unavailable => (t.route_checkout_unavailable(), t.route_checkout_unavailable_description()),
    };
    html! {
        <section class={(Panel, Lost)} data-recovery={format!("{kind:?}")}>
            <h1 class={Title}>{title}</h1>
            <p class={Muted}>{description}</p>
            <p class={Row}>
                <a class={Button} href={url::Cart::default()}>{t.recovery_view_buy_cart()}</a>
                <a class={(Button, Secondary)} href="/search">{t.recovery_browse_marketplace()}</a>
            </p>
        </section>
    }
}

/// The page.
#[component(css)]
pub fn CheckoutPage<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let empty = screen.session.lines.is_empty();
    html! {
        <div class={Checkout} data-checkout>
            <header class={Header}>
                <div class={HeaderText}>
                    <p class={Eyebrow}>{t.page_secure_checkout()}</p>
                    <h1 class={Title}>{t.page_checkout()}</h1>
                    <p class={Muted}>
                        {if screen.offer {
                            t.page_confirm_shipping_place_purchase_intent()
                        } else if screen.guest {
                            t.page_simple_checkout_description()
                        } else {
                            t.page_signed_in_checkout_description()
                        }}
                    </p>
                </div>
                <a class={(Button, Secondary)} href={url::Cart::default()}>{t.page_back_to_cart()}</a>
            </header>
            if empty {
                <section class={(Panel, Lost)}>
                    <p class={Strong}>{t.page_your_cart_is_empty()}</p>
                    <p class={Muted}>{t.page_add_a_product_before_starting_checkout()}</p>
                    <p><a class={Button} href="/search">{t.page_browse_marketplace()}</a></p>
                </section>
            } else {
                <details class={MobileSummary}>
                    <summary class={MobileSummaryBar}>
                        <span class={Strong}>{t.page_order_summary()}</span>
                        <span class={Muted}>{t.page_item_count(&lines(screen).to_string())}</span>
                        <span class={Amount}>{shown_total(t, screen)}</span>
                    </summary>
                    <Summary t={t} screen={screen} />
                </details>
                <div class={Flow}>
                    <div class={Main}>
                        <Stepper t={t} screen={screen} />
                        if let Some(error) = &screen.error {
                            <div class={Banner} data-tone="danger" role="alert" data-checkout-error>
                                <p class={Strong}>{t.page_checkout_issue()}</p>
                                <p>{error}</p>
                            </div>
                        } else if screen.expired {
                            <div class={Banner} data-tone="danger" role="alert" data-checkout-error>
                                <p class={Strong}>{t.recovery_checkout_handoff_expired()}</p>
                                <p>{t.recovery_checkout_handoff_expired_description()}</p>
                            </div>
                        } else if screen.preview_missing {
                            <div class={Banner} data-tone="danger" role="alert" data-checkout-error>
                                <p class={Strong}>{t.page_checkout_issue()}</p>
                                <p>{t.route_fulfillment_preview_temporarily_unavailable()}</p>
                            </div>
                        }
                        <PageNotice t={t} screen={screen} />
                        if !screen.expired {
                            if let Some(payment) = &screen.session.payment_id {
                                <Confirmation t={t} screen={screen} payment={payment} />
                            } else {
                                <CheckoutFormPart t={t} screen={screen} />
                            }
                        }
                    </div>
                    <aside class={Aside} aria-label={t.page_checkout_summary()}>
                        <Summary t={t} screen={screen} />
                    </aside>
                </div>
                if !screen.expired {
                    <StickyBar t={t} screen={screen} />
                }
            }
        </div>
    }
}

fn lines(screen: &Screen) -> u64 {
    screen.session.lines.iter().map(|l| l.quantity).sum()
}

fn total(t: CheckoutMsg, screen: &Screen) -> String {
    money_or_pending(t, screen.total())
}

/// The total the summary and the bar show: No payment today for a purchase intent.
fn shown_total(t: CheckoutMsg, screen: &Screen) -> String {
    if screen.offer { t.page_no_payment_today().to_owned() } else { total(t, screen) }
}

/// The total's label (`totalsTotalLabel`).
fn total_label(t: CheckoutMsg, screen: &Screen) -> &'static str {
    if screen.offer { t.page_total() } else { t.page_payable_total() }
}

#[component(css = CheckoutPage)]
fn Stepper<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    html! {
        <ol class={Steps} aria-label={t.page_checkout_steps()}>
            for (label, description, status) in steps(t, screen) {
                <li class={Step} data-status={status} aria-current={(status == "current").then_some("step")}>
                    <span class={StepMark} aria-hidden="true"></span>
                    <span class={StepText}>
                        <span class={Strong}>{label}</span>
                        <span class={StepDescription}>{description}</span>
                    </span>
                </li>
            }
        </ol>
    }
}

/// The page's one notice (`CheckoutNoticeStack`), and "Totals need refresh", which the page's
/// script shows once a field changes.
#[component(css = CheckoutPage)]
fn PageNotice<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let notice: Option<(&str, String, &str)> = screen.notice.as_ref().map(|n| match n {
        Notice::CartReview(count) => (
            t.page_checkout_needs_cart_review(),
            t.page_checkout_needs_cart_review_description(&count.to_string()).to_string(),
            "warning",
        ),
        Notice::FulfillmentChanged(reasons) => (
            t.page_fulfillment_changed(),
            reasons.clone().unwrap_or_else(|| t.page_fulfillment_changed_description().to_owned()),
            "warning",
        ),
        Notice::QuoteRequired => {
            (t.page_payment_quote_required(), t.page_payment_quote_required_description().to_owned(), "info")
        }
        Notice::ReviewUpdated => (t.page_review_updated(), t.page_review_updated_description().to_owned(), "success"),
        Notice::FastCheckout { address, method } => {
            (t.page_fast_checkout_ready(), t.page_fast_checkout_ready_description(address, method).to_string(), "success")
        }
        Notice::SavedPayment { address, method } => {
            (t.page_saved_payment_step_ready(), t.page_saved_payment_step_ready_description(address, method).to_string(), "info")
        }
        Notice::SavedAddress(address) => {
            (t.page_saved_address_ready(), t.page_saved_address_ready_description(address).to_string(), "info")
        }
    });
    html! {
        if let Some((title, description, tone)) = notice {
            <div class={(Banner, Drawn)} data-tone={tone} role="status" data-checkout-notice>
                <p class={Strong}>{title}</p>
                <p>{description}</p>
                if matches!(screen.notice, Some(Notice::CartReview(_))) {
                    <p><a class={(Button, Secondary)} href={url::Cart::default()}>{t.page_review_buy_cart()}</a></p>
                }
            </div>
        }
        if !screen.offer {
            <div class={(Banner, StaleOnly)} data-tone="warning" role="status" data-checkout-stale>
                <p class={Strong}>{t.page_totals_need_refresh()}</p>
                <p>{t.page_totals_need_refresh_description()}</p>
            </div>
        }
    }
}

/// The checkout form: its hidden fields, the ready steps' rows, each open step, Pay now and the
/// policies.
#[component(css = CheckoutPage)]
fn CheckoutFormPart<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let f = CheckoutForm::FIELDS;
    let s = &screen.session;
    let id = s.session_id.as_str();
    let a = &screen.address;
    let payment = screen.payment.as_ref();
    let (eligible, selected) = screen.authenticity();
    let offer = screen.preview.as_ref().and_then(|p| p.authenticity_check_offer.as_ref());
    let credit = if screen.wallet_unavailable {
        String::new()
    } else {
        payment
            .map(|p| p.wallet_credit.requested_amount.clone())
            .or_else(|| screen.wallet.as_ref().map(|w| w.available_balance_amount.clone()))
            .unwrap_or_else(|| "0.00".into())
    };
    let option = s.shipping_option.as_deref().unwrap_or("standard");
    let picked = a.shipping_address_id.clone().unwrap_or_else(|| MANUAL.into());
    let text = |v: &Option<String>| v.clone().unwrap_or_default();
    let steps = &screen.steps;
    html! {
        <form
            id={CheckoutFormId}
            class={Form}
            method="post"
            action={url::BuyCheckout { id, place: Place::default() }}
            on:change={handlers::stale(event)}
            on:input={handlers::stale(event)}
        >
            <input
                type="hidden"
                name={f.fulfillment_preview_revision}
                value={screen.preview.as_ref().and_then(|p| p.revision.as_deref()).unwrap_or("")}
            >
            <input
                type="hidden"
                name={f.marketplace_checkout_fee_quote_fingerprint}
                value={payment.map_or("", |p| p.marketplace_checkout_fee.quote_fingerprint.as_str())}
            >
            <input type="hidden" name={f.requested_balance_credit_amount} value={&credit}>
            <input type="hidden" name={f.payment_method_category} value={&screen.method}>
            <input type="hidden" name={f.reviewed_shipping_option} value={option}>
            <input type="hidden" name={f.reviewed_shipping_address_signature} value={signature(a)}>
            <input type="hidden" name={f.acknowledged_material_changes} value={if screen.acknowledged { "true" } else { "" }}>
            <input type="hidden" name={f.accelerated_saved_payment} value={if screen.accelerated { "true" } else { "" }}>
            if steps.rows() {
                <SavedRows t={t} screen={screen} />
            }
            if steps.show_contact {
                <fieldset class={Part}>
                    <legend class={PartTitle}>{t.page_contact()}</legend>
                    <label class={Field}>
                        <span class={Label}>{t.page_email()}</span>
                        <input
                            class={Input}
                            type="email"
                            name={f.shipping_email}
                            value={text(&a.email)}
                            autocomplete="email"
                            required={!screen.offer}
                        >
                    </label>
                </fieldset>
            } else {
                <input type="hidden" name={f.shipping_email} value={text(&a.email)}>
            }
            if steps.show_delivery {
                <fieldset class={Part} data-step="delivery">
                    <legend class={PartTitle}>{t.page_delivery()}</legend>
                    <p class={Muted}>
                        {if screen.offer {
                            t.page_destination_required_for_purchase_intent()
                        } else {
                            t.page_destination_required_for_sales_tax()
                        }}
                    </p>
                    if !screen.addresses.is_empty() {
                        <label class={Field}>
                            <span class={Label}>{t.page_saved_shipping_address()}</span>
                            <select class={Input} name={f.shipping_address_id}>
                                <option value={MANUAL} selected={picked == MANUAL}>{t.page_enter_a_new_address()}</option>
                                for saved in &screen.addresses {
                                    <option value={&saved.shipping_address_id} selected={picked == saved.shipping_address_id}>
                                        if saved.is_default {
                                            {t.page_default_address_option(&saved.label)}
                                        } else {
                                            {&saved.label}
                                        }
                                    </option>
                                }
                            </select>
                        </label>
                    } else {
                        <input type="hidden" name={f.shipping_address_id} value={MANUAL}>
                    }
                    <div class={Fields}>
                        <TextField
                            label={t.page_recipient_name()}
                            name={f.shipping_name}
                            value={&a.name}
                            auto="shipping name"
                            required
                        />
                        <TextField
                            label={t.page_company()}
                            name={f.shipping_company}
                            value={&text(&a.company)}
                            auto="shipping organization"
                            required={false}
                        />
                        <label class={Field}>
                            <span class={Label}>{t.page_country()}</span>
                            <select class={Input} name={f.shipping_country} autocomplete="shipping country">
                                <option value="US" selected>{t.page_country_united_states()}</option>
                            </select>
                        </label>
                        <TextField
                            label={t.page_address_line1()}
                            name={f.shipping_line1}
                            value={&a.line1}
                            auto="shipping address-line1"
                            required
                        />
                        <TextField
                            label={t.page_address_line2()}
                            name={f.shipping_line2}
                            value={&text(&a.line2)}
                            auto="shipping address-line2"
                            required={false}
                        />
                        <TextField
                            label={t.page_city()}
                            name={f.shipping_city}
                            value={&a.city}
                            auto="shipping address-level2"
                            required
                        />
                        <TextField
                            label={t.page_state()}
                            name={f.shipping_state}
                            value={&a.state}
                            auto="shipping address-level1"
                            required
                        />
                        <TextField
                            label={t.page_postal_code()}
                            name={f.shipping_postal_code}
                            value={&a.postal_code}
                            auto="shipping postal-code"
                            required
                        />
                        <TextField
                            label={t.page_phone()}
                            name={f.shipping_phone}
                            value={&text(&a.phone)}
                            auto="shipping tel"
                            required={false}
                        />
                    </div>
                </fieldset>
            } else {
                <input type="hidden" name={f.shipping_address_id} value={&picked}>
                <input type="hidden" name={f.shipping_name} value={&a.name}>
                <input type="hidden" name={f.shipping_company} value={text(&a.company)}>
                <input type="hidden" name={f.shipping_country} value={&a.country}>
                <input type="hidden" name={f.shipping_line1} value={&a.line1}>
                <input type="hidden" name={f.shipping_line2} value={text(&a.line2)}>
                <input type="hidden" name={f.shipping_city} value={&a.city}>
                <input type="hidden" name={f.shipping_state} value={&a.state}>
                <input type="hidden" name={f.shipping_postal_code} value={&a.postal_code}>
                <input type="hidden" name={f.shipping_phone} value={text(&a.phone)}>
            }
            if steps.show_shipping {
                <fieldset class={Part} data-step="shipping">
                    <legend class={PartTitle}>{t.page_shipping_method()}</legend>
                    <p class={Muted}>{t.page_shipping_method_description()}</p>
                    <label class={Field}>
                        <span class={Label}>{t.page_shipping_option()}</span>
                        <select class={Input} name={f.shipping_option}>
                            for choice in SHIPPING {
                                <option value={choice} selected={choice == option}>{shipping_label(t, choice)}</option>
                            }
                        </select>
                    </label>
                    match estimate(t, screen) {
                        Some(summary) => {
                            <div class={Banner} data-tone="info">
                                <p class={Strong}>{t.page_delivery_estimate()}</p>
                                <p>{summary}</p>
                            </div>
                        }
                        None => {
                            <div class={Banner} data-tone="info">
                                <p class={Strong}>{t.page_shipping_after_address()}</p>
                                <p>{t.page_shipping_after_address_description()}</p>
                            </div>
                        }
                    }
                    if let Some(offer) = offer.filter(|_| eligible) {
                        <label class={Check}>
                            <input type="checkbox" name={f.authenticity_check_opt_in} value="true" checked={selected}>
                            <span>
                                <span class={Strong}>{t.page_authenticity_check_opt_in(&money(t, &offer.fee_amount))}</span>
                                <span class={StepDescription}>{t.page_authenticity_check_opt_in_description()}</span>
                            </span>
                        </label>
                        <input
                            type="hidden"
                            name={f.authenticity_check_opt_in_quote_fingerprint}
                            value={&offer.quote_fingerprint}
                        >
                    } else {
                        <input
                            type="hidden"
                            name={f.authenticity_check_opt_in_quote_fingerprint}
                            value={s.authenticity_check_opt_in.as_ref().and_then(|o| o.quote_fingerprint.as_deref()).unwrap_or("")}
                        >
                    }
                </fieldset>
            } else {
                <input type="hidden" name={f.shipping_option} value={option}>
                <input type="hidden" name={f.authenticity_check_opt_in} value={if selected { "true" } else { "false" }}>
                <input
                    type="hidden"
                    name={f.authenticity_check_opt_in_quote_fingerprint}
                    value={offer.map_or("", |o| o.quote_fingerprint.as_str())}
                >
            }
            <PaymentPart t={t} screen={screen} />
            <div class={CommitRow}>
                <a class={(Button, Secondary)} href={url::Cart::default()}>{t.page_back_to_cart()}</a>
                <Commit t={t} screen={screen} in_form />
            </div>
            <section class={Policies} aria-label={t.policy_label()}>
                <p class={Row}>
                    <a href={on_marketplace("/terms")}>{t.policy_terms()}</a>
                    <a href={on_marketplace("/privacy")}>{t.policy_privacy()}</a>
                    <a href={on_marketplace("/refunds-and-returns")}>{t.policy_refunds()}</a>
                </p>
                <p class={Muted}>{t.policy_description()}</p>
                if screen.guest {
                    <p class={Muted}>{t.page_guest_data_description()}</p>
                }
            </section>
        </form>
    }
}

#[component(css = CheckoutPage)]
fn TextField<'a, N: AttrValue>(label: &'a str, name: N, value: &'a str, auto: &'a str, required: bool) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{label}</span>
            <input class={Input} type="text" name={name} value={value} autocomplete={auto} required={required}>
        </label>
    }
}

/// The Payment step: the method, a saved method, saving this one, and what comes next.
#[component(css = CheckoutPage)]
fn PaymentPart<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let f = CheckoutForm::FIELDS;
    let retry = html! {
        if screen.wallet_unavailable {
            <div class={Banner} data-tone="warning" role="status">
                <p class={Strong}>{t.page_wallet_unavailable()}</p>
                <p>{t.page_wallet_unavailable_description()}</p>
                <p>
                    <button type="submit" class={(Button, Secondary)} name={f.intent} value="retry-wallet-balance" formnovalidate>
                        {t.page_retry_wallet()}
                    </button>
                </p>
            </div>
        }
    };
    html! {
        if screen.steps.show_payment {
            <fieldset class={Part} data-step="payment">
                <legend class={PartTitle}>{t.page_payment()}</legend>
                <p class={Muted}>{t.page_payment_section_description()}</p>
                {retry}
                <label class={Field}>
                    <span class={Label}>{t.page_payment_method()}</span>
                    <select class={Input} name={f.preview_payment_method_category}>
                        for method in &screen.methods {
                            <option value={method} selected={*method == screen.method}>{method_label(t, method)}</option>
                        }
                    </select>
                </label>
                if !screen.instruments.is_empty() {
                    <label class={Field}>
                        <span class={Label}>{t.page_saved_payment()}</span>
                        <select class={Input} name={f.saved_checkout_instrument_id}>
                            for i in &screen.instruments {
                                <option
                                    value={&i.instrument_id}
                                    selected={screen.instrument.as_ref().is_some_and(|s| s.instrument_id == i.instrument_id)}
                                >
                                    if i.is_default {
                                        {t.page_default_saved_payment_option(&i.display_label)}
                                    } else {
                                        {&i.display_label}
                                    }
                                </option>
                            }
                        </select>
                    </label>
                }
                if screen.can_save_payment && screen.instrument.is_none() && screen.method != "platform-credit" {
                    <label class={Check}>
                        <input type="checkbox" name={f.save_payment_method_for_future} value="true">
                        <span>
                            <span class={Strong}>{t.page_save_payment_method()}</span>
                            <span class={StepDescription}>{t.page_save_payment_method_description()}</span>
                        </span>
                    </label>
                }
                <div class={Banner} data-tone={if screen.payment.is_some() { "success" } else { "info" }}>
                    if screen.payment.is_some() {
                        <p class={Strong}>{t.page_final_totals_before_payment()}</p>
                        <p>{t.page_final_totals_before_payment_description()}</p>
                    } else {
                        <p class={Strong}>{t.page_payment_review_next()}</p>
                        if let Some(w) = &screen.wallet {
                            <p>
                                {t.page_payment_review_next_with_wallet(&w.available_balance_amount, &w.currency_code.to_uppercase())}
                            </p>
                        } else {
                            <p>{t.page_payment_review_next_description()}</p>
                        }
                    }
                </div>
            </fieldset>
        } else {
            {retry}
            <input type="hidden" name={f.preview_payment_method_category} value={&screen.method}>
            if let Some(i) = &screen.instrument {
                <input type="hidden" name={f.saved_checkout_instrument_id} value={&i.instrument_id}>
            }
        }
    }
}

/// The ready steps as rows, each with Edit (`CheckoutSavedInfoSection`): a link to the page with
/// that step open.
#[component(css = CheckoutPage)]
fn SavedRows<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let s = &screen.steps;
    let a = &screen.address;
    let edit = |step: Edit| url::BuyCheckout { id: &screen.session.session_id, place: screen.place.editing(step) };
    let region = [a.state.trim(), a.postal_code.trim()].iter().filter(|v| !v.is_empty()).copied().collect::<Vec<_>>().join(" ");
    let locality = [a.city.trim(), region.as_str()].iter().filter(|v| !v.is_empty()).copied().collect::<Vec<_>>().join(", ");
    let line2 = a.line2.as_deref().unwrap_or("").trim();
    let place = [a.line1.trim(), line2, locality.as_str(), a.country.trim()]
        .iter()
        .filter(|v| !v.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let phone = a.phone.as_deref().unwrap_or("").trim();
    let contact_text = if phone.is_empty() {
        t.page_contact_row_supporting().to_owned()
    } else {
        t.page_contact_row_supporting_phone(phone).to_string()
    };
    let option = shipping_label(t, screen.session.shipping_option.as_deref().unwrap_or("standard"));
    let fast = screen.instrument.as_ref().is_some_and(|i| i.confirmation_experience == "off-session-token");
    html! {
        <section class={(Part, Rows)} aria-labelledby="checkout-details">
            <h2 class={PartTitle} id="checkout-details">{t.page_saved_checkout_details()}</h2>
            <ul class={RowList}>
                if s.contact {
                    <SavedRow
                        label={t.page_contact()}
                        value={a.email.as_deref().unwrap_or("")}
                        detail={&contact_text}
                        ready={t.page_ready()}
                        status="success"
                        edit={(!s.show_contact && !screen.guest).then(|| (edit(Edit::Contact).href(), t.page_edit_contact()))}
                    />
                }
                if s.delivery {
                    <SavedRow
                        label={t.page_ship_to()}
                        value={&a.name}
                        detail={&place}
                        ready={t.page_ready()}
                        status="success"
                        edit={(!s.show_delivery).then(|| (edit(Edit::Delivery).href(), t.page_edit_delivery()))}
                    />
                }
                if let Some(summary) = estimate(t, screen).filter(|_| s.shipping) {
                    <SavedRow
                        label={t.page_shipping()}
                        value={option}
                        detail={&summary}
                        ready={t.page_ready()}
                        status="success"
                        edit={(!s.show_shipping).then(|| (edit(Edit::Shipping).href(), t.page_edit_shipping()))}
                    />
                }
                if let Some(i) = screen.instrument.as_ref().filter(|_| s.payment) {
                    <SavedRow
                        label={t.page_payment()}
                        value={&i.display_label}
                        detail={if fast { t.page_saved_payment_row_supporting_fast() } else { t.page_saved_payment_row_supporting_secure_step() }}
                        ready={if screen.payment.is_some() { t.page_ready() } else { t.page_review_required() }}
                        status={if screen.payment.is_some() { "success" } else { "warning" }}
                        edit={(!s.show_payment).then(|| (edit(Edit::Payment).href(), t.page_edit_payment()))}
                    />
                }
            </ul>
        </section>
    }
}

#[component(css = CheckoutPage)]
fn SavedRow<'a>(
    label: &'a str,
    value: &'a str,
    detail: &'a str,
    ready: &'a str,
    status: &'a str,
    edit: Option<(String, &'a str)>,
) -> impl Render {
    html! {
        <li class={SavedItem}>
            <div class={SavedText}>
                <p class={Label}>{label}</p>
                <p class={Strong}>{value}</p>
                <p class={Muted}>{detail}</p>
            </div>
            <div class={SavedEnd}>
                <span class={Badge} data-tone={status}>{ready}</span>
                if let Some((href, text)) = &edit {
                    <a class={(Button, Secondary, Small)} href={href}>{*text}</a>
                }
            </div>
        </li>
    }
}

/// The one commit control (`checkoutCommitButton`): Review buy cart while a line cannot be
/// bought, Update totals while there is no quote, else Pay now, which the page's script swaps for
/// Update totals once a field changes.
#[component(css = CheckoutPage)]
fn Commit<'a>(t: CheckoutMsg, screen: &'a Screen, in_form: bool) -> impl Render {
    let f = CheckoutForm::FIELDS;
    let form = (!in_form).then_some(CheckoutFormId);
    let pay = if screen.accelerated {
        let label = screen.instrument.as_ref().map_or_else(|| screen.method.replace('-', " "), |i| i.display_label.clone());
        t.page_pay_now_with_saved_payment(&label).to_string()
    } else {
        t.page_pay_now().to_owned()
    };
    html! {
        if screen.offer {
            <button type="submit" class={(Button, Wide)} form={form} name={f.intent} value="confirm-checkout" data-commit="offer">
                {t.page_place_purchase_intent()}
            </button>
        } else if !screen.can_confirm {
            <a class={(Button, Wide)} href={url::Cart::default()}>{t.page_review_buy_cart()}</a>
        } else if screen.needs_quote {
            <button
                type="submit"
                class={(Button, Wide)}
                form={form}
                name={f.intent}
                value="refresh-checkout-preview"
                data-commit="refresh"
            >
                {t.page_update_totals()}
            </button>
        } else {
            <button
                type="submit"
                class={(Button, Wide, PayOnly)}
                form={form}
                name={f.intent}
                value="confirm-checkout"
                data-commit="pay"
            >
                {pay}
            </button>
            <button
                type="submit"
                class={(Button, Wide, StaleOnly)}
                form={form}
                name={f.intent}
                value="refresh-checkout-preview"
                data-commit="refresh"
            >
                {t.page_update_totals()}
            </button>
        }
    }
}

/// The bar a phone keeps at the bottom: the total and Pay now (`CheckoutStickyAction`).
#[component(css = CheckoutPage)]
fn StickyBar<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let paid = screen.session.payment_id.is_some();
    html! {
        <section class={Bar} aria-label={t.page_checkout_summary()}>
            <div class={BarTotal}>
                <p class={Label}>{total_label(t, screen)}</p>
                <p class={Amount}>{if paid { t.page_payment_ready().to_owned() } else { shown_total(t, screen) }}</p>
                <p class={StepDescription}>
                    {if screen.offer { t.page_shipping_saved_for_seller_acceptance() } else { t.page_secure_checkout_context() }}
                </p>
            </div>
            if let Some(payment) = &screen.session.payment_id {
                <a class={(Button, Wide)} href={crate::checkout::payment_href(screen.guest, payment, None)}>
                    {t.page_continue_to_payment()}
                </a>
            } else {
                <Commit t={t} screen={screen} in_form={false} />
            }
        </section>
    }
}

/// Once Pay now started the payment (`CheckoutConfirmationSection`): the references, the total
/// and the next steps, and Continue to payment: the payment's page, an account's or a guest's.
#[component(css = CheckoutPage)]
fn Confirmation<'a>(t: CheckoutMsg, screen: &'a Screen, payment: &'a str) -> impl Render {
    let s = &screen.session;
    let orders = if s.order_ids.is_empty() {
        t.page_pending().to_owned()
    } else {
        s.order_ids.iter().map(|id| display_reference(id)).collect::<Vec<_>>().join(", ")
    };
    let support = support_reference(s).unwrap_or_else(|| t.page_pending().to_owned());
    let steps = [
        (t.page_payment_handoff_title(), t.page_payment_handoff_description()),
        (t.page_account_fulfillment_pending_title(), t.page_account_fulfillment_pending_description()),
        (t.page_support_reference_ready_title(), t.page_support_reference_ready_description()),
    ];
    html! {
        <section class={(Panel, Confirmed)} aria-labelledby="checkout-confirmed" data-payment={payment}>
            <h2 class={PartTitle} id="checkout-confirmed">{t.page_payment_ready_2()}</h2>
            <p class={Muted}>{t.page_purchases_have_been_created_and_payment()}</p>
            <dl class={Facts}>
                <div>
                    <dt>{t.page_order_reference()}</dt>
                    <dd data-orders>{orders}</dd>
                </div>
                <div>
                    <dt>{t.page_support_reference()}</dt>
                    <dd>{support}</dd>
                </div>
                <div>
                    <dt>{t.page_payable_total()}</dt>
                    <dd>{total(t, screen)}</dd>
                </div>
            </dl>
            <ul class={NextSteps}>
                for (title, description) in steps {
                    <li>
                        <p class={Strong}>{title}</p>
                        <p class={Muted}>{description}</p>
                    </li>
                }
            </ul>
            <p>
                <a class={Button} href={crate::checkout::payment_href(screen.guest, payment, None)}>
                    {t.page_continue_to_payment()}
                </a>
            </p>
        </section>
    }
}

/// A payment's status in Checkout received's words (`paymentStatusLabel`).
fn payment_status(t: CheckoutMsg, status: &str) -> &'static str {
    match status {
        "pending-confirmation" => t.confirmation_payment_status_ready(),
        "captured" => t.confirmation_payment_status_paid(),
        "failed" => t.confirmation_payment_status_failed(),
        "cancelled" => t.confirmation_payment_status_cancelled(),
        _ => t.confirmation_payment_status_pending(),
    }
}

/// Checkout received (`BuyCheckoutConfirmationPage`): the header, then the payment's panel (its
/// reference, the support reference, its total, the next steps and Continue to payment), the
/// order's status, the protections, and Secure payment. One column.
#[component(css = CheckoutPage)]
pub fn BuyConfirmationPage<'a>(t: CheckoutMsg, screen: &'a ConfirmationScreen) -> impl Render {
    let orders = if screen.order_ids.is_empty() {
        t.page_pending().to_owned()
    } else {
        screen.order_ids.iter().map(|id| display_reference(id)).collect::<Vec<_>>().join(", ")
    };
    // Payments borrow the order's reference when the checkout made one order (`buyCheckoutPaymentReference`).
    let reference = match screen.order_ids.as_slice() {
        [one] => display_reference(one),
        _ => screen.payment_id.clone(),
    };
    let support = screen.support_reference.clone().unwrap_or_else(|| t.page_pending().to_owned());
    let total = screen.payment.as_ref().map_or_else(
        || t.confirmation_payment_total_pending().to_owned(),
        |p| match (platform::money::decimal(&p.amount), Currency::parse(p.currency_code.trim())) {
            (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
            _ => format!("{} {}", p.amount, p.currency_code.to_ascii_uppercase()),
        },
    );
    let status = screen.payment.as_ref().map_or(t.confirmation_payment_status_preparing(), |p| payment_status(t, &p.status));
    let order_status =
        if screen.order_ids.is_empty() { t.confirmation_order_status_pending() } else { t.confirmation_order_status_created() };
    let steps = [
        (t.page_payment_handoff_title(), t.page_payment_handoff_description()),
        (t.page_account_fulfillment_pending_title(), t.page_account_fulfillment_pending_description()),
        (t.page_support_reference_ready_title(), t.page_support_reference_ready_description()),
    ];
    html! {
        <div class={Checkout} data-confirmation={&screen.session_id}>
            <header class={Header}>
                <div class={HeaderText}>
                    <p class={Eyebrow}>{t.confirmation_eyebrow()}</p>
                    <h1 class={Title}>{t.confirmation_title()}</h1>
                    <p class={Muted}>{t.confirmation_description()}</p>
                </div>
            </header>
            <h2 class={PartTitle}>{t.confirmation_summary()}</h2>
            <section class={(Panel, Confirmed)} aria-labelledby="checkout-received" data-payment={&screen.payment_id}>
                <h3 class={PartTitle} id="checkout-received">{t.page_payment_ready_2()}</h3>
                <p class={Muted}>{t.page_purchases_have_been_created_and_payment()}</p>
                <dl class={Facts}>
                    <div>
                        <dt>{t.confirmation_payment_reference()}</dt>
                        <dd>{&reference}</dd>
                    </div>
                    <div>
                        <dt>{t.page_support_reference()}</dt>
                        <dd>{&support}</dd>
                    </div>
                    <div>
                        <dt>{t.confirmation_payment_total()}</dt>
                        <dd>{&total}</dd>
                    </div>
                </dl>
                <ul class={NextSteps}>
                    for (title, description) in steps {
                        <li>
                            <p class={Strong}>{title}</p>
                            <p class={Muted}>{description}</p>
                        </li>
                    }
                </ul>
                <p><a class={(Button, Wide)} href={&screen.payment_href}>{t.page_continue_to_payment()}</a></p>
            </section>
            <section class={Panel} aria-labelledby="checkout-order-status">
                <h3 class={PartTitle} id="checkout-order-status">{t.confirmation_order_status()}</h3>
                <dl class={Facts}>
                    <div>
                        <dt>{t.page_order_reference()}</dt>
                        <dd data-orders>{&orders}</dd>
                    </div>
                    <div>
                        <dt>{t.confirmation_order_status()}</dt>
                        <dd>{order_status}</dd>
                    </div>
                    <div>
                        <dt>{t.confirmation_payment_status()}</dt>
                        <dd>{status}</dd>
                    </div>
                </dl>
                <ul class={Protections}>
                    <li>
                        <p class={Strong}>{t.page_buyer_protection()}</p>
                        <p class={Muted}>
                            {t.page_order_protection_terms_summary()} " "
                            <a href={on_marketplace("/help/buying/order-protection")}>{t.page_order_protection_terms_link()}</a>
                        </p>
                    </li>
                    <li>
                        <p class={Strong}>{t.page_payment_ready()}</p>
                        <p class={Muted}>{t.page_purchases_have_been_created_and_payment()}</p>
                    </li>
                </ul>
                <p class={(Muted, Small)}>{t.confirmation_payment_handoff()}</p>
            </section>
        </div>
    }
}

/// The order summary (`CheckoutOrderSummarySection`): each line, the totals, the payable total and
/// the order's protections.
#[component(css = CheckoutPage)]
fn Summary<'a>(t: CheckoutMsg, screen: &'a Screen) -> impl Render {
    let preview = screen.preview.as_ref();
    let totals = preview.map(|p| &p.totals);
    let payment = screen.payment.as_ref();
    let (_, authenticity) = screen.authenticity();
    let offer = preview.and_then(|p| p.authenticity_check_offer.as_ref());
    let pending = !screen.offer && screen.total().is_none();
    let intent = screen.offer;
    html! {
        <section class={(Panel, SummaryPanel)} aria-label={t.page_order_summary()}>
            <div class={SummaryHead}>
                <h2 class={PartTitle}>{t.page_order_summary()}</h2>
                <span class={Badge}>{t.page_item_count(&lines(screen).to_string())}</span>
            </div>
            <ul class={Items}>
                for line in &screen.session.lines {
                    <li class={ItemRow}>
                        <div class={SavedText}>
                            <p class={Strong}>{&line.item_title}</p>
                            if let Some(subtitle) = &line.item_subtitle {
                                <p class={StepDescription}>{subtitle}</p>
                            }
                            if line.product_summary.is_some() {
                                <ul class={Chips}>
                                    for option in options(line.product_summary.as_deref()) {
                                        <li class={Chip}>{option}</li>
                                    }
                                </ul>
                            }
                            <p class={StepDescription}>{t.page_quantity_summary(&line.quantity.to_string())}</p>
                        </div>
                        <p class={Price} data-line-price>{line_price(t, screen, line)}</p>
                    </li>
                }
            </ul>
            <dl class={Totals}>
                <div>
                    <dt>{t.page_subtotal()}</dt>
                    <dd>{money_or_pending(t, totals.and_then(|x| x.item_subtotal_amount.as_deref()))}</dd>
                </div>
                <div class={Quiet}>
                    <dt>{t.page_shipping_2()}</dt>
                    <dd>
                        {if intent {
                            t.page_no_payment_today().to_owned()
                        } else {
                            money_or_pending(t, totals.and_then(|x| x.shipping_amount.as_deref()))
                        }}
                    </dd>
                </div>
                <div class={Quiet}>
                    <dt>{t.page_estimated_tax()}</dt>
                    <dd>
                        {if intent {
                            t.page_not_applicable().to_owned()
                        } else {
                            money_or_pending(t, totals.and_then(|x| x.sales_tax_amount.as_deref()))
                        }}
                    </dd>
                </div>
                if !intent {
                    <div class={(payment.is_none()).then_some(Quiet)}>
                        <dt>{t.page_marketplace_checkout_fee()}</dt>
                        <dd data-fee>
                            match payment {
                                Some(p) => { {money(t, &p.marketplace_checkout_fee.marketplace_checkout_fee_amount)} }
                                None => { {t.page_calculated_before_payment()} }
                            }
                        </dd>
                    </div>
                }
                if let (Some(_), Some(p)) = (&screen.wallet, payment) {
                    <div>
                        <dt>{t.page_wallet_credit()}</dt>
                        <dd>{money(t, &format!("-{}", p.wallet_credit.applied_amount))}</dd>
                    </div>
                }
                if let Some(o) = offer.filter(|_| authenticity) {
                    <div>
                        <dt>{t.page_authenticity_check_fee()}</dt>
                        <dd>{money(t, &o.fee_amount)}</dd>
                    </div>
                }
                if let Some(w) = &screen.wallet {
                    <div class={Quiet}>
                        <dt>{t.page_available_balance()}</dt>
                        <dd>{money(t, &w.available_balance_amount)}</dd>
                    </div>
                }
                <div class={Total}>
                    <dt>{total_label(t, screen)}</dt>
                    <dd class={(pending.then_some(Quiet), (!pending).then_some(Amount))} data-total>{shown_total(t, screen)}</dd>
                </div>
            </dl>
            <p class={StepDescription}>
                {if intent { t.page_sellers_can_accept_purchase_intent_before_order() } else { t.page_secure_payment_confirmed_caption() }}
            </p>
            <ul class={Protections}>
                <li>
                    <p class={Strong}>{t.page_buyer_protection()}</p>
                    <p class={Muted}>
                        {t.page_order_protection_terms_summary()} " "
                        <a href={on_marketplace("/help/buying/order-protection")}>{t.page_order_protection_terms_link()}</a>
                    </p>
                </li>
                <li>
                    if intent {
                        <p class={Strong}>{t.page_no_payment_today()}</p>
                        <p class={Muted}>{t.page_sellers_can_accept_purchase_intent_before_order()}</p>
                    } else {
                        <p class={Strong}>{t.page_secure_payment()}</p>
                        <p class={Muted}>{t.page_payment_starts_only_after_orders_are()}</p>
                    }
                </li>
                <li>
                    <p class={Strong}>{t.page_fulfillment_ready()}</p>
                    <p class={Muted}>
                        {if intent {
                            t.page_shipping_preference_is_captured_for_purchase_intent()
                        } else {
                            t.page_fulfillment_resolved_before_checkout()
                        }}
                    </p>
                </li>
                if authenticity {
                    <li>
                        <p class={Strong}>{t.page_authenticity_check_protection()}</p>
                        <p class={Muted}>{t.page_authenticity_check_protection_description()}</p>
                    </li>
                }
            </ul>
        </section>
    }
}
