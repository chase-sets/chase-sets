//! The signed-in account's connected agents (Auth's marketplace `account-agents`,
//! `account-agents-detail` and `account-agents-consent` routes): the list with how to connect an
//! assistant, a grant's page and its four writes (Revoke access, the spending mandate, and saving or
//! disabling the webhook), and the consent an agent's OAuth authorize sends the user to. Every rule
//! is the API's (`/ucp/oauth`), which needs only an interactive session and keeps each grant to its
//! account, so every handler takes an `AgentHolder` (anyone signed in), as marketplace's routes do.
//!
//! Revoke access is an attempt (`Idempotency-Key`) whose receipt the page checks before believing
//! it, as marketplace's action does: an answer for another attempt, an unknown state, or a done one
//! without its last phase is "not confirmed". A revoke the page could not settle comes back to the
//! page with its attempt in the address (`?attempt=`), so Revoke access sends the same attempt
//! again, which marketplace keeps in `sessionStorage` instead.
//!
//! Saving a webhook answers with its signing secret, once: that POST answers the page itself, with
//! `Cache-Control: no-store`, as the security page answers a new API key.
//!
//! Approve and Deny post to the API's `/ucp/oauth/authorize`, which the ingress sends to the platform
//! API, and which answers with a redirect to the agent's own address. So the consent page's forms
//! may go to any HTTPS origin (`form-action`, its area's policy), and the page sends no more of its
//! address than its origin (`strict-origin`, a `<meta name="referrer">`: its address carries the
//! consent token; Corten replaces a header's policy, todd-skelton/corten#390). Locally there is no ingress, so the pilot relays `/ucp/oauth/authorize` to the API
//! with its redirects as they are (`authorize`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/agents` | the account's connected agents, and how to connect one |
//! | `GET /account/agents/{id}?<place>` | a grant, its spend, mandate, webhook and activity |
//! | `POST /account/agents/{id}/revoke` | revoke the grant, as an attempt |
//! | `POST /account/agents/{id}/mandate` | save its spending mandate |
//! | `POST /account/agents/{id}/webhook` | save its webhook's address, answered with the new secret |
//! | `POST /account/agents/{id}/webhook/disable` | disable its webhook |
//! | `GET /account/agents/consent?consent_token=..` | an agent's consent request |
//! | `POST /account/agents/consent` | answer it as another of the user's accounts |
//! | `GET`, `POST /ucp/oauth/authorize` | the API's authorize, relayed (local only) |
use corten::{
    NoStore, Relay,
    axum::{
        body::Body,
        http::{HeaderMap, HeaderName, StatusCode, Uri, header},
    },
    prelude::*,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{
        AgentCalls as _, AgentConsent, AgentGrant, ApiError, GrantActivity, GrantDetail, GrantWebhook, Method, RevokeAnswer,
        SessionCalls as _, SessionWrite, SpendingMandate,
    },
    app::{Shared, read_failed, sign_in, sign_in_back_to, url},
    auth::{AgentHolder, Viewer},
    recovery::valid_attempt,
    text::{AgentsMsg, Pilot},
    views::{self, Layout},
};

/// The payment rails a mandate can allow (`AGENT_GRANT_PAYMENT_RAILS`), and the one it allows when
/// none is chosen.
pub const RAILS: [&str; 2] = ["handoff-only", "stored-pm"];
const DEFAULT_RAIL: &str = "handoff-only";

/// The list: the account's grants and the connector URL an assistant is given.
#[derive(Serialize, ToJson)]
pub struct ListScreen {
    pub grants: Vec<AgentGrant>,
    pub mcp_url: String,
}

/// What a revoke the server settled says (`AgentGrantRevocationState`, without the states a page
/// is in only while its form is sending).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Revocation {
    Succeeded,
    AlreadyRevokedCleanupComplete,
    FailedSafe,
    Conflict,
    Ambiguous,
    ReauthRequired,
    RouteDenied,
}

impl Revocation {
    /// The state a refusal's status says (`revocationFailure`).
    pub fn of_status(status: Option<StatusCode>) -> Self {
        match status.map(|s| s.as_u16()) {
            Some(401) => Revocation::ReauthRequired,
            Some(404) => Revocation::RouteDenied,
            Some(409) => Revocation::Conflict,
            Some(503) => Revocation::FailedSafe,
            _ => Revocation::Ambiguous,
        }
    }

