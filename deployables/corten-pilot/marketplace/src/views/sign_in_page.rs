//! Marketplace's sign-in page (`SignInPage`), its registration page (`RegisterPage`), its account
//! selection (`AccountSelectionPage`) and a magic link that could not sign in
//! (`MagicLinkLandingPage`).
//!
//! No script: each step is an address, each method a link and each action a form. One narrow
//! column on every screen, every control at least --control-height (44 px) tall.
use corten::prelude::*;

use crate::{
    api::segment,
    app::url,
    invite::{self, AcceptForm, Invitation, InviteScreen},
    register::{self, Join, RegisterForm, RegisterScreen},
    sign_in::{
        Ask, Back, DEFAULT_SUCCESS, Kind, Membership, Method, Notice, SelectForm, SignInForm, SignInScreen, on_marketplace,
        safe_return_to,
    },
    text::SignInMsg,
};

/// A social sign-in's start, on marketplace's origin, where the provider comes back to.
fn social(provider: &str, return_to: &str) -> String {
    super::on_marketplace(&format!("/api/auth/social/{provider}/start?journey=sign-in&returnTo={}", segment(return_to)))
}

/// The page.
#[component(css)]
pub fn SignInPage<'a>(t: SignInMsg, screen: &'a SignInScreen) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1 class={Title}>{t.page_sign_in()}</h1>
                <p class={Muted}>{t.page_use_social_email_or_phone()}</p>
            </header>
            if let Some((title, description)) = screen.context {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{title}</p>
                    <p>{description}</p>
                </div>
            }
            if let Some(error) = &screen.error {
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

/// The first step: a social account, or an email or phone (a GET to the page, which offers its
/// methods).
#[component(css = SignInPage)]
fn Start<'a>(t: SignInMsg, ask: &'a Ask) -> impl Render {
    let f = Ask::FIELDS;
    let return_to = safe_return_to(ask.return_to.as_deref(), DEFAULT_SUCCESS);
    html! {
        <section class={(Card, Flush)}>
            <p class={Muted}>{t.page_continue_with_social_login()}</p>
            <div class={Row}>
                <a class={(Button, Secondary)} href={&social("google", &return_to)}>{t.page_continue_with_google()}</a>
                <a class={(Button, Secondary)} href={&social("facebook", &return_to)}>{t.page_continue_with_facebook()}</a>
            </div>
        </section>
        <section class={Card}>
            <p class={Muted}>{t.page_you_can_sign_in_with()}</p>
            <ul class={Plain}>
                for method in Method::ALL {
                    <li>{method.label(t)}</li>
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
                        {choice.label(t)}
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
                // WebAuthn is marketplace's page's script: the same identifier there.
                <a class={Button} href={&on_marketplace(ask)}>{t.page_use_passkey()}</a>
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
                <form class={(Card, Form)} method="post" action={url::AccountSelect { back: back.clone() }}>
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

/// A social registration's start, on marketplace's origin, where the provider comes back to.
fn social_registration(provider: &str, return_to: &str) -> String {
    super::on_marketplace(&format!("/api/auth/social/{provider}/start?journey=registration&returnTo={}", segment(return_to)))
}

/// Creating an account: a social account, or a method's form. Marketplace's segmented control is a
/// row of links, one per method.
#[component(css = SignInPage)]
pub fn RegisterPage<'a>(t: SignInMsg, screen: &'a RegisterScreen) -> impl Render {
    let method = screen.method;
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1 class={Title}>{t.register_create_account()}</h1>
                <p class={Muted}>{t.register_create_your_personal_identity_and_owner()}</p>
            </header>
            if let Some((title, description)) = screen.context {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{title}</p>
                    <p>{description}</p>
                </div>
            }
            if let Some(error) = &screen.error {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.register_registration_failed()}</p>
                    <p>{error}</p>
                </div>
            } else {
                if let Some(error) = screen.social_error {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.register_registration_failed()}</p>
                        <p>{error}</p>
                    </div>
                }
            }
            if let Some(notice) = &screen.notice {
                <div class={Banner} data-tone="success" role="status">
                    if *notice == register::Notice::MagicLinkSent {
                        <p class={Strong}>{t.page_magic_link_sent()}</p>
                        <p>{t.page_magic_link_ready_check_your_email()}</p>
                    } else {
                        <p class={Strong}>{t.register_phone_code_sent()}</p>
                        <p>{t.register_phone_code_ready_check_your_phone()}</p>
                    }
                </div>
            }
            <section class={(Card, Flush)}>
                <p class={Muted}>{t.register_use_an_account_you_already_have()}</p>
                <div class={Row}>
                    <a class={(Button, Secondary)} href={&social_registration("google", &screen.return_to)}>
                        {t.register_continue_with_google()}
                    </a>
                    <a class={(Button, Secondary)} href={&social_registration("facebook", &screen.return_to)}>
                        {t.register_continue_with_facebook()}
                    </a>
                </div>
            </section>
            <nav class={Methods} aria-label={t.register_method()}>
                for choice in register::Method::ALL {
                    <a
                        class={Choice}
                        href={url::Register { join: screen.join.with_method(choice) }}
                        aria-current={(choice == method).then_some("true")}
                    >
                        {choice.label(t)}
                    </a>
                }
            </nav>
            <MethodForm t={t} screen={screen} />
        </div>
    }
}

