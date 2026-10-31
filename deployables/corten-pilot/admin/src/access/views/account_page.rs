//! An account's workspace (`AccountAccessHubPage`): breadcrumbs, the account's name, badges and
//! status, then corten-ui's tabs: Overview (profile, lifecycle, badges), Team (memberships,
//! invitations, and a card for each user the viewer may manage), API Access (the keys, a new key's
//! form, and a key's one-time secret just made) and Audit (the account's Identity events).
//!
//! Each tab is a link to the workspace on it, so without JavaScript a tab loads its page. A
//! form that asks first (suspend, close, revoke, cancel) opens a `<dialog>` with
//! `command="show-modal"`, no script. Forms stack on a phone and sit in a row from 40rem; tables
//! scroll on their own.
use corten::prelude::*;
use corten_ui::{CopyButton, Tab as UiTab, TabGroup};

use super::access_page::when;
use crate::{
    access::{
        self,
        account::{self, AUTH_METHODS, CONTACT_METHOD_TYPES, GRANTABLE_ROLES, HubForm, HubScreen, Tab},
        api::{ApiKey, Hub, Invitation, Membership, User},
        people,
        sessions::{self, SessionForm, SessionScreen},
        url,
    },
    auth::Viewer,
    text::{Acc, Pilot},
};

/// The one-time secret, which its Copy button copies.
#[derive(Id)]
pub struct SecretId;

/// A form's confirm dialog's id, by its intent and what it acts on.
fn dialog_id(intent: &str, target: &str) -> String {
    let safe: String = target.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
    format!("account-hub-{intent}-{safe}")
}

fn tab_label(t: Acc, tab: Tab) -> &'static str {
    match tab {
        Tab::Overview => t.account_tab_overview(),
        Tab::Team => t.account_tab_team(),
        Tab::ApiAccess => t.account_tab_api_access(),
        Tab::Audit => t.account_tab_audit(),
    }
}

/// `formatAuditEvent`: the event's type without `identity.`, its parts as words.
fn audit_title(event_type: &str) -> String {
    event_type
        .strip_prefix("identity.")
        .unwrap_or(event_type)
        .split('.')
        .map(|p| p.replace('-', " "))
        .collect::<Vec<_>>()
        .join(" · ")
}

fn contact_type(t: Acc, value: &str) -> String {
    let known = match value {
        "email" => Some(t.user_detail_email()),
        "phone" => Some(t.user_detail_phone()),
        _ => None,
    };
    access::machine(t, known, t.family_contact_method_type(), value)
}

fn badge_label(t: Acc, key: &str) -> &'static str {
    match key {
        "manual-payout-review" => t.badges_manual_payout_review(),
        "trusted-seller" => t.badges_trusted_seller(),
        _ => t.badges_founding_account(),
    }
}

