//! The app: three areas, each with its routes, stylesheet and the caller its handlers take: the
//! seller's inventory screens (`locations`, `restock`), the buyer's cart (`cart`) and the public
//! item page (`items`).
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
//! | `GET /account/cart?after_write=..` | the account's cart, or a guest's, its readiness and total |
//! | `POST /account/cart/quantity` | a line's quantity, one step down or up |
//! | `POST /account/cart/remove` | remove a line |
//! | `POST /account/cart/lock` | lock a line to its preferred listing |
//! | `POST /account/cart/checkout` | start a checkout session (a guest's through checkout start), then the checkout |
//! | `GET /checkout/buy/readiness?<entry>`, `POST ..` | checkout start for a listing, an offer or the cart, and Continue (see `checkout_start`) |
//! | `GET /checkout/payments/{id}?<place>`, `POST ..`, `../status?<watch>` | a guest checkout's payment, its Retry payment and its status part (see `payment`) |
//! | `GET /items/{slug}?<choice>` | an item, its product options and its market book, to anyone |
//! | `POST /items/{slug}/cart`, `/buy`, `/offer`, `/sell-list`, `/watch` | the rail's buy, sell and watch forms |
//! | `POST /items/{slug}/save` | Add to List: add the product to a Saved List, or a guest's intent |
//! | `POST /items/{slug}/list`, `/ship-from` | list the product at a price, and the ship-from setup it needs |
//! | `GET /account/purchases`, `/account/sales` and each order's page, `POST ../{id}/cancel` | the account's orders (see `orders`) |
//! | `GET /account/shipments`, each buyer and sale shipment's page | the account's shipments (see `shipments`) |
//! | `GET /account?<place>`, `POST /account` | the account's own page and its profile's update (see `account_home`) |
//! | `GET /account/sessions?<filters>`, `../{id}?<place>`, `POST ../{id}/revoke`, `../{id}/switch` | the user's sessions (see `sessions`) |
//! | `GET /account/agents`, `../{id}?<place>`, `POST ../{id}/revoke`, `../mandate`, `../webhook`, `../webhook/disable`, `GET /account/agents/consent`, `POST ..`, `GET`, `POST /ucp/oauth/authorize` | the account's connected agents, their writes and an agent's consent (see `agents`) |
//! | `GET /account/security?<place>`, `POST ..` | the user's names and API keys, and their writes (see `security`) |
//! | `GET /account/team?<place>`, `POST ..` | the account's members and invitations, and their writes (see `team`) |
//! | `GET /account/consents?<place>`, `POST ..` | the user's consent history, and withdrawing a consent (see `consents`) |
//! | `GET /account/reviews`, `/received?<place>`, `/written?<place>`, `POST ..` | the account's review summary and lists, and reporting a review (see `reviews`) |
//! | `GET /account/reviews/{id}?<place>`, `POST ..` | a review, reporting it and replying to it (see `review`) |
//! | `GET /account/shipping-addresses`, `POST ..`, `../{id}`, `../{id}/default`, `../{id}/archive` | the account's shipping addresses (see `addresses`) |
//! | `GET /account/listings/new?<form>`, `POST ..` | Create listing, with its photos (see `listing_new`) |
//! | `GET /account/listings/{id}?<place>`, `POST ..`, `POST ../photos` | the seller's listing and its writes (see `seller_listing`) |
//! | `GET /account/channels?<place>`, `POST ..`, `../{id}?after_write=..`, `POST ../{id}`, `../publication`, `../publication/{id}?<place>`, `POST ..`, `POST ../{id}/manual-sync`, `../ingest`, `../download` | the channel connections, Connect, a connection's writes and manual sync, the publication list and a connection's publication with its writes (see `channels`) |
//! | `GET /search?<terms>` | marketplace search: the results for the words, filters and sort, to anyone |
//! | `GET /categories/{slug}?<terms>` | the same, in a category |
//! | `GET /sign-in?<ask>`, `POST ..` | signing in: the email or phone, its methods and their forms (see `sign_in`) |
//! | `GET /sign-in/magic?token=..` | a magic link's landing |
//! | `GET /account/select`, `POST ..` | the account a sign-in acts for |
//! | `POST /sign-out` | signing out |
//! | `GET /robots.txt` | the crawler rules, and the sitemap index when the site may be indexed (see `site`) |
//! | `GET /sitemap.xml`, `/sitemap/{kind}/{page}.xml` | the sitemap index and its pages: the home page and search, then Discovery's public pages |
//! | `GET /favicon.svg`, `/favicon.ico` | the design system's logo (`Public`, a day) |
//! | `GET /.well-known/appspecific/com.chrome.devtools.json` | nothing (204, `no-store`), so Chrome stops asking |
//! | `GET /manifest.webmanifest`, `/service-worker.js` | the web app manifest and the service worker (Corten's, `pwa`) |
//! | `GET /offline` | the page the service worker shows for a navigation it cannot make |
//!
//! `<check>` is `recovery::Check`: `after_write`, `attempt`, `family`, `target` and `user`;
//! `<choice>` is `items::Address`: `market`, `listing`, `offer`, `book` and `dimension.<id>`;
//! `<terms>` is `search::Terms`: `q`, `tag`, `language`, `marketActivity`, `priceMin`,
//! `priceMax`, `inStock`, `sort`, `field.<id>`, `reference.<id>`, `dimension.<id>`,
//! `interpreted` and `more`.
use std::sync::Arc;

use corten::{
    axum::http::{StatusCode, Uri},
    prelude::*,
};

use crate::{
    api::{ApiError, Platform},
    auth::Viewer,
    text::Pilot,
    views,
};

pub const VIEW: &str = "inventory.view";
pub const MANAGE: &str = "inventory.manage";
/// A guest checkout's session (marketplace's `canUseAccountCart`): it has no account cart.
pub const GUEST_CHECKOUT: &str = "guest-checkout.manage";
/// An account's own pages (the notification center), as marketplace's loaders require.
pub const ACCOUNTS_VIEW: &str = "accounts.view";
/// Changing them (the shipping addresses' writes).
pub const ACCOUNTS_MANAGE: &str = "accounts.manage";
/// The account's orders, as marketplace's order loaders and actions require.
pub const ORDERS_VIEW: &str = "orders.view";
pub const ORDERS_MANAGE: &str = "orders.manage";
/// The wallet, which checkout applies to the payable total (marketplace's checkout loader), and the
/// Seller Desk's money page.
pub const PAYOUTS_VIEW: &str = "payouts.view";
/// On the money page: Request a payout, Manage payout account, and Retry and Check status.
pub const PAYOUTS_REQUEST: &str = "payouts.request";
pub const PAYOUTS_SETUP: &str = "payouts.setup";
pub const PAYOUTS_RECONCILE: &str = "payouts.reconcile";
/// A sale's pages need it too (marketplace's `account-sale` and `account-sales` loaders).
pub const LISTINGS_VIEW: &str = "listings.view";
/// Creating a listing (marketplace's `account-listings-new` action).
pub const LISTINGS_MANAGE: &str = "listings.manage";
/// The Seller Desk's repricing page: to see its policies, and to change them or the halt.
pub const PRICING_VIEW: &str = "pricing.view";
pub const PRICING_MANAGE: &str = "pricing.manage";
/// The channel screens: to see the connections, and to connect, activate, pause, resume or disconnect one.
pub const CHANNELS_VIEW: &str = "channels.view";
pub const CHANNELS_MANAGE: &str = "channels.manage";
/// The seller's offer matches: to see them, and to add one to the sell list or decline it.
pub const OFFERS_VIEW: &str = "offers.view";
pub const OFFERS_MANAGE: &str = "offers.manage";
/// The user's security page: to see it, update the user's names, and create, rotate or revoke its
/// API keys (Identity's `account-security` loader and action).
pub const SECURITY_MANAGE: &str = "security.manage";
/// The account's team: to see its members and invitations, and to invite, cancel an invitation,
/// change a role, revoke or reinstate a membership (Identity's `account-team` loader and action).
pub const MEMBERSHIPS_VIEW: &str = "memberships.view";
/// The account's reviews: to read them, and to report one (Reputation's review loaders and action).
pub const REPUTATION_VIEW: &str = "reputation.view";
pub const REPUTATION_MANAGE: &str = "reputation.manage";
pub const MEMBERSHIPS_MANAGE: &str = "memberships.manage";
/// The account's shipments (Fulfillment's marketplace loaders and actions).
pub const FULFILLMENT_VIEW: &str = "fulfillment.view";
pub const FULFILLMENT_MANAGE: &str = "fulfillment.manage";
/// A Support Request's participant page: to read it, and to act on it (Platform Operations'
/// `account-support-detail` loader and action).
pub const SUPPORT_VIEW: &str = "support.view";
pub const SUPPORT_MANAGE: &str = "support.manage";

/// Where the pilot finds the platform API. Marketplace's origin is `marketplace_origin()`.
pub struct Config {
    pub platform: Platform,
    /// The scheme browsers use for the pilot, forwarded to the API.
    pub proto: &'static str,
    /// Stripe's publishable key, which payout setup's Connect components start with
    /// (`STRIPE_PUBLISHABLE_KEY`, as marketplace reads it); without it the page says setup is not
    /// configured.
    pub stripe_publishable_key: Option<String>,
    /// Whether crawlers may index the site (`CHASE_SETS_MARKETPLACE_INDEXING`, `shouldIndexFromEnv`:
    /// anything but `0`, `false`, `no` or `off`).
    pub indexing: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
        Config {
            platform: Platform::new(&var("PLATFORM_API_ORIGIN", "http://localhost:7762")),
            proto: if var("PUBLIC_PROTO", "http") == "https" { "https" } else { "http" },
            stripe_publishable_key: std::env::var("STRIPE_PUBLISHABLE_KEY")
                .ok()
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty()),
            indexing: indexing(std::env::var("CHASE_SETS_MARKETPLACE_INDEXING").ok().as_deref()),
        }
    }

    /// The API's calls for no one in particular, as if for marketplace's own host: a `Public`
    /// handler's, which cannot read the request's cookies or host.
    pub fn anonymous(&self) -> crate::api::Caller<'_> {
        let origin = marketplace_origin();
        let host = origin.split_once("://").map_or(origin, |(_, host)| host);
        self.platform.anonymous(host, self.proto)
    }
}

/// `shouldIndexFromEnv`: on unless the variable says off.
pub fn indexing(value: Option<&str>) -> bool {
    !matches!(value.map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("0" | "false" | "no" | "off"))
}

/// Marketplace's origin (`MARKETPLACE_WEB_ORIGIN`), for sign-in and the pages the pilot links to.
pub fn marketplace_origin() -> &'static str {
    static ORIGIN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        std::env::var("MARKETPLACE_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:7753".into()).trim_end_matches('/').into()
    });
    &ORIGIN
}

