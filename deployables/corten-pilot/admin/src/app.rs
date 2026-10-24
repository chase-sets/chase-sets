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
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::{receipt::Receipt, session};
use serde::Serialize;

use crate::{
    api::{ApiError, PackagePlan, Platform, Policies as _, Policy, PolicyList, Written},
    auth::{self, ColorMode, Session},
    catalog,
    form::{ActivateInput, CloneInput, PolicyInput, RetireInput, reason},
    text::{Msg, Pilot},
    views::{self, Draft, Forms},
};

const VIEW: &str = "postage-policies.view";
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

pub(crate) type Shared = Arc<Config>;

/// Every URL the pilot serves.
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// The postage-policy screen's area: its routes, stylesheet and guard.
    #[derive(Route)]
    #[route("/commerce/postage-policies")]
    pub struct PostageArea;

    /// The list; `policy` opens its sheet, `after_write` is the receipt of the write before.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route("/commerce/postage-policies")]
    pub struct Policies {
        pub limit: Option<u32>,
        pub offset: Option<u32>,
        pub policy: Option<String>,
        pub after_write: Option<String>,
    }

    #[derive(Route)]
    #[route("/commerce/postage-policies/{id}")]
    pub struct Policy<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/commerce/postage-policies/{id}/revise")]
    pub struct Revise<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/commerce/postage-policies/{id}/activate")]
    pub struct Activate<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/commerce/postage-policies/{id}/retire")]
    pub struct Retire<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/commerce/postage-policies/{id}/clone")]
    pub struct Clone<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/commerce/postage-policies/{id}/preview")]
    pub struct Preview<'a> {
        pub id: &'a str,
    }
}

