//! The Seller Desk's money page (Settlement's `SettlementMoneyDashboardPage` and
//! `SettlementPayoutRequestPanel`): the header with Manage payout account, the money at a glance
//! (the wallet, the next payout, the blocked ones), what the last write did, payout setup while it
//! is unfinished, Request a payout or its preview, the payouts that need a next step, every payout
//! with its breakdown, and the wallet's activity.
//!
//! No script. A payout's breakdown is a dialog its button opens (`command="show-modal"`); a wallet
//! adjustment's is a link to the page with its dialog drawn open, modal once it joins the page
//! (corten-ui's `dialog::modalClosedBy`), and Escape goes to its Close link's address, so a
//! reload does not open it again. One column on a phone; the
//! three figures side by side from 48rem, and a row's facts beside its actions from 48rem.
use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::on_marketplace;
use crate::{
    api::{BlockedPayout, Payout, WalletAdjustment, WalletEntry},
    app::url,
    money::{MoneyInput, MoneyScreen, PayoutScreen, Place},
    text::{MoneyMsg, Pilot},
};

/// A payout's breakdown dialog.
#[derive(Id, Clone, Copy)]
pub struct PayoutBreakdownId<'a>(pub &'a str);
/// The open wallet adjustment's dialog.
#[derive(Id, Clone, Copy)]
pub struct AdjustmentDialogId;

const NONE: [(&str, &str); 0] = [];

/// An amount the API sent, in the request's locale (`formatMoney`), or as sent when it is not money.
fn money(t: MoneyMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

fn date(t: MoneyMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
}

fn date_time(t: MoneyMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// A money status code's words (`moneyStatusLabel`): Settlement's label, or the code with its dashes
/// as spaces; a failure's own words as they are.
fn status_label(t: MoneyMsg, code: &str) -> String {
    t.by_key(&format!("status.{}", code.replace('-', "_")), &NONE).map_or_else(|| code.replace('-', " "), |m| m.to_string())
}

/// A payout's status (`payoutStatusLabel`) and its badge's tone (`payoutStatusTone`).
fn payout_status(t: MoneyMsg, status: &str) -> (String, &'static str) {
    match status {
        "requested" => (t.page_requested().to_owned(), "neutral"),
        "in-transit" => (t.page_on_the_way().to_owned(), "accent"),
        "completed" => (t.page_paid().to_owned(), "success"),
        "failed" => (t.page_needs_attention().to_owned(), "danger"),
        other => (other.to_owned(), "neutral"),
    }
}

/// A blocked payout's kind (`attentionKindLabel`).
fn kind(t: MoneyMsg, kind: &str) -> &'static str {
    match kind {
        "failed" => t.page_failed_payout(),
        "missing-provider-reference" => t.page_awaiting_confirmation(),
        _ => t.page_status_check_overdue(),
    }
}

/// An adjustment's status (`walletAdjustmentAccountStatusLabel` and its tone).
fn adjustment_status(t: MoneyMsg, status: &str) -> (&'static str, &'static str) {
    match status {
        "requested" | "approved" => (t.adjustment_status_under_review(), "warning"),
        "rejected" => (t.adjustment_status_not_applied(), "neutral"),
        "posted" => (t.adjustment_status_posted(), "success"),
        _ => (t.adjustment_status_reversed(), "neutral"),
    }
}

/// An adjustment's reason, in the account-facing words (`walletAdjustmentCustomerReasonCategoryLabel`).
fn reason(t: MoneyMsg, code: &str) -> String {
    let key = match code {
        "other-with-required-detail" => "reason.other".to_owned(),
        code => format!("reason.{}", code.replace('-', ".")),
    };
    t.by_key(&key, &NONE).map_or_else(|| t.reason_other().to_owned(), |m| m.to_string())
}

/// Whether the API sent a value (`Boolean(x)`: an empty one is none).
fn present(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.is_empty())
}

/// A label the catalog ends with `": "`, as a breakdown's term.
fn term(label: &str) -> &str {
    label.trim_end_matches(": ")
}

