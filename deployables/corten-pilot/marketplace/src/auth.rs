//! Who is asking, and what they may see: the session marketplace signed in, the color mode
//! they chose, and marketplace's top nav filtered by the same rules as `resolveWebHostNavItems`.
use std::sync::LazyLock;

use corten::{
    Identify, Refused,
    axum::http::{Uri, request::Parts},
};
use platform::session;
pub use platform::{
    api::Actor,
    nav::{self, NavItem},
    session::ColorMode,
};

use crate::{
    api::Identity,
    app::{
        ACCOUNTS_MANAGE, ACCOUNTS_VIEW, FULFILLMENT_MANAGE, FULFILLMENT_VIEW, GUEST_CHECKOUT, LISTINGS_MANAGE, LISTINGS_VIEW,
        MANAGE, ORDERS_MANAGE, ORDERS_VIEW, Shared, VIEW, sign_in_at,
    },
    views,
};

/// Who is asking on the public pages (the item page): `Option<Caller<Session>>`, `None` for a
/// visitor who is not signed in.
#[derive(Clone, Debug, Hash)]
pub enum Session {
    /// Someone signed in.
    Account(Viewer),
    /// The cookie is there but the API could not say whose it is. Not "signed out": sending the
    /// user to sign in again would loop while the API is down, and the page still shows.
    Unavailable,
}

impl Session {
    pub fn viewer(&self) -> Option<&Viewer> {
        match self {
            Session::Account(viewer) => Some(viewer),
            Session::Unavailable => None,
        }
    }
}

/// What the platform API says of the request's session cookie.
enum Found {
    Account(Viewer),
    SignedOut,
    Unknown,
}

async fn find(parts: &Parts, config: &Shared) -> Found {
    let Some(forward) = session::forwarded(&parts.headers) else { return Found::SignedOut };
    let color_mode = ColorMode::from_headers(&parts.headers);
    match config.platform.caller(&forward, config.proto, None).identify().await {
        Identity::Actor(actor) => Found::Account(Viewer { actor, color_mode }),
        Identity::SignedOut => Found::SignedOut,
        Identity::Unknown => Found::Unknown,
    }
}

/// Signing in at marketplace, coming back to `to`.
fn sign_in(to: Option<Uri>) -> Refused {
    match to {
        Some(to) => Refused::sign_in(&to),
        None => Refused::unavailable("marketplace's sign-in address does not parse"),
    }
}

const UNKNOWN: &str = "the platform API could not say whose the session is";

impl Identify<Shared> for Session {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) => Ok(Session::Account(viewer)),
            Found::Unknown => Ok(Session::Unavailable),
            // Read as `Option<Caller<Session>>`: no one.
            Found::SignedOut => Err(Refused::unauthorized()),
        }
    }
}

/// A seller on the inventory screens: reading needs `inventory.view`, writing
/// `inventory.manage`, as marketplace's actions require (the API checks both again). Anyone not
/// signed in is sent to marketplace's sign-in, back to the screen.
#[derive(Clone, Debug, Hash)]
pub struct Seller(pub Viewer);

impl Identify<Shared> for Seller {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(if parts.method.is_safe() { VIEW } else { MANAGE }) => Ok(Seller(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at(parts.uri.path()))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer with an account cart. The guest cart is not ported: a visitor without an account, or a
/// guest checkout's session, is sent to marketplace's own cart, which reads it.
#[derive(Clone, Debug, Hash)]
pub struct Buyer(pub Viewer);

impl Identify<Shared> for Buyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if !viewer.actor.can(GUEST_CHECKOUT) => Ok(Buyer(viewer)),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
            Found::Account(_) | Found::SignedOut => Err(sign_in(views::marketplace("/account/cart"))),
        }
    }
}

/// An account on its own pages (the notification center): `accounts.view`, as marketplace's
/// loaders and actions require (the API checks again). Anyone not signed in is sent to
/// marketplace's sign-in, back to the notification center.
#[derive(Clone, Debug, Hash)]
pub struct Member(pub Viewer);

impl Identify<Shared> for Member {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(ACCOUNTS_VIEW) => Ok(Member(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at("/account/notifications"))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// An account on its shipping addresses: reading needs `accounts.view`, writing `accounts.manage`,
/// as Identity's loader and action require (the API checks both again). Anyone not signed in is
/// sent to marketplace's sign-in, back to the addresses.
#[derive(Clone, Debug, Hash)]
pub struct AddressOwner(pub Viewer);

impl Identify<Shared> for AddressOwner {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { ACCOUNTS_VIEW } else { ACCOUNTS_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(AddressOwner(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at("/account/shipping-addresses"))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer on its purchases: reading needs `orders.view`, cancelling `orders.manage`, as
/// marketplace's loader and action require (the API checks both again). Anyone not signed in is
/// sent to marketplace's sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct OrderBuyer(pub Viewer);

impl Identify<Shared> for OrderBuyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { ORDERS_VIEW } else { ORDERS_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(OrderBuyer(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at(parts.uri.path()))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on its sales: reading needs `orders.view` and `listings.view`, cancelling
/// `orders.manage`, as marketplace's loaders and action require.
#[derive(Clone, Debug, Hash)]
pub struct OrderSeller(pub Viewer);

impl Identify<Shared> for OrderSeller {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let may = |actor: &Actor| match parts.method.is_safe() {
            true => actor.can(ORDERS_VIEW) && actor.can(LISTINGS_VIEW),
            false => actor.can(ORDERS_MANAGE),
        };
        match find(parts, config).await {
            Found::Account(viewer) if may(&viewer.actor) => Ok(OrderSeller(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at(parts.uri.path()))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer or seller on their shipments: reading needs `fulfillment.view`, a shipment's actions
/// `fulfillment.manage`, as Fulfillment's loaders and actions require (the API checks both again).
#[derive(Clone, Debug, Hash)]
pub struct Shipper(pub Viewer);

impl Identify<Shared> for Shipper {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { FULFILLMENT_VIEW } else { FULFILLMENT_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(Shipper(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at(parts.uri.path()))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller creating a listing: any account may open the page, which says when it may not
/// manage listings (marketplace's "Account access required", `listings.view`); writing needs
/// `listings.manage`, as marketplace's action requires (the API checks again). Anyone not signed
/// in is sent to marketplace's sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct ListingSeller(pub Viewer);

impl Identify<Shared> for ListingSeller {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if parts.method.is_safe() || viewer.actor.can(LISTINGS_MANAGE) => Ok(ListingSeller(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at(parts.uri.path()))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on one of its listings (marketplace's `account-listing`): reading needs
/// `listings.view`, as its loader requires, and writing `listings.manage`, as its action does
/// (the API checks again). Anyone not signed in is sent to marketplace's sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct ListingManager(pub Viewer);

impl Identify<Shared> for ListingManager {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer)
                if viewer.actor.can(LISTINGS_VIEW) && (parts.method.is_safe() || viewer.actor.can(LISTINGS_MANAGE)) =>
            {
                Ok(ListingManager(viewer))
            }
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(sign_in_at(parts.uri.path()))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

#[derive(Clone, Debug, Hash)]
pub struct Viewer {
    pub actor: Actor,
    pub color_mode: ColorMode,
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