pub type Shared = Arc<Config>;

/// Every URL the pilot serves, by area. Each area's routes module names each route's handler and
/// the caller every handler there takes.
pub mod url {
    pub use account_home::AccountHome;
    pub use account_select::AccountSelect;
    pub use accounts::{Account, AccountReviewReport};
    pub use addresses::{AddressArchive, AddressDefault, AddressUpdate, ShippingAddresses};
    pub use agent_consent::AgentConsent;
    pub use agents::{AgentMandate, AgentPage, AgentRevoke, AgentWebhook, AgentWebhookDisable, Agents};
    pub use bulk_reprice::{BulkReprice, BulkRepriceCancel, BulkRepriceLive, BulkRepriceResults, BulkRepriceTemplate};
    pub use cart::{Cart, CartCheckout, CartLock, CartQuantity, CartRemove};
    pub use categories::Category;
    pub use channels::{
        ChannelConnection, ChannelManualSync, ChannelManualSyncDownload, ChannelManualSyncIngest, ChannelPublication,
        ChannelPublications, Channels,
    };
    pub use checkout::{BuyCheckout, BuyConfirmation};
    pub use checkout_start::CheckoutStart;
    pub use consents::Consents;
    pub use desk::Desk;
    pub use desk_offers::DeskOffers;
    pub use guest_payments::{GuestPayment, GuestPaymentStatus};
    pub use home::{Home, Sitemap, SitemapPage};
    pub use inventory::{
        Archive, ImportBatch, ImportCommit, ImportExport, ImportResolve, ImportTemplate, Imports, Inventory, Location, Locations,
        OfflineSale, Restock, Restocked, StockAdjust, StockHold, StockItem, StockRelease, StockSale, WrittenOff,
    };
    pub use invite::Invite;
    pub use items::{Item, ItemBuy, ItemCart, ItemList, ItemLive, ItemOffer, ItemSave, ItemSellList, ItemShipFrom, ItemWatch};
    pub use listings::{PublicListing, PublicListingBuy, PublicListingReport};
    pub use money::Money;
    pub use new_listing::NewListing;
    pub use notifications::{NotificationPreference, NotificationRead, NotificationReadAll, Notifications, ProductAlertChange};
    pub use oauth::OAuthAuthorize;
    pub use offer_matches::{OfferMatch, OfferMatches, OfferMatchesLive};
    pub use payment_methods::PaymentMethods;
    pub use payments::{BuyerPayment, BuyerPaymentNew, BuyerPaymentStatus};
    pub use payout::DeskPayout;
    pub use payout_setup::{PayoutSetup, PayoutSetupSession};
    pub use pricing_health::PricingHealth;
    pub use purchase_reviews::PurchaseReview;
    pub use purchases::{Purchase, PurchaseCancel, Purchases};
    pub use recommendations::{Recommendations, RecommendationsLive};
    pub use register::Register;
    pub use repricing::{Repricing, RepricingDryRunLive, RepricingPolicy};
    pub use reviews::{ReceivedReviews, Review, Reviews, WrittenReviews};
    pub use sale_reviews::SaleReview;
    pub use sale_shipments::{Pack, Packing, PackingLine, PackingScan, PackingSlips, PackingStart, SaleShipment, SaleShipments};
    pub use sales::{Sale, SaleCancel, Sales};
    pub use search::Search;
    pub use security::Security;
    pub use sell_checkout::{SellCheckout, SellConfirmation};
    pub use sell_list::{SellList, SellListEvidence};
    pub use seller_listings::{SellerListing, SellerListingPhotos, SellerListings, SellerListingsLive};
    pub use sessions::{SessionPage, SessionRevoke, SessionSwitch, Sessions};
    pub use sets::Set;
    pub use shipments::{Shipment, Shipments};
    pub use sign_in::{MagicLink, SignIn};
    pub use submitted_offers::{SubmittedOffer, SubmittedOffers, SubmittedOffersLive};
    pub use support::{SupportCase, SupportList};
    pub use team::Team;

    /// The routes in no area, all public. The home page: marketplace's index route is its search
    /// route, so it is the search at `/` (with nothing asked, the landing and its shelf); an area's
    /// prefix is the start of each of its paths, and every path starts with `/`. And Settlement's
    /// old addresses, which share no prefix and move for good to the Seller Desk's (marketplace's
    /// `account-payouts`, `account-payout`, `account-desk-settings`, `account-settlement` and
    /// `account-wallet-adjustment` redirects, see `money`); the page each moves to asks who it is for.
    /// And two more that share no prefix: Product alerts' old address and leaving a guest checkout.
    #[corten::routes(state = crate::app::Shared)]
    pub mod home {
        /// The search's landing, or the results for the address's terms.
        #[derive(Clone, Debug, Default)]
        #[route("/", get = crate::search::page)]
        pub struct Home {
            #[route(query)]
            pub terms: crate::search::Terms,
        }

        #[route("/account/payouts", get = crate::money::legacy_payouts)]
        pub struct LegacyPayouts;

        #[route("/account/payouts/setup", get = crate::money::legacy_payout_setup)]
        pub struct LegacyPayoutSetup;

        #[route("/account/payouts/{id}", get = crate::money::legacy_payout)]
        pub struct LegacyPayout<'a> {
            pub id: &'a str,
        }

        #[route("/account/settlement", get = crate::money::legacy_payouts)]
        pub struct LegacySettlement;

