//! An account's workspace (admin-web's `/access/accounts/{id}`, `AccountAccessHubPage`): the
//! account's overview (profile, lifecycle, badges), its team (memberships, invitations and each
//! user the viewer may manage), its API access and its Identity history, one tab each, read from
//! the Identity API (`GET /api/identity/access-hub/accounts/{id}`).
//!
//! Each form posts an `intent` to the workspace, as admin-web's do, and is refused (403) unless
//! the viewer has what admin-web shows it for: `accounts.manage` for the profile and lifecycle,
//! the platform admin role for badges, `memberships.manage` for memberships and invitations,
//! and `security.manage` for users and API keys (a user's own, unless a platform admin). A write
//! goes back to its tab, read after its receipt. A key's create or rotate answers with the page
//! and its one-time secret (never in an address). A refusal (4xx) is the page with the API's
//! words.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    api::{self, Hub, Secret},
    url, views,
};
use crate::{
    api::{ApiError, Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{AccountsView, MembershipsView, SecurityManage, Staff, Viewer},
    text::Acc,
};

/// The workspace's tabs (`accountAccessHubTabs`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tab {
    #[default]
    Overview,
    Team,
    ApiAccess,
    Audit,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Overview, Tab::Team, Tab::ApiAccess, Tab::Audit];

    /// The tab an address names, else the overview.
    pub fn of(value: Option<&str>) -> Tab {
        Tab::ALL.into_iter().find(|tab| Some(tab.key()) == value).unwrap_or(Tab::Overview)
    }

    pub fn key(self) -> &'static str {
        match self {
            Tab::Overview => "overview",
            Tab::Team => "team",
            Tab::ApiAccess => "api-access",
            Tab::Audit => "audit",
        }
    }
}

/// Where an account's workspace opens on a tab; the overview is its plain address.
pub fn hub(account: &str, tab: Tab) -> String {
    let tab = (tab != Tab::Overview).then_some(tab.key());
    url::AccountHub { id: account, tab, after_write: None }.href()
}

/// The badges a platform admin assigns and removes here (`accountBadgeKeys` but the founding
/// account's, which Identity gives).
pub const ASSIGNABLE_BADGES: [&str; 2] = ["manual-payout-review", "trusted-seller"];
/// Every badge key Identity knows (`accountBadgeKeys`).
const BADGES: [&str; 3] = ["founding-account", "manual-payout-review", "trusted-seller"];
/// The roles a membership or an invitation can have (`GRANTABLE_ROLE_KEYS`).
pub const GRANTABLE_ROLES: [&str; 4] = ["owner", "manager", "fulfillment", "viewer"];
/// A contact method's types (`contactMethodTypeSelectItems`).
pub const CONTACT_METHOD_TYPES: [&str; 2] = ["email", "phone"];
/// The sign-in methods staff enable here (`identityAuthenticationMethodSelectItems`).
pub const AUTH_METHODS: [&str; 5] = ["password", "magic-link", "passkey", "sms-code", "social-login"];
/// How long an invitation is open (admin-web's seven days).
const INVITATION_OPEN_FOR: Duration = Duration::days(7);

/// Whether the viewer may manage `user`'s access (`canManageUser`).
pub fn manages_user(viewer: &Viewer, user: &str) -> bool {
    viewer.can("security.manage") && (viewer.role_key == "platform-admin" || viewer.user_id == user)
}

/// Every form of the workspace: its intent and the fields some intents send.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct HubForm {
    pub intent: String,
    pub name: String,
    pub display_name: String,
    pub badge_key: String,
    pub email: String,
    pub role_key: String,
    pub membership_id: String,
    pub invitation_id: String,
    pub expires_at: String,
    pub user_id: String,
    pub given_name: String,
    pub family_name: String,
    pub contact_method_type: String,
    pub contact_method_value: String,
    pub contact_method_id: String,
    pub auth_method: String,
    pub api_key_id: String,
    pub api_key_name: String,
}

/// A form's call: where it goes, and the tab it comes back to.
enum Call {
    Write { method: Method, rest: String, body: Option<Value>, tab: Tab },
    Secret { rest: String, body: Value, created: bool },
}

