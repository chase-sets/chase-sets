//! Accepting an invitation to an account: marketplace's `invite/:invitationId` route (Auth's
//! `InvitationAcceptancePage` and the route's action).
//!
//! The invitation's email links here with its `token`; the page asks the API what the invitation
//! is (`POST /api/auth/invitations/inspect`). A pending one offers a passkey or a password, each at
//! its own address (`credentialMethod`), as marketplace's segmented control does. A passkey needs
//! the browser's WebAuthn, so it is a link to marketplace's page, as on sign-in.
//!
//! An acceptance is one attempt: the form's `SubmitKey`, sent as `attemptId` and
//! `Idempotency-Key` (`POST /api/auth/invitations/accept`). The API applies an attempt once, so
//! the same form sent again is the same acceptance. What its answer means, as the route's action
//! reads it:
//!
//! | Answer | Then |
//! |---|---|
//! | a session, or account selection | signed in, to the account's page read after the write |
//! | `accepted-reauth-required`, `confirming`, `ambiguous` | the attempt's state, with Sign in and Check status |
//! | 409 `invitation_attempt_conflict` | conflict |
//! | 403 | route denied |
//! | any other 4xx | the form again, saying nothing was accepted (failed safe) |
//! | a 5xx, `invitation_attempt_ambiguous`, or no answer | the attempt's status (`POST /api/auth/invitations/acceptance-status`); ambiguous when that fails too |
//!
//! Check status asks for the same attempt's state again. Marketplace keeps the attempt in the
//! tab's history state so a reload shows its state; here the attempt is in the form the status
//! page draws, and a reload of the page itself shows the invitation as the API has it.
use crate::recovery::attempt_text;
use corten::{
    ClientIp,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api::{ApiError, Caller, Method as Http},
    app::{Shared, read_failed, url},
    recovery::valid_attempt,
    register::landing,
    sign_in::{Authenticated, DEFAULT_SUCCESS, complete},
    text::SignInMsg,
    views::{self, Layout},
};

const AUTH: &str = "auth";

/// The page's address: the invitation's token, as the email writes it, and the method shown.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Invited {
    pub token: Option<String>,
    pub credential_method: Option<String>,
}

impl Invited {
    pub fn token(&self) -> &str {
        self.token.as_deref().unwrap_or_default()
    }

    /// The same address with `method` shown.
    pub fn with_method(&self, method: Method) -> Self {
        Invited { credential_method: Some(method.key().into()), ..self.clone() }
    }
}

/// A way to accept, in marketplace's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Passkey,
    Password,
}

impl Method {
    pub const ALL: [Method; 2] = [Method::Passkey, Method::Password];

    pub fn key(self) -> &'static str {
        match self {
            Method::Passkey => "passkey",
            Method::Password => "password",
        }
    }

    pub fn label(self, t: SignInMsg) -> &'static str {
        match self {
            Method::Passkey => t.invite_passkey(),
            Method::Password => t.invite_password(),
        }
    }

    /// The method asked for, else marketplace's first.
    pub fn shown(asked: Option<&str>) -> Method {
        if asked == Some("password") { Method::Password } else { Method::Passkey }
    }
}

/// What the API says the invitation is (`InvitationAcceptancePresentation`). A status the page
/// does not know is unavailable.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Invitation {
    #[serde(rename_all = "camelCase")]
    Pending {
        invitation_id: String,
        email: String,
        account_name: String,
        invited_by_name: String,
        role_label: String,
    },
    Expired,
    Revoked,
    Accepted,
    #[serde(other)]
    Unavailable,
}

/// The acceptance form's fields: the attempt (`SubmitKey`), and the password.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct AcceptForm {
    pub intent: String,
    pub attempt: Option<SubmitKey>,
    pub password: String,
}

/// Where an attempt stands, once its answer is not a session (the action's `state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Confirming,
    AcceptedReauthRequired,
    Conflict,
    Ambiguous,
    RouteDenied,
}

impl Phase {
    fn of(kind: &str) -> Phase {
        match kind {
            "confirming" => Phase::Confirming,
            "accepted-reauth-required" => Phase::AcceptedReauthRequired,
            _ => Phase::Ambiguous,
        }
    }

    pub fn title(self, t: SignInMsg) -> &'static str {
        match self {
            Phase::Confirming => t.invite_attempt_confirming(),
            Phase::AcceptedReauthRequired => t.invite_attempt_accepted_reauth_required(),
            Phase::Conflict => t.invite_attempt_conflict(),
            Phase::Ambiguous => t.invite_attempt_ambiguous(),
            Phase::RouteDenied => t.invite_attempt_route_denied(),
        }
    }

    pub fn accepted(self) -> bool {
        self == Phase::AcceptedReauthRequired
    }
}