        #[route("/account/wallet/adjustments/{reference}", get = crate::money::legacy_adjustment)]
        pub struct LegacyAdjustment<'a> {
            pub reference: &'a str,
        }

        /// Discovery's `account-product-alerts`: the notification center's Product alerts.
        #[route("/account/product-alerts", get = crate::notifications::product_alerts)]
        pub struct ProductAlerts;

        /// Auth's `guest-checkout-exit`: a guest leaves checkout as Sign out does (it ends the guest
        /// checkout and any session, then the search).
        #[route("/guest-checkout/exit", post = crate::sign_in::sign_out)]
        pub struct GuestCheckoutExit;

        /// The site's own files (`crate::site`): the crawler rules, the sitemap index and its
        /// pages, the favicon at both of marketplace-web's addresses, and Chrome's devtools probe.
        #[route("/robots.txt", get = crate::site::robots)]
        pub struct Robots;

        #[route("/sitemap.xml", get = crate::site::sitemap)]
        pub struct Sitemap;

        /// `page` is the page's number, as written (`site::page_number` reads it).
        #[route("/sitemap/{kind}/{page}.xml", get = crate::site::sitemap_page)]
        pub struct SitemapPage<'a> {
            pub kind: &'a str,
            pub page: &'a str,
        }

        #[route("/favicon.svg", get = crate::site::favicon)]
        pub struct FaviconSvg;

        #[route("/favicon.ico", get = crate::site::favicon)]
        pub struct FaviconIco;

        #[route("/.well-known/appspecific/com.chrome.devtools.json", get = crate::site::devtools)]
        pub struct Devtools;

        /// The item page's and search's analytics events (`crate::site::rail_analytics`).
        #[route("/analytics/item-detail-rail", post = crate::site::rail_analytics)]
        pub struct RailAnalytics;
    }

    /// The offline page (`crate::site::offline`), an area for its stylesheet, which no other page
    /// loads. Public.
    #[corten::routes(state = crate::app::Shared, area = Offline)]
    pub mod offline {
        #[route("/offline", get = crate::site::offline)]
        pub struct Offline;
    }

    /// The account's own page (Identity's `account`): its profile and Update Profile. Every handler
    /// takes an `AccountOwner` (`accounts.view` to read, `accounts.manage` to write). Its prefix
    /// holds every other `/account/..` area, so its stylesheet is in `App::components` (as Corten's
    /// styles guide says for a page whose path is the prefix of other areas).
    #[corten::routes(state = crate::app::Shared, area = AccountHome, caller = crate::auth::AccountOwner)]
    pub mod account_home {
        /// The page, read after the write whose receipt it carries, and the profile's update.
        #[derive(Clone, Debug, Default)]
        #[route("/account", get = crate::account_home::page, post = crate::account_home::update)]
        pub struct AccountHome {
            #[route(query)]
            pub place: crate::account_home::Place,
        }
    }

    /// Marketplace search, public: a handler that shows who is signed in reads
    /// `Option<Caller<Session>>`.
    #[corten::routes(state = crate::app::Shared, area = Search)]
    pub mod search {
        /// The results for the address's terms.
        #[derive(Clone, Debug, Default)]
        #[route("/search", get = crate::search::page)]
        pub struct Search {
            #[route(query)]
            pub terms: crate::search::Terms,
        }
    }

    /// A category's search page, public.
    #[corten::routes(state = crate::app::Shared, area = Categories)]
    pub mod categories {
        /// The area's prefix: only the start of its paths. No page is served at `/categories` (marketplace
        /// answers its not-found page), so it names no handler and nothing can link to it.
        #[route("/categories")]
        pub struct Categories;

        /// The results for the address's terms, in the category.
        #[derive(Clone, Debug)]
        #[route("/categories/{slug}", get = crate::search::category)]
        pub struct Category<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub terms: crate::search::Terms,
        }
    }

    /// An account's public page, public: a handler that shows who is signed in reads
    /// `Option<Caller<Session>>`; Report review posts to the review's own path.
    #[corten::routes(state = crate::app::Shared, area = AccountsArea)]
    pub mod accounts {
        /// The area's prefix: only the start of its paths. No page is served at `/accounts` (marketplace
        /// answers its not-found page), so it names no handler and nothing can link to it.
        #[route("/accounts")]
        pub struct AccountsArea;

        /// The account (`slug` is its slug, or an old one or its id, which moves), the reviews'
        /// role and page, and the review a report was just received for.
        #[route("/accounts/{slug}", get = crate::accounts::page)]
        pub struct Account<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub query: crate::accounts::AccountQuery,
        }

        /// Report a review, from the page with its role and page.
        #[route("/accounts/{slug}/reviews/{review}/report", post = crate::accounts::report_review)]
        pub struct AccountReviewReport<'a> {
            pub slug: &'a str,
            pub review: &'a str,
            #[route(query)]
            pub query: crate::accounts::AccountQuery,
        }
    }

    /// A listing's public page, public: a handler that shows who is signed in reads
    /// `Option<Caller<Session>>`; Buy this listing and Report listing post to their own paths.
    #[corten::routes(state = crate::app::Shared, area = ListingsArea)]
    pub mod listings {
        /// The area's prefix: only the start of its paths. No page is served at `/listings` (marketplace
        /// answers its not-found page), so it names no handler and nothing can link to it.
        #[route("/listings")]
        pub struct ListingsArea;

        /// The listing (`slug` is its slug, or an old one, which moves), and whether a report
        /// of it was just received.
        #[derive(Clone, Debug)]
        #[route("/listings/{slug}", get = crate::public_listing::page)]
        pub struct PublicListing<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub reported: crate::public_listing::Reported,
        }

        /// Buy the listing now.
        #[route("/listings/{slug}/buy", post = crate::public_listing::buy)]
        pub struct PublicListingBuy<'a> {
            pub slug: &'a str,
        }

        /// Report the listing.
        #[route("/listings/{slug}/report", post = crate::public_listing::report)]
        pub struct PublicListingReport<'a> {
            pub slug: &'a str,
        }
    }

    /// A set's page, public: a handler that shows who is signed in reads
    /// `Option<Caller<Session>>`.
    #[corten::routes(state = crate::app::Shared, area = Sets)]
    pub mod sets {
        /// The area's prefix: only the start of its paths. No page is served at `/sets` (marketplace
        /// answers its not-found page), so it names no handler and nothing can link to it.
        #[route("/sets")]
        pub struct Sets;

        /// The set and its cataloged items (`slug` is its slug, or an old one, which moves).
        #[derive(Clone, Debug)]
        #[route("/sets/{slug}", get = crate::sets::page)]
        pub struct Set<'a> {
            pub slug: &'a str,
        }
    }

    /// Marketplace's item pages, public: no caller is required (a handler that shows whose offers
    /// are theirs reads `Option<Caller<Session>>`), and each route names its handler, so a link
    /// from an item page cannot reach a route nobody serves.
    #[corten::routes(state = crate::app::Shared, area = ItemsArea)]
    pub mod items {
        /// The area's prefix: only the start of its paths. No page is served at `/items` (marketplace
        /// answers its not-found page), so it names no handler and nothing can link to it.
        #[route("/items")]
        pub struct ItemsArea;

        /// An item, and what the buyer chose of it (`id` is its slug or its id; an id moves to the
        /// slug).
        #[derive(Clone, Debug)]
        #[route("/items/{slug}", get = crate::items::page)]
        pub struct Item<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
            /// What the write before left for the page to say (its receipt), if any.
            #[route(query)]
            pub after: crate::items::After,
        }

        /// The item page's market parts, drawn again on each change to the item
        /// (`<corten-live>`); `id` is the item's id, which names its realtime topic.
        #[route("/items/{id}/live", get = crate::items::live)]
        pub struct ItemLive<'a> {
            pub id: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
        }

        /// Add the item's listing or product to the buy cart, or buy the best match.
        #[route("/items/{slug}/cart", post = crate::buying::add)]
        pub struct ItemCart<'a> {
            pub slug: &'a str,
        }

        /// Buy the listing the item page shows now.
        #[route("/items/{slug}/buy", post = crate::buying::buy)]
        pub struct ItemBuy<'a> {
            pub slug: &'a str,
        }

        /// Make an offer for the product the item page shows: checked, then checkout start for the offer.
        #[route("/items/{slug}/offer", post = crate::buying::offer)]
        pub struct ItemOffer<'a> {
            pub slug: &'a str,
        }

        /// Add the offer the item page shows (Accept offer, Add offer to Sell List), or its product,
        /// to the sell list.
        #[route("/items/{slug}/sell-list", post = crate::selling::add)]
        pub struct ItemSellList<'a> {
            pub slug: &'a str,
        }

        /// Set a Watch alert for the product the item page shows: an account's alert, or a guest's
        /// intent and then marketplace's registration.
        #[route("/items/{slug}/watch", post = crate::watching::watch)]
        pub struct ItemWatch<'a> {
            pub slug: &'a str,
        }

        /// Add the product the item page shows to a Saved List (Add to List): an account's
        /// addition, or a guest's intent and then marketplace's registration.
        #[route("/items/{slug}/save", post = crate::saving::save)]
        pub struct ItemSave<'a> {
            pub slug: &'a str,
        }

        /// List the product the Sell tab shows at a price: an account's listing, published, or a
        /// guest's draft and then marketplace's registration.
        #[route("/items/{slug}/list", post = crate::listing::list)]
        pub struct ItemList<'a> {
            pub slug: &'a str,
        }

        /// Save the ship-from address an account's quick listings ship from (its Listing stock
        /// location).
        #[route("/items/{slug}/ship-from", post = crate::listing::ship_from)]
        pub struct ItemShipFrom<'a> {
            pub slug: &'a str,
        }
    }

    /// The seller's inventory screens: every handler takes a `Seller` (`inventory.view` to read,
    /// `inventory.manage` to write).
    #[corten::routes(state = crate::app::Shared, area = Inventory, caller = crate::auth::Seller)]
    pub mod inventory {
        use crate::recovery::Check;

        /// The inventory items (a page of them, the Record sale open and what the last sale did),
        /// Create inventory item, and the write to confirm.
        #[derive(Clone, Debug, Default)]
        #[route("/account/inventory", get = crate::inventory_list::list, post = crate::inventory_list::create)]
        pub struct Inventory {
            #[route(query)]
            pub place: crate::inventory_list::Place,
            #[route(query)]
            pub check: Check,
        }

        /// Record an offline sale of the item, from the list's page.
        #[route("/account/inventory/items/{id}/offline-sales", post = crate::inventory_list::sale)]
        pub struct OfflineSale<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::inventory_list::Place,
        }

        /// An inventory item's page: the ledger's filter, what the last sale did, and the write
        /// to confirm.
        #[derive(Clone, Debug)]
        #[route("/account/inventory/items/{id}", get = crate::inventory_item::open)]
        pub struct StockItem<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::inventory_item::ItemPlace,
            #[route(query)]
            pub check: Check,
        }

        /// Adjust Quantity, from the item's page.
        #[route("/account/inventory/items/{id}/adjustments", post = crate::inventory_item::adjust)]
        pub struct StockAdjust<'a> {
            pub id: &'a str,
        }

        /// Create Hold, from the item's page.
        #[route("/account/inventory/items/{id}/holds", post = crate::inventory_item::hold)]
        pub struct StockHold<'a> {
            pub id: &'a str,
        }

        /// Release a manual hold, from its item's page.
        #[route("/account/inventory/items/{id}/holds/{hold}/release", post = crate::inventory_item::release)]
        pub struct StockRelease<'a> {
            pub id: &'a str,
            pub hold: &'a str,
        }

        /// Record an offline sale of the item, from its page.
        #[route("/account/inventory/items/{id}/sale", post = crate::inventory_item::sale)]
        pub struct StockSale<'a> {
            pub id: &'a str,
        }

        /// The storage locations, and the write to confirm.
        #[derive(Clone, Debug, Default)]
        #[route("/account/inventory/locations", get = crate::locations::list, post = crate::locations::create)]
        pub struct Locations {
            #[route(query)]
            pub check: Check,
        }

        #[route("/account/inventory/locations/{id}", post = crate::locations::update)]
        pub struct Location<'a> {
            pub id: &'a str,
        }

        #[route("/account/inventory/locations/{id}/archive", post = crate::locations::archive)]
        pub struct Archive<'a> {
            pub id: &'a str,
        }

        /// Inventory import: the upload form and the recent batches, a job's progress, and a new
        /// import (see `imports`).
        #[derive(Clone, Debug, Default)]
        #[route("/account/inventory/imports", get = crate::imports::list, post = crate::imports::create)]
        pub struct Imports {
            #[route(query)]
            pub place: crate::imports::Place,
        }

        /// The native CSV template, as the API sends it.
        #[route("/account/inventory/imports/template.csv", get = crate::imports::template)]
        pub struct ImportTemplate;

        /// The account's inventory as native CSV, as the API sends it.
        #[route("/account/inventory/imports/export.csv", get = crate::imports::export)]
        pub struct ImportExport;

        /// An import batch: its summary, a page of its rows and Commit.
        #[derive(Clone, Debug)]
        #[route("/account/inventory/imports/{batch}", get = crate::imports::batch)]
        pub struct ImportBatch<'a> {
            pub batch: &'a str,
            #[route(query)]
            pub place: crate::imports::Place,
        }

        /// Resolve a rejected row: its catalog item, options and storage location.
        #[route("/account/inventory/imports/{batch}/rows/{row}/resolve", post = crate::imports::resolve)]
        pub struct ImportResolve<'a> {
            pub batch: &'a str,
            pub row: &'a str,
        }

        /// Commit a batch's accepted rows.
        #[route("/account/inventory/imports/{batch}/commit", post = crate::imports::commit)]
        pub struct ImportCommit<'a> {
            pub batch: &'a str,
        }

        /// The pending restock decisions, and the write to confirm.
        #[derive(Clone, Debug, Default)]
        #[route("/account/inventory/restock-decisions", get = crate::restock::list)]
        pub struct Restock {
            #[route(query)]
            pub check: Check,
        }

        #[route("/account/inventory/restock-decisions/{id}/restock", post = crate::restock::restock)]
        pub struct Restocked<'a> {
            pub id: &'a str,
        }

        #[route("/account/inventory/restock-decisions/{id}/write-off", post = crate::restock::write_off)]
        pub struct WrittenOff<'a> {
            pub id: &'a str,
        }
    }

    /// The account's notification center (Notifications' `routes/account-notifications.tsx`): the
    /// feed, the delivery settings and the account's Product alerts. Every handler takes a `Member`
    /// (`accounts.view`).
    #[corten::routes(state = crate::app::Shared, area = Notifications, caller = crate::auth::Member)]
    pub mod notifications {
        /// The feed, or the settings (`view=settings`, at `section`), read after the write whose
        /// receipt it carries.
        #[derive(Clone, Debug, Default)]
        #[route("/account/notifications", get = crate::notifications::page)]
        pub struct Notifications {
            #[route(query)]
            pub place: crate::notifications::Place,
        }

        /// Mark a notification read (the form names its delivery).
        #[route("/account/notifications/read", post = crate::notifications::mark_read)]
        pub struct NotificationRead;

        /// Mark every notification read.
        #[route("/account/notifications/read-all", post = crate::notifications::mark_all_read)]
        pub struct NotificationReadAll;

        /// Turn a delivery channel on or off.
        #[route("/account/notifications/preferences/{key}", post = crate::notifications::set_preference)]
        pub struct NotificationPreference<'a> {
            pub key: &'a str,
        }

        /// Pause, resume or delete a Product alert (Discovery's).
        #[route("/account/notifications/product-alerts/{id}", post = crate::notifications::change_alert)]
        pub struct ProductAlertChange<'a> {
            pub id: &'a str,
        }
    }

    /// The user's sessions (Auth's `account-sessions`): the list is the area's route, and every
    /// handler takes a `SecurityOwner` (`security.manage`, which Auth requires for every call).
    #[corten::routes(state = crate::app::Shared, area = Sessions, caller = crate::auth::SecurityOwner)]
    pub mod sessions {
        /// A page of the user's sessions, by status.
        #[derive(Clone, Debug, Default)]
        #[route("/account/sessions", get = crate::sessions::list)]
        pub struct Sessions {
            #[route(query)]
            pub filters: crate::sessions::Filters,
        }

        /// A session, read after the write whose receipt it carries.
        #[derive(Clone, Debug)]
        #[route("/account/sessions/{id}", get = crate::sessions::page)]
        pub struct SessionPage<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::sessions::Place,
        }

        /// Sign a session out.
        #[route("/account/sessions/{id}/revoke", post = crate::sessions::revoke)]
        pub struct SessionRevoke<'a> {
            pub id: &'a str,
        }

        /// Make a session act for another of its accounts.
        #[route("/account/sessions/{id}/switch", post = crate::sessions::switch)]
        pub struct SessionSwitch<'a> {
            pub id: &'a str,
        }
    }

    /// The account's connected agents (Auth's `account-agents` and `account-agents-detail`): the
    /// list is the area's route, and every handler takes an `AgentHolder` (anyone signed in, as
    /// marketplace's routes; Auth keeps each grant to its account).
    #[corten::routes(state = crate::app::Shared, area = Agents, caller = crate::auth::AgentHolder)]
    pub mod agents {
        /// The account's grants, and how to connect an assistant.
        #[route("/account/agents", get = crate::agents::list)]
        pub struct Agents;

        /// A grant, saying what the last write did.
        #[derive(Clone, Debug)]
        #[route("/account/agents/{id}", get = crate::agents::page)]
        pub struct AgentPage<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::agents::Place,
        }

        /// Revoke access, as an attempt.
        #[route("/account/agents/{id}/revoke", post = crate::agents::revoke)]
        pub struct AgentRevoke<'a> {
            pub id: &'a str,
        }

        /// Save the spending mandate.
        #[route("/account/agents/{id}/mandate", post = crate::agents::mandate)]
        pub struct AgentMandate<'a> {
            pub id: &'a str,
        }

        /// Save the webhook's address; the answer shows its new signing secret.
        #[route("/account/agents/{id}/webhook", post = crate::agents::webhook)]
        pub struct AgentWebhook<'a> {
            pub id: &'a str,
        }

        /// Disable the webhook.
        #[route("/account/agents/{id}/webhook/disable", post = crate::agents::disable_webhook)]
        pub struct AgentWebhookDisable<'a> {
            pub id: &'a str,
        }
    }

    /// An agent's consent (Auth's `account-agents-consent`), its own area: its forms go to the agent's
    /// address (the API's authorize redirects there), which its policy allows. Its handlers take an
    /// `AgentHolder`.
    #[corten::routes(state = crate::app::Shared, area = AgentConsent, caller = crate::auth::AgentHolder)]
    pub mod agent_consent {
        /// The consent request, and answering it as another of the user's accounts.
        #[derive(Clone, Debug, Default)]
        #[route("/account/agents/consent", get = crate::agents::consent, post = crate::agents::switch_account)]
        pub struct AgentConsent {
            #[route(query)]
            pub ask: crate::agents::ConsentAsk,
        }
    }

    /// The platform API's OAuth authorize, relayed with its redirects as they are. The ingress sends
    /// `/ucp` to the API before the pilot sees it; locally nothing else serves it. Public: the API
    /// asks who it is for.
    #[corten::routes(state = crate::app::Shared, area = OAuthAuthorize)]
    pub mod oauth {
        #[route("/ucp/oauth/authorize", get = crate::agents::authorize, post = crate::agents::decide)]
        pub struct OAuthAuthorize;
    }

    /// The user's security page (Identity's `account-security`): its names and its API keys. Every
    /// write posts to the page itself, which answers a key's create or rotate with its secret, so
    /// a reload asks the API again (which then says the secret cannot be shown) instead of
    /// loading another address. Every handler takes a `SecurityOwner` (`security.manage`).
    #[corten::routes(state = crate::app::Shared, area = Security, caller = crate::auth::SecurityOwner)]
    pub mod security {
        /// The page, read after the write whose receipt it carries, and its writes.
        #[derive(Clone, Debug, Default)]
        #[route("/account/security", get = crate::security::page, post = crate::security::write)]
        pub struct Security {
            #[route(query)]
            pub place: crate::security::Place,
        }
    }

    /// The account's team (Identity's `account-team`): its members and invitations. Every write posts
    /// to the page itself, as marketplace's form action does. Every handler takes a `TeamOwner`
    /// (`memberships.view` to read, `memberships.manage` to write).
    #[corten::routes(state = crate::app::Shared, area = Team, caller = crate::auth::TeamOwner)]
    pub mod team {
        /// The page, read after the write whose receipt it carries, and its writes.
        #[derive(Clone, Debug, Default)]
        #[route("/account/team", get = crate::team::page, post = crate::team::write)]
        pub struct Team {
            #[route(query)]
            pub place: crate::team::Place,
        }
    }

    /// The account's reviews (Reputation's `account-review-summary`, `account-received-reviews` and
    /// `account-written-reviews`). Report review posts to the page it is on, as marketplace's form
    /// action does. Every handler takes a `ReviewMember` (`reputation.view` to read,
    /// `reputation.manage` to report).
    #[corten::routes(state = crate::app::Shared, area = Reviews, caller = crate::auth::ReviewMember)]
    pub mod reviews {
        /// The account's ratings and its newest reviews.
        #[derive(Clone, Debug, Default)]
        #[route("/account/reviews", get = crate::reviews::summary, post = crate::reviews::report_on_summary)]
        pub struct Reviews {
            #[route(query)]
            pub place: crate::reviews::Place,
        }

        /// The reviews others left the account, by role.
        #[derive(Clone, Debug, Default)]
        #[route("/account/reviews/received", get = crate::reviews::received, post = crate::reviews::report_on_received)]
        pub struct ReceivedReviews {
            #[route(query)]
            pub place: crate::reviews::Place,
        }

        /// The reviews the account left, by role.
        #[derive(Clone, Debug, Default)]
        #[route("/account/reviews/written", get = crate::reviews::written, post = crate::reviews::report_on_written)]
        pub struct WrittenReviews {
            #[route(query)]
            pub place: crate::reviews::Place,
        }

        /// A review, read after the reply whose receipt its address carries; Report review and the
        /// reply post to it.
        #[derive(Clone, Debug)]
        #[route("/account/reviews/{id}", get = crate::review::page, post = crate::review::write)]
        pub struct Review<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::review::ReviewPlace,
        }
    }

    /// The user's consent history (Identity's `account-consents`). Withdraw posts to the page
    /// itself, as marketplace's form action does. Every handler takes a `ConsentHolder` (anyone
    /// signed in; the API decides the rest).
    #[corten::routes(state = crate::app::Shared, area = Consents, caller = crate::auth::ConsentHolder)]
    pub mod consents {
        /// The page, read after the withdrawal whose receipt it carries, and the withdrawal.
        #[derive(Clone, Debug, Default)]
        #[route("/account/consents", get = crate::consents::page, post = crate::consents::write)]
        pub struct Consents {
            #[route(query)]
            pub place: crate::consents::Place,
        }
    }

    /// The account's shipping addresses (Identity's `account-shipping-addresses`): the list is the
    /// area's route, and every handler takes an `AddressOwner` (`accounts.view` to read,
    /// `accounts.manage` to write).
    #[corten::routes(state = crate::app::Shared, area = ShippingAddresses, caller = crate::auth::AddressOwner)]
    pub mod addresses {
        /// The addresses, read after the write whose receipt it carries, and what the write did.
        #[derive(Clone, Debug, Default)]
        #[route("/account/shipping-addresses", get = crate::addresses::page, post = crate::addresses::create)]
        pub struct ShippingAddresses {
            #[route(query)]
            pub place: crate::addresses::Place,
        }

        /// Update an address.
        #[route("/account/shipping-addresses/{id}", post = crate::addresses::update)]
        pub struct AddressUpdate<'a> {
            pub id: &'a str,
        }

        /// Make an address the default.
        #[route("/account/shipping-addresses/{id}/default", post = crate::addresses::make_default)]
        pub struct AddressDefault<'a> {
            pub id: &'a str,
        }

        /// Archive an address.
        #[route("/account/shipping-addresses/{id}/archive", post = crate::addresses::archive)]
        pub struct AddressArchive<'a> {
            pub id: &'a str,
        }
    }

    /// Create listing (marketplace's `account-listings-new`): the form, and the create with its
    /// photos (see `listing_new`). Every handler takes a `ListingSeller`.
    #[corten::routes(state = crate::app::Shared, area = NewListing, caller = crate::auth::ListingSeller)]
    pub mod new_listing {
        /// The form as the address asks, and the create.
        #[route("/account/listings/new", get = crate::listing_new::page, post = crate::listing_new::create)]
        pub struct NewListing;
    }

    /// The seller's listings (marketplace's `account-listings` and `account-listing`): the list
    /// and its writes, and a listing's page and its writes, the photo writes at `/photos` since
    /// they post files. Every handler takes a `ListingManager`. Create listing
    /// (`/account/listings/new`) is an area of its own inside this one.
    #[corten::routes(state = crate::app::Shared, area = SellerListings, caller = crate::auth::ListingManager)]
    pub mod seller_listings {
        /// The list as its address asks (filters, page, the last write), and its writes: the
        /// account-wide settings and Pause or Withdraw selected (see `seller_listings`).
        #[derive(Clone, Debug, Default)]
        #[route("/account/listings", get = crate::seller_listings::page, post = crate::seller_listings::write)]
        pub struct SellerListings {
            #[route(query)]
            pub place: crate::seller_listings::Place,
        }

        /// The list's counts, rows and fee lock report, drawn again on each change to the
        /// account's listings (`<corten-live>`).
        #[route("/account/listings/live", get = crate::seller_listings::live)]
        pub struct SellerListingsLive {
            #[route(query)]
            pub place: crate::seller_listings::Place,
        }

        /// A listing, read after the write whose receipt its address carries, with a price to
        /// preview; its writes but the photos'.
        #[derive(Clone, Debug)]
        #[route("/account/listings/{id}", get = crate::seller_listing::page, post = crate::seller_listing::write)]
        pub struct SellerListing<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::seller_listing::Place,
        }

        /// Add photos and Replace photo (`multipart/form-data`).
        #[route("/account/listings/{id}/photos", post = crate::seller_listing::photos)]
        pub struct SellerListingPhotos<'a> {
            pub id: &'a str,
        }
    }

    /// The Seller Desk home (marketplace's `account-desk`): the attention queue and the KPI band.
    /// Its handler takes a `DeskSeller` (anyone signed in).
    #[corten::routes(state = crate::app::Shared, area = Desk, caller = crate::auth::DeskSeller)]
    pub mod desk {
        /// The Desk home. `drawer` and `entity` are the queue's links to a drawer marketplace has
        /// not built; the page ignores them, as marketplace's does.
        #[route("/account/desk", get = crate::desk::page)]
        pub struct Desk;
    }

    /// Seller checkout (Checkout's `sell-checkout-session` and `sell-checkout-confirmation`): anyone,
    /// a guest's being a review of the guest sell list. Its handlers take who is asking, if anyone
    /// (see `sell_checkout`).
    #[corten::routes(state = crate::app::Shared, area = SellCheckoutArea)]
    pub mod sell_checkout {
        /// The area's prefix: only the start of its paths, with no page of its own.
        #[route("/checkout/sell/session")]
        pub struct SellCheckoutArea;

        /// The review, from the snapshot its address names; its one form posts to it.
        #[route("/checkout/sell/session/{id}", get = crate::sell_checkout::page, post = crate::sell_checkout::write)]
        pub struct SellCheckout<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::sell_checkout::Place,
        }

        /// The saved seller confirmation, read after the confirm's receipt.
        #[route("/checkout/sell/session/{id}/confirmation", get = crate::sell_checkout::confirmation)]
        pub struct SellConfirmation<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::sell_checkout::ConfirmationPlace,
        }
    }

    /// Checkout's Sell List (`account-sell-list`): anyone, a guest's being the browser's guest sell
    /// list. Its handlers take who is asking, if anyone (see `sell_list`). The Seller Desk's Offers &
    /// sell list is the same page for anyone signed in, at its own address (`DeskOffers`).
    #[corten::routes(state = crate::app::Shared, area = SellList)]
    pub mod sell_list {
        /// The page, read after the write its address names; every form but Add photo posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/sell-list", get = crate::sell_list::page, post = crate::sell_list::write)]
        pub struct SellList {
            #[route(query)]
            pub place: crate::sell_list::Place,
        }

        /// Add photo to a selected offer's listing (`multipart/form-data`), for either address.
        #[route("/account/sell-list/evidence", post = crate::sell_list::evidence)]
        pub struct SellListEvidence;
    }

    /// The Seller Desk's Offers & sell list (Checkout's `account-desk-offers`): the Sell List for anyone
    /// signed in. Every handler takes a `DeskSeller`.
    #[corten::routes(state = crate::app::Shared, area = DeskOffers, caller = crate::auth::DeskSeller)]
    pub mod desk_offers {
        #[derive(Clone, Debug, Default)]
        #[route("/account/desk/offers", get = crate::sell_list::desk_page, post = crate::sell_list::desk_write)]
        pub struct DeskOffers {
            #[route(query)]
            pub place: crate::sell_list::Place,
        }
    }

    /// The Seller Desk's money page (Settlement's `account-desk-money`): the wallet, the payouts and
    /// Request a payout, and its writes (see `money`). Every handler takes a `PayoutViewer`.
    #[corten::routes(state = crate::app::Shared, area = Money, caller = crate::auth::PayoutViewer)]
    pub mod money {
        /// The page, with a wallet adjustment's breakdown when the address names one; every write
        /// posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/desk/money", get = crate::money::page, post = crate::money::write)]
        pub struct Money {
            #[route(query)]
            pub place: crate::money::Place,
        }
    }

    /// Payout setup (Settlement's `account-desk-settings`, see `payout_setup`): any account may
    /// open it; Refresh and Stripe's sessions need `payouts.setup` (`PayoutSetter`).
    #[corten::routes(state = crate::app::Shared, area = PayoutSetup, caller = crate::auth::PayoutSetter)]
    pub mod payout_setup {
        /// The page; Refresh setup status posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/desk/settings", get = crate::payout_setup::page, post = crate::payout_setup::write)]
        pub struct PayoutSetup {
            #[route(query)]
            pub place: crate::payout_setup::Place,
        }

        /// A Stripe Connect session for the page's script, as JSON.
        #[derive(Clone, Debug, Default)]
        #[route("/account/desk/settings/session", post = crate::payout_setup::session)]
        pub struct PayoutSetupSession {
            #[route(query)]
            pub which: crate::payout_setup::Which,
        }
    }

    /// A payout's page (Settlement's `account-desk-payout`, see `money`). It takes a
    /// `PayoutViewer`, as the money page does.
    #[corten::routes(state = crate::app::Shared, area = PayoutsArea, caller = crate::auth::PayoutViewer)]
    pub mod payout {
        /// The prefix, with no page: the payouts are listed on the money page.
        #[route("/account/desk/payouts")]
        pub struct PayoutsArea;

        /// The payout, read after the request whose receipt it carries.
        #[derive(Clone, Debug)]
        #[route("/account/desk/payouts/{id}", get = crate::money::payout)]
        pub struct DeskPayout<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::money::PayoutPlace,
        }
    }

    /// A buyer's payment (Payments' `account-payment`, see `payment`): the page, its status part,
    /// which the page reads again while the payment waits for the buyer, and starting a payment
    /// for a buyer's orders (`account-payment-new`, see `payment_start`). Every handler takes a
    /// `PaymentBuyer`.
    #[corten::routes(state = crate::app::Shared, area = PaymentsArea, caller = crate::auth::PaymentBuyer)]
    pub mod payments {
        /// The prefix, with no page: a payment is reached from its checkout or its purchase.
        #[route("/account/payments")]
        pub struct PaymentsArea;

        /// Start a payment for the buyer's orders: the page, and Continue to payment, which posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/payments/new", get = crate::payment_start::page, post = crate::payment_start::start)]
        pub struct BuyerPaymentNew {
            #[route(query)]
            pub place: crate::payment_start::StartPlace,
        }

        /// The payment, read after the write whose receipt it carries.
        #[derive(Clone, Debug)]
        #[route("/account/payments/{id}", get = crate::payment::page)]
        pub struct BuyerPayment<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::payment::Place,
        }

        /// The payment's status part, read again while the payment waits for the buyer.
        #[derive(Clone, Debug)]
        #[route("/account/payments/{id}/status", get = crate::payment::status)]
        pub struct BuyerPaymentStatus<'a> {
            pub id: &'a str,
            #[route(query)]
            pub watch: crate::payment::Watch,
        }
    }

    /// A guest checkout's payment (Payments' `checkout-payment`, the same page as an account's, see
    /// `payment`): the page and its Retry payment, and its status part. Its handlers take who is
    /// asking, if anyone: an account is sent to its own payment page, and anyone else is told the
    /// link is no longer good.
    #[corten::routes(state = crate::app::Shared, area = GuestPaymentsArea)]
    pub mod guest_payments {
        /// The prefix, with no page: a guest reaches its payment from its checkout.
        #[route("/checkout/payments")]
        pub struct GuestPaymentsArea;

        /// The payment, read after the write whose receipt it carries; Retry payment posts to it.
        #[derive(Clone, Debug)]
        #[route("/checkout/payments/{id}", get = crate::payment::guest_page, post = crate::payment::guest_retry)]
        pub struct GuestPayment<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::payment::GuestPlace,
        }

        /// The payment's status part, read again while the payment waits for the guest.
        #[derive(Clone, Debug)]
        #[route("/checkout/payments/{id}/status", get = crate::payment::guest_status)]
        pub struct GuestPaymentStatus<'a> {
            pub id: &'a str,
            #[route(query)]
            pub watch: crate::payment::Watch,
        }
    }

    /// The account's saved payment methods (Payments' `account-payment-methods`, see
    /// `payment_methods`): the page, and its writes, which post to it as marketplace's form does.
    /// Every handler takes a `PaymentBuyer` (`orders.view`; Payments needs `orders.manage` to write).
    #[corten::routes(state = crate::app::Shared, area = PaymentMethods, caller = crate::auth::PaymentBuyer)]
    pub mod payment_methods {
        /// The page, read after a change's receipt or a setup's outcome, and Add, Set default,
        /// Remove and Refresh.
        #[derive(Clone, Debug, Default)]
        #[route("/account/payment-methods", get = crate::payment_methods::page, post = crate::payment_methods::write)]
        pub struct PaymentMethods {
            #[route(query)]
            pub place: crate::payment_methods::Place,
        }
    }

    /// The account's support: its cases and Report a problem (Platform Operations' marketplace
    /// `account-support`, see `support_list`), and a Support Request's participant page
    /// (`account-support-detail`): the case, what its buyer or seller is asked for, and their
    /// writes (see `support`). Every handler takes a `SupportMember`.
    #[corten::routes(state = crate::app::Shared, area = SupportList, caller = crate::auth::SupportMember)]
    pub mod support {
        /// The account's cases and Report a problem (marketplace's `account-support`, see
        /// `support_list`): the intake's order, step and choices are the address, and its last
        /// step posts to it with the photos.
        #[derive(Clone, Debug, Default)]
        #[route("/account/support", get = crate::support_list::page, post = crate::support_list::write)]
        pub struct SupportList {
            #[route(query)]
            pub ask: crate::support_list::Ask,
        }

        /// The case, with what the last write did and its receipt; every write posts to it.
        #[derive(Clone, Debug)]
        #[route("/account/support/{id}", get = crate::support::page, post = crate::support::write)]
        pub struct SupportCase<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::support::Place,
        }
    }

    /// The Seller Desk's repricing page (marketplace's `account-desk-repricing`): the policies, the
    /// halt, the dry runs and the preset editor, its writes, a dry run's status relayed live (see
    /// `repricing`), and a policy's page (`account-desk-repricing-policy`). Every handler takes a
    /// `PricingManager`.
    #[corten::routes(state = crate::app::Shared, area = Repricing, caller = crate::auth::PricingManager)]
    pub mod repricing {
        /// The page, and the editor when the address opens it; every write posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/desk/repricing", get = crate::repricing::page, post = crate::repricing::write)]
        pub struct Repricing {
            #[route(query)]
            pub place: crate::repricing::Place,
        }

        /// A policy's page, and its writes (see `repricing_policy`).
        #[route(
            "/account/desk/repricing/{id}",
            get = crate::repricing_policy::page,
            post = crate::repricing_policy::write
        )]
        pub struct RepricingPolicy<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::repricing_policy::Place,
        }

        /// A dry run's part, drawn again on each status its stream sends, for the editor at `place`.
        #[route("/account/desk/repricing/dry-runs/{id}/live", get = crate::repricing::live)]
        pub struct RepricingDryRunLive<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::repricing::Place,
        }
    }

    /// The channel screens (Channels' `account-channels` routes): the connections and Connect, a
    /// connection and its writes, and the publication list (see `channels`). Every handler takes a
    /// `ChannelsMember`.
    #[corten::routes(state = crate::app::Shared, area = Channels, caller = crate::auth::ChannelsMember)]
    pub mod channels {
        /// The connections, of a status and from a page; Connect posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/channels", get = crate::channels::list, post = crate::channels::connect)]
        pub struct Channels {
            #[route(query)]
            pub place: crate::channels::ListPlace,
        }

        /// The publication list.
        #[derive(Clone, Debug, Default)]
        #[route("/account/channels/publication", get = crate::channels::publications)]
        pub struct ChannelPublications;

        /// A connection's publication: its settings, blocked listings and mappings to review, the
        /// mappings from a cursor, waiting for the configuration version a write was made at; its
        /// writes post to it.
        #[route(
            "/account/channels/publication/{id}",
            get = crate::channels::publication,
            post = crate::channels::publication_write
        )]
        pub struct ChannelPublication<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::channels::PublicationPlace,
        }

        /// A connection, after the write whose receipt the address carries; its writes post to it.
        #[route("/account/channels/{id}", get = crate::channels::connection, post = crate::channels::command)]
        pub struct ChannelConnection<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::channels::ConnectionPlace,
        }

        /// A connection's manual sync writes, but an export's ingest and the download.
        #[route("/account/channels/{id}/manual-sync", post = crate::channels::manual_sync)]
        pub struct ChannelManualSync<'a> {
            pub id: &'a str,
        }

        /// Ingest a Live or Staged export (`multipart/form-data`).
        #[route("/account/channels/{id}/manual-sync/ingest", post = crate::channels::manual_sync_ingest)]
        pub struct ChannelManualSyncIngest<'a> {
            pub id: &'a str,
        }

        /// Clamp and download CSV: Channels' Staged batch for the composed run.
        #[route("/account/channels/{id}/manual-sync/download", post = crate::channels::manual_sync_download)]
        pub struct ChannelManualSyncDownload<'a> {
            pub id: &'a str,
        }
    }

    /// Pricing health (marketplace's `account-desk-pricing-health`): the verdict for a policy,
    /// Compute verdict, Compare goals and Apply goal (see `pricing_health`). Every handler takes a
    /// `PricingManager`.
    #[corten::routes(state = crate::app::Shared, area = PricingHealth, caller = crate::auth::PricingManager)]
    pub mod pricing_health {
        /// The page, for the policy its address names; the writes post to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/desk/pricing-health", get = crate::pricing_health::page, post = crate::pricing_health::write)]
        pub struct PricingHealth {
            #[route(query)]
            pub place: crate::pricing_health::Place,
        }
    }

    /// The pricing recommendations (marketplace's `account-repricing`): the page following a job,
    /// Refresh, Apply and Dismiss, and the job relayed live (see `recommendations`). Every handler
    /// takes a `PricingManager`.
    #[corten::routes(state = crate::app::Shared, area = Recommendations, caller = crate::auth::PricingManager)]
    pub mod recommendations {
        /// The page, following the job its address names; Refresh, Apply and Dismiss post to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/repricing", get = crate::recommendations::page, post = crate::recommendations::write)]
        pub struct Recommendations {
            #[route(query)]
            pub place: crate::recommendations::Place,
        }

        /// A running job's notice, drawn again on each event, then the page's part.
        #[route("/account/repricing/jobs/{id}/live", get = crate::recommendations::live)]
        pub struct RecommendationsLive<'a> {
            pub id: &'a str,
        }
    }

    /// Bulk reprice (marketplace's `account-bulk-reprice`): the page following a job, Upload,
    /// Cancel, the job's part relayed live, and the template and results CSVs (see `bulk_reprice`).
    /// Every handler takes a `BulkRepricer`.
    #[corten::routes(state = crate::app::Shared, area = BulkReprice, caller = crate::auth::BulkRepricer)]
    pub mod bulk_reprice {
        /// The page, following the job its address names; Upload posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/bulk-reprice", get = crate::bulk_reprice::page, post = crate::bulk_reprice::upload)]
        pub struct BulkReprice {
            #[route(query)]
            pub place: crate::bulk_reprice::Place,
        }

        /// The CSV template, as Pricing sends it.
        #[route("/account/bulk-reprice/template.csv", get = crate::bulk_reprice::template)]
        pub struct BulkRepriceTemplate;

        /// Cancel a running job.
        #[route("/account/bulk-reprice/jobs/{id}/cancel", post = crate::bulk_reprice::cancel)]
        pub struct BulkRepriceCancel<'a> {
            pub id: &'a str,
        }

        /// A finished job's results, as Pricing sends them.
        #[route("/account/bulk-reprice/jobs/{id}/results.csv", get = crate::bulk_reprice::results)]
        pub struct BulkRepriceResults<'a> {
            pub id: &'a str,
        }

        /// A running job's part, drawn again on each event its stream sends.
        #[route("/account/bulk-reprice/jobs/{id}/live", get = crate::bulk_reprice::live)]
        pub struct BulkRepriceLive<'a> {
            pub id: &'a str,
        }
    }

    /// The seller's offer matches (marketplace's `account-offer-matches` and `account-offer-match`):
    /// the list, drawn again live, and a match's page with its writes (see `offer_matches`). Every
    /// handler takes an `OfferReviewer`.
    #[corten::routes(state = crate::app::Shared, area = OfferMatches, caller = crate::auth::OfferReviewer)]
    pub mod offer_matches {
        /// The list, read after the write whose receipt its address carries.
        #[derive(Clone, Debug, Default)]
        #[route("/account/offers/matches", get = crate::offer_matches::list)]
        pub struct OfferMatches {
            #[route(query)]
            pub place: crate::offer_matches::Place,
        }

        /// The list's snapshot and rows, drawn again on each change to the account's offers.
        #[route("/account/offers/matches/live", get = crate::offer_matches::live)]
        pub struct OfferMatchesLive;

        /// A match, and its writes: Add selected offer to Sell List (and Accept offer match) and
        /// Decline.
        #[route("/account/offers/matches/{id}", get = crate::offer_matches::page, post = crate::offer_matches::write)]
        pub struct OfferMatch<'a> {
            pub id: &'a str,
        }
    }

    /// The buyer's submitted offers (marketplace's `account-offers-submitted`): the list in a
    /// status, drawn again live, and its Pause, Resume and Withdraw (see `submitted_offers`). Every
    /// handler takes an `OfferBuyer`.
    #[corten::routes(state = crate::app::Shared, area = SubmittedOffers, caller = crate::auth::OfferBuyer)]
    pub mod submitted_offers {
        /// The list in the address's status; a lifecycle change posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/account/offers/submitted", get = crate::submitted_offers::list, post = crate::submitted_offers::change)]
        pub struct SubmittedOffers {
            #[route(query)]
            pub place: crate::submitted_offers::Place,
        }

        /// The status counts and the rows, drawn again on each change to the account's offers.
        #[derive(Clone, Debug, Default)]
        /// One offer: its overview, and Pause, Resume and Withdraw for it.
        #[route("/account/offers/submitted/{id}", get = crate::submitted_offers::detail, post = crate::submitted_offers::change_one)]
        pub struct SubmittedOffer<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::submitted_offers::OfferPlace,
        }

        #[route("/account/offers/submitted/live", get = crate::submitted_offers::live)]
        pub struct SubmittedOffersLive {
            #[route(query)]
            pub place: crate::submitted_offers::Place,
        }
    }

    /// The account's purchases (Ordering's `account-purchases` and `account-purchase`): the list
    /// is the area's route, and every handler takes an `OrderBuyer`.
    #[corten::routes(state = crate::app::Shared, area = Purchases, caller = crate::auth::OrderBuyer)]
    pub mod purchases {
        /// A page of the purchases.
        #[derive(Clone, Debug, Default)]
        #[route("/account/purchases", get = crate::orders::purchases)]
        pub struct Purchases {
            #[route(query)]
            pub page: crate::orders::Paging,
        }

        /// A purchase, read after the write whose receipt it carries.
        #[route("/account/purchases/{id}", get = crate::orders::purchase)]
        pub struct Purchase<'a> {
            pub id: &'a str,
            #[route(query)]
            pub after: crate::cart::AfterWrite,
        }

        /// Cancel the purchase.
        #[route("/account/purchases/{id}/cancel", post = crate::orders::cancel_purchase)]
        pub struct PurchaseCancel<'a> {
            pub id: &'a str,
        }
    }

    /// Review the seller (Reputation's `account-purchase-review`, see `order_review`), in the
    /// purchases' area: it needs `reputation.manage`, not the purchases' permissions, so its caller
    /// is its own (todd-skelton/corten#273).
    #[corten::routes(state = crate::app::Shared, area = super::purchases::Purchases, caller = crate::auth::Reviewer)]
    pub mod purchase_reviews {
        /// The review form; it posts to itself.
        #[route("/account/purchases/{id}/review", get = crate::order_review::purchase, post = crate::order_review::submit_purchase)]
        pub struct PurchaseReview<'a> {
            pub id: &'a str,
            #[route(query)]
            pub ask: crate::order_review::ReviewAsk,
        }
    }

    /// The account's sales (Ordering's `account-sales` and `account-sale`): the list is the area's
    /// route, and every handler takes an `OrderSeller`. `/account/sales/shipments` is Fulfillment's,
    /// an area of its own (`sale_shipments`).
    #[corten::routes(state = crate::app::Shared, area = Sales, caller = crate::auth::OrderSeller)]
    pub mod sales {
        /// A page of the sales.
        #[derive(Clone, Debug, Default)]
        #[route("/account/sales", get = crate::orders::sales)]
        pub struct Sales {
            #[route(query)]
            pub page: crate::orders::Paging,
        }

        /// A sale, read after the write whose receipt it carries.
        #[route("/account/sales/{id}", get = crate::orders::sale)]
        pub struct Sale<'a> {
            pub id: &'a str,
            #[route(query)]
            pub after: crate::cart::AfterWrite,
        }

        /// Cancel the sale.
        #[route("/account/sales/{id}/cancel", post = crate::orders::cancel_sale)]
        pub struct SaleCancel<'a> {
            pub id: &'a str,
        }
    }

    /// Review the buyer (Reputation's `account-sale-review`, see `order_review`), in the sales'
    /// area with a caller of its own, as the purchase's review is.
    #[corten::routes(state = crate::app::Shared, area = super::sales::Sales, caller = crate::auth::Reviewer)]
    pub mod sale_reviews {
        /// The review form; it posts to itself.
        #[route("/account/sales/{id}/review", get = crate::order_review::sale, post = crate::order_review::submit_sale)]
        pub struct SaleReview<'a> {
            pub id: &'a str,
            #[route(query)]
            pub ask: crate::order_review::ReviewAsk,
        }
    }

    /// The buyer's shipments (Fulfillment's `account-shipments` and `account-shipment`): the list
    /// is the area's route, and every handler takes a `Shipper`.
    #[corten::routes(state = crate::app::Shared, area = Shipments, caller = crate::auth::Shipper)]
    pub mod shipments {
        /// The buyer's shipments.
        #[route("/account/shipments", get = crate::shipments::purchases)]
        pub struct Shipments;

        /// A shipment the buyer is sent.
        #[route("/account/shipments/{id}", get = crate::shipments::purchase)]
        pub struct Shipment<'a> {
            pub id: &'a str,
        }
    }

    /// The seller's shipments (Fulfillment's `account-sale-shipments` and
    /// `account-sale-shipment`), an area inside the sales'. The list is marketplace's command
    /// center, which the API does not serve yet (chase-sets/chase-sets#10638), so the pilot sends
    /// it there; a shipment's page is the pilot's.
    #[corten::routes(state = crate::app::Shared, area = SaleShipments, caller = crate::auth::Shipper)]
    pub mod sale_shipments {
        /// The command center, on marketplace.
        #[route("/account/sales/shipments", get = crate::shipments::command_center)]
        pub struct SaleShipments;

        /// Packing slips to print (Fulfillment's `account-sale-shipment-packing-slips`): the
        /// shipments `shipmentIds` names (each value may be a comma-separated list), in `format`.
        #[route("/account/sales/shipments/packing-slips", get = crate::packing_slips::page)]
        pub struct PackingSlips<'a> {
            #[serde(rename = "shipmentIds")]
            pub shipment_ids: &'a [&'a str],
            pub format: Option<&'a str>,
        }

        /// A shipment the seller sends, read after the write whose receipt it carries.
        #[route("/account/sales/shipments/{id}", get = crate::shipments::sale)]
        pub struct SaleShipment<'a> {
            pub id: &'a str,
            #[route(query)]
            pub after: crate::cart::AfterWrite,
        }

        /// Packing the shipment (see `packing`).
        #[route("/account/sales/shipments/{id}/packing", get = crate::packing::page)]
        pub struct Packing<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::packing::Place,
        }

        /// Start packing.
        #[route("/account/sales/shipments/{id}/packing/start", post = crate::packing::start)]
        pub struct PackingStart<'a> {
            pub id: &'a str,
        }

        /// How many of a line are packed.
        #[route("/account/sales/shipments/{id}/packing/lines/{line}", post = crate::packing::line)]
        pub struct PackingLine<'a> {
            pub id: &'a str,
            pub line: &'a str,
        }

        /// One more of the line a scan names.
        #[route("/account/sales/shipments/{id}/packing/scan", post = crate::packing::scan)]
        pub struct PackingScan<'a> {
            pub id: &'a str,
        }

        /// Record the package as packed.
        #[route("/account/sales/shipments/{id}/pack", post = crate::packing::pack)]
        pub struct Pack<'a> {
            pub id: &'a str,
        }
    }

    /// The buy checkout page (marketplace's `checkout/buy/session/:sessionId`): the session, Update
    /// totals and Pay now (see `checkout`). Every handler takes a `CheckoutBuyer`.
    #[corten::routes(state = crate::app::Shared, area = BuyCheckoutArea, caller = crate::auth::CheckoutBuyer)]
    pub mod checkout {
        /// The area's prefix: only the start of its paths. No page is served at
        /// `/checkout/buy/session` (marketplace answers its not-found page), so it names no handler
        /// and nothing can link to it.
        #[route("/checkout/buy/session")]
        pub struct BuyCheckoutArea;

        /// The page, after the write whose receipt its address carries; every write posts to it.
        #[route("/checkout/buy/session/{id}", get = crate::checkout::page, post = crate::checkout::write)]
        pub struct BuyCheckout<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::checkout::Place,
        }

        /// Checkout received (marketplace's `checkout/buy/session/:sessionId/confirmation`): a
        /// started payment's references and Continue to payment, read after Pay now's receipt.
        #[route("/checkout/buy/session/{id}/confirmation", get = crate::checkout::confirmation)]
        pub struct BuyConfirmation<'a> {
            pub id: &'a str,
            #[route(query)]
            pub place: crate::checkout::ConfirmationPlace,
        }
    }

    /// Checkout start (marketplace's `checkout/buy/readiness`): where a checkout begins for a
    /// listing, an offer or the cart, to anyone; Continue (and a visitor's Buy) posts to it. Its
    /// handlers take who is asking, if anyone (see `checkout_start`).
    #[corten::routes(state = crate::app::Shared, area = CheckoutStart)]
    pub mod checkout_start {
        /// The page, for the entry its query names (read as marketplace's `sourceFromUrl` reads it).
        #[route("/checkout/buy/readiness", get = crate::checkout_start::page, post = crate::checkout_start::start)]
        pub struct CheckoutStart;
    }

    /// Signing in (see `sign_in`): the page and its writes, and a magic link's landing. Public: no
    /// handler reads who is asking.
    #[corten::routes(state = crate::app::Shared, area = SignIn)]
    pub mod sign_in {
        /// The page, at the step its address is on; every sign-in form posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/sign-in", get = crate::sign_in::page, post = crate::sign_in::write)]
        pub struct SignIn {
            #[route(query)]
            pub ask: crate::sign_in::Ask,
        }

        /// Where a magic link's email points: its token signs the browser in.
        #[derive(Clone, Debug, Default)]
        #[route("/sign-in/magic", get = crate::sign_in::magic)]
        pub struct MagicLink {
            #[route(query)]
            pub link: crate::sign_in::Link,
        }
    }

    /// Creating an account (see `register`): the page and its writes. Public: no handler reads who
    /// is asking.
    #[corten::routes(state = crate::app::Shared, area = Register)]
    pub mod register {
        /// The page, with the method its address asks for; every registration form posts to it.
        #[derive(Clone, Debug, Default)]
        #[route("/register", get = crate::register::page, post = crate::register::write)]
        pub struct Register {
            #[route(query)]
            pub join: crate::register::Join,
        }
    }

    /// Accepting an invitation (see `invite`): the page and its writes. Public: the invitation's
    /// token says whose it is.
    #[corten::routes(state = crate::app::Shared, area = Invitations)]
    pub mod invite {
        /// The area's prefix: only the start of its paths. No page is served at `/invite`, so it
        /// names no handler.
        #[route("/invite")]
        pub struct Invitations;

        /// The invitation, as its email links to it; the acceptance and status forms post to it.
        #[derive(Clone, Debug)]
        #[route("/invite/{id}", get = crate::invite::page, post = crate::invite::write)]
        pub struct Invite<'a> {
            pub id: &'a str,
            #[route(query)]
            pub invited: crate::invite::Invited,
        }
    }

    /// The account a sign-in acts for, when the user may act for more than one. Public: the
    /// selection's cookie says whose it is.
    #[corten::routes(state = crate::app::Shared, area = AccountSelect)]
    pub mod account_select {
        #[derive(Clone, Debug, Default)]
        #[route("/account/select", get = crate::sign_in::select_page, post = crate::sign_in::select)]
        pub struct AccountSelect {
            #[route(query)]
            pub back: crate::sign_in::Back,
        }
    }

    /// Signing out. Public: it ends whatever session the cookie names.
    #[corten::routes(state = crate::app::Shared, area = SignOut)]
    pub mod sign_out {
        #[route("/sign-out", post = crate::sign_in::sign_out)]
        pub struct SignOut;
    }

    /// The buyer's cart: the cart is the area's route, and every handler takes a `Buyer` (the
    /// account's cart, or the guest cart the browser carries).
    #[corten::routes(state = crate::app::Shared, area = Cart, caller = crate::auth::Buyer)]
    pub mod cart {
        /// The cart, after the write whose receipt it carries.
        #[derive(Clone, Debug, Default)]
        #[route("/account/cart", get = crate::cart::page)]
        pub struct Cart {
            #[route(query)]
            pub after: crate::cart::AfterWrite,
        }

        /// A cart line's quantity, one step down or up.
        #[route("/account/cart/quantity", post = crate::cart::quantity)]
        pub struct CartQuantity;

        /// Remove a cart line.
        #[route("/account/cart/remove", post = crate::cart::remove)]
        pub struct CartRemove;

        /// Lock a cart line to its preferred listing.
        #[route("/account/cart/lock", post = crate::cart::lock)]
        pub struct CartLock;

        /// Check out the account's cart: starts a checkout session and sends the buyer to it.
        #[route("/account/cart/checkout", post = crate::cart::checkout)]
        pub struct CartCheckout;
    }
}

