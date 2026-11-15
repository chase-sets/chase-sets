//! Provider detail's Operator session (admin-web's `OperatorSessionPanel`, offered where the
//! provider's health surface says so: a platform admin on TCGplayer): the extension grant's
//! status, Pair extension and Disconnect. Each write first asks the surface whether it is offered.
//! Catalog's
//! `/api/catalog/operator-session` routes decide everything: who may (`catalog.manage` and the
//! platform-admin role), a sign-in within ten minutes, and that a write comes from the page's own
//! origin. So each write carries the browser's `Origin` and `Sec-Fetch-Site`, as admin-web's
//! same-origin `fetch` does, and the API compares them with the forwarded host.
//!
//! Pair answers with a grant shown once: the API keeps only its hash. So the pilot answers that
//! POST itself with the page and `Cache-Control: no-store` (the route's `no_store`), never a
//! redirect to an address that would carry it. Both forms post to the provider's own page, each
//! naming its write (`intent`), so the answer is drawn at an address that answers a `GET`, as marketplace's security page answers a key's
//! secret. The grant is not part of the page's screen data. With JavaScript the page first hands
//! it to the operator extension (`views/operator_session.js`) and shows it only when the
//! extension does not confirm; without it the grant is shown at once. Disconnect is a form whose
//! box confirms it, as the page's lifecycle commands are, answered with the page saying what came
//! of it.
//!
//! | Route | Answers |
//! |---|---|
//! | `POST /catalog/providers/{key}?<context>`, `intent=pair` | mints a grant and draws the page with it |
//! | `POST /catalog/providers/{key}?<context>`, `intent=disconnect` | revokes every active grant and draws the page with the outcome |
use corten::{
    http::{HeaderMap, StatusCode, Uri, header},
    prelude::*,
};
use serde::{Deserialize, Serialize};

use super::{daily, provider};
use crate::{
    api::{Caller, Method},
    app::Shared,
    auth::{CatalogAccess, Staff},
};

/// The API's operator-session routes, under its Catalog mount.
const PATH: &str = "/api/catalog/operator-session";
const CATALOG: &str = "catalog";

/// The extension grant's status (`GET /api/catalog/operator-session`, `OperatorSessionMetadata`).
/// The stored-at and browser-expiry instants are read but never drawn, as on admin-web.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub revision: u64,
    pub custody_available: bool,
    pub grant: Option<GrantMetadata>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct GrantMetadata {
    pub active: bool,
    pub created_at: String,
    pub idle_expires_at: String,
    pub last_used_at: String,
}

/// What the page draws for the panel: the status, or none when it could not be read.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
pub struct Operator {
    pub metadata: Option<Metadata>,
}

/// A grant Pair minted, shown once (`POST /grant`'s answer).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Minted {
    pub grant: String,
    pub idle_expires_at: String,
}

impl Minted {
    /// The grant as Catalog mints it: 32 random bytes in base64url, 43 characters. Anything else is
    /// not drawn.
    fn valid(&self) -> bool {
        self.grant.len() == 43 && self.grant.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}

/// Why a write did not do what was asked (admin-web's `OperatorSessionFailure`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    StepUpRequired,
    Unauthenticated,
    Forbidden,
    RateLimited,
    CustodyUnavailable,
    RevisionExhausted,
    Unknown,
}

impl Failure {
    /// admin-web's `classifyFailure`: step-up is the slice's flat `400 {code:"step_up_required"}`.
    fn of(status: StatusCode, code: Option<&str>) -> Failure {
        match (status.as_u16(), code) {
            (400, Some("step_up_required")) => Failure::StepUpRequired,
            (401, _) => Failure::Unauthenticated,
            (403, _) => Failure::Forbidden,
            (429, _) => Failure::RateLimited,
            (503, Some("custody-unavailable")) => Failure::CustodyUnavailable,
            (503, Some("revision-exhausted")) => Failure::RevisionExhausted,
            _ => Failure::Unknown,
        }
    }

    /// Refused before Disconnect ran (admin-web's `refusedBeforeDisconnect`). Any other failure may
    /// follow a revocation that was committed, so it never says nothing happened.
    fn before_disconnect(self) -> bool {
        matches!(self, Failure::StepUpRequired | Failure::Unauthenticated | Failure::Forbidden | Failure::RateLimited)
    }

