//! The access section (admin-web's `/access`, Identity's admin routes): Access's home, with its
//! attention queue and account search, and the accounts, users, memberships, invitations and API
//! keys lists, each with its search and status filters and its pages, read from the Identity API
//! as the signed-in staff member.
//!
//! | Route | Answers | Needs |
//! |---|---|---|
//! | `GET /access?search` | the attention queue and the accounts found | `accounts.view` |
//! | `GET /access/accounts?search&status&limit&offset` | the accounts | `accounts.view` |
//! | `GET /access/users?...` | the users | `security.manage` |
//! | `GET /access/memberships?...` | the memberships | `memberships.view` |
//! | `GET /access/invitations?...` | the invitations | `memberships.view` |
//! | `GET /access/api-keys?...` | the API keys | `security.manage` |
//! | `GET /access/users/{id}`, `GET /access/api-keys/{id}` | its account's workspace (a redirect), else the list searched for it | `security.manage` |
//! | `GET /access/accounts/{id}?tab&after_write`, `POST` | an account's workspace; its forms | `accounts.view`, and each form what admin-web shows it for |
//! | `GET /access/sessions?...` | Auth's sessions | `security.manage` |
//! | `GET /access/sessions/{id}?after_write`, `POST` | a session's page; its switch and revoke (`sessions`) | `security.manage` |
//!
//! Each route needs what admin-web's access layout challenges its path for: the nav entry's
//! permission, else `accounts.view`. A user's, a membership's, an invitation's or an API key's
//! page is its account's workspace on a tab, as admin-web's are.
use corten::{axum::http::HeaderMap, prelude::*};
use serde::Serialize;

pub mod account;
pub mod api;
pub mod sessions;
pub mod views;

use crate::{
    api::ApiError,
    app::{Shared, read_failed},
    auth::{AccountsView, MembershipsView, SecurityManage, Staff, Viewer},
    text::Acc,
};
use api::{Account, ApiKey, Home, Invitation, Kind, List, Membership, User};

/// admin-web's page size (`readOffsetPageParams`), and the most a page may ask for.
pub const PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 500;

/// The statuses each list filters by (`IDENTITY_*_STATUSES`); any other is no filter.
pub const ACCOUNT_STATUSES: &[&str] = &["active", "suspended", "closed"];
pub const USER_STATUSES: &[&str] = &["active", "suspended"];
pub const MEMBERSHIP_STATUSES: &[&str] = &["active", "revoked"];
pub const INVITATION_STATUSES: &[&str] = &["pending", "accepted", "declined", "cancelled", "expired"];
pub const API_KEY_STATUSES: &[&str] = &["active", "revoked"];

/// The home and the accounts list: `accounts.view`.
#[corten::routes(state = crate::app::Shared, area = crate::access::url::Access, caller = crate::auth::Staff<crate::auth::AccountsView>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    pub use super::people::{ApiKeys, Users};
    pub use super::teams::{Invitations, Memberships};

    /// The area: Access's home, with the account search its form sends.
    #[derive(Clone, Debug, Default)]
    #[route("/access", get = home)]
    pub struct Access {
        #[route(query)]
        pub search: HomeQuery,
    }

    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct HomeQuery {
        pub search: Option<String>,
    }

    /// A list's filters (the filter form's fields) and page (`limit`, `offset`, as admin-web's).
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct ListQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub limit: Option<u32>,
        pub offset: Option<u32>,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/access/accounts", get = accounts)]
    pub struct Accounts {
        #[route(query)]
        pub query: ListQuery,
    }

    /// An account's workspace on a tab, after the write whose receipt the address carries; a
    /// `POST` is one of its forms (`intent`).
    #[route("/access/accounts/{id}", get = crate::access::account::page, post = crate::access::account::write)]
    pub struct AccountHub<'a> {
        pub id: &'a str,
        pub tab: Option<&'a str>,
        pub after_write: Option<String>,
    }
}

/// Users and API keys: `security.manage`.
#[corten::routes(state = crate::app::Shared, area = crate::access::url::Access, caller = crate::auth::Staff<crate::auth::SecurityManage>)]
pub mod people {
    pub use super::url::ListQuery;