    /// What a receipt for `attempt` says, once checked (`safeRevocationReceipt`): one for another
    /// attempt, with a state the page does not know, or done without its last phase is not
    /// confirmed.
    pub fn of_receipt(receipt: &serde_json::Value, attempt: &str) -> Self {
        let text = |name: &str| receipt.get(name).and_then(serde_json::Value::as_str);
        if text("attempt_id") != Some(attempt) {
            return Revocation::Ambiguous;
        }
        let state = match text("state") {
            Some("succeeded") => Revocation::Succeeded,
            Some("already-revoked-cleanup-complete") => Revocation::AlreadyRevokedCleanupComplete,
            Some("ambiguous") => Revocation::Ambiguous,
            Some("failed-safe") => Revocation::FailedSafe,
            Some("conflict") => Revocation::Conflict,
            _ => return Revocation::Ambiguous,
        };
        if state.done() && text("phase") != Some("completed") {
            return Revocation::Ambiguous;
        }
        state
    }

    /// The grant is revoked and cleaned up: nothing is left to resume.
    pub fn done(self) -> bool {
        matches!(self, Revocation::Succeeded | Revocation::AlreadyRevokedCleanupComplete)
    }

    /// Sending the attempt again would not help: it belongs to another request, the user must sign
    /// in again, or the grant is not this account's.
    pub fn stuck(self) -> bool {
        matches!(self, Revocation::Conflict | Revocation::ReauthRequired | Revocation::RouteDenied)
    }
}

/// What came of a mandate or webhook write, in the grant page's address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Said {
    MandateSaved,
    WebhookSaved,
    WebhookDisabled,
    /// The grant was revoked, so it cannot be changed (the API's 409).
    GrantRevoked,
    /// Spending mandates are not configured (the API's 404 `unsupported`).
    MandateUnsupported,
    /// A write whose result is not known.
    Failed,
}

/// What a grant's address carries: what the last write did, and a revoke the server could not
/// settle, with its attempt.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub said: Option<Said>,
    pub revocation: Option<Revocation>,
    pub attempt: Option<String>,
}

/// The spending mandate's form (`MandateForm`): each cap as money (empty for no cap), whether a
/// person must be present (a hidden `false` and the switch's `true`), and the rails allowed.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct MandateInput {
    pub max_per_order_amount: String,
    pub daily_cap_amount: String,
    pub monthly_cap_amount: String,
    pub human_present_required: Vec<String>,
    pub allowed_rails: Vec<String>,
}

/// A cap's field as cents: none when empty, `Err` when it is not an amount of money (marketplace
/// saves one it cannot read as no cap, which would lift the limit; the field takes `min="0"` and
/// `step="0.01"`, so a browser sends only an amount).
fn cap(field: &str) -> Result<Option<i64>, ()> {
    match field.trim() {
        "" => Ok(None),
        amount => platform::money::cents(amount).filter(|c| *c >= 0).map(Some).ok_or(()),
    }
}

impl MandateInput {
    /// The mandate it sends (`update-mandate`), or `None` when a cap is not an amount.
    pub fn mandate(&self) -> Option<SpendingMandate> {
        let rails: Vec<String> = self.allowed_rails.iter().map(|r| r.trim().to_owned()).filter(|r| !r.is_empty()).collect();
        Some(SpendingMandate {
            max_per_order_cents: cap(&self.max_per_order_amount).ok()?,
            daily_cap_cents: cap(&self.daily_cap_amount).ok()?,
            monthly_cap_cents: cap(&self.monthly_cap_amount).ok()?,
            // The last value sent: the switch's `true` follows the hidden `false`; none is `true`.
            human_present_required: self.human_present_required.last().is_none_or(|v| v != "false"),
            allowed_rails: if rails.is_empty() { vec![DEFAULT_RAIL.to_owned()] } else { rails },
        })
    }
}

/// The webhook's form: its callback address (empty disables it, as marketplace's save does).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct WebhookInput {
    pub callback_url: String,
}

/// Revoke access's form: the attempt it was drawn with.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct RevokeInput {
    pub attempt_id: String,
}

