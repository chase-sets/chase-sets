//! Signing in through Auth's API, as both web hosts' auth host does
//! (bounded-contexts/auth/support/route-support/auth-host.ts): the ways to sign in, the API's
//! answers, the calls (each forwarding the browser's address), what a refusal means, and the
//! cookies a sign-in or a sign-out leaves. Each app draws its own pages and says the refusals in
//! its own words.
//!
//! Every call forwards the browser's address (`X-Forwarded-For`), as the hosts' forwarded Auth
//! transport does: the API limits failed sign-ins by that address, and without it every browser
//! would share the web host's
//! ([chase-sets/chase-sets#10686](https://github.com/chase-sets/chase-sets/issues/10686)).
use std::time::{Duration, SystemTime};

use corten::{
    ClientIp, Local,
    axum::http::{HeaderMap, StatusCode},
    i18n::parse_timestamp,
    security::cookie::{self, SetCookie},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    api::{ApiError, Caller, Method as Http},
    receipt::Receipt,
    session::SESSION_COOKIE,
};

/// The account selection a sign-in that may act for more than one account waits on.
pub const SELECTION_COOKIE: &str = "chase_sets_account_selection";
/// A guest checkout's session, which signing out ends.
pub const GUEST_CHECKOUT_COOKIE: &str = "chase_sets_guest_checkout";
/// The hosts retry a password sign-in the API never received, after these waits.
const RETRIES: [Duration; 2] = [Duration::from_millis(100), Duration::from_millis(250)];
const AUTH: &str = "auth";

/// A way to sign in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Password,
    PhoneCode,
    MagicLink,
    Passkey,
}

impl Method {
    pub const ALL: [Method; 4] = [Method::Password, Method::PhoneCode, Method::MagicLink, Method::Passkey];

    pub fn key(self) -> &'static str {
        match self {
            Method::Password => "password",
            Method::PhoneCode => "phone-code",
            Method::MagicLink => "magic-link",
            Method::Passkey => "passkey",
        }
    }

    fn parse(key: &str) -> Option<Method> {
        Method::ALL.into_iter().find(|m| m.key() == key)
    }

    /// The method a sign-in form was for (`withSignInAttempt`).
    pub fn of_intent(intent: &str) -> Method {
        match intent {
            "phone-code-request" | "phone-code-consume" => Method::PhoneCode,
            "magic-link-request" | "magic-link-consume" => Method::MagicLink,
            "passkey-sign-in" => Method::Passkey,
            _ => Method::Password,
        }
    }
}

/// What the identifier is: the hosts read anything with an `@` as an email.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Email,
    Phone,
}

impl Kind {
    pub fn of(identifier: &str) -> Kind {
        if identifier.contains('@') { Kind::Email } else { Kind::Phone }
    }

    /// The methods the identifier offers, in the sign-in page's order (`EMAIL_METHOD_PRIORITY`).
    pub fn methods(self) -> &'static [Method] {
        match self {
            Kind::Email => &[Method::Passkey, Method::MagicLink, Method::Password],
            Kind::Phone => &[Method::PhoneCode],
        }
    }

    /// The method shown: the one asked for when the identifier offers it, else its first.
    pub fn shown(self, asked: Option<&str>) -> Method {
        let methods = self.methods();
        asked.and_then(Method::parse).filter(|m| methods.contains(m)).unwrap_or(methods[0])
    }
}

/// Auth's `getSafeReturnTo`: a path on this site (`Local`), else `fallback`. `/\host`, which a
/// browser reads as `//host`, another site, is refused, as Auth refuses it since
/// [chase-sets/chase-sets#10687](https://github.com/chase-sets/chase-sets/issues/10687); so are a
/// control character and a `.` or `..` segment.
pub fn safe_return_to(value: Option<&str>, fallback: &str) -> String {
    value.and_then(Local::parse).map_or_else(|| fallback.to_owned(), |path| path.to_string())
}

/// A sign-in the API answered: a session, or a choice of account first (`InteractiveAuthResult`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Authenticated {
    #[serde(rename_all = "camelCase")]
    SessionStarted { session_token: String, session: SessionRow },
    #[serde(rename_all = "camelCase")]
    AccountSelectionRequired { selection_token: String, selection_expires_at: String },
}

#[derive(Debug, Deserialize)]
pub struct SessionRow {
    pub expires_at: String,
}

impl Authenticated {
    /// The cookie the browser keeps: the session's, or the selection's until the account is
    /// chosen, each for as long as the API says it lasts. `None` for a token a cookie cannot carry,
    /// which is the API's mistake.
    pub fn cookie(&self) -> Option<SetCookie> {
        let (name, token, expires_at) = match self {
            Authenticated::SessionStarted { session_token, session } => (SESSION_COOKIE, session_token, &session.expires_at),
            Authenticated::AccountSelectionRequired { selection_token, selection_expires_at } => {
                (SELECTION_COOKIE, selection_token, selection_expires_at)
            }
        };
        SetCookie::try_new(name, token).ok().map(|c| c.max_age(seconds_until(expires_at)))
    }
}

