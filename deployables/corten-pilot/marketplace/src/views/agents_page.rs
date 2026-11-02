//! The connected agents pages (Auth's `AgentGrantListPage`, `AgentGrantDetailPage` and
//! `AgentConsentPage`). The list: the title, how to connect an assistant (the connector URL with
//! Copy, Learn more and each assistant's steps), then one card per grant (its name and status, scope
//! count, spend and when it was connected) linking to its page. A grant's page: the breadcrumb,
//! the name with its status, what the last write did, Revoke access (a dialog that asks first) and
//! the revoke's state, then its agent, scopes by family, spend, the spending mandate's form, the
//! webhook's form (a new secret shown once, with Copy) and its activity. The consent: who asks,
//! where the answer goes and as which account, the access by family, Approve and Deny, and Use
//! for each other account. One column on a phone, every control at least 2.75rem tall; from 48rem a
//! card's facts sit side by side and the forms' fields in two columns.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use corten_ui::CopyButton;

use super::account_home_page::humanized;
use crate::{
    agents::{
        ConsentAsk, ConsentScreen, DecideInput, GrantScreen, ListScreen, MandateInput, Place, Posted, RAILS, Revocation,
        RevokeInput, SwitchInput, WebhookInput, cap_field, cap_words, dollars, granted, said_words,
    },
    api::AgentGrant,
    app::url,
    text::{AgentsMsg, Pilot},
};

/// The connector URL, which Copy URL copies.
#[derive(Id, Clone, Copy)]
pub struct McpUrlId;

/// A new webhook signing secret, which Copy secret copies.
#[derive(Id, Clone, Copy)]
pub struct SigningSecretId;

/// The dialog Revoke access opens.
#[derive(Id, Clone, Copy)]
pub struct RevokeGrantDialogId;

/// The mandate form's error, which its fields name.
#[derive(Id, Clone, Copy)]
pub struct MandateErrorId;

/// The webhook form's error.
#[derive(Id, Clone, Copy)]
pub struct WebhookErrorId;

/// A known value's words, else Auth's unrecognized words with the value made readable.
fn machine(t: AgentsMsg, known: Option<&'static str>, family: &str, value: &str) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.value_unrecognized(family).to_string(),
    }
}

/// A grant's status's words (`agentGrantStatusLabel`).
pub fn status(t: AgentsMsg, value: &str) -> String {
    let known = match value {
        "active" => Some(t.value_status_active()),
        "revoked" => Some(t.value_status_revoked()),
        _ => None,
    };
    machine(t, known, t.value_family_status(), value)
}

/// An activity outcome's words (`agentGrantOutcomeLabel`).
pub fn outcome(t: AgentsMsg, value: &str) -> String {
    let known = match value {
        "allowed" => Some(t.value_outcome_allowed()),
        "denied" => Some(t.value_outcome_denied()),
        "failed" => Some(t.value_outcome_failed()),
        _ => None,
    };
    machine(t, known, t.value_family_outcome(), value)
}

/// A time as the pages show it, or Date unavailable.
fn when(t: AgentsMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(
        || t.value_date_unavailable().to_owned(),
        |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
    )
}

/// The list's spend line (`agentGrantSpendSummary`): today's spend of the daily cap.
fn spend_summary(t: AgentsMsg, grant: &AgentGrant) -> String {
    match (&grant.spending_mandate, &grant.spend) {
        (Some(mandate), Some(spend)) => {
            t.presentation_daily_spend_summary(&dollars(t, spend.daily_cents), &cap_words(t, mandate.daily_cap_cents)).to_string()
        }
        _ => t.presentation_no_spend_data().to_owned(),
    }
}

fn rail_words(t: AgentsMsg, rail: &str) -> &'static str {
    match rail {
        "stored-pm" => t.presentation_rail_stored_pm(),
        _ => t.presentation_rail_handoff_only(),
    }
}

