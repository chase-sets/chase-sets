//! Who is asking, and what they may see: the staff session admin-web signed in, the color mode
//! they chose, and admin-web's navigation filtered by the same rules as `resolveWebHostNavItems`.
use std::{hash::Hash, marker::PhantomData, sync::LazyLock};

use corten::{
    Identify, Refused,
    axum::http::{Method, request::Parts},
};
use platform::session;
pub use platform::{
    nav::{self, NavItem},
    session::ColorMode,
};

use crate::{api::Identity, app::Shared};

/// What an area asks of who is asking: the permission a request needs, by its method.
pub trait Rule: Clone + Hash + Send + Sync + 'static {
    fn permission(method: &Method) -> &'static str;

    /// Whether `viewer` may make a request with `method`: by default, that they have
    /// [`Rule::permission`]. A rule of more than one permission says so here.
    fn allows(viewer: &Viewer, method: &Method) -> bool {
        viewer.can(Self::permission(method))
    }
}

/// Signed-in staff with the permission `R` says the request needs. Each area's routes module
/// says `caller = Staff<..>`, so every handler there takes one. Anyone else is sent to sign in at
/// admin-web (no session), refused (403) or answered 503 (the API could not say whose the
/// session is: signing in again would loop while it is down).
#[derive(Clone, Debug, Hash)]
pub struct Staff<R> {
    pub viewer: Viewer,
    rule: PhantomData<R>,
}

impl<R: Rule> Identify<Shared> for Staff<R> {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let viewer = viewer(parts, config).await?;
        if !R::allows(&viewer, &parts.method) {
            return Err(Refused::forbidden());
        }
        Ok(Staff { viewer, rule: PhantomData })
    }
}

/// Any signed-in staff member, whatever they may use: the error page's `Option<Caller<Viewer>>`,
/// which draws the nav for who is asking. A handler takes `Staff<..>`, which says what it needs.
impl Identify<Shared> for Viewer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        viewer(parts, config).await
    }
}

/// The signed-in staff member, or why there is none.
async fn viewer(parts: &Parts, config: &Shared) -> Result<Viewer, Refused> {
    let sign_in = || match crate::app::sign_in_at(parts.uri.path()) {
        Some(to) => Refused::sign_in(&to),
        None => Refused::unavailable("admin-web's sign-in address does not parse"),
    };
    let Some(forward) = session::forwarded(&parts.headers) else { return Err(sign_in()) };
    let color_mode = ColorMode::from_headers(&parts.headers);
    match config.platform.caller(&forward, config.proto, None).identify().await {
        Identity::Actor(actor) => {
            Ok(Viewer { user_id: actor.user_id, role_key: actor.role_key, permissions: actor.permissions, color_mode })
        }
        Identity::SignedOut => Err(sign_in()),
        Identity::Unknown => Err(Refused::unavailable("the platform API could not say whose the session is")),
    }
}

/// A rule of one permission, whatever the method.
macro_rules! rules {
    ($($(#[$doc:meta])* $name:ident => $permission:expr;)*) => {$(
        $(#[$doc])*
        #[derive(Clone, Debug, Hash)]
        pub struct $name;

        impl Rule for $name {
            fn permission(_: &Method) -> &'static str {
                $permission
            }
        }
    )*};
}

rules! {
    /// Commerce > Postage policies.
    PostageView => "postage-policies.view";
    /// Platform > Operations attention and Projection operations.
    OperationsView => "projection-operations.view";
    /// Access's home and Accounts (admin-web's access section falls back to `accounts.view`).
    AccountsView => "accounts.view";
    /// Access > Users and API Keys.
    SecurityManage => "security.manage";
    /// Access > Memberships and Invitations.
    MembershipsView => "memberships.view";
    /// Support > Reported Content (its moderation actions too: the API asks for the same).
    ReportedContentView => "reported-content.view";
    /// Support > Reference Lookup (and Support's other operator pages).
    SupportManage => "support.manage";
    /// Support > CSAT dashboard.
    PlatformFeedbackView => "platform-feedback.view";
    /// Growth > Waitlist, Promo Bar and Campaign Analytics (Public Presence's admin API asks for the
    /// same, for reads and writes alike).
    GrowthView => "public-presence.view";
    /// Growth > Google Shopping (its nav entry's permission; Discovery's API asks for
    /// `google-shopping.manage`, which every role with this one holds).
    GoogleShoppingView => "google-shopping.view";
    /// Platform > Insights (Offer Economics and the Ops Dashboard; the API asks for the same).
    InsightsView => "insights-dashboards.view";
    /// Support > Customer Feedback (admin-web's route takes its nav entry's permission).
    SupportView => "support.view";
    /// Platform > Listing Evidence Policy: reading, and every write (each write's own permission is
    /// checked by its handler, as the API checks it).
    EvidenceView => "listing-evidence-policy.view";
}

/// Platform > Policy Console: reading needs `platform-policy.view`, a revision or a review's
/// confirmation `platform-policy.manage`, as the API's routes ask.
#[derive(Clone, Debug, Hash)]
pub struct PolicyAccess;

impl Rule for PolicyAccess {
    fn permission(method: &Method) -> &'static str {
        if method.is_safe() { "platform-policy.view" } else { "platform-policy.manage" }
    }
}

