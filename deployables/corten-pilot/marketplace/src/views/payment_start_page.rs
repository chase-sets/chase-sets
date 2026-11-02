//! Starting a payment (Payments' `account-payment-new`): the header with Back to purchases, the
//! payment summary (folded above the page on a phone, beside it from 64rem) with the seller's
//! evidence at acceptance, the form (payment method and wallet credit, Continue to payment), every
//! method's quote, and the purchases. On a phone Continue to payment is also in a bar at the bottom
//! with the total. No script: the form posts to the page.
use corten::{i18n::Currency, prelude::*};

use crate::{
    api::{FeeQuote, PaymentOrder},
    app::url,
    payment_start::{StartForm, StartScreen, amount},
    text::PaymentStartMsg,
};

/// The form, which the phone's bar submits too.
#[derive(Id)]
pub struct StartFormId;

/// An amount the API sent, in the request's locale (`formatMoney`, always US dollars), or as sent
/// when it is not money.
fn money(t: PaymentStartMsg, value: &str) -> String {
    match (platform::money::decimal(value), Currency::parse("USD")) {
        (Some(decimal), Some(usd)) => t.money(decimal, usd).to_string(),
        _ => value.to_owned(),
    }
}

/// A payment method's name (`paymentMethodLabel`).
fn method(t: PaymentStartMsg, category: &str) -> &'static str {
    match category {
        "bank-account" => t.bank_account(),
        "platform-credit" => t.platform_credit(),
        _ => t.card(),
    }
}

/// The page.
#[component(css)]
pub fn PaymentStartPage<'a>(t: PaymentStartMsg, screen: &'a StartScreen) -> impl Render {
    let fee = &screen.quote.marketplace_checkout_fee;
    let total_due = money(t, &fee.total_amount);
    html! {
        <div class={Page}>
            <header class={Header}>
                <div class={Tight}>
                    <p class={Eyebrow}>{t.secure_checkout()}</p>
                    <h1 class={Title}>{t.start_payment()}</h1>
                    <p class={Muted}>{t.review_the_purchases_created_by_checkout()}</p>
                </div>
                <a class={(Button, Secondary)} href={url::Purchases::default()}>{t.back_to_purchases()}</a>
            </header>
            <details class={MobileSummary}>
                <summary class={MobileSummaryBar}>
                    <span class={Strong}>{t.total_due()}</span>
                    <span class={Amount}>{&total_due}</span>
                </summary>
                <Summary t={t} screen={screen} />
            </details>
            <div class={Flow}>
                <div class={Main}>
                    <div class={Banner} role="note">
                        <p class={Strong}>{t.transparent_totals()}</p>
                        <p>{t.transparent_totals_description()}</p>
                    </div>
                    <StartCard t={t} screen={screen} />
                    <section class={Section} aria-labelledby="start-quotes-title">
                        <h2 id="start-quotes-title" class={PartTitle}>{t.payment_method_fee_preview()}</h2>
                        <ul class={Quotes}>
                            for quote in &screen.quote.payment_method_quotes {
                                <Quote t={t} quote={quote} />
                            }
                        </ul>
                    </section>
                    <section class={Section} aria-labelledby="start-purchases-title">
                        <h2 id="start-purchases-title" class={PartTitle}>{t.purchases_2()}</h2>
                        <ul class={Rows}>
                            for order in &screen.orders {
                                <Purchase t={t} order={order} />
                            }
                        </ul>
                    </section>
                </div>
                <aside class={Aside} aria-label={t.checkout_summary()}>
                    <Summary t={t} screen={screen} />
                </aside>
            </div>
            <div class={Bar} role="group" aria-label={t.continue_to_payment()}>
                <p class={BarTotal}>
                    <span class={Muted}>{t.final_totals_before_payment()}</span>
                    <span class={Strong}>{&total_due}</span>
                </p>
                <button type="submit" class={(Button, Wide)} form={StartFormId}>{t.continue_to_payment()}</button>
                <a class={(Button, Secondary, Wide)} href={url::Purchases::default()}>{t.back_to_purchases()}</a>
            </div>
        </div>
    }
}