/// A payout's page (Settlement's `SettlementPayoutDetailPage`, without the support details
/// marketplace hides from sellers): the header with Back to payouts, Payout requested after a
/// request, the summary (the status, a failed payout's next step, the amounts and moments, the last
/// provider check) and the status timeline as a list of steps.
#[component(css = MoneyPage)]
pub fn PayoutPage<'a>(t: MoneyMsg, screen: &'a PayoutScreen) -> impl Render {
    let payout = &screen.payout;
    let currency = payout.currency_code.as_str();
    let net = money(t, &payout.net_amount, currency);
    let requested_at = date_time(t, &payout.requested_at);
    let transfer = present(&payout.provider_transfer_reference) || present(&payout.sent_at);
    let submitted = present(&payout.provider_payout_reference) || present(&payout.sent_at);
    let completed = payout.status == "completed";
    let failed = payout.status == "failed";
    let failure = status_label(t, payout.failure_reason.as_deref().unwrap_or("recent-payout-failure"));
    let status = match payout.status.as_str() {
        "requested" => t.detail_requested().to_owned(),
        "in-transit" => t.detail_on_the_way().to_owned(),
        "completed" => t.detail_paid().to_owned(),
        "failed" => t.detail_needs_attention().to_owned(),
        other => other.to_owned(),
    };
    let tone = if failed {
        "danger"
    } else if completed {
        "success"
    } else {
        "info"
    };
    let said = if failed {
        failure.clone()
    } else {
        payout.note.clone().unwrap_or_else(|| t.detail_payout_account_saved_payout_account().to_owned())
    };
    let moments = [
        (t.detail_sent(), &payout.sent_at),
        (t.detail_completed(), &payout.completed_at),
        (t.detail_failed(), &payout.failed_at),
    ];
    let event = payout.last_provider_event_at.as_deref().map(|at| date_time(t, at));
    let (last, last_says, last_status) = if failed {
        (t.detail_needs_attention_2(), failure.clone(), "issue")
    } else if completed {
        let when = payout
            .completed_at
            .as_deref()
            .map_or_else(|| t.detail_usually_1_3_business_days_after().to_owned(), |at| date_time(t, at));
        (t.detail_paid_2(), when, "complete")
    } else {
        (t.detail_paid_2(), t.detail_usually_1_3_business_days_after().to_owned(), "current")
    };
    let steps = [
        (t.detail_requested_3(), requested_at.clone(), "complete"),
        (
            t.detail_provider_transfer_submitted(),
            if transfer { t.page_provider_accepted_transfer() } else { t.detail_waiting_for_provider_transfer_reference() }
                .to_owned(),
            if transfer { "complete" } else { "upcoming" },
        ),
        (
            t.detail_payout_submitted(),
            if submitted { t.page_provider_accepted_payout() } else { t.detail_waiting_for_provider_payout_reference() }
                .to_owned(),
            if submitted { "complete" } else { "upcoming" },
        ),
        (
            t.detail_provider_event_received(),
            event.clone().unwrap_or_else(|| t.detail_waiting_for_provider_event().to_owned()),
            if event.is_some() { "complete" } else { "upcoming" },
        ),
        (last, last_says, last_status),
    ];
    html! {
        <header class={Header}>
            <div class={Tight}>
                <p class={Eyebrow}>{t.detail_settlement()}</p>
                <h1 class={Title}>{t.detail_payout_title(&payout.display_reference)}</h1>
                <p class={Muted}>{t.payout_net_payout_amount(&net)}</p>
            </div>
            <a class={(Button, Secondary)} href={url::Money::default()}>{t.detail_back_to_payouts()}</a>
        </header>
        if screen.requested {
            <section class={Section} aria-labelledby="payout-requested-title">
                <h2 id="payout-requested-title" class={PartTitle}>{t.detail_payout_requested()}</h2>
                <div class={Banner} data-tone="success" role="status">
                    <p class={Strong}>{t.detail_payout_requested_2()}</p>
                    <p>{t.detail_amount_is_being_sent_to_your_saved(&net)}</p>
                </div>
            </section>
        }
        <section class={Section} aria-labelledby="payout-summary-title">
            <h2 id="payout-summary-title" class={PartTitle}>{t.detail_summary()}</h2>
            <div class={Banner} data-tone={tone}>
                <p class={Strong}>{&status}</p>
                <p>{&said}</p>
            </div>
            if failed {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.detail_payout_account_needs_review()}</p>
                    <p>{t.detail_review_payout_details_before_requesting()}</p>
                    <p class={Row}>
                        <a
                            class={(Button, Secondary)}
                            href={url::PayoutSetup { place: crate::payout_setup::Place::of(crate::payout_setup::Mode::Management, None) }}
                        >
                            {t.detail_review_payout_details()}
                        </a>
                        <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.detail_contact_support()}</a>
                    </p>
                </div>
            }
            <dl class={(Card, Breakdown)}>
                <div>
                    <dt>{t.payout_requested_amount()}</dt>
                    <dd>{money(t, &payout.requested_amount, currency)}</dd>
                </div>
                <div>
                    <dt>{t.payout_fee()}</dt>
                    <dd>{money(t, &payout.fee_amount, currency)}</dd>
                </div>
                <div>
                    <dt>{term(t.detail_requested_2())}</dt>
                    <dd>{&requested_at}</dd>
                </div>
                for (label, at) in moments {
                    if let Some(at) = at {
                        <div>
                            <dt>{term(label)}</dt>
                            <dd>{date_time(t, at)}</dd>
                        </div>
                    }
                }
                <div class={Total}>
                    <dt>{t.payout_net_payout()}</dt>
                    <dd>{&net}</dd>
                </div>
            </dl>
            if let Some(at) = &payout.last_reconciled_at {
                <div class={Banner} data-tone="neutral">
                    <p class={Strong}>{term(t.detail_last_provider_check())}</p>
                    <p>{date_time(t, at)}</p>
                </div>
            }
        </section>
        <section class={Section} aria-labelledby="payout-timeline-title">
            <h2 id="payout-timeline-title" class={PartTitle}>{t.detail_status_timeline()}</h2>
            <ol class={Timeline}>
                for (label, says, status) in steps {
                    <li class={Step} data-status={status} aria-current={(status == "current").then_some("step")}>
                        <p class={Strong}>{label}</p>
                        <p class={Muted}>{&says}</p>
                    </li>
                }
            </ol>
        </section>
    }
}

