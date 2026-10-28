//! The user's consent history (Identity's `ConsentHistoryPage`, a `CustomerSummaryPage`): the
//! title and what the page is for; what the last withdrawal did; then each consent, with its
//! policy and version, when it was recorded (and withdrawn), its status, and Withdraw (behind a
//! dialog that asks first) while it is recorded and current. One column on a phone, every control
//! at least 2.75rem tall; from 48rem a consent's status and Withdraw sit beside its words.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::account_home_page::humanized;
use crate::{
    addresses::Said,
    api::{AccountAction, Consent},
    app::url,
    consents::{ConsentInput, ConsentsScreen, Place},
    text::{ConsentsMsg, Pilot},
};

/// The dialog a consent's Withdraw opens.
#[derive(Id)]
pub struct WithdrawConsentDialogId<'a>(pub &'a str);

/// Identity's `formatMachineValue` with this page's words.
fn machine(known: Option<&'static str>, t: ConsentsMsg, family: &str, value: &str) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.value_unrecognized(family).to_string(),
    }
}

/// A policy's name (`consentPolicyLabel`).
fn policy(t: ConsentsMsg, value: &str) -> String {
    let known = match value {
        "terms-of-service" => Some(t.policy_terms_of_service()),
        "privacy-policy" => Some(t.policy_privacy_policy()),
        "seller-agreement" => Some(t.policy_seller_agreement()),
        "payments-terms" => Some(t.policy_payments_terms()),
        _ => None,
    };
    machine(known, t, t.family_consent_policy(), value)
}

/// A consent's status (`consentStatusLabel`).
fn status(t: ConsentsMsg, value: &str) -> String {
    let known = match value {
        "recorded" => Some(t.page_recorded()),
        "withdrawn" => Some(t.page_withdrawn()),
        _ => None,
    };
    machine(known, t, t.family_consent_status(), value)
}

/// A policy version (`consentVersionLabel`): a machine token, else unavailable.
fn version(t: ConsentsMsg, value: &str) -> String {
    match humanized(value) {
        Some(_) => t.value_version(value).to_string(),
        None => t.value_version_unavailable().to_owned(),
    }
}

/// A moment as marketplace's `formatDateTime` writes it, else the date's unavailable words.
fn when(t: ConsentsMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(
        || t.value_date_unavailable().to_owned(),
        |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
    )
}

/// The page.
#[component(css)]
pub fn ConsentsPage<'a>(t: ConsentsMsg, p: Pilot, screen: &'a ConsentsScreen) -> impl Render {
    let banner = match &screen.said {
        Said::Editing => None,
        Said::Saved => Some(("info", t.manage_state_succeeded())),
        // A refusal's own words (an out-of-date form, no consent chosen), else nothing was recorded.
        Said::NotSaved => Some(("danger", screen.refused.unwrap_or(t.manage_state_failed_safe()))),
        Said::Conflict => Some(("warning", t.manage_state_conflict())),
        Said::Unconfirmed { .. } => Some(("warning", t.manage_state_ambiguous())),
        Said::Denied => Some(("danger", t.manage_state_route_denied())),
    };
    let again = match &screen.said {
        Said::Unconfirmed { attempt, target, .. } => Some(
            url::Consents { place: Place { check: Some(attempt.clone()), target: target.clone(), ..Place::default() } }.href(),
        ),
        _ => None,
    };
    html! {
        <header class={Header}>
            <h1 class={Title}>{t.page_consent_history()}</h1>
            <p class={Muted}>{t.page_audit_history_for_agreements_policies_and()}</p>
        </header>
        <div class={Status} role="status" aria-live="polite">
            if let Some((tone, text)) = banner {
                <div class={Banner} data-tone={tone} tabindex="-1" autofocus>
                    <p class={Strong}>{text}</p>
                    if let Some(again) = &again {
                        <p><a href={again}>{p.addresses_check()}</a></p>
                    }
                </div>
            }
            if screen.pending {
                <div class={Banner} data-tone="warning">
                    <p>{t.route_consents_updating()}</p>
                </div>
            }
        </div>
        if screen.consents.is_empty() {
            <p class={Muted}>{p.consents_none()}</p>
        } else {
            <ul class={Rows}>
                for consent in &screen.consents {
                    <ConsentRow t={t} p={p} consent={consent} said={&screen.said} />
                }
            </ul>
        }
    }
}

/// A consent: its policy and version, when it was recorded (and withdrawn), its status, and
/// Withdraw behind a dialog while it is recorded and current.
#[component(css = ConsentsPage)]
fn ConsentRow<'a>(t: ConsentsMsg, p: Pilot, consent: &'a Consent, said: &'a Said) -> impl Render {
    let f = ConsentInput::FIELDS;
    let id = consent.consent_id.as_str();
    let name = policy(t, &consent.policy_key);
    let title = t.page_policy_title(&name, &version(t, &consent.policy_version)).to_string();
    let recorded = when(t, &consent.recorded_at);
    let body = if consent.status == "withdrawn" {
        let withdrawn = when(t, consent.withdrawn_at.as_deref().unwrap_or(&consent.updated_at));
        t.page_withdrawn_at(&recorded, &withdrawn).to_string()
    } else {
        t.page_recorded_at(&recorded).to_string()
    };
    let tone = if consent.status == "withdrawn" { "neutral" } else { "success" };
    let withdrawable = consent.status == "recorded" && consent.is_current;
    let confirm = t.page_withdraw_confirm_title(&name).to_string();
    let description = t.page_withdraw_confirm_description(&name).to_string();
    let (title_id, text_id) = (format!("withdraw-title-{id}"), format!("withdraw-text-{id}"));
    html! {
        <li class={Row} data-consent={id}>
            <div class={Words}>
                <h2 class={Policy}>{&title}</h2>
                <p class={Muted}>{&body}</p>
            </div>
            <div class={Controls}>
                <span class={Badge} data-tone={tone}>{status(t, &consent.status)}</span>
                if withdrawable {
                    <button type="button" class={Danger} command="show-modal" commandfor={WithdrawConsentDialogId(id)}>
                        {t.page_withdraw()}
                    </button>
                }
            </div>
            if withdrawable {
                <dialog id={WithdrawConsentDialogId(id)} class={Dialog} aria-labelledby={&title_id} aria-describedby={&text_id}>
                    <h2 id={&title_id} class={DialogTitle}>{&confirm}</h2>
                    <p id={&text_id} class={Muted}>{&description}</p>
                    <form class={Buttons} method="post" action={url::Consents::default()}>
                        <input type="hidden" name={f.intent} value="withdraw">
                        <input type="hidden" name={f.consent_id} value={id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="button" class={Secondary} command="close" commandfor={WithdrawConsentDialogId(id)}>
                            {p.addresses_cancel()}
                        </button>
                        <button type="submit" class={Danger} disabled={said.holds(AccountAction::Withdraw, Some(id))}>
                            {t.page_withdraw_confirm_action()}
                        </button>
                    </form>
                </dialog>
            }
        </li>
    }
}