/// The page's view model.
pub struct InviteScreen {
    pub id: String,
    pub invited: Invited,
    pub invitation: Invitation,
    pub method: Method,
    /// The attempt's state and id, once it has one that is not the form's.
    pub phase: Option<(Phase, String)>,
    /// The form again after an acceptance the API refused without applying it.
    pub failed_safe: bool,
}

#[derive(Debug, Deserialize)]
struct AttemptState {
    #[serde(rename = "type")]
    kind: String,
}

/// An invitation call with the attempt as its `Idempotency-Key`, and the browser's address.
async fn post<T: serde::de::DeserializeOwned>(
    caller: &Caller<'_>,
    client: Option<ClientIp>,
    path: &str,
    attempt: Option<&str>,
    body: Value,
) -> Result<(T, Option<Receipt>), ApiError> {
    let mut req = caller.request(Http::POST, path, AUTH).json(&body);
    if let Some(attempt) = attempt {
        req = req.header("idempotency-key", attempt);
    }
    if let Some(ClientIp(ip)) = client {
        req = req.header("x-forwarded-for", ip.to_string());
    }
    caller.write::<T>(req).await
}

async fn inspect(caller: &Caller<'_>, client: Option<ClientIp>, id: &str, token: &str) -> Result<Invitation, ApiError> {
    let body = json!({ "invitationId": id, "token": token });
    post::<Invitation>(caller, client, "/api/auth/invitations/inspect", None, body).await.map(|(i, _)| i)
}

/// The attempt's state as the API has it; ambiguous when it cannot say.
async fn status(caller: &Caller<'_>, client: Option<ClientIp>, id: &str, token: &str, attempt: &str) -> Phase {
    let body = json!({ "invitationId": id, "token": token, "attemptId": attempt });
    match post::<AttemptState>(caller, client, "/api/auth/invitations/acceptance-status", Some(attempt), body).await {
        Ok((state, _)) => Phase::of(&state.kind),
        Err(error) => {
            tracing::warn!("an invitation attempt's status could not be read: {error}");
            Phase::Ambiguous
        }
    }
}

/// What an acceptance's answer means (the route's action).
pub enum Accepted {
    Signed(Authenticated, Option<Receipt>),
    Phase(Phase),
    FailedSafe,
}

/// The answer to an acceptance, or the attempt's status when the answer does not settle it.
pub fn read_answer(answer: Result<(Value, Option<Receipt>), ApiError>) -> Result<Accepted, ()> {
    match answer {
        Ok((body, receipt)) => match body["type"].as_str() {
            Some("session-started" | "account-selection-required") => {
                serde_json::from_value(body).map(|signed| Accepted::Signed(signed, receipt)).map_err(|_| ())
            }
            Some(kind) => Ok(Accepted::Phase(Phase::of(kind))),
            None => Err(()),
        },
        Err(error) => match (error.status(), error.code()) {
            (_, Some("invitation_attempt_ambiguous")) => Err(()),
            (Some(status), code) if status.is_client_error() => Ok(match code {
                Some("invitation_attempt_conflict") => Accepted::Phase(Phase::Conflict),
                _ if status == StatusCode::FORBIDDEN => Accepted::Phase(Phase::RouteDenied),
                _ => Accepted::FailedSafe,
            }),
            _ => {
                tracing::warn!("an invitation acceptance's answer was lost: {error}");
                Err(())
            }
        },
    }
}