/// The workspace.
#[component(css)]
pub fn AccountPage<'a>(t: Acc, p: Pilot, viewer: &'a Viewer, screen: &'a HubScreen, tab: Tab) -> impl Render {
    let hub = &screen.hub;
    let account = &hub.account;
    let id = account.account_id.as_str();
    let name = if account.display_name.is_empty() { id } else { account.display_name.as_str() };
    let wallet = viewer.can(crate::commerce::wallet::VIEW).then(|| {
        let view = crate::commerce::wallet::url::View { account_name: Some(name.to_owned()), ..Default::default() };
        crate::commerce::wallet::url::Wallet { id, view }
    });
    let team = hub.memberships.len() + hub.invitations.iter().filter(|i| i.status == "pending").count();
    let keys = hub.api_keys.iter().filter(|k| k.status == "active").count();
    html! {
        let links = Tab::ALL.map(|tab| url::AccountHub { id, tab: Some(tab.key()), after_write: None });
        let labels = Tab::ALL.map(|tab| match tab {
            Tab::Team => format!("{} ({team})", tab_label(t, tab)),
            Tab::ApiAccess => format!("{} ({keys})", tab_label(t, tab)),
            _ => tab_label(t, tab).to_owned(),
        });
        let overview = html! { <Overview t={t} p={p} viewer={viewer} hub={hub} /> };
        let team_panel = html! { <Team t={t} p={p} viewer={viewer} hub={hub} /> };
        let api = html! { <ApiAccess t={t} p={p} viewer={viewer} hub={hub} secret={screen.secret.as_ref()} /> };
        let audit = html! { <Audit t={t} hub={hub} /> };
        let tabs = [
            UiTab { label: labels[0].as_str(), panel: &overview, link: Some(&links[0]) },
            UiTab { label: labels[1].as_str(), panel: &team_panel, link: Some(&links[1]) },
            UiTab { label: labels[2].as_str(), panel: &api, link: Some(&links[2]) },
            UiTab { label: labels[3].as_str(), panel: &audit, link: Some(&links[3]) },
        ];
        let selected = Tab::ALL.iter().position(|t| *t == tab).unwrap_or(0);
        <nav class={Crumbs} aria-label={p.access_breadcrumbs()}>
            <a href={url::Access::default()}>{t.home_title()}</a>
            <span aria-hidden="true">"/"</span>
            <span aria-current="page">{name}</span>
        </nav>
        <div class={Head}>
            <crate::views::PageHeader eyebrow={t.account_eyebrow()} title={name} description={t.account_description()} />
            if let Some(href) = &wallet {
                <a class={(Button, Secondary)} href={href}>{t.account_detail_view_wallet()}</a>
            }
        </div>
        <p class={Pills}>
            for badge in access::badges(t, account) {
                <span class={(Pill, Badge)}>{&badge}</span>
            }
            <span class={Pill}>{access::account_status(t, &account.status)}</span>
        </p>
        if let Some(refusal) = &screen.refusal {
            <p class={Alert} role="alert">{refusal}</p>
        }
        if screen.catching_up {
            <p class={Note} role="status">{p.error_pending()}</p>
        }
        <div class={Tabs}>
            <TabGroup id="account-hub" label={name} tabs={&tabs} selected={selected} />
        </div>
    }
}

/// A form: its intent and fields, posted to the workspace.
fn action(id: &str) -> url::AccountHub<'_> {
    url::AccountHub { id, tab: None, after_write: None }
}

/// A button that asks first: the dialog it opens says what will happen and sends the form.
#[component(css = AccountPage)]
fn Confirmed<'a>(
    p: Pilot,
    id: &'a str,
    intent: &'a str,
    hidden: &'a [(&'a str, &'a str)],
    target: &'a str,
    label: &'a str,
    title: &'a str,
    description: &'a str,
    confirm: &'a str,
    small: bool,
) -> impl Render {
    let f = HubForm::FIELDS;
    let dialog = dialog_id(intent, target);
    html! {
        if small {
            <button type="button" class={(Button, Danger, Small)} command="show-modal" commandfor={&dialog}>{label}</button>
        } else {
            <button type="button" class={(Button, Danger)} command="show-modal" commandfor={&dialog}>{label}</button>
        }
        <dialog class={Confirm} id={&dialog} aria-label={title}>
            <form method="post" action={action(id)}>
                <input type="hidden" name={f.intent} value={intent}>
                for (name, value) in hidden {
                    <input type="hidden" name={*name} value={*value}>
                }
                <h3>{title}</h3>
                <p>{description}</p>
                <div class={Buttons}>
                    <button type="button" class={(Button, Secondary)} command="close" commandfor={&dialog}>
                        {p.access_close()}
                    </button>
                    <button type="submit" class={(Button, Danger)}>{confirm}</button>
                </div>
            </form>
        </dialog>
    }
}

/// A form of one button.
#[component(css = AccountPage)]
fn Act<'a>(
    id: &'a str,
    intent: &'a str,
    hidden: &'a [(&'a str, &'a str)],
    label: &'a str,
    primary: bool,
    small: bool,
) -> impl Render {
    let f = HubForm::FIELDS;
    html! {
        <form class={Inline} method="post" action={action(id)}>
            <input type="hidden" name={f.intent} value={intent}>
            for (name, value) in hidden {
                <input type="hidden" name={*name} value={*value}>
            }
            match (primary, small) {
                (true, true) => <button type="submit" class={(Button, Small)}>{label}</button>,
                (true, false) => <button type="submit" class={Button}>{label}</button>,
                (false, true) => <button type="submit" class={(Button, Secondary, Small)}>{label}</button>,
                (false, false) => <button type="submit" class={(Button, Secondary)}>{label}</button>,
            }
        </form>
    }
}