/// The form: the payment method, how much of the wallet to use, and Continue to payment
/// (marketplace's payment setup card).
#[component(css = PaymentStartPage)]
fn StartCard<'a>(t: PaymentStartMsg, screen: &'a StartScreen) -> impl Render {
    let f = StartForm::FIELDS;
    let totals = &screen.totals;
    let chosen = &screen.chosen;
    let count = screen.orders.len();
    let label = if count == 1 { t.purchase_singular() } else { t.purchase_plural() };
    let wallet = screen.wallet.as_ref();
    let credit_only_off = totals.external_after_max > 0;
    let wallet_says = match wallet {
        Some(_) => t.maximum_leaves_external_payment(&money(t, &amount(totals.external_after_max))).to_string(),
        None => t.no_wallet_balance_is_available_for().to_owned(),
    };
    let custom_says = match wallet {
        Some(w) => {
            t.wallet_available_custom_description(&w.available_balance_amount, &w.currency_code.to_ascii_uppercase()).to_string()
        }
        None => t.apply_available_wallet_balance_to_this().to_owned(),
    };
    html! {
        <section class={Card} aria-labelledby="start-setup-title">
            <p><span class={Badge} data-tone="accent">{t.payment_setup_2()}</span></p>
            <h2 id="start-setup-title" class={Strong}>{t.ready_to_initialize_payment()}</h2>
            <p class={Muted}>{t.payment_covers_purchases(&count.to_string(), label)}</p>
            // What Payments withholds from this quote (the wallet's credit until the buyer accepts the
            // current terms): marketplace's page does not say, and the payment is then charged in full
            // (chase-sets/chase-sets#10820).
            for reason in &screen.quote.unavailable_reason_details {
                <div class={Banner} data-tone="warning" role="status">
                    <p>{&reason.message}</p>
                </div>
            }
            if let Some(error) = &screen.error {
                <div class={Banner} data-tone="danger" role="alert">
                    <p>{error}</p>
                </div>
            }
            <form id={StartFormId} method="post" action={url::BuyerPaymentNew::default()} class={Fields}>
                <input type="hidden" name={f.order_ids} value={screen.order_ids.join(",")}>
                <label class={Field}>
                    <span class={Label}>{t.payment_method()}</span>
                    <select name={f.payment_method_category} aria-describedby="start-method-says">
                        <option value="card" selected={chosen.payment_method_category == "card"}>{t.card()}</option>
                        <option value="bank-account" selected={chosen.payment_method_category == "bank-account"}>
                            {t.bank_account()}
                        </option>
                        <option
                            value="platform-credit"
                            disabled={credit_only_off}
                            selected={chosen.payment_method_category == "platform-credit"}
                        >
                            {t.platform_credit_only()}
                        </option>
                    </select>
                    <span id="start-method-says" class={Muted}>{t.marketplace_checkout_fee_description()}</span>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.wallet_balance()}</span>
                    <select name={f.balance_credit_mode} aria-describedby="start-wallet-says">
                        <option value="none" selected={chosen.balance_credit_mode == "none"}>{t.do_not_use_balance()}</option>
                        <option value="max" disabled={totals.available <= 0} selected={chosen.balance_credit_mode == "max"}>
                            {t.use_up_to_amount(&money(t, &amount(totals.max_credit)))}
                        </option>
                        <option value="custom" selected={chosen.balance_credit_mode == "custom"}>
                            {t.use_a_custom_amount()}
                        </option>
                    </select>
                    <span id="start-wallet-says" class={Muted}>{&wallet_says}</span>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.custom_wallet_amount()}</span>
                    <input
                        name={f.requested_balance_credit_amount}
                        value={&chosen.requested_balance_credit_amount}
                        placeholder="0.00"
                        inputmode="decimal"
                        aria-describedby="start-custom-says"
                    >
                    <span id="start-custom-says" class={Muted}>{&custom_says}</span>
                </label>
                <button type="submit" class={(Button, Wide)}>{t.continue_to_payment()}</button>
            </form>
        </section>
    }
}

