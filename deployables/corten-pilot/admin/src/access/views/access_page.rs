//! Access's pages: the home (`AccessPage`, admin-web's `AccessHomePage`: the attention queue, then the account search) and
//! each list (`AdminResourceListPage`: its title, its search and status filters with the chips of
//! those applied, how many it found, its table with a View on each row, and its pager). A table
//! scrolls on its own on a phone; the filters stack there and sit side by side from 40rem.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    access::{
        self, Read,
        account::{Tab, hub},
        api::{Account, ApiKey, Invitation, List, Membership, User},
        people,
        sessions::{self, SESSION_STATUSES, Session},
        url::{self, ListQuery},
    },
    text::{Acc, Pilot},
};

/// A moment as admin-web's `formatDateTime` writes it, else the date's unavailable words.
pub(super) fn when(t: Acc, at: Option<&str>) -> String {
    at.and_then(parse_timestamp).map_or_else(
        || t.value_date_unavailable().to_owned(),
        |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
    )
}

/// One attention row (`buildAttentionRows`): what it is, its account, its details and where it is
/// reviewed.
struct Attention {
    kind: &'static str,
    account: String,
    detail: String,
    href: String,
}

fn attention(t: Acc, home: &access::api::Home) -> Vec<Attention> {
    let a = &home.attention;
    let invitations = a.pending_invitations.iter().map(|i| Attention {
        kind: t.home_pending_invitation(),
        account: i.account_label().to_owned(),
        detail: t
            .home_pending_invitation_detail(&i.email, &access::role(t, &i.role_key), &when(t, Some(&i.expires_at)))
            .to_string(),
        href: hub(&i.account_id, Tab::Team),
    });
    let keys = a.api_keys_needing_rotation.iter().map(|k| Attention {
        kind: t.home_api_key_rotation(),
        account: if k.account_display_name.is_empty() { k.account_id.clone() } else { k.account_display_name.clone() },
        detail: t
            .home_api_key_rotation_detail(&k.key.name, k.key.user_label(), &when(t, k.rotation_due_at.as_deref()))
            .to_string(),
        href: hub(&k.account_id, Tab::ApiAccess),
    });
    let suspended = a.suspended_accounts.iter().map(|acc| Attention {
        kind: t.home_suspended_account(),
        account: account_label(acc).to_owned(),
        detail: when(t, Some(&acc.updated_at)),
        href: hub(&acc.account_id, Tab::Overview),
    });
    let review = a.memberships_awaiting_review.iter().map(|m| Attention {
        kind: t.home_membership_review(),
        account: m.account_label().to_owned(),
        detail: t.home_membership_review_detail(m.user_label(), &access::role(t, &m.role_key)).to_string(),
        href: hub(&m.account_id, Tab::Team),
    });
    invitations.chain(keys).chain(suspended).chain(review).collect()
}

fn account_label(account: &Account) -> &str {
    if account.display_name.is_empty() { &account.account_id } else { &account.display_name }
}

