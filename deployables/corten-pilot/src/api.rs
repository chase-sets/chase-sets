//! The platform API, called as the signed-in staff member: every call forwards the browser's
//! cookies and the public host, as admin-web's `createForwardedAuthFetch` does, and names the
//! bounded context it reads (`Chase-Sets-Read-Target-Context`). Types hold only the fields the
//! screen reads; they are also the screen's JSON for data clients.
use std::{fmt, time::Duration};

use corten::axum::http::{HeaderMap, StatusCode, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::receipt::Receipt;

/// The platform API's address and an HTTP client for it.
#[derive(Clone)]
pub struct Platform {
    http: reqwest::Client,
    origin: String,
}

impl Platform {
    pub fn new(origin: &str) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("an HTTP client");
        Platform { http, origin: origin.trim_end_matches('/').to_owned() }
    }

    /// Calls for one browser request: its cookies, its host and the receipt of a write it follows.
    pub fn caller(&self, headers: &HeaderMap, proto: &'static str, receipt: Option<&Receipt>) -> Caller<'_> {
        let text = |name| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        Caller {
            platform: self,
            cookie: text(header::COOKIE),
            host: text(header::HOST).unwrap_or_else(|| "localhost".into()),
            proto,
            receipt: receipt.map(Receipt::header),
        }
    }
}

pub struct Caller<'a> {
    platform: &'a Platform,
    cookie: Option<String>,
    host: String,
    proto: &'static str,
    receipt: Option<String>,
}

const ORDERING: &str = "ordering";
const POLICIES: &str = "/api/marketplace/admin/postage-policies";