#[component(css = AccountPage)]
fn Overview<'a>(t: Acc, p: Pilot, viewer: &'a Viewer, hub: &'a Hub) -> impl Render {
    let account = &hub.account;
    let id = account.account_id.as_str();
    let manage = viewer.can("accounts.manage");
    let admin = viewer.role_key == "platform-admin";
    let f = HubForm::FIELDS;
    let name = account.display_name.as_str();
    let badges = access::badges(t, account);
    html! {
        <section class={Card}>
            <h2 class={CardTitle}>{t.account_overview_profile()}</h2>
            <p class={Muted}>{t.account_overview_profile_description()}</p>
            <dl class={Facts}>
                <div>
                    <dt>{t.account_detail_account_id()}</dt>
                    <dd><code>{id}</code></dd>
                </div>
                <div>
                    <dt>{t.account_detail_account_type()}</dt>
                    <dd>{access::account_type(t, &account.account_type)}</dd>
                </div>
                <div>
                    <dt>{t.account_detail_updated_at()}</dt>
                    <dd>{when(t, Some(&account.updated_at))}</dd>
                </div>
            </dl>
            if manage {
                <form class={Row} method="post" action={action(id)}>
                    <input type="hidden" name={f.intent} value="update-profile">
                    <label class={Field}>
                        <span>{t.account_detail_legal_name()}</span>
                        <input name={f.name} value={&account.name} required>
                    </label>
                    <label class={Field}>
                        <span>{t.account_detail_display_name()}</span>
                        <input name={f.display_name} value={name} required>
                    </label>
                    <button type="submit" class={(Button, Secondary)}>{t.account_detail_update_profile()}</button>
                </form>
            }
        </section>
        <section class={Card}>
            <h2 class={CardTitle}>{t.account_overview_lifecycle()}</h2>
            <p class={Muted}>{t.account_overview_lifecycle_description()}</p>
            <div class={Actions}>
                <span class={Pill}>{access::account_status(t, &account.status)}</span>
                if manage && account.status == "active" {
                    <Confirmed
                        p={p}
                        id={id}
                        intent="suspend"
                        hidden={&[]}
                        target={id}
                        label={t.account_detail_suspend()}
                        title={&t.account_detail_suspend_confirm_title(name).to_string()}
                        description={&t.account_detail_suspend_confirm_description(name).to_string()}
                        confirm={t.account_detail_suspend_confirm_action()}
                        small={false}
                    />
                }
                if manage && account.status == "suspended" {
                    <Act
                        id={id}
                        intent="reactivate"
                        hidden={&[]}
                        label={t.account_detail_reactivate()}
                        primary={true}
                        small={false}
                    />
                }
                if manage && account.status != "closed" {
                    <Confirmed
                        p={p}
                        id={id}
                        intent="close"
                        hidden={&[]}
                        target={id}
                        label={t.account_detail_close()}
                        title={&t.account_close_confirm_title(name).to_string()}
                        description={&t.account_close_confirm_description(name).to_string()}
                        confirm={t.account_close_confirm_action()}
                        small={false}
                    />
                }
            </div>
        </section>
        <section class={Card}>
            <h2 class={CardTitle}>{t.account_detail_account_badges()}</h2>
            if badges.is_empty() {
                <p class={Muted}>{t.account_detail_no_account_badges()}</p>
            } else {
                <p class={Pills}>
                    for badge in &badges {
                        <span class={(Pill, Badge)}>{badge}</span>
                    }
                </p>
            }
            if admin {
                <div class={Actions} role="group" aria-label={p.access_assignable_badges()}>
                    for key in account::ASSIGNABLE_BADGES {
                        let assigned = account.badges.iter().any(|b| b == key);
                        let label = if assigned {
                            t.account_detail_remove_account_badge(badge_label(t, key)).to_string()
                        } else {
                            t.account_detail_assign_account_badge(badge_label(t, key)).to_string()
                        };
                        <Act
                            id={id}
                            intent={if assigned { "remove-account-badge" } else { "assign-account-badge" }}
                            hidden={&[(f.badge_key.as_str(), key)]}
                            label={&label}
                            primary={!assigned}
                            small={false}
                        />
                    }
                </div>
            }
        </section>
    }
}

