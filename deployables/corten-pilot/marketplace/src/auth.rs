//! Who is asking, and what they may see: the seller session marketplace signed in, the color mode
//! they chose, and marketplace's top nav filtered by the same rules as `resolveWebHostNavItems`.
use std::sync::LazyLock;

pub use platform::{
    api::Actor,
    nav::{self, NavItem},
    session::ColorMode,
};

use crate::api::{Caller, Identity};

/// `App::context`: present for a request with a session cookie.
#[derive(Clone, Debug, Hash)]
pub enum Session {
    Seller(Viewer),
    /// The cookie is there but the API could not say whose it is. Not "signed out": sending the
    /// user to sign in again would loop while the API is down.
    Unavailable,
}

#[derive(Clone, Debug, Hash)]
pub struct Viewer {
    pub actor: Actor,
    pub color_mode: ColorMode,
}

/// The session for a request: `None` without a session cookie or when the API says it is not
/// signed in.
pub async fn session(caller: Caller<'_>, color_mode: ColorMode) -> Option<Session> {
    match caller.identify().await {
        Identity::Actor(actor) => Some(Session::Seller(Viewer { actor, color_mode })),
        Identity::SignedOut => None,
        Identity::Unknown => Some(Session::Unavailable),
    }
}

impl nav::Reader for Viewer {
    fn can(&self, permission: &str) -> bool {
        self.actor.can(permission)
    }

    fn role_key(&self) -> &str {
        &self.actor.role_key
    }
}

/// marketplace-web's top-nav contributions, from `nav.json` (scripts/export.mjs).
pub static NAV: LazyLock<Vec<NavItem>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../nav.json")).expect("nav.json is the export's output"));

/// The top nav the viewer may see, by order then label, each group with its visible entries.
pub fn top_nav(viewer: &Viewer) -> Vec<(&'static NavItem, Vec<&'static NavItem>)> {
    nav::visible(NAV.iter(), viewer)
}