/// The pilot's sign-in, coming back to the screen the request was for: the path's first three
/// segments (`/account/inventory/restock-decisions` for a write to one decision).
pub fn sign_in_at(path: &str) -> Option<Uri> {
    let page: String = path.split('/').filter(|s| !s.is_empty()).take(3).map(|s| format!("/{s}")).collect();
    let page = if page.is_empty() { "/".to_owned() } else { page };
    sign_in_back_to(&page)
}

/// The pilot's sign-in, coming back to `page` (a path and its query).
pub fn sign_in_back_to(page: &str) -> Option<Uri> {
    url::SignIn { ask: crate::sign_in::Ask::back_to(page) }.href().parse().ok()
}

/// Where Stripe.js loads from, and the origin of the payment fields' frames.
pub const STRIPE_JS: &str = "https://js.stripe.com";

/// What Stripe.js and its fields need: its script, its frames and the APIs they call.
fn stripe(p: corten::security::Sources) -> corten::security::Sources {
    p.script_src(STRIPE_JS)
        .frame_src(STRIPE_JS)
        .frame_src("https://hooks.stripe.com")
        .connect_src("https://api.stripe.com")
        .connect_src("https://merchant-ui-api.stripe.com")
}

/// Where Stripe's Connect.js loads from, and the origin of its components' frames.
pub const CONNECT_JS: &str = "https://connect-js.stripe.com";