/// The payment summary (`PriceBreakdown`, `OrderProtectionModule` and the seller's evidence at
/// acceptance).
#[component(css = PaymentStartPage)]
fn Summary<'a>(t: PaymentStartMsg, screen: &'a StartScreen) -> impl Render {
    let fee = &screen.quote.marketplace_checkout_fee;
    let totals = &screen.totals;
    let evidence = screen.orders.iter().flat_map(|o| o.listing_evidence.iter()).collect::<Vec<_>>();
    html! {
        <section class={(Card, SummaryCard)} aria-label={t.checkout_summary()}>
            <dl class={Breakdown}>
                <div>
                    <dt>{t.purchases()}</dt>
                    <dd>{screen.orders.len().to_string()}</dd>
                </div>
                <div>
                    <dt>{t.marketplace_sales_fee()}</dt>
                    <dd>{money(t, &amount(totals.sales_fee))}</dd>
                </div>
                <div>
                    <dt>{t.seller_payout()}</dt>
                    <dd>{money(t, &amount(totals.payout))}</dd>
                </div>
                <div>
                    <dt>{t.sales_tax()}</dt>
                    <dd>{money(t, &amount(totals.tax))}</dd>
                </div>
                <div>
                    <dt>{t.marketplace_checkout_fee()}</dt>
                    <dd>{money(t, &fee.marketplace_checkout_fee_amount)}</dd>
                </div>
                if let Some(wallet) = &screen.wallet {
                    <div>
                        <dt>{t.available_balance()}</dt>
                        <dd>{&wallet.available_balance_amount} " " {wallet.currency_code.to_ascii_uppercase()}</dd>
                    </div>
                }
                <div>
                    <dt>{t.payment_method_charge(method(t, &fee.payment_method_category))}</dt>
                    <dd>{money(t, &fee.processor_amount)}</dd>
                </div>
                <div class={Total}>
                    <dt>{t.total_due()}</dt>
                    <dd>{money(t, &fee.total_amount)}</dd>
                </div>
            </dl>
            <p class={Muted}>{t.secure_payment()}</p>
            <h3 class={Strong}>{t.checkout_confidence()}</h3>
            <ul class={Protections}>
                <li>
                    <p class={Strong}>{t.secure_payment()}</p>
                    <p class={Muted}>{t.payment_details_are_collected_by_the()}</p>
                </li>
                <li>
                    <p class={Strong}>{t.buyer_protection()}</p>
                    <p class={Muted}>{t.the_secure_form_can_use_wallets()}</p>
                </li>
                <li>
                    <p class={Strong}>{t.payment_setup()}</p>
                    <p class={Muted}>{t.the_next_step_initializes_a_managed()}</p>
                </li>
            </ul>
            if !evidence.is_empty() {
                <h3 class={Strong}>{t.seller_evidence_at_acceptance()}</h3>
                for line in evidence {
                    <div class={Evidence}>
                        <p class={Strong}>{&line.item_title}</p>
                        <ul class={Photos}>
                            for image in &line.gallery {
                                if let Some(asset) = image
                                    .assets
                                    .iter()
                                    .find(|a| a.role == "catalog-detail")
                                    .or_else(|| image.assets.iter().find(|a| a.role == "search-card"))
                                    .or_else(|| image.assets.first()) {
                                    <li>
                                        <img
                                            src={&asset.public_url}
                                            alt={image.alt_text.clone().unwrap_or_else(|| format!("{} evidence", line.item_title))}
                                            width={asset.width.to_string()}
                                            height={asset.height.to_string()}
                                            loading="lazy"
                                        >
                                    </li>
                                }
                            }
                        </ul>
                        <p class={Muted}>{t.seller_evidence_at_acceptance_description()}</p>
                    </div>
                }
            }
        </section>
    }
}

/// One method's quote: its fee, how much less than the card's it is, and the payment's total.
#[component(css = PaymentStartPage)]
fn Quote<'a>(t: PaymentStartMsg, quote: &'a FeeQuote) -> impl Render {
    let tone = if quote.payment_method_category == "card" { "accent" } else { "success" };
    let reduced = platform::money::cents(&quote.marketplace_checkout_fee_reduction_amount).is_some_and(|c| c > 0);
    html! {
        <li class={Card}>
            <p><span class={Badge} data-tone={tone}>{method(t, &quote.payment_method_category)}</span></p>
            <p class={Strong}>{t.marketplace_checkout_fee_amount(&money(t, &quote.marketplace_checkout_fee_amount))}</p>
            <p class={Muted}>
                if reduced {
                    {t.reduction_from_card(&money(t, &quote.marketplace_checkout_fee_reduction_amount))}
                } else {
                    {t.base_card_checkout_fee()}
                }
            </p>
            <p class={Muted}>{t.final_payment(&money(t, &quote.total_amount))}</p>
        </li>
    }
}

/// One of the purchases: its reference and status, its total and seller payout, and Open purchase.
#[component(css = PaymentStartPage)]
fn Purchase<'a>(t: PaymentStartMsg, order: &'a PaymentOrder) -> impl Render {
    html! {
        <li class={(Card, Line)}>
            <div class={Tight}>
                <p class={Strong}>{t.purchase()}{&order.order_id}</p>
                <p><span class={Badge} data-tone="accent">{&order.status}</span></p>
            </div>
            <div class={Tight}>
                <p class={Muted}>{t.total()}</p>
                <p class={Strong}>{money(t, &order.total_amount)}</p>
            </div>
            <div class={Tight}>
                <p class={Muted}>{t.seller_payout()}</p>
                <p>{money(t, &order.seller_payout_amount)}</p>
            </div>
            <p>
                <a class={(Button, Secondary)} href={url::Purchase { id: &order.order_id, after: Default::default() }}>
                    {t.open_purchase()}
                </a>
            </p>
        </li>
    }
}

/// Orders the account does not have (marketplace's 404 Purchase not found).
#[component(css = PaymentStartPage)]
pub fn PaymentStartMissing(t: PaymentStartMsg) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <div class={Tight}>
                    <p class={Eyebrow}>{t.secure_checkout()}</p>
                    <h1 class={Title}>{t.start_payment()}</h1>
                </div>
                <a class={(Button, Secondary)} href={url::Purchases::default()}>{t.back_to_purchases()}</a>
            </header>
            <div class={Banner} data-tone="warning" role="status">
                <p class={Strong}>{t.purchase_not_found()}</p>
            </div>
        </div>
    }
}
