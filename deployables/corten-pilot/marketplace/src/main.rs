//! Marketplace screens on Corten: the seller's Inventory > Storage locations and Restock decisions
//! (pilot ports of marketplace's `/account/inventory/locations` and
//! `/account/inventory/restock-decisions`) and the buyer's cart (`/account/cart`), which read and
//! write through the platform API as the signed-in account. See README.md.
mod api;
mod app;
mod auth;
mod cart;
mod form;
mod locations;
mod recovery;
mod restock;
mod text;
mod views;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