/// What Stripe's Connect embedded components need (Stripe's CSP list, and marketplace's
/// `CONNECT_EMBEDDED_COMPONENT_CSP`): Connect.js and Stripe.js, their frames, the APIs they call,
/// and the empty `<style>` Connect.js writes, by its hash, rather than marketplace's
/// `'unsafe-inline'`. Images from Stripe are `https:`, which every page allows.
fn stripe_connect(p: corten::security::Sources) -> corten::security::Sources {
    p.script_src(CONNECT_JS)
        .script_src(STRIPE_JS)
        .frame_src(CONNECT_JS)
        .frame_src(STRIPE_JS)
        .connect_src("https://api.stripe.com")
        .connect_src("https://merchant-ui-api.stripe.com")
        .style_src("'sha256-0hAheEzaMe6uXIKV4EehS9pu1am1lj/KnnzrOYqckXk='")
}

// The app's `static/` directory, compiled into the program, so the binary is the whole deploy
// (todd-skelton/corten#268).
corten::assets::embed!(pub struct Static = "static");

/// What marketplace-web's service worker leaves to the network (`marketplaceServiceWorkerPolicy`'s
/// excluded paths and prefixes): no offline page for a sign-in, a checkout, a payment, an account's
/// pages or an order. Its exact paths are prefixes here, which reach only their own sub-paths
/// (`/sign-in/magic`).
const NETWORK_ONLY: [&str; 10] = [
    "/guest-checkout/exit",
    "/sign-in",
    "/sign-out",
    "/register",
    "/api/",
    "/account",
    "/checkout",
    "/payment",
    "/payments",
    "/orders",
];

