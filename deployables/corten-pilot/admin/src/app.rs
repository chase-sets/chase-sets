//! Routes and handlers. Every write is its own typed route (admin-web posts one form with an
//! `intent`); each answers a patch of its form when the input or the API says no, and a
//! redirect to the policy, carrying the write's receipt, when it succeeds.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /commerce/postage-policies?limit&offset&policy&after_write` | the list, and the policy's sheet |
//! | `POST /commerce/postage-policies` | create a draft |
//! | `GET /commerce/postage-policies/{id}` | a redirect to the list with the policy's sheet open |
//! | `POST /commerce/postage-policies/{id}/revise`, `/activate`, `/retire`, `/clone` | the write |
//! | `POST /commerce/postage-policies/{id}/preview` | the package plan, as a patch or the page |
use std::sync::Arc;

use corten::{
    Fragment, LiveResponse, LiveSince,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::StreamExt;
use platform::{realtime::Tick, receipt::Receipt};
use serde::Serialize;

use crate::{
    api::{ApiError, PackagePlan, Platform, Policies as _, Policy, PolicyList, Written},
    auth::{PostageView, Staff, Viewer},
    catalog,
    form::{ActivateInput, CloneInput, PolicyInput, RetireInput, reason},
    text::{Msg, Pilot},
    views::{self, Draft, Forms},
};

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 500;

/// Where the pilot finds the platform API. admin-web's origin is `admin_web_origin()`.
pub struct Config {
    pub platform: Platform,
    /// The scheme browsers use for the pilot, forwarded to the API.
    pub proto: &'static str,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
        Config {
            platform: Platform::new(&var("PLATFORM_API_ORIGIN", "http://localhost:7762")),
            proto: if var("PUBLIC_PROTO", "http") == "https" { "https" } else { "http" },
        }
    }
}

/// admin-web's sign-in, coming back to the page the request was for there: admin-web only
/// returns to its own paths, and the pilot's are admin-web's, so the page is the path's section
/// and screen (`/catalog/dimensions` for `/catalog/dimensions/dim_1/edit`).
pub(crate) fn sign_in_at(path: &str) -> Option<corten::axum::http::Uri> {
    let page: String = path.split('/').filter(|s| !s.is_empty()).take(2).map(|s| format!("/{s}")).collect();
    let page = if page.is_empty() { "/".to_owned() } else { page };
    views::admin_web(&format!("/access/sign-in?returnTo={}", crate::api::segment(&page)))
}

/// admin-web's origin (`ADMIN_WEB_ORIGIN`), for sign-in and the admin pages the pilot links to.
pub fn admin_web_origin() -> &'static str {
    static ORIGIN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        std::env::var("ADMIN_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:7752".into()).trim_end_matches('/').into()
    });
    &ORIGIN
}

/// Marketplace's origin (`CHASE_SETS_MARKETPLACE_ORIGIN`), for the payout pages' links to a payout;
/// none when it is not set, and then there are no links, as on admin-web.
pub fn marketplace_origin() -> Option<&'static str> {
    static ORIGIN: std::sync::LazyLock<Option<String>> = std::sync::LazyLock::new(|| {
        std::env::var("CHASE_SETS_MARKETPLACE_ORIGIN").ok().map(|o| o.trim().to_owned()).filter(|o| !o.is_empty())
    });
    ORIGIN.as_deref()
}

pub(crate) type Shared = Arc<Config>;

/// Every URL the postage screen serves, with its handlers. The list is the area's route: its
/// routes, its stylesheet, and the caller every handler takes (staff who may see postage policies).
#[corten::routes(state = Shared, area = Policies, caller = Staff<PostageView>)]
pub mod url {
    use serde::Deserialize;

    /// The list; `policy` opens its sheet, `after_write` is the receipt of the write before.
    #[derive(Clone, Debug, Default, Deserialize)]
    #[route("/commerce/postage-policies", get = list, post = create)]
    pub struct Policies {
        pub limit: Option<u32>,
        pub offset: Option<u32>,
        pub policy: Option<String>,
        pub after_write: Option<String>,
    }

    #[route("/commerce/postage-policies/{id}", get = open)]
    pub struct Policy<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/postage-policies/{id}/revise", post = revise)]
    pub struct Revise<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/postage-policies/{id}/activate", post = activate)]
    pub struct Activate<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/postage-policies/{id}/retire", post = retire)]
    pub struct Retire<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/postage-policies/{id}/clone", post = clone)]
    pub struct Clone<'a> {
        pub id: &'a str,
    }

    #[route("/commerce/postage-policies/{id}/preview", post = preview)]
    pub struct Preview<'a> {
        pub id: &'a str,
    }
}

