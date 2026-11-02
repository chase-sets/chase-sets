//! The screens' text. `Msg` (storage locations) and `Restock` (restock decisions) are the
//! Inventory context's own catalogs for each screen, `ItemMsg` the Discovery context's item page's,
//! `SearchMsg` the Discovery context's search page's, `ListingMsg` its public listing page's, `AccountMsg` its public account page's (with Reputation's review words), `AddressesMsg` the Identity context's shipping addresses page's, `AccountHomeMsg` its account page's, `SecurityMsg` its security page's, `TeamMsg` its team page's, `ConsentsMsg` its consent history's, `ReviewsMsg` the Reputation context's account review pages', `SessionsMsg` the Auth context's session pages', `AgentsMsg` its connected agents pages', `ListingNewMsg` the Marketplace context's Create listing page's, `SellerListingMsg` its seller's listing page's, `SellerListingsMsg` its seller's list of listings', `OfferMatchesMsg` its seller's offer matches', `SubmittedOffersMsg` its buyer's submitted offers', `InventoryMsg` the Inventory context's inventory list's, `NotificationsMsg` the Notifications context's notification center's, `OrdersMsg` the Ordering context's order pages', `ImportsMsg` the Inventory context's import page's, `ShipmentsMsg` the Fulfillment context's shipment pages', `CartMsg` the Checkout context's cart page's, `SellListMsg` its Sell List's (with Marketplace's evidence coverage words), `CheckoutMsg` its buy checkout page's, `DeskMsg` the Marketplace context's Seller Desk home's, `MoneyMsg` the Settlement context's Seller Desk money page's, `PaymentMethodsMsg` the Payments context's saved payment methods page's (with its payment page's secure step words), `PaymentStartMsg` its page for starting a payment for a buyer's orders, `SupportMsg` the Platform Operations context's Support Request participant page's, `SignInMsg` the Auth context's sign-in, magic link and account selection pages' (exported from contracts/localization by
//! scripts/export.mjs, so the copy cannot drift); `Pilot` is the pilot's shell, input checks and
//! the routes' own messages. `messages!` checks every call against the catalogs when the crate
//! compiles.
pub use account::AccountMsg;
pub use account_home::AccountHomeMsg;
pub use addresses::AddressesMsg;
pub use agents::AgentsMsg;
pub use cart::CartMsg;
pub use channels::ChannelsMsg;
pub use checkout::CheckoutMsg;
pub use consents::ConsentsMsg;
pub use desk::DeskMsg;
pub use imports::ImportsMsg;
pub use inventory::Msg;
pub use inventory_list::InventoryMsg;
pub use item::ItemMsg;
pub use listing::ListingMsg;
pub use listing_new::ListingNewMsg;
pub use money::MoneyMsg;
pub use notifications::NotificationsMsg;
pub use offer_matches::OfferMatchesMsg;
pub use orders::OrdersMsg;
pub use payment::PaymentMsg;
pub use payment_methods::PaymentMethodsMsg;
pub use payment_start::PaymentStartMsg;
pub use pilot::Pilot;
pub use repricing::RepricingMsg;
pub use restock::Restock;
pub use reviews::ReviewsMsg;
pub use search::SearchMsg;
pub use security::SecurityMsg;
pub use sell_checkout::SellCheckoutMsg;
pub use sell_list::SellListMsg;
pub use seller_listing::SellerListingMsg;
pub use seller_listings::SellerListingsMsg;
pub use sessions::SessionsMsg;
pub use shipments::ShipmentsMsg;
pub use sign_in::SignInMsg;
pub use site::SiteMsg;
pub use submitted_offers::SubmittedOffersMsg;
pub use support::SupportMsg;
pub use team::TeamMsg;

mod sign_in {
    corten::i18n::messages! {
        pub struct SignInMsg { "en" => "locales/sign_in.en.json" }
    }
}

mod checkout {
    corten::i18n::messages! {
        pub struct CheckoutMsg { "en" => "locales/checkout.en.json" }
    }
}

mod desk {
    corten::i18n::messages! {
        pub struct DeskMsg { "en" => "locales/desk.en.json" }
    }
}

mod money {
    corten::i18n::messages! {
        pub struct MoneyMsg { "en" => "locales/money.en.json" }
    }
}

mod payment {
    corten::i18n::messages! {
        pub struct PaymentMsg { "en" => "locales/payment.en.json" }
    }
}

mod payment_start {
    corten::i18n::messages! {
        pub struct PaymentStartMsg { "en" => "locales/payment_start.en.json" }
    }
}

