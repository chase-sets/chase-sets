//! The user's sessions (Auth's `SessionListPage` and `SessionDetailPage`). The list: the title,
//! the status filter (a plain GET form) with its chip and Clear, then one card per session (its
//! user, account, method and status) linking to its page, and the pages. A session's page: the
//! breadcrumb back to the list, the title with the status, what the last write did, Switch Account
//! (only the other accounts) and Revoke (a dialog that asks first) while it is active, and its
//! details. One column on a phone, every control at least 2.75rem tall; from 48rem a card's four
//! facts sit side by side.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::account_home_page::humanized;
use crate::{
    app::url,
    sessions::{Filters, ListScreen, Place, STATUSES, Said, SessionScreen, SwitchInput},
    text::{Pilot, SessionsMsg},
};

/// The dialog a session's Revoke opens.
#[derive(Id, Clone, Copy)]
pub struct RevokeSessionDialogId;

fn machine(
    known: Option<&'static str>,
    family: &str,
    value: &str,
    with_value: impl Fn(&str, &str) -> String,
    plain: impl Fn(&str) -> String,
) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => with_value(family, &human),
        (None, None) => plain(family),
    }
}

/// A session's status's words (`sessionStatusLabel`).
pub fn status(t: SessionsMsg, value: &str) -> String {
    let known = match value {
        "active" => Some(t.list_status_filter_active()),
        "revoked" => Some(t.list_status_filter_revoked()),
        "expired" => Some(t.list_status_filter_expired()),
        _ => None,
    };
    machine(
        known,
        t.value_family_session_status(),
        value,
        |f, v| t.value_unrecognized_with_value(f, v).to_string(),
        |f| t.value_unrecognized(f).to_string(),
    )
}

/// A sign-in method's words (`authenticationMethodLabel`).
pub fn method(t: SessionsMsg, value: &str) -> String {
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
    machine(
        known,
        t.method_family(),
        value,
        |f, v| t.method_unrecognized_with_value(f, v).to_string(),
        |f| t.method_unrecognized(f).to_string(),
    )
}

/// The list.
#[component(css)]
pub fn SessionsPage<'a>(t: SessionsMsg, p: Pilot, screen: &'a ListScreen) -> impl Render {
    let f = Filters::FIELDS;
    let chosen = screen.status.as_deref().unwrap_or("all");
    html! {
        <header class={Header}>
            <h1 class={Title}>{t.list_sessions()}</h1>
        </header>
        <form class={Filter} method="get" action={url::Sessions::default()}>
            <label class={Field}>
                <span class={Label}>{t.list_status()}</span>
                <select name={f.status}>
                    <option value="all" selected={chosen == "all"}>{t.list_status_filter_all()}</option>
                    for value in STATUSES {
                        <option value={value} selected={chosen == value}>{status(t, value)}</option>
                    }
                </select>
            </label>
            <button type="submit" class={Secondary}>{t.list_apply_filters()}</button>
            if screen.status.is_some() {
                <a class={(Button, Secondary)} href={url::Sessions::default()}>{t.list_clear_filters()}</a>
            }
        </form>
        if let Some(chip) = screen.status.as_deref() {
            <p class={Chip}>{t.list_status_filter_chip(&status(t, chip))}</p>
        }
        if screen.sessions.is_empty() {
            <p class={Muted}>{t.list_no_sessions_yet()}</p>
        } else {
            <ul class={Cards}>
                for session in &screen.sessions {
                    <li>
                        <a class={Card} href={url::SessionPage { id: &session.session_id, place: Place::default() }}>
                            <dl class={Facts}>
                                <div>
                                    <dt>{t.list_user()}</dt>
                                    <dd>{session.user()}</dd>
                                </div>
                                <div>
                                    <dt>{t.list_account()}</dt>
                                    <dd>{session.account()}</dd>
                                </div>
                                <div>
                                    <dt>{t.list_method()}</dt>
                                    <dd>{method(t, &session.authentication_method)}</dd>
                                </div>
                                <div>
                                    <dt>{t.list_status()}</dt>
                                    <dd><span class={Badge} data-status={&session.status}>{status(t, &session.status)}</span></dd>
                                </div>
                            </dl>
                        </a>
                    </li>
                }
            </ul>
        }
        if screen.paged() {
            <Pager p={p} screen={screen} />
        }
    }
}