/// The display name and email every email method asks for, as last sent.
#[component(css = SignInPage)]
fn Identity<'a>(t: SignInMsg, typed: &'a RegisterForm) -> impl Render {
    let f = RegisterForm::FIELDS;
    html! {
        <label class={Field}>
            <span class={Label}>{t.register_display_name()}</span>
            <input class={Input} type="text" name={f.display_name} autocomplete="name" required value={&typed.display_name}>
        </label>
        <label class={Field}>
            <span class={Label}>{t.register_email()}</span>
            <input class={Input} type="email" name={f.email} autocomplete="email" required value={&typed.email}>
        </label>
    }
}

/// The shown method's form (or, for a passkey, marketplace's page).
#[component(css = SignInPage)]
fn MethodForm<'a>(t: SignInMsg, screen: &'a RegisterScreen) -> impl Render {
    let f = RegisterForm::FIELDS;
    let action = url::Register { join: Join { registration_method: None, social_login_error: None, ..screen.join.clone() } };
    let typed = &screen.typed;
    let token_id = match &screen.notice {
        Some(register::Notice::PhoneCodeSent { token_id }) => Some(token_id.as_str()),
        _ => None,
    };
    html! {
        if screen.method == register::Method::Passkey {
            <section class={Card}>
                <div class={Row}>
                    <span class={Badge}>{t.register_recommended()}</span>
                    <p class={Muted}>{t.register_passkey_recommended_copy()}</p>
                </div>
                // WebAuthn is marketplace's page's script.
                <a class={Button} href={&register::on_marketplace(&screen.join)}>{t.register_create_with_passkey()}</a>
            </section>
        }
        if screen.method == register::Method::MagicLink {
            <form class={(Card, Form)} method="post" action={&action}>
                <input type="hidden" name={f.intent} value="magic-link-register">
                <p class={Muted}>{t.register_magic_link_copy()}</p>
                <Identity t={t} typed={typed} />
                <button type="submit">{t.register_email_me_magic_link()}</button>
            </form>
        }
        if screen.method == register::Method::PhoneCode {
            <form class={(Card, Form)} method="post" action={&action}>
                <input type="hidden" name={f.intent} value="phone-code-request">
                <p class={Muted}>{t.register_phone_code_copy()}</p>
                <label class={Field}>
                    <span class={Label}>{t.register_display_name()}</span>
                    <input
                        class={Input}
                        type="text"
                        name={f.display_name}
                        autocomplete="name"
                        required
                        value={&typed.display_name}
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.register_phone()}</span>
                    <input class={Input} type="tel" name={f.phone} autocomplete="tel" required value={&typed.phone}>
                </label>
                <button type="submit">{t.register_text_me_a_code()}</button>
            </form>
            // The code's form once a code is sent: it sends the request's id back with the name.
            if let Some(token_id) = token_id {
                <form class={(Card, Form)} method="post" action={&action}>
                    <input type="hidden" name={f.intent} value="phone-code-consume">
                    <input type="hidden" name={f.token_id} value={token_id}>
                    <input type="hidden" name={f.display_name} value={&typed.display_name}>
                    <p class={Muted}>{t.register_enter_phone_code_copy()}</p>
                    <label class={Field}>
                        <span class={Label}>{t.register_phone()}</span>
                        <input class={Input} type="tel" name={f.phone} autocomplete="tel" required value={&typed.phone}>
                    </label>
                    <label class={Field}>
                        <span class={Label}>{t.register_phone_code_2()}</span>
                        <input class={Input} type="text" name={f.code} autocomplete="one-time-code" inputmode="numeric" required>
                    </label>
                    <button class={Secondary} type="submit">{t.register_create_account_with_code()}</button>
                </form>
            }
        }
        if screen.method == register::Method::Password {
            <form class={(Card, Form)} method="post" action={&action}>
                <input type="hidden" name={f.intent} value="password">
                <p class={Muted}>{t.register_password_fallback_copy()}</p>
                <Identity t={t} typed={typed} />
                <label class={Field}>
                    <span class={Label}>{t.register_password_2()}</span>
                    <input class={Input} type="password" name={f.password} autocomplete="new-password" required>
                </label>
                <button class={Secondary} type="submit">{t.register_create_account_with_password()}</button>
            </form>
        }
    }
}