/// The list.
#[component(css)]
pub fn AgentsPage<'a>(t: AgentsMsg, screen: &'a ListScreen) -> impl Render {
    let url = screen.mcp_url.as_str();
    let assistants = [
        (
            t.list_connect_claude_name(),
            [
                t.list_connect_claude_step1().to_owned(),
                t.list_connect_claude_step2(url).to_string(),
                t.list_connect_claude_step3().to_owned(),
            ],
        ),
        (
            t.list_connect_chatgpt_name(),
            [
                t.list_connect_chatgpt_step1().to_owned(),
                t.list_connect_chatgpt_step2(url).to_string(),
                t.list_connect_chatgpt_step3().to_owned(),
            ],
        ),
        (
            t.list_connect_gemini_name(),
            [
                t.list_connect_gemini_step1().to_owned(),
                t.list_connect_gemini_step2(url).to_string(),
                t.list_connect_gemini_step3().to_owned(),
            ],
        ),
    ];
    html! {
        <header class={Header}>
            <h1 class={Title}>{t.list_connected_agents()}</h1>
        </header>
        <section class={Part} aria-labelledby="connect-title">
            <h2 id="connect-title" class={PartTitle}>{t.list_connect_title()}</h2>
            <p class={Muted}>{t.list_connect_description()}</p>
            <p class={Label} id="connector-label">{t.list_connect_url_label()}</p>
            <pre class={Code} aria-labelledby="connector-label"><code id={McpUrlId}>{url}</code></pre>
            <div class={Links}>
                <CopyButton text={McpUrlId} label={t.list_connect_copy()} copied={t.list_connect_copied()} />
                <a
                    class={(Button, Secondary)}
                    href="https://ucp.dev/latest/specification/overview"
                    target="_blank"
                    rel="noreferrer"
                >
                    {t.list_connect_learn_more()}
                </a>
            </div>
            <div class={Assistants}>
                for (name, steps) in &assistants {
                    <div>
                        <h3 class={Name}>{*name}</h3>
                        <ol class={Steps}>
                            for step in steps {
                                <li>{step}</li>
                            }
                        </ol>
                    </div>
                }
            </div>
        </section>
        if screen.grants.is_empty() {
            <p class={Muted}>{t.list_no_agents_yet()}</p>
        } else {
            <ul class={Cards}>
                for grant in &screen.grants {
                    <li>
                        <a class={Card} href={url::AgentPage { id: &grant.id, place: Place::default() }}>
                            <span class={Name}>{grant.name()}</span>
                            <span class={Badge} data-status={&grant.status}>{status(t, &grant.status)}</span>
                            <dl class={Facts}>
                                <div>
                                    <dt>{t.list_scopes()}</dt>
                                    <dd>{t.list_scope_count(grant.scopes.len())}</dd>
                                </div>
                                <div>
                                    <dt>{t.list_spend()}</dt>
                                    <dd>{&spend_summary(t, grant)}</dd>
                                </div>
                                <div>
                                    <dt>{t.list_granted()}</dt>
                                    <dd>{&when(t, &grant.granted_at)}</dd>
                                </div>
                            </dl>
                        </a>
                    </li>
                }
            </ul>
        }
    }
}

/// The scopes `scopes` grants, by family: each scope's label and description.
#[component(css = AgentsPage)]
fn Scopes<'a>(scopes: &'a [String], none: &'a str) -> impl Render {
    let families = granted(scopes);
    html! {
        if families.is_empty() {
            <p class={Muted}>{none}</p>
        } else {
            <div class={Families}>
                for (family, scopes) in &families {
                    <div>
                        <h3 class={Name}>{&family.label}</h3>
                        <ul class={Steps}>
                            for scope in scopes {
                                <li>{&format!("{} - {}", scope.label, scope.description)}</li>
                            }
                        </ul>
                    </div>
                }
            </div>
        }
    }
}

