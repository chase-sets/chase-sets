//! Marketplace screens on Corten: the seller's Inventory > Storage locations and Restock decisions
//! (pilot ports of marketplace's `/account/inventory/locations` and
//! `/account/inventory/restock-decisions`), the buyer's cart (`/account/cart`), which read and
//! write through the platform API as the signed-in account, and the public item page
//! (`/items/{slug}`) and search (`/search`, `/categories/{slug}`), and the account's orders
//! (`/account/purchases`, `/account/sales`). See README.md.
mod accounts;
mod api;
mod app;
mod auth;
mod buying;
mod cart;
mod cart_attempt;
mod form;
mod items;
mod listing;
mod locations;
mod notifications;
mod orders;
mod public_listing;
mod recovery;
mod restock;
mod saving;
mod search;
mod selling;
mod sets;
mod text;
mod views;
mod watching;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