/// A requested payout Settlement has not caught up to (`SettlementPayoutDetailRecoveryPage`).
#[component(css = MoneyPage)]
pub fn PayoutPreparing(t: MoneyMsg) -> impl Render {
    html! {
        <header class={Header}>
            <div class={Tight}>
                <p class={Eyebrow}>{t.detail_settlement()}</p>
                <h1 class={Title}>{t.route_payout_preparing()}</h1>
                <p class={Muted}>{t.route_payout_preparing_description()}</p>
            </div>
            <a class={(Button, Secondary)} href={url::Money::default()}>{t.detail_back_to_payouts()}</a>
        </header>
        <section class={Section} aria-labelledby="payout-summary-title">
            <h2 id="payout-summary-title" class={PartTitle}>{t.detail_summary()}</h2>
            <div class={Banner} data-tone="info" role="status">
                <p class={Strong}>{t.route_payout_preparing()}</p>
                <p>{t.route_payout_preparing_description()}</p>
            </div>
        </section>
    }
}

/// The page.
#[component(css)]
pub fn MoneyPage<'a>(t: MoneyMsg, p: Pilot, screen: &'a MoneyScreen) -> impl Render {
    let wallet = &screen.wallet;
    let currency = wallet.currency_code.as_str();
    let said = &screen.said;
    let summary = &screen.summary;
    let complete = summary.complete();
    let incomplete = status_label(t, "payout-summary-incomplete");
    let blocked_count = summary.blocked_payouts.len();
    let blocked_words = if !complete {
        incomplete.clone()
    } else if blocked_count == 1 {
        t.page_one_needs_attention().to_owned()
    } else {
        t.page_many_need_attention(blocked_count).to_string()
    };
    let settings = url::PayoutSetup::default();
    html! {
        <header class={Header}>
            <div class={Tight}>
                <p class={Eyebrow}>{t.page_seller_desk()}</p>
                <h1 class={Title}>{t.page_title()}</h1>
                <p class={Muted}>{t.page_description()}</p>
            </div>
            if screen.may.setup {
                <a class={(Button, Secondary)} href={&settings}>{t.page_manage_payout_account()}</a>
            }
        </header>
        <section class={Section} aria-labelledby="money-glance-title">
            <h2 id="money-glance-title" class={PartTitle}>{t.page_at_aglance()}</h2>
            <dl class={Figures}>
                <div class={Figure}>
                    <dt>{t.page_wallet_balance()}</dt>
                    <dd class={Number}>{money(t, &wallet.available_balance_amount, currency)}</dd>
                    <dd class={Muted}>{t.page_pending_balance(&money(t, &wallet.pending_balance_amount, currency))}</dd>
                </div>
                <div class={Figure}>
                    <dt>{t.page_next_payout()}</dt>
                    if !complete {
                        <dd class={Number}>{&incomplete}</dd>
                        <dd class={Muted}>{&incomplete}</dd>
                    } else if let Some(next) = &summary.next_payout {
                        <dd class={Number}>{money(t, &next.amount, &next.currency_code)}</dd>
                        <dd class={Muted}>{t.page_estimated_by(&date(t, &next.estimated_arrival_at))}</dd>
                    } else {
                        <dd class={Number}>{t.page_none_scheduled()}</dd>
                        <dd class={Muted}>{t.page_request_when_ready()}</dd>
                    }
                </div>
                <div class={Figure}>
                    <dt>{t.page_blocked()}</dt>
                    <dd class={Number}>{&blocked_words}</dd>
                    if complete {
                        <dd class={Muted}>{t.page_blocked_detail()}</dd>
                    } else {
                        <dd class={Muted}>{&incomplete}</dd>
                    }
                </div>
            </dl>
        </section>
        if let Some(adjustment) = &screen.adjustment {
            <AdjustmentDialog t={t} p={p} adjustment={adjustment} />
        }
        <div class={Notices} role="status" aria-live="polite">
            if let Some(error) = &said.error {
                <div class={Banner} data-tone="danger" tabindex="-1" autofocus>
                    <p class={Strong}>{t.page_action_failed()}</p>
                    <p>{error}</p>
                </div>
            }
            if let Some(checked) = &said.checked {
                <div class={Banner} data-tone="info" tabindex="-1" autofocus>
                    <p class={Strong}>{t.page_status_check_queued()}</p>
                    <p>{checked}</p>
                </div>
            }
            if !complete {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.page_payout_attention()}</p>
                    <p>{&incomplete}</p>
                </div>
            }
        </div>
        if screen.setup_incomplete() {
            <section class={Section} aria-labelledby="money-setup-title">
                <h2 id="money-setup-title" class={PartTitle}>{t.page_needs_attention()}</h2>
                <div class={(Banner, Row)} data-tone="warning">
                    <div class={Tight}>
                        <p class={Strong}>{t.page_finish_payout_setup()}</p>
                        <p>{status_label(t, "payout-setup-incomplete")}</p>
                    </div>
                    if screen.may.setup {
                        <a class={(Button, Secondary)} href={&settings}>{t.page_finish_payout_setup()}</a>
                    }
                </div>
            </section>
        }
        <section class={Section} aria-labelledby="money-request-title">
            <h2 id="money-request-title" class={PartTitle}>{t.page_request_payout()}</h2>
            <div class={Card} data-payout-request>
                match &said.confirmation {
                    Some(_) => { <Confirm t={t} p={p} screen={screen} /> }
                    None => { <RequestForm t={t} screen={screen} /> }
                }
            </div>
        </section>
        <section class={Section} aria-labelledby="money-attention-title">
            <h2 id="money-attention-title" class={PartTitle}>{t.page_payout_attention()}</h2>
            if summary.blocked_payouts.is_empty() {
                <div class={(Card, Empty)}>
                    <p class={Strong}>{t.page_no_blocked_payouts()}</p>
                    <p class={Muted}>{t.page_no_blocked_payouts_detail()}</p>
                </div>
            } else {
                <ul class={Rows}>
                    for row in &summary.blocked_payouts {
                        <BlockedRow t={t} row={row} reconcile={screen.may.reconcile} />
                    }
                </ul>
            }
        </section>
        <section class={Section} aria-labelledby="money-timeline-title">
            <h2 id="money-timeline-title" class={PartTitle}>{t.page_payout_timeline()}</h2>
            if summary.items.is_empty() {
                <p class={Muted}>{t.page_none_scheduled()}</p>
            } else {
                <ol class={Rows}>
                    for payout in &summary.items {
                        <PayoutRow t={t} p={p} payout={payout} />
                    }
                </ol>
            }
        </section>
        <section class={Section} aria-labelledby="money-activity-title">
            <h2 id="money-activity-title" class={PartTitle}>{t.page_wallet_activity()}</h2>
            if screen.entries.is_empty() {
                <div class={(Card, Empty)}>
                    <p class={Strong}>{t.page_no_wallet_activity()}</p>
                    <p class={Muted}>{t.page_no_wallet_activity_detail()}</p>
                </div>
            } else {
                <ol class={Rows}>
                    for entry in &screen.entries {
                        <EntryRow t={t} entry={entry} />
                    }
                </ol>
            }
        </section>
    }
}

