//! Connect eBay Sandbox (Channels' `channels-ebay-connection` route, `/account/channels/ebay`), and
//! eBay's return from consent (`channels-ebay-callback` and `channels-ebay-declined`,
//! `/channels/ebay/callback` and `/channels/ebay/declined`), through Channels' eBay calls
//! (`/api/channels/ebay`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/channels/ebay?connectionId&publication&outcome` | the journey: consent, or a connection's state, or what consent came back with |
//! | `POST /account/channels/ebay` | `intent=authorize` sends the seller to eBay's consent; `intent=disconnect` disconnects the connection and draws it |
//! | `GET /channels/ebay/callback?state&code`, `GET /channels/ebay/declined?state` | the connection eBay committed, or the journey saying consent was declined or failed |
//!
//! The page's state is marketplace's (`EbayJourneyState`): consent for a new connection; for an
//! address naming a connection, its status (`connected` while active, `reauthorize` while
//! paused, `pending-setup`, `disconnected`), a status the page does not know being Channels'
//! fault (503); and `declined` or `failed` from consent's outcome or a refused write. Consent lists
//! the scopes Channels asks eBay for, and offers Continue (Reauthorize for a live connection) only
//! where eBay is configured. Marketplace shows `awaiting-callback` while its form submits; here the
//! form's own pending state stands for it.
//!
//! Authorize sends the seller only to eBay Sandbox's authorization address
//! (`https://auth.sandbox.ebay.com/oauth2/authorize`), which the area's `form-action` allows, and
//! anything else Channels answers is `failed`. Every answer is `no-store` and the area sends no
//! referrer, so eBay's one-time code and state stay out of caches and other sites' logs; a
//! return's sign-in goes back to the journey, not to the return's address. Reading needs
//! `channels.manage`, as marketplace's loader does (`ChannelsManager`, `EbayReturn`).
use corten::{
    http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use serde::Deserialize;

use crate::{
    api::{ApiError, ChannelCalls as _, EbayCalls as _},
    app::{Shared, read_failed, sign_in, url},
    auth::{ChannelsManager, EbayReturn, Viewer},
    text::ChannelsMsg,
    views::{self, Layout},
};

/// The journey's address, where a return's sign-in comes back to.
pub const PAGE: &str = "/account/channels/ebay";

/// The only address Authorize sends the seller to: eBay Sandbox's consent.
pub const EBAY_ORIGIN: &str = "https://auth.sandbox.ebay.com";
/// Where eBay Sandbox's consent may send the seller on its way (`auth2.sandbox.ebay.com`, its
/// sign-in): Chromium and WebKit check every redirect a form's submission follows against
/// `form-action`, so the journey's page allows eBay Sandbox's hosts (Authorize's among them), not
/// only the one Authorize names.
pub const EBAY_SANDBOX_HOSTS: &str = "https://*.sandbox.ebay.com";
const EBAY_AUTHORIZE: &str = "/oauth2/authorize";

/// The journey's address: the connection it is about, whether consent asks for publication, and
/// what consent came back with (`declined` or `failed`), in marketplace's names.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct EbayPlace {
    pub connection_id: Option<String>,
    pub publication: Option<String>,
    pub outcome: Option<String>,
}

impl EbayPlace {
    /// The journey for connection `id`.
    pub fn connection(id: &str) -> EbayPlace {
        EbayPlace { connection_id: Some(id.to_owned()), ..EbayPlace::default() }
    }

    /// The journey saying what consent came back with.
    fn outcome(outcome: Outcome) -> EbayPlace {
        EbayPlace { outcome: Some(outcome.word().to_owned()), ..EbayPlace::default() }
    }

    fn connection_id(&self) -> Option<&str> {
        self.connection_id.as_deref().filter(|id| !id.is_empty())
    }

    fn publication(&self) -> bool {
        self.publication.as_deref() == Some("true")
    }
}

/// What consent came back with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Declined,
    Failed,
}