/// The list's pages, as links: Previous, the numbers, Next.
#[component(css = SessionsPage)]
fn Pager<'a>(p: Pilot, screen: &'a ListScreen) -> impl Render {
    let (page, pages) = screen.page();
    html! {
        <nav class={Pages} aria-label={p.account_pagination()}>
            if page > 1 {
                <a class={(Button, Secondary)} href={&screen.page_href(page - 1)}>{p.account_previous_page()}</a>
            }
            <ul class={Numbers}>
                for number in &super::account_page::page_range(page, pages) {
                    <li>
                        match number {
                            Some(n) => {
                                <a
                                    class={(Button, Secondary)}
                                    href={&screen.page_href(*n)}
                                    aria-current={(*n == page).then_some("page")}
                                    aria-label={&p.account_page_number(*n).to_string()}
                                >
                                    {*n}
                                </a>
                            }
                            None => { <span class={Muted} aria-hidden="true">"\u{2026}"</span> }
                        }
                    </li>
                }
            </ul>
            if page < pages {
                <a class={(Button, Secondary)} href={&screen.page_href(page + 1)}>{p.account_next_page()}</a>
            }
        </nav>
    }
}

/// A session's page.
#[component(css = SessionsPage)]
pub fn SessionPage<'a>(t: SessionsMsg, p: Pilot, screen: &'a SessionScreen) -> impl Render {
    let s = &screen.session;
    let user = s.user();
    let account = s.account();
    let active = s.status == "active";
    let others: Vec<&str> = s.others().collect();
    let expires = parse_timestamp(&s.expires_at).map_or_else(
        || t.value_date_unavailable().to_owned(),
        |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
    );
    let banner = screen.said.map(|said| match said {
        Said::Revoked => ("info", p.sessions_revoked()),
        Said::Switched => ("info", p.sessions_switched()),
        Said::NotActive => ("warning", p.sessions_not_active()),
        Said::SwitchRefused => ("danger", p.sessions_switch_refused()),
        Said::Failed => ("warning", p.sessions_failed()),
    });
    let f = SwitchInput::FIELDS;
    let id = s.session_id.as_str();
    html! {
        <nav class={Crumbs} aria-label={t.list_sessions()}>
            <a href={url::Sessions::default()}>{t.list_sessions()}</a>
            <span aria-hidden="true">"/"</span>
            <span aria-current="page">{user}</span>
        </nav>
        <header class={Header}>
            <h1 class={Title}>{t.detail_title(user)}</h1>
            <span class={Badge} data-status={&s.status}>{status(t, &s.status)}</span>
        </header>
        <div class={Status} role="status" aria-live="polite">
            if let Some((tone, text)) = banner {
                <div class={Banner} data-tone={tone} tabindex="-1" autofocus>
                    <p>{text}</p>
                </div>
            }
            if screen.pending {
                <div class={Banner} data-tone="warning">
                    <p>{p.sessions_pending()}</p>
                </div>
            }
        </div>
        if active {
            <div class={Actions}>
                if !others.is_empty() {
                    <form class={Switch} method="post" action={url::SessionSwitch { id }}>
                        <label class={Field}>
                            <span class={Label}>{p.sessions_other_accounts()}</span>
                            <select name={f.account_id} required>
                                for other in &others {
                                    <option value={*other}>{*other}</option>
                                }
                            </select>
                        </label>
                        <button type="submit" class={Secondary}>{t.detail_switch_account()}</button>
                    </form>
                }
                <button type="button" class={Danger} command="show-modal" commandfor={RevokeSessionDialogId}>
                    {t.detail_revoke()}
                </button>
                <dialog id={RevokeSessionDialogId} class={Dialog} aria-labelledby="revoke-title" aria-describedby="revoke-text">
                    <h2 id="revoke-title" class={PartTitle}>{t.detail_revoke_confirm_title(user)}</h2>
                    <p id="revoke-text" class={Muted}>{t.detail_revoke_confirm_description(user, account)}</p>
                    <form class={Buttons} method="post" action={url::SessionRevoke { id }}>
                        <button type="button" class={Secondary} command="close" commandfor={RevokeSessionDialogId}>
                            {p.addresses_cancel()}
                        </button>
                        <button type="submit" class={Danger}>{t.detail_revoke_confirm_action()}</button>
                    </form>
                </dialog>
            </div>
        }
        <dl class={Details}>
            <div>
                <dt>{t.detail_session_id()}</dt>
                <dd class={Code}>{id}</dd>
            </div>
            <div>
                <dt>{t.detail_user()}</dt>
                <dd>{user}</dd>
            </div>
            <div>
                <dt>{t.detail_active_account()}</dt>
                <dd>{account}</dd>
            </div>
            <div>
                <dt>{t.detail_available_accounts()}</dt>
                <dd>{s.available_account_ids.join(", ")}</dd>
            </div>
            <div>
                <dt>{t.detail_authentication_method()}</dt>
                <dd>{method(t, &s.authentication_method)}</dd>
            </div>
            <div>
                <dt>{t.detail_expires_at()}</dt>
                <dd>{&expires}</dd>
            </div>
        </dl>
    }
}
