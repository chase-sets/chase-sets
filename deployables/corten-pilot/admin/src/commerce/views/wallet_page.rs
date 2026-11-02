//! The Wallet Workbench (`SettlementWalletWorkbenchPage`). Top to bottom: the header, the balance (its
//! four figures one to a row on a phone, two from 40rem and four from 64rem), the guided credit or
//! debit (its steps, the form, and the preview with Confirm & submit), the adjustment history with
//! each row's Approve, Reject or Reverse, and the ledger. The tables scroll on their own on a phone.
//! Every command asks first in a dialog, as admin-web's `AlertDialog` does, so a bare Enter cannot
//! post one; the dialogs open with the browser's own `command` buttons, without JavaScript.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    api::segment,
    commerce::{
        money,
        wallet::{
            APPROVE_INTENT, Adjustment, CommandForm, DETAIL_REQUIRED, Kind, PREVIEW, REASONS, REJECT_INTENT, REQUEST,
            REVERSE_INTENT, Refusal, STATUSES, WalletScreen, url,
        },
    },
    text::Com,
};

fn when(t: Com, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string())
}

fn direction_label(t: Com, direction: &str) -> &'static str {
    if direction == "credit" { t.wa_copy_credit() } else { t.wa_copy_debit() }
}

fn reason_label(t: Com, reason: &str) -> &'static str {
    match reason {
        "refund-correction" => t.wa_copy_refund_correction(),
        "fee-correction" => t.wa_copy_fee_correction(),
        "dispute-resolution" => t.wa_copy_dispute_resolution(),
        "fraud-recovery" => t.wa_copy_fraud_recovery(),
        "support-resolution" => t.wa_copy_support_resolution(),
        "legal-obligation" => t.wa_copy_legal_obligation(),
        "goodwill-cash-credit" => t.wa_copy_goodwill_cash_credit(),
        "operational-error" => t.wa_copy_operational_error(),
        "other-with-required-detail" => t.wa_copy_other_requires_explanation(),
        _ => t.wa_copy_transaction_correction(),
    }
}

fn status_label(t: Com, status: &str) -> &'static str {
    match status {
        "requested" => t.wa_copy_awaiting_approval(),
        "approved" => t.wa_copy_approved_posting(),
        "rejected" => t.wa_copy_rejected(),
        "posted" => t.wa_copy_posted(),
        "reversed" => t.wa_copy_reversed(),
        _ => t.ww_filter_all(),
    }
}

fn elevation_label(t: Com, reason: &str) -> &'static str {
    match reason {
        "high-value" => t.wa_copy_high_value_amount(),
        "negative-balance" => t.wa_copy_creates_or_deepens_a_negative_balance(),
        _ => t.wa_copy_reversal_of_settled_funds(),
    }
}

/// A refusal's title and whether it is a warning (else it is danger), as admin-web's
/// `walletAdjustmentFlowErrorTitle` and `walletAdjustmentFlowErrorTone` have them.
fn refusal_title(t: Com, kind: Kind) -> (&'static str, bool) {
    match kind {
        Kind::Validation => (t.wa_copy_check_the_adjustment_details(), true),
        Kind::StalePreview => (t.wa_copy_balance_changed_since_preview(), true),
        Kind::StepUpRequired => (t.wa_copy_reauthentication_required(), true),
        Kind::RequiresElevatedApproval => (t.wa_copy_second_approval_required(), true),
        Kind::SelfBenefitingBlocked => (t.wa_copy_self_benefiting_adjustment_blocked(), false),
        Kind::NotFound => (t.wa_copy_adjustment_not_found(), false),
        Kind::Forbidden => (t.wa_copy_not_authorized(), false),
        Kind::AuthenticationRequired => (t.wa_copy_sign_in_required(), false),
        Kind::Conflict => (t.wa_copy_action_could_not_be_completed(), false),
        Kind::Unknown => (t.wa_copy_something_went_wrong(), false),
    }
}

/// A dialog's id, by what it does and the adjustment it does it to.
fn dialog_id(what: &str, adjustment: &str) -> String {
    let safe: String =
        adjustment.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
    format!("wallet-{what}-{safe}")
}

