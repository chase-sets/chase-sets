//! Payout setup on the Seller Desk (Settlement's marketplace `account-desk-settings`,
//! `account-payout-setup.tsx` with `PayoutSetupPage`, `PayoutReadinessPanel` and
//! `StripeConnectNotificationBanner`): the setup's status, what it needs and the steps
//! Settlement works out (`/payout-setup/progress`), Refresh setup status, and Stripe's own setup
//! form (Connect's account onboarding, or account management with `?mode=manage`), with Stripe's
//! payout notifications once the account has a provider account.
//!
//! The page is the server's; only Stripe's components are the script's (`payout_connect.js`), as
//! marketplace's are React's. Each asks the pilot for its session (`POST
//! /account/desk/settings/session`, JSON), which asks Settlement, so Stripe's client secret is never
//! in a page or an address. Leaving Stripe's form (Connect's `onExit`) sends Refresh.
//!
//! What the seller should do next, whether to offer Stripe's form and whether to offer support are
//! Settlement's answers on the readiness read (`next_step`, `provider_setup_available`,
//! `provider_management_available`, `support_recommended`); the page only words them. The
//! requirement groups and the steps are Settlement's too (`/payout-setup/progress`).
//!
//! Stripe's Connect sign-in needs `Cross-Origin-Opener-Policy: unsafe-none`, which the payout
//! setup area allows for its pages only (`allow_cross_origin_opener`, todd-skelton/corten#318).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/desk/settings?mode=manage&setup=updated&returnTo=&afterWrite=` | the page, read after the refresh whose receipt it carries; an account without `payouts.setup` gets "Account access required" (`403`) |
//! | `POST /account/desk/settings` | `intent=refresh-payout-setup`: `303` to the page saying it was refreshed, or to `returnTo` once setup is ready; any other intent goes back to the page |
//! | `POST /account/desk/settings/session?which=` | JSON `{"secret"}` for `onboarding`, `management` or `notifications`, or `{"code","message"}` when Settlement refuses (`step_up_required` asks the seller to sign in again) |
use corten::{
    Local,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{AccountCalls as _, ApiError, ConnectSession, MoneyCalls as _, PayoutReadiness, PayoutSetupProgress, RequirementGroup},
    app::{PAYOUTS_SETUP, Shared, read_failed, sign_in, url},
    auth::{PayoutSetter, Viewer},
    sign_in::destination,
    text::MoneyMsg,
    views::{self, Layout},
};

/// The page's path.
pub const PATH: &str = "/account/desk/settings";

/// What the page's address carries, named as marketplace's: `mode=manage` for account management,
/// `setup=updated` after a refresh, the account page to go back to once setup is ready, and the
/// refresh's receipt.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub mode: Option<String>,
    pub setup: Option<String>,
    pub return_to: Option<String>,
    pub after_write: Option<String>,
}

impl Place {
    /// `returnTo` when it is one of the account's pages on this site (`safeAccountReturnTo`).
    pub fn return_to(&self) -> Option<String> {
        let local = Local::parse(self.return_to.as_deref()?.trim())?.to_string();
        local.starts_with("/account/").then_some(local)
    }

    fn asks_manage(&self) -> bool {
        self.mode.as_deref() == Some("manage")
    }

    /// The page in `mode`, keeping where to go back to (`setupRouteForMode`).
    pub fn of(mode: Mode, return_to: Option<String>) -> Place {
        Place { mode: (mode == Mode::Management).then(|| "manage".into()), return_to, ..Place::default() }
    }
}

/// Which of Stripe's forms the page shows (`PayoutSetupMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Setup,
    Management,
}

impl Mode {
    /// `resolvePayoutSetupMode`: management only for an account with a provider account.
    fn of(place: &Place, readiness: &PayoutReadiness) -> Mode {
        if place.asks_manage() && has_provider(readiness) { Mode::Management } else { Mode::Setup }
    }

    pub fn session(self) -> ConnectSession {
        match self {
            Mode::Setup => ConnectSession::Onboarding,
            Mode::Management => ConnectSession::Management,
        }
    }
}

fn has_provider(readiness: &PayoutReadiness) -> bool {
    readiness.provider_management_available
}