/// The form's call, or `None` for an intent the workspace does not have; `Err` when the viewer
/// may not send it.
fn call(viewer: &Viewer, account: &str, form: &HubForm) -> Option<Result<Call, StatusCode>> {
    let acc = segment(account);
    let s = segment;
    let allow = |may: bool, call: Call| Some(if may { Ok(call) } else { Err(StatusCode::FORBIDDEN) });
    let write = |method, rest: String, body: Option<Value>, tab| Call::Write { method, rest, body, tab };
    let accounts = viewer.can("accounts.manage");
    let memberships = viewer.can("memberships.manage");
    let admin = viewer.role_key == "platform-admin";
    let user = manages_user(viewer, &form.user_id);
    let empty = Some(json!({}));
    match form.intent.as_str() {
        "update-profile" => allow(
            accounts,
            write(
                Method::PUT,
                format!("/accounts/{acc}"),
                Some(json!({ "name": form.name, "displayName": form.display_name })),
                Tab::Overview,
            ),
        ),
        action @ ("suspend" | "reactivate" | "close") => {
            allow(accounts, write(Method::POST, format!("/accounts/{acc}/{action}"), empty, Tab::Overview))
        }
        "assign-account-badge" | "remove-account-badge" if !BADGES.contains(&form.badge_key.as_str()) => {
            Some(Err(StatusCode::BAD_REQUEST))
        }
        "assign-account-badge" => allow(
            admin,
            write(Method::POST, format!("/accounts/{acc}/badges"), Some(json!({ "badgeKey": form.badge_key })), Tab::Overview),
        ),
        "remove-account-badge" => {
            allow(admin, write(Method::DELETE, format!("/accounts/{acc}/badges/{}", s(&form.badge_key)), None, Tab::Overview))
        }
        "create-invitation" => {
            let expires = OffsetDateTime::now_utc() + INVITATION_OPEN_FOR;
            let expires = expires.replace_millisecond(expires.millisecond()).ok()?.format(&Rfc3339).ok()?;
            let role = if form.role_key.is_empty() { "viewer" } else { &form.role_key };
            let body = json!({
                "invitationId": crate::catalog::form::new_id("ivt"), "accountId": account, "email": form.email,
                "roleKey": role, "expiresAt": expires,
            });
            allow(memberships, write(Method::POST, "/invitations".into(), Some(body), Tab::Team))
        }
        "change-membership-role" => allow(
            memberships,
            write(
                Method::PUT,
                format!("/memberships/{}/role", s(&form.membership_id)),
                Some(json!({ "roleKey": form.role_key })),
                Tab::Team,
            ),
        ),
        "revoke-membership" => {
            allow(memberships, write(Method::POST, format!("/memberships/{}/revoke", s(&form.membership_id)), empty, Tab::Team))
        }
        "reinstate-membership" => allow(
            memberships,
            write(Method::POST, format!("/memberships/{}/reinstate", s(&form.membership_id)), empty, Tab::Team),
        ),
        "resend-invitation" => allow(
            memberships,
            write(
                Method::POST,
                format!("/invitations/{}/resend", s(&form.invitation_id)),
                Some(json!({ "expiresAt": form.expires_at })),
                Tab::Team,
            ),
        ),
        action @ ("cancel-invitation" | "decline-invitation") => {
            let action = action.trim_end_matches("-invitation");
            allow(memberships, write(Method::POST, format!("/invitations/{}/{action}", s(&form.invitation_id)), empty, Tab::Team))
        }
        "update-user-profile" => allow(
            user,
            write(
                Method::PUT,
                format!("/users/{}", s(&form.user_id)),
                Some(json!({ "displayName": form.display_name, "givenName": form.given_name, "familyName": form.family_name })),
                Tab::Team,
            ),
        ),
        "suspend-user" => allow(user, write(Method::POST, format!("/users/{}/suspend", s(&form.user_id)), empty, Tab::Team)),
        "reactivate-user" => {
            allow(user, write(Method::POST, format!("/users/{}/reactivate", s(&form.user_id)), empty, Tab::Team))
        }
        "add-user-contact-method" => {
            let body = json!({
                "contactMethodId": crate::catalog::form::new_id("ctm"),
                "contactMethodType": form.contact_method_type, "value": form.contact_method_value,
            });
            allow(user, write(Method::POST, format!("/users/{}/contact-methods", s(&form.user_id)), Some(body), Tab::Team))
        }
        "verify-user-contact-method" => allow(
            user,
            write(
                Method::POST,
                format!("/users/{}/contact-methods/{}/verify", s(&form.user_id), s(&form.contact_method_id)),
                empty,
                Tab::Team,
            ),
        ),
        "enable-user-auth-method" => allow(
            user,
            write(
                Method::POST,
                format!("/users/{}/auth-methods", s(&form.user_id)),
                Some(json!({ "authMethod": form.auth_method })),
                Tab::Team,
            ),
        ),
        "disable-user-auth-method" => allow(
            user,
            write(Method::DELETE, format!("/users/{}/auth-methods/{}", s(&form.user_id), s(&form.auth_method)), None, Tab::Team),
        ),
        // A key's owner is checked by the API; the workspace shows these only for keys the viewer manages.
        "create-api-key" => allow(
            user,
            Call::Secret {
                rest: "/api-keys".into(),
                body: json!({ "userId": form.user_id, "name": form.api_key_name }),
                created: true,
            },
        ),
        "rotate-api-key" => allow(
            viewer.can("security.manage"),
            Call::Secret { rest: format!("/api-keys/{}/rotate", s(&form.api_key_id)), body: json!({}), created: false },
        ),
        "revoke-api-key" => allow(
            viewer.can("security.manage"),
            write(Method::POST, format!("/api-keys/{}/revoke", s(&form.api_key_id)), empty, Tab::ApiAccess),
        ),
        _ => None,
    }
}