/// A grant's page.
#[component(css = AgentsPage)]
pub fn AgentPage<'a>(t: AgentsMsg, p: Pilot, screen: &'a GrantScreen) -> impl Render {
    let grant = &screen.detail.authorization;
    let id = grant.id.as_str();
    let name = grant.name();
    let revocation = screen.revocation();
    let state = match revocation {
        None => t.detail_revocation_editing(),
        Some(Revocation::Succeeded) => t.detail_revocation_succeeded(),
        Some(Revocation::AlreadyRevokedCleanupComplete) => t.detail_revocation_already_complete(),
        Some(Revocation::FailedSafe) => t.detail_revocation_failed_safe(),
        Some(Revocation::Conflict) => t.detail_revocation_conflict(),
        Some(Revocation::Ambiguous) => t.detail_revocation_ambiguous(),
        Some(Revocation::ReauthRequired) => t.detail_revocation_reauth(),
        Some(Revocation::RouteDenied) => t.detail_revocation_denied(),
    };
    let banner = screen.said.map(|said| said_words(p, said));
    let stuck = revocation.is_some_and(Revocation::stuck);
    let r = RevokeInput::FIELDS;
    html! {
        <nav class={Crumbs} aria-label={t.list_connected_agents()}>
            <a href={url::Agents}>{t.list_connected_agents()}</a>
            <span aria-hidden="true">"/"</span>
            <span aria-current="page">{name}</span>
        </nav>
        <header class={Header}>
            <h1 class={Title}>{name}</h1>
            <span class={Badge} data-status={&grant.status}>{status(t, &grant.status)}</span>
        </header>
        <div class={Status} role="status" aria-live="polite">
            if let Some((tone, text)) = banner {
                <div class={Banner} data-tone={tone} tabindex="-1" autofocus>
                    <p>{text}</p>
                </div>
            }
            if screen.detail.revocation_active {
                <p class={Muted}>{state}</p>
            }
        </div>
        if screen.revocable() {
            <div class={Actions}>
                <button type="button" class={Danger} command="show-modal" commandfor={RevokeGrantDialogId} disabled={stuck}>
                    {t.detail_revoke()}
                </button>
                <dialog id={RevokeGrantDialogId} class={Dialog} aria-labelledby="revoke-title" aria-describedby="revoke-text">
                    <h2 id="revoke-title" class={PartTitle}>{t.detail_revoke_confirm_title()}</h2>
                    <p id="revoke-text" class={Muted}>{t.detail_revoke_confirm_description(name)}</p>
                    <form class={Buttons} method="post" action={url::AgentRevoke { id }}>
                        <input type="hidden" name={r.attempt_id} value={&screen.attempt}>
                        <button type="button" class={Secondary} command="close" commandfor={RevokeGrantDialogId}>
                            {t.detail_cancel()}
                        </button>
                        <button type="submit" class={Danger}>{t.detail_revoke()}</button>
                    </form>
                </dialog>
            </div>
        }
        <section class={Part} aria-labelledby="agent-title">
            <h2 id="agent-title" class={PartTitle}>{t.detail_agent()}</h2>
            <p class={Muted}>{&grant.platform_profile_url}</p>
            <p class={Muted}>{t.detail_connected_on(&when(t, &grant.granted_at))}</p>
        </section>
        <section class={Part} aria-labelledby="scopes-title">
            <h2 id="scopes-title" class={PartTitle}>{t.detail_scopes()}</h2>
            <Scopes scopes={&grant.scopes} none={t.detail_no_scopes()} />
        </section>
        <section class={Part} aria-labelledby="spend-title">
            <h2 id="spend-title" class={PartTitle}>{t.detail_spend()}</h2>
            match (&grant.spending_mandate, &grant.spend) {
                (Some(mandate), Some(spend)) => {
                    <p>{t.detail_spend_today(&dollars(t, spend.daily_cents), &cap_words(t, mandate.daily_cap_cents))}</p>
                    <p>{t.detail_spend_this_month(&dollars(t, spend.monthly_cents), &cap_words(t, mandate.monthly_cap_cents))}</p>
                    <p class={Muted}>{t.detail_spend_per_order_cap(&cap_words(t, mandate.max_per_order_cents))}</p>
                }
                _ => { <p class={Muted}>{t.detail_no_spend_data()}</p> }
            }
        </section>
        <MandateForm t={t} p={p} screen={screen} />
        <WebhookForm t={t} p={p} screen={screen} />
        <section class={Part} aria-labelledby="activity-title">
            <h2 id="activity-title" class={PartTitle}>{t.detail_activity()}</h2>
            match &screen.activity {
                None => { <p class={Muted}>{p.agents_activity_unavailable()}</p> }
                Some(activity) if activity.is_empty() => { <p class={Muted}>{t.detail_no_activity_yet()}</p> }
                Some(activity) => {
                    <ul class={Cards}>
                        for call in activity {
                            <li class={Card}>
                                <dl class={Facts}>
                                    <div>
                                        <dt>{t.detail_activity_when()}</dt>
                                        <dd>{&when(t, &call.occurred_at)}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.detail_activity_tool()}</dt>
                                        <dd class={Mono}>{call.called()}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.detail_activity_outcome()}</dt>
                                        <dd>
                                            <span class={Badge} data-outcome={&call.outcome}>{outcome(t, &call.outcome)}</span>
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>{t.detail_activity_reason()}</dt>
                                        <dd>{call.reason.as_deref().unwrap_or("\u{2014}")}</dd>
                                    </div>
                                </dl>
                            </li>
                        }
                    </ul>
                }
            }
        </section>
    }
}