/// marketplace-web's web app manifest (`routes/manifest.ts`), and its service worker as Corten's
/// (`corten::pwa`): pages from the network, the offline page when there is none, and the static
/// files from the cache. Marketplace's `orientation` (`any`, the default) and `categories`
/// (`shopping`, `productivity`) are not written: Corten's manifest has neither
/// (todd-skelton/corten#515). The description is in English, as marketplace's is.
fn pwa() -> corten::pwa::Pwa {
    use corten::{
        i18n::Messages as _,
        pwa::{Manifest, Pwa},
    };
    let t = crate::text::SiteMsg::for_locale("en");
    let manifest = Manifest::new("Chase Sets", "Chase Sets")
        .description(t.manifest_description())
        .theme_color("#4845c6")
        .background_color("#f7f5f1")
        .icon(Static::ICONS_CHASE_SETS_192_PNG, "192x192")
        .icon(Static::ICONS_CHASE_SETS_512_PNG, "512x512")
        .maskable_icon(Static::ICONS_CHASE_SETS_MASKABLE_192_PNG, "192x192")
        .maskable_icon(Static::ICONS_CHASE_SETS_MASKABLE_512_PNG, "512x512");
    NETWORK_ONLY.into_iter().fold(Pwa::new(manifest), Pwa::network_only)
}