fn render(req: &Req, status: StatusCode, screen: &InviteScreen) -> HtmlResult {
    let t: SignInMsg = req.t();
    let page = html! {
        <Layout req={req} viewer={None} title={t.invite_title()} head={html! { <meta name="robots" content="noindex"> }}>
            <views::InvitePage t={t} screen={screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The invitation, as the API has it.
pub(crate) async fn page(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::Invite<'_>>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let invitation = match inspect(&caller, client, &route.id, route.invited.token()).await {
        Ok(invitation) => invitation,
        Err(error) => return read_failed(&req, None, error, None),
    };
    let screen = InviteScreen {
        id: route.id.clone(),
        method: Method::shown(route.invited.credential_method.as_deref()),
        invited: route.invited,
        invitation,
        phase: None,
        failed_safe: false,
    };
    render(&req, StatusCode::OK, &screen)
}

/// Accept, or check an attempt's status.
pub(crate) async fn write(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::Invite<'_>>,
    Form(form): Form<AcceptForm>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let (id, token) = (route.id.as_str(), route.invited.token());
    let mut screen = InviteScreen {
        id: id.to_owned(),
        method: Method::Password,
        invited: route.invited.clone(),
        invitation: Invitation::Unavailable,
        phase: None,
        failed_safe: false,
    };
    let attempt = attempt_text(&form.attempt).to_owned();
    if !valid_attempt(&attempt) {
        // No attempt the API could apply: nothing was sent.
        screen.invitation = inspect(&caller, client, id, token).await.unwrap_or(Invitation::Unavailable);
        screen.failed_safe = true;
        return render(&req, StatusCode::UNPROCESSABLE_ENTITY, &screen);
    }
    if form.intent == "status" {
        screen.phase = Some((status(&caller, client, id, token, &attempt).await, attempt));
        return render(&req, StatusCode::OK, &screen);
    }
    let body = json!({ "invitationId": id, "token": token, "attemptId": attempt, "password": form.password });
    let answer = post::<Value>(&caller, client, "/api/auth/invitations/accept", Some(&attempt), body).await;
    let phase = match read_answer(answer) {
        Ok(Accepted::Signed(result, receipt)) => {
            return complete(&req, &config, &landing(DEFAULT_SUCCESS, receipt.as_ref()), result);
        }
        Ok(Accepted::Phase(phase)) => phase,
        Ok(Accepted::FailedSafe) => {
            screen.invitation = inspect(&caller, client, id, token).await.unwrap_or(Invitation::Unavailable);
            screen.failed_safe = true;
            return render(&req, StatusCode::UNPROCESSABLE_ENTITY, &screen);
        }
        Err(()) => status(&caller, client, id, token, &attempt).await,
    };
    screen.phase = Some((phase, attempt));
    render(&req, StatusCode::OK, &screen)
}

/// Marketplace's page, for a passkey (WebAuthn is its page's script).
pub fn on_marketplace(id: &str, invited: &Invited) -> String {
    let address = url::Invite { id, invited: Invited { credential_method: None, ..invited.clone() } }.href();
    views::on_marketplace(&address)
}

#[cfg(test)]
mod tests {
    use corten::axum::http::StatusCode;

    use super::*;

    fn refused(status: u16, code: &str) -> Result<(Value, Option<Receipt>), ApiError> {
        Err(ApiError::Status {
            status: StatusCode::from_u16(status).unwrap(),
            code: Some(code.to_owned()),
            message: String::new(),
        })
    }

    fn phase(answer: Result<(Value, Option<Receipt>), ApiError>) -> Option<Phase> {
        match read_answer(answer) {
            Ok(Accepted::Phase(phase)) => Some(phase),
            _ => None,
        }
    }

    #[test]
    fn an_answer_is_read_as_the_routes_action_reads_it() {
        assert_eq!(phase(Ok((json!({ "type": "confirming", "attemptId": "a" }), None))), Some(Phase::Confirming));
        assert_eq!(phase(Ok((json!({ "type": "accepted-reauth-required" }), None))), Some(Phase::AcceptedReauthRequired));
        assert_eq!(phase(refused(409, "invitation_attempt_conflict")), Some(Phase::Conflict));
        assert_eq!(phase(refused(403, "forbidden")), Some(Phase::RouteDenied));
        assert!(matches!(read_answer(refused(400, "invitation_attempt_invalid")), Ok(Accepted::FailedSafe)));
        assert!(matches!(read_answer(refused(429, "rate_limited")), Ok(Accepted::FailedSafe)));
        // Not settled by the answer: the attempt's status is asked.
        assert!(read_answer(refused(503, "invitation_attempt_ambiguous")).is_err());
        assert!(read_answer(refused(409, "invitation_attempt_ambiguous")).is_err());
        assert!(read_answer(refused(500, "internal")).is_err());
        let started = json!({
            "type": "session-started", "sessionToken": "tok", "session": { "expires_at": "2099-01-01T00:00:00.000Z" },
        });
        assert!(matches!(read_answer(Ok((started, None))), Ok(Accepted::Signed(..))));
    }

    #[test]
    fn an_invitation_the_page_does_not_know_is_unavailable() {
        let read = |v: Value| serde_json::from_value::<Invitation>(v).unwrap();
        assert_eq!(read(json!({ "status": "expired" })), Invitation::Expired);
        assert_eq!(read(json!({ "status": "something-new" })), Invitation::Unavailable);
        assert!(matches!(
            read(json!({
                "status": "pending", "invitationId": "ivt_1", "email": "a@example.test", "accountName": "Shop",
                "invitedByName": "Ann", "roleLabel": "Viewer",
            })),
            Invitation::Pending { .. }
        ));
    }
}