fn user_of(m: &Membership) -> &str {
    m.user_label()
}

#[component(css = AccountPage)]
fn Team<'a>(t: Acc, p: Pilot, viewer: &'a Viewer, hub: &'a Hub) -> impl Render {
    let id = hub.account.account_id.as_str();
    let name = hub.account.display_name.as_str();
    let manage = viewer.can("memberships.manage");
    let f = HubForm::FIELDS;
    let invite = dialog_id("create-invitation", id);
    html! {
        <section class={Card}>
            <h2 class={CardTitle}>{t.account_team()}</h2>
            <p class={Muted}>{t.team_manage_the_people_who_can_act()}</p>
            if manage {
                <div>
                    <button type="button" class={Button} command="show-modal" commandfor={&invite}>
                        {t.account_detail_invite_member()}
                    </button>
                </div>
                <dialog class={Confirm} id={&invite} aria-label={t.account_invite_title()}>
                    <form class={Stack} method="post" action={action(id)}>
                        <input type="hidden" name={f.intent} value="create-invitation">
                        <h3>{t.account_invite_title()}</h3>
                        <p>{t.account_invite_description(name)}</p>
                        <label class={Field}>
                            <span>{t.account_detail_invite_email()}</span>
                            <input type="email" name={f.email} required>
                        </label>
                        <label class={Field}>
                            <span>{t.account_detail_invite_role()}</span>
                            <select name={f.role_key}>
                                for role in GRANTABLE_ROLES {
                                    <option value={role} selected={role == "viewer"}>{access::role(t, role)}</option>
                                }
                            </select>
                        </label>
                        <div class={Buttons}>
                            <button type="button" class={(Button, Secondary)} command="close" commandfor={&invite}>
                                {p.access_close()}
                            </button>
                            <button type="submit" class={Button}>{t.team_invite()}</button>
                        </div>
                    </form>
                </dialog>
            }
            if hub.memberships.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.account_team_empty()}</p>
                    <p class={Muted}>{t.account_team_empty_description()}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <table class={Table} aria-label={t.account_team()}>
                        <thead>
                            <tr>
                                <th scope="col">{t.memberships_user()}</th>
                                <th scope="col">{t.memberships_role()}</th>
                                <th scope="col">{t.memberships_status()}</th>
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            for m in &hub.memberships {
                                <MembershipRow t={t} p={p} id={id} account={name} m={m} manage={manage} />
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
        <section class={Card}>
            <h2 class={CardTitle}>{t.invitations_invitations()}</h2>
            if hub.invitations.is_empty() {
                <p class={Muted}>{t.invitations_no_invitations_yet()}</p>
            } else {
                <div class={Scroll}>
                    <table class={Table} aria-label={t.invitations_invitations()}>
                        <thead>
                            <tr>
                                <th scope="col">{t.invitations_email()}</th>
                                <th scope="col">{t.invitations_role()}</th>
                                <th scope="col">{t.invitations_status()}</th>
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            for i in &hub.invitations {
                                <InvitationRow t={t} p={p} id={id} account={name} i={i} manage={manage} />
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
        for user in hub.users.iter().filter(|u| account::manages_user(viewer, &u.user_id)) {
            <UserCard t={t} id={id} p={p} user={user} />
        }
    }
}

#[component(css = AccountPage)]
fn MembershipRow<'a>(t: Acc, p: Pilot, id: &'a str, account: &'a str, m: &'a Membership, manage: bool) -> impl Render {
    let f = HubForm::FIELDS;
    let who = user_of(m);
    let hidden = [(f.membership_id.as_str(), m.membership_id.as_str())];
    html! {
        <tr>
            <td>{who}</td>
            <td>{access::role(t, &m.role_key)}</td>
            <td><span class={Pill}>{access::membership_status(t, &m.status)}</span></td>
            <td>
                if manage && m.status == "active" {
                    <div class={Actions}>
                        <form class={Inline} method="post" action={action(id)}>
                            <input type="hidden" name={f.intent} value="change-membership-role">
                            <input type="hidden" name={f.membership_id} value={&m.membership_id}>
                            <select name={f.role_key} aria-label={t.membership_detail_role()}>
                                for role in GRANTABLE_ROLES {
                                    <option value={role} selected={role == m.role_key}>{access::role(t, role)}</option>
                                }
                            </select>
                            <button type="submit" class={(Button, Secondary, Small)}>{t.membership_detail_change_role()}</button>
                        </form>
                        <Confirmed
                            p={p}
                            id={id}
                            intent="revoke-membership"
                            hidden={&hidden}
                            target={&m.membership_id}
                            label={t.membership_detail_revoke()}
                            title={&t.membership_detail_revoke_confirm_title(who).to_string()}
                            description={&t.membership_detail_revoke_confirm_description(who, account).to_string()}
                            confirm={t.membership_detail_revoke_confirm_action()}
                            small={true}
                        />
                    </div>
                } else if manage {
                    <Act
                        id={id}
                        intent="reinstate-membership"
                        hidden={&hidden}
                        label={t.membership_detail_reinstate()}
                        primary={true}
                        small={true}
                    />
                }
            </td>
        </tr>
    }
}

