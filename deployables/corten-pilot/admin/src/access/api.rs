//! The Identity API as the access section reads it (`/api/identity`, bounded-contexts/identity's
//! `AccessHome`, `Account`, `User`, `Membership`, `Invitation` and `ApiKey`), as far as the pages
//! use it. Each list answers `{ items, total }` for a `limit` and `offset`.
use corten::prelude::*;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use platform::receipt::Receipt;
use serde_json::Value;

use crate::api::{ApiError, Caller, Method, segment};

pub const CONTEXT: &str = "identity";

/// A page of a list and how many there are in all.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct List<T> {
    pub items: Vec<T>,
    pub total: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Account {
    pub account_id: String,
    pub name: String,
    pub display_name: String,
    pub account_type: String,
    pub status: String,
    #[serde(default)]
    pub badges: Vec<String>,
    #[serde(default)]
    pub founder_number: Option<u32>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct User {
    pub user_id: String,
    pub display_name: String,
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub family_name: Option<String>,
    #[serde(default)]
    pub primary_email: Option<String>,
    pub status: String,
    #[serde(default)]
    pub auth_methods: Vec<String>,
    #[serde(default)]
    pub contact_methods: Vec<ContactMethod>,
}

impl User {
    /// `userLabel`: the display name, else the email, else the id.
    pub fn label(&self) -> &str {
        Some(self.display_name.as_str())
            .filter(|n| !n.is_empty())
            .or(self.primary_email.as_deref().filter(|e| !e.is_empty()))
            .unwrap_or(&self.user_id)
    }
}

/// A user's email or phone, and whether it is verified (`ContactMethod`; its keys are camelCase).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ContactMethod {
    pub contact_method_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub verified_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Membership {
    pub membership_id: String,
    pub user_id: String,
    #[serde(default)]
    pub user_display_name: Option<String>,
    #[serde(default)]
    pub user_primary_email: Option<String>,
    pub account_id: String,
    #[serde(default)]
    pub account_display_name: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    pub role_key: String,
    pub status: String,
}

impl Membership {
    /// `userLabel`: the display name, else the email, else the id.
    pub fn user_label(&self) -> &str {
        self.user_display_name.as_deref().or(self.user_primary_email.as_deref()).unwrap_or(&self.user_id)
    }

    /// `accountLabel`: the display name, else the legal name, else the id.
    pub fn account_label(&self) -> &str {
        self.account_display_name.as_deref().or(self.account_name.as_deref()).unwrap_or(&self.account_id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Invitation {
    pub invitation_id: String,
    pub account_id: String,
    #[serde(default)]
    pub account_display_name: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    pub email: String,
    pub role_key: String,
    pub status: String,
    pub expires_at: String,
}

impl Invitation {
    pub fn account_label(&self) -> &str {
        self.account_display_name.as_deref().or(self.account_name.as_deref()).unwrap_or(&self.account_id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct ApiKey {
    pub api_key_id: String,
    pub user_id: String,
    #[serde(default)]
    pub user_display_name: Option<String>,
    #[serde(default)]
    pub user_primary_email: Option<String>,
    pub name: String,
    pub key_prefix: String,
    pub status: String,
}

impl ApiKey {
    pub fn user_label(&self) -> &str {
        self.user_display_name.as_deref().or(self.user_primary_email.as_deref()).unwrap_or(&self.user_id)
    }
}

/// A key whose rotation is due, with its account (`ApiKeyRotationAttention`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct RotationDue {
    #[serde(flatten)]
    pub key: ApiKey,
    pub account_id: String,
    #[serde(default)]
    pub account_display_name: String,
    #[serde(default)]
    pub rotation_due_at: Option<String>,
}

/// What needs an operator (`AccessAttentionQueue`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
pub struct Attention {
    #[serde(default)]
    pub pending_invitations: Vec<Invitation>,
    #[serde(default)]
    pub api_keys_needing_rotation: Vec<RotationDue>,
    #[serde(default)]
    pub suspended_accounts: Vec<Account>,
    #[serde(default)]
    pub memberships_awaiting_review: Vec<Membership>,
}

/// Access's home (`AccessHome`): the accounts found, how many in all, and the attention queue.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Home {
    pub accounts: Vec<Account>,
    pub account_total: u64,
    #[serde(default)]
    pub attention: Attention,
}

/// An Identity event of the account or its access records (`AccountAuditEvent`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct AuditEvent {
    pub event_id: String,
    pub stream_id: String,
    pub event_type: String,
    pub performed_by_user_id: String,
    pub recorded_at: String,
}

/// An account's workspace (`AccountAccessHub`): the account, its team's users, memberships and
/// invitations, its API keys and its Identity history.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Hub {
    pub account: Account,
    #[serde(default)]
    pub users: Vec<User>,
    #[serde(default)]
    pub memberships: Vec<Membership>,
    #[serde(default)]
    pub invitations: Vec<Invitation>,
    #[serde(default)]
    pub api_keys: Vec<ApiKey>,
    #[serde(default)]
    pub audit_events: Vec<AuditEvent>,
}

/// A key's one-time secret, as a create or a rotate answers it (`ApiKeySecretMutationResult`).
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Secret {
    pub api_key_id: String,
    pub key_prefix: String,
    pub secret: String,
    /// Whether the key was created (else rotated).
    pub created: bool,
}

/// The create's or rotate's answer, as the API names it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretAnswer {
    id: String,
    key_prefix: String,
    secret: String,
}

/// The lists the section reads, by their path under `/api/identity`.
#[derive(Clone, Copy, Debug)]
pub enum Kind {
    Accounts,
    Users,
    Memberships,
    Invitations,
    ApiKeys,
}

impl Kind {
    pub fn path(self) -> &'static str {
        match self {
            Kind::Accounts => "accounts",
            Kind::Users => "users",
            Kind::Memberships => "memberships",
            Kind::Invitations => "invitations",
            Kind::ApiKeys => "api-keys",
        }
    }
}

/// Access's home, its accounts found by `search` (`GET /api/identity/access-hub`).
pub async fn home(caller: &Caller<'_>, search: Option<&str>) -> Result<Home, ApiError> {
    let query = search.map(|s| format!("?search={}", segment(s))).unwrap_or_default();
    caller.read(&format!("/api/identity/access-hub{query}"), CONTEXT).await
}

/// A page of a list, its query already built (`identityListQuery`).
pub async fn list<T: DeserializeOwned>(caller: &Caller<'_>, kind: Kind, query: &str) -> Result<List<T>, ApiError> {
    caller.read(&format!("/api/identity/{}?{query}", kind.path()), CONTEXT).await
}

/// An account's workspace (`GET /api/identity/access-hub/accounts/{id}`).
pub async fn hub(caller: &Caller<'_>, id: &str) -> Result<Hub, ApiError> {
    caller.read(&format!("/api/identity/access-hub/accounts/{}", segment(id)), CONTEXT).await
}

/// A write under `/api/identity` (`rest`, its segments already escaped): its receipt.
pub async fn write(caller: &Caller<'_>, method: Method, rest: &str, body: Option<&Value>) -> Result<Option<Receipt>, ApiError> {
    let mut req = caller.request(method, &format!("/api/identity{rest}"), CONTEXT);
    if let Some(body) = body {
        req = req.json(body);
    }
    let (_, receipt): (Value, _) = caller.write(req).await?;
    Ok(receipt)
}

/// A key's create or rotate: its one-time secret and the receipt. An answer without the secret
/// is the API failing (admin-web's `oneTimeSecretFromMutation`: a 502).
pub async fn with_secret(
    caller: &Caller<'_>,
    rest: &str,
    body: &Value,
    created: bool,
) -> Result<(Secret, Option<Receipt>), ApiError> {
    let req = caller.request(Method::POST, &format!("/api/identity{rest}"), CONTEXT).json(body);
    let (answer, receipt): (SecretAnswer, _) = caller.write(req).await?;
    let secret = Secret { api_key_id: answer.id, key_prefix: answer.key_prefix, secret: answer.secret, created };
    Ok((secret, receipt))
}

/// The account a user acts for, if any (`GET /api/identity/access-hub/users/{id}/account`).
pub async fn user_account(caller: &Caller<'_>, user: &str) -> Result<Option<String>, ApiError> {
    #[derive(Deserialize)]
    struct Link {
        account_id: Option<String>,
    }
    let link: Link = caller.read(&format!("/api/identity/access-hub/users/{}/account", segment(user)), CONTEXT).await?;
    Ok(link.account_id)
}

/// A membership (`GET /api/identity/memberships/{id}`).
pub async fn membership(caller: &Caller<'_>, id: &str) -> Result<Membership, ApiError> {
    caller.read(&format!("/api/identity/memberships/{}", segment(id)), CONTEXT).await
}

/// An invitation (`GET /api/identity/invitations/{id}`).
pub async fn invitation(caller: &Caller<'_>, id: &str) -> Result<Invitation, ApiError> {
    caller.read(&format!("/api/identity/invitations/{}", segment(id)), CONTEXT).await
}

/// An API key (`GET /api/identity/api-keys/{id}`).
pub async fn api_key(caller: &Caller<'_>, id: &str) -> Result<ApiKey, ApiError> {
    caller.read(&format!("/api/identity/api-keys/{}", segment(id)), CONTEXT).await
}