    #[derive(Clone, Debug, Default)]
    #[route("/access/users", get = users)]
    pub struct Users {
        #[route(query)]
        pub query: ListQuery,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/access/api-keys", get = api_keys)]
    pub struct ApiKeys {
        #[route(query)]
        pub query: ListQuery,
    }

    /// A user's page: their account's workspace on its team tab (admin-web's redirect).
    #[route("/access/users/{id}", get = crate::access::account::user)]
    pub struct UserPage<'a> {
        pub id: &'a str,
    }

    /// An API key's page: its user's account's workspace on its API access tab.
    #[route("/access/api-keys/{id}", get = crate::access::account::api_key)]
    pub struct ApiKeyPage<'a> {
        pub id: &'a str,
    }

    /// Auth's sessions.
    #[derive(Clone, Debug, Default)]
    #[route("/access/sessions", get = crate::access::sessions::list)]
    pub struct Sessions {
        #[route(query)]
        pub query: ListQuery,
    }

    /// A session's page, after the write whose receipt the address carries; a `POST` is one of
    /// its forms (`intent`).
    #[route("/access/sessions/{id}", get = crate::access::sessions::page, post = crate::access::sessions::write)]
    pub struct SessionPage<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
    }
}

/// Memberships and invitations: `memberships.view`.
#[corten::routes(state = crate::app::Shared, area = crate::access::url::Access, caller = crate::auth::Staff<crate::auth::MembershipsView>)]
pub mod teams {
    pub use super::url::ListQuery;

    #[derive(Clone, Debug, Default)]
    #[route("/access/memberships", get = memberships)]
    pub struct Memberships {
        #[route(query)]
        pub query: ListQuery,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/access/invitations", get = invitations)]
    pub struct Invitations {
        #[route(query)]
        pub query: ListQuery,
    }

    /// A membership's page: its account's workspace on its team tab (admin-web's redirect).
    #[route("/access/memberships/{id}", get = crate::access::account::membership)]
    pub struct MembershipPage<'a> {
        pub id: &'a str,
    }

    /// An invitation's page: its account's workspace on its team tab (admin-web's redirect).
    #[route("/access/invitations/{id}", get = crate::access::account::invitation)]
    pub struct InvitationPage<'a> {
        pub id: &'a str,
    }
}

/// The area: its routes and its stylesheet.
pub fn area(area: Area<url::Access>, shared: Shared) -> Area<url::Access> {
    let area = people::area(area, shared.clone());
    let area = teams::area(area, shared.clone());
    url::area(area, shared).components(views::COMPONENTS)
}

/// A list's query as the page reads it (`readOffsetPageParams`, `readIdentityListFilters`): the
/// search trimmed, a status the list knows (else none), and the page.
#[derive(Clone, Debug)]
pub struct Read {
    pub search: String,
    pub status: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

impl Read {
    pub fn of(query: &url::ListQuery, statuses: &[&str]) -> Self {
        let status = query.status.as_deref().map(str::trim).filter(|s| statuses.contains(s)).map(str::to_owned);
        Read {
            search: query.search.as_deref().map(str::trim).unwrap_or_default().to_owned(),
            status,
            limit: query.limit.filter(|l| *l > 0).unwrap_or(PAGE_SIZE).min(MAX_PAGE_SIZE),
            offset: query.offset.unwrap_or(0),
        }
    }

    /// The Identity API's query (`identityListQuery`).
    pub fn api_query(&self) -> String {
        let mut query = format!("limit={}&offset={}", self.limit, self.offset);
        if let Some(status) = &self.status {
            query.push_str(&format!("&status={}", crate::api::segment(status)));
        }
        if !self.search.is_empty() {
            query.push_str(&format!("&search={}", crate::api::segment(&self.search)));
        }
        query
    }

    /// This list's address at `offset` (its filters kept).
    pub fn at(&self, offset: u32) -> url::ListQuery {
        url::ListQuery {
            search: (!self.search.is_empty()).then(|| self.search.clone()),
            status: self.status.clone(),
            limit: (self.limit != PAGE_SIZE).then_some(self.limit),
            offset: (offset > 0).then_some(offset),
        }
    }
}

/// A list's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ListScreen<T> {
    pub list: List<T>,
}

