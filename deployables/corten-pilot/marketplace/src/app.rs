//! Routes and handlers. Every write is its own typed route (marketplace posts one form with an
//! `intent`). A write the input or the API refuses answers its form again, as a patch or the page
//! (422); one the API applies redirects to the list, carrying the write's receipt and the
//! attempt, which the list confirms (see `recovery`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/inventory/locations?after_write&attempt&family&target&user` | the list, and what the last write did |
//! | `POST /account/inventory/locations` | create a location |
//! | `POST /account/inventory/locations/{id}` | save a location |
//! | `POST /account/inventory/locations/{id}/archive` | archive a location |
use std::sync::Arc;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::{receipt::Receipt, session};
use serde::Serialize;

use crate::{
    api::{ApiError, Caller, Inventory as _, Location, Platform},
    auth::{self, ColorMode, Session, Viewer},
    form::LocationInput,
    recovery::{self, Family, Status},
    text::{Msg, Pilot},
    views::{self, Draft, Forms},
};

const VIEW: &str = "inventory.view";
const MANAGE: &str = "inventory.manage";
/// Marketplace's sign-in, coming back to the screen there (marketplace only returns to its own paths).
const SIGN_IN: &str = "/sign-in?returnTo=%2Faccount%2Finventory%2Flocations";

/// Where the pilot finds the platform API. Marketplace's origin is `marketplace_origin()`.
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

/// Marketplace's origin (`MARKETPLACE_WEB_ORIGIN`), for sign-in and the pages the pilot links to.
pub fn marketplace_origin() -> &'static str {
    static ORIGIN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        std::env::var("MARKETPLACE_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:7753".into()).trim_end_matches('/').into()
    });
    &ORIGIN
}

type Shared = Arc<Config>;

/// Every URL the pilot serves.
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    use crate::recovery::Family;

    /// The list. `after_write` is the receipt of the write before; `attempt`, `family`, `target`
    /// and `user` name a write to confirm (`user` only when the browser's record names it).
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route("/account/inventory/locations")]
    pub struct Locations {
        pub after_write: Option<String>,
        pub attempt: Option<String>,
        pub family: Option<Family>,
        pub target: Option<String>,
        pub user: Option<String>,
    }

    #[derive(Route)]
    #[route("/account/inventory/locations/{id}")]
    pub struct Location<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/account/inventory/locations/{id}/archive")]
    pub struct Archive<'a> {
        pub id: &'a str,
    }
}