/// Request a payout's form: the balance, why a payout is unavailable, the amount, the two quick
/// amounts, an optional note, the fee terms and Preview payout.
#[component(css = MoneyPage)]
fn RequestForm<'a>(t: MoneyMsg, screen: &'a MoneyScreen) -> impl Render {
    let f = MoneyInput::FIELDS;
    let wallet = &screen.wallet;
    let currency = wallet.currency_code.as_str();
    let quick = &screen.quick_amounts;
    let availability = &screen.summary.availability;
    let on = availability.can_request;
    let full = platform::money::cents(&quick.full_available_amount).is_some_and(|c| c > 0);
    let draft = screen.said.draft.as_ref();
    let amount = draft.map_or("", |d| d.amount.as_str());
    let note = draft.and_then(|d| d.note.as_deref()).unwrap_or_default();
    html! {
        <form class={Form} method="post" action={url::Money::default()}>
            <input type="hidden" name={f.intent} value="preview-payout">
            <p class={Muted}>{t.page_available_to_request(&money(t, &wallet.available_balance_amount, currency))}</p>
            if !on && !availability.unavailable_reasons.is_empty() {
                <Reasons t={t} reasons={availability.unavailable_reasons.iter().map(|code| status_label(t, code)).collect()} />
            }
            <label class={Field}>
                <span class={Label}>{t.page_payout_amount()}</span>
                <input
                    type="text"
                    name={f.amount}
                    value={amount}
                    inputmode="decimal"
                    placeholder="0.00"
                    autocomplete="off"
                    required
                    disabled={!on}
                >
            </label>
            <div class={Row}>
                // A quick amount sends the form without the typed amount's check.
                <button
                    type="submit"
                    class={(Button, Secondary)}
                    name={f.quick_amount}
                    value="minimum"
                    formnovalidate
                    disabled={!on}
                >
                    {t.page_minimum_amount(&money(t, &quick.minimum_amount, currency))}
                </button>
                <button
                    type="submit"
                    class={(Button, Secondary)}
                    name={f.quick_amount}
                    value="available"
                    formnovalidate
                    disabled={!on || !full}
                >
                    {t.page_full_available(&money(t, &quick.full_available_amount, currency))}
                </button>
            </div>
            <details class={Fold} open={!note.is_empty()}>
                <summary>
                    <span class={Strong}>{t.page_optional_note()}</span>
                    <span class={Muted}>{if note.is_empty() { t.page_optional_note_summary() } else { note }}</span>
                </summary>
                <label class={Field}>
                    <span class={Label}>{t.page_optional_note()}</span>
                    <input type="text" name={f.note} value={note} disabled={!on}>
                </label>
            </details>
            <FeeTerms t={t} />
            <div class={Row}>
                <button type="submit" class={Button} disabled={!on}>{t.page_preview_payout()}</button>
            </div>
        </form>
    }
}