/// The area's stylesheet, and Access's home.
#[component(css)]
pub fn AccessPage<'a>(t: Acc, screen: &'a access::HomeScreen) -> impl Render {
    let rows = attention(t, &screen.home);
    let home = url::Access::default().href();
    let f = url::HomeQuery::FIELDS;
    html! {
        <crate::views::PageHeader eyebrow={t.home_eyebrow()} title={t.home_title()} description={t.home_description()} />
        <section class={Part}>
            <h2 class={Title}>{t.home_attention()}</h2>
            <p class={Muted}>{t.home_attention_description()}</p>
            if rows.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.home_attention_empty()}</p>
                    <p class={Muted}>{t.home_attention_empty_description()}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <table class={Table} aria-label={t.home_attention()}>
                        <thead>
                            <tr>
                                <th scope="col">{t.home_attention_type()}</th>
                                <th scope="col">{t.home_account()}</th>
                                <th scope="col">{t.home_details()}</th>
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &rows {
                                <tr>
                                    <td>{row.kind}</td>
                                    <td>{&row.account}</td>
                                    <td>{&row.detail}</td>
                                    <td><a class={Open} href={&row.href}>{t.home_review()}</a></td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
        <section class={Part}>
            <h2 class={Title}>{t.home_account_search()}</h2>
            <p class={Muted}>{t.home_account_search_description()}</p>
            <div class={Card}>
                <form class={Filters} role="search" method="get" action={&home}>
                    <label class={Filter}>
                        <span class={Label}>{t.home_search()}</span>
                        <input type="search" name={f.search} value={&screen.search} placeholder={t.home_search_placeholder()}>
                    </label>
                    <div class={Actions}>
                        <button type="submit">{t.home_search_action()}</button>
                        if !screen.search.is_empty() {
                            <a class={Open} href={&home}>{t.home_search_clear()}</a>
                        }
                    </div>
                </form>
                <p class={Muted}>{t.home_account_count(screen.home.account_total)}</p>
                if screen.home.accounts.is_empty() {
                    <div class={Empty}>
                        <p class={EmptyTitle}>{t.home_accounts_empty()}</p>
                        <p class={Muted}>{t.home_accounts_empty_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table} aria-label={t.home_account_search()}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.accounts_display_name()}</th>
                                    <th scope="col">{t.accounts_type()}</th>
                                    <th scope="col">{t.accounts_status()}</th>
                                    <th scope="col"></th>
                                </tr>
                            </thead>
                            <tbody>
                                for account in &screen.home.accounts {
                                    <tr>
                                        <td>{account_label(account)}</td>
                                        <td>{access::account_type(t, &account.account_type)}</td>
                                        <td>
                                            if account.status == "active" {
                                                <span class={(Pill, Success)}>{access::account_status(t, &account.status)}</span>
                                            } else {
                                                <span class={(Pill, Warning)}>{access::account_status(t, &account.status)}</span>
                                            }
                                        </td>
                                        <td>
                                            <a class={Open} href={hub(&account.account_id, Tab::Overview)}>
                                                {t.home_open_account()}
                                            </a>
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </div>
        </section>
    }
}

/// What a list page draws around its table: the words its filters use.
struct Words<'a> {
    title: &'a str,
    search: &'a str,
    placeholder: &'a str,
    status: &'a str,
    all: &'a str,
    apply: &'a str,
    clear: &'a str,
    filters: &'a str,
    empty: &'a str,
    search_chip: String,
    status_chip: Option<String>,
}

/// A list page (`AdminResourceListPage`): its title, filters and chips, count, table and pager.
#[component(css = AccessPage)]
fn ListFrame<'a, C: Render>(
    p: Pilot,
    words: &'a Words<'a>,
    read: &'a Read,
    at: &'a dyn Fn(&ListQuery) -> String,
    statuses: &'a [(&'a str, String)],
    head: &'a [&'a str],
    shown: usize,
    total: u64,
    children: C,
) -> impl Render {
    let f = ListQuery::FIELDS;
    let clear = at(&ListQuery::default());
    let status = read.status.as_deref().unwrap_or("");
    let page = read.offset / read.limit.max(1) + 1;
    let pages = (total.max(1) as u32).div_ceil(read.limit.max(1));
    let previous = (read.offset > 0).then(|| at(&read.at(read.offset.saturating_sub(read.limit))));
    let next = (u64::from(read.offset + read.limit) < total).then(|| at(&read.at(read.offset + read.limit)));
    let filtered = !read.search.is_empty() || read.status.is_some();
    html! {
        <h1 class={PageTitle}>{words.title}</h1>
        <form class={(Card, Filters)} method="get" action={&clear} aria-label={words.filters}>
            <label class={Filter}>
                <span class={Label}>{words.search}</span>
                <input type="search" name={f.search} value={&read.search} placeholder={words.placeholder}>
            </label>
            <label class={Filter}>
                <span class={Label}>{words.status}</span>
                <select name={f.status}>
                    <option value="all" selected={status.is_empty()}>{words.all}</option>
                    for (value, label) in statuses {
                        <option value={*value} selected={*value == status}>{label}</option>
                    }
                </select>
            </label>
            <div class={Actions}>
                <button type="submit">{words.apply}</button>
                <a class={Open} href={&clear}>{words.clear}</a>
            </div>
        </form>
        if filtered {
            <ul class={Chips} aria-label={words.filters}>
                if !read.search.is_empty() {
                    <li class={Chip}>{&words.search_chip}</li>
                }
                if let Some(chip) = &words.status_chip {
                    <li class={Chip}>{chip}</li>
                }
                <li><a class={Open} href={&clear}>{words.clear}</a></li>
            </ul>
        }
        <section class={Part}>
            // One form per count until the pin has Corten's plural messages (README, Open workarounds).
            if shown == 1 {
                <h2 class={Title}>{p.access_item(shown)}</h2>
            } else {
                <h2 class={Title}>{p.access_items(shown)}</h2>
            }
            if shown == 0 {
                <p class={Muted}>{words.empty}</p>
            } else {
                <div class={Scroll}>
                    <table class={Table} aria-label={words.title}>
                        <thead>
                            <tr>
                                for heading in head {
                                    <th scope="col">{*heading}</th>
                                }
                                <th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>{children}</tbody>
                    </table>
                </div>
            }
            if previous.is_some() || next.is_some() {
                <nav class={Pages} aria-label={p.pages_label()}>
                    if let Some(href) = &previous { <a class={Open} href={href} rel="prev">{p.pages_previous()}</a> }
                    <span>{p.pages_current(page, pages)}</span>
                    if let Some(href) = &next { <a class={Open} href={href} rel="next">{p.pages_next()}</a> }
                </nav>
            }
        </section>
    }
}