    /// Whether the page offers to sign in again.
    pub fn signs_in(self) -> bool {
        matches!(self, Failure::StepUpRequired | Failure::Unauthenticated)
    }
}

/// What Disconnect came to (`DELETE`'s 200 `cleared` or `unchanged`, or 409 `stale-revision`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disconnected {
    Cleared,
    Unchanged,
    StaleRevision,
}

/// What the panel says after a write. Only Pair's answer carries the grant.
pub enum Answer {
    Grant(Minted),
    Failed(Failure),
    DisconnectIncomplete(Failure),
    Disconnected(Disconnected, u64),
}

/// A request to the operator-session routes, with the browser's `Origin` and `Sec-Fetch-Site`.
fn request(caller: &Caller<'_>, headers: &HeaderMap, method: Method, rest: &str) -> reqwest::RequestBuilder {
    let mut req = caller.request(method, &format!("{PATH}{rest}"), CATALOG).header(header::ACCEPT, "application/json");
    for name in [header::ORIGIN.as_str(), "sec-fetch-site"] {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            req = req.header(name, value);
        }
    }
    req
}

/// A response's status and JSON body; none when the API could not be reached.
async fn send(req: reqwest::RequestBuilder) -> Option<(StatusCode, serde_json::Value)> {
    let res = req.send().await.ok()?;
    let status = StatusCode::from_u16(res.status().as_u16()).ok()?;
    let body = res.json().await.unwrap_or(serde_json::Value::Null);
    Some((status, body))
}

fn failure(answer: Option<&(StatusCode, serde_json::Value)>) -> Failure {
    match answer {
        Some((status, body)) => Failure::of(*status, body.get("code").and_then(serde_json::Value::as_str)),
        None => Failure::Unknown,
    }
}

/// The grant's status, or none when it could not be read (the panel then says so).
pub async fn metadata(config: &Shared, headers: &HeaderMap) -> Option<Metadata> {
    let caller = config.platform.caller(headers, config.proto, None);
    match send(request(&caller, headers, Method::GET, "")).await? {
        (StatusCode::OK, body) => serde_json::from_value(body).ok(),
        _ => None,
    }
}

/// Mints a grant: the grant, or why not.
async fn mint(config: &Shared, headers: &HeaderMap) -> Answer {
    let caller = config.platform.caller(headers, config.proto, None);
    let answer = send(request(&caller, headers, Method::POST, "/grant")).await;
    if let Some((StatusCode::OK, body)) = &answer {
        return match serde_json::from_value::<Minted>(body.clone()) {
            Ok(minted) if minted.valid() => Answer::Grant(minted),
            _ => Answer::Failed(Failure::Unknown),
        };
    }
    Answer::Failed(failure(answer.as_ref()))
}

/// Revokes every active grant: its outcome and revision, or why it did not finish.
async fn revoke(config: &Shared, headers: &HeaderMap) -> Answer {
    #[derive(Deserialize)]
    struct Outcome {
        outcome: String,
        revision: u64,
    }
    let caller = config.platform.caller(headers, config.proto, None);
    let answer = send(request(&caller, headers, Method::DELETE, "")).await;
    let outcome = |body: &serde_json::Value| serde_json::from_value::<Outcome>(body.clone()).ok();
    let done = match &answer {
        Some((StatusCode::OK, body)) => outcome(body).and_then(|o| match o.outcome.as_str() {
            "cleared" => Some((Disconnected::Cleared, o.revision)),
            "unchanged" => Some((Disconnected::Unchanged, o.revision)),
            _ => None,
        }),
        Some((StatusCode::CONFLICT, body)) => {
            outcome(body).filter(|o| o.outcome == "stale-revision").map(|o| (Disconnected::StaleRevision, o.revision))
        }
        _ => None,
    };
    match done {
        Some((outcome, revision)) => Answer::Disconnected(outcome, revision),
        None => match failure(answer.as_ref()) {
            failure if failure.before_disconnect() => Answer::Failed(failure),
            failure => Answer::DisconnectIncomplete(failure),
        },
    }
}

