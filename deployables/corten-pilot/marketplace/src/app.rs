//! The app: who may come in, the shell, and two areas, each with its routes, stylesheet and guard:
//! the seller's inventory screens (`locations`, `restock`) and the buyer's cart (`cart`).
//! Every write is its own typed route (marketplace posts one form with an `intent`). A write the
//! input or the API refuses answers its form again, as a patch or the page (422); one the API
//! applies redirects to its list, carrying the write's receipt and the attempt, which the list
//! confirms (see `recovery`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/inventory/locations?<check>` | the storage locations, and what the last write did |
//! | `POST /account/inventory/locations` | create a location |
//! | `POST /account/inventory/locations/{id}` | save a location |
//! | `POST /account/inventory/locations/{id}/archive` | archive a location |
//! | `GET /account/inventory/restock-decisions?<check>` | the pending restock decisions, and what the last write did |
//! | `POST /account/inventory/restock-decisions/{id}/restock` | restock a decision's items |
//! | `POST /account/inventory/restock-decisions/{id}/write-off` | write them off, with a damage note |
//! | `GET /account/cart` | the account's cart, its readiness and total |
//!
//! `<check>` is `recovery::Check`: `after_write`, `attempt`, `family`, `target` and `user`.
use std::sync::Arc;

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use platform::session;

use crate::{
    api::{ApiError, Platform, segment},
    auth::{self, ColorMode, Session, Viewer},
    cart, locations, restock,
    text::Pilot,
    views,
};

pub const VIEW: &str = "inventory.view";
pub const MANAGE: &str = "inventory.manage";
/// A guest checkout's session (marketplace's `canUseAccountCart`): it has no account cart.
pub const GUEST_CHECKOUT: &str = "guest-checkout.manage";

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

pub type Shared = Arc<Config>;

/// Every URL the pilot serves.
pub mod url {
    use corten::Route;

    use crate::recovery::Check;

    /// The seller's inventory screens: their routes, stylesheet and guard.
    #[derive(Route)]
    #[route("/account/inventory")]
    pub struct InventoryArea;

    /// The buyer's cart: its routes, stylesheet and guard.
    #[derive(Route)]
    #[route("/account/cart")]
    pub struct CartArea;

    /// The account's cart.
    #[derive(Route)]
    #[route("/account/cart")]
    pub struct Cart;

    /// The storage locations, and the write to confirm.
    #[derive(Clone, Debug, Default, Route)]
    #[route("/account/inventory/locations")]
    pub struct Locations {
        #[route(query)]
        pub check: Check,
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

    /// The pending restock decisions, and the write to confirm.
    #[derive(Clone, Debug, Default, Route)]
    #[route("/account/inventory/restock-decisions")]
    pub struct Restock {
        #[route(query)]
        pub check: Check,
    }

    #[derive(Route)]
    #[route("/account/inventory/restock-decisions/{id}/restock")]
    pub struct Restocked<'a> {
        pub id: &'a str,
    }

    #[derive(Route)]
    #[route("/account/inventory/restock-decisions/{id}/write-off")]
    pub struct WrittenOff<'a> {
        pub id: &'a str,
    }
}

/// Marketplace's sign-in, coming back to the screen the request was for (marketplace only returns
/// to its own paths, and the pilot's are marketplace's): the path's first three segments
/// (`/account/inventory/restock-decisions` for a write to one decision).
pub fn sign_in_at(path: &str) -> Option<Uri> {
    let page: String = path.split('/').filter(|s| !s.is_empty()).take(3).map(|s| format!("/{s}")).collect();
    let page = if page.is_empty() { "/".to_owned() } else { page };
    views::marketplace(&format!("/sign-in?returnTo={}", segment(&page)))
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
        // The cart's fallback picture is on marketplace's origin, which is plain http locally (the
        // default policy takes any https image).
        .policy(corten::security::Policy::new().img_src(marketplace_origin()))
        .shell(views::shell)
        .messages::<crate::text::Msg>()
        .components(views::COMPONENTS)
        // Sellers who may see their inventory read the screens; writing needs inventory.manage, as
        // marketplace's actions require. The API checks both again.
        .area::<url::InventoryArea>(|area| {
            restock::routes(locations::routes(area, &shared), &shared).components(views::INVENTORY).guard(|session, req| {
                match session {
                    Some(Session::Account(viewer)) if viewer.actor.can(if req.writes() { MANAGE } else { VIEW }) => Access::ALLOW,
                    Some(Session::Account(_)) => Access::refuse(corten::Error::status(StatusCode::FORBIDDEN)),
                    other => signed_out(other, req.uri().path()),
                }
            })
        })
        // Any signed-in account has a cart. The guest cart is not ported: a visitor without an
        // account, or a guest checkout's session, is sent to marketplace's own cart, which reads it.
        .area::<url::CartArea>(|area| {
            cart::routes(area, &shared).components(views::CART).guard(|session, _| match session {
                Some(Session::Account(viewer)) if !viewer.actor.can(GUEST_CHECKOUT) => Access::ALLOW,
                Some(Session::Unavailable) => Access::refuse(corten::Error::status(StatusCode::BAD_GATEWAY)),
                _ => match views::marketplace("/account/cart") {
                    Some(to) => Access::sign_in(&to),
                    None => Access::refuse(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
                },
            })
        })
        .error_page(views::error_page)
}

/// A guard's answer without an account: the API could not say whose the cookie is (signing in
/// again would loop while it is down), or no one is signed in.
fn signed_out(session: Option<&Session>, path: &str) -> Access {
    match session {
        Some(Session::Unavailable) => Access::refuse(corten::Error::status(StatusCode::BAD_GATEWAY)),
        _ => match sign_in_at(path) {
            Some(to) => Access::sign_in(&to),
            None => Access::refuse(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
        },
    }
}

/// The signed-in seller; the guard let only sellers in.
pub fn viewer(req: &Req) -> Result<&Viewer, corten::Error> {
    match req.context::<Session>() {
        Some(Session::Account(viewer)) => Ok(viewer),
        _ => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// Marketplace's sign-in, for a session the API says has ended (the guard sends the rest there).
pub fn sign_in(req: &Req) -> corten::Result {
    match sign_in_at(req.path()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// A list's read that failed, as the page's answer. After a write, a read that failed for good is
/// marketplace's "could not be verified" (409), in the screen's words (`unverified`): the error
/// page knows only the status, so the screen draws it.
pub fn read_failed(req: &Req, error: ApiError, after_write: Option<&str>) -> corten::Result {
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(StatusCode::FORBIDDEN) => StatusCode::FORBIDDEN,
        _ => match after_write {
            Some(unverified) => {
                tracing::warn!("the read after a write failed: {error}");
                let title = req.t::<Pilot>().error_failed_title();
                return req.page_with_status(StatusCode::CONFLICT, Meta::new(title).noindex(), views::failed(title, unverified));
            }
            None => StatusCode::BAD_GATEWAY,
        },
    };
    Err(corten::Error::new(error).with_status(status))
}