#[component(css = AccountPage)]
fn InvitationRow<'a>(t: Acc, p: Pilot, id: &'a str, account: &'a str, i: &'a Invitation, manage: bool) -> impl Render {
    let f = HubForm::FIELDS;
    let target = [(f.invitation_id.as_str(), i.invitation_id.as_str())];
    let resend = [(f.invitation_id.as_str(), i.invitation_id.as_str()), (f.expires_at.as_str(), i.expires_at.as_str())];
    html! {
        <tr>
            <td>{&i.email}</td>
            <td>{access::role(t, &i.role_key)}</td>
            <td><span class={Pill}>{access::invitation_status(t, &i.status)}</span></td>
            <td>
                if manage && i.status == "pending" {
                    <div class={Actions}>
                        <Act
                            id={id}
                            intent="resend-invitation"
                            hidden={&resend}
                            label={t.invitation_detail_resend()}
                            primary={false}
                            small={true}
                        />
                        <Confirmed
                            p={p}
                            id={id}
                            intent="cancel-invitation"
                            hidden={&target}
                            target={&i.invitation_id}
                            label={t.invitation_detail_cancel()}
                            title={&t.invitation_detail_cancel_confirm_title(&i.email).to_string()}
                            description={&t.invitation_detail_cancel_confirm_description(&i.email, account).to_string()}
                            confirm={t.invitation_detail_cancel_confirm_action()}
                            small={true}
                        />
                        <Act
                            id={id}
                            intent="decline-invitation"
                            hidden={&target}
                            label={t.invitation_detail_decline()}
                            primary={false}
                            small={true}
                        />
                    </div>
                }
            </td>
        </tr>
    }
}