/// The panel's forms: the write each names (`intent`), and the box Disconnect's form carries.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct OperatorInput {
    pub intent: String,
    pub confirmed: String,
}

impl OperatorInput {
    pub const PAIR: &'static str = "pair";
    pub const DISCONNECT: &'static str = "disconnect";
    pub const CONFIRMED: &'static str = "disconnect";
}

/// The page's answer to a write: the page, with what came of it in the panel.
async fn drawn(
    req: &Req,
    staff: &Staff<CatalogAccess>,
    config: &Shared,
    headers: &HeaderMap,
    key: &str,
    uri: &Uri,
    answer: Answer,
) -> HtmlResult {
    let context = daily::context_of(uri);
    let status = match &answer {
        Answer::Grant(_) => StatusCode::OK,
        Answer::Disconnected(Disconnected::StaleRevision, _) => StatusCode::CONFLICT,
        Answer::Disconnected(..) => StatusCode::OK,
        Answer::Failed(_) | Answer::DisconnectIncomplete(_) => StatusCode::UNPROCESSABLE_ENTITY,
    };
    provider::drawn_with(req, staff, config, headers, key, &context, &answer, status).await
}

/// Pair extension or Disconnect, by the write the form names. Each first asks the surface whether
/// the panel is offered; Disconnect runs only once its box is checked.
pub(crate) async fn write(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<provider::url::Provider<'_>>,
    Form(input): Form<OperatorInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let refused = |errors| provider::again(&req, &staff, &config, &headers, &route.key, &context, errors);
    if !provider::offers_operator_session(&config, &headers, &route.key, &context).await {
        return refused(super::not_offered(req.t())).await;
    }
    let answer = match input.intent.as_str() {
        OperatorInput::PAIR => mint(&config, &headers).await,
        OperatorInput::DISCONNECT if input.confirmed == OperatorInput::CONFIRMED => revoke(&config, &headers).await,
        OperatorInput::DISCONNECT => {
            let t: crate::text::Cat = req.t();
            let mut errors = Errors::new();
            errors.add_form(t.feedback_confirmation_required());
            return refused(errors).await;
        }
        _ => return refused(super::not_offered(req.t())).await,
    };
    drawn(&req, &staff, &config, &headers, &route.key, &uri, answer).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_reads_as_admin_web_classifies_it() {
        assert_eq!(Failure::of(StatusCode::BAD_REQUEST, Some("step_up_required")), Failure::StepUpRequired);
        assert_eq!(Failure::of(StatusCode::BAD_REQUEST, Some("invalid")), Failure::Unknown, "only the slice's step-up code");
        assert_eq!(Failure::of(StatusCode::UNAUTHORIZED, None), Failure::Unauthenticated);
        assert_eq!(Failure::of(StatusCode::FORBIDDEN, Some("forbidden")), Failure::Forbidden);
        assert_eq!(Failure::of(StatusCode::TOO_MANY_REQUESTS, None), Failure::RateLimited);
        assert_eq!(Failure::of(StatusCode::SERVICE_UNAVAILABLE, Some("custody-unavailable")), Failure::CustodyUnavailable);
        assert_eq!(Failure::of(StatusCode::SERVICE_UNAVAILABLE, Some("revision-exhausted")), Failure::RevisionExhausted);
        assert_eq!(Failure::of(StatusCode::SERVICE_UNAVAILABLE, None), Failure::Unknown);
    }

    #[test]
    fn only_a_refusal_before_it_ran_says_disconnect_did_nothing() {
        assert!(Failure::StepUpRequired.before_disconnect() && Failure::RateLimited.before_disconnect());
        assert!(!Failure::CustodyUnavailable.before_disconnect() && !Failure::Unknown.before_disconnect());
    }

    #[test]
    fn a_grant_is_drawn_only_in_the_shape_catalog_mints() {
        let minted = |grant: &str| Minted { grant: grant.into(), idle_expires_at: "2026-12-05T00:00:00.000Z".into() };
        assert!(minted(&"A".repeat(43)).valid());
        assert!(minted("abcdefghijklmnopqrstuvwxyzABCDEFGHIJK-_0123").valid());
        assert!(!minted(&"A".repeat(42)).valid());
        assert!(!minted(&format!("{}<", "A".repeat(42))).valid());
    }
}
