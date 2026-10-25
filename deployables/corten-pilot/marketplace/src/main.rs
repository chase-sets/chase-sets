//! The marketplace seller's Inventory > Storage locations and Restock decisions screens on Corten:
//! pilot ports of marketplace's `/account/inventory/locations` and
//! `/account/inventory/restock-decisions`, which read and write through the platform API as the
//! signed-in seller. See README.md.
mod api;
mod app;
mod auth;
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
