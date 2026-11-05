//! Provider detail's Operator session (admin-web's `OperatorSessionPanel`): the extension grant's
//! revision and state, Pair extension, and Disconnect with its box. Pair's answer draws the grant
//! once. With JavaScript it is hidden while `operator_session.js` hands it to the operator
//! extension, removed when the extension confirms and shown when it does not; without JavaScript it
//! is shown at once (the stylesheet's `scripting` rules). Copy is the kit's, shown with the script.
use corten::prelude::*;
use corten_ui::CopyButton;
use platform::ui::{
    button::{Button, ButtonSize, ButtonVariant},
    checkbox::Checkbox,
};

use super::integrations_page::{Banner, Empty, Pairs, Pill, when};
use crate::{
    catalog::{
        operator_session::{Answer, DisconnectInput, Disconnected, Failure, Metadata, Minted, Operator},
        provider::url,
    },
    text::{Cat, Pilot},
};

/// The grant's text, which Copy reads.
#[derive(Id, Clone, Copy)]
pub struct OperatorGrantId;

fn failure_text(t: Cat, failure: Failure) -> &'static str {
    match failure {
        Failure::StepUpRequired => t.os_step_up_message(),
        Failure::Unauthenticated => t.os_error_unauthenticated(),
        Failure::Forbidden => t.os_error_forbidden(),
        Failure::RateLimited => t.os_error_rate_limited(),
        Failure::CustodyUnavailable => t.os_error_custody_unavailable(),
        Failure::RevisionExhausted => t.os_error_revision_exhausted(),
        Failure::Unknown => t.os_error_unknown(),
    }
}

/// The panel, for a platform admin on TCGplayer: the status (or that it could not be read), Pair,
/// Disconnect while a grant exists, and what the last write came to.
#[component(css, js)]
pub fn OperatorSession<'a>(
    t: Cat,
    p: Pilot,
    key: &'a str,
    context: &'a str,
    operator: &'a Operator,
    answer: Option<&'a Answer>,
    sign_in: &'a str,
) -> impl Render {
    let at = |href: String| crate::catalog::daily::at(&href, context);
    let pair = at(url::Pair { key }.href().to_string());
    let disconnect = at(url::Disconnect { key }.href().to_string());
    let page = at(url::Provider { key }.href().to_string());
    let disconnectable = operator.metadata.as_ref().is_some_and(|m| m.grant.is_some());
    let f = DisconnectInput::FIELDS;
    html! {
        <section class={Panel} aria-labelledby="pd-operator-session" data-catalog-operator-session-panel="true">
            <h2 id="pd-operator-session" class={Title}>{t.os_title()}</h2>
            <p class={Muted}>{t.os_description()}</p>
            match &operator.metadata {
                Some(metadata) => { <Status t={t} metadata={metadata} /> }
                None => { <Empty title={t.os_unavailable_title()} description={t.os_unavailable_description()} /> }
            }
            <p class={Muted}>{t.os_pair_description()}</p>
            <div class={Actions}>
                <form method="post" action={&pair}>
                    <button type="submit" class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                        {t.os_pair_submit()}
                    </button>
                </form>
            </div>
            if disconnectable {
                <form method="post" action={&disconnect} class={Disconnect} data-catalog-operator-session-disconnect="true">
                    <p class={Muted}>{t.os_disconnect_dialog_description()}</p>
                    <Checkbox label={p.provider_os_disconnect_confirm()}>
                        <input type="checkbox" name={f.confirmed} value={DisconnectInput::CONFIRMED} required>
                    </Checkbox>
                    <div>
                        <button type="submit" class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}>
                            {t.os_disconnect_submit()}
                        </button>
                    </div>
                </form>
            }
            match answer {
                Some(Answer::Grant(minted)) => { <Grant t={t} p={p} minted={minted} page={&page} /> }
                Some(Answer::Failed(failure)) => {
                    <div class={Notice} role="alert">
                        <Banner tone="danger" title={failure_text(t, *failure)} description="" />
                        if failure.signs_in() {
                            <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={sign_in}>
                                {t.os_step_up_sign_in()}
                            </a>
                        }
                    </div>
                }
                Some(Answer::DisconnectIncomplete(failure)) => {
                    <div class={Notice} role="alert">
                        <Banner
                            tone="danger"
                            title={t.os_disconnect_outcome_partial_failure()}
                            description={
                                if *failure == Failure::RevisionExhausted { t.os_error_revision_exhausted() } else { "" }
                            }
                        />
                    </div>
                }
                Some(Answer::Disconnected(outcome, revision)) => {
                    let revision = revision.to_string();
                    match outcome {
                        Disconnected::StaleRevision => {
                            <div class={Notice} role="alert">
                                <Banner
                                    tone="danger"
                                    title={&t.os_disconnect_outcome_conflict(&revision).to_string()}
                                    description=""
                                />
                            </div>
                        }
                        Disconnected::Cleared => {
                            <div class={Notice} role="status">
                                <Banner
                                    tone="success"
                                    title={&t.os_disconnect_outcome_cleared(&revision).to_string()}
                                    description=""
                                />
                            </div>
                        }
                        Disconnected::Unchanged => {
                            <div class={Notice} role="status">
                                <Banner
                                    tone="success"
                                    title={&t.os_disconnect_outcome_unchanged(&revision).to_string()}
                                    description=""
                                />
                            </div>
                        }
                    }
                }
                None => {}
            }
        </section>
    }
}