/// A refused form, drawn again with what was sent.
#[derive(Clone, Debug)]
pub enum Posted {
    Mandate(MandateInput),
    Webhook(WebhookInput),
}

/// A grant's page: the grant, its activity (none when Auth keeps none), its webhook, what the
/// last write did, the revoke attempt Revoke access sends, and a refused form.
#[derive(Serialize, ToJson)]
pub struct GrantScreen {
    pub detail: GrantDetail,
    pub activity: Option<Vec<GrantActivity>>,
    pub webhook: Option<GrantWebhook>,
    pub said: Option<Said>,
    pub revocation: Option<Revocation>,
    pub attempt: String,
    #[serde(skip)]
    pub posted: Option<Posted>,
}

impl GrantScreen {
    /// What the revoke status line says (marketplace's `state`): a revoke the server settled, a
    /// grant revoked before, or nothing to say yet (`editing`).
    pub fn revocation(&self) -> Option<Revocation> {
        let grant = &self.detail.authorization;
        self.revocation.or_else(|| {
            (self.detail.revocation_active && !self.detail.revocation_available && grant.status == "revoked")
                .then_some(Revocation::AlreadyRevokedCleanupComplete)
        })
    }

    /// Whether Revoke access is drawn: while the API can revoke it, an active grant, or a revoked one
    /// whose cleanup is not known to be done.
    pub fn revocable(&self) -> bool {
        let grant = &self.detail.authorization;
        self.detail.revocation_available
            && (grant.status == "active" || (grant.status == "revoked" && !self.revocation().is_some_and(Revocation::done)))
    }
}

/// An agent's consent request (none when the API does not have it), and its token.
#[derive(Serialize, ToJson)]
pub struct ConsentScreen {
    pub consent: Option<AgentConsent>,
    #[serde(skip)]
    pub token: String,
}

/// Approve's and Deny's form, as the API reads it.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct DecideInput {
    pub consent_token: String,
    pub decision: String,
}

/// A scope family Auth recognizes and its scopes (`AGENT_OAUTH_KNOWN_SCOPE_FAMILIES`).
#[derive(Debug, Deserialize)]
pub struct ScopeFamily {
    pub label: String,
    pub scopes: Vec<Scope>,
}

#[derive(Debug, Deserialize)]
pub struct Scope {
    pub scope: String,
    pub label: String,
    pub description: String,
}

/// Every family, from `agent-scopes.json` (scripts/export.mjs).
static SCOPE_FAMILIES: std::sync::LazyLock<Vec<ScopeFamily>> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../agent-scopes.json")).expect("agent-scopes.json is the export's output")
});

/// The families with a scope in `scopes`, and those scopes, in Auth's order (a scope Auth does not
/// know is not listed, as marketplace's `GrantedScopes`).
pub fn granted(scopes: &[String]) -> Vec<(&'static ScopeFamily, Vec<&'static Scope>)> {
    SCOPE_FAMILIES
        .iter()
        .map(|family| (family, family.scopes.iter().filter(|s| scopes.contains(&s.scope)).collect::<Vec<_>>()))
        .filter(|(_, granted)| !granted.is_empty())
        .collect()
}

/// Use another account's form.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct SwitchInput {
    pub consent_token: String,
    pub account_id: String,
}

/// The consent's address: its token.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct ConsentAsk {
    pub consent_token: Option<String>,
}

pub(crate) async fn list(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let grants = match caller.agent_grants().await {
        Ok(grants) => grants,
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    // The connector is this site's `/mcp`, which the ingress sends to the platform API.
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost");
    let screen = ListScreen { grants, mcp_url: format!("{}://{host}/mcp", config.proto) };
    let t: AgentsMsg = req.t();
    let view = html! { <views::AgentsPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! { <Layout req={&req} viewer={Some(&viewer)} title={t.list_connected_agents()} head={()}>{view}</Layout> },
    )
}

pub(crate) async fn page(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::agents::AgentPage<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id.as_str(), route.place);
    let attempt = place.attempt.filter(|a| valid_attempt(a));
    let shown = Shown { said: place.said, revocation: place.revocation, attempt, webhook: None };
    render(&req, &viewer, &config, &headers, id, shown, None, StatusCode::OK).await
}

