//! admin-web screens on Corten, reading and writing through the platform API as the signed-in
//! staff member: Commerce > Postage policies (`/commerce/postage-policies`) and the catalog
//! area's dimensions and fields (`/catalog`), each an area with its own stylesheet and the caller its handlers take.
//! See README.md.
mod access;
mod api;
mod app;
mod auth;
mod catalog;
mod form;
mod operations;
mod projections;
mod text;
mod views;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