/// A code request's answer: its id, which the code's form sends back.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCodeSent {
    pub token_id: String,
}

/// An account the user may act for.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub account_id: String,
    pub account_name: String,
    pub role_label: String,
}

#[derive(Debug, Deserialize)]
struct Memberships {
    #[serde(default)]
    memberships: Vec<Membership>,
}

/// An auth call: the browser's cookies and host, as every call sends them, and its address.
pub async fn call<T: DeserializeOwned>(
    caller: &Caller<'_>,
    client: Option<ClientIp>,
    path: &str,
    body: Value,
) -> Result<T, ApiError> {
    call_written(caller, client, path, body).await.map(|(answer, _)| answer)
}

/// An auth call that writes, and the receipt the next read waits for (a new identity's).
pub async fn call_written<T: DeserializeOwned>(
    caller: &Caller<'_>,
    client: Option<ClientIp>,
    path: &str,
    body: Value,
) -> Result<(T, Option<Receipt>), ApiError> {
    let mut req = caller.request(Http::POST, path, AUTH).json(&body);
    if let Some(ClientIp(ip)) = client {
        req = req.header("x-forwarded-for", ip.to_string());
    }
    caller.write::<T>(req).await
}

/// A password sign-in, sent again after a short wait when the API never received it
/// (`retryTransientPasswordSignIn`).
pub async fn password(
    caller: &Caller<'_>,
    client: Option<ClientIp>,
    email: &str,
    password: &str,
) -> Result<Authenticated, ApiError> {
    let body = json!({ "email": email, "password": password });
    let mut waits = RETRIES.iter();
    loop {
        match call::<Authenticated>(caller, client, "/api/auth/password-sign-in", body.clone()).await {
            Err(ApiError::Transport(error)) if error.is_connect() => match waits.next() {
                Some(wait) => tokio::time::sleep(*wait).await,
                None => break Err(ApiError::Transport(error)),
            },
            answer => break answer,
        }
    }
}

/// The accounts a selection's token may choose from; a 401 when the choice ended.
pub async fn memberships(caller: &Caller<'_>, client: Option<ClientIp>, token: &str) -> Result<Vec<Membership>, ApiError> {
    let found: Memberships =
        call(caller, client, "/api/auth/account-selection/resolve", json!({ "selectionToken": token })).await?;
    Ok(found.memberships)
}

/// The selection's token: none without the cookie.
pub fn selection_token(headers: &HeaderMap) -> Option<&str> {
    cookie::get(headers, SELECTION_COOKIE).filter(|token| !token.is_empty())
}

/// What a refusal means for the page (`authApiActionError`), which each app says in its words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No answer from the API: sign-in is unavailable for now (503).
    Unavailable,
    InvalidEmailOrPassword,
    InvalidPhoneCode,
    InvalidSelection,
    InvitationRequired,
    DisposableEmail,
    ConsentUnavailable,
    /// Too many attempts (429).
    RateLimited,
    /// Any other refusal: the request failed.
    Failed,
}

impl Refusal {
    /// The refusal of a form (`intent`) the API answered with `error`.
    pub fn of(intent: &str, error: &ApiError) -> Refusal {
        let Some(status) = error.status() else {
            tracing::warn!("a sign-in call failed: {error}");
            return Refusal::Unavailable;
        };
        let code = error.code();
        match status.as_u16() {
            401 if code.is_none_or(|c| c == "authentication_required") => match intent {
                "password" => Refusal::InvalidEmailOrPassword,
                "phone-code-consume" => Refusal::InvalidPhoneCode,
                "account-selection" => Refusal::InvalidSelection,
                _ => Refusal::Failed,
            },
            403 if code == Some("registration_admission_required") => Refusal::InvitationRequired,
            403 if code == Some("disposable_email_domain") => Refusal::DisposableEmail,
            400 if matches!(
                code,
                Some(
                    "registration_consent_not_server_minted"
                        | "registration_consent_expired"
                        | "registration_consent_affirmation_required"
                )
            ) && matches!(intent, "password" | "phone-code-consume") =>
            {
                Refusal::ConsentUnavailable
            }
            429 if code.is_none_or(|c| c == "rate_limited") => Refusal::RateLimited,
            _ => {
                tracing::warn!("a sign-in was refused: {error}");
                Refusal::Failed
            }
        }
    }

    /// The page's status.
    pub fn status(self) -> StatusCode {
        match self {
            Refusal::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Refusal::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        }
    }
}

