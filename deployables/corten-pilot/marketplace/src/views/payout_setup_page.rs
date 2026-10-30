//! Payout setup (Settlement's `PayoutSetupPage`, `PayoutReadinessPanel` and
//! `StripeConnectNotificationBanner`): the header with Back to payouts and the other view, the
//! refreshed notice, Stripe's payout notifications, the current status with the readiness panel
//! (what to do next, the steps, what needs attention in a fold), Refresh setup status, and Stripe's
//! form or "Payouts are ready".
//!
//! The page needs no script but Stripe's: its folds are `<details>`, Refresh is a form, Retry is a
//! link to the page. Stripe's components (`ConnectSurface`, `payout_connect.js`) say they are
//! loading, then show Stripe's form, or why it could not load. One column on a phone; the steps
//! two to a row from 48rem.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    api::{PayoutReadiness, RequirementGroup},
    app::url,
    payout_setup::{Mode, Place, REFRESH, SetupForm, SetupScreen, Which},
    text::MoneyMsg,
};

const NONE: [(&str, &str); 0] = [];

/// A panel message by the key a rule chose (`recovery`).
fn panel(t: MoneyMsg, key: &str) -> String {
    t.by_key(&format!("setup_panel.{key}"), &NONE).map_or_else(String::new, |m| m.to_string())
}

fn date_time(t: MoneyMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// The setup's status as a badge and a headline (`statusLabel`, `statusTone`, `statusHeadline`).
fn status(t: MoneyMsg, status: &str) -> (&'static str, &'static str, &'static str) {
    match status {
        "ready" => (t.setup_ready(), "success", t.setup_payout_setup_is_ready()),
        "restricted" => (t.setup_needs_attention(), "danger", t.setup_payout_setup_needs_attention()),
        "not-started" => (t.setup_not_started(), "neutral", t.setup_start_payout_setup()),
        _ => (t.setup_in_progress(), "warning", t.setup_finish_payout_setup()),
    }
}

/// The panel's readiness title and description (`readinessTitle`, `readinessDescription`).
fn readiness_words(t: MoneyMsg, status: &str) -> (&'static str, &'static str) {
    match status {
        "ready" => (t.setup_panel_payouts_are_ready(), t.setup_payout_setup_is_complete_and_available()),
        "restricted" => (t.setup_panel_payout_setup_needs_attention(), t.setup_panel_some_payout_details_need_to_be()),
        "not-started" => (t.setup_panel_set_up_payouts(), t.setup_panel_add_a_payout_account_using_the()),
        _ => (t.setup_panel_finish_setup_to_receive_payouts(), t.setup_panel_continue_the_hosted_setup_flow_before()),
    }
}

/// A capability's or step's state in words (`setupStatusLabel`).
fn state(t: MoneyMsg, value: &str) -> String {
    match value {
        "not-started" => t.setup_panel_not_started_2().to_owned(),
        "pending" => t.setup_panel_needs_attention_2().to_owned(),
        "complete" | "active" | "ready" => t.setup_panel_ready_2().to_owned(),
        "inactive" | "missing" => t.setup_panel_missing().to_owned(),
        other => other.replace(['_', '.'], " "),
    }
}

/// A step's badge (`progressLabel`, `progressTone`).
fn step(t: MoneyMsg, status: &str) -> (&'static str, &'static str) {
    match status {
        "ready" => (t.setup_panel_ready_3(), "success"),
        "needs-attention" => (t.setup_panel_needs_attention_3(), "warning"),
        "pending" => (t.setup_panel_in_review(), "accent"),
        _ => (t.setup_panel_not_started_3(), "neutral"),
    }
}

/// A requirement group's name and what to do about it, in the panel's words.
fn group(t: MoneyMsg, id: &str) -> (&'static str, &'static str) {
    match id {
        "payout-account" => (t.setup_panel_payout_account(), t.setup_panel_add_or_confirm_the_payout_destination()),
        "identity-and-business" => {
            (t.setup_panel_identity_and_business_details(), t.setup_panel_review_account_identity_or_business())
        }
        "account-agreement" => (t.setup_panel_account_agreement(), t.setup_panel_review_and_accept_the_required_account()),
        "platform-review" => (t.setup_panel_platform_review(), t.setup_panel_platform_review_description()),
        _ => (t.setup_panel_verification_review(), t.setup_panel_review_the_remaining_verification_details()),
    }
}

/// A group's name in the page's support details (`requirementGroupLabel`).
fn support_group(t: MoneyMsg, id: &str) -> &'static str {
    match id {
        "payout-account" => t.setup_payout_account(),
        "identity-and-business" => t.setup_identity_and_business_details(),
        "account-agreement" => t.setup_account_agreement(),
        "platform-review" => t.setup_platform_review(),
        _ => t.setup_verification_review(),
    }
}