/// The workspace as a data client gets it: the hub, the tab, and a key's one-time secret.
#[derive(Serialize, ToJson)]
pub struct HubScreen {
    pub hub: Hub,
    pub tab: &'static str,
    pub secret: Option<Secret>,
    /// Why the last form was refused.
    pub refusal: Option<String>,
    /// Whether the page was read without the write it follows, which is not readable yet.
    pub catching_up: bool,
}

pub(crate) async fn page(
    req: Req,
    Caller(staff): Caller<Staff<AccountsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::AccountHub<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let shown = Shown { tab: Tab::of(route.tab.as_deref()), receipt, ..Shown::default() };
    draw(&req, &staff.viewer, &config, &headers, &route.id, shown).await
}

/// What the page shows besides the hub: its tab, the write it is read after, and what a form left.
#[derive(Default)]
struct Shown {
    tab: Tab,
    receipt: Option<Receipt>,
    secret: Option<Secret>,
    refusal: Option<String>,
    status: Option<StatusCode>,
}

async fn draw(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, id: &str, shown: Shown) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, shown.receipt.as_ref());
    let mut catching_up = false;
    let hub = match api::hub(&caller, id).await {
        Ok(hub) => hub,
        // admin-web's `onPending`: the write is not readable yet, so the page is read without it
        // and says so (chase-sets/chase-sets#10828: the receipted read times out on projections
        // the write did not touch; drop the note when it is fixed, keep the fallback).
        Err(error) if shown.receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match api::hub(&config.platform.caller(headers, config.proto, None), id).await {
                Ok(hub) => hub,
                Err(error) => return read_failed(req, error, false),
            }
        }
        Err(error) => return read_failed(req, error, shown.receipt.is_some()),
    };
    let screen = HubScreen { hub, tab: shown.tab.key(), secret: shown.secret, refusal: shown.refusal, catching_up };
    let t: Acc = req.t();
    let view = html! { <views::AccountPage t={t} p={req.t()} viewer={viewer} screen={&screen} tab={shown.tab} /> };
    req.screen_with_status(
        shown.status.unwrap_or(StatusCode::OK),
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_account()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

pub(crate) async fn write(
    req: Req,
    Caller(staff): Caller<Staff<AccountsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::AccountHub<'_>>,
    Form(form): Form<HubForm>,
) -> HtmlResult {
    let (id, viewer) = (route.id, &staff.viewer);
    let call = match call(viewer, &id, &form) {
        Some(Ok(call)) => call,
        Some(Err(status)) => return Err(corten::Error::status(status)),
        None => return Err(corten::Error::status(StatusCode::BAD_REQUEST)),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let (tab, error) = match call {
        Call::Write { method, rest, body, tab } => match api::write(&caller, method, &rest, body.as_ref()).await {
            Ok(receipt) => {
                let after_write = receipt.as_ref().map(Receipt::param);
                return req.redirect(&url::AccountHub { id: &id, tab: Some(tab.key()), after_write });
            }
            Err(error) => (tab, error),
        },
        Call::Secret { rest, body, created } => match api::with_secret(&caller, &rest, &body, created).await {
            Ok((secret, receipt)) => {
                let status = if created { StatusCode::CREATED } else { StatusCode::OK };
                let shown =
                    Shown { tab: Tab::ApiAccess, receipt, secret: Some(secret), status: Some(status), ..Shown::default() };
                return draw(&req, viewer, &config, &headers, &id, shown).await;
            }
            Err(error) => (Tab::ApiAccess, error),
        },
    };
    refused(&req, viewer, &config, &headers, &id, tab, error).await
}

/// A form the API refused (4xx), as the workspace on its tab with the API's words; a session that
/// ended signs in again, and anything else is a 502.
async fn refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    tab: Tab,
    error: ApiError,
) -> HtmlResult {
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(status) if status.is_client_error() => status,
        _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let p: crate::text::Pilot = req.t();
    let refusal = Some(error.refusal().unwrap_or(p.access_refused()).to_owned());
    let status = if status == StatusCode::CONFLICT { status } else { StatusCode::UNPROCESSABLE_ENTITY };
    draw(req, viewer, config, headers, id, Shown { tab, refusal, status: Some(status), ..Shown::default() }).await
}

/// A user's or a key's account, or the list searched for it: admin-web's redirects.
fn to_account(
    req: &Req,
    account: Option<String>,
    tab: Tab,
    search: &str,
    list: impl FnOnce(super::url::ListQuery) -> String,
) -> HtmlResult {
    let to = match account {
        Some(account) => url::AccountHub { id: &account, tab: Some(tab.key()), after_write: None }.href(),
        None => list(super::url::ListQuery { search: Some(search.to_owned()), ..Default::default() }),
    };
    req.redirect(&to.parse::<corten::axum::http::Uri>().map_err(corten::Error::new)?)
}

pub(crate) async fn user(
    req: Req,
    Caller(_): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<super::people::UserPage<'_>>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    match api::user_account(&caller, &route.id).await {
        Ok(account) => to_account(&req, account, Tab::Team, &route.id, |query| super::people::Users { query }.href()),
        Err(error) => read_failed(&req, error, false),
    }
}

