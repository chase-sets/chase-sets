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
//! | `GET /account/cart?after_write=..` | the account's cart, its readiness and total |
//! | `POST /account/cart/quantity` | a line's quantity, one step down or up |
//! | `POST /account/cart/remove` | remove a line |
//! | `POST /account/cart/lock` | lock a line to its preferred listing |
//! | `POST /account/cart/checkout` | start a checkout session, then marketplace's checkout |
//! | `GET /items/{slug}?<choice>` | an item, its product options and its market book, to anyone |
//! | `POST /items/{slug}/cart`, `/buy`, `/offer`, `/sell-list`, `/watch` | the rail's buy, sell and watch forms |
//! | `POST /items/{slug}/save` | Add to List: add the product to a Saved List, or a guest's intent |
//! | `POST /items/{slug}/list`, `/ship-from` | list the product at a price, and the ship-from setup it needs |
//! | `GET /account/purchases`, `/account/sales` and each order's page, `POST ../{id}/cancel` | the account's orders (see `orders`) |
//! | `GET /account/shipments`, each buyer and sale shipment's page | the account's shipments (see `shipments`) |
//! | `GET /account/shipping-addresses`, `POST ..`, `../{id}`, `../{id}/default`, `../{id}/archive` | the account's shipping addresses (see `addresses`) |
//! | `GET /account/listings/new?<form>`, `POST ..` | Create listing, with its photos (see `listing_new`) |
//! | `GET /search?<terms>` | marketplace search: the results for the words, filters and sort, to anyone |
//! | `GET /categories/{slug}?<terms>` | the same, in a category |
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
    api::{ApiError, Platform, segment},
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
/// A sale's pages need it too (marketplace's `account-sale` and `account-sales` loaders).
pub const LISTINGS_VIEW: &str = "listings.view";
/// Creating a listing (marketplace's `account-listings-new` action).
pub const LISTINGS_MANAGE: &str = "listings.manage";
/// The account's shipments (Fulfillment's marketplace loaders and actions).
pub const FULFILLMENT_VIEW: &str = "fulfillment.view";
pub const FULFILLMENT_MANAGE: &str = "fulfillment.manage";

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

/// Every URL the pilot serves, by area. Each area's routes module names each route's handler and
/// the caller every handler there takes.
pub mod url {
    pub use accounts::{Account, AccountReviewReport, AccountsArea};
    pub use addresses::{AddressArchive, AddressDefault, AddressUpdate, ShippingAddresses};
    pub use cart::{Cart, CartCheckout, CartLock, CartQuantity, CartRemove};
    pub use categories::{Categories, Category};
    pub use home::Home;
    pub use inventory::{Archive, InventoryArea, Location, Locations, Restock, Restocked, WrittenOff};
    pub use items::{
        Item, ItemAdded, ItemBuy, ItemCart, ItemList, ItemLive, ItemOffer, ItemSave, ItemSaved, ItemSellList, ItemShipFrom,
        ItemWatch, ItemWatched, ItemWritten, ItemsArea,
    };
    pub use listings::{ListingsArea, PublicListing, PublicListingBuy, PublicListingReport};
    pub use new_listing::NewListing;
    pub use notifications::{NotificationPreference, NotificationRead, NotificationReadAll, Notifications, ProductAlertChange};
    pub use purchases::{Purchase, PurchaseCancel, Purchases};
    pub use sale_shipments::{Pack, Packing, PackingLine, PackingScan, PackingStart, SaleShipment, SaleShipments};
    pub use sales::{Sale, SaleCancel, Sales};
    pub use search::Search;
    pub use sets::{Set, Sets};
    pub use shipments::{Shipment, Shipments};

    /// The home page, public: marketplace's index route is its search route, so it is the search
    /// at `/` (with nothing asked, the landing and its shelf). It is in no area: an area's prefix
    /// is the start of each of its paths, and every path starts with `/`.
    #[corten::routes(state = crate::app::Shared)]
    pub mod home {
        /// The search's landing, or the results for the address's terms.
        #[derive(Clone, Debug, Default)]
        #[route("/", get = crate::search::page)]
        pub struct Home {
            #[route(query)]
            pub terms: crate::search::Terms,
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
        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/categories", link)]
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
        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/accounts", link)]
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
        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/listings", link)]
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
        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/sets", link)]
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
        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/items", link)]
        pub struct ItemsArea;

        /// An item, and what the buyer chose of it (`id` is its slug or its id; an id moves to the
        /// slug).
        #[derive(Clone, Debug)]
        #[route("/items/{slug}", get = crate::items::page)]
        pub struct Item<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
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

        /// Make an offer for the product the item page shows: checked, then marketplace's offer checkout.
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

        /// A link (the item's route serves it): the item after a seller's write (ship-from setup, a
        /// listing), whose reads wait for the write's receipt (empty for none).
        #[route("/items/{slug}", link)]
        pub struct ItemWritten<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
            pub after_write: &'a str,
        }

        /// A link (the item's route serves it): the item on its Watch tab after Set alert: the page says the alert was saved, with the
        /// write's receipt (empty for none).
        #[route("/items/{slug}", link)]
        pub struct ItemWatched<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
            pub watched: &'a str,
        }