/// What the page says besides the grant: the last write, a revoke and its attempt, and a webhook a
/// save answered (with its secret).
#[derive(Default)]
struct Shown {
    said: Option<Said>,
    revocation: Option<Revocation>,
    attempt: Option<String>,
    webhook: Option<Option<GrantWebhook>>,
}

/// A grant Auth does not have for this account is not found.
fn failed_read(req: &Req, viewer: &Viewer, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::NOT_FOUND) => Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND)),
        _ => read_failed(req, Some(viewer), error, None),
    }
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    shown: Shown,
    posted: Option<Posted>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let (detail, activity) = tokio::join!(caller.agent_grant(id), caller.agent_activity(id));
    let detail = match detail {
        Ok(detail) => detail,
        Err(error) => return failed_read(req, viewer, error),
    };
    // Auth answers 404 `unsupported` when it keeps no activity: the page says so instead of failing.
    let activity = match activity {
        Ok(activity) => Some(activity),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => None,
        Err(error) => return failed_read(req, viewer, error),
    };
    let webhook = match shown.webhook {
        Some(saved) => saved,
        None => match caller.agent_webhook(id).await {
            Ok(webhook) => webhook,
            Err(error) => return failed_read(req, viewer, error),
        },
    };
    let attempt = shown.attempt.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let screen = GrantScreen { detail, activity, webhook, said: shown.said, revocation: shown.revocation, attempt, posted };
    let t: AgentsMsg = req.t();
    let view = html! { <views::AgentPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={screen.detail.authorization.name()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// The grant's page, saying `said`.
fn back(req: &Req, id: &str, said: Said) -> HtmlResult {
    req.redirect(&url::AgentPage { id, place: Place { said: Some(said), ..Place::default() } })
}

pub(crate) async fn revoke(
    req: Req,
    Caller(AgentHolder(_)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::agents::AgentRevoke<'_>>,
    Form(input): Form<RevokeInput>,
) -> HtmlResult {
    let id = route.id.as_str();
    let sent = input.attempt_id.trim().to_ascii_lowercase();
    let attempt = if valid_attempt(&sent) { sent } else { uuid::Uuid::new_v4().to_string() };
    let caller = config.platform.caller(&headers, config.proto, None);
    let revocation = match caller.revoke_agent_grant(id, &attempt).await {
        Ok(RevokeAnswer::Plain) => return req.redirect(&url::AgentPage { id, place: Place::default() }),
        Ok(RevokeAnswer::Receipt(receipt)) => Revocation::of_receipt(&receipt, &attempt),
        Err(error @ ApiError::Status { .. }) => Revocation::of_status(error.status()),
        // No answer: what came of the attempt, as marketplace asks.
        Err(error) => {
            tracing::warn!("a grant revoke had no answer: {error}");
            match caller.agent_revocation(id, &attempt).await {
                Ok(receipt) => Revocation::of_receipt(&receipt, &attempt),
                Err(error) => Revocation::of_status(error.status()),
            }
        }
    };
    // A revoke left to resume keeps its attempt, so Revoke access sends it again.
    let attempt = (!revocation.done()).then_some(attempt);
    req.redirect(&url::AgentPage { id, place: Place { said: None, revocation: Some(revocation), attempt } })
}

pub(crate) async fn mandate(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::agents::AgentMandate<'_>>,
    Form(input): Form<MandateInput>,
) -> HtmlResult {
    let id = route.id.as_str();
    let Some(mandate) = input.mandate() else {
        let posted = Some(Posted::Mandate(input));
        return render(&req, &viewer, &config, &headers, id, Shown::default(), posted, StatusCode::UNPROCESSABLE_ENTITY).await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.save_agent_mandate(id, &mandate).await {
        Ok(()) => back(&req, id, Said::MandateSaved),
        Err(error) => written(&req, &viewer, id, error, Said::MandateUnsupported),
    }
}

/// A mandate or webhook write the API refused: sign in again, a grant that is not this account's,
/// a revoked grant, `missing` for a 404 (the write is not configured), or not confirmed.
fn written(req: &Req, viewer: &Viewer, id: &str, error: ApiError, missing: Said) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(StatusCode::FORBIDDEN) => failed_read(req, viewer, error),
        Some(StatusCode::NOT_FOUND) => back(req, id, missing),
        Some(StatusCode::CONFLICT) => back(req, id, Said::GrantRevoked),
        _ => {
            tracing::warn!("a grant write did not succeed: {error}");
            back(req, id, Said::Failed)
        }
    }
}

/// Save the webhook's address. Nothing may keep the answer: it carries the new signing secret.
pub(crate) async fn webhook(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::agents::AgentWebhook<'_>>,
    Form(input): Form<WebhookInput>,
) -> NoStore<HtmlResult> {
    let id = route.id.as_str();
    let address = input.callback_url.trim();
    let caller = config.platform.caller(&headers, config.proto, None);
    NoStore(match caller.save_agent_webhook(id, Some(address).filter(|a| !a.is_empty())).await {
        Ok(None) => back(&req, id, Said::WebhookDisabled),
        Ok(Some(saved)) => {
            let shown = Shown { said: Some(Said::WebhookSaved), webhook: Some(Some(saved)), ..Shown::default() };
            render(&req, &viewer, &config, &headers, id, shown, None, StatusCode::OK).await
        }
        Err(error) if error.status() == Some(StatusCode::BAD_REQUEST) => {
            let posted = Some(Posted::Webhook(input));
            render(&req, &viewer, &config, &headers, id, Shown::default(), posted, StatusCode::UNPROCESSABLE_ENTITY).await
        }
        Err(error) => written(&req, &viewer, id, error, Said::Failed),
    })
}

pub(crate) async fn disable_webhook(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::agents::AgentWebhookDisable<'_>>,
) -> HtmlResult {
    let id = route.id.as_str();
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.save_agent_webhook(id, None).await {
        Ok(_) => back(&req, id, Said::WebhookDisabled),
        Err(error) => written(&req, &viewer, id, error, Said::Failed),
    }
}

/// An agent's consent request. Nothing may keep it, and its address (with the token) goes no
/// further than this site's origin.
pub(crate) async fn consent(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::agent_consent::AgentConsent>,
) -> NoStore<HtmlResult> {
    let token = route.ask.consent_token.unwrap_or_default();
    let caller = config.platform.caller(&headers, config.proto, None);
    let consent = match caller.agent_consent(&token).await {
        Ok(consent) => Some(consent),
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => return NoStore(back_to_consent(&req, &token)),
            Some(StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND) => None,
            _ => return NoStore(read_failed(&req, Some(&viewer), error, None)),
        },
    };
    let screen = ConsentScreen { consent, token };
    let t: AgentsMsg = req.t();
    let head = html! { <meta name="referrer" content="strict-origin"> };
    let view = html! { <views::AgentConsentPage t={t} screen={&screen} /> };
    let title = if screen.consent.is_some() { t.consent_title() } else { t.consent_invalid_title() };
    NoStore(req.screen(&screen, html! { <Layout req={&req} viewer={Some(&viewer)} title={title} head={head}>{view}</Layout> }))
}

/// The sign-in, back to this consent (its token included).
fn back_to_consent(req: &Req, token: &str) -> HtmlResult {
    let page = url::AgentConsent { ask: ConsentAsk { consent_token: Some(token.to_owned()) } }.href();
    match sign_in_back_to(&page) {
        Some(to) => req.redirect(&to),
        None => sign_in(req),
    }
}

/// Use another account: the session acts for it, and the agent's authorize is asked again, which
/// makes a consent for that account (marketplace's consent action). Corten refuses a write from
/// another site before this runs, as the action's `Origin` and `Sec-Fetch-Site` checks do.
pub(crate) async fn switch_account(
    req: Req,
    Caller(AgentHolder(viewer)): Caller<AgentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<SwitchInput>,
) -> NoStore<HtmlResult> {
    let caller = config.platform.caller(&headers, config.proto, None);
    let consent = match caller.agent_consent(&input.consent_token).await {
        Ok(consent) => consent,
        Err(error) => {
            return NoStore(match error.status() {
                Some(StatusCode::UNAUTHORIZED) => back_to_consent(&req, &input.consent_token),
                Some(StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND) => {
                    let ask = ConsentAsk { consent_token: Some(input.consent_token.clone()) };
                    req.redirect(&url::AgentConsent { ask })
                }
                _ => read_failed(&req, Some(&viewer), error, None),
            });
        }
    };
    let account = input.account_id.trim();
    if !consent.memberships.iter().any(|m| m.account_id == account) {
        return NoStore(Err(corten::Error::status(StatusCode::FORBIDDEN)));
    }
    if let Err(error) = caller.session_write(&consent.session_id, SessionWrite::Switch(account)).await {
        return NoStore(match error.status() {
            Some(StatusCode::UNAUTHORIZED) => back_to_consent(&req, &input.consent_token),
            Some(StatusCode::FORBIDDEN) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        });
    }
    NoStore(match consent.authorize_path.parse::<Uri>() {
        Ok(to) if to.authority().is_none() && consent.authorize_path.starts_with("/ucp/oauth/authorize?") => req.redirect(&to),
        _ => Err(corten::Error::status(StatusCode::BAD_GATEWAY)),
    })
}

/// The headers of the API's authorize answer the browser gets: where it sends the browser, and
/// what the answer is.
const KEPT: [HeaderName; 4] = [header::LOCATION, header::CONTENT_TYPE, header::CACHE_CONTROL, header::REFERRER_POLICY];

/// The API's authorize (an agent's link, or after Use another account): a redirect to the
/// consent, or to the sign-in.
pub(crate) async fn authorize(State(config): State<Shared>, headers: HeaderMap, uri: Uri) -> corten::Result<Relay> {
    let path = match uri.query() {
        Some(query) => format!("/ucp/oauth/authorize?{query}"),
        None => "/ucp/oauth/authorize".to_owned(),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    relay(as_sent(caller.request_unfollowed(Method::GET, &path, "auth"), &headers)).await
}

/// The request with the browser's `Host`, as the ingress passes it on: the API reads its public
/// origin from `Host` where it does not trust `X-Forwarded-Host` (locally), and checks Approve's
/// `Origin` against it.
fn as_sent(sent: platform::api::RequestBuilder, headers: &HeaderMap) -> platform::api::RequestBuilder {
    match headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        Some(host) => sent.header(header::HOST.as_str(), host),
        None => sent,
    }
}

/// Approve or Deny, sent to the API with the browser's `Origin` and `Sec-Fetch-Site`, which it
/// checks: a redirect to the agent's address, with its code or `access_denied`.
pub(crate) async fn decide(
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<DecideInput>,
) -> corten::Result<Relay> {
    let caller = config.platform.caller(&headers, config.proto, None);
    let fields = [("consent_token", input.consent_token.as_str()), ("decision", input.decision.as_str())];
    let mut sent = as_sent(caller.request_unfollowed(Method::POST, "/ucp/oauth/authorize", "auth"), &headers).form(&fields);
    for name in [header::ORIGIN.as_str(), "sec-fetch-site"] {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            sent = sent.header(name, value);
        }
    }
    relay(sent).await
}