/// Access's home: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct HomeScreen {
    pub home: Home,
    pub search: String,
}

async fn home(
    req: Req,
    Caller(staff): Caller<Staff<AccountsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Access>,
) -> HtmlResult {
    let search = route.search.search.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let (req, viewer, config, headers) = (&req, &staff.viewer, &config, &headers);
    let caller = config.platform.caller(headers, config.proto, None);
    let home = match api::home(&caller, search.as_deref()).await {
        Ok(home) => home,
        Err(error) => return read_failed(req, error, false),
    };
    let screen = HomeScreen { home, search: search.unwrap_or_default() };
    let t: Acc = req.t();
    let view = html! { <views::AccessPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_home()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// A list's read from the Identity API, as the signed-in staff member.
async fn read_list<T: serde::de::DeserializeOwned>(
    config: &Shared,
    headers: &HeaderMap,
    kind: Kind,
    read: &Read,
) -> Result<List<T>, ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    api::list::<T>(&caller, kind, &read.api_query()).await
}

/// A list page: the list a data client gets, and the view drawn of it in the frame.
fn list_page<T: Serialize>(req: &Req, viewer: &Viewer, title: &str, screen: &ListScreen<T>, view: impl Render) -> HtmlResult
where
    ListScreen<T>: ToJson,
{
    req.screen(
        screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={title} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

async fn accounts(
    req: Req,
    Caller(staff): Caller<Staff<AccountsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Accounts>,
) -> HtmlResult {
    let read = Read::of(&route.query, ACCOUNT_STATUSES);
    let screen = match read_list::<Account>(&config, &headers, Kind::Accounts, &read).await {
        Ok(list) => ListScreen { list },
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Acc = req.t();
    list_page(&req, &staff.viewer, t.route_accounts(), &screen, views::accounts(t, req.t(), &read, &screen.list))
}

async fn users(
    req: Req,
    Caller(staff): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<people::Users>,
) -> HtmlResult {
    let read = Read::of(&route.query, USER_STATUSES);
    let screen = match read_list::<User>(&config, &headers, Kind::Users, &read).await {
        Ok(list) => ListScreen { list },
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Acc = req.t();
    list_page(&req, &staff.viewer, t.route_users(), &screen, views::users(t, req.t(), &read, &screen.list))
}

async fn memberships(
    req: Req,
    Caller(staff): Caller<Staff<MembershipsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<teams::Memberships>,
) -> HtmlResult {
    let read = Read::of(&route.query, MEMBERSHIP_STATUSES);
    let screen = match read_list::<Membership>(&config, &headers, Kind::Memberships, &read).await {
        Ok(list) => ListScreen { list },
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Acc = req.t();
    list_page(&req, &staff.viewer, t.route_memberships(), &screen, views::memberships(t, req.t(), &read, &screen.list))
}

async fn invitations(
    req: Req,
    Caller(staff): Caller<Staff<MembershipsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<teams::Invitations>,
) -> HtmlResult {
    let read = Read::of(&route.query, INVITATION_STATUSES);
    let screen = match read_list::<Invitation>(&config, &headers, Kind::Invitations, &read).await {
        Ok(list) => ListScreen { list },
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Acc = req.t();
    list_page(&req, &staff.viewer, t.route_invitations(), &screen, views::invitations(t, req.t(), &read, &screen.list))
}

async fn api_keys(
    req: Req,
    Caller(staff): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<people::ApiKeys>,
) -> HtmlResult {
    let read = Read::of(&route.query, API_KEY_STATUSES);
    let screen = match read_list::<ApiKey>(&config, &headers, Kind::ApiKeys, &read).await {
        Ok(list) => ListScreen { list },
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Acc = req.t();
    list_page(&req, &staff.viewer, t.route_api_keys(), &screen, views::api_keys(t, req.t(), &read, &screen.list))
}

/// Identity's `formatMachineValue`: a known value's words, else an unrecognized one's, with the
/// value made readable when it is a plain token.
pub fn machine(t: Acc, known: Option<&'static str>, family: &str, value: &str) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.value_unrecognized(family).to_string(),
    }
}

/// A lowercase `kebab-case` token as words (`safeMachineToken`, `humanizeMachineValue`).
pub(crate) fn humanized(value: &str) -> Option<String> {
    let token = !value.is_empty()
        && value.len() <= 40
        && value.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    token.then(|| {
        value
            .split('-')
            .map(|part| {
                let mut chars = part.chars();
                chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ")
    })
}

pub fn account_type(t: Acc, value: &str) -> String {
    let known = match value {
        "personal" => Some(t.account_type_personal()),
        "business" => Some(t.account_type_business()),
        "enterprise" => Some(t.account_type_enterprise()),
        _ => None,
    };
    machine(t, known, t.family_account_type(), value)
}

pub fn account_status(t: Acc, value: &str) -> String {
    let known = match value {
        "active" => Some(t.accounts_status_filter_active()),
        "suspended" => Some(t.accounts_status_filter_suspended()),
        "closed" => Some(t.accounts_status_filter_closed()),
        _ => None,
    };
    machine(t, known, t.family_account_status(), value)
}

pub fn user_status(t: Acc, value: &str) -> String {
    let known = match value {
        "active" => Some(t.users_status_filter_active()),
        "suspended" => Some(t.users_status_filter_suspended()),
        _ => None,
    };
    machine(t, known, t.family_user_status(), value)
}

pub fn role(t: Acc, value: &str) -> String {
    let known = match value {
        "platform-admin" => Some(t.role_platform_admin()),
        "owner" => Some(t.role_owner()),
        "manager" => Some(t.role_manager()),
        "fulfillment" => Some(t.role_fulfillment()),
        "viewer" => Some(t.role_viewer()),
        _ => None,
    };
    machine(t, known, t.family_membership_role(), value)
}

pub fn membership_status(t: Acc, value: &str) -> String {
    let known = match value {
        "active" => Some(t.memberships_status_filter_active()),
        "revoked" => Some(t.memberships_status_filter_revoked()),
        _ => None,
    };
    machine(t, known, t.family_membership_status(), value)
}

pub fn invitation_status(t: Acc, value: &str) -> String {
    let known = match value {
        "pending" => Some(t.invitations_status_filter_pending()),
        "accepted" => Some(t.invitations_status_filter_accepted()),
        "declined" => Some(t.invitations_status_filter_declined()),
        "cancelled" => Some(t.invitations_status_filter_cancelled()),
        "expired" => Some(t.invitations_status_filter_expired()),
        _ => None,
    };
    machine(t, known, t.family_invitation_status(), value)
}

pub fn api_key_status(t: Acc, value: &str) -> String {
    let known = match value {
        "active" => Some(t.api_keys_status_filter_active()),
        "revoked" => Some(t.api_keys_status_filter_revoked()),
        _ => None,
    };
    machine(t, known, t.family_api_key_status(), value)
}

/// `authenticationMethodLabel`.
pub fn method(t: Acc, value: &str) -> String {
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
    machine(t, known, t.family_authentication_method(), value)
}

/// The account badges admin-web shows (`AccountBadgeList`): the known ones, a founding
/// account's with its number.
pub fn badges(t: Acc, account: &Account) -> Vec<String> {
    account
        .badges
        .iter()
        .filter_map(|badge| match badge.as_str() {
            "founding-account" => Some(match account.founder_number {
                Some(n) if n > 0 => format!("{} #{n:03}", t.badges_founding_account()),
                _ => t.badges_founding_account().to_owned(),
            }),
            "manual-payout-review" => Some(t.badges_manual_payout_review().to_owned()),
            "trusted-seller" => Some(t.badges_trusted_seller().to_owned()),
            _ => None,
        })
        .collect()
}

/// An admin-web page of the section (an account's workspace and the rest not in the pilot yet).
pub fn admin_web(path: &str) -> String {
    crate::views::admin_web(path).map(|uri| uri.to_string()).unwrap_or_else(|| path.to_owned())
}