pub fn app(config: Config) -> App<Session> {
    let shared: Shared = Arc::new(config);
    let context = shared.clone();
    App::new(Router::new())
        .context(move |headers: &HeaderMap| {
            let forward = session::forwarded(headers);
            let color_mode = ColorMode::from_headers(headers);
            let config = context.clone();
            async move {
                let forward = forward?;
                auth::session(config.platform.caller(&forward, config.proto, None), color_mode).await
            }
        })
        // Every route the pilot serves, and any added later, is for signed-in staff; each area
        // then asks for its own permission.
        .guard(move |session, req| match session {
            Some(Session::Staff(_)) => Access::ALLOW,
            // The API could not say whose the cookie is: signing in again would loop while it is down.
            Some(Session::Unavailable) => Access::refuse(corten::Error::status(StatusCode::BAD_GATEWAY)),
            None => match sign_in_at(req.uri().path()) {
                Some(to) => Access::sign_in(&to),
                None => Access::refuse(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            },
        })
        .shell(views::shell)
        .messages::<Msg>()
        .components(views::COMPONENTS)
        .area::<url::PostageArea>(|area| {
            routes(area, shared.clone()).components(views::POSTAGE).guard(|session, _| allow(session, VIEW))
        })
        .area::<catalog::url::Catalog>(|area| {
            catalog::routes(area, shared)
                .components(catalog::views::COMPONENTS)
                .guard(|session, req| allow(session, if req.writes() { catalog::MANAGE } else { catalog::VIEW }))
        })
        .error_page(views::error_page)
}

/// An area's answer: staff with `permission` pass, anyone else is refused (the app's guard has
/// already sent everyone without a session to sign in).
pub(crate) fn allow(session: Option<&Session>, permission: &str) -> Access {
    match session {
        Some(Session::Staff(viewer)) if viewer.can(permission) => Access::ALLOW,
        _ => Access::refuse(corten::Error::status(StatusCode::FORBIDDEN)),
    }
}

fn routes(area: Area<Session, url::PostageArea>, shared: Shared) -> Area<Session, url::PostageArea> {
    area.route::<url::Policies>(get(list).post(create).with_state(shared.clone()))
        .route::<url::Policy>(get(open).with_state(shared.clone()))
        .route::<url::Revise>(post(revise).with_state(shared.clone()))
        .route::<url::Activate>(post(activate).with_state(shared.clone()))
        .route::<url::Retire>(post(retire).with_state(shared.clone()))
        .route::<url::Clone>(post(clone).with_state(shared.clone()))
        .route::<url::Preview>(post(preview).with_state(shared))
}

/// Why a write's API call ends in something other than the form: the guard let the request in,
/// but the API says the session ended meanwhile, or failed.
pub(crate) enum Denied {
    /// Not signed in (or no longer): sign in at admin-web.
    SignIn,
    /// An error page: 403, the API failing, ...
    Error(corten::Error),
}

impl Denied {
    pub(crate) fn answer(self, req: &Req) -> corten::Result {
        match self {
            Denied::SignIn => sign_in(req),
            Denied::Error(error) => Err(error),
        }
    }
}

/// admin-web's sign-in, for a session the API says has ended (the guard sends the rest there).
pub(crate) fn sign_in(req: &Req) -> corten::Result {
    match sign_in_at(req.path()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// A read that failed, as the page's answer.
pub(crate) fn read_failed(req: &Req, error: ApiError, after_write: bool) -> corten::Result {
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

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize)]
pub struct Screen {
    pub policies: PolicyList,
    pub selected: Option<Policy>,
    pub preview: Option<PackagePlan>,
    pub limit: u32,
    pub offset: u32,
}

/// The page for `query`, with `forms` in place of the forms' defaults.
async fn render(req: &Req, config: &Config, headers: &HeaderMap, query: &url::Policies, forms: Forms) -> corten::Result {
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
    req.screen(Meta::new(t.route_title()), &screen, view)
}

async fn list(req: Req, State(config): State<Shared>, headers: HeaderMap, Query(query): Query<url::Policies>) -> corten::Result {
    render(&req, &config, &headers, &query, Forms::default()).await
}

async fn open(req: Req, Path(id): Path<String>) -> corten::Result {
    req.redirect(&url::Policies { policy: Some(id), ..Default::default() })
}

/// The policy's sheet after a write, waiting for the write's projection.
fn written(req: &Req, written: Written) -> corten::Result {
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
async fn invalid(
    req: &Req,
    config: &Config,
    headers: &HeaderMap,
    errors: Errors,
    form: impl Render,
    policy: Option<&str>,
    forms: Forms,
) -> corten::Result {
    let query = url::Policies { policy: policy.map(str::to_owned), ..Default::default() };
    req.invalid(&errors, form, || render(req, config, headers, &query, forms)).await
}

async fn create(req: Req, State(config): State<Shared>, headers: HeaderMap, Form(input): Form<PolicyInput>) -> corten::Result {
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
    invalid(&req, &config, &headers, draft.errors.clone(), form, None, forms).await
}

async fn revise(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<PolicyInput>,
) -> corten::Result {
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
    invalid(&req, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn preview(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<PolicyInput>,
) -> corten::Result {
    let errors = match input.preview_payload(req.t()) {
        Ok((payload, numbers)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match caller.preview(&input.preview(&payload, &numbers)).await {
                Ok(plan) if req.mode == Mode::Action => return req.patch(views::PreviewResult { t: req.t(), plan: Some(&plan) }),
                Ok(plan) => {
                    let query = url::Policies { policy: Some(id), ..Default::default() };
                    let forms =
                        Forms { revise: Some(Draft { input, errors: Errors::new() }), preview: Some(plan), ..Forms::default() };
                    return render(&req, &config, &headers, &query, forms).await;
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
    invalid(&req, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn activate(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<ActivateInput>,
) -> corten::Result {
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
    invalid(&req, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn retire(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<RetireInput>,
) -> corten::Result {
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
    invalid(&req, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}

async fn clone(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<CloneInput>,
) -> corten::Result {
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
    invalid(&req, &config, &headers, draft.errors.clone(), form, Some(&id), forms).await
}
