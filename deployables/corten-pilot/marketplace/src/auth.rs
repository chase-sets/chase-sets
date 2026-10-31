//! Who is asking, and what they may see: the session marketplace signed in, the color mode
//! they chose, and marketplace's top nav filtered by the same rules as `resolveWebHostNavItems`.
use std::sync::LazyLock;

use corten::{
    Identify, Refused,
    axum::http::{Uri, request::Parts},
};
pub use platform::{
    api::Actor,
    nav::{self, NavItem},
    session::ColorMode,
};
use platform::{receipt::Receipt, session};

use crate::{
    api::Identity,
    app::{
        ACCOUNTS_MANAGE, ACCOUNTS_VIEW, CHANNELS_MANAGE, CHANNELS_VIEW, FULFILLMENT_MANAGE, FULFILLMENT_VIEW, GUEST_CHECKOUT,
        LISTINGS_MANAGE, LISTINGS_VIEW, MANAGE, MEMBERSHIPS_MANAGE, MEMBERSHIPS_VIEW, OFFERS_MANAGE, OFFERS_VIEW, ORDERS_MANAGE,
        ORDERS_VIEW, PAYOUTS_SETUP, PAYOUTS_VIEW, PRICING_MANAGE, PRICING_VIEW, REPUTATION_MANAGE, REPUTATION_VIEW,
        SECURITY_MANAGE, SUPPORT_MANAGE, SUPPORT_VIEW, Shared, VIEW, sign_in_at, sign_in_back_to,
    },
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

/// Whose the request is: its session, else its guest checkout (a guest has only the guest
/// checkout's cookie, and the API answers with the guest's actor, as marketplace resolves it).
async fn find(parts: &Parts, config: &Shared) -> Found {
    let cookies = [session::SESSION_COOKIE, crate::sign_in::GUEST_CHECKOUT_COOKIE];
    let Some(forward) = session::forwarded_for(&parts.headers, &cookies) else { return Found::SignedOut };
    let color_mode = ColorMode::from_headers(&parts.headers);
    // A session the write just started is read after that write, as marketplace's
    // `resolveActorFromAuthContext` reads it with the address's receipt: an invitation's
    // acceptance or a registration signs in and lands on a page carrying its receipt. When that
    // read fails, it is read again as it stands (`shouldRetryWithoutFreshWrite`).
    let as_it_stands = config.platform.caller(&forward, config.proto, None);
    let found = match after_write(&parts.uri) {
        Some(receipt) => match config.platform.caller(&forward, config.proto, Some(&receipt)).identify().await {
            Identity::Unknown => as_it_stands.identify().await,
            found => found,
        },
        None => as_it_stands.identify().await,
    };
    match found {
        Identity::Actor(actor) => Found::Account(Viewer { actor, color_mode }),
        Identity::SignedOut => Found::SignedOut,
        Identity::Unknown => Found::Unknown,
    }
}

/// The receipt the address carries (`after_write`), while it is fresh.
fn after_write(uri: &Uri) -> Option<Receipt> {
    let value = uri.query()?.split('&').find_map(|pair| pair.strip_prefix("after_write="))?;
    let decoded = percent_encoding::percent_decode_str(value).decode_utf8().ok()?;
    Receipt::from_param(Some(&decoded))
}

/// The sign-in for a request: back to a page itself, its query included (marketplace's
/// `buildCurrentPath`); a write, which the pilot posts to an address of its own, back to its screen.
fn back_to(parts: &Parts) -> Option<Uri> {
    if parts.method.is_safe() {
        sign_in_back_to(parts.uri.path_and_query().map_or("/", |p| p.as_str()))
    } else {
        sign_in_at(parts.uri.path())
    }
}

/// Signing in (the pilot's sign-in), or, for a guest's checkout, marketplace's page: `to`.
fn sign_in(to: Option<Uri>) -> Refused {
    match to {
        Some(to) => Refused::sign_in(&to),
        None => Refused::unavailable("the sign-in address does not parse"),
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
/// signed in is sent to the sign-in, back to the screen.
#[derive(Clone, Debug, Hash)]
pub struct Seller(pub Viewer);

impl Identify<Shared> for Seller {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(if parts.method.is_safe() { VIEW } else { MANAGE }) => Ok(Seller(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on the Seller Desk home: anyone signed in, as marketplace's loader requires (the API
/// checks the queue's permissions and answers 403 without them; the page then shows the queue as
/// unavailable). Anyone not signed in is sent to the sign-in, back to the Desk.
#[derive(Clone, Debug, Hash)]
pub struct DeskSeller(pub Viewer);

impl Identify<Shared> for DeskSeller {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) => Ok(DeskSeller(viewer)),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on the channel screens (Channels' `account-channels` routes): reading needs
/// `channels.view`, as marketplace's loaders require, and writing `channels.manage`, as its actions
/// do (the API checks again). Anyone not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct ChannelsMember(pub Viewer);

impl Identify<Shared> for ChannelsMember {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer)
                if viewer.actor.can(CHANNELS_VIEW) && (parts.method.is_safe() || viewer.actor.can(CHANNELS_MANAGE)) =>
            {
                Ok(ChannelsMember(viewer))
            }
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on the Seller Desk's repricing page (marketplace's `account-desk-repricing`): reading
/// needs `pricing.view`, as the loader requires, and writing `pricing.manage`, as the action does
/// (the API checks again). Anyone not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct PricingManager(pub Viewer);

impl Identify<Shared> for PricingManager {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer)
                if viewer.actor.can(PRICING_VIEW) && (parts.method.is_safe() || viewer.actor.can(PRICING_MANAGE)) =>
            {
                Ok(PricingManager(viewer))
            }
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on bulk reprice (marketplace's `account-bulk-reprice`): reading and writing both need
/// `listings.manage`, as its loader and action require (Pricing checks again). Anyone not signed
/// in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct BulkRepricer(pub Viewer);

impl Identify<Shared> for BulkRepricer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(LISTINGS_MANAGE) => Ok(BulkRepricer(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// Whose cart the request is (marketplace's `canUseAccountCart`): an account's, or a guest's,
/// which is the guest cart the browser carries (`chase_sets_anonymous_cart`). A visitor and a
/// guest checkout have no account cart, so both read and write the guest cart, as marketplace's
/// loader and action do.
#[derive(Clone, Debug, Hash)]
pub enum Buyer {
    Account(Viewer),
    /// A visitor (`None`), or a guest checkout's guest.
    Guest(Option<Viewer>),
}

impl Buyer {
    pub fn viewer(&self) -> Option<&Viewer> {
        match self {
            Buyer::Account(viewer) => Some(viewer),
            Buyer::Guest(viewer) => viewer.as_ref(),
        }
    }

    /// The public pages' session for the same request, for checkout start.
    pub fn session(&self) -> Option<Session> {
        self.viewer().cloned().map(Session::Account)
    }
}

impl Identify<Shared> for Buyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if !viewer.actor.can(GUEST_CHECKOUT) => Ok(Buyer::Account(viewer)),
            Found::Account(viewer) => Ok(Buyer::Guest(Some(viewer))),
            Found::SignedOut => Ok(Buyer::Guest(None)),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer on the buy checkout page: an account, or a guest checkout (`Viewer::guest`), as
/// marketplace's loader reads either; anyone else signs in and comes back to the page.
#[derive(Clone, Debug, Hash)]
pub struct CheckoutBuyer(pub Viewer);

impl Identify<Shared> for CheckoutBuyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) => Ok(CheckoutBuyer(viewer)),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer on its payment's page (Payments' `account-payment`): an account with `orders.view`, as
/// marketplace's loader requires (the API checks again and answers only the account's own
/// payment). A guest checkout has no `orders.view`, so it is refused, as marketplace refuses it: a
/// guest's payment is `/checkout/payments/{id}` (see `payment`). Anyone not signed in signs in and
/// comes back to the page.
#[derive(Clone, Debug, Hash)]
pub struct PaymentBuyer(pub Viewer);

impl Identify<Shared> for PaymentBuyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(ORDERS_VIEW) && !viewer.guest() => Ok(PaymentBuyer(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// An account on its own pages (the notification center): `accounts.view`, as marketplace's
/// loaders and actions require (the API checks again). Anyone not signed in is sent to
/// the sign-in, back to the notification center.
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
/// sent to the sign-in, back to the addresses.
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

/// An account on its own page (`/account`): reading needs `accounts.view`, updating the profile
/// `accounts.manage`, as Identity's loader and action require (the API checks both again). Anyone
/// not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct AccountOwner(pub Viewer);

impl Identify<Shared> for AccountOwner {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { ACCOUNTS_VIEW } else { ACCOUNTS_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(AccountOwner(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A user on its security page (`/account/security`): reading and every write need
/// `security.manage`, as Identity's loader and action require (the API checks it again). Anyone
/// not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct SecurityOwner(pub Viewer);

impl Identify<Shared> for SecurityOwner {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(SECURITY_MANAGE) => Ok(SecurityOwner(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A member on its account's team (`/account/team`): reading needs `memberships.view`, every write
/// `memberships.manage`, as Identity's loader and action require (the API checks both again). Anyone
/// not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct TeamOwner(pub Viewer);

impl Identify<Shared> for TeamOwner {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { MEMBERSHIPS_VIEW } else { MEMBERSHIPS_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(TeamOwner(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// An account on its reviews (`/account/reviews`, `/received`, `/written`): reading needs
/// `reputation.view`, reporting a review `reputation.manage`, as Reputation's loaders and action
/// require (the API checks both again). Anyone not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct ReviewMember(pub Viewer);

impl Identify<Shared> for ReviewMember {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { REPUTATION_VIEW } else { REPUTATION_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(ReviewMember(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on the Seller Desk's money page (Settlement's `account-desk-money`): reading and every
/// write need `payouts.view`, as marketplace's loader and action require; each write checks its own
/// permission too (`payouts.request`, `payouts.reconcile`), and the API checks them all again.
/// Anyone not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct PayoutViewer(pub Viewer);

impl Identify<Shared> for PayoutViewer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(PAYOUTS_VIEW) => Ok(PayoutViewer(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer or seller on a Support Request's page (Platform Operations' `account-support-detail`):
/// reading needs `support.view` and every write `support.manage`, as marketplace's loader and action
/// require; the page then answers Not found to anyone but the case's buyer or seller, and the API
/// checks it all again. Anyone not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct SupportMember(pub Viewer);

impl Identify<Shared> for SupportMember {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { SUPPORT_VIEW } else { SUPPORT_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(SupportMember(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A user on its consent history (`/account/consents`): anyone signed in to an account, as
/// Identity's loader and action require (the API decides which consents it lists and who may
/// withdraw one). Anyone not signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct ConsentHolder(pub Viewer);

impl Identify<Shared> for ConsentHolder {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) => Ok(ConsentHolder(viewer)),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A user on its connected agents (`/account/agents`) and an agent's consent: anyone signed in to
/// an account, as marketplace's routes require (`authenticated`, no permission) and Auth's
/// `/ucp/oauth` routes, which need only an interactive session and keep each grant to its
/// account. The nav shows the entry to `security.manage` only. Anyone not signed in is sent to the
/// sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct AgentHolder(pub Viewer);

impl Identify<Shared> for AgentHolder {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) => Ok(AgentHolder(viewer)),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer on its purchases: reading needs `orders.view`, cancelling `orders.manage`, as
/// marketplace's loader and action require (the API checks both again). Anyone not signed in is
/// sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct OrderBuyer(pub Viewer);

impl Identify<Shared> for OrderBuyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        let permission = if parts.method.is_safe() { ORDERS_VIEW } else { ORDERS_MANAGE };
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(permission) => Ok(OrderBuyer(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// Someone reviewing the other side of an order (`/account/purchases/{id}/review`,
/// `/account/sales/{id}/review`): `reputation.manage` and nothing else, as Reputation's loader and
/// action require. Its routes are a module of their own in the orders' areas.
#[derive(Clone, Debug, Hash)]
pub struct Reviewer(pub Viewer);

impl Identify<Shared> for Reviewer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if viewer.actor.can(REPUTATION_MANAGE) => Ok(Reviewer(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
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
        let may = |actor: &Actor| {
            if parts.method.is_safe() { actor.can(ORDERS_VIEW) && actor.can(LISTINGS_VIEW) } else { actor.can(ORDERS_MANAGE) }
        };
        match find(parts, config).await {
            Found::Account(viewer) if may(&viewer.actor) => Ok(OrderSeller(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
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
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller creating a listing: any account may open the page, which says when it may not
/// manage listings (marketplace's "Account access required", `listings.view`); writing needs
/// `listings.manage`, as marketplace's action requires (the API checks again). Anyone not signed
/// in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct ListingSeller(pub Viewer);

impl Identify<Shared> for ListingSeller {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if parts.method.is_safe() || viewer.actor.can(LISTINGS_MANAGE) => Ok(ListingSeller(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on payout setup (Settlement's `account-desk-settings`): any account may open the page,
/// which says when it may not set up payouts (marketplace's "Account access required",
/// `payouts.setup`); Refresh and a Stripe Connect session need `payouts.setup`, as marketplace's
/// action requires (the API checks again). Anyone not signed in is sent to the sign-in, back to the
/// page.
#[derive(Clone, Debug, Hash)]
pub struct PayoutSetter(pub Viewer);

impl Identify<Shared> for PayoutSetter {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer) if parts.method.is_safe() || viewer.actor.can(PAYOUTS_SETUP) => Ok(PayoutSetter(viewer)),
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on one of its listings (marketplace's `account-listing`): reading needs
/// `listings.view`, as its loader requires, and writing `listings.manage`, as its action does
/// (the API checks again). Anyone not signed in is sent to the sign-in, back to the page.
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
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A seller on their offer matches (marketplace's `account-offer-matches` and
/// `account-offer-match`): reading needs `offers.view` and `listings.view`, as their loaders
/// require, and writing `offers.manage` too, as the action does (the API checks again). Anyone not
/// signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct OfferReviewer(pub Viewer);

impl Identify<Shared> for OfferReviewer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer)
                if viewer.actor.can(OFFERS_VIEW)
                    && viewer.actor.can(LISTINGS_VIEW)
                    && (parts.method.is_safe() || viewer.actor.can(OFFERS_MANAGE)) =>
            {
                Ok(OfferReviewer(viewer))
            }
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

/// A buyer on their submitted offers (marketplace's `account-offers-submitted`): reading needs
/// `offers.view`, as its loader requires, and Pause, Resume and Withdraw `offers.manage`, as its
/// action does (the API checks again). A reader without it sees the offers with no changes to make
/// (marketplace shows them and the API refuses them:
/// [chase-sets/chase-sets#10660](https://github.com/chase-sets/chase-sets/issues/10660)). Anyone not
/// signed in is sent to the sign-in, back to the page.
#[derive(Clone, Debug, Hash)]
pub struct OfferBuyer(pub Viewer);

impl Identify<Shared> for OfferBuyer {
    async fn identify(parts: &Parts, config: &Shared) -> Result<Self, Refused> {
        match find(parts, config).await {
            Found::Account(viewer)
                if viewer.actor.can(OFFERS_VIEW) && (parts.method.is_safe() || viewer.actor.can(OFFERS_MANAGE)) =>
            {
                Ok(OfferBuyer(viewer))
            }
            Found::Account(_) => Err(Refused::forbidden()),
            Found::SignedOut => Err(sign_in(back_to(parts))),
            Found::Unknown => Err(Refused::unavailable(UNKNOWN)),
        }
    }
}

#[derive(Clone, Debug, Hash)]
pub struct Viewer {
    pub actor: Actor,
    pub color_mode: ColorMode,
}

impl Viewer {
    /// A guest checkout, not an account (marketplace's `guest-buyer` role, with
    /// `guest-checkout.manage`).
    pub fn guest(&self) -> bool {
        self.actor.can(GUEST_CHECKOUT) || self.actor.role_key == "guest-buyer"
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
