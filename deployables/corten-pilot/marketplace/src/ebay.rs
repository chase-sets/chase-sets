//! Connect eBay Sandbox (Channels' `channels-ebay-connection` route, `/account/channels/ebay`), and
//! eBay's return from consent (`channels-ebay-callback` and `channels-ebay-declined`,
//! `/channels/ebay/callback` and `/channels/ebay/declined`), through Channels' eBay calls
//! (`/api/channels/ebay`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/channels/ebay?connectionId&publication&outcome` | the journey: consent, or a connection's state, or what consent came back with |
//! | `POST /account/channels/ebay` | `intent=authorize` sends the seller to eBay's consent; `intent=disconnect` disconnects the connection and draws it |
//! | `POST /account/channels/ebay` with `intent=select-setup` | saves the seller's policies and location pairs, which activates the connection, then draws it |
//! | `POST /account/channels/ebay` with `intent=add-pair` | draws the setup form again with what was chosen and one more location pair |
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
//!
//! Seller setup (marketplace's `EbaySellerSetup`): a connection pending setup or connected, where
//! eBay is configured, shows the setup Channels holds and eBay's lists, read with the
//! connection's credential, beside the seller's active storage locations, both read at once. The
//! seller picks a fulfillment, payment and return policy and pairs storage locations with eBay
//! inventory locations; Save posts the selection with the setup generation it replaces, and
//! Channels activates the connection. A list eBay answered in part, an empty list, a failed read
//! and a refused save each have their own words. Marketplace adds a pair in the browser; here Add
//! location pair is a submit button that draws the form again with one more pair, so it works
//! without JavaScript, and a refused save draws the form with what the seller chose.
use corten::{
    http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use serde::Deserialize;

use crate::{
    api::{
        ApiError, ChannelCalls as _, EbayCalls as _, EbayLocationPair, EbaySetup, EbaySetupCommand, EbaySetupPair,
        EbaySetupPolicy, SetupLocation,
    },
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
    /// The setup generation the selection replaces (`0` before any).
    pub setup_generation: String,
    pub fulfillment_policy_id: String,
    pub payment_policy_id: String,
    pub return_policy_id: String,
    /// Each pair's storage location, in the pairs' order.
    pub storage_location_id: Vec<String>,
    /// Each pair's eBay inventory location, in the pairs' order.
    pub merchant_location_key: Vec<String>,
}

/// The most pairs a selection holds (`parseSetupCommand`).
pub const MAX_PAIRS: usize = 200;

/// The policy types, in the form's order, with their item's id field.
pub const POLICY_TYPES: [(&str, &str); 3] =
    [("fulfillment", "fulfillmentPolicyId"), ("payment", "paymentPolicyId"), ("return", "returnPolicyId")];

/// What the setup form shows chosen: from the setup Channels holds, or from what was posted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SetupDraft {
    /// The fulfillment, payment and return policy ids, in `POLICY_TYPES`' order.
    pub policies: [String; 3],
    /// At least one pair, blank when none is chosen.
    pub pairs: Vec<EbayLocationPair>,
}

impl SetupDraft {
    fn of(setup: &EbaySetup) -> SetupDraft {
        let mut draft = SetupDraft::default();
        if let Some(selection) = &setup.selection {
            for (slot, (kind, _)) in draft.policies.iter_mut().zip(POLICY_TYPES) {
                if let Some(choice) = selection.policies.iter().find(|p| p.policy_type == kind) {
                    slot.clone_from(&choice.policy_id);
                }
            }
            draft.pairs = selection.location_pairs.clone();
        }
        draft.at_least_one()
    }

    /// What `form` posted, every pair as drawn.
    fn posted(form: &EbayForm) -> SetupDraft {
        let count = form.storage_location_id.len().max(form.merchant_location_key.len()).min(MAX_PAIRS);
        let at = |list: &[String], i: usize| list.get(i).cloned().unwrap_or_default();
        SetupDraft {
            policies: [form.fulfillment_policy_id.clone(), form.payment_policy_id.clone(), form.return_policy_id.clone()],
            pairs: (0..count)
                .map(|i| EbayLocationPair {
                    storage_location_id: at(&form.storage_location_id, i),
                    merchant_location_key: at(&form.merchant_location_key, i),
                })
                .collect(),
        }
        .at_least_one()
    }

    fn at_least_one(mut self) -> SetupDraft {
        if self.pairs.is_empty() {
            self.pairs.push(EbayLocationPair::default());
        }
        self
    }

    /// The selection to save, replacing generation `generation`: the pairs with neither side
    /// chosen are left out, as marketplace leaves them out.
    fn command(&self, generation: u64) -> EbaySetupCommand {
        EbaySetupCommand {
            expected_setup_generation: generation,
            policies: POLICY_TYPES
                .iter()
                .zip(&self.policies)
                .map(|((kind, _), id)| EbaySetupPolicy { policy_type: kind, policy_id: id.clone() })
                .collect(),
            location_pairs: self
                .pairs
                .iter()
                .filter(|p| !(p.storage_location_id.is_empty() && p.merchant_location_key.is_empty()))
                .map(|p| EbaySetupPair {
                    storage_location_id: p.storage_location_id.clone(),
                    merchant_location_key: p.merchant_location_key.clone(),
                })
                .collect(),
        }
    }
}