/// The pilot: each screen is an area whose routes module says who may use it (`caller = ..`):
/// sellers on the inventory screens, buyers on the cart, anyone on an item or a search.
pub fn app(config: Config) -> App<crate::auth::OneLookup> {
    let shared: Shared = Arc::new(config);
    App::new(url::home::router(shared.clone()))
        // One look at whose the request is, for every caller type and the layout's cart count.
        .middleware(crate::auth::OneLookup)
        .assets(Static)
        .pwa(pwa())
        // The cart's fallback picture is on marketplace's origin and a listing's photos on the API's,
        // which are plain http locally (the default policy takes any https image), and Check out
        // redirects to marketplace's checkout.
        .policy(
            corten::security::Policy::new()
                .img_src(marketplace_origin())
                .img_src(shared.platform.origin())
                .form_action(marketplace_origin()),
        )
        .messages::<crate::text::Msg>()
        // The seller's listings turn a picked day into its start where the seller is.
        .client_zone()
        .components(views::COMPONENTS)
        // Search is the home page too, outside every area, and at two prefixes, and a set's page
        // shows its cards: its components are in `components.css`, about 2.2 KB brotli, which a
        // stylesheet for `/` alone would trade for a blocking request on the most visited page
        // (todd-skelton/corten#95, measured there).
        .components(views::SEARCH)
        .components(views::ACCOUNT_HOME)
        .area(|area| url::account_home::area(area, shared.clone()))
        .area(|area| url::inventory::area(area, shared.clone()).components(views::INVENTORY))
        .area(|area| url::cart::area(area, shared.clone()).components(views::CART))
        .area(|area| url::checkout::area(area, shared.clone()).components(views::CHECKOUT))
        .area(|area| url::checkout_start::area(area, shared.clone()).components(views::CHECKOUT_START))
        .area(|area| url::items::area(area, shared.clone()).components(views::ITEM))
        .area(|area| url::search::area(area, shared.clone()))
        .area(|area| url::categories::area(area, shared.clone()))
        .area(|area| url::sets::area(area, shared.clone()).components(views::SET))
        .area(|area| url::listings::area(area, shared.clone()).components(views::LISTING))
        .area(|area| url::accounts::area(area, shared.clone()).components(views::ACCOUNT))
        .area(|area| {
            url::purchase_reviews::area(url::purchases::area(area, shared.clone()), shared.clone()).components(views::ORDERS)
        })
        .area(|area| url::sale_reviews::area(url::sales::area(area, shared.clone()), shared.clone()).components(views::ORDERS))
        .area(|area| url::shipments::area(area, shared.clone()).components(views::SHIPMENTS))
        .area(|area| url::sale_shipments::area(area, shared.clone()).components(views::SALE_SHIPMENTS))
        .area(|area| url::notifications::area(area, shared.clone()).components(views::NOTIFICATIONS))
        .area(|area| url::addresses::area(area, shared.clone()).components(views::ADDRESSES))
        .area(|area| url::security::area(area, shared.clone()).components(views::SECURITY))
        .area(|area| url::team::area(area, shared.clone()).components(views::TEAM))
        .area(|area| url::consents::area(area, shared.clone()).components(views::CONSENTS))
        .area(|area| url::reviews::area(area, shared.clone()).components(views::REVIEWS))
        .area(|area| url::sessions::area(area, shared.clone()).components(views::SESSIONS))
        .area(|area| url::agents::area(area, shared.clone()).components(views::AGENTS))
        // Approve and Deny post to the API's authorize, which redirects to the agent's own address,
        // any HTTPS origin or a developer's localhost (`isTrustedHttpUrl`): Chromium and WebKit apply
        // `form-action` to that redirect.
        .area(|area| {
            url::agent_consent::area(area, shared.clone()).components(views::AGENTS).policy(|p| {
                p.form_action("https:")
                    .form_action("http://localhost:*")
                    .form_action("http://127.0.0.1:*")
                    .referrer(corten::security::Referrer::StrictOrigin)
            })
        })
        .area(|area| url::oauth::area(area, shared.clone()))
        // A create sends up to 60 MB of photos, which the API normalizes into six sizes each.
        // A listing's photo writes send up to 60 MB, as a create does.
        .area(|area| {
            url::seller_listings::area(area, shared.clone())
                .components(views::SELLER_LISTING)
                .deadline(crate::seller_listing::DEADLINE)
        })
        .area(|area| url::desk::area(area, shared.clone()).components(views::DESK))
        .area(|area| url::desk_offers::area(area, shared.clone()).components(views::SELL_LIST))
        .area(|area| url::sell_checkout::area(area, shared.clone()).components(views::SELL_CHECKOUT))
        // A photo is up to 10 MB, as Create listing's are.
        .area(|area| {
            url::sell_list::area(area, shared.clone()).components(views::SELL_LIST).deadline(crate::listing_new::DEADLINE)
        })
        .area(|area| url::money::area(area, shared.clone()).components(views::MONEY))
        .area(|area| url::payout::area(area, shared.clone()).components(views::MONEY))
        // Stripe's Connect sign-in reports back through a popup, which `same-origin` cuts off
        // (todd-skelton/corten#318); the rest of the app keeps `same-origin`.
        .area(|area| {
            url::payout_setup::area(area, shared.clone())
                .components(views::PAYOUT_SETUP)
                .policy(|p| stripe_connect(p).allow_cross_origin_opener())
        })
        // Stripe.js and its fields are allowed on the payment pages and the saved payment methods
        // only (todd-skelton/corten#275).
        .area(|area| url::payments::area(area, shared.clone()).components(views::PAYMENT).policy(stripe))
        .area(|area| url::guest_payments::area(area, shared.clone()).components(views::PAYMENT).policy(stripe))
        .area(|area| url::payment_methods::area(area, shared.clone()).components(views::PAYMENT_METHODS).policy(stripe))
        .area(|area| url::support::area(area, shared.clone()).components(views::SUPPORT))
        .area(|area| url::repricing::area(area, shared.clone()).components(views::REPRICING))
        .area(|area| url::recommendations::area(area, shared.clone()).components(views::RECOMMENDATIONS))
        .area(|area| url::pricing_health::area(area, shared.clone()).components(views::PRICING_HEALTH))
        .area(|area| url::channels::area(area, shared.clone()).components(views::CHANNELS))
        // A CSV is up to 16 MB, so a slow connection has a listing's photos' time.
        .area(|area| {
            url::bulk_reprice::area(area, shared.clone()).components(views::BULK_REPRICE).deadline(crate::bulk_reprice::DEADLINE)
        })
        .area(|area| url::offer_matches::area(area, shared.clone()).components(views::OFFER_MATCHES))
        .area(|area| url::submitted_offers::area(area, shared.clone()).components(views::SUBMITTED_OFFERS))
        .area(|area| {
            url::new_listing::area(area, shared.clone()).components(views::NEW_LISTING).deadline(crate::listing_new::DEADLINE)
        })
        .area(|area| url::sign_in::area(area, shared.clone()).components(views::SIGN_IN))
        .area(|area| url::register::area(area, shared.clone()).components(views::REGISTER))
        .area(|area| url::invite::area(area, shared.clone()).components(views::REGISTER))
        .area(|area| url::account_select::area(area, shared.clone()).components(views::SIGN_IN))
        .area(|area| url::sign_out::area(area, shared.clone()))
        .area(|area| url::offline::area(area, shared.clone()).components(views::OFFLINE))
        .error_page(views::error_page, shared)
}