/// A preview waiting for Confirm: its breakdown, the balance after it, why it cannot be
/// requested, and Confirm payout (with the form's attempt) or Edit payout.
#[component(css = MoneyPage)]
fn Confirm<'a>(t: MoneyMsg, p: Pilot, screen: &'a MoneyScreen) -> impl Render {
    let f = MoneyInput::FIELDS;
    let currency = screen.wallet.currency_code.as_str();
    let confirmation = screen.said.confirmation.as_ref();
    html! {
        if let Some(c) = confirmation {
            <div class={Form}>
                <p class={Strong}>{t.page_confirm_payout()}</p>
                <dl class={Breakdown}>
                    <div>
                        <dt>{t.payout_requested_amount()}</dt>
                        <dd>{money(t, &c.preview.requested_amount, currency)}</dd>
                    </div>
                    for line in &c.preview.fee_lines {
                        <div>
                            <dt>{&line.label}</dt>
                            <dd>{money(t, &line.amount, currency)}</dd>
                        </div>
                    }
                    <div class={Total}>
                        <dt>{t.payout_net_payout()}</dt>
                        <dd>{money(t, &c.preview.net_amount, currency)}</dd>
                    </div>
                </dl>
                <p>{t.page_available_after(&money(t, &c.preview.estimated_wallet_balance_after, currency))}</p>
                if !c.preview.unavailable_reason_details.is_empty() {
                    <Reasons t={t} reasons={c.preview.unavailable_reason_details.iter().map(|r| r.message.clone()).collect()} />
                }
                <FeeTerms t={t} />
                <div class={Row}>
                    <form method="post" action={url::Money::default()}>
                        <input type="hidden" name={f.intent} value="confirm-payout">
                        <input type="hidden" name={f.amount} value={&c.amount}>
                        if let Some(note) = &c.note {
                            <input type="hidden" name={f.note} value={note}>
                        }
                        {SubmitKey::field(f.attempt)}
                        <button type="submit" class={Button} disabled={!c.preview.can_request}>{t.page_confirm_payout()}</button>
                    </form>
                    <form method="post" action={url::Money::default()}>
                        <input type="hidden" name={f.intent} value="edit-payout">
                        <input type="hidden" name={f.amount} value={&c.amount}>
                        if let Some(note) = &c.note {
                            <input type="hidden" name={f.note} value={note}>
                        }
                        <button type="submit" class={(Button, Secondary)}>{t.page_edit_payout()}</button>
                    </form>
                    <a class={(Button, Ghost)} href={url::Money::default()}>{p.addresses_cancel()}</a>
                </div>
            </div>
        }
    }
}