/// The page.
#[component(css)]
pub fn PayoutSetupPage<'a>(t: MoneyMsg, screen: &'a SetupScreen) -> impl Render {
    let readiness = &screen.readiness;
    let groups = &screen.progress.missing_requirement_groups;
    let (label, tone, headline) = status(t, &readiness.status);
    let other = match screen.mode {
        Mode::Management => (Mode::Setup, t.setup_setup_view()),
        Mode::Setup => (Mode::Management, t.setup_manage_details()),
    };
    let here = url::PayoutSetup { place: Place::of(screen.mode, screen.return_to.clone()) };
    let missing: u64 = groups.iter().map(|g| g.count).sum();
    let (provider_title, provider_description) = match screen.mode {
        Mode::Management => (t.setup_manage_payout_details(), t.setup_review_or_update_the_details()),
        Mode::Setup => (t.setup_complete_payout_setup(), t.setup_add_the_required_account_and()),
    };
    let f = SetupForm::FIELDS;
    html! {
        <header class={Header}>
            <div class={Tight}>
                <p class={Eyebrow}>{t.setup_settlement()}</p>
                <h1 class={Title}>{t.setup_payout_setup()}</h1>
                <p class={Muted}>{t.setup_keep_your_payout_destination()}</p>
            </div>
            <p class={Row}>
                <a class={(Button, Secondary)} href={url::Money::default()}>{t.setup_back_to_payouts()}</a>
                if screen.has_provider {
                    <a
                        class={(Button, Secondary)}
                        href={url::PayoutSetup { place: Place::of(other.0, screen.return_to.clone()) }}
                    >
                        {other.1}
                    </a>
                }
            </p>
        </header>
        if screen.refreshed {
            <div class={Banner} data-tone="success" role="status">
                <p class={Strong}>{t.setup_setup_status_checked()}</p>
                <p>{t.setup_route_payout_setup_status_was_refreshed()}</p>
            </div>
        }
        if screen.has_provider {
            <section class={Section} aria-labelledby="payout-notifications-title">
                <h2 id="payout-notifications-title" class={PartTitle}>{t.setup_payout_notifications()}</h2>
                <ConnectSurface
                    t={t}
                    which={Which::of(crate::api::ConnectSession::Notifications)}
                    key={screen.publishable_key.as_deref()}
                    retry={None}
                    label={t.setup_notification_banner_aria_label()}
                />
            </section>
        }
        <section class={Section} aria-labelledby="payout-status-title">
            <h2 id="payout-status-title" class={PartTitle}>{t.setup_current_status()}</h2>
            <div class={Card}>
                <div class={Tight}>
                    <p><span class={Badge} data-tone={tone}>{label}</span></p>
                    <p class={Strong}>{headline}</p>
                    <p class={Muted}>{provider_description}</p>
                </div>
                <Panel t={t} readiness={readiness} screen={screen} />
                if missing > 0 {
                    <details class={Fold}>
                        <summary>
                            <span class={Strong}>{t.setup_support_details()}</span>
                            " "
                            <span class={Muted}>{t.setup_requirement_count(&missing.to_string())}</span>
                        </summary>
                        <ul class={Plain}>
                            for g in groups {
                                <li class={Muted}>
                                    {support_group(t, &g.id)}": "{t.setup_requirement_group_count(&g.count.to_string())}
                                </li>
                            }
                        </ul>
                    </details>
                }
                <form method="post" action={&here} class={Row}>
                    <input type="hidden" name={f.intent} value={REFRESH}>
                    <input
                        type="hidden"
                        name={f.mode}
                        value={if screen.mode == Mode::Management { "management" } else { "setup" }}
                    >
                    <button type="submit" class={(Button, Secondary)} id="payout-refresh">
                        {t.setup_refresh_setup_status()}
                    </button>
                </form>
            </div>
        </section>
        <section class={Section} aria-labelledby="payout-provider-title">
            <h2 id="payout-provider-title" class={PartTitle}>{provider_title}</h2>
            if let Some(error) = &screen.error {
                <div class={Banner} data-tone="warning" role="alert" tabindex="-1" autofocus>
                    <p class={Strong}>{t.setup_setup_could_not_load()}</p>
                    <p>{t.setup_setup_load_failed_with_reason(error)}</p>
                    <p class={Row}>
                        <a class={(Button, Secondary)} href={&here}>{t.setup_retry()}</a>
                        <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.setup_contact_support()}</a>
                    </p>
                </div>
            }
            if screen.offers_provider {
                <ConnectSurface
                    t={t}
                    which={Which::of(screen.mode.session())}
                    key={screen.publishable_key.as_deref()}
                    retry={Some(&here)}
                    label={provider_title}
                />
            } else {
                <div class={Banner} data-tone="success">
                    <p class={Strong}>{t.setup_payouts_are_ready()}</p>
                    <p>{t.setup_you_can_request_payouts()}</p>
                    <p class={Row}><a class={Button} href={url::Money::default()}>{t.setup_request_payout()}</a></p>
                </div>
            }
        </section>
    }
}