impl Caller<'_> {
    fn request(&self, method: reqwest::Method, path: &str, context: &str) -> reqwest::RequestBuilder {
        let mut req = self
            .platform
            .http
            .request(method, format!("{}{path}", self.platform.origin))
            .header("x-forwarded-host", &self.host)
            .header("x-forwarded-proto", self.proto)
            .header("chase-sets-read-target-context", context);
        if let Some(cookie) = &self.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        if let Some(receipt) = &self.receipt {
            req = req.header("chase-sets-read-after-write", receipt);
        }
        req
    }

    async fn read<T: DeserializeOwned>(&self, path: &str, context: &str) -> Result<T, ApiError> {
        let res = self.request(reqwest::Method::GET, path, context).send().await?;
        let res = check(res).await?;
        Ok(res.json().await?)
    }

    async fn write<B: Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<(T, Option<Receipt>), ApiError> {
        let res = self.request(reqwest::Method::POST, path, ORDERING).json(body).send().await?;
        let res = check(res).await?;
        let receipt = Receipt::from_response(res.headers());
        Ok((res.json().await?, receipt))
    }

    async fn command<B: Serialize>(&self, method: reqwest::Method, path: &str, body: &B) -> Result<Written, ApiError> {
        let res = self.request(method, path, ORDERING).json(body).send().await?;
        let res = check(res).await?;
        let receipt = Receipt::from_response(res.headers());
        let id: Id = res.json().await?;
        Ok(Written { id: id.id, receipt })
    }

    /// The staff member the cookies belong to, or `None` when they are signed out.
    pub async fn session(&self) -> Result<Option<Actor>, ApiError> {
        match self.read::<SessionBody>("/api/auth/session", "auth").await {
            Ok(body) => Ok(body.actor),
            Err(ApiError::Status { status: StatusCode::UNAUTHORIZED, .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn list(&self, limit: u32, offset: u32) -> Result<PolicyList, ApiError> {
        self.read(&format!("{POLICIES}?limit={limit}&offset={offset}"), ORDERING).await
    }

    pub async fn get(&self, id: &str) -> Result<Policy, ApiError> {
        self.read(&format!("{POLICIES}/{}", segment(id)), ORDERING).await
    }

    pub async fn create(&self, body: &PolicyCommand) -> Result<Written, ApiError> {
        self.command(reqwest::Method::POST, POLICIES, body).await
    }

    pub async fn revise(&self, id: &str, body: &PolicyCommand) -> Result<Written, ApiError> {
        self.command(reqwest::Method::PUT, &format!("{POLICIES}/{}", segment(id)), body).await
    }

    pub async fn activate(&self, id: &str, reason: &str) -> Result<Written, ApiError> {
        let body = serde_json::json!({ "activationReason": reason });
        self.command(reqwest::Method::POST, &format!("{POLICIES}/{}/activate", segment(id)), &body).await
    }

    pub async fn retire(&self, id: &str, reason: &str) -> Result<Written, ApiError> {
        let body = serde_json::json!({ "retirementReason": reason });
        self.command(reqwest::Method::POST, &format!("{POLICIES}/{}/retire", segment(id)), &body).await
    }

    pub async fn clone_policy(&self, id: &str, body: &CloneCommand<'_>) -> Result<Written, ApiError> {
        self.command(reqwest::Method::POST, &format!("{POLICIES}/{}/clone", segment(id)), body).await
    }

    pub async fn preview(&self, body: &PreviewCommand<'_>) -> Result<PackagePlan, ApiError> {
        let (plan, _): (PreviewBody, _) = self.write(&format!("{POLICIES}/preview"), body).await?;
        Ok(plan.package_plan)
    }
}

/// What `encodeURIComponent` leaves as it is: admin-web's encoding for path segments and the
/// read-after-write header.
pub const URI_COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// A path segment, as `encodeURIComponent` writes it.
fn segment(text: &str) -> String {
    percent_encoding::utf8_percent_encode(text, URI_COMPONENT).to_string()
}

async fn check(res: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if status.is_success() {
        return Ok(res);
    }
    let body: Option<ErrorBody> = res.json().await.ok();
    let (code, message) = body.map(|b| (b.error.code, b.error.message)).unwrap_or_default();
    Err(ApiError::Status { status, code, message })
}

/// Why a call failed.
#[derive(Debug)]
pub enum ApiError {
    /// The API answered with an error: its status, `error.code` and `error.message`.
    Status { status: StatusCode, code: Option<String>, message: String },
    /// No answer, or one that is not the expected JSON.
    Transport(reqwest::Error),
}

impl ApiError {
    /// The API's message for a refusal the user can act on (a 4xx other than sign-in).
    pub fn refusal(&self) -> Option<&str> {
        match self {
            ApiError::Status { status, message, .. }
                if status.is_client_error() && *status != StatusCode::UNAUTHORIZED && !message.is_empty() =>
            {
                Some(message)
            }
            _ => None,
        }
    }

    pub fn status(&self) -> Option<StatusCode> {
        match self {
            ApiError::Status { status, .. } => Some(*status),
            ApiError::Transport(_) => None,
        }
    }

    /// After a write, whether this read failed only because the write's projection is not
    /// readable yet: `classifyFreshWriteReadError`'s transient kinds (contracts/http/responses.ts).
    pub fn catching_up(&self) -> bool {
        match self {
            ApiError::Status { status, code, .. } => matches!(
                (status.as_u16(), code.as_deref()),
                (404, _) | (503, Some("projection_freshness_timeout")) | (502..=504, None)
            ),
            ApiError::Transport(_) => false,
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Status { status, code, message } => {
                write!(f, "platform API {status}: {} {message}", code.as_deref().unwrap_or("-"))
            }
            ApiError::Transport(error) => write!(f, "platform API unreachable: {error}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(error: reqwest::Error) -> Self {
        ApiError::Transport(error)
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    code: Option<String>,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct SessionBody {
    actor: Option<Actor>,
}

/// The signed-in staff member, from `GET /api/auth/session`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub user_id: String,
    pub role_key: String,
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

/// A write the API accepted: the policy's id and the receipt the next read waits for.
pub struct Written {
    pub id: String,
    pub receipt: Option<Receipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PolicyList {
    pub items: Vec<Policy>,
    pub total: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Policy {
    pub policy_id: String,
    pub label: String,
    pub status: String,
    pub policy_version: String,
    pub payload: Payload,
    pub effective_from: String,
    pub effective_until: Option<String>,
    pub activation_reason: Option<String>,
    pub updated_at: String,
    pub activated_at: Option<String>,
    #[serde(default)]
    pub history: Vec<History>,
    #[serde(default, rename = "activeComparison")]
    pub active_comparison: Vec<Difference>,
}

/// A policy's rules (`PostagePolicy` in contracts/product-measures).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub policy_version: String,
    pub max_letter_units: f64,
    pub max_letter_weight_ounces: f64,
    pub max_letter_thickness_inches: f64,
    pub max_letter_declared_value_amount: f64,
    pub letter_envelope_weight_ounces: f64,
    pub parcel_packaging_weight_ounces: f64,
    pub parcel_required_shipping_options: Vec<String>,
    pub letter_required_physical_flags: Vec<String>,
    pub parcel_required_physical_flags: Vec<String>,
    pub signature_required_shipping_options: Vec<String>,
    pub signature_required_declared_value_amount: Option<f64>,
    pub signature_required_physical_flags: Vec<String>,
    pub insurance_required_declared_value_amount: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct History {
    pub history_id: String,
    pub event_type: String,
    pub actor_user_id: String,
    pub reason: Option<String>,
    pub status: String,
    pub recorded_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub field: String,
    pub active_value: String,
    pub candidate_value: String,
}

/// The body of a create or a revision: the label, the dates and the rules, side by side.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCommand {
    pub label: String,
    pub effective_from: String,
    pub effective_until: String,
    #[serde(flatten)]
    pub payload: Payload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneCommand<'a> {
    pub label: &'a str,
    pub effective_from: &'a str,
    pub effective_until: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCommand<'a> {
    pub policy: &'a Payload,
    pub shipping_option: &'a str,
    pub item_subtotal_amount: &'a str,
    pub quantity: f64,
    pub unit_length_inches: f64,
    pub unit_width_inches: f64,
    pub unit_height_inches: f64,
    pub unit_weight_ounces: f64,
    pub physical_flags: &'a [String],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBody {
    package_plan: PackagePlan,
}

/// What a preview answers (`PackagePlan` in contracts/product-measures), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub package_count: u32,
    pub packages: Vec<Package>,
    pub postage_policy_snapshot: Option<Snapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub mailpiece_class: String,
    pub service_level: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub parcel_required: bool,
    pub parcel_reasons: Vec<String>,
    pub signature_required: bool,
    pub signature_reasons: Vec<String>,
    pub insurance_required: bool,
    pub insurance_reasons: Vec<String>,
    pub insured_value_amount: Option<String>,
    pub shipping_evidence_tier: String,
}