/// Why a payout is unavailable, open (`ProgressiveDisclosure` with `defaultOpen`).
#[component(css = MoneyPage)]
fn Reasons(t: MoneyMsg, reasons: Vec<String>) -> impl Render {
    html! {
        <details class={(Fold, Warning)} open>
            <summary>
                <span class={Strong}>{t.page_payout_blocked()}</span>
                <span class={Muted}>{reasons.first().cloned().unwrap_or_default()}</span>
            </summary>
            <ul class={Plain}>
                for reason in reasons.iter() {
                    <li>{reason}</li>
                }
            </ul>
        </details>
    }
}

/// The payout fee's terms and the seller's fees (`PayoutFeeDisclosureLinks`).
#[component(css = MoneyPage)]
fn FeeTerms(t: MoneyMsg) -> impl Render {
    html! {
        <div class={Row}>
            <a class={(Button, Ghost)} href={&on_marketplace("/payments-terms#payout-fee")}>{t.payout_fee_terms()}</a>
            <a class={(Button, Ghost)} href={&on_marketplace("/seller-agreement#fees-and-deductions")}>
                {t.payout_seller_fees()}
            </a>
        </div>
    }
}

/// A blocked payout: its reference, why, and its next step (Retry payout or Check status, for an
/// account that may reconcile) and Contact support.
#[component(css = MoneyPage)]
fn BlockedRow<'a>(t: MoneyMsg, row: &'a BlockedPayout, reconcile: bool) -> impl Render {
    let f = MoneyInput::FIELDS;
    let tone = if row.kind == "failed" { "danger" } else { "warning" };
    html! {
        <li class={(Card, Line)} data-blocked-payout={&row.payout_id}>
            <div class={Tight}>
                <p class={Strong}>{&row.reference}</p>
                <p><span class={Badge} data-tone={tone}>{kind(t, &row.kind)}</span></p>
                <p class={Muted}>{status_label(t, &row.block_reason)}</p>
            </div>
            <div class={Row}>
                if reconcile {
                    <form method="post" action={url::Money::default()}>
                        <input type="hidden" name={f.intent} value={&row.next_action}>
                        <button type="submit" class={Button}>
                            {if row.next_action == "retry" { t.page_retry_payout() } else { t.page_check_status() }}
                        </button>
                    </form>
                }
                <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.page_contact_support()}</a>
            </div>
        </li>
    }
}