impl Outcome {
    fn word(self) -> &'static str {
        match self {
            Outcome::Declined => "declined",
            Outcome::Failed => "failed",
        }
    }
}

/// The journey's forms, named as marketplace's name them.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct EbayForm {
    pub intent: String,
    pub connection_id: String,
    /// `true` or `false`.
    pub publication: String,
}

/// Where the journey is (`EbayJourneyState`, but `awaiting-callback`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EbayState {
    Consent,
    Declined,
    Failed,
    PendingSetup,
    Connected,
    Reauthorize,
    Disconnected,
}

impl EbayState {
    /// A connection's status as the journey's state; `None` for a status it does not know.
    fn of(status: &str) -> Option<EbayState> {
        Some(match status {
            "active" => EbayState::Connected,
            "paused" => EbayState::Reauthorize,
            "pending-setup" => EbayState::PendingSetup,
            "disconnected" => EbayState::Disconnected,
            _ => return None,
        })
    }
}

/// What the journey shows.
pub struct EbayScreen {
    pub state: EbayState,
    /// The scopes consent asks eBay for; none where eBay is not configured.
    pub scopes: Vec<String>,
    pub connection_id: Option<String>,
    pub publication: bool,
    /// eBay is configured here, so consent can be given (again).
    pub authorization_available: bool,
}

impl EbayScreen {
    /// A connection that can still be authorized again or disconnected.
    pub fn live(&self) -> Option<&str> {
        self.connection_id.as_deref().filter(|_| self.state != EbayState::Disconnected)
    }
}

/// The journey at `place`, `failed` after a write Channels refused, at `status`.
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &EbayPlace,
    failed: bool,
    status: StatusCode,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    let read_error = |error: ApiError| match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        _ => read_failed(req, Some(viewer), error, None),
    };
    let mut state = match place.outcome.as_deref() {
        Some("declined") => EbayState::Declined,
        Some("failed") => EbayState::Failed,
        _ => EbayState::Consent,
    };
    let mut authorization_available = true;
    if let Some(id) = place.connection_id() {
        let connection = match caller.ebay_connection(id).await {
            Ok(Some(connection)) => connection,
            Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
            Err(error) => return read_error(error),
        };
        authorization_available = connection.authorization_available;
        state = match EbayState::of(&connection.status) {
            Some(state) => state,
            None => {
                tracing::warn!("an eBay connection's status is not one the journey knows: {}", connection.status);
                return Err(corten::Error::status(StatusCode::SERVICE_UNAVAILABLE));
            }
        };
    }
    let scopes = if authorization_available {
        match caller.ebay_consent(place.publication()).await {
            Ok(consent) => consent.scopes,
            Err(error) => return read_error(error),
        }
    } else {
        Vec::new()
    };
    if failed {
        state = EbayState::Failed;
    }
    let screen = EbayScreen {
        state,
        scopes,
        connection_id: place.connection_id().map(str::to_owned),
        publication: place.publication(),
        authorization_available,
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.ebay_title()} head={html! { <meta name="robots" content="noindex"> }}>
            <views::EbayPage t={t} screen={&screen} place={place} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The journey at the address.
pub(crate) async fn page(
    req: Req,
    Caller(ChannelsManager(viewer)): Caller<ChannelsManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::EbayConnect>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &route.place, false, StatusCode::OK).await
}

