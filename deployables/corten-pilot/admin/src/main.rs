//! admin-web screens on Corten, reading and writing through the platform API as the signed-in
//! staff member: Commerce > Postage policies (`/commerce/postage-policies`) and the catalog
//! area's dimensions and fields (`/catalog`), Access, and Support, each an area with its own
//! stylesheet and the caller its handlers take.
//! See README.md.
mod access;
mod api;
mod app;
mod auth;
mod catalog;
mod commerce;
mod evidence;
mod form;
mod growth;
mod insights;
mod operations;
mod policy_console;
mod projections;
mod providers;
mod reported;
mod sign_in;
mod site;
mod support;
mod text;
mod views;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