/// A refusal where it was made: its title, the API's message, the fields it named, and a new sign-in
/// in another tab when the session is too old for the command.
#[component(css = WalletPage)]
fn Refused<'a>(t: Com, refusal: &'a Refusal, sign_in: &'a str) -> impl Render {
    let (title, warning) = refusal_title(t, refusal.kind);
    let again = matches!(refusal.kind, Kind::StepUpRequired | Kind::AuthenticationRequired);
    html! {
        <div class={(Banner, if warning { Warning } else { Danger })} role="alert">
            <p class={Strong}>{title}</p>
            <p>{&refusal.message}</p>
            if !refusal.fields.is_empty() {
                <ul class={Fields}>
                    for field in &refusal.fields {
                        <li>{field}</li>
                    }
                </ul>
            }
            if again {
                <a class={(Button, Secondary, Small)} href={sign_in} target="_blank" rel="noreferrer">
                    {t.wa_reauth_sign_in_again_in_new_tab()}
                </a>
            }
        </div>
    }
}

#[component(css = WalletPage)]
fn Figure<'a>(label: &'a str, value: String) -> impl Render {
    html! {
        <div class={Figure}>
            <span class={Muted}>{label}</span>
            <span class={Amount}>{value}</span>
        </div>
    }
}

/// A command that asks first: the button opens a dialog that says what will happen and sends the
/// form, with the fields the command takes.
#[component(css = WalletPage)]
fn Ask<'a, C: Render>(
    id: &'a str,
    label: &'a str,
    danger: bool,
    title: &'a str,
    description: &'a str,
    confirm: &'a str,
    cancel: &'a str,
    action: &'a url::Wallet<'a>,
    intent: &'a str,
    adjustment: &'a str,
    disabled: bool,
    children: C,
) -> impl Render {
    let f = CommandForm::FIELDS;
    let tone = if danger { Danger } else { Primary };
    html! {
        <button type="button" class={(Button, tone)} command="show-modal" commandfor={id} disabled={disabled}>{label}</button>
        <dialog class={Confirm} id={id} aria-label={title}>
            <form method="post" action={action}>
                <input type="hidden" name={f.intent} value={intent}>
                if !adjustment.is_empty() {
                    <input type="hidden" name={f.adjustment_id} value={adjustment}>
                }
                <h3>{title}</h3>
                <p class={Muted}>{description}</p>
                {children}
                <div class={Buttons}>
                    <button type="button" class={(Button, Secondary)} command="close" commandfor={id}>{cancel}</button>
                    <button type="submit" class={(Button, tone)}>{confirm}</button>
                </div>
            </form>
        </dialog>
    }
}

/// A requested adjustment's Approve and Reject, for an approver; the requester sees why they
/// cannot (the API refuses them too).
#[component(css = WalletPage)]
fn Approval<'a>(
    t: Com,
    screen: &'a WalletScreen,
    row: &'a Adjustment,
    refusal: Option<&'a Refusal>,
    label: &'a str,
) -> impl Render {
    html! {
        let f = CommandForm::FIELDS;
        let own = row.requested_by == screen.user_id;
        let elevated = row.elevation_required || refusal.is_some_and(|r| r.kind == Kind::RequiresElevatedApproval);
        let action = url::Wallet { id: &screen.account_id, view: screen.route_view() };
        let amount = money(t, &row.amount, &row.currency_code);
        let approve = dialog_id("approve", &row.adjustment_id);
        let reject = dialog_id("reject", &row.adjustment_id);
        let description = t.wa_approval_approve_description(&amount, label).to_string();
        if own {
            <div class={(Banner, Warning)}>
                <p class={Strong}>{t.wa_approval_you_requested_this_adjustment()}</p>
                <p>{t.wa_approval_another_platform_admin_must_approve()}</p>
            </div>
        }
        <div class={Buttons}>
            <Ask
                id={&approve}
                label={t.wa_approval_approve()}
                danger={false}
                title={t.wa_approval_approve_title()}
                description={&description}
                confirm={t.wa_approval_approve_confirm()}
                cancel={t.wa_approval_cancel()}
                action={&action}
                intent={APPROVE_INTENT}
                adjustment={&row.adjustment_id}
                disabled={own}
            >
                if elevated {
                    <p class={Muted}>{t.wa_approval_elevation_explanation()}</p>
                    <label class={Field}>
                        <span>{t.wa_approval_elevation_approver()}</span>
                        <input
                            type="text"
                            name={f.elevation_approved_by_user_id}
                            placeholder="usr_..."
                            required
                            autocomplete="off"
                        >
                    </label>
                }
            </Ask>
            <Ask
                id={&reject}
                label={t.wa_approval_reject()}
                danger={true}
                title={t.wa_approval_reject_title()}
                description={t.wa_approval_reject_description()}
                confirm={t.wa_approval_reject_confirm()}
                cancel={t.wa_approval_cancel()}
                action={&action}
                intent={REJECT_INTENT}
                adjustment={&row.adjustment_id}
                disabled={own}
            >
                <label class={Field}>
                    <span>{t.wa_approval_rejection_reason()}</span>
                    <textarea name={f.rejection_reason} rows="3"></textarea>
                </label>
            </Ask>
        </div>
    }
}

