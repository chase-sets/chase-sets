//! admin-web's sign-in page (`SignInPage` with `adminAuthHostConfig`), its account selection
//! (`AccountSelectionPage`) and a magic link that could not sign in (`MagicLinkLandingPage`).
//!
//! No script: each step is an address, each method a link and each action a form. One narrow
//! column on every screen, every control at least --control-height tall.
use corten::prelude::*;
use platform::auth::{Kind, Membership, Method};

use crate::{
    sign_in::{Ask, Back, Notice, SelectForm, SignInForm, SignInScreen, label, on_admin_web, url, workspace},
    text::SignInMsg,
};

/// The page.
#[component(css)]
pub fn SignInPage<'a>(t: SignInMsg, screen: &'a SignInScreen) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1 class={Title}>{t.page_sign_in()}</h1>
                <p class={Muted}>{t.page_use_social_email_or_phone()}</p>
            </header>
            if let Some(error) = screen.error {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.page_sign_in_failed()}</p>
                    <p>{error}</p>
                </div>
            } else {
                if let Some(error) = screen.social_error {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.page_sign_in_failed()}</p>
                        <p>{error}</p>
                    </div>
                }
            }
            if let Some(notice) = &screen.notice {
                <div class={Banner} data-tone="success" role="status">
                    if *notice == Notice::MagicLinkSent {
                        <p class={Strong}>{t.page_magic_link_sent()}</p>
                        <p>{t.page_magic_link_ready_check_your_email()}</p>
                    } else {
                        <p class={Strong}>{t.page_phone_code_sent()}</p>
                        <p>{t.page_phone_code_ready_check_your_phone()}</p>
                    }
                </div>
            }
            if let (Some((identifier, kind)), Some(method)) = (&screen.identifier, screen.method) {
                <Challenge
                    t={t}
                    ask={&screen.ask}
                    identifier={identifier}
                    kind={*kind}
                    method={method}
                    notice={screen.notice.as_ref()}
                />
            } else {
                <Start t={t} ask={&screen.ask} />
            }
        </div>
    }
}

/// The first step: Google Workspace, or an email or phone (a GET to the page, which offers its
/// methods).
#[component(css = SignInPage)]
fn Start<'a>(t: SignInMsg, ask: &'a Ask) -> impl Render {
    let f = Ask::FIELDS;
    html! {
        <section class={(Card, Flush)}>
            <p class={Muted}>{t.page_continue_with_workspace_account()}</p>
            <a class={(Button, Secondary)} href={&workspace(&ask.return_to())}>{t.page_continue_with_google_workspace()}</a>
        </section>
        <section class={Card}>
            <p class={Muted}>{t.page_you_can_sign_in_with()}</p>
            <ul class={Plain}>
                for method in Method::ALL {
                    <li>{label(t, method)}</li>
                }
            </ul>
            <form class={Form} method="get" action={url::SignIn::default()}>
                if let Some(back) = &ask.return_to {
                    <input type="hidden" name={f.return_to} value={back}>
                }
                <input type="hidden" name={f.sign_in_method} value={Method::Password.key()}>
                <label class={Field}>
                    <span class={Label}>{t.page_email_or_phone()}</span>
                    <input class={Input} type="text" name={f.sign_in_identifier} autocomplete="username" required>
                </label>
                <button type="submit">{t.page_continue()}</button>
            </form>
        </section>
    }
}