/// A user the viewer may manage: their profile, status, contact methods and sign-in methods.
#[component(css = AccountPage)]
fn UserCard<'a>(t: Acc, p: Pilot, id: &'a str, user: &'a User) -> impl Render {
    let f = HubForm::FIELDS;
    let who = user.label();
    let hidden = [(f.user_id.as_str(), user.user_id.as_str())];
    html! {
        <section class={Card}>
            <h2 class={CardTitle}>{who}</h2>
            <p class={Muted}><code>{&user.user_id}</code></p>
            <form class={Row} method="post" action={action(id)}>
                <input type="hidden" name={f.intent} value="update-user-profile">
                <input type="hidden" name={f.user_id} value={&user.user_id}>
                <label class={Field}>
                    <span>{t.user_detail_display_name()}</span>
                    <input name={f.display_name} value={&user.display_name} required>
                </label>
                <label class={Field}>
                    <span>{t.user_detail_given_name()}</span>
                    <input name={f.given_name} value={user.given_name.as_deref().unwrap_or("")}>
                </label>
                <label class={Field}>
                    <span>{t.user_detail_family_name()}</span>
                    <input name={f.family_name} value={user.family_name.as_deref().unwrap_or("")}>
                </label>
                <button type="submit" class={(Button, Secondary)}>{t.user_detail_update_profile()}</button>
            </form>
            <div class={Actions}>
                if user.status == "active" {
                    <Confirmed
                        p={p}
                        id={id}
                        intent="suspend-user"
                        hidden={&hidden}
                        target={&user.user_id}
                        label={t.user_detail_suspend()}
                        title={&t.user_detail_suspend_confirm_title(who).to_string()}
                        description={&t.user_detail_suspend_confirm_description(who).to_string()}
                        confirm={t.user_detail_suspend_confirm_action()}
                        small={false}
                    />
                } else {
                    <Act
                        id={id}
                        intent="reactivate-user"
                        hidden={&hidden}
                        label={t.user_detail_reactivate()}
                        primary={true}
                        small={false}
                    />
                }
            </div>
            <form class={Row} method="post" action={action(id)}>
                <input type="hidden" name={f.intent} value="add-user-contact-method">
                <input type="hidden" name={f.user_id} value={&user.user_id}>
                <label class={Field}>
                    <span>{t.user_detail_contact_method_type()}</span>
                    <select name={f.contact_method_type} required>
                        for kind in CONTACT_METHOD_TYPES {
                            <option value={kind}>{contact_type(t, kind)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.user_detail_contact_method_value()}</span>
                    <input name={f.contact_method_value} required>
                </label>
                <button type="submit" class={(Button, Secondary)}>{t.user_detail_add_contact_method()}</button>
            </form>
            if !user.contact_methods.is_empty() {
                <ul class={Methods}>
                    for method in &user.contact_methods {
                        <li>
                            <span>{contact_type(t, &method.kind)}": "{&method.value}</span>
                            if method.verified_at.is_some() {
                                <span class={(Pill, Good)}>{t.user_detail_verified()}</span>
                            } else {
                                <span class={(Pill, Warn)}>{t.user_detail_unverified()}</span>
                                <Act
                                    id={id}
                                    intent="verify-user-contact-method"
                                    hidden={&[(f.user_id.as_str(), user.user_id.as_str()), (f.contact_method_id.as_str(), method.contact_method_id.as_str())]}
                                    label={t.user_detail_verify()}
                                    primary={false}
                                    small={true}
                                />
                            }
                        </li>
                    }
                </ul>
            }
            <form class={Row} method="post" action={action(id)}>
                <input type="hidden" name={f.intent} value="enable-user-auth-method">
                <input type="hidden" name={f.user_id} value={&user.user_id}>
                <label class={Field}>
                    <span>{t.user_detail_auth_method()}</span>
                    <select name={f.auth_method} required>
                        for method in AUTH_METHODS {
                            <option value={method}>{access::method(t, method)}</option>
                        }
                    </select>
                </label>
                <button type="submit" class={(Button, Secondary)}>{t.user_detail_enable_auth_method()}</button>
            </form>
            if !user.auth_methods.is_empty() {
                <div class={Actions}>
                    for method in &user.auth_methods {
                        let label = t.account_disable_auth_method(&access::method(t, method)).to_string();
                        <form class={Inline} method="post" action={action(id)}>
                            <input type="hidden" name={f.intent} value="disable-user-auth-method">
                            <input type="hidden" name={f.user_id} value={&user.user_id}>
                            <input type="hidden" name={f.auth_method} value={method}>
                            <button type="submit" class={(Button, Danger, Small)}>{&label}</button>
                        </form>
                    }
                </div>
            }
        </section>
    }
}