/// What the seller should do next (`recoveryGuidance`): its words' keys in the panel's catalog
/// and its tone, from Settlement's `next_step`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Recovery {
    pub tone: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// The groups' names, for `complete.requested.groups`.
    pub groups: Vec<String>,
}

/// `recoveryGuidance`: the words for Settlement's `next_step`.
pub fn recovery(readiness: &PayoutReadiness, groups: &[RequirementGroup]) -> Option<Recovery> {
    let guide = |tone, title, description| Recovery { tone, title, description, groups: Vec::new() };
    let restricted = |description| Some(guide("warning", "setup.is.restricted", description));
    match readiness.next_step.as_str() {
        "restricted_past_due" => restricted("restricted.past.due"),
        "restricted_review" => restricted("restricted.review"),
        "restricted_rejected" => restricted("restricted.rejected"),
        "restricted_paused" => restricted("restricted.paused"),
        "restricted" => restricted("setup.is.restricted.description"),
        "platform_review" => Some(guide("warning", "platform.review", "platform.review.description")),
        "complete_requirements" => Some(Recovery {
            groups: groups.iter().map(|g| g.id.clone()).collect(),
            ..guide("warning", "setup.details.need.attention", "complete.requested.groups")
        }),
        "add_destination" => Some(guide("warning", "add.a.payout.destination", "add.a.payout.destination.description")),
        "provider_review" => Some(guide("info", "provider.review.in.progress", "provider.review.in.progress.description")),
        "none" if readiness.provider_setup_available => {
            Some(guide("info", "setup.can.continue", "setup.can.continue.description"))
        }
        _ => None,
    }
}

/// Whether the page offers Stripe's form (`canRenderProviderComponent`): Settlement's
/// `provider_setup_available` in setup, `provider_management_available` in management.
pub fn offers_provider(mode: Mode, readiness: &PayoutReadiness) -> bool {
    match mode {
        Mode::Setup => readiness.provider_setup_available,
        Mode::Management => readiness.provider_management_available,
    }
}

/// Whether the page offers support (`showSupportEscalation`): Settlement recommends it, or the
/// last refresh failed.
pub fn offers_support(readiness: &PayoutReadiness, failed: bool) -> bool {
    readiness.support_recommended || failed
}
/// The page: what the API read and what the page works out from it.
#[derive(Serialize, ToJson)]
pub struct SetupScreen {
    pub readiness: PayoutReadiness,
    pub progress: PayoutSetupProgress,
    pub mode: Mode,
    pub recovery: Option<Recovery>,
    pub offers_provider: bool,
    pub offers_support: bool,
    /// Whether the account has a provider account, so Stripe's notifications and Manage details.
    pub has_provider: bool,
    /// Whether the address says a refresh just happened.
    pub refreshed: bool,
    /// Why the last refresh failed.
    pub error: Option<String>,
    /// Stripe's publishable key, which Connect starts with (`STRIPE_PUBLISHABLE_KEY`).
    pub publishable_key: Option<String>,
    pub return_to: Option<String>,
}

/// The account may not set up payouts: marketplace's "Account access required", back to the page.
fn access_required(req: &Req, viewer: &Viewer, place: &Place) -> HtmlResult {
    let t: MoneyMsg = req.t();
    let back = url::PayoutSetup { place: place.clone() }.href();
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.setup_route_account_access_required_title()} head={()}>
            <views::PayoutSetupAccessRequired t={t} back={&back} />
        </Layout>
    };
    req.page_with_status(StatusCode::FORBIDDEN, page)
}

async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    error: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let (readiness, progress) = tokio::join!(caller.payout_readiness(), caller.payout_setup_progress());
    let (readiness, progress) = match (readiness, progress) {
        (Ok(readiness), Ok(progress)) => (readiness, progress),
        (Err(error), _) | (_, Err(error)) => return read_failed(req, Some(viewer), error, place.after_write.as_deref()),
    };
    let mode = Mode::of(place, &readiness);
    let groups = &progress.missing_requirement_groups;
    let screen = SetupScreen {
        recovery: recovery(&readiness, groups),
        offers_provider: offers_provider(mode, &readiness),
        offers_support: offers_support(&readiness, error.is_some()),
        has_provider: has_provider(&readiness),
        refreshed: place.setup.as_deref() == Some("updated"),
        error,
        publishable_key: config.stripe_publishable_key.clone(),
        return_to: place.return_to(),
        mode,
        readiness,
        progress,
    };
    let t: MoneyMsg = req.t();
    let view = html! { <views::PayoutSetupPage t={t} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.setup_route_payout_setup_marketplace()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// The page, read after the refresh whose receipt the address carries.
pub(crate) async fn page(
    req: Req,
    Caller(PayoutSetter(viewer)): Caller<PayoutSetter>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::PayoutSetup>,
) -> HtmlResult {
    if !viewer.actor.can(PAYOUTS_SETUP) {
        return access_required(&req, &viewer, &route.place);
    }
    render(&req, &viewer, &config, &headers, &route.place, None, StatusCode::OK).await
}

/// The page's form: the intent, and the mode it was in.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct SetupForm {
    pub intent: String,
    pub mode: String,
}