/// Support > Platform Feedback: reading needs `platform-feedback.view`, writing
/// `platform-feedback.manage` (the export's `platform-feedback.export` is checked by its handler).
#[derive(Clone, Debug, Hash)]
pub struct FeedbackAccess;

impl Rule for FeedbackAccess {
    fn permission(method: &Method) -> &'static str {
        if method.is_safe() { "platform-feedback.view" } else { crate::support::feedback::MANAGE }
    }
}

/// Commerce > Return Intake: reading needs `return-intake.view`, writing `return-intake.manage`, as
/// admin-web's loader and action do.
#[derive(Clone, Debug, Hash)]
pub struct IntakeAccess;

impl Rule for IntakeAccess {
    fn permission(method: &Method) -> &'static str {
        if method.is_safe() { "return-intake.view" } else { "return-intake.manage" }
    }
}

/// Commerce > Recovered Returns: reading needs `recovered-inventory.view`, writing
/// `recovered-inventory.manage`, as admin-web's loader and action and Inventory's API do.
#[derive(Clone, Debug, Hash)]
pub struct RecoveredAccess;

impl Rule for RecoveredAccess {
    fn permission(method: &Method) -> &'static str {
        if method.is_safe() { "recovered-inventory.view" } else { "recovered-inventory.manage" }
    }
}

/// Commerce > Commercial Terms: `commercial-terms.view` for the page and its writes, as admin-web's
/// route needs; the API refuses a schedule write without `commercial-terms.manage` and an override
/// write without `commercial-terms.agreements.manage`.
#[derive(Clone, Debug, Hash)]
pub struct TermsAccess;

impl Rule for TermsAccess {
    fn permission(_: &Method) -> &'static str {
        "commercial-terms.view"
    }
}

/// Commerce > Wallet Workbench: `wallet-adjustments.view` for the page and its commands, as
/// admin-web's route needs; each command's own permission (`create`, `approve` or `reverse`) is
/// checked by its handler, as the API checks it.
#[derive(Clone, Debug, Hash)]
pub struct WalletAccess;

impl Rule for WalletAccess {
    fn permission(_: &Method) -> &'static str {
        crate::commerce::wallet::VIEW
    }
}

/// Platform > Provider Connections: `provider-connections.view` held by a `platform-admin`, as
/// admin-web's loader and the API ask (other roles hold the permission too).
#[derive(Clone, Debug, Hash)]
pub struct ProviderConnectionsView;

impl Rule for ProviderConnectionsView {
    fn permission(_: &Method) -> &'static str {
        "provider-connections.view"
    }

    fn allows(viewer: &Viewer, method: &Method) -> bool {
        viewer.role_key == "platform-admin" && viewer.can(Self::permission(method))
    }
}

/// Settlement's `payouts.reconcile`: a reconciliation run, the payout setup's readiness and the
/// provider attempts.
pub const RECONCILE: &str = "payouts.reconcile";

/// Commerce > Money Health and Payout Operations: reading needs `payouts.reconcile` or
/// `payouts.platform.view`, as their nav entries do (`requiredPermissionsMatch: any`); a run needs
/// `payouts.reconcile`, as the API does.
#[derive(Clone, Debug, Hash)]
pub struct PayoutAccess;

impl Rule for PayoutAccess {
    fn permission(_: &Method) -> &'static str {
        RECONCILE
    }

    fn allows(viewer: &Viewer, method: &Method) -> bool {
        viewer.can(RECONCILE) || (method.is_safe() && viewer.can("payouts.platform.view"))
    }
}

/// The catalog area: reading needs `catalog.view`, writing `catalog.manage` (admin-web's
/// actions require it; the API checks both again).
#[derive(Clone, Debug, Hash)]
pub struct CatalogAccess;

impl Rule for CatalogAccess {
    fn permission(method: &Method) -> &'static str {
        if method.is_safe() { crate::catalog::VIEW } else { crate::catalog::MANAGE }
    }
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