async fn relay(sent: platform::api::RequestBuilder) -> corten::Result<Relay> {
    let res = sent.send().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut kept = HeaderMap::new();
    for name in KEPT {
        if let Some(value) =
            res.headers().get(name.as_str()).and_then(|v| corten::axum::http::HeaderValue::from_bytes(v.as_bytes()).ok())
        {
            kept.insert(name, value);
        }
    }
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(status, kept, Body::from(bytes)))
}

/// A cap's words: an amount in dollars, or No cap (`agentGrantMandateCapLabel`).
pub fn cap_words(t: AgentsMsg, cents: Option<i64>) -> String {
    match cents {
        Some(cents) => dollars(t, cents),
        None => t.presentation_no_cap().to_owned(),
    }
}

/// Cents in dollars (`formatMoney(centsToMoneyAmount(..), "USD")`).
pub fn dollars(t: AgentsMsg, cents: i64) -> String {
    match corten::i18n::Currency::parse("USD") {
        Some(usd) => t.money(corten::i18n::Decimal::new(i128::from(cents), 2), usd).to_string(),
        None => cents.to_string(),
    }
}

/// A cap's field as the form draws it: the amount, or empty for no cap.
pub fn cap_field(cents: Option<i64>) -> String {
    cents.map(|c| format!("{}.{:02}", c / 100, c % 100)).unwrap_or_default()
}