/// A posted adjustment's Reverse: always with an approver and a distinct elevated approver.
#[component(css = WalletPage)]
fn Reversal<'a>(t: Com, screen: &'a WalletScreen, row: &'a Adjustment, label: &'a str) -> impl Render {
    html! {
        let f = CommandForm::FIELDS;
        let action = url::Wallet { id: &screen.account_id, view: screen.route_view() };
        let amount = money(t, &row.amount, &row.currency_code);
        let id = dialog_id("reverse", &row.adjustment_id);
        let description = t.wa_reversal_confirm_description(&amount, label).to_string();
        <Ask
            id={&id}
            label={t.wa_reversal_reverse()}
            danger={true}
            title={t.wa_reversal_confirm_title()}
            description={&description}
            confirm={t.wa_reversal_confirm_reverse()}
            cancel={t.wa_reversal_cancel()}
            action={&action}
            intent={REVERSE_INTENT}
            adjustment={&row.adjustment_id}
            disabled={false}
        >
            <p class={Muted}>{t.wa_reversal_reversal_explanation()}</p>
            <label class={Field}>
                <span>{t.wa_reversal_approver()}</span>
                <input type="text" name={f.approved_by_user_id} placeholder="usr_..." required autocomplete="off">
            </label>
            <label class={Field}>
                <span>{t.wa_reversal_elevated_approver()}</span>
                <input type="text" name={f.elevation_approved_by_user_id} placeholder="usr_..." required autocomplete="off">
            </label>
            <label class={Field}>
                <span>{t.wa_reversal_reversal_reason()}</span>
                <textarea name={f.explanation} rows="3"></textarea>
            </label>
        </Ask>
    }
}