/// The readiness panel (`PayoutReadinessPanel`, without its actions, which the money page has).
#[component(css = PayoutSetupPage)]
fn Panel<'a>(t: MoneyMsg, readiness: &'a PayoutReadiness, screen: &'a SetupScreen) -> impl Render {
    let groups: &[RequirementGroup] = &screen.progress.missing_requirement_groups;
    let upcoming = &screen.progress.advisory_requirement_groups;
    let (title, description) = readiness_words(t, &readiness.status);
    let (label, tone, _) = status(t, &readiness.status);
    let checked =
        readiness.updated_at.as_deref().map_or_else(|| t.setup_panel_not_checked_yet().to_owned(), |at| date_time(t, at));
    let ready = readiness.status == "ready";
    let summary = match groups.first() {
        Some(first) => t.setup_panel_requirement_group_needs_attention(group(t, &first.id).0).to_string(),
        None if ready => t.setup_panel_ready().to_owned(),
        None => state(t, &readiness.onboarding_status),
    };
    let recovery = screen.recovery.as_ref().map(|r| {
        let description = if r.description == "complete.requested.groups" {
            let names: Vec<&str> = r.groups.iter().map(|id| group(t, id).0).collect();
            t.setup_panel_complete_requested_groups(&names.join(", ")).to_string()
        } else {
            panel(t, r.description)
        };
        (r.tone, panel(t, r.title), description, screen.offers_support)
    });
    let specs = [
        (t.setup_panel_onboarding(), &readiness.onboarding_status),
        (t.setup_panel_transfers(), &readiness.transfer_capability_status),
        (t.setup_panel_payouts(), &readiness.payout_capability_status),
        (t.setup_panel_payout_destination(), &readiness.payout_destination_status),
    ];
    html! {
        <div class={Tight}>
            <p><span class={Badge} data-tone={tone}>{label}</span></p>
            <p class={Strong}>{title}</p>
            <p class={Muted}>{description}</p>
            <p class={Muted}>{t.setup_panel_last_checked()}{&checked}</p>
        </div>
        if let Some((tone, title, description, support)) = &recovery {
            <div class={Banner} data-tone={*tone}>
                <p class={Strong}>{title}</p>
                <p>{description}</p>
                if *support {
                    <p class={Row}>
                        <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.setup_panel_contact_support()}</a>
                    </p>
                }
            </div>
        }
        if !upcoming.is_empty() {
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.setup_panel_future_requirements()}</p>
                <p>{t.setup_panel_future_requirements_description()}</p>
            </div>
        }
        <ol class={Steps}>
            for s in &screen.progress.steps {
                <li class={Step}>
                    <p><span class={Badge} data-tone={step(t, &s.status).1}>{step(t, &s.status).0}</span></p>
                    <p class={Strong}>{&s.label}</p>
                    <p class={Muted}>{&s.detail}</p>
                </li>
            }
        </ol>
        <details
            class={Fold}
            open={readiness.status == "restricted"}
            data-tone={if groups.is_empty() { "info" } else { "warning" }}
        >
            <summary>
                <span class={Strong}>{t.setup_panel_what_needs_attention()}</span>
                " "
                <span class={Muted}>{&summary}</span>
            </summary>
            <dl class={Specs}>
                for (name, value) in specs {
                    <div>
                        <dt>{name.trim_end_matches(": ")}</dt>
                        <dd>{state(t, value)}</dd>
                    </div>
                }
                if let Some(deadline) = &readiness.requirements_deadline {
                    <div>
                        <dt>{t.setup_panel_requirements_deadline()}</dt>
                        <dd>{date_time(t, deadline)}</dd>
                    </div>
                }
            </dl>
            if !groups.is_empty() {
                <p class={Strong}>{t.setup_panel_what_needs_attention()}</p>
                <ul class={Plain}>
                    for g in groups {
                        <li class={Muted}>
                            {group(t, &g.id).0}": "{t.setup_panel_requirement_group_count(&g.count.to_string())}" "
                            {group(t, &g.id).1}
                        </li>
                    }
                </ul>
            }
            if !upcoming.is_empty() {
                <p class={Strong}>{t.setup_panel_upcoming_requirements()}</p>
                <ul class={Plain}>
                    for g in upcoming {
                        <li class={Muted}>{group(t, &g.id).0}": "{group(t, &g.id).1}</li>
                    }
                </ul>
            }
        </details>
        if ready {
            <p class={Muted}>{t.setup_panel_eligible_seller_balances()}</p>
        }
    }
}