/// A payout in the timeline: its reference and status, what reaches the seller, when it last
/// changed, and View breakdown, a dialog with its amounts and moments and Open payout.
#[component(css = MoneyPage)]
fn PayoutRow<'a>(t: MoneyMsg, p: Pilot, payout: &'a Payout) -> impl Render {
    let (status, tone) = payout_status(t, &payout.status);
    let currency = payout.currency_code.as_str();
    let id = PayoutBreakdownId(&payout.payout_id);
    let title = format!("breakdown-{}", payout.payout_id);
    let open = url::DeskPayout { id: &payout.payout_id, place: Default::default() };
    html! {
        <li class={(Card, Line)} data-payout={&payout.payout_id}>
            <div class={Tight}>
                <p class={Row}>
                    <span class={Strong}>{&payout.display_reference}</span>
                    <span class={Badge} data-tone={tone}>{&status}</span>
                </p>
                <p>{t.payout_net_payout()}": "<span class={Number}>{money(t, &payout.net_amount, currency)}</span></p>
                <p class={Muted}>{date_time(t, &payout.updated_at)}</p>
            </div>
            <div class={Row}>
                <button type="button" class={(Button, Secondary)} command="show-modal" commandfor={id}>
                    {t.page_view_breakdown()}
                </button>
            </div>
            <dialog id={id} class={Dialog} aria-labelledby={&title}>
                <h3 id={&title} class={PartTitle}>{t.page_payout_breakdown(&payout.display_reference)}</h3>
                <p class={Muted}>{&status}</p>
                <dl class={Breakdown}>
                    <div>
                        <dt>{t.payout_requested_amount()}</dt>
                        <dd>{money(t, &payout.requested_amount, currency)}</dd>
                    </div>
                    <div>
                        <dt>{t.payout_fee()}</dt>
                        <dd>{money(t, &payout.fee_amount, currency)}</dd>
                    </div>
                    <div>
                        <dt>{t.page_requested()}</dt>
                        <dd>{date_time(t, &payout.requested_at)}</dd>
                    </div>
                    if let Some(sent) = &payout.sent_at {
                        <div>
                            <dt>{t.page_sent()}</dt>
                            <dd>{date_time(t, sent)}</dd>
                        </div>
                    }
                    if let Some(completed) = &payout.completed_at {
                        <div>
                            <dt>{t.page_completed()}</dt>
                            <dd>{date_time(t, completed)}</dd>
                        </div>
                    }
                    <div class={Total}>
                        <dt>{t.payout_net_payout()}</dt>
                        <dd>{money(t, &payout.net_amount, currency)}</dd>
                    </div>
                </dl>
                <div class={Row}>
                    <a class={(Button, Secondary)} href={&open}>{t.page_open_payout()}</a>
                    <button type="button" class={(Button, Ghost)} command="close" commandfor={id}>{p.addresses_close()}</button>
                </div>
            </dialog>
        </li>
    }
}

