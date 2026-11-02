//! The user's security page (Identity's `SecurityPage`): the header (eyebrow, title, description)
//! with Update Profile and Create API Key; what the last write did; a secret a create or rotate
//! issued, once, with Copy (with the script) and a link that leaves it once it is stored; Account
//! Protection's three metrics; and Security Signals with Manage sessions, the verified cue, the
//! specification list, each key with Rotate and Revoke (behind a dialog that asks first), and the
//! checkout safety cue. One column on a phone, every control at least 2.75rem tall; from 48rem the
//! forms' fields sit side by side and the metrics three across.
use corten::{
    i18n::{DateStyle, parse_timestamp},
    prelude::*,
};
use corten_ui::CopyButton;

use super::account_home_page::humanized;
use crate::{
    addresses::Said,
    api::{AccountAction, ApiKey, KeySecret},
    app::url,
    security::{Draft, Place, SecurityInput, SecurityScreen, Which},
    text::{Pilot, SecurityMsg},
};

/// Update Profile's form: a refused update draws it again.
#[derive(Id, Clone, Copy)]
pub struct UserFormId;

/// Create API Key's form.
#[derive(Id, Clone, Copy)]
pub struct ApiKeyFormId;

/// A new key's secret, which Copy copies.
#[derive(Id)]
pub struct SecretId;

/// The dialog a key's Revoke opens.
#[derive(Id)]
pub struct RevokeDialogId<'a>(pub &'a str);

/// Identity's `formatMachineValue` with this page's words.
fn machine(known: Option<&'static str>, t: SecurityMsg, family: &str, value: &str) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.value_unrecognized(family).to_string(),
    }
}

/// A sign-in method's words (`authenticationMethodLabel`).
pub fn method(t: SecurityMsg, value: &str) -> String {
    let known = match value {
        "password" => Some(t.method_password()),
        "magic-link" => Some(t.method_magic_link()),
        "passkey" => Some(t.method_passkey()),
        "sms-code" => Some(t.method_sms_code()),
        "social-login" => Some(t.method_social_login()),
        "google" => Some(t.method_google()),
        "facebook" => Some(t.method_facebook()),
        _ => None,
    };
    machine(known, t, t.family_authentication_method(), value)
}

/// A key's status's words (`apiKeyStatusLabel`).
pub fn key_status(t: SecurityMsg, value: &str) -> String {
    let known = match value {
        "active" => Some(t.key_status_active()),
        "revoked" => Some(t.key_status_revoked()),
        _ => None,
    };
    machine(known, t, t.family_api_key_status(), value)
}