/// The second step: the identifier, a link per method it offers, and the method's form.
#[component(css = SignInPage)]
fn Challenge<'a>(
    t: SignInMsg,
    ask: &'a Ask,
    identifier: &'a str,
    kind: Kind,
    method: Method,
    notice: Option<&'a Notice>,
) -> impl Render {
    let f = SignInForm::FIELDS;
    let methods = kind.methods();
    let token_id = match notice {
        Some(Notice::PhoneCodeSent { token_id }) => Some(token_id.as_str()),
        _ => None,
    };
    html! {
        <div class={Row}>
            <p class={Muted}>{t.page_signing_in_with(identifier)}</p>
            <a class={(Button, Secondary, Small)} href={url::SignIn { ask: ask.change() }}>{t.page_change()}</a>
        </div>
        if methods.len() > 1 {
            <nav class={Methods} aria-label={t.page_method()}>
                for choice in methods {
                    <a
                        class={Choice}
                        href={url::SignIn { ask: ask.with_method(*choice) }}
                        aria-current={(*choice == method).then_some("true")}
                    >
                        {label(t, *choice)}
                    </a>
                }
            </nav>
        }
        <section class={Card}>
            if method == Method::Password {
                <form class={Form} method="post" action={url::SignIn { ask: ask.clone() }}>
                    <input type="hidden" name={f.intent} value="password">
                    <input type="hidden" name={f.email} value={identifier}>
                    <label class={Field}>
                        <span class={Label}>{t.page_password_2()}</span>
                        <input class={Input} type="password" name={f.password} autocomplete="current-password" required>
                    </label>
                    <button type="submit">{t.page_sign_in_2()}</button>
                </form>
            }
            if method == Method::MagicLink {
                <p class={Muted}>{t.page_magic_link_description()}</p>
                <form class={Form} method="post" action={url::SignIn { ask: ask.clone() }}>
                    <input type="hidden" name={f.intent} value="magic-link-request">
                    <input type="hidden" name={f.email} value={identifier}>
                    <button type="submit">{t.page_send_magic_link()}</button>
                </form>
            }
            if method == Method::PhoneCode {
                <form class={Form} method="post" action={url::SignIn { ask: ask.clone() }}>
                    <input type="hidden" name={f.intent} value="phone-code-request">
                    <input type="hidden" name={f.phone} value={identifier}>
                    <button type="submit">{t.page_send_phone_code()}</button>
                </form>
                // The code's form once a code is sent: it sends the request's id back.
                if let Some(token_id) = token_id {
                    <form class={Form} method="post" action={url::SignIn { ask: ask.clone() }}>
                        <input type="hidden" name={f.intent} value="phone-code-consume">
                        <input type="hidden" name={f.token_id} value={token_id}>
                        <input type="hidden" name={f.phone} value={identifier}>
                        <label class={Field}>
                            <span class={Label}>{t.page_phone_code_2()}</span>
                            <input
                                class={Input}
                                type="text"
                                name={f.code}
                                autocomplete="one-time-code"
                                inputmode="numeric"
                                required
                            >
                        </label>
                        <button class={Secondary} type="submit">{t.page_continue_with_code()}</button>
                    </form>
                }
            }
            if method == Method::Passkey {
                // WebAuthn is admin-web's page's script: the same identifier there.
                <a class={Button} href={&on_admin_web(ask)}>{t.page_use_passkey()}</a>
            }
        </section>
    }
}

/// The accounts the user may act for, each its own form.
#[component(css = SignInPage)]
pub fn AccountSelectPage<'a>(t: SignInMsg, memberships: &'a [Membership], error: Option<&'a str>, back: &'a Back) -> impl Render {
    let f = SelectForm::FIELDS;
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1 class={Title}>{t.select_choose_account()}</h1>
                <p class={Muted}>{t.select_this_user_can_act_for_more()}</p>
            </header>
            if let Some(error) = error {
                <div class={Banner} data-tone="danger" role="alert"><p>{error}</p></div>
            }
            for membership in memberships {
                <form
                    class={(Card, Form)}
                    method="post"
                    action={crate::sign_in::account_select::AccountSelect { back: back.clone() }}
                >
                    <input type="hidden" name={f.account_id} value={&membership.account_id}>
                    <div class={Tight}>
                        <h2 class={Name}>{&membership.account_name}</h2>
                        <p class={Muted}>{t.select_role(&membership.role_label)}</p>
                    </div>
                    <button type="submit">{t.select_continue()}</button>
                </form>
            }
        </div>
    }
}

/// A magic link that could not sign in: why, and the sign-in again.
#[component(css = SignInPage)]
pub fn MagicLinkFailed<'a>(t: SignInMsg, title: &'a str, description: &'a str, again: &'a url::SignIn) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{description}</p>
            </header>
            <p><a class={Button} href={again}>{t.magic_request_new_link()}</a></p>
        </div>
    }
}