/// The spending mandate's form: a refused one as it was sent, else the grant's mandate (a person
/// present and the trusted handoff when it has none).
#[component(css = AgentsPage)]
fn MandateForm<'a>(t: AgentsMsg, p: Pilot, screen: &'a GrantScreen) -> impl Render {
    let grant = &screen.detail.authorization;
    let f = MandateInput::FIELDS;
    let posted = match &screen.posted {
        Some(Posted::Mandate(input)) => Some(input),
        _ => None,
    };
    let mandate = grant.spending_mandate.as_ref();
    let (max, daily, monthly, human, rails) = match posted {
        Some(input) => (
            input.max_per_order_amount.clone(),
            input.daily_cap_amount.clone(),
            input.monthly_cap_amount.clone(),
            input.human_present_required.last().is_none_or(|v| v != "false"),
            input.allowed_rails.clone(),
        ),
        None => (
            cap_field(mandate.and_then(|m| m.max_per_order_cents)),
            cap_field(mandate.and_then(|m| m.daily_cap_cents)),
            cap_field(mandate.and_then(|m| m.monthly_cap_cents)),
            mandate.is_none_or(|m| m.human_present_required),
            mandate.map_or_else(|| vec!["handoff-only".to_owned()], |m| m.allowed_rails.clone()),
        ),
    };
    let refused = posted.is_some();
    // A field the refusal is about: one sent that is not an amount.
    let bad = |value: &str| refused && !value.trim().is_empty() && platform::money::cents(value).is_none_or(|c| c < 0);
    let caps = [
        (f.max_per_order_amount, t.detail_mandate_max_per_order(), bad(&max), max),
        (f.daily_cap_amount, t.detail_mandate_daily_cap(), bad(&daily), daily),
        (f.monthly_cap_amount, t.detail_mandate_monthly_cap(), bad(&monthly), monthly),
    ];
    html! {
        <section class={Part} aria-labelledby="mandate-title">
            <h2 id="mandate-title" class={PartTitle}>{t.detail_mandate()}</h2>
            <form class={Form} method="post" action={url::AgentMandate { id: &grant.id }}>
                if refused {
                    <p id={MandateErrorId} class={Error} tabindex="-1" autofocus>{p.agents_amount_invalid()}</p>
                }
                <div class={Fields}>
                    for (name, label, invalid, value) in &caps {
                        <label class={Field}>
                            <span class={Label}>{*label}</span>
                            <input
                                type="number"
                                inputmode="decimal"
                                min="0"
                                step="0.01"
                                name={*name}
                                value={value}
                                placeholder={t.detail_mandate_no_cap_placeholder()}
                                aria-invalid={invalid.then_some("true")}
                                aria-describedby={invalid.then_some(MandateErrorId)}
                            >
                        </label>
                    }
                </div>
                <input type="hidden" name={f.human_present_required} value="false">
                <label class={Check}>
                    <input
                        type="checkbox"
                        role="switch"
                        name={f.human_present_required}
                        value="true"
                        checked={human}
                        aria-describedby="human-text"
                    >
                    <span>
                        <span class={Label}>{t.detail_mandate_human_present_required()}</span>
                        <span id="human-text" class={Muted}>{t.detail_mandate_human_present_required_description()}</span>
                    </span>
                </label>
                <fieldset class={Rails}>
                    <legend class={Label}>{t.detail_mandate_allowed_rails()}</legend>
                    for rail in RAILS {
                        <label class={Check}>
                            <input type="checkbox" name={f.allowed_rails} value={rail} checked={rails.iter().any(|r| r == rail)}>
                            <span>{rail_words(t, rail)}</span>
                        </label>
                    }
                </fieldset>
                <div class={Links}>
                    <button type="submit">{t.detail_mandate_save()}</button>
                </div>
            </form>
        </section>
    }
}