// The app's `static/` directory, compiled into the program, so the binary is the whole deploy
// (todd-skelton/corten#268).
corten::assets::embed!(pub struct Static = "static");

/// The pilot: every screen is an area whose routes module says which staff may use it
/// (`caller = Staff<..>`), so every route there, and any added later, takes that caller. Nothing
/// is served outside an area but Corten's own (health, the runtime, assets, the PWA's manifest and
/// worker) and the favicon; the offline page is an area for everyone (see `site`).
pub fn app(config: Config) -> App {
    let shared: Shared = Arc::new(config);
    App::new(crate::site::files::router(shared.clone()))
        .assets(Static)
        .pwa(crate::site::pwa())
        .messages::<Msg>()
        // Return Intake reads a receipt time in the operator's zone.
        .client_zone()
        .components(views::COMPONENTS)
        .area(|area| url::area(area, shared.clone()).components(views::POSTAGE))
        .area(|area| crate::operations::area(area, shared.clone()))
        .area(|area| crate::projections::area(area, shared.clone()))
        .area(|area| crate::providers::area(area, shared.clone()))
        .area(|area| crate::insights::area(area, shared.clone()))
        .area(|area| crate::insights::ops::area(area, shared.clone()))
        .area(|area| crate::policy_console::area(area, shared.clone()))
        .area(|area| crate::evidence::area(area, shared.clone()))
        .area(|area| catalog::area(area, shared.clone()))
        .area(|area| crate::access::area(area, shared.clone()))
        .area(|area| crate::reported::area(area, shared.clone()))
        .area(|area| crate::reported::risk::area(area, shared.clone()))
        .area(|area| crate::support::area(area, shared.clone()))
        .area(|area| crate::support::csat::area(area, shared.clone()))
        .area(|area| crate::support::feedback::area(area, shared.clone()))
        .area(|area| crate::support::requests::area(area, shared.clone()))
        .area(|area| crate::support::ebay::area(area, shared.clone()))
        .area(|area| crate::support::attention::area(area, shared.clone()))
        .area(|area| crate::commerce::intake::area(area, shared.clone()))
        .area(|area| crate::commerce::recovered::area(area, shared.clone()))
        .area(|area| crate::commerce::terms::area(area, shared.clone()))
        .area(|area| crate::commerce::payouts::health_area(area, shared.clone()))
        .area(|area| crate::commerce::payouts::area(area, shared.clone()))
        .area(|area| crate::commerce::wallet::area(area, shared.clone()))
        .area(|area| crate::growth::google_shopping::area(area, shared.clone()))
        .area(|area| crate::growth::waitlist::area(area, shared.clone()))
        .area(|area| crate::growth::campaign::area(area, shared.clone()))
        .area(|area| crate::growth::promo::area(area, shared.clone()))
        .area(|area| crate::site::offline_page::area(area, shared.clone()).components(views::OFFLINE))
        .error_page(views::error_page, shared)
}

/// Why a write's API call ends in something other than the form: the caller was found,
/// but the API says the session ended meanwhile, or failed.
pub(crate) enum Denied {
    /// Not signed in (or no longer): sign in at admin-web.
    SignIn,
    /// An error page: 403, the API failing, ...
    Error(corten::Error),
}

impl Denied {
    pub(crate) fn answer(self, req: &Req) -> HtmlResult {
        match self {
            Denied::SignIn => sign_in(req),
            Denied::Error(error) => Err(error),
        }
    }
}

