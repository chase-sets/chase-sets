//! The platform API, called as the signed-in user: every call forwards the browser's cookies and
//! the public host, as the web hosts' `createForwardedAuthFetch` does, and names the bounded
//! context it reads (`Chase-Sets-Read-Target-Context`). Each app adds the calls its screens make.
use std::{fmt, time::Duration};

use corten::http::{HeaderMap, StatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};

use crate::receipt::Receipt;

pub use reqwest::{Method, RequestBuilder};

/// The platform's internal capability (`x-chase-sets-internal-auth`, from
/// `PLATFORM_INTERNAL_AUTH_SECRET`): what a web host's server sends on the few calls only a host may
/// make, as `createPlatformInternalAuthHeaders` does. Never printed: its header is marked sensitive
/// and its `Debug` says nothing of it.
#[derive(Clone)]
pub struct InternalAuth(reqwest::header::HeaderValue);

impl InternalAuth {
    pub const ENV: &'static str = "PLATFORM_INTERNAL_AUTH_SECRET";
    const HEADER: &'static str = "x-chase-sets-internal-auth";

    /// The capability, trimmed; none for an empty value or one a header cannot carry.
    pub fn new(secret: &str) -> Option<Self> {
        let mut value = reqwest::header::HeaderValue::from_str(secret.trim()).ok().filter(|v| !v.is_empty())?;
        value.set_sensitive(true);
        Some(InternalAuth(value))
    }

    /// The capability the environment holds, if any. Unlike the React hosts the pilot has no
    /// development default: without it the calls that need it are refused by the API. A value set
    /// that a header cannot carry is warned of here, once, rather than only by those refusals.
    pub fn from_env() -> Option<Self> {
        let value = std::env::var(Self::ENV).ok()?;
        let found = Self::new(&value);
        if found.is_none() && !value.trim().is_empty() {
            tracing::warn!("{} is set but is not a value a header can carry, so it is not sent", Self::ENV);
        }
        found
    }
}

impl fmt::Debug for InternalAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("InternalAuth(..)")
    }
}

/// The platform API's address and an HTTP client for it.
#[derive(Clone)]
pub struct Platform {
    http: reqwest::Client,
    /// The same, but a redirect the API answers is the answer: a relayed page passes it on to
    /// the browser instead of following it here.
    direct: reqwest::Client,
    origin: String,
    /// The internal capability, for the calls only a host may make.
    internal: Option<InternalAuth>,
}

impl Platform {
    pub fn new(origin: &str) -> Self {
        let client = || reqwest::Client::builder().timeout(Duration::from_secs(10));
        let http = client().build().expect("an HTTP client");
        let direct = client().redirect(reqwest::redirect::Policy::none()).build().expect("an HTTP client");
        Platform { http, direct, origin: origin.trim_end_matches('/').to_owned(), internal: None }
    }

    /// The same, holding the internal capability (`InternalAuth::from_env`).
    pub fn with_internal_auth(mut self, internal: Option<InternalAuth>) -> Self {
        self.internal = internal;
        self
    }

    /// The API's origin, `http://localhost:7762` locally.
    pub fn origin(&self) -> &str {
        &self.origin
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

    /// Calls that are the same for everyone: no cookies, no receipt, and the host the app
    /// configured instead of the request's, for a handler that cannot read who is asking
    /// (`corten::Public`).
    pub fn anonymous(&self, host: &str, proto: &'static str) -> Caller<'_> {
        Caller { platform: self, cookie: None, host: host.to_owned(), proto, receipt: None }
    }
}

pub struct Caller<'a> {
    platform: &'a Platform,
    cookie: Option<String>,
    host: String,
    proto: &'static str,
    receipt: Option<String>,
}

impl Caller<'_> {
    /// A request to `path` that reads or writes the bounded context `context`.
    pub fn request(&self, method: Method, path: &str, context: &str) -> RequestBuilder {
        self.prepare(&self.platform.http, method, path, context)
    }

    /// The same request with the platform's internal capability, for a call only a host may make
    /// (Auth's guest checkout claim). Without the capability none is sent, and the API refuses it.
    pub fn request_internal(&self, method: Method, path: &str, context: &str) -> RequestBuilder {
        let req = self.request(method, path, context);
        match &self.platform.internal {
            Some(InternalAuth(secret)) => req.header(InternalAuth::HEADER, secret.clone()),
            None => req,
        }
    }