/// The guided credit or debit: its steps, the form, and the preview with Confirm & submit.
#[component(css = WalletPage)]
fn Request<'a>(t: Com, screen: &'a WalletScreen, sign_in: &'a str) -> impl Render {
    html! {
        let f = CommandForm::FIELDS;
        let form = &screen.form;
        let action = url::Wallet { id: &screen.account_id, view: screen.route_view() };
        let refusal = screen
            .outcome
            .as_ref()
            .filter(|o| o.intent == PREVIEW || o.intent == REQUEST)
            .and_then(|o| o.refusal.as_ref());
        let preview = screen.preview.as_ref();
        let label = screen.label();
        let steps = [
            (t.wa_flow_step_details(), t.wa_flow_step_details_description(), if preview.is_some() { "complete" } else { "current" }),
            (t.wa_flow_step_review(), t.wa_flow_step_review_description(), if preview.is_some() { "current" } else { "upcoming" }),
            (t.wa_flow_step_confirm(), t.wa_flow_step_confirm_description(), "upcoming"),
        ];
        let reasons = REASONS.map(|r| (r, reason_label(t, r)));
        let explanation = if form.reason() == DETAIL_REQUIRED { t.wa_flow_explanation_required() } else { t.wa_flow_explanation_optional() };
        <section class={Card} aria-labelledby="wallet-request">
            <h2 class={Heading} id="wallet-request">{t.ww_request_adjustment()}</h2>
            <ol class={Steps}>
                for (number, (step, description, state)) in steps.iter().enumerate() {
                    if *state == "current" {
                        <li class={(Step, Current)} aria-current="step">
                            <span class={Number}>{number + 1}</span>
                            <span><span class={Strong}>{*step}</span><span class={Muted}>{*description}</span></span>
                        </li>
                    } else if *state == "complete" {
                        <li class={(Step, Complete)}>
                            <span class={Number}>{number + 1}</span>
                            <span><span class={Strong}>{*step}</span><span class={Muted}>{*description}</span></span>
                        </li>
                    } else {
                        <li class={Step}>
                            <span class={Number}>{number + 1}</span>
                            <span><span class={Strong}>{*step}</span><span class={Muted}>{*description}</span></span>
                        </li>
                    }
                }
            </ol>
            if let Some(refusal) = refusal {
                <Refused t={t} refusal={refusal} sign_in={sign_in} />
            }
            <form class={(Form, Tinted)} method="post" action={&action}>
                <input type="hidden" name={f.intent} value={PREVIEW}>
                <fieldset class={Choice}>
                    <legend>{t.wa_flow_credit_or_debit()}</legend>
                    <label>
                        <input type="radio" name={f.direction} value="credit" checked={form.direction() == "credit"}>
                        <span>{t.wa_copy_credit()}</span>
                    </label>
                    <label>
                        <input type="radio" name={f.direction} value="debit" checked={form.direction() == "debit"}>
                        <span>{t.wa_copy_debit()}</span>
                    </label>
                </fieldset>
                <div class={Grid}>
                    <label class={Field}>
                        <span>{t.wa_flow_amount()} " (" {screen.wallet.currency_code.to_ascii_uppercase()} ")"</span>
                        <input type="text" name={f.amount} value={&form.amount} inputmode="decimal" required autocomplete="off">
                    </label>
                    <label class={Field}>
                        <span>{t.wa_flow_reason()}</span>
                        <select name={f.reason_code} required>
                            for (value, words) in reasons {
                                <option value={value} selected={form.reason() == value}>{words}</option>
                            }
                        </select>
                    </label>
                </div>
                <label class={Field}>
                    <span>{explanation}</span>
                    <textarea name={f.explanation} rows="3">{&form.explanation}</textarea>
                    <span class={Hint}>{t.wa_flow_explanation_description()}</span>
                </label>
                <label class={Field}>
                    <span>{t.wa_flow_related_references()}</span>
                    <input type="text" name={f.evidence_references} value={&form.evidence_references} autocomplete="off">
                    <span class={Hint}>{t.wa_flow_related_references_description()}</span>
                </label>
                <button type="submit" class={(Button, Secondary)}>{t.wa_flow_request_preview()}</button>
            </form>
            if let Some(preview) = preview {
                let before = money(t, &preview.available_balance_before, &preview.currency_code);
                let after = money(t, &preview.available_balance_after, &preview.currency_code);
                let amount = money(t, &preview.amount, &preview.currency_code);
                let yes_no = |b: bool| if b { t.wa_flow_yes() } else { t.wa_flow_no() };
                let debit = preview.direction == "debit";
                let direction = direction_label(t, &preview.direction).to_lowercase();
                let elevation: Vec<&str> = preview.elevation_reasons.iter().map(|r| elevation_label(t, r)).collect();
                let confirm = t.wa_flow_confirm_description(&direction, &amount, label, &after).to_string();
                <div class={(Card, Raised)}>
                    <h3 class={Strong}>{t.wa_flow_preview_title()}</h3>
                    <dl class={Pairs}>
                        <dt>{t.wa_flow_target_account()}</dt>
                        <dd class={Words}>{label}</dd>
                        <dt>{t.wa_flow_available_balance_before()}</dt>
                        <dd>{&before}</dd>
                        <dt>{t.wa_flow_available_balance_after()}</dt>
                        <dd>{&after}</dd>
                        <dt>{t.wa_flow_spendable()}</dt>
                        <dd>{yes_no(preview.spendable)}</dd>
                        <dt>{t.wa_flow_payoutable()}</dt>
                        <dd>{yes_no(preview.payoutable)}</dd>
                    </dl>
                    if preview.creates_or_increases_negative_balance {
                        <div class={(Banner, Warning)}>
                            <p class={Strong}>{t.wa_flow_negative_balance_title()}</p>
                            <p>{t.wa_flow_negative_balance_description()}</p>
                        </div>
                    }
                    if preview.requires_second_approval {
                        <div class={(Banner, Warning)}>
                            <p class={Strong}>{t.wa_flow_second_approval_title()}</p>
                            <p>{elevation.join("; ")}</p>
                        </div>
                    }
                    if preview.blocked_reason.is_some() {
                        <div class={(Banner, Danger)} role="alert">
                            <p class={Strong}>{t.wa_flow_self_benefiting_title()}</p>
                            <p>{t.wa_flow_self_benefiting_description()}</p>
                        </div>
                    } else {
                        <div class={Buttons}>
                            <Ask
                                id="wallet-confirm"
                                label={t.wa_flow_confirm_and_submit()}
                                danger={debit}
                                title={t.wa_flow_confirm_title()}
                                description={&confirm}
                                confirm={t.wa_flow_confirm_submit()}
                                cancel={t.wa_flow_cancel()}
                                action={&action}
                                intent={REQUEST}
                                adjustment=""
                                disabled={false}
                            >
                                <input type="hidden" name={f.direction} value={&preview.direction}>
                                <input type="hidden" name={f.amount} value={&preview.amount}>
                                <input type="hidden" name={f.reason_code} value={&preview.reason_code}>
                                <input type="hidden" name={f.explanation} value={&form.explanation}>
                                <input type="hidden" name={f.evidence_references} value={&form.evidence_references}>
                                <input type="hidden" name={f.expected_balance_revision} value={&preview.balance_revision}>
                            </Ask>
                        </div>
                    }
                </div>
            }
        </section>
    }
}