/// Stripe's component for `which`: loading words, the place Stripe's form joins, and why it could
/// not load (with Sign in again when Settlement asks the seller to confirm it is them, and Retry
/// and Contact support for setup). Without a key it says setup is not configured; without a
/// script, that Stripe's form needs one.
#[component(css = PayoutSetupPage, js)]
pub fn ConnectSurface<'a>(
    t: MoneyMsg,
    which: Which,
    key: Option<&'a str>,
    retry: Option<&'a url::PayoutSetup>,
    label: &'a str,
) -> impl Render {
    let session = url::PayoutSetupSession { which: which.clone() };
    let setup = retry.is_some();
    let (loading, error, error_text, step_up, step_up_text) = refs();
    let parts = js::Parts { loading, error, error_text, step_up, step_up_text };
    let session = session.href();
    let could_not_load =
        if setup { t.setup_provider_component_could_not_load() } else { t.setup_notification_banner_could_not_load_detail() };
    let no_session =
        if setup { t.setup_session_could_not_be_created() } else { t.setup_notification_banner_could_not_be_created() };
    let back = retry.map(|r| url::SignIn { ask: crate::sign_in::Ask::back_to(&r.href()) });
    html! {
        <div class={Provider}>
            match key {
                Some(key) => {
                    <p ref={loading} class={Muted} role="status">
                        {if setup { t.setup_loading_secure_setup() } else { t.setup_notification_banner_loading() }}
                    </p>
                    <noscript><p class={Muted}>{t.setup_connect_can_only_load_in_browser()}</p></noscript>
                    <div ref={error} class={Banner} data-tone="warning" role="alert" hidden>
                        <p class={Strong}>
                            {if setup { t.setup_setup_could_not_load() } else { t.setup_notification_banner_could_not_load() }}
                        </p>
                        <p ref={error_text}></p>
                        if let Some(retry) = retry {
                            <p class={Row}>
                                <a class={(Button, Secondary)} href={retry}>{t.setup_retry()}</a>
                                <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.setup_contact_support()}</a>
                            </p>
                        }
                    </div>
                    <div ref={step_up} class={Banner} data-tone="warning" role="alert" hidden>
                        <p class={Strong}>{t.setup_confirm_it_is_you()}</p>
                        <p ref={step_up_text}>{t.setup_sign_in_again_to_manage_payouts()}</p>
                        <p class={Row}>
                            if let Some(back) = &back {
                                <a class={Button} href={back}>{t.setup_sign_in_again()}</a>
                            }
                            if let Some(retry) = retry {
                                <a class={(Button, Secondary)} href={retry}>{t.setup_retry()}</a>
                            }
                        </p>
                    </div>
                    <div
                        class={Surface}
                        aria-label={label}
                        on:connect={js::mount(target, parts, key, &session, could_not_load, no_session, signal)}
                    ></div>
                }
                None => {
                    <div class={Banner} data-tone="warning" role="alert">
                        <p class={Strong}>
                            {if setup { t.setup_setup_could_not_load() } else { t.setup_notification_banner_could_not_load() }}
                        </p>
                        <p>{t.setup_provider_setup_is_not_configured()}</p>
                    </div>
                }
            }
        </div>
    }
}

/// An account that may not set up payouts (marketplace's `AccountAccessRequiredPage`).
#[component(css = PayoutSetupPage)]
pub fn PayoutSetupAccessRequired<'a>(t: MoneyMsg, back: &'a str) -> impl Render {
    let sign_in = url::SignIn { ask: crate::sign_in::Ask::back_to(back) };
    html! {
        <header class={Header}>
            <div class={Tight}>
                <p class={Eyebrow}>{t.setup_route_account_access()}</p>
                <h1 class={Title}>{t.setup_route_account_access_required_title()}</h1>
                <p class={Muted}>{t.setup_route_account_access_required_description()}</p>
            </div>
        </header>
        <section class={Section} aria-labelledby="payout-next-step-title">
            <h2 id="payout-next-step-title" class={PartTitle}>{t.setup_route_next_step()}</h2>
            <p>{t.setup_route_use_an_account_with_payout_setup_access()}</p>
            <p class={Row}>
                <a class={Button} href={&sign_in}>{t.setup_route_use_a_different_account()}</a>
                <a class={(Button, Secondary)} href={url::AccountHome::default()}>{t.setup_route_view_account()}</a>
            </p>
        </section>
    }
}