    /// The same request, answered as the API answers it: a redirect is not followed, so a route
    /// that relays the API's page passes it on (an OAuth authorize, which sends the browser on).
    pub fn request_unfollowed(&self, method: Method, path: &str, context: &str) -> RequestBuilder {
        self.prepare(&self.platform.direct, method, path, context)
    }

    fn prepare(&self, http: &reqwest::Client, method: Method, path: &str, context: &str) -> RequestBuilder {
        let mut req = http
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

    /// A `GET`'s JSON answer.
    pub async fn read<T: DeserializeOwned>(&self, path: &str, context: &str) -> Result<T, ApiError> {
        let res = self.request(Method::GET, path, context).send().await?;
        Ok(check(res).await?.json().await?)
    }

    /// A `GET`'s JSON answer and its headers: what the API says about the answer itself (how long
    /// a cache may keep it, say).
    pub async fn read_with_headers<T: DeserializeOwned>(&self, path: &str, context: &str) -> Result<(T, HeaderMap), ApiError> {
        let res = check(self.request(Method::GET, path, context).send().await?).await?;
        let headers = res.headers().clone();
        Ok((res.json().await?, headers))
    }

    /// A write's JSON answer and the receipt the next read waits for.
    pub async fn write<T: DeserializeOwned>(&self, req: RequestBuilder) -> Result<(T, Option<Receipt>), ApiError> {
        let res = check(req.send().await?).await?;
        let receipt = Receipt::from_response(res.headers());
        Ok((res.json().await?, receipt))
    }

    /// Who the cookies belong to.
    pub async fn identify(&self) -> Identity {
        match self.read::<SessionBody>("/api/auth/session", "auth").await {
            Ok(SessionBody { actor: Some(actor) }) => Identity::Actor(actor),
            Ok(SessionBody { actor: None }) => Identity::SignedOut,
            Err(error) if error.status().is_some_and(|s| s.is_client_error()) => Identity::SignedOut,
            Err(error) => {
                tracing::warn!("session lookup failed: {error}");
                Identity::Unknown
            }
        }
    }
}

/// Who a session belongs to.
pub enum Identity {
    Actor(Actor),
    /// No session, or one that ended.
    SignedOut,
    /// The API could not say. Not "signed out": sending the user to sign in again would loop
    /// while the API is down.
    Unknown,
}

#[derive(Deserialize)]
struct SessionBody {
    actor: Option<Actor>,
}

/// The signed-in user and the account they act for, from `GET /api/auth/session`
/// (`ResolvedActor` in contracts/auth-context), the fields the apps read.
#[derive(Clone, Debug, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub user_id: String,
    pub account_id: String,
    pub role_key: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Whether an agent acts through an OAuth grant (`agentGrant`): Auth's email-verification
    /// rule never asks an agent to verify.
    #[serde(default, rename = "agentGrant", deserialize_with = "present")]
    pub agent: bool,
}

/// Whether a field is there and not null, whatever it holds.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<serde::de::IgnoredAny>::deserialize(d)?.is_some())
}

impl Actor {
    pub fn can(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

/// What `encodeURIComponent` leaves as it is: the web hosts' encoding for path segments and the
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
pub fn segment(text: &str) -> String {
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

    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Status { code, .. } => code.as_deref(),
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

/// The envelope's `error`: `{ code, message }`. A body that is not the envelope has no code and no
/// message, so the screen says its own words.
#[derive(Deserialize)]
struct ErrorDetail {
    code: Option<String>,
    #[serde(default)]
    message: String,
}

#[cfg(test)]
mod error_body_tests {
    use super::ErrorBody;

    #[test]
    fn an_error_is_the_envelope_and_nothing_else() {
        let parts = |text: &str| serde_json::from_str::<ErrorBody>(text).ok().map(|b| (b.error.code, b.error.message));
        assert_eq!(
            parts(r#"{"error":{"code":"reason_required","message":"Give a reason."}}"#),
            Some((Some("reason_required".to_owned()), "Give a reason.".to_owned()))
        );
        assert_eq!(parts(r#"{"error":"Bulk rejection requires a reason."}"#), None);
        assert_eq!(parts(r#"{"message":"no error key"}"#), None);
    }
}