        /// A link (the item's route serves it): the item after Add to List's Add Product: the page
        /// says so, with the write's receipt (empty for none), the list, the quantity added and
        /// the line's status (`added` or `merged`).
        #[route("/items/{slug}", link)]
        pub struct ItemSaved<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
            pub saved: &'a str,
            pub saved_list: &'a str,
            pub saved_quantity: &'a str,
            pub saved_line: &'a str,
        }

        /// A link (the item's route serves it): the item after Add to cart: the page says so, with the write's receipt (empty for none).
        #[route("/items/{slug}", link)]
        pub struct ItemAdded<'a> {
            pub slug: &'a str,
            #[route(query)]
            pub state: crate::items::Address,
            pub added: &'a str,
        }
    }

    /// The seller's inventory screens: every handler takes a `Seller` (`inventory.view` to read,
    /// `inventory.manage` to write).
    #[corten::routes(state = crate::app::Shared, area = InventoryArea, caller = crate::auth::Seller)]
    pub mod inventory {
        use crate::recovery::Check;

        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/account/inventory", link)]
        pub struct InventoryArea;

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

    /// The buyer's cart: the cart is the area's route, and every handler takes a `Buyer` (an
    /// account cart).
    #[corten::routes(state = crate::app::Shared, area = Cart, caller = crate::auth::Buyer)]
    pub mod cart {
        /// The account's cart, after the write whose receipt it carries.
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

/// Marketplace's sign-in, coming back to the screen the request was for (marketplace only returns
/// to its own paths, and the pilot's are marketplace's): the path's first three segments
/// (`/account/inventory/restock-decisions` for a write to one decision).
pub fn sign_in_at(path: &str) -> Option<Uri> {
    let page: String = path.split('/').filter(|s| !s.is_empty()).take(3).map(|s| format!("/{s}")).collect();
    let page = if page.is_empty() { "/".to_owned() } else { page };
    views::marketplace(&format!("/sign-in?returnTo={}", segment(&page)))
}

/// The pilot: each screen is an area whose routes module says who may use it (`caller = ..`):
/// sellers on the inventory screens, buyers on the cart, anyone on an item or a search.
pub fn app(config: Config) -> App {
    let shared: Shared = Arc::new(config);
    App::new(url::home::router(shared.clone()))
        // The cart's fallback picture is on marketplace's origin, which is plain http locally (the
        // default policy takes any https image), and Check out redirects to its checkout.
        .policy(corten::security::Policy::new().img_src(marketplace_origin()).form_action(marketplace_origin()))
        .messages::<crate::text::Msg>()
        .components(views::COMPONENTS)
        // Search is the home page too, outside every area, and at two prefixes, and a set's page
        // shows its cards: its components are in `components.css`, about 2.2 KB brotli, which a
        // stylesheet for `/` alone would trade for a blocking request on the most visited page
        // (todd-skelton/corten#95, measured there).
        .components(views::SEARCH)
        .area::<url::InventoryArea>(|area| url::inventory::area(area, shared.clone()).components(views::INVENTORY))
        .area::<url::Cart>(|area| url::cart::area(area, shared.clone()).components(views::CART))
        .area::<url::ItemsArea>(|area| url::items::area(area, shared.clone()).components(views::ITEM))
        .area::<url::Search>(|area| url::search::area(area, shared.clone()))
        .area::<url::Categories>(|area| url::categories::area(area, shared.clone()))
        .area::<url::Sets>(|area| url::sets::area(area, shared.clone()).components(views::SET))
        .area::<url::ListingsArea>(|area| url::listings::area(area, shared.clone()).components(views::LISTING))
        .area::<url::AccountsArea>(|area| url::accounts::area(area, shared.clone()).components(views::ACCOUNT))
        .area::<url::Purchases>(|area| url::purchases::area(area, shared.clone()).components(views::ORDERS))
        .area::<url::Sales>(|area| url::sales::area(area, shared.clone()).components(views::ORDERS))
        .area::<url::Shipments>(|area| url::shipments::area(area, shared.clone()).components(views::SHIPMENTS))
        .area::<url::SaleShipments>(|area| url::sale_shipments::area(area, shared.clone()).components(views::SALE_SHIPMENTS))
        .area::<url::Notifications>(|area| url::notifications::area(area, shared.clone()).components(views::NOTIFICATIONS))
        .area::<url::ShippingAddresses>(|area| url::addresses::area(area, shared.clone()).components(views::ADDRESSES))
        // A create sends up to 60 MB of photos, which the API normalizes into six sizes each.
        .area::<url::NewListing>(|area| {
            url::new_listing::area(area, shared.clone()).components(views::NEW_LISTING).deadline(crate::listing_new::DEADLINE)
        })
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
pub fn read_failed(req: &Req, viewer: Option<&Viewer>, error: ApiError, after_write: Option<&str>) -> HtmlResult {
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
                    html! { <views::Layout req={req} viewer={viewer} title={title} head={head}>{view}</views::Layout> },
                );
            }
            None => StatusCode::BAD_GATEWAY,
        },
    };
    Err(corten::Error::new(error).with_status(status))
}