/// A row's View: the record's page (its account's workspace).
#[component(css = AccessPage)]
fn View<'a>(p: Pilot, href: &'a str) -> impl Render {
    html! { <td><a class={Open} href={href}>{p.access_view()}</a></td> }
}

/// An account's name with its badges.
#[component(css = AccessPage)]
fn AccountName<'a>(t: Acc, account: &'a Account) -> impl Render {
    html! {
        <td>
            <span class={Named}>
                <span>{&account.display_name}</span>
                for badge in access::badges(t, account) {
                    <span class={Badge} title={&badge}>{&badge}</span>
                }
            </span>
        </td>
    }
}

fn statuses(values: &[&'static str], label: impl Fn(&str) -> String) -> Vec<(&'static str, String)> {
    values.iter().map(|v| (*v, label(v))).collect()
}

pub fn accounts<'a>(t: Acc, p: Pilot, read: &'a Read, list: &'a List<Account>) -> impl Render + 'a {
    html! {
        let at = |q: &ListQuery| url::Accounts { query: q.clone() }.href();
        let states = statuses(access::ACCOUNT_STATUSES, |s| access::account_status(t, s));
        let words = Words {
            title: t.accounts_accounts(),
            search: t.accounts_search(),
            placeholder: t.accounts_search_placeholder(),
            status: t.accounts_status(),
            all: t.accounts_status_filter_all(),
            apply: t.accounts_apply_filters(),
            clear: t.accounts_clear_filters(),
            filters: t.accounts_filters(),
            empty: t.accounts_no_accounts_yet(),
            search_chip: t.accounts_search_filter_chip(&read.search).to_string(),
            status_chip: read.status.as_deref().map(|s| t.accounts_status_filter_chip(&access::account_status(t, s)).to_string()),
        };
        let head = [t.accounts_display_name(), t.accounts_legal_name(), t.accounts_type(), t.accounts_status()];
        <ListFrame
            p={p}
            words={&words}
            read={read}
            at={&at}
            statuses={&states}
            head={&head}
            shown={list.items.len()}
            total={list.total}
        >
            for account in &list.items {
                <tr>
                    <AccountName t={t} account={account} />
                    <td>{&account.name}</td>
                    <td>{access::account_type(t, &account.account_type)}</td>
                    <td>{access::account_status(t, &account.status)}</td>
                    <View p={p} href={&hub(&account.account_id, Tab::Overview)} />
                </tr>
            }
        </ListFrame>
    }
}

pub fn users<'a>(t: Acc, p: Pilot, read: &'a Read, list: &'a List<User>) -> impl Render + 'a {
    html! {
        let at = |q: &ListQuery| url::Users { query: q.clone() }.href();
        let states = statuses(access::USER_STATUSES, |s| access::user_status(t, s));
        let words = Words {
            title: t.users_users(),
            search: t.users_search(),
            placeholder: t.users_search_placeholder(),
            status: t.users_status(),
            all: t.users_status_filter_all(),
            apply: t.users_apply_filters(),
            clear: t.users_clear_filters(),
            filters: t.users_filters(),
            empty: t.users_no_users_yet(),
            search_chip: t.users_search_filter_chip(&read.search).to_string(),
            status_chip: read.status.as_deref().map(|s| t.users_status_filter_chip(&access::user_status(t, s)).to_string()),
        };
        let head = [t.users_display_name(), t.users_email(), t.users_auth_methods(), t.users_status()];
        <ListFrame
            p={p}
            words={&words}
            read={read}
            at={&at}
            statuses={&states}
            head={&head}
            shown={list.items.len()}
            total={list.total}
        >
            for user in &list.items {
                <tr>
                    <td>{&user.display_name}</td>
                    <td>{user.primary_email.as_deref().unwrap_or("")}</td>
                    <td>
                        {if user.auth_methods.is_empty() {
                            t.users_none().to_owned()
                        } else {
                            user.auth_methods.iter().map(|m| access::method(t, m)).collect::<Vec<_>>().join(", ")
                        }}
                    </td>
                    <td>{access::user_status(t, &user.status)}</td>
                    <View p={p} href={&people::UserPage { id: &user.user_id }.href()} />
                </tr>
            }
        </ListFrame>
    }
}

pub fn memberships<'a>(t: Acc, p: Pilot, read: &'a Read, list: &'a List<Membership>) -> impl Render + 'a {
    html! {
        let at = |q: &ListQuery| url::Memberships { query: q.clone() }.href();
        let states = statuses(access::MEMBERSHIP_STATUSES, |s| access::membership_status(t, s));
        let words = Words {
            title: t.memberships_memberships(),
            search: t.memberships_search(),
            placeholder: t.memberships_search_placeholder(),
            status: t.memberships_status(),
            all: t.memberships_status_filter_all(),
            apply: t.memberships_apply_filters(),
            clear: t.memberships_clear_filters(),
            filters: t.memberships_filters(),
            empty: t.memberships_no_memberships_yet(),
            search_chip: t.memberships_search_filter_chip(&read.search).to_string(),
            status_chip: read.status.as_deref().map(|s| t.memberships_status_filter_chip(&access::membership_status(t, s)).to_string()),
        };
        let head = [t.memberships_user(), t.memberships_account(), t.memberships_role(), t.memberships_status()];
        <ListFrame
            p={p}
            words={&words}
            read={read}
            at={&at}
            statuses={&states}
            head={&head}
            shown={list.items.len()}
            total={list.total}
        >
            for m in &list.items {
                <tr>
                    <td>{m.user_label()}</td>
                    <td>{m.account_label()}</td>
                    <td>{access::role(t, &m.role_key)}</td>
                    <td>{access::membership_status(t, &m.status)}</td>
                    <View p={p} href={&hub(&m.account_id, Tab::Team)} />
                </tr>
            }
        </ListFrame>
    }
}

pub fn invitations<'a>(t: Acc, p: Pilot, read: &'a Read, list: &'a List<Invitation>) -> impl Render + 'a {
    html! {
        let at = |q: &ListQuery| url::Invitations { query: q.clone() }.href();
        let states = statuses(access::INVITATION_STATUSES, |s| access::invitation_status(t, s));
        let words = Words {
            title: t.invitations_invitations(),
            search: t.invitations_search(),
            placeholder: t.invitations_search_placeholder(),
            status: t.invitations_status(),
            all: t.invitations_status_filter_all(),
            apply: t.invitations_apply_filters(),
            clear: t.invitations_clear_filters(),
            filters: t.invitations_filters(),
            empty: t.invitations_no_invitations_yet(),
            search_chip: t.invitations_search_filter_chip(&read.search).to_string(),
            status_chip: read.status.as_deref().map(|s| t.invitations_status_filter_chip(&access::invitation_status(t, s)).to_string()),
        };
        let head = [t.invitations_email(), t.invitations_account(), t.invitations_role(), t.invitations_status()];
        <ListFrame
            p={p}
            words={&words}
            read={read}
            at={&at}
            statuses={&states}
            head={&head}
            shown={list.items.len()}
            total={list.total}
        >
            for i in &list.items {
                <tr>
                    <td>{&i.email}</td>
                    <td>{i.account_label()}</td>
                    <td>{access::role(t, &i.role_key)}</td>
                    <td>{access::invitation_status(t, &i.status)}</td>
                    <View p={p} href={&hub(&i.account_id, Tab::Team)} />
                </tr>
            }
        </ListFrame>
    }
}

pub fn api_keys<'a>(t: Acc, p: Pilot, read: &'a Read, list: &'a List<ApiKey>) -> impl Render + 'a {
    html! {
        let at = |q: &ListQuery| url::ApiKeys { query: q.clone() }.href();
        let states = statuses(access::API_KEY_STATUSES, |s| access::api_key_status(t, s));
        let words = Words {
            title: t.api_keys_api_keys(),
            search: t.api_keys_search(),
            placeholder: t.api_keys_search_placeholder(),
            status: t.api_keys_status(),
            all: t.api_keys_status_filter_all(),
            apply: t.api_keys_apply_filters(),
            clear: t.api_keys_clear_filters(),
            filters: t.api_keys_filters(),
            empty: t.api_keys_no_api_keys_yet(),
            search_chip: t.api_keys_search_filter_chip(&read.search).to_string(),
            status_chip: read.status.as_deref().map(|s| t.api_keys_status_filter_chip(&access::api_key_status(t, s)).to_string()),
        };
        let head = [t.api_keys_name(), t.api_keys_user(), t.api_keys_prefix(), t.api_keys_status()];
        <ListFrame
            p={p}
            words={&words}
            read={read}
            at={&at}
            statuses={&states}
            head={&head}
            shown={list.items.len()}
            total={list.total}
        >
            for key in &list.items {
                <tr>
                    <td>{&key.name}</td>
                    <td>{key.user_label()}</td>
                    <td><code>{&key.key_prefix}</code></td>
                    <td>{access::api_key_status(t, &key.status)}</td>
                    <View p={p} href={&people::ApiKeyPage { id: &key.api_key_id }.href()} />
                </tr>
            }
        </ListFrame>
    }
}

pub fn sessions<'a>(t: Acc, p: Pilot, read: &'a Read, list: &'a List<Session>) -> impl Render + 'a {
    html! {
        let at = |q: &ListQuery| people::Sessions { query: q.clone() }.href();
        let states = statuses(SESSION_STATUSES, |s| sessions::status(t, s));
        let words = Words {
            title: t.sessions_sessions(),
            search: t.sessions_search(),
            placeholder: t.sessions_search_placeholder(),
            status: t.sessions_status(),
            all: t.sessions_status_filter_all(),
            apply: t.sessions_apply_filters(),
            clear: t.sessions_clear_filters(),
            filters: t.sessions_filters(),
            empty: t.sessions_no_sessions_yet(),
            search_chip: t.sessions_search_filter_chip(&read.search).to_string(),
            status_chip: read.status.as_deref().map(|s| t.sessions_status_filter_chip(&sessions::status(t, s)).to_string()),
        };
        let head = [t.sessions_user(), t.sessions_account(), t.sessions_method(), t.sessions_status()];
        <ListFrame
            p={p}
            words={&words}
            read={read}
            at={&at}
            statuses={&states}
            head={&head}
            shown={list.items.len()}
            total={list.total}
        >
            for session in &list.items {
                <tr>
                    <td>{session.user_label()}</td>
                    <td>{session.account_label()}</td>
                    <td>{access::method(t, &session.authentication_method)}</td>
                    <td>{sessions::status(t, &session.status)}</td>
                    <View p={p} href={&people::SessionPage { id: &session.session_id, after_write: None }.href()} />
                </tr>
            }
        </ListFrame>
    }
}