#[component(css = AccountPage)]
fn ApiAccess<'a>(t: Acc, p: Pilot, viewer: &'a Viewer, hub: &'a Hub, secret: Option<&'a access::api::Secret>) -> impl Render {
    let id = hub.account.account_id.as_str();
    let f = HubForm::FIELDS;
    let users: Vec<&User> = hub.users.iter().filter(|u| account::manages_user(viewer, &u.user_id)).collect();
    html! {
        if let Some(secret) = secret {
            <section class={Secret} aria-labelledby="account-hub-secret">
                <h2 class={CardTitle} id="account-hub-secret">
                    {if secret.created { t.secret_created_title() } else { t.secret_rotated_title() }}
                </h2>
                <p>{t.secret_warning()}</p>
                <p class={Muted}>{t.secret_full_secret()}</p>
                <pre class={Code}><code id={SecretId}>{&secret.secret}</code></pre>
                <div class={Actions}>
                    <CopyButton text={SecretId} label={t.secret_copy()} copied={t.secret_copied()} />
                </div>
            </section>
        }
        <section class={Card}>
            <h2 class={CardTitle}>{t.account_api_access()}</h2>
            <p class={Muted}>{t.account_api_access_description()}</p>
            if !users.is_empty() {
                <form class={Row} method="post" action={action(id)}>
                    <input type="hidden" name={f.intent} value="create-api-key">
                    <label class={Field}>
                        <span>{t.api_keys_user()}</span>
                        <select name={f.user_id} required>
                            for user in &users {
                                <option value={&user.user_id}>
                                    {match user.primary_email.as_deref().filter(|e| !e.is_empty() && *e != user.label()) {
                                        Some(email) => format!("{} ({email})", user.label()),
                                        None => user.label().to_owned(),
                                    }}
                                </option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.user_detail_api_key_name()}</span>
                        <input name={f.api_key_name} required>
                    </label>
                    <button type="submit" class={Button}>{t.user_detail_create_api_key()}</button>
                </form>
            }
            if hub.api_keys.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.api_keys_no_api_keys_yet()}</p>
                    <p class={Muted}>{t.account_api_access_empty_description()}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <table class={Table} aria-label={t.account_api_access()}>
                        <thead>
                            <tr>
                                <th scope="col">{t.api_keys_name()}</th>
                                <th scope="col">{t.api_keys_user()}</th>
                                <th scope="col">{t.api_keys_prefix()}</th>
                                <th scope="col">{t.api_keys_status()}</th>
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            for key in &hub.api_keys {
                                <KeyRow
                                    t={t}
                                    p={p}
                                    id={id}
                                    key_={key}
                                    manage={key.status == "active" && account::manages_user(viewer, &key.user_id)}
                                />
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
    }
}

#[component(css = AccountPage)]
fn KeyRow<'a>(t: Acc, p: Pilot, id: &'a str, key_: &'a ApiKey, manage: bool) -> impl Render {
    let f = HubForm::FIELDS;
    let hidden = [(f.api_key_id.as_str(), key_.api_key_id.as_str())];
    html! {
        <tr>
            <td>{&key_.name}</td>
            <td>{key_.user_label()}</td>
            <td><code>{&key_.key_prefix}</code></td>
            <td><span class={Pill}>{access::api_key_status(t, &key_.status)}</span></td>
            <td>
                if manage {
                    <div class={Actions}>
                        <Act
                            id={id}
                            intent="rotate-api-key"
                            hidden={&hidden}
                            label={t.api_key_detail_rotate()}
                            primary={false}
                            small={true}
                        />
                        <Confirmed
                            p={p}
                            id={id}
                            intent="revoke-api-key"
                            hidden={&hidden}
                            target={&key_.api_key_id}
                            label={t.api_key_detail_revoke()}
                            title={&t.api_key_detail_revoke_confirm_title(&key_.name).to_string()}
                            description={&t.api_key_detail_revoke_confirm_description(&key_.name).to_string()}
                            confirm={t.api_key_detail_revoke_confirm_action()}
                            small={true}
                        />
                    </div>
                }
            </td>
        </tr>
    }
}

#[component(css = AccountPage)]
fn Audit<'a>(t: Acc, hub: &'a Hub) -> impl Render {
    html! {
        if hub.audit_events.is_empty() {
            <div class={Empty}>
                <p class={Strong}>{t.account_audit_empty()}</p>
                <p class={Muted}>{t.account_audit_empty_description()}</p>
            </div>
        } else {
            <ol class={Timeline}>
                for event in &hub.audit_events {
                    <li>
                        <p class={Strong}>{audit_title(&event.event_type)}</p>
                        <p class={Muted}>{t.account_audit_event_description(&event.stream_id, &event.performed_by_user_id)}</p>
                        <p class={Muted}>{when(t, Some(&event.recorded_at))}</p>
                    </li>
                }
            </ol>
        }
    }
}