/// A list's Previous and Next.
#[component(css = WalletPage)]
fn Pager<'a>(t: Com, label: &'a str, previous: Option<url::Wallet<'a>>, next: Option<url::Wallet<'a>>) -> impl Render {
    html! {
        if previous.is_some() || next.is_some() {
            <nav class={Buttons} aria-label={label}>
                if let Some(href) = &previous {
                    <a class={(Button, Secondary, Small)} href={href}>{t.ww_previous()}</a>
                }
                if let Some(href) = &next {
                    <a class={(Button, Secondary, Small)} href={href}>{t.ww_next()}</a>
                }
            </nav>
        }
    }
}

/// The page when its wallet cannot be shown.
#[component(css = WalletPage)]
pub fn WalletMissing<'a>(t: Com, title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Page}>
            <crate::views::PageHeader eyebrow={t.ww_settlement()} title={t.ww_wallet_workbench()} description="" />
            <div class={Empty}>
                <p class={Strong}>{title}</p>
                <p class={Muted}>{description}</p>
            </div>
        </div>
    }
}

#[component(css)]
pub fn WalletPage<'a>(t: Com, screen: &'a WalletScreen, title: &'a str) -> impl Render {
    html! {
        let w = &screen.wallet;
        let id = screen.account_id.as_str();
        let view = screen.route_view();
        let label = screen.label();
        let here = format!("/commerce/wallet-workbench/{}", segment(id));
        let sign_in = crate::views::admin_web(&format!("/access/sign-in?returnTo={}", segment(&here))).map_or(here.clone(), |u| u.to_string());
        let (standing, standing_tone) = match w.negative_balance_status.as_str() {
            "collections" => (t.ww_standing_collections(), Danger),
            "negative" => (t.ww_standing_negative(), Warning),
            _ => (t.ww_standing_good(), Good),
        };
        let restricted = match w.negative_balance_status.as_str() {
            "collections" => Some((Danger, t.ww_payout_restricted_collections_description())),
            "negative" => Some((Warning, t.ww_payout_restricted_negative_description())),
            _ => None,
        };
        let reference = t.ww_account_id_reference(id).to_string();
        let updated = w.updated_at.as_deref().map_or_else(|| t.ww_never_updated().to_owned(), |at| t.ww_last_updated(&when(t, at)).to_string());
        let current = screen.view.status.as_deref().unwrap_or("all");
        let filters = STATUSES.map(|s| (s, url::Wallet { id, view: view.filtered(s) }, s == current));
        let v = &screen.view;
        let previous = (v.adjustments_offset > 0)
            .then(|| url::Wallet { id, view: view.adjustments_at(v.adjustments_offset.saturating_sub(v.adjustments_limit)) });
        let next = (u64::from(v.adjustments_offset + v.adjustments_limit) < screen.adjustments_total)
            .then(|| url::Wallet { id, view: view.adjustments_at(v.adjustments_offset + v.adjustments_limit) });
        let ledger_previous =
            (v.ledger_offset > 0).then(|| url::Wallet { id, view: view.ledger_at(v.ledger_offset.saturating_sub(v.ledger_limit)) });
        let ledger_next = (u64::from(v.ledger_offset + v.ledger_limit) < screen.ledger_total)
            .then(|| url::Wallet { id, view: view.ledger_at(v.ledger_offset + v.ledger_limit) });
        let scoped = |row: &Adjustment| {
            screen
                .outcome
                .as_ref()
                .filter(|o| matches!(o.intent.as_str(), APPROVE_INTENT | REJECT_INTENT | REVERSE_INTENT))
                .filter(|o| o.adjustment_id.as_deref() == Some(row.adjustment_id.as_str()))
                .and_then(|o| o.refusal.as_ref())
        };
        // A row command refused on an adjustment the page does not list: said at the history's top.
        let unlisted = screen
            .outcome
            .as_ref()
            .filter(|o| matches!(o.intent.as_str(), APPROVE_INTENT | REJECT_INTENT | REVERSE_INTENT))
            .filter(|o| !screen.adjustments.iter().any(|row| o.adjustment_id.as_deref() == Some(row.adjustment_id.as_str())))
            .and_then(|o| o.refusal.as_ref());
        let payout = |payout_id: &str| screen.marketplace.as_deref().map(|origin| {
            format!("{}/account/desk/payouts/{}", origin.trim_end_matches('/'), segment(payout_id))
        });
        <div class={Page}>
            <crate::views::PageHeader eyebrow={t.ww_settlement()} title={title} description={&reference} />
            <section class={Card} aria-labelledby="wallet-balance">
                <h2 class={Heading} id="wallet-balance">{t.ww_balance()}</h2>
                <div class={Figures}>
                    <Figure label={t.ww_available()} value={money(t, &w.available_balance_amount, &w.currency_code)} />
                    <Figure label={t.ww_pending()} value={money(t, &w.pending_balance_amount, &w.currency_code)} />
                    <Figure label={t.ww_lifetime_credits()} value={money(t, &w.total_credited_amount, &w.currency_code)} />
                    <Figure label={t.ww_lifetime_debits()} value={money(t, &w.total_debited_amount, &w.currency_code)} />
                </div>
                <p class={Line}>
                    <span class={(Pill, standing_tone)}>{standing}</span>
                    <span class={Muted}>{&updated}</span>
                </p>
                if let Some((tone, description)) = restricted {
                    <div class={(Banner, tone)}>
                        <p class={Strong}>{t.ww_payout_restricted_title()}</p>
                        <p>{description}</p>
                    </div>
                }
            </section>
            if screen.can_create {
                <Request t={t} screen={screen} sign_in={&sign_in} />
            }
            <section class={Card} aria-labelledby="wallet-history">
                <h2 class={Heading} id="wallet-history">{t.ww_adjustment_history()}</h2>
                if screen.catching_up {
                    <div class={(Banner, Info)} role="status">
                        <p class={Strong}>{t.ww_projection_catching_up_title()}</p>
                        <p>{t.ww_projection_catching_up_description()}</p>
                    </div>
                }
                if let Some(refusal) = unlisted {
                    <Refused t={t} refusal={refusal} sign_in={&sign_in} />
                }
                <nav class={Filters} aria-label={t.ww_status()}>
                    for (status, href, on) in &filters {
                        if *on {
                            <a class={(Button, Primary, Small)} href={href} aria-current="page">{status_label(t, status)}</a>
                        } else {
                            <a class={(Button, Secondary, Small)} href={href}>{status_label(t, status)}</a>
                        }
                    }
                </nav>
                if screen.adjustments.is_empty() {
                    <div class={Empty}>
                        <p class={Strong}>{t.ww_no_adjustments_title()}</p>
                        <p class={Muted}>{t.ww_no_adjustments_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.ww_status()}</th>
                                    <th scope="col">{t.ww_direction()}</th>
                                    <th scope="col">{t.ww_reason()}</th>
                                    <th scope="col">{t.ww_actors()}</th>
                                    <th scope="col">{t.ww_resulting_balance()}</th>
                                    <th scope="col">{t.ww_reversal()}</th>
                                    <th scope="col">{t.ww_timeline()}</th>
                                    <th scope="col">{t.ww_actions()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.adjustments {
                                    let refusal = scoped(row);
                                    let status_tone = match row.status.as_str() {
                                        "requested" => Warning,
                                        "approved" => Info,
                                        "posted" => Good,
                                        _ => Neutral,
                                    };
                                    let direction_tone = if row.direction == "credit" { Good } else { Danger };
                                    <tr>
                                        <td>
                                            <span class={(Pill, status_tone)}>{status_label(t, &row.status)}</span>
                                            <span class={(Muted, Words, Block)}>{&row.adjustment_id}</span>
                                        </td>
                                        <td>
                                            <span class={(Pill, direction_tone)}>{direction_label(t, &row.direction)}</span>
                                            <span class={(Strong, Block)}>{money(t, &row.amount, &row.currency_code)}</span>
                                        </td>
                                        <td>
                                            <span class={Block}>{reason_label(t, &row.reason_code)}</span>
                                            if let Some(explanation) = &row.explanation {
                                                <span class={(Muted, Words, Block)}>{explanation}</span>
                                            }
                                            if !row.evidence_references.is_empty() {
                                                <span class={(Muted, Words, Block)}>{row.evidence_references.join(", ")}</span>
                                            }
                                        </td>
                                        <td>
                                            <span class={(Muted, Words, Block)}>{t.ww_requested_by(&row.requested_by)}</span>
                                            if let Some(user) = &row.approved_by {
                                                <span class={(Muted, Words, Block)}>{t.ww_approved_by(user)}</span>
                                            }
                                            if let Some(user) = &row.rejected_by {
                                                <span class={(Muted, Words, Block)}>{t.ww_rejected_by(user)}</span>
                                            }
                                        </td>
                                        <td>
                                            {row.available_balance_after.as_deref().map_or_else(|| "\u{2014}".to_owned(), |a| money(t, a, &row.currency_code))}
                                        </td>
                                        <td>
                                            if let Some(of) = &row.reversal_of_adjustment_id {
                                                <span class={(Muted, Words)}>{t.ww_reverses(of)}</span>
                                            } else if let Some(by) = &row.reversed_by_adjustment_id {
                                                <span class={(Muted, Words)}>{t.ww_reversed_by(by)}</span>
                                            } else {
                                                "\u{2014}"
                                            }
                                        </td>
                                        <td>
                                            <span class={(Muted, Block)}>{when(t, &row.requested_at)}</span>
                                            if let Some(at) = &row.posted_at {
                                                <span class={(Muted, Block)}>{t.ww_posted_at(&when(t, at))}</span>
                                            }
                                        </td>
                                        <td class={Actions}>
                                            if let Some(refusal) = refusal {
                                                <Refused t={t} refusal={refusal} sign_in={&sign_in} />
                                            }
                                            if row.status == "requested" && screen.can_approve {
                                                <Approval t={t} screen={screen} row={row} refusal={refusal} label={label} />
                                            } else if row.status == "posted" && screen.can_reverse {
                                                <Reversal t={t} screen={screen} row={row} label={label} />
                                            }
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
                <Pager t={t} label={t.ww_adjustment_history()} previous={previous} next={next} />
            </section>
            <section class={Card} aria-labelledby="wallet-ledger">
                <h2 class={Heading} id="wallet-ledger">{t.ww_ledger()}</h2>
                if screen.ledger.is_empty() {
                    <div class={Empty}>
                        <p class={Strong}>{t.ww_no_ledger_title()}</p>
                        <p class={Muted}>{t.ww_no_ledger_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.ww_kind()}</th>
                                    <th scope="col">{t.ww_direction()}</th>
                                    <th scope="col" class={End}>{t.ww_amount()}</th>
                                    <th scope="col">{t.ww_posted()}</th>
                                    <th scope="col">{t.ww_related()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for entry in &screen.ledger {
                                    let direction_tone = if entry.direction == "credit" { Good } else { Danger };
                                    let link = entry.payout_id.as_deref().and_then(payout);
                                    <tr>
                                        <td>
                                            <span class={(Strong, Block)}>{&entry.kind}</span>
                                            if let Some(description) = &entry.description {
                                                <span class={(Muted, Words, Block)}>{description}</span>
                                            }
                                        </td>
                                        <td>
                                            <span class={(Pill, direction_tone)}>{direction_label(t, &entry.direction)}</span>
                                        </td>
                                        <td class={End}>{money(t, &entry.amount, &entry.currency_code)}</td>
                                        <td>{when(t, &entry.posted_at)}</td>
                                        <td>
                                            if let Some(href) = &link {
                                                <a
                                                    class={(Button, Secondary, Small)}
                                                    href={href}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    {t.ww_related_payout()}
                                                </a>
                                            } else if let Some(order) = &entry.order_id {
                                                <span class={(Muted, Words)}>{order}</span>
                                            } else {
                                                "\u{2014}"
                                            }
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
                <Pager t={t} label={t.ww_ledger()} previous={ledger_previous} next={ledger_next} />
            </section>
        </div>
    }
}