/// The page.
#[component(css)]
pub fn SecurityPage<'a>(t: SecurityMsg, p: Pilot, screen: &'a SecurityScreen) -> impl Render {
    let user = &screen.user;
    let methods = if user.auth_methods.is_empty() {
        t.page_no_interactive_methods_enabled().to_owned()
    } else {
        user.auth_methods.iter().map(|m| method(t, m)).collect::<Vec<_>>().join(", ")
    };
    let active = screen.keys.iter().filter(|key| key.status == "active").count();
    let keys_detail = if screen.keys.is_empty() {
        t.page_no_api_keys_yet().to_owned()
    } else {
        t.page_active_keys_detail(screen.keys.len()).to_string()
    };
    let keys_spec = if screen.keys.is_empty() {
        t.page_no_api_keys_yet().to_owned()
    } else {
        screen.keys.iter().map(|key| format!("{} ({})", key.name, key_status(t, &key.status))).collect::<Vec<_>>().join(", ")
    };
    let updated = if user.updated_at.is_empty() {
        t.page_not_available().to_owned()
    } else {
        parse_timestamp(&user.updated_at)
            .map_or_else(|| t.value_date_unavailable().to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
    };
    let banner = match &screen.said {
        Said::Editing => None,
        Said::Saved => Some(("info", t.manage_state_succeeded())),
        Said::NotSaved => Some(("danger", t.manage_state_failed_safe())),
        Said::Conflict => Some(("warning", t.manage_state_conflict())),
        Said::Unconfirmed { .. } => Some(("warning", t.manage_state_ambiguous())),
        Said::Denied => Some(("danger", t.manage_state_route_denied())),
    };
    let again = match &screen.said {
        Said::Unconfirmed { attempt, action, target } => Some(
            url::Security {
                place: Place { check: Some(attempt.clone()), action: Some(*action), target: target.clone(), ..Place::default() },
            }
            .href(),
        ),
        _ => None,
    };
    let pending =
        if matches!(screen.secret, KeySecret::Issued { .. }) { p.security_pending_secret() } else { p.security_pending() };
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.page_account()}</p>
                <h1 class={Title}>{t.page_security()}</h1>
                <p class={Muted}>{t.page_authentication_methods_passkeys_sessions_and_api()}</p>
            </div>
            <div class={Actions}>
                <ProfileForm
                    t={t}
                    draft={&screen.draft(Which::Profile)}
                    held={screen.said.holds(AccountAction::UpdateUser, Some(&user.user_id))}
                />
                <KeyForm t={t} draft={&screen.draft(Which::Key)} held={screen.said.holds(AccountAction::CreateApiKey, None)} />
            </div>
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
            if screen.secret == KeySecret::Unrecoverable {
                <div class={Banner} data-tone="warning">
                    <p>{t.manage_secret_unrecoverable()}</p>
                </div>
            }
            if screen.pending {
                <div class={Banner} data-tone="warning">
                    <p>{pending}</p>
                </div>
            }
        </div>
        if let KeySecret::Issued { secret, .. } = &screen.secret {
            <SecretReveal t={t} secret={secret} rotated={screen.issued_by == Some(AccountAction::RotateApiKey)} />
        }
        <section class={Part} aria-labelledby="protection-title">
            <h2 id="protection-title" class={PartTitle}>{t.page_account_protection()}</h2>
            <p class={Muted}>{t.page_account_protection_description()}</p>
            <dl class={Metrics}>
                <div class={Metric}>
                    <dt>{t.page_enabled_methods()}</dt>
                    <dd class={Value}>{user.auth_methods.len()}</dd>
                    <dd class={Muted}>{&methods}</dd>
                </div>
                <div class={Metric}>
                    <dt>{t.page_api_keys()}</dt>
                    <dd class={Value}>{active}</dd>
                    <dd class={Muted}>{&keys_detail}</dd>
                </div>
                <div class={Metric}>
                    <dt>{t.page_updated()}</dt>
                    <dd class={Value}>{&updated}</dd>
                    <dd class={Muted}>{t.page_review_security_before_checkout()}</dd>
                </div>
            </dl>
        </section>
        <section class={Part} aria-labelledby="signals-title">
            <div class={PartHead}>
                <div class={Heading}>
                    <h2 id="signals-title" class={PartTitle}>{t.page_security_signals()}</h2>
                    <p class={Muted}>{t.page_security_signals_description()}</p>
                </div>
                <a class={(Button, Secondary)} href={url::Sessions::default()}>{t.page_manage_sessions()}</a>
            </div>
            <p class={Verified}>{t.page_sign_in_methods_verified()}</p>
            <dl class={Specs}>
                <div>
                    <dt>{t.page_enabled_methods()}</dt>
                    <dd>{&methods}</dd>
                </div>
                <div>
                    <dt>{t.page_api_keys()}</dt>
                    <dd>{&keys_spec}</dd>
                </div>
            </dl>
            if !screen.keys.is_empty() {
                <ul class={Keys}>
                    for key in &screen.keys {
                        <KeyRow t={t} p={p} key={key} said={&screen.said} />
                    }
                </ul>
            }
            <div class={Cue}>
                <p class={Strong}>{t.page_checkout_safety()}</p>
                <p class={Muted}>{t.page_checkout_safety_description()}</p>
            </div>
        </section>
    }
}

/// A secret a create or rotate issued: the warning, Copy (corten-ui's, shown with the script), the secret,
/// and a link that leaves it once it is stored (marketplace's acknowledgement).
#[component(css = SecurityPage)]
fn SecretReveal<'a>(t: SecurityMsg, secret: &'a str, rotated: bool) -> impl Render {
    let title = if rotated { t.reveal_rotated_title() } else { t.reveal_created_title() };
    html! {
        <section class={Reveal} aria-labelledby="secret-title">
            <h2 id="secret-title" class={PartTitle}>{title}</h2>
            <p>{t.reveal_warning()}</p>
            <p class={Label} id="secret-label">{t.reveal_full_secret()}</p>
            <pre class={Secret} aria-labelledby="secret-label"><code id={SecretId}>{secret}</code></pre>
            <div class={Links}>
                <span class={CopyPrimary}>
                    <CopyButton text={SecretId} label={t.reveal_copy()} copied={t.reveal_copied()} />
                </span>
                <a class={(Button, Secondary)} href={url::Security::default()}>{t.manage_acknowledge_secret()}</a>
            </div>
        </section>
    }
}