/// Authorize and Disconnect: eBay's consent, or the connection after Disconnect, or the journey
/// saying it failed.
pub(crate) async fn write(
    req: Req,
    Caller(ChannelsManager(viewer)): Caller<ChannelsManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::EbayConnect>,
    Form(form): Form<EbayForm>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let connection = Some(form.connection_id.trim()).filter(|id| !id.is_empty());
    let refused = match (form.intent.as_str(), connection) {
        ("disconnect", Some(id)) => match caller.channel_command(id, "disconnect").await {
            Ok(_) => return req.redirect(&url::EbayConnect { place: EbayPlace::connection(id) }),
            Err(error) => error,
        },
        ("authorize", _) if matches!(form.publication.as_str(), "true" | "false") => {
            match caller.start_ebay(connection, form.publication == "true").await {
                Ok(address) => match consent_address(&address) {
                    Some(to) => return req.redirect(&to),
                    None => {
                        tracing::warn!("Channels answered an eBay authorization address that is not eBay Sandbox's consent");
                        return render(&req, &viewer, &config, &headers, &route.place, true, StatusCode::BAD_GATEWAY).await;
                    }
                },
                Err(error) => error,
            }
        }
        _ => {
            return render(&req, &viewer, &config, &headers, &route.place, true, StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    match refused.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
        Some(StatusCode::FORBIDDEN) => Err(crate::app::api_refused(refused)),
        status => {
            tracing::warn!("an eBay connection's write was refused: {refused}");
            let status = if status.is_some_and(|s| s.is_client_error()) {
                StatusCode::UNPROCESSABLE_ENTITY
            } else {
                StatusCode::BAD_GATEWAY
            };
            render(&req, &viewer, &config, &headers, &route.place, true, status).await
        }
    }
}

/// `address` when it is eBay Sandbox's consent (marketplace checks the same), else `None`.
pub fn consent_address(address: &str) -> Option<Uri> {
    let uri: Uri = address.parse().ok()?;
    let origin_ok =
        uri.scheme_str() == Some("https") && uri.authority().is_some_and(|a| format!("https://{}", a.as_str()) == EBAY_ORIGIN);
    (origin_ok && uri.path() == EBAY_AUTHORIZE).then_some(uri)
}

/// Every value `name` has in `query`, decoded.
fn values(query: Option<&str>, name: &str) -> Vec<String> {
    let decode = |text: &str| {
        let text = text.replace('+', " ");
        percent_encoding::percent_decode_str(&text).decode_utf8_lossy().into_owned()
    };
    query
        .unwrap_or_default()
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| part.split_once('=').unwrap_or((part, "")))
        .filter(|(key, _)| decode(key) == name)
        .map(|(_, value)| decode(value))
        .collect()
}

/// The single value `name` has in `query`; `None` when it has none or several.
fn single(query: Option<&str>, name: &str) -> Option<String> {
    let mut found = values(query, name);
    if found.len() == 1 { found.pop() } else { None }
}

/// eBay's return with consent given: the connection Channels committed, else the journey saying
/// it failed. A state or code missing or given twice is not sent on.
pub(crate) async fn callback(
    req: Req,
    Caller(EbayReturn(_)): Caller<EbayReturn>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let place = match (single(uri.query(), "state").filter(|s| !s.is_empty()), single(uri.query(), "code")) {
        (Some(state), Some(code)) => match caller.ebay_callback(&state, &code).await {
            Ok(Some(id)) => EbayPlace::connection(&id),
            Ok(None) => EbayPlace::outcome(Outcome::Failed),
            Err(error) => {
                tracing::warn!("eBay's consent could not be committed: {error}");
                EbayPlace::outcome(Outcome::Failed)
            }
        },
        _ => EbayPlace::outcome(Outcome::Failed),
    };
    req.redirect(&url::EbayConnect { place })
}

/// eBay's return with consent declined: Channels uses the state up, and the journey says so (or
/// that it failed).
pub(crate) async fn declined(
    req: Req,
    Caller(EbayReturn(_)): Caller<EbayReturn>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let outcome = match single(uri.query(), "state").filter(|s| !s.is_empty()) {
        Some(state) => match caller.ebay_declined(&state).await {
            Ok(()) => Outcome::Declined,
            Err(error) => {
                tracing::warn!("eBay's declined consent could not be recorded: {error}");
                Outcome::Failed
            }
        },
        None => Outcome::Failed,
    };
    req.redirect(&url::EbayConnect { place: EbayPlace::outcome(outcome) })
}