mod payment_methods {
    corten::i18n::messages! {
        pub struct PaymentMethodsMsg { "en" => "locales/payment_methods.en.json" }
    }
}

mod support {
    corten::i18n::messages! {
        pub struct SupportMsg { "en" => "locales/support.en.json" }
    }
}

mod channels {
    corten::i18n::messages! {
        pub struct ChannelsMsg { "en" => "locales/channels.en.json" }
    }
}

mod repricing {
    corten::i18n::messages! {
        pub struct RepricingMsg { "en" => "locales/repricing.en.json" }
    }
}

mod account_home {
    corten::i18n::messages! {
        pub struct AccountHomeMsg { "en" => "locales/account-home.en.json" }
    }
}

mod agents {
    corten::i18n::messages! {
        pub struct AgentsMsg { "en" => "locales/agents.en.json" }
    }
}

mod sessions {
    corten::i18n::messages! {
        pub struct SessionsMsg { "en" => "locales/sessions.en.json" }
    }
}

mod security {
    corten::i18n::messages! {
        pub struct SecurityMsg { "en" => "locales/security.en.json" }
    }
}

mod team {
    corten::i18n::messages! {
        pub struct TeamMsg { "en" => "locales/team.en.json" }
    }
}

mod reviews {
    corten::i18n::messages! {
        pub struct ReviewsMsg { "en" => "locales/reviews.en.json" }
    }
}

mod consents {
    corten::i18n::messages! {
        pub struct ConsentsMsg { "en" => "locales/consents.en.json" }
    }
}

mod addresses {
    corten::i18n::messages! {
        pub struct AddressesMsg { "en" => "locales/addresses.en.json" }
    }
}

mod account {
    corten::i18n::messages! {
        pub struct AccountMsg { "en" => "locales/account.en.json" }
    }
}

mod notifications {
    corten::i18n::messages! {
        pub struct NotificationsMsg { "en" => "locales/notifications.en.json" }
    }
}

mod imports {
    corten::i18n::messages! {
        pub struct ImportsMsg { "en" => "locales/imports.en.json" }
    }
}

mod shipments {
    corten::i18n::messages! {
        pub struct ShipmentsMsg { "en" => "locales/shipments.en.json" }
    }
}

mod orders {
    corten::i18n::messages! {
        pub struct OrdersMsg { "en" => "locales/orders.en.json" }
    }
}

mod inventory {
    corten::i18n::messages! {
        pub struct Msg { "en" => "locales/en.json" }
    }
}

mod restock {
    corten::i18n::messages! {
        pub struct Restock { "en" => "locales/restock.en.json" }
    }
}

mod sell_checkout {
    corten::i18n::messages! {
        pub struct SellCheckoutMsg { "en" => "locales/sell_checkout.en.json" }
    }
}

mod sell_list {
    corten::i18n::messages! {
        pub struct SellListMsg { "en" => "locales/sell_list.en.json" }
    }
}

mod cart {
    corten::i18n::messages! {
        pub struct CartMsg { "en" => "locales/cart.en.json" }
    }
}

/// marketplace-web's offline page and its web app manifest's description.
mod site {
    corten::i18n::messages! {
        pub struct SiteMsg { "en" => "locales/site.en.json" }
    }
}

mod item {
    corten::i18n::messages! {
        pub struct ItemMsg { "en" => "locales/item.en.json" }
    }
}

mod listing_new {
    corten::i18n::messages! {
        pub struct ListingNewMsg { "en" => "locales/listing-new.en.json" }
    }
}

mod seller_listing {
    corten::i18n::messages! {
        pub struct SellerListingMsg { "en" => "locales/seller-listing.en.json" }
    }
}

mod offer_matches {
    corten::i18n::messages! {
        pub struct OfferMatchesMsg { "en" => "locales/offer-matches.en.json" }
    }
}

mod inventory_list {
    corten::i18n::messages! {
        pub struct InventoryMsg { "en" => "locales/inventory.en.json" }
    }
}

mod submitted_offers {
    corten::i18n::messages! {
        pub struct SubmittedOffersMsg { "en" => "locales/submitted-offers.en.json" }
    }
}

mod seller_listings {
    corten::i18n::messages! {
        pub struct SellerListingsMsg { "en" => "locales/seller-listings.en.json" }
    }
}

mod listing {
    corten::i18n::messages! {
        pub struct ListingMsg { "en" => "locales/listing.en.json" }
    }
}

mod search {
    corten::i18n::messages! {
        pub struct SearchMsg { "en" => "locales/search.en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