/// Update Profile: the display, given and family names, off while its last write is unconfirmed.
#[component(css = SecurityPage)]
fn ProfileForm<'a>(t: SecurityMsg, draft: &'a Draft, held: bool) -> impl Render {
    let f = SecurityInput::FIELDS;
    let (i, e) = (&draft.input, draft.errors.within(UserFormId));
    // A display name must have a letter in it, as the account page's names (chase-sets/chase-sets#10688).
    let named = ".*\\S.*";
    html! {
        <form id={UserFormId} class={Form} method="post" action={url::Security::default()}>
            <input type="hidden" name={f.intent} value="update-user">
            {SubmitKey::field(f.attempt)}
            {draft.errors.form_message()}
            <fieldset class={Row} disabled={held}>
                <label class={Field}>
                    <span class={Label}>{t.user_display_name()}</span>
                    <input
                        type="text"
                        name={f.display_name}
                        value={&i.display_name}
                        required
                        pattern={named}
                        autocomplete="nickname"
                        {..e.aria(f.display_name)}
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.user_given_name()}</span>
                    <input
                        type="text"
                        name={f.given_name}
                        value={&i.given_name}
                        autocomplete="given-name"
                        {..e.aria(f.given_name)}
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.user_family_name()}</span>
                    <input
                        type="text"
                        name={f.family_name}
                        value={&i.family_name}
                        autocomplete="family-name"
                        {..e.aria(f.family_name)}
                    >
                </label>
                <button type="submit" class={Secondary}>{t.page_update_profile()}</button>
            </fieldset>
        </form>
    }
}

/// Create API Key: its name and purpose (only Integration).
#[component(css = SecurityPage)]
fn KeyForm<'a>(t: SecurityMsg, draft: &'a Draft, held: bool) -> impl Render {
    let f = SecurityInput::FIELDS;
    let (i, e) = (&draft.input, draft.errors.within(ApiKeyFormId));
    let named = ".*\\S.*";
    html! {
        <form id={ApiKeyFormId} class={Form} method="post" action={url::Security::default()}>
            <input type="hidden" name={f.intent} value="create-api-key">
            {SubmitKey::field(f.attempt)}
            {draft.errors.form_message()}
            <fieldset class={Row} disabled={held}>
                <label class={Field}>
                    <span class={Label}>{t.page_api_key_name()}</span>
                    <input
                        type="text"
                        name={f.name}
                        value={&i.name}
                        required
                        pattern={named}
                        autocomplete="off"
                        {..e.aria(f.name)}
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.page_purpose()}</span>
                    <select name={f.purpose}>
                        <option value="integration" selected>{t.page_integration()}</option>
                    </select>
                </label>
                <button type="submit" class={Primary}>{t.page_create_api_key()}</button>
            </fieldset>
        </form>
    }
}

/// A key: its name and status, and while it is active Rotate and Revoke (a dialog that asks first).
#[component(css = SecurityPage)]
fn KeyRow<'a>(t: SecurityMsg, p: Pilot, key: &'a ApiKey, said: &'a Said) -> impl Render {
    let f = SecurityInput::FIELDS;
    let id = key.api_key_id.as_str();
    let title = t.page_revoke_confirm_title(&key.name).to_string();
    let description = t.page_revoke_confirm_description(&key.name).to_string();
    let (title_id, text_id) = (format!("revoke-title-{id}"), format!("revoke-text-{id}"));
    html! {
        <li class={Key}>
            <dl class={Specs}>
                <div>
                    <dt>{t.page_api_key()}</dt>
                    <dd>{&key.name}</dd>
                </div>
                <div>
                    <dt>{t.page_status()}</dt>
                    <dd>{key_status(t, &key.status)}</dd>
                </div>
            </dl>
            if key.status == "active" {
                <div class={Links}>
                    <form method="post" action={url::Security::default()}>
                        <input type="hidden" name={f.intent} value="rotate-api-key">
                        <input type="hidden" name={f.api_key_id} value={id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="submit" class={Secondary} disabled={said.holds(AccountAction::RotateApiKey, Some(id))}>
                            {t.page_rotate()}
                        </button>
                    </form>
                    <button type="button" class={Danger} command="show-modal" commandfor={RevokeDialogId(id)}>
                        {t.page_revoke()}
                    </button>
                </div>
                <dialog id={RevokeDialogId(id)} class={Dialog} aria-labelledby={&title_id} aria-describedby={&text_id}>
                    <h3 id={&title_id} class={PartTitle}>{&title}</h3>
                    <p id={&text_id} class={Muted}>{&description}</p>
                    <form class={Links} method="post" action={url::Security::default()}>
                        <input type="hidden" name={f.intent} value="revoke-api-key">
                        <input type="hidden" name={f.api_key_id} value={id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="button" class={Secondary} command="close" commandfor={RevokeDialogId(id)}>
                            {p.addresses_cancel()}
                        </button>
                        <button type="submit" class={Danger} disabled={said.holds(AccountAction::RevokeApiKey, Some(id))}>
                            {t.page_revoke_confirm_action()}
                        </button>
                    </form>
                </dialog>
            }
        </li>
    }
}