/// A session's page (`SessionDetailPage`): its user, its account and how it was signed in to, and
/// for an active one, the account switch and the revoke (which asks first, in a `<dialog>`).
/// Drawn with the workspace's styles.
#[component(css = AccountPage)]
pub fn SessionPage<'a>(t: Acc, p: Pilot, screen: &'a SessionScreen) -> impl Render {
    let session = &screen.session;
    let (user, account) = (session.user_label(), session.account_label());
    let id = session.session_id.as_str();
    let action = people::SessionPage { id, after_write: None };
    let f = SessionForm::FIELDS;
    let revoke = dialog_id("revoke-session", id);
    let active = session.status == "active";
    html! {
        let title = t.session_detail_title(user).to_string();
        let confirm_title = t.session_detail_revoke_confirm_title(user).to_string();
        <nav class={Crumbs} aria-label={p.access_breadcrumbs()}>
            <a href={people::Sessions::default()}>{t.sessions_sessions()}</a>
            <span aria-hidden="true">"/"</span>
            <span aria-current="page">{user}</span>
        </nav>
        <div class={Head}>
            <h1>{&title}</h1>
        </div>
        <p class={Pills}>
            if active {
                <span class={(Pill, Good)}>{sessions::status(t, &session.status)}</span>
            } else {
                <span class={(Pill, Warn)}>{sessions::status(t, &session.status)}</span>
            }
        </p>
        if let Some(refusal) = &screen.refusal {
            <p class={Alert} role="alert">{refusal}</p>
        }
        if screen.catching_up {
            <p class={Note} role="status">{p.error_pending()}</p>
        }
        if active {
            <section class={Card}>
                <form class={Row} method="post" action={&action}>
                    <input type="hidden" name={f.intent} value="switch-account">
                    <label class={Field}>
                        <span>{t.session_detail_active_account()}</span>
                        <select name={f.account_id}>
                            for option in &session.available_account_ids {
                                <option value={option} selected={*option == session.account_id}>
                                    {if *option == session.account_id { account } else { option.as_str() }}
                                </option>
                            }
                        </select>
                    </label>
                    <button type="submit" class={(Button, Secondary)}>{t.session_detail_switch_account()}</button>
                </form>
                <div class={Actions}>
                    <button type="button" class={(Button, Danger)} command="show-modal" commandfor={&revoke}>
                        {t.session_detail_revoke()}
                    </button>
                </div>
                <dialog class={Confirm} id={&revoke} aria-label={&confirm_title}>
                    <form method="post" action={&action}>
                        <input type="hidden" name={f.intent} value="revoke">
                        <h3>{&confirm_title}</h3>
                        <p>{t.session_detail_revoke_confirm_description(user, account)}</p>
                        <div class={Buttons}>
                            <button type="button" class={(Button, Secondary)} command="close" commandfor={&revoke}>
                                {p.access_close()}
                            </button>
                            <button type="submit" class={(Button, Danger)}>{t.session_detail_revoke_confirm_action()}</button>
                        </div>
                    </form>
                </dialog>
            </section>
        }
        <section class={Card}>
            <dl class={Facts}>
                <div>
                    <dt>{t.session_detail_session_id()}</dt>
                    <dd><code>{id}</code></dd>
                </div>
                <div>
                    <dt>{t.session_detail_user()}</dt>
                    <dd>{user}</dd>
                </div>
                <div>
                    <dt>{t.session_detail_active_account()}</dt>
                    <dd>{account}</dd>
                </div>
                <div>
                    <dt>{t.session_detail_available_accounts()}</dt>
                    <dd>{session.available_account_ids.join(", ")}</dd>
                </div>
                <div>
                    <dt>{t.session_detail_authentication_method()}</dt>
                    <dd>{access::method(t, &session.authentication_method)}</dd>
                </div>
                <div>
                    <dt>{t.session_detail_expires_at()}</dt>
                    <dd>{sessions::when(t, session.expires_at.as_deref())}</dd>
                </div>
            </dl>
        </section>
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_audit_event_reads_as_words() {
        assert_eq!(super::audit_title("identity.membership.role-changed"), "membership · role changed");
        assert_eq!(super::audit_title("other.thing"), "other · thing");
    }
}
