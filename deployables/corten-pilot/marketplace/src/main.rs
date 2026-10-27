//! Marketplace screens on Corten: the seller's Inventory > Storage locations and Restock decisions
//! (pilot ports of marketplace's `/account/inventory/locations` and
//! `/account/inventory/restock-decisions`), the buyer's cart (`/account/cart`), which read and
//! write through the platform API as the signed-in account, and the public item page
//! (`/items/{slug}`) and search (`/search`, `/categories/{slug}`), and the account's orders
//! (`/account/purchases`, `/account/sales`) and shipments (`/account/shipments`,
//! `/account/sales/shipments/{id}`) and shipping addresses (`/account/shipping-addresses`), and Create listing
//! (`/account/listings/new`). See README.md.
mod accounts;
mod addresses;
mod api;
mod app;
mod auth;
mod buying;
mod cart;
mod cart_attempt;
mod form;
mod items;
mod listing;
mod listing_new;
mod locations;
mod notifications;
mod orders;
mod packing;
mod public_listing;
mod recovery;
mod restock;
mod saving;
mod search;
mod selling;
mod sets;
mod shipments;
mod text;
mod uploads;
mod views;
mod watching;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