/// Accepting an invitation: who sent it and as what, then a passkey (marketplace's page) or a
/// password; once an attempt has a state of its own, that state, Sign in and Check status.
#[component(css = SignInPage)]
pub fn InvitePage<'a>(t: SignInMsg, screen: &'a InviteScreen) -> impl Render {
    let f = AcceptForm::FIELDS;
    let action = url::Invite { id: &screen.id, invited: invite::Invited { credential_method: None, ..screen.invited.clone() } };
    html! {
        <div class={Page}>
            if let Some((phase, attempt)) = &screen.phase {
                <div class={Banner} data-tone={if phase.accepted() { "success" } else { "danger" }} role="status">
                    <p class={Strong}>{phase.title(t)}</p>
                    <p>{t.invite_attempt_safe_recovery()}</p>
                </div>
                <a class={Button} href={url::SignIn::default()}>{t.invite_attempt_sign_in()}</a>
                <form class={Form} method="post" action={&action}>
                    <input type="hidden" name={f.intent} value="status">
                    <input type="hidden" name={f.attempt} value={attempt}>
                    <button class={Secondary} type="submit">{t.invite_attempt_check_status()}</button>
                </form>
            } else {
                match &screen.invitation {
                    Invitation::Pending { invited_by_name, account_name, role_label, .. } => {
                        <header class={Header}>
                            <h1 class={Title}>{t.invite_accept_invitation()}</h1>
                            <p>{t.invite_invited_by(invited_by_name, account_name, role_label)}</p>
                        </header>
                        if screen.failed_safe {
                            <div class={Banner} data-tone="danger" role="alert">
                                <p class={Strong}>{t.invite_acceptance_failed()}</p>
                                <p>{t.invite_attempt_failed_safe()}</p>
                            </div>
                        }
                        <nav class={Methods} aria-label={t.invite_method()}>
                            for choice in invite::Method::ALL {
                                <a
                                    class={Choice}
                                    href={url::Invite { id: &screen.id, invited: screen.invited.with_method(choice) }}
                                    aria-current={(choice == screen.method).then_some("true")}
                                >
                                    {choice.label(t)}
                                </a>
                            }
                        </nav>
                        if screen.method == invite::Method::Passkey {
                            <section class={Card}>
                                <p class={Muted}>{t.invite_passkey_copy()}</p>
                                // WebAuthn is marketplace's page's script.
                                <a class={Button} href={&invite::on_marketplace(&screen.id, &screen.invited)}>
                                    {t.invite_accept_passkey()}
                                </a>
                            </section>
                        } else {
                            <form class={(Card, Form)} method="post" action={&action}>
                                {SubmitKey::field(f.attempt)}
                                <label class={Field}>
                                    <span class={Label}>{t.invite_create_password()}</span>
                                    <input class={Input} type="password" name={f.password} autocomplete="new-password" required>
                                </label>
                                <button class={Secondary} type="submit">{t.invite_accept_password()}</button>
                            </form>
                        }
                    }
                    ended => {
                        <section class={(Card, Flush)}>
                            <h1 class={Name}>
                                {match ended {
                                    Invitation::Expired => t.invite_invitation_expired(),
                                    Invitation::Revoked => t.invite_invitation_revoked(),
                                    Invitation::Accepted => t.invite_invitation_accepted(),
                                    _ => t.invite_invitation_unavailable(),
                                }}
                            </h1>
                            <p class={Muted}>{t.invite_new_invitation()}</p>
                        </section>
                    }
                }
            }
        </div>
    }
}