pub fn app(config: Config) -> App<Session> {
    let shared: Shared = Arc::new(config);
    let context = shared.clone();
    let sign_in_at = views::marketplace(SIGN_IN);
    App::new(routes(shared))
        .context(move |headers: &HeaderMap| {
            let forward = session::forwarded(headers);
            let color_mode = ColorMode::from_headers(headers);
            let config = context.clone();
            async move {
                let forward = forward?;
                auth::session(config.platform.caller(&forward, config.proto, None), color_mode).await
            }
        })
        // Sellers who may see their inventory read the screen; writing needs inventory.manage, as
        // marketplace's action requires. The API checks both again.
        .guard(move |session, req| match session {
            Some(Session::Seller(viewer)) if viewer.actor.can(if req.writes() { MANAGE } else { VIEW }) => Access::ALLOW,
            Some(Session::Seller(_)) => Access::refuse(corten::Error::status(StatusCode::FORBIDDEN)),
            Some(Session::Unavailable) => Access::refuse(corten::Error::status(StatusCode::BAD_GATEWAY)),
            None => match &sign_in_at {
                Some(to) => Access::sign_in(to),
                None => Access::refuse(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            },
        })
        .shell(views::shell)
        .messages::<Msg>()
        .components(views::COMPONENTS)
        .error_page(views::error_page)
}

fn routes(shared: Shared) -> Router {
    Router::new()
        .route(url::Locations::PATH, get(list).post(create))
        .route(url::Location::PATH, post(update))
        .route(url::Archive::PATH, post(archive))
        .with_state(shared)
}

/// The signed-in seller; the guard let only sellers in.
fn viewer(req: &Req) -> Result<&Viewer, corten::Error> {
    match req.context::<Session>() {
        Some(Session::Seller(viewer)) => Ok(viewer),
        _ => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// Marketplace's sign-in, for a session the API says has ended (the guard sends the rest there).
fn sign_in(req: &Req) -> corten::Result {
    match views::marketplace(SIGN_IN) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct Screen {
    pub locations: Vec<Location>,
    /// The locations are not readable yet after a write (marketplace's `onPending`).
    pub pending: bool,
    pub status: Status,
}

/// The page for `query`, with `forms` in place of the forms' defaults.
async fn render(req: &Req, config: &Config, headers: &HeaderMap, query: &url::Locations, forms: Forms) -> corten::Result {
    let viewer = viewer(req)?;
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let status = async {
        if let Some(status) = &forms.status {
            return status.clone();
        }
        match &query.attempt {
            // The attempt's result is read as it is now, without waiting for a projection.
            Some(attempt) => {
                let caller = config.platform.caller(headers, config.proto, None);
                let (family, target, user) = (query.family, query.target.as_deref(), query.user.as_deref());
                recovery::check(&caller, &viewer.actor, attempt, family, target, user).await
            }
            None => Status::Ready,
        }
    };
    let (locations, status) = tokio::join!(caller.locations(), status);
    let (locations, pending) = match locations {
        Ok(list) => (list.items, false),
        // The write's projection is not readable yet: marketplace's pending answer, the page with
        // a message and no list (the receipt stays in the address for 30 seconds).
        Err(error) if receipt.is_some() && error.catching_up() => (Vec::new(), true),
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = Screen { locations, pending, status };
    let t: Msg = req.t();
    let meta = Meta::new(t.route_title()).description(t.route_description());
    // The status's "check again" link: the same check, without the receipt.
    let again = url::Locations { after_write: None, ..query.clone() };
    let view = views::page(t, req.t(), viewer, &screen, again, forms);
    req.screen(meta, &screen, view)
}

/// A read that failed, as the page's answer.
fn read_failed(req: &Req, error: ApiError, after_write: bool) -> corten::Result {
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(StatusCode::FORBIDDEN) => StatusCode::FORBIDDEN,
        // After a write, a read that failed for good: marketplace's "could not be verified" (409).
        _ if after_write => StatusCode::CONFLICT,
        _ => StatusCode::BAD_GATEWAY,
    };
    Err(corten::Error::new(error).with_status(status))
}

async fn list(req: Req, State(config): State<Shared>, headers: HeaderMap, Query(query): Query<url::Locations>) -> corten::Result {
    render(&req, &config, &headers, &query, Forms::default()).await
}

/// Which write a form asks for.
enum Write {
    Create,
    Update(String),
    Archive(String),
}

impl Write {
    fn family(&self) -> Family {
        match self {
            Write::Create => Family::Create,
            Write::Update(_) => Family::Update,
            Write::Archive(_) => Family::Archive,
        }
    }

    /// The attempt's target, as the API keeps it: `draft` for a create, else the location.
    fn target(&self) -> &str {
        match self {
            Write::Create => "draft",
            Write::Update(id) | Write::Archive(id) => id,
        }
    }

    fn archived(&self) -> Option<bool> {
        match self {
            Write::Create => None,
            Write::Update(_) => Some(false),
            Write::Archive(_) => Some(true),
        }
    }
}

async fn create(req: Req, State(config): State<Shared>, headers: HeaderMap, Form(input): Form<LocationInput>) -> corten::Result {
    write(&req, &config, &headers, Write::Create, input).await
}

async fn update(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<LocationInput>,
) -> corten::Result {
    write(&req, &config, &headers, Write::Update(id), input).await
}

async fn archive(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<LocationInput>,
) -> corten::Result {
    write(&req, &config, &headers, Write::Archive(id), input).await
}

/// The list after a write the API applied: it waits for the write's projection and confirms the
/// attempt, so the browser forgets it.
fn applied(req: &Req, write: &Write, attempt: &str, receipt: Option<Receipt>) -> corten::Result {
    req.redirect(&url::Locations {
        after_write: receipt.map(|r| r.param()),
        attempt: Some(attempt.into()),
        family: Some(write.family()),
        target: Some(write.target().into()),
        user: None,
    })
}

/// What a write's failed API call means for the form.
enum Failed {
    /// The API refused the attempt with a message for the user: nothing was applied.
    Refused(Errors),
    /// The API refused this request, but holds a result for its attempt: the same attempt was
    /// applied before (the form was posted again with other fields).
    AppliedBefore,
    /// Not signed in any more: sign in at marketplace.
    SignIn,
    /// No answer, or one that says nothing about the attempt: the error page. The browser keeps
    /// its record and the next page checks it.
    Unknown(corten::Error),
}

async fn failed(caller: &Caller<'_>, write: &Write, attempt: &str, error: ApiError) -> Failed {
    if error.status() == Some(StatusCode::UNAUTHORIZED) {
        return Failed::SignIn;
    }
    let Some(message) = error.refusal() else {
        return Failed::Unknown(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY));
    };
    match caller.attempt(attempt).await {
        Ok(Some(result)) if result.family == write.family().as_str() && result.target_id == write.target() => {
            Failed::AppliedBefore
        }
        Ok(_) => {
            let mut errors = Errors::new();
            errors.add_form(message);
            Failed::Refused(errors)
        }
        Err(lookup) => {
            tracing::warn!("attempt check after a refusal failed: {lookup}");
            Failed::Unknown(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))
        }
    }
}

async fn write(req: &Req, config: &Config, headers: &HeaderMap, write: Write, input: LocationInput) -> corten::Result {
    let p: Pilot = req.t();
    let errors = match input.command(p, write.archived()) {
        Ok(command) => {
            let caller = config.platform.caller(headers, config.proto, None);
            let attempt = input.attempt.as_str();
            let sent = match &write {
                Write::Create => caller.create_location(attempt, &command).await,
                Write::Update(id) | Write::Archive(id) => caller.update_location(attempt, id, &command).await,
            };
            match sent {
                Ok(written) => return applied(req, &write, attempt, written.receipt),
                Err(error) => match failed(&caller, &write, attempt, error).await {
                    Failed::Refused(errors) => errors,
                    Failed::AppliedBefore => return applied(req, &write, attempt, None),
                    Failed::SignIn => return sign_in(req),
                    Failed::Unknown(error) => return Err(error),
                },
            }
        }
        Err(errors) => errors,
    };
    // Nothing was applied: the form again, drawn with a new attempt, and a status that settles
    // the posted one.
    let viewer = viewer(req)?;
    let status = Status::Refused(input.attempt.clone());
    let draft = Draft { input: input.redrawn(recovery::new_attempt()), errors };
    let t: Msg = req.t();
    let patch = views::Refused { t, viewer, write: &write.view(), draft: &draft, status: &status };
    let forms = Forms { status: Some(status.clone()), draft: Some((write.view(), draft.clone())) };
    let page = url::Locations::default();
    req.invalid(&draft.errors, patch, || render(req, config, headers, &page, forms)).await
}

impl Write {
    /// The form in the views.
    fn view(&self) -> views::Which {
        match self {
            Write::Create => views::Which::Create,
            Write::Update(id) => views::Which::Update(id.clone()),
            Write::Archive(id) => views::Which::Archive(id.clone()),
        }
    }
}