/// Marketplace's sign-in, for a session the API says has ended (the callers' `identify` sends the rest
/// there).
pub fn sign_in(req: &Req) -> HtmlResult {
    match sign_in_at(req.path()) {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// A list's read that failed, as the page's answer. After a write, a read that failed for good is
/// marketplace's "could not be verified" (409), in the screen's words (`unverified`): the error
/// page knows only the status, so the screen draws it.
pub fn read_failed(
    req: &Req,
    viewer: Option<&Viewer>,
    error: ApiError,
    after_write: Option<&str>,
    cart: Option<u64>,
) -> HtmlResult {
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(StatusCode::FORBIDDEN) => StatusCode::FORBIDDEN,
        _ => match after_write {
            Some(unverified) => {
                tracing::warn!("the read after a write failed: {error}");
                let title = req.t::<Pilot>().error_failed_title();
                let view = views::failed(title, unverified);
                let head = html! { <meta name="robots" content="noindex"> };
                return req.page_with_status(
                    StatusCode::CONFLICT,
                    html! {
                        <views::Layout req={req} viewer={viewer} cart={cart} title={title} head={head}>{view}</views::Layout>
                    },
                );
            }
            None => StatusCode::BAD_GATEWAY,
        },
    };
    Err(corten::Error::new(error).with_status(status))
}