/// admin-web's sign-in, for a session the API says has ended (`Staff::identify` sends the rest there).
pub(crate) fn sign_in(req: &Req) -> HtmlResult {
    match sign_in_at(req.path()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// A read that failed, as the page's answer.
pub(crate) fn read_failed(req: &Req, error: ApiError, after_write: bool) -> HtmlResult {
    // The write's projection is not readable yet: admin-web's "pending" answer, which asks the
    // user to refresh (the receipt stays in the address for 30 seconds).
    if after_write && error.catching_up() {
        return Err(corten::Error::new(error).with_status(StatusCode::SERVICE_UNAVAILABLE));
    }
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(StatusCode::FORBIDDEN) => StatusCode::FORBIDDEN,
        Some(StatusCode::NOT_FOUND) => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_GATEWAY,
    };
    Err(corten::Error::new(error).with_status(status))
}

/// What a refused write answers.
pub(crate) enum Refusal {
    /// The page again with the API's words, at this status: the API's for a refusal it names,
    /// else 422.
    Again(StatusCode, String),
    /// The session ended: sign in.
    SignIn,
    /// The API failed: a bad gateway.
    Failed(ApiError),
}

/// A failed write as what it answers.
pub(crate) fn refusal(req: &Req, error: ApiError) -> Refusal {
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return Refusal::SignIn,
        Some(status) if status.is_client_error() => status,
        _ => return Refusal::Failed(error),
    };
    let p: crate::text::Pilot = req.t();
    let message = error.refusal().unwrap_or(p.access_refused()).to_owned();
    let status = match status {
        StatusCode::CONFLICT | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => status,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    Refusal::Again(status, message)
}

/// A failed write's answer when it is not the page again.
pub(crate) fn refusal_answer(req: &Req, refusal: Refusal) -> HtmlResult {
    match refusal {
        Refusal::SignIn => sign_in(req),
        Refusal::Failed(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        Refusal::Again(status, _) => Err(corten::Error::status(status)),
    }
}

/// A page's live part for `<corten-live>` (a list's rows, a queue), drawn on each change to `topic`
/// until the API refuses the stream. Each fragment carries the realtime stream's cursor after it, so a browser that
/// reconnects (`since`, from its `Last-Event-ID`) gets what changed while it was away, and
/// nothing when nothing did. A first connection has no cursor (the page's read does not give one),
/// so the part is drawn once the stream is open: a change after the page was drawn is not missed.
/// A read that fails sends nothing, and the part stays as it was.
pub(crate) fn live_rows<F, Fut>(
    config: Shared,
    headers: HeaderMap,
    since: LiveSince,
    topic: &'static str,
    rows: F,
) -> LiveResponse
where
    F: Fn(Shared, HeaderMap) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    let resumed = since.0.is_some();
    let changes = config.platform.caller(&headers, config.proto, None).changes(&[topic], since.0);
    let fragments = changes
        .take_while(|tick| std::future::ready(!matches!(tick, Tick::Refused(_))))
        .filter_map(move |tick| {
            std::future::ready(match tick {
                Tick::Opened(_) if resumed => None,
                Tick::Opened(cursor) | Tick::Changed(cursor, _) => Some(cursor),
                Tick::Refused(_) => None,
            })
        })
        .then(move |cursor| {
            let rows = rows(config.clone(), headers.clone());
            async move {
                let html = rows.await?;
                Some(match cursor {
                    Some(cursor) => Fragment::new(html).cursor(cursor),
                    None => Fragment::new(html),
                })
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct Screen {
    pub policies: PolicyList,
    pub selected: Option<Policy>,
    pub preview: Option<PackagePlan>,
    pub limit: u32,
    pub offset: u32,
}

/// The page for `query`, with `forms` in place of the forms' defaults.
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    query: &url::Policies,
    forms: Forms,
) -> HtmlResult {
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0);
    let selected = async {
        match &query.policy {
            Some(id) => caller.get(id).await.map(Some),
            None => Ok(None),
        }
    };
    let (policies, selected) = tokio::join!(caller.list(limit, offset), selected);
    let (policies, selected) = match (policies, selected) {
        (Ok(policies), Ok(selected)) => (policies, selected),
        (Err(error), _) | (_, Err(error)) => return read_failed(req, error, receipt.is_some()),
    };
    let preview = forms.preview.clone();
    let screen = Screen { policies, selected, preview, limit, offset };
    let t: Msg = req.t();
    let view = views::page(t, req.t(), &screen, forms);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_title()} head="">{view}</crate::views::Layout>
        },
    )
}

async fn list(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Policies>,
) -> HtmlResult {
    let query = url::Policies { limit: route.limit, offset: route.offset, policy: route.policy, after_write: route.after_write };
    render(&req, &staff.viewer, &config, &headers, &query, Forms::default()).await
}

async fn open(req: Req, _: Caller<Staff<PostageView>>, Params(route): Params<crate::app::url::Policy<'_>>) -> HtmlResult {
    let id = route.id;
    req.redirect(&url::Policies { policy: Some(id), ..Default::default() })
}

/// The policy's sheet after a write, waiting for the write's projection.
fn written(req: &Req, written: Written) -> HtmlResult {
    req.redirect(&url::Policies {
        policy: Some(written.id),
        after_write: written.receipt.map(|r| r.param()),
        ..Default::default()
    })
}

/// A write the API refused with a message for the user, or the answer for any other failure.
pub(crate) fn refused(error: ApiError) -> Result<Errors, Denied> {
    match error.refusal() {
        Some(message) => {
            let mut errors = Errors::new();
            errors.add_form(message);
            Ok(errors)
        }
        None if error.status() == Some(StatusCode::UNAUTHORIZED) => Err(Denied::SignIn),
        None => Err(Denied::Error(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))),
    }
}

