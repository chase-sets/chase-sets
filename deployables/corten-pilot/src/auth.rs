//! Who is asking, and what they may see: the staff session admin-web signed in (the
//! `chase_sets_session` cookie, resolved by `GET /api/auth/session`), the color mode they chose,
//! and admin-web's navigation filtered by the same rules as `resolveWebHostNavItems`.
use std::sync::LazyLock;

use corten::{axum::http::HeaderMap, security::cookie};
use serde::Deserialize;

use crate::api::{Actor, ApiError, Caller};

pub const SESSION_COOKIE: &str = "chase_sets_session";
const COLOR_MODE_COOKIE: &str = "chase_sets_color_mode";

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

/// The color mode the user chose in admin-web (`chase_sets_color_mode`).
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub enum ColorMode {
    #[default]
    System,
    Light,
    Dark,
}

impl ColorMode {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        match cookie::get(headers, COLOR_MODE_COOKIE) {
            Some("light") => ColorMode::Light,
            Some("dark") => ColorMode::Dark,
            _ => ColorMode::System,
        }
    }

    /// `data-theme` on `<html>`; `None` follows the system.
    pub fn theme(self) -> Option<&'static str> {
        match self {
            ColorMode::System => None,
            ColorMode::Light => Some("light"),
            ColorMode::Dark => Some("dark"),
        }
    }
}

/// The session for a request: `None` without a session cookie or when the API says it is not
/// signed in.
pub async fn session(caller: Caller<'_>, color_mode: ColorMode) -> Option<Session> {
    match caller.session().await {
        Ok(Some(Actor { user_id, role_key, permissions })) => {
            Some(Session::Staff(Viewer { user_id, role_key, permissions, color_mode }))
        }
        Ok(None) => None,
        Err(error @ ApiError::Status { .. }) if error.status().is_some_and(|s| s.is_client_error()) => None,
        Err(error) => {
            tracing::warn!("session lookup failed: {error}");
            Some(Session::Unavailable)
        }
    }
}

/// One admin-web primary-nav entry, from `nav.json` (scripts/export.mjs).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavItem {
    #[serde(default)]
    pub section: String,
    pub label: String,
    pub href: Option<String>,
    pub order: i32,
    visibility: String,
    required_permissions: Vec<String>,
    required_permissions_match: String,
    excluded_role_keys: Vec<String>,
    #[serde(default)]
    pub children: Vec<NavItem>,
}

pub static NAV: LazyLock<Vec<NavItem>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../nav.json")).expect("nav.json is the export's output"));

/// admin-web's sections, in its order.
pub const SECTIONS: [&str; 6] = ["access", "catalog", "commerce", "growth", "support", "platform"];

impl NavItem {
    /// `isVisibleForActor` and the role exclusions; a group shows when a child does.
    fn visible(&self, viewer: &Viewer) -> bool {
        let signed_in = self.visibility != "signed-out";
        let permitted = match self.required_permissions_match.as_str() {
            "any" => self.required_permissions.is_empty() || self.required_permissions.iter().any(|p| viewer.can(p)),
            _ => self.required_permissions.iter().all(|p| viewer.can(p)),
        };
        let excluded = self.excluded_role_keys.contains(&viewer.role_key);
        signed_in && permitted && !excluded && (self.children.is_empty() || self.children.iter().any(|c| c.visible(viewer)))
    }
}

/// The section's entries the viewer may see, by order then label, each with its visible children.
pub fn section_items<'a>(viewer: &Viewer, section: &str) -> Vec<(&'a NavItem, Vec<&'a NavItem>)> {
    let mut items: Vec<&NavItem> = NAV.iter().filter(|i| i.section == section && i.visible(viewer)).collect();
    items.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.label.cmp(&b.label)));
    items
        .into_iter()
        .map(|item| {
            let mut children: Vec<&NavItem> = item.children.iter().filter(|c| c.visible(viewer)).collect();
            children.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.label.cmp(&b.label)));
            (item, children)
        })
        .collect()
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