/// A wallet movement: what it was, its amount, whether the money is available yet, when it posted,
/// and an adjustment's View breakdown.
#[component(css = MoneyPage)]
fn EntryRow<'a>(t: MoneyMsg, entry: &'a WalletEntry) -> impl Render {
    let activity = match (entry.kind.as_str(), &entry.description) {
        ("adjustment", _) => t.page_wallet_adjustment().to_owned(),
        (_, Some(description)) if !description.is_empty() => description.clone(),
        (kind, _) => kind.to_owned(),
    };
    let tone = if entry.funds_status == "available" { "success" } else { "warning" };
    let breakdown =
        (entry.kind == "adjustment").then_some(entry.adjustment_display_reference.as_deref()).flatten().filter(|r| !r.is_empty());
    html! {
        <li class={(Card, Line)}>
            <div class={Tight}>
                <p class={Strong}>{&activity}</p>
                <p class={Row}>
                    <span class={Number}>{money(t, &entry.amount, &entry.currency_code)}</span>
                    <span class={Badge} data-tone={tone}>{&entry.funds_status}</span>
                </p>
                <p class={Muted}>{t.page_posted()}" "{date(t, &entry.posted_at)}</p>
            </div>
            if let Some(reference) = breakdown {
                <div class={Row}>
                    <a class={(Button, Secondary)} href={url::Money { place: Place::adjustment(reference) }}>
                        {t.page_view_breakdown()}
                    </a>
                </div>
            }
        </li>
    }
}

/// A wallet adjustment's breakdown, drawn open; Close goes back to the page.
#[component(css = MoneyPage)]
fn AdjustmentDialog<'a>(t: MoneyMsg, p: Pilot, adjustment: &'a WalletAdjustment) -> impl Render {
    let (status, tone) = adjustment_status(t, &adjustment.status);
    let direction = if adjustment.direction == "credit" {
        (t.adjustment_direction_credit(), "success")
    } else {
        (t.adjustment_direction_debit(), "danger")
    };
    let currency = adjustment.currency_code.as_str();
    let close = refs();
    html! {
        <dialog
            id={AdjustmentDialogId}
            class={Dialog}
            aria-labelledby="adjustment-title"
            aria-describedby="adjustment-description"
            open
            on:connect={corten_ui::dialog::modalClosedBy(target, close, signal)}
        >
            <div class={Row}>
                <h2 id="adjustment-title" class={PartTitle}>{t.page_wallet_adjustment_title(&adjustment.display_reference)}</h2>
                <a ref={close} class={(Button, Ghost)} href={url::Money::default()}>{p.addresses_close()}</a>
            </div>
            <p id="adjustment-description" class={Muted}>{t.page_wallet_adjustment_description()}</p>
            <p class={Row}>
                <span class={Badge} data-tone={tone}>{status}</span>
                <span class={Strong}>{&adjustment.display_reference}</span>
            </p>
            <dl class={Breakdown}>
                <div>
                    <dt>{t.page_direction()}</dt>
                    <dd><span class={Badge} data-tone={direction.1}>{direction.0}</span></dd>
                </div>
                <div>
                    <dt>{t.page_amount()}</dt>
                    <dd>{money(t, &adjustment.amount, currency)}</dd>
                </div>
                <div>
                    <dt>{t.page_reason()}</dt>
                    <dd>{reason(t, &adjustment.reason_code)}</dd>
                </div>
                <div>
                    <dt>{t.page_requested()}</dt>
                    <dd>{date(t, &adjustment.requested_at)}</dd>
                </div>
                if let Some(after) = &adjustment.available_balance_after {
                    <div>
                        <dt>{t.page_resulting_balance()}</dt>
                        <dd>{money(t, after, currency)}</dd>
                    </div>
                }
            </dl>
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.page_wallet_adjustment_safe_title()}</p>
                <p>{t.page_wallet_adjustment_safe_description()}</p>
            </div>
            <div class={Row}>
                <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.page_contact_support()}</a>
            </div>
        </dialog>
    }
}