/// The webhook's form, its secret's preview, and a new secret once.
#[component(css = AgentsPage)]
fn WebhookForm<'a>(t: AgentsMsg, p: Pilot, screen: &'a GrantScreen) -> impl Render {
    let id = screen.detail.authorization.id.as_str();
    let f = WebhookInput::FIELDS;
    let posted = match &screen.posted {
        Some(Posted::Webhook(input)) => Some(input),
        _ => None,
    };
    let current = screen.webhook.as_ref();
    let address = posted.map_or_else(|| current.map_or("", |w| w.callback_url.as_str()), |i| i.callback_url.as_str());
    html! {
        <section class={Part} aria-labelledby="webhook-title">
            <h2 id="webhook-title" class={PartTitle}>{t.detail_webhook()}</h2>
            <p class={Muted}>{t.detail_webhook_description()}</p>
            // Sent by the runtime when it runs (`data-patch`): the answer, with the new secret, replaces
            // the page and the address stays the grant's, so a reload reads it again instead of posting
            // the save again, which would rotate the secret.
            <form class={Form} method="post" action={url::AgentWebhook { id }} data-patch>
                if posted.is_some() {
                    <p id={WebhookErrorId} class={Error} tabindex="-1" autofocus>{p.agents_webhook_invalid()}</p>
                }
                <label class={Field}>
                    <span class={Label}>{t.detail_webhook_callback_url()}</span>
                    <input
                        type="url"
                        name={f.callback_url}
                        value={address}
                        placeholder="https://agent.example/hooks"
                        aria-invalid={posted.is_some().then_some("true")}
                        aria-describedby={posted.is_some().then_some(WebhookErrorId)}
                    >
                </label>
                <div class={Links}>
                    <button type="submit">{t.detail_webhook_save()}</button>
                    if current.is_some() {
                        <button type="submit" class={Danger} formaction={url::AgentWebhookDisable { id }} formnovalidate>
                            {t.detail_webhook_disable()}
                        </button>
                    }
                </div>
            </form>
            if let Some(preview) = current.and_then(|w| w.signing_secret_preview.as_deref()) {
                <p class={Label}>{t.detail_webhook_secret_preview()}</p>
                <p class={(Muted, Mono)}>{preview}</p>
            }
            if let Some(secret) = current.and_then(|w| w.signing_secret.as_deref()) {
                <div class={Secret}>
                    <p class={Label}>{t.detail_webhook_secret_once()}</p>
                    <p class={Label} id="secret-label">{t.detail_webhook_secret_label()}</p>
                    <pre class={Code} aria-labelledby="secret-label"><code id={SigningSecretId}>{secret}</code></pre>
                    <CopyButton
                        text={SigningSecretId}
                        label={t.detail_webhook_secret_copy()}
                        copied={t.detail_webhook_secret_copied()}
                    />
                </div>
            }
        </section>
    }
}

/// An agent's consent request.
#[component(css = AgentsPage)]
pub fn AgentConsentPage<'a>(t: AgentsMsg, screen: &'a ConsentScreen) -> impl Render {
    let d = DecideInput::FIELDS;
    let s = SwitchInput::FIELDS;
    let token = screen.token.as_str();
    html! {
        match &screen.consent {
            None => {
                <header class={Header}>
                    <h1 class={Title}>{t.consent_invalid_title()}</h1>
                </header>
                <p class={Muted}>{t.consent_invalid_description()}</p>
            }
            Some(consent) => {
                <header class={Header}>
                    <h1 class={Title}>{t.consent_title()}</h1>
                </header>
                <dl class={Details}>
                    <div>
                        <dt>{t.consent_client()}</dt>
                        <dd>{&consent.client_name}</dd>
                        <dd class={Muted}>{t.consent_untrusted_name()}</dd>
                    </div>
                    <div>
                        <dt>{t.consent_redirect()}</dt>
                        <dd class={Mono}>{&consent.redirect_origin}</dd>
                    </div>
                    <div>
                        <dt>{t.consent_account()}</dt>
                        <dd>{&consent.account_name}</dd>
                    </div>
                </dl>
                <section class={Part} aria-labelledby="access-title">
                    <h2 id="access-title" class={PartTitle}>{t.consent_scopes()}</h2>
                    <Scopes scopes={&consent.scopes} none={t.detail_no_scopes()} />
                    if let Some(at) = consent.operator_grant_expires_at.as_deref().and_then(parse_timestamp) {
                        <p>{t.consent_operator_expiry(&t.date(at, DateStyle::Medium).to_string())}</p>
                    }
                </section>
                <div class={Decisions}>
                    for (decision, words, tone) in [("approve", t.consent_approve(), None), ("deny", t.consent_deny(), Some(Secondary))] {
                        <form method="post" action={url::OAuthAuthorize}>
                            <input type="hidden" name={d.consent_token} value={token}>
                            <input type="hidden" name={d.decision} value={decision}>
                            <button type="submit" class={tone}>{words}</button>
                        </form>
                    }
                </div>
                for membership in consent.memberships.iter().filter(|m| m.account_id != consent.account_id) {
                    <form class={Decisions} method="post" action={url::AgentConsent { ask: ConsentAsk::default() }}>
                        <input type="hidden" name={s.consent_token} value={token}>
                        <input type="hidden" name={s.account_id} value={&membership.account_id}>
                        <button type="submit" class={Secondary}>{t.consent_switch_account(&membership.account_name)}</button>
                    </form>
                }
            }
        }
    }
}