/// The pilot's words for what the last write did.
pub fn said_words(p: Pilot, said: Said) -> (&'static str, &'static str) {
    match said {
        Said::MandateSaved => ("info", p.agents_mandate_saved()),
        Said::WebhookSaved => ("info", p.agents_webhook_saved()),
        Said::WebhookDisabled => ("info", p.agents_webhook_disabled()),
        Said::GrantRevoked => ("danger", p.agents_grant_revoked()),
        Said::MandateUnsupported => ("warning", p.agents_mandate_unsupported()),
        Said::Failed => ("warning", p.agents_failed()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATTEMPT: &str = "4f8b1c2e-1d3a-4b5c-8d7e-9f0a1b2c3d4e";

    #[test]
    fn a_receipt_is_believed_only_for_its_attempt_and_with_its_last_phase() {
        let receipt = |attempt: &str, state: &str, phase: Option<&str>| serde_json::json!({ "attempt_id": attempt, "state": state, "phase": phase });
        assert_eq!(Revocation::of_receipt(&receipt(ATTEMPT, "succeeded", Some("completed")), ATTEMPT), Revocation::Succeeded);
        assert_eq!(
            Revocation::of_receipt(&receipt(ATTEMPT, "already-revoked-cleanup-complete", Some("completed")), ATTEMPT),
            Revocation::AlreadyRevokedCleanupComplete
        );
        assert_eq!(Revocation::of_receipt(&receipt(ATTEMPT, "succeeded", Some("admitted")), ATTEMPT), Revocation::Ambiguous);
        assert_eq!(Revocation::of_receipt(&receipt(ATTEMPT, "succeeded", None), ATTEMPT), Revocation::Ambiguous);
        assert_eq!(Revocation::of_receipt(&receipt("other", "succeeded", Some("completed")), ATTEMPT), Revocation::Ambiguous);
        assert_eq!(Revocation::of_receipt(&receipt(ATTEMPT, "editing", None), ATTEMPT), Revocation::Ambiguous);
        assert_eq!(Revocation::of_receipt(&receipt(ATTEMPT, "failed-safe", Some("admitted")), ATTEMPT), Revocation::FailedSafe);
        assert_eq!(Revocation::of_receipt(&serde_json::json!(["x"]), ATTEMPT), Revocation::Ambiguous);
    }

    #[test]
    fn a_refusal_says_what_marketplace_says() {
        let of = |code: u16| Revocation::of_status(StatusCode::from_u16(code).ok());
        assert_eq!(
            [of(401), of(404), of(409), of(503), of(500)],
            [
                Revocation::ReauthRequired,
                Revocation::RouteDenied,
                Revocation::Conflict,
                Revocation::FailedSafe,
                Revocation::Ambiguous
            ]
        );
        assert_eq!(Revocation::of_status(None), Revocation::Ambiguous);
    }

    #[test]
    fn a_mandate_is_cents_or_no_cap_and_never_an_amount_it_cannot_read() {
        let input = |max: &str, rails: &[&str], human: &[&str]| MandateInput {
            max_per_order_amount: max.into(),
            daily_cap_amount: "50".into(),
            monthly_cap_amount: String::new(),
            human_present_required: human.iter().map(|h| (*h).to_owned()).collect(),
            allowed_rails: rails.iter().map(|r| (*r).to_owned()).collect(),
        };
        let m = input("12.50", &["stored-pm"], &["false", "true"]).mandate().unwrap();
        assert_eq!((m.max_per_order_cents, m.daily_cap_cents, m.monthly_cap_cents), (Some(1250), Some(5000), None));
        assert!(m.human_present_required);
        assert_eq!(m.allowed_rails, ["stored-pm"]);
        let m = input("", &[], &["false"]).mandate().unwrap();
        assert_eq!((m.max_per_order_cents, m.human_present_required), (None, false));
        assert_eq!(m.allowed_rails, [DEFAULT_RAIL], "no rail chosen is the trusted handoff");
        assert!(input("", &[], &[]).mandate().unwrap().human_present_required, "none sent is a person present");
        for bad in ["abc", "-1", "1.234", "1e3"] {
            assert!(input(bad, &[], &[]).mandate().is_none(), "{bad} is not no cap");
        }
        assert_eq!((cap_field(Some(1250)), cap_field(Some(7)), cap_field(None)), ("12.50".into(), "0.07".into(), String::new()));
    }
}