/// Signing out (`signOutActorViaAuthApi`): the guest checkout ended when there is one and the
/// session ended, each only logged when the API could not be reached; then the cookies to clear,
/// which the browser loses either way.
pub async fn sign_out(caller: &Caller<'_>, client: Option<ClientIp>, headers: &HeaderMap) -> [&'static str; 3] {
    if cookie::get(headers, GUEST_CHECKOUT_COOKIE).is_some()
        && let Err(error) = call::<Value>(caller, client, "/api/auth/guest-checkout/exit", json!({})).await
    {
        tracing::warn!("a guest checkout could not be ended: {error}");
    }
    if let Err(error) = call::<Value>(caller, client, "/api/auth/sign-out", json!({})).await {
        tracing::warn!("a session could not be ended: {error}");
    }
    [SELECTION_COOKIE, SESSION_COOKIE, GUEST_CHECKOUT_COOKIE]
}

/// Seconds until `expires_at`, none past it (`maxAgeSecondsFromExpiry`).
pub fn seconds_until(expires_at: &str) -> i64 {
    let Some(at) = parse_timestamp(expires_at) else { return 0 };
    at.duration_since(SystemTime::now()).map_or(0, |left| left.as_secs_f64().ceil() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_return_address_is_a_path_on_this_site() {
        assert_eq!(safe_return_to(Some("/account/cart?x=1"), "/account"), "/account/cart?x=1");
        assert_eq!(safe_return_to(None, "/account"), "/account");
        assert_eq!(safe_return_to(Some("https://example.com/"), "/account"), "/account");
        assert_eq!(safe_return_to(Some("//example.com/"), "/account"), "/account");
        assert_eq!(safe_return_to(Some("/\\example.com/"), "/account"), "/account", "a browser reads it as //example.com");
        assert_eq!(safe_return_to(Some("/a\nb"), "/account"), "/account");
    }

    #[test]
    fn an_email_offers_a_password_and_a_phone_a_code() {
        assert_eq!(Kind::of("collector@chasesets.test"), Kind::Email);
        assert_eq!(Kind::of("+1 555 0100"), Kind::Phone);
        assert_eq!(Kind::Email.shown(Some("password")), Method::Password);
        assert_eq!(Kind::Email.shown(None), Method::Passkey, "the page's first, as it shows with JavaScript");
        assert_eq!(Kind::Phone.shown(Some("password")), Method::PhoneCode, "a phone has no password");
        assert_eq!(Kind::Email.shown(Some("phone-code")), Method::Passkey);
        assert_eq!(Method::of_intent("magic-link-request"), Method::MagicLink);
        assert_eq!(Method::of_intent("anything"), Method::Password);
    }

    #[test]
    fn the_api_answers_a_session_or_a_choice() {
        let started: Authenticated = serde_json::from_value(json!({
            "type": "session-started", "userId": "usr_1", "sessionId": "ses_1", "sessionToken": "tok",
            "session": { "expires_at": "2099-01-01T00:00:00.000Z" }, "memberships": [],
        }))
        .unwrap();
        assert!(matches!(started, Authenticated::SessionStarted { ref session_token, .. } if session_token == "tok"));
        assert!(started.cookie().is_some());
        let choice: Authenticated = serde_json::from_value(json!({
            "type": "account-selection-required", "userId": "usr_1", "selectionToken": "sel",
            "selectionExpiresAt": "2099-01-01T00:00:00.000Z", "memberships": [],
        }))
        .unwrap();
        assert!(
            matches!(choice, Authenticated::AccountSelectionRequired { ref selection_token, .. } if selection_token == "sel")
        );
        assert!(seconds_until("2099-01-01T00:00:00.000Z") > 0);
        assert_eq!(seconds_until("2000-01-01T00:00:00.000Z"), 0);
        let garbled = Authenticated::SessionStarted {
            session_token: "tok;Path=/evil".into(),
            session: SessionRow { expires_at: "2099-01-01T00:00:00.000Z".into() },
        };
        assert!(garbled.cookie().is_none(), "a token a cookie cannot carry");
    }

    #[test]
    fn a_refusal_is_named_by_its_form() {
        let refused = |status: u16, code: Option<&str>| ApiError::Status {
            status: StatusCode::from_u16(status).unwrap(),
            code: code.map(str::to_owned),
            message: String::new(),
        };
        assert_eq!(Refusal::of("password", &refused(401, None)), Refusal::InvalidEmailOrPassword);
        assert_eq!(Refusal::of("phone-code-consume", &refused(401, Some("authentication_required"))), Refusal::InvalidPhoneCode);
        assert_eq!(Refusal::of("magic-link-request", &refused(401, None)), Refusal::Failed);
        assert_eq!(Refusal::of("password", &refused(429, None)).status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(Refusal::of("password", &refused(500, Some("internal"))), Refusal::Failed);
    }
}