/// The revision, the grant's state and its instants. The stored-at and browser expiry are never
/// drawn, as on admin-web: server credential custody is retired, as the panel's description says.
#[component(css = OperatorSession)]
fn Status<'a>(t: Cat, metadata: &'a Metadata) -> impl Render {
    let (state, tone) = match &metadata.grant {
        None => (t.os_grant_state_none(), "neutral"),
        Some(grant) if grant.active => (t.os_grant_state_active(), "success"),
        Some(_) => (t.os_grant_state_inactive(), "warning"),
    };
    let mut items = vec![(t.os_facts_revision(), metadata.revision.to_string())];
    if let Some(grant) = &metadata.grant {
        items.push((t.os_grant_created_at(), when(t, &grant.created_at)));
        items.push((t.os_grant_last_used_at(), when(t, &grant.last_used_at)));
        items.push((t.os_grant_idle_expires_at(), when(t, &grant.idle_expires_at)));
    }
    html! {
        <div class={Status}>
            <div class={Row}>
                <span class={Label}>{t.os_grant_heading()}</span>
                <Pill text={state} tone={tone} />
            </div>
            <Pairs items={&items} />
            if metadata.grant.as_ref().is_some_and(|g| !g.active) {
                <p class={Muted}>{t.os_grant_state_inactive_hint()}</p>
            }
        </div>
    }
}

/// The grant Pair minted, shown once. The script hands it to the extension first (`data-pending`
/// hides it meanwhile); Dismiss is the page without it.
#[component(css = OperatorSession, js = OperatorSession)]
fn Grant<'a>(t: Cat, p: Pilot, minted: &'a Minted, page: &'a str) -> impl Render {
    let expiry = when(t, &minted.idle_expires_at);
    html! {
        <div class={Handoff}>
            <p class={Pending} role="status" data-operator-pending="true">{t.os_pair_submitting()}</p>
            <p class={Paired} role="status" data-operator-paired="true" hidden>{t.os_pair_handoff_paired()}</p>
            <section
                class={Reveal}
                aria-labelledby="pd-operator-grant"
                data-operator-session-grant="true"
                data-pending="true"
                on:connect={js::handoff(target)}
            >
                <h3 id="pd-operator-grant" class={Title}>{t.os_pair_grant_heading()}</h3>
                <p>{t.os_pair_handoff_not_confirmed()}</p>
                <p>{t.os_pair_grant_once()}</p>
                <p>{t.os_pair_grant_paste()}</p>
                <pre class={Secret}><code id={OperatorGrantId}>{&minted.grant}</code></pre>
                <p class={Muted}>{&t.os_pair_grant_idle_expires_at(&expiry).to_string()}</p>
                <div class={Actions}>
                    <CopyButton
                        text={OperatorGrantId}
                        label={p.provider_os_copy()}
                        copied={p.provider_os_copied()}
                        class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}
                    />
                    <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={page}>
                        {t.os_pair_grant_dismiss()}
                    </a>
                </div>
            </section>
        </div>
    }
}
