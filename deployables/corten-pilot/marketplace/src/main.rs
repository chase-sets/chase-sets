//! The marketplace seller's Inventory > Storage locations screen on Corten: a pilot port of
//! marketplace's `/account/inventory/locations`, which reads and writes through the platform API
//! as the signed-in seller. See README.md.
mod api;
mod app;
mod auth;
mod form;
mod recovery;
mod text;
mod views;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
