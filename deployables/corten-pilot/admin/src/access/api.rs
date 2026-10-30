//! The Identity API as the access section reads it (`/api/identity`, bounded-contexts/identity's
//! `AccessHome`, `Account`, `User`, `Membership`, `Invitation` and `ApiKey`), as far as the pages
//! use it. Each list answers `{ items, total }` for a `limit` and `offset`.
use corten::prelude::*;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::api::{ApiError, Caller, segment};

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
    pub primary_email: Option<String>,
    pub status: String,
    #[serde(default)]
    pub auth_methods: Vec<String>,
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