/// A connection's seller setup as the journey shows it.
pub enum SetupState {
    /// The setup or the storage locations could not be read.
    Error,
    Loaded {
        setup: EbaySetup,
        locations: Vec<SetupLocation>,
        /// The connection is active, so the selection replaces the current one.
        active: bool,
        draft: SetupDraft,
    },
}

/// The seller setup part of the journey.
pub struct SetupScreen {
    pub state: SetupState,
    /// A save was refused.
    pub failed: bool,
}

impl SetupScreen {
    /// eBay answered one of its lists in part.
    pub fn blocked(&self) -> bool {
        match &self.state {
            SetupState::Loaded { setup, .. } => {
                let l = &setup.lists;
                [&l.fulfillment, &l.payment, &l.return_, &l.locations].iter().any(|list| !list.complete())
            }
            SetupState::Error => false,
        }
    }

    /// A list, or the storage locations, has nothing to choose.
    pub fn empty(&self) -> bool {
        match &self.state {
            SetupState::Loaded { setup, locations, .. } => {
                let l = &setup.lists;
                [&l.fulfillment, &l.payment, &l.return_, &l.locations].iter().any(|list| list.items.is_empty())
                    || locations.is_empty()
            }
            SetupState::Error => false,
        }
    }
}

/// What the setup part is drawn with: what a post chose, and whether its save was refused.
#[derive(Default)]
struct SetupInput {
    posted: Option<SetupDraft>,
    failed: bool,
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
    /// Seller setup, for a connection pending setup or connected where eBay is configured.
    pub setup: Option<SetupScreen>,
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
    setup_input: SetupInput,
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
    let setup = match place.connection_id() {
        Some(id) if authorization_available && matches!(state, EbayState::PendingSetup | EbayState::Connected) => {
            let (setup, locations) = tokio::join!(caller.ebay_setup(id), caller.setup_locations());
            let state = match (setup, locations) {
                (Ok(setup), Ok(locations)) => SetupState::Loaded {
                    draft: setup_input.posted.clone().unwrap_or_else(|| SetupDraft::of(&setup)),
                    setup,
                    locations,
                    active: state == EbayState::Connected,
                },
                (Err(error), _) | (_, Err(error)) => {
                    tracing::warn!("an eBay connection's seller setup could not be read: {error}");
                    SetupState::Error
                }
            };
            Some(SetupScreen { state, failed: setup_input.failed })
        }
        _ => None,
    };
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
        setup,
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
    render(&req, &viewer, &config, &headers, &route.place, false, SetupInput::default(), StatusCode::OK).await
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
        ("add-pair", Some(_)) => {
            let mut draft = SetupDraft::posted(&form);
            if draft.pairs.len() < MAX_PAIRS {
                draft.pairs.push(EbayLocationPair::default());
            }
            let input = SetupInput { posted: Some(draft), failed: false };
            return render(&req, &viewer, &config, &headers, &route.place, false, input, StatusCode::OK).await;
        }
        ("select-setup", Some(id)) => {
            let draft = SetupDraft::posted(&form);
            let Ok(generation) = form.setup_generation.trim().parse::<u64>() else {
                let input = SetupInput { posted: Some(draft), failed: true };
                return render(&req, &viewer, &config, &headers, &route.place, false, input, StatusCode::UNPROCESSABLE_ENTITY)
                    .await;
            };
            let error = match caller.select_ebay_setup(id, &draft.command(generation)).await {
                Ok(saved) if saved.status == "active" => {
                    return req.redirect(&url::EbayConnect { place: EbayPlace::connection(id) });
                }
                Ok(saved) => {
                    tracing::warn!("an eBay seller setup was saved but the connection is {}", saved.status);
                    None
                }
                Err(error) => Some(error),
            };
            let status = match error {
                Some(error) => match error.status() {
                    Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
                    Some(StatusCode::FORBIDDEN) => return Err(crate::app::api_refused(error)),
                    status => {
                        tracing::warn!("an eBay seller setup was refused: {error}");
                        if status.is_some_and(|s| s.is_client_error()) {
                            StatusCode::UNPROCESSABLE_ENTITY
                        } else {
                            StatusCode::BAD_GATEWAY
                        }
                    }
                },
                None => StatusCode::BAD_GATEWAY,
            };
            let input = SetupInput { posted: Some(draft), failed: true };
            return render(&req, &viewer, &config, &headers, &route.place, false, input, status).await;
        }
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
                        return render(
                            &req,
                            &viewer,
                            &config,
                            &headers,
                            &route.place,
                            true,
                            SetupInput::default(),
                            StatusCode::BAD_GATEWAY,
                        )
                        .await;
                    }
                },
                Err(error) => error,
            }
        }
        _ => {
            return render(
                &req,
                &viewer,
                &config,
                &headers,
                &route.place,
                true,
                SetupInput::default(),
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
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
            render(&req, &viewer, &config, &headers, &route.place, true, SetupInput::default(), status).await
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
