//! Who is asking, and what they may see: the staff session admin-web signed in, the color mode
//! they chose, and admin-web's navigation filtered by the same rules as `resolveWebHostNavItems`.
use std::sync::LazyLock;

pub use platform::{
    nav::{self, NavItem},
    session::ColorMode,
};

use crate::api::{Caller, Identity};

/// `App::context`: present for a request with a session cookie.
#[derive(Clone, Debug, Hash)]
pub enum Session {
    Staff(Viewer),
    /// The cookie is there but the API could not say whose it is. Not "signed out": sending the
    /// user to sign in again would loop while the API is down.
    Unavailable,
}

#[derive(Clone, Debug, Hash)]
pub struct Viewer {
    pub user_id: String,
    pub role_key: String,
    pub permissions: Vec<String>,
    pub color_mode: ColorMode,
}

impl Viewer {
    pub fn can(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

/// The session for a request: `None` without a session cookie or when the API says it is not
/// signed in.
pub async fn session(caller: Caller<'_>, color_mode: ColorMode) -> Option<Session> {
    match caller.identify().await {
        Identity::Actor(actor) => Some(Session::Staff(Viewer {
            user_id: actor.user_id,
            role_key: actor.role_key,
            permissions: actor.permissions,
            color_mode,
        })),
        Identity::SignedOut => None,
        Identity::Unknown => Some(Session::Unavailable),
    }
}

/// admin-web's primary-nav contributions, from `nav.json` (scripts/export.mjs).
pub static NAV: LazyLock<Vec<NavItem>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../nav.json")).expect("nav.json is the export's output"));

/// admin-web's sections, in its order.
pub const SECTIONS: [&str; 6] = ["access", "catalog", "commerce", "growth", "support", "platform"];

impl nav::Reader for Viewer {
    fn can(&self, permission: &str) -> bool {
        Viewer::can(self, permission)
    }

    fn role_key(&self) -> &str {
        &self.role_key
    }
}

/// The section's entries the viewer may see, by order then label, each with its visible children.
pub fn section_items(viewer: &Viewer, section: &str) -> Vec<(&'static NavItem, Vec<&'static NavItem>)> {
    nav::visible(NAV.iter().filter(|i| i.section == section), viewer)
}

/// The sections with at least one entry the viewer may see.
pub fn sections(viewer: &Viewer) -> Vec<&'static str> {
    SECTIONS.into_iter().filter(|s| NAV.iter().any(|i| i.section == *s && i.visible(viewer))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(permissions: &[&str]) -> Viewer {
        Viewer {
            user_id: "u".into(),
            role_key: "r".into(),
            permissions: permissions.iter().map(|p| p.to_string()).collect(),
            color_mode: ColorMode::System,
        }
    }

    #[test]
    fn the_nav_follows_admin_webs_rules() {
        let finance = viewer(&["postage-policies.view", "settlement-money-health.view"]);
        let hrefs: Vec<&str> = section_items(&finance, "commerce").iter().filter_map(|(i, _)| i.href.as_deref()).collect();
        assert!(hrefs.contains(&"/postage-policies"), "{hrefs:?}");
        assert!(!hrefs.contains(&"/terms"), "needs commercial-terms.view: {hrefs:?}");
        assert_eq!(sections(&finance), ["commerce"]);
        assert!(sections(&viewer(&[])).is_empty());
        let orders: Vec<i32> = section_items(&finance, "commerce").iter().map(|(i, _)| i.order).collect();
        assert!(orders.windows(2).all(|w| w[0] <= w[1]), "{orders:?}");
    }
}