/// 422: the form with its errors as a patch, or the whole page without JavaScript.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn invalid(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    errors: Errors,
    form: impl Patch,
    policy: Option<&str>,
    forms: Forms,
) -> HtmlResult {
    let query = url::Policies { policy: policy.map(str::to_owned), ..Default::default() };
    req.invalid(&errors, form, || render(req, viewer, config, headers, &query, forms)).await
}

async fn create(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<PolicyInput>,
) -> HtmlResult {
    let pilot: Pilot = req.t();
    let errors = match input.command(pilot) {
        Ok(command) => match config.platform.caller(&headers, config.proto, None).create(&command).await {
            Ok(done) => return written(&req, done),
            Err(error) => match refused(error) {
                Ok(errors) => errors,
                Err(denied) => return denied.answer(&req),
            },
        },
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::CreateForm { t: req.t(), form: &draft };
    let forms = Forms { create: Some(draft.clone()), ..Forms::default() };
    invalid(&req, &staff.viewer, &config, &headers, draft.errors.clone(), form, None, forms).await
}

async fn revise(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::Revise<'_>>,
    Form(input): Form<PolicyInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.command(req.t()) {
        Ok(command) => match config.platform.caller(&headers, config.proto, None).revise(&id, &command).await {
            Ok(done) => return written(&req, done),
            Err(error) => match refused(error) {
                Ok(errors) => errors,
                Err(denied) => return denied.answer(&req),
            },
        },
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::ReviseForm { t: req.t(), id: &id, form: &draft };
    let forms = Forms { revise: Some(draft.clone()), ..Forms::default() };
    invalid(&req, &staff.viewer, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn preview(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::Preview<'_>>,
    Form(input): Form<PolicyInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.preview_payload(req.t()) {
        Ok((payload, numbers)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match caller.preview(&input.preview(&payload, &numbers)).await {
                Ok(plan) if req.mode == Mode::Action => return req.patch(views::PreviewResult { t: req.t(), plan: Some(&plan) }),
                Ok(plan) => {
                    let query = url::Policies { policy: Some(id), ..Default::default() };
                    let forms =
                        Forms { revise: Some(Draft { input, errors: Errors::new() }), preview: Some(plan), ..Forms::default() };
                    return render(&req, &staff.viewer, &config, &headers, &query, forms).await;
                }
                Err(error) => match refused(error) {
                    Ok(errors) => errors,
                    Err(denied) => return denied.answer(&req),
                },
            }
        }
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::ReviseForm { t: req.t(), id: &id, form: &draft };
    let forms = Forms { revise: Some(draft.clone()), ..Forms::default() };
    invalid(&req, &staff.viewer, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn activate(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::Activate<'_>>,
    Form(input): Form<ActivateInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match reason(req.t(), ActivateInput::FIELDS.activation_reason, &input.activation_reason) {
        Ok(text) => match config.platform.caller(&headers, config.proto, None).activate(&id, &text).await {
            Ok(done) => return written(&req, done),
            Err(error) => match refused(error) {
                Ok(errors) => errors,
                Err(denied) => return denied.answer(&req),
            },
        },
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    // The status decides whether the button is enabled; the form only failed, so it stays enabled.
    let form = views::ActivateForm { t: req.t(), id: &id, enabled: true, form: &draft };
    let forms = Forms { activate: Some(draft.clone()), ..Forms::default() };
    invalid(&req, &staff.viewer, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn retire(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::Retire<'_>>,
    Form(input): Form<RetireInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match reason(req.t(), RetireInput::FIELDS.retirement_reason, &input.retirement_reason) {
        Ok(text) => match config.platform.caller(&headers, config.proto, None).retire(&id, &text).await {
            Ok(done) => return written(&req, done),
            Err(error) => match refused(error) {
                Ok(errors) => errors,
                Err(denied) => return denied.answer(&req),
            },
        },
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::RetireForm { t: req.t(), id: &id, enabled: true, form: &draft };
    let forms = Forms { retire: Some(draft.clone()), ..Forms::default() };
    invalid(&req, &staff.viewer, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn clone(
    req: Req,
    Caller(staff): Caller<Staff<PostageView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::Clone<'_>>,
    Form(input): Form<CloneInput>,
) -> HtmlResult {
    let id = route.id;
    let errors = match input.command(req.t()) {
        Ok(command) => match config.platform.caller(&headers, config.proto, None).clone_policy(&id, &command).await {
            Ok(done) => return written(&req, done),
            Err(error) => match refused(error) {
                Ok(errors) => errors,
                Err(denied) => return denied.answer(&req),
            },
        },
        Err(errors) => errors,
    };
    let draft = Draft { input, errors };
    let form = views::CloneForm { t: req.t(), id: &id, form: &draft };
    let forms = Forms { clone: Some(draft.clone()), ..Forms::default() };
    invalid(&req, &staff.viewer, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}