pub const REFRESH: &str = "refresh-payout-setup";

/// Refresh setup status (`refresh-payout-setup`): Settlement reads the provider again; the page
/// then says so, read after it, or, once setup is ready, the seller goes back to `returnTo`
/// (marketplace's `navigateAfterWrite`). Any other intent goes back to the page in its mode.
pub(crate) async fn write(
    req: Req,
    Caller(PayoutSetter(viewer)): Caller<PayoutSetter>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::PayoutSetup>,
    Form(form): Form<SetupForm>,
) -> HtmlResult {
    let return_to = route.place.return_to();
    let mode = if form.mode == "management" { Mode::Management } else { Mode::Setup };
    if form.intent != REFRESH {
        return req.redirect(&url::PayoutSetup { place: Place::of(mode, return_to) });
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.refresh_payout_setup().await {
        Ok((readiness, receipt)) => {
            if readiness.status == "ready"
                && let Some(to) = return_to.as_deref().and_then(|to| destination(&req, to))
            {
                return req.redirect(&to);
            }
            let place =
                Place { setup: Some("updated".into()), after_write: receipt.map(|r| r.param()), ..Place::of(mode, return_to) };
            req.redirect(&url::PayoutSetup { place })
        }
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(status) if status.is_client_error() => {
                let t: MoneyMsg = req.t();
                let said =
                    error.refusal().map_or_else(|| t.setup_route_payout_setup_status_could_not().to_owned(), str::to_owned);
                let place = Place::of(mode, return_to);
                render(&req, &viewer, &config, &headers, &place, Some(said), StatusCode::UNPROCESSABLE_ENTITY).await
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}

/// Which session the script asks for.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Which {
    pub which: Option<String>,
}

impl Which {
    pub fn of(session: ConnectSession) -> Which {
        let which = match session {
            ConnectSession::Onboarding => "onboarding",
            ConnectSession::Management => "management",
            ConnectSession::Notifications => "notifications",
        };
        Which { which: Some(which.into()) }
    }
}

/// A Connect session's answer: its secret, or why Settlement refused it.
#[derive(Serialize, ToJson)]
pub struct Session {
    pub secret: Option<String>,
    pub code: Option<String>,
    pub message: Option<String>,
}

/// A Connect session for the script (`fetchEmbeddedClientSecret`,
/// `fetchNotificationBannerClientSecret`): onboarding sends the account's email, as marketplace does.
/// Kept by no cache, since it carries a secret.
pub(crate) async fn session(
    Caller(PayoutSetter(_)): Caller<PayoutSetter>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::PayoutSetupSession>,
) -> NoStore<JsonResult<Session>> {
    let session = match route.which.which.as_deref() {
        Some("management") => ConnectSession::Management,
        Some("notifications") => ConnectSession::Notifications,
        _ => ConnectSession::Onboarding,
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let email = match session {
        ConnectSession::Onboarding => caller.actor_display().await.ok().and_then(|d| d.user.primary_email),
        _ => None,
    };
    let answer = match caller.connect_session(session, email.as_deref()).await {
        Ok(secret) if !secret.trim().is_empty() => Session { secret: Some(secret), code: None, message: None },
        Ok(_) => Session { secret: None, code: Some("missing_secret".into()), message: None },
        Err(error) => refused(error),
    };
    NoStore(Ok(Json(answer)))
}

fn refused(error: ApiError) -> Session {
    Session { secret: None, code: error.code().map(str::to_owned), message: error.refusal().map(str::to_owned) }
}