pub(crate) async fn api_key(
    req: Req,
    Caller(_): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<super::people::ApiKeyPage<'_>>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let account = match api::api_key(&caller, &route.id).await {
        Ok(key) => api::user_account(&caller, &key.user_id).await,
        Err(error) => Err(error),
    };
    match account {
        Ok(account) => to_account(&req, account, Tab::ApiAccess, &route.id, |query| super::people::ApiKeys { query }.href()),
        Err(error) => read_failed(&req, error, false),
    }
}

/// A membership's account, on its team tab.
pub(crate) async fn membership(
    req: Req,
    Caller(_): Caller<Staff<MembershipsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<super::teams::MembershipPage<'_>>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    match api::membership(&caller, &route.id).await {
        Ok(m) => to_account(&req, Some(m.account_id), Tab::Team, &route.id, |_| String::new()),
        Err(error) => read_failed(&req, error, false),
    }
}

/// An invitation's account, on its team tab.
pub(crate) async fn invitation(
    req: Req,
    Caller(_): Caller<Staff<MembershipsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<super::teams::InvitationPage<'_>>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    match api::invitation(&caller, &route.id).await {
        Ok(i) => to_account(&req, Some(i.account_id), Tab::Team, &route.id, |_| String::new()),
        Err(error) => read_failed(&req, error, false),
    }
}
